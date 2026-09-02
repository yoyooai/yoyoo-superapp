/**
 * Yoyoo 超级应用 · 后端（P1）
 *
 * 这是**我们自己的账本**，不是宿主的。宿主只提供"这个人是谁"，
 * 应用本身的存在、归属、内容全在这里 —— 所以换壳时应用不会丢。
 *
 * 刻意的设计取舍：
 *  · **零第三方依赖**：只用 Node 内置（node:http + node:sqlite）。这东西要能被
 *    丢到任何一台机器上直接跑起来，装依赖是部署时最容易出岔子的一步。
 *  · **身份不自己发明**：不签发自己的 token，而是拿宿主的 token 去问宿主"这是谁"。
 *    我们绝不持有用户凭据，也就没有"我们这边泄露账号"这种风险。
 *  · **provenance 徽章从第一天就有**（created_by: human | ai）。读 OCTO 代码时
 *    我认为这是它全仓最便宜也最聪明的设计 —— 一旦允许 AI 自主产出可持久化的东西，
 *    "这是谁造的"就是唯一能让人保持信任的元数据。既然这么说了，就第一天做。
 *
 * 环境变量：
 *   PORT              监听端口（默认 8790）
 *   DB_PATH           SQLite 文件（默认 ./data/yoyoo-superapp.db）
 *   HOST_VERIFY_URL   宿主校验**用户**身份的地址（默认 http://octo-server:8090/v1/user/current）
 *   HOST_BOT_API_URL  宿主 bot 面根地址（默认 http://octo-server:8090）
 *   OCTO_SPACE_ID     本期只认一个 Space；`/apps/for` 的成员校验要用
 *   YOYOO_BOT_ALLOWLIST  允许调 `/apps/for` 的 robot_id，逗号分隔。**不配等于全拒**
 *   APP_DEEP_LINK     应用深链模板，含 `{id}`（如 https://host/superapp?app={id}）
 *   CONNECTOR_ALLOW_PRIVATE_HOSTS_FOR_TEST
 *                     🔴 只给冒烟测试用，松开连接器的 SSRF 拦截（允许 base_url 指向
 *                     localhost/内网）。必须显式设成 "1" 才生效；ship.sh 绝不设它。
 */
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { generateBlueprint } from "./generate.mjs";
import { normalizeForStore } from "./blueprint.mjs";
import { normalizeCardForStore } from "./card-store.mjs";
import { createBotAuth } from "./bot-auth.mjs";
import { createMarket } from "./market.mjs";
import { createInvites } from "./invite.mjs";
import { createConnectors } from "./connectors.mjs";
import { send, readJson, clip } from "./http-util.mjs";

const PORT = Number(process.env.PORT || 8790);
const DB_PATH = process.env.DB_PATH || "./data/yoyoo-superapp.db";
// 说明书唯一真源。改这份文件不用重启就生效（每次请求现读，文件很小，读一次的代价可忽略）；
// 版本号从文件头 `<!-- manual-version: N -->` 里现拆，不在这里另存一份、免得两处对不上。
// 🔴 本地开发时 docs/ 跟 server/ 是同级目录（`../docs/...` 找得到）；但线上部署
// （deploy/ship.sh）把 server/*.mjs 摊平发到 /app/ 下，没有那层嵌套，摊平后
// `../docs/` 会指到 /app 的上一级，読不到——09-03 真的踩过这个 500。
// 所以线上用 MANUAL_PATH 环境变量显式指定（ship.sh 会把文件也摊平发到 /app/ 同级，
// 并设好这个变量），本地不设就走开发时的相对路径。
const MANUAL_PATH = process.env.MANUAL_PATH
  || join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "AI-MANUAL.md");
const HOST_VERIFY_URL =
  process.env.HOST_VERIFY_URL || "http://octo-server:8090/v1/user/current";
const HOST_BOT_API_URL = process.env.HOST_BOT_API_URL || "http://octo-server:8090";
const APP_DEEP_LINK = process.env.APP_DEEP_LINK || "";

/**
 * bot 面的门。白名单不配就是全拒 —— 这个默认值是刻意的：
 * 这个接口能替别人造东西，"忘了配"必须等于"关着"，不能等于"敞着"。
 */
const botAuth = createBotAuth({
  hostBotApiUrl: HOST_BOT_API_URL,
  spaceId: process.env.OCTO_SPACE_ID || "",
  allowlist: String(process.env.YOYOO_BOT_ALLOWLIST || "").split(","),
});

/**
 * 模型配置。没配 apiKey 时 generateBlueprint 会自动走本地生成 ——
 * 功能不瘫，只是不聪明。接上密钥立刻变真 AI，不需要改代码。
 */
const LLM = {
  apiKey: process.env.LLM_API_KEY || "",
  baseUrl: process.env.LLM_BASE_URL || "https://key.cosark.com.cn/v1",
  model: process.env.LLM_MODEL || "gpt-5.6-sol",
};

// ── 存储 ────────────────────────────────────────────────────────
mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS apps (
    id          TEXT PRIMARY KEY,
    owner_uid   TEXT NOT NULL,
    name        TEXT NOT NULL,
    icon        TEXT,
    blueprint   TEXT NOT NULL,
    created_by  TEXT NOT NULL DEFAULT 'human',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_apps_owner ON apps(owner_uid, updated_at DESC);
  -- cards：跟 apps 是对称的两张账本（§ SPEC-ai-manual-and-authoring.md）——
  -- 结构一模一样，只是内容列叫 card 不叫 blueprint。建表放在这里（跟 apps 一起，
  -- 由我们自己拥有），market.mjs 只负责后面 ALTER 两个市场需要的来源列，
  -- 这个顺序是硬依赖：createMarket() 必须在这张表建完之后调用。
  CREATE TABLE IF NOT EXISTS cards (
    id          TEXT PRIMARY KEY,
    owner_uid   TEXT NOT NULL,
    name        TEXT NOT NULL,
    icon        TEXT,
    card        TEXT NOT NULL,
    created_by  TEXT NOT NULL DEFAULT 'human',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_cards_owner ON cards(owner_uid, updated_at DESC);
`);

const q = {
  list: db.prepare(
    `SELECT id,name,icon,created_by,created_at,updated_at FROM apps
      WHERE owner_uid=? ORDER BY updated_at DESC LIMIT 200`),
  get: db.prepare(`SELECT * FROM apps WHERE id=? AND owner_uid=?`),
  insert: db.prepare(
    `INSERT INTO apps (id,owner_uid,name,icon,blueprint,created_by,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?)`),
  update: db.prepare(
    `UPDATE apps SET name=?, icon=?, blueprint=?, updated_at=? WHERE id=? AND owner_uid=?`),
  remove: db.prepare(`DELETE FROM apps WHERE id=? AND owner_uid=?`),
};

const qCards = {
  list: db.prepare(
    `SELECT id,name,icon,created_by,created_at,updated_at FROM cards
      WHERE owner_uid=? ORDER BY updated_at DESC LIMIT 200`),
  get: db.prepare(`SELECT * FROM cards WHERE id=? AND owner_uid=?`),
  insert: db.prepare(
    `INSERT INTO cards (id,owner_uid,name,icon,card,created_by,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?)`),
  update: db.prepare(
    `UPDATE cards SET name=?, icon=?, card=?, updated_at=? WHERE id=? AND owner_uid=?`),
  remove: db.prepare(`DELETE FROM cards WHERE id=? AND owner_uid=?`),
};

// ── 身份 ────────────────────────────────────────────────────────
/**
 * 拿宿主 token 去问宿主"这是谁"。
 * 带一个很短的缓存：不是为了性能，是为了别把宿主的登录接口当水龙头拧
 * （每翻一次列表就打一次它的鉴权接口，是很不客气的做法）。
 */
const identityCache = new Map(); // token -> { uid, at }
const IDENTITY_TTL_MS = 60_000;

async function whoami(token) {
  if (!token) return null;
  const hit = identityCache.get(token);
  if (hit && Date.now() - hit.at < IDENTITY_TTL_MS) return hit.uid;

  try {
    const res = await fetch(HOST_VERIFY_URL, {
      headers: { token, Authorization: token },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    const uid = body?.uid || body?.data?.uid;
    if (!uid) return null;
    identityCache.set(token, { uid, at: Date.now() });
    return uid;
  } catch {
    return null; // 宿主不可达时一律当未登录 —— fail closed，不放行
  }
}

// ── 市场（我们自己的货架；建表 + 给 apps 补两列都在里面）─────────
// 🔴 不寄生宿主的市场：它那四种货位是 MySQL ENUM 写死的，塞第五种要动它的骨头。
//    详见 SPEC-market.md §0。
const market = createMarket({ db, spaceId: process.env.OCTO_SPACE_ID || "" });

// ── 邀请 AI（票据）─────────────────────────────────────────────
// 🔴 病根：宿主把"造一个新 AI"当成了"邀请一个已有的 AI"。这一层把两件事拆开。
//    我们**不持有能替用户造号的凭据** —— 建号一律由前端在用户登录态下完成，
//    这里只管票据、待确认队列和"凭据只交付一次"。详见 invite.mjs 文件头。
const invites = createInvites({
  db,
  spaceId: process.env.OCTO_SPACE_ID || "",
  apiBase: process.env.INVITE_API_BASE || "",
  hostApiUrl: process.env.INVITE_HOST_API_URL || "",
  sealSecretEnv: process.env.INVITE_SEAL_SECRET || "",
  sealKeyPath: `${dirname(DB_PATH)}/invite-seal.key`,
});

// ── 连接器（外部系统凭据 + 代理调用）────────────────────────────
// 详见 connectors.mjs 文件头：唯一持有外部凭据的地方，密钥独立一份、
// 不跟 invite 的封装密钥共用。
const connectors = createConnectors({
  db,
  sealKeyPath: `${dirname(DB_PATH)}/connector-seal.key`,
  // 🔴 只有这一个开关能松开 SSRF 拦截，且必须显式设成 "1"——不留给部署脚本、
  //    不留给任何生产用途。存在的唯一理由：冒烟测试要用真实 HTTP 往返验证
  //    代理逻辑，而假外部服务只能起在 localhost。ship.sh 绝不设这个变量。
  allowPrivateHosts: process.env.CONNECTOR_ALLOW_PRIVATE_HOSTS_FOR_TEST === "1",
});

// ── HTTP 小工具 ─────────────────────────────────────────────────
// send / readJson / clip 已抬到 http-util.mjs —— market.mjs 要用同一份，
// 留在这里会让"请求体上限"这类安全参数出现第二个值。

/** 应用深链。没配模板就返回 null —— 宁可不给链接，也不给一个瞎猜出来的地址 */
const deepLink = (id) =>
  APP_DEEP_LINK ? APP_DEEP_LINK.replace("{id}", encodeURIComponent(id)) : null;

/**
 * bot 面对 app/card 两种内容通用的存取描述 —— `handleBotContent()` 只认这份接口，
 * 不直接碰 `q`/`qCards`，这样"应用"和"卡片"的 bot 面路由是同一份代码在跑两遍，
 * 不是抄两份、改一处忘一处。
 */
const APP_STORE = {
  contentKey: "blueprint",
  defaultName: "AI 造的应用",
  list: q.list, get: q.get, insert: q.insert, update: q.update, remove: q.remove,
  normalize: (raw) => normalizeForStore(raw),
  deepLink,
};
const CARD_STORE = {
  contentKey: "card",
  defaultName: "AI 造的卡片",
  list: qCards.list, get: qCards.get, insert: qCards.insert, update: qCards.update, remove: qCards.remove,
  normalize: (raw) => normalizeCardForStore(raw),
  deepLink: () => null, // 卡片没有独立深链页面，装完就在"我的卡片"列表里
};

/**
 * bot 面对某一种内容（app|card）的全套 CRUD + 市场操作。
 * `prefix` 形如 `/yoyoo/v1/apps/for` 或 `/yoyoo/v1/cards/for`。
 *
 * 路由表（`rel` = path 去掉 prefix 之后剩下的部分）：
 *   ''                     GET 列表 / POST 造一个新的
 *   '/market'              GET 逛市场
 *   '/market/:id/install'  POST 装
 *   '/:id'                 GET 详情 / POST 编辑（局部更新） / DELETE 删除
 *   '/:id/publish'         POST 发布到市场
 *
 * 每一步都先 `botAuth.verify(token, ownerUid)`——owner_uid 从 query（GET）或
 * body（POST/DELETE 也走 body，浏览器 DELETE 带 body 不方便，所以 DELETE 走 query）里取，
 * 跟 `/apps/for` 创建时的规矩一致：**永远用宿主返回的规范 uid，不用请求里那个字符串**。
 */
async function handleBotContent(kind, store, req, res, { path, url, prefix }) {
  const rel = path.slice(prefix.length);
  const botToken = String(req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");

  async function authFor(ownerUidRaw) {
    return botAuth.verify(botToken, ownerUidRaw);
  }
  async function readBodyOr400() {
    try {
      return { ok: true, body: await readJson(req) };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  }

  // ── 市场 ──────────────────────────────────────────────────────
  if (rel === "/market") {
    if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });
    const auth = await authFor(url.searchParams.get("owner_uid"));
    if (!auth.ok) return send(res, auth.status, { error: auth.error });
    const r = market.doBrowse(kind, auth.ownerUid, {
      q: url.searchParams.get("q"),
      page: url.searchParams.get("page"),
      hot: url.searchParams.get("sort") === "hot",
      mine: url.searchParams.get("mine") === "1",
    });
    return send(res, r.status, r.body);
  }
  if (rel.startsWith("/market/")) {
    const seg = rel.slice("/market/".length).split("/");
    const listingId = decodeURIComponent(seg[0] || "");
    const action = seg[1] || "";
    if (action !== "install") return send(res, 404, { error: "not found" });
    if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
    const rb = await readBodyOr400();
    if (!rb.ok) return send(res, 400, { error: rb.error });
    const auth = await authFor(rb.body.owner_uid);
    if (!auth.ok) return send(res, auth.status, { error: auth.error });
    const r = market.doInstall(kind, auth.ownerUid, listingId, Date.now());
    return send(res, r.status, r.body);
  }

  // ── 列表 / 造一个新的 ───────────────────────────────────────────
  if (rel === "") {
    if (req.method === "GET") {
      const auth = await authFor(url.searchParams.get("owner_uid"));
      if (!auth.ok) return send(res, auth.status, { error: auth.error });
      return send(res, 200, { items: store.list.all(auth.ownerUid) });
    }
    if (req.method === "POST") {
      const rb = await readBodyOr400();
      if (!rb.ok) return send(res, 400, { error: rb.error });
      const body = rb.body;
      const auth = await authFor(body.owner_uid);
      if (!auth.ok) return send(res, auth.status, { error: auth.error });

      const raw = body[store.contentKey];
      if (raw == null) return send(res, 400, { error: `${store.contentKey} required` });
      const norm = store.normalize(raw);
      if (!norm.ok) return send(res, 400, { error: norm.error });
      const content = norm.blueprint ?? norm.card;

      const ts = Date.now();
      const id = randomUUID();
      const name = clip(body.name, 80) || store.defaultName;
      const icon = clip(body.icon, 16) || "✨";
      store.insert.run(id, auth.ownerUid, name, icon, JSON.stringify(content), "ai", ts, ts);
      console.log(`[yoyoo-superapp] ${prefix} create robot=${auth.robotId} owner=${auth.ownerUid} id=${id}`);
      return send(res, 201, {
        id, name, icon, owner_uid: auth.ownerUid, created_by: "ai", created_at: ts,
        url: store.deepLink(id),
      });
    }
    return send(res, 405, { error: "method not allowed" });
  }

  // ── /:id 与 /:id/publish ────────────────────────────────────────
  const seg = rel.slice(1).split("/");
  const contentId = decodeURIComponent(seg[0] || "");
  const action = seg[1] || "";

  if (action === "publish") {
    if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
    const rb = await readBodyOr400();
    if (!rb.ok) return send(res, 400, { error: rb.error });
    const body = rb.body;
    const auth = await authFor(body.owner_uid);
    if (!auth.ok) return send(res, auth.status, { error: auth.error });
    const r = market.doPublishNew(kind, auth.ownerUid, {
      appId: contentId, summary: body.summary, note: body.note,
      confirmSensitive: body.confirm_sensitive === true,
    }, Date.now());
    return send(res, r.status, r.body);
  }
  if (action) return send(res, 404, { error: "not found" });

  if (req.method === "GET") {
    const auth = await authFor(url.searchParams.get("owner_uid"));
    if (!auth.ok) return send(res, auth.status, { error: auth.error });
    const row = store.get.get(contentId, auth.ownerUid);
    if (!row) return send(res, 404, { error: "not found" });
    return send(res, 200, { ...row, [store.contentKey]: JSON.parse(row[store.contentKey]) });
  }
  if (req.method === "POST") {
    const rb = await readBodyOr400();
    if (!rb.ok) return send(res, 400, { error: rb.error });
    const body = rb.body;
    const auth = await authFor(body.owner_uid);
    if (!auth.ok) return send(res, auth.status, { error: auth.error });
    const row = store.get.get(contentId, auth.ownerUid);
    if (!row) return send(res, 404, { error: "not found" });

    let content = JSON.parse(row[store.contentKey]);
    if (body[store.contentKey] != null) {
      const norm = store.normalize(body[store.contentKey]);
      if (!norm.ok) return send(res, 400, { error: norm.error });
      content = norm.blueprint ?? norm.card;
    }
    store.update.run(
      clip(body.name, 80) || row.name, clip(body.icon, 16) || row.icon,
      JSON.stringify(content), Date.now(), contentId, auth.ownerUid);
    return send(res, 200, { ok: true });
  }
  if (req.method === "DELETE") {
    const auth = await authFor(url.searchParams.get("owner_uid"));
    if (!auth.ok) return send(res, auth.status, { error: auth.error });
    if (!store.get.get(contentId, auth.ownerUid)) return send(res, 404, { error: "not found" });
    store.remove.run(contentId, auth.ownerUid);
    market.onAppDeleted(auth.ownerUid, contentId);
    return send(res, 200, { ok: true });
  }
  return send(res, 405, { error: "method not allowed" });
}

// ── 路由 ────────────────────────────────────────────────────────
const ROOT = "/yoyoo/v1";

async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  const path = url.pathname;

  if (path === `${ROOT}/health`) {
    return send(res, 200, { ok: true, service: "yoyoo-superapp", ts: Date.now() });
  }
  // 说明书：公开、不需要任何 token——邀请函里的链接必须是一个"没有身份也能读"的地址，
  // 不然一个刚拿到 bot_token 但还没跑通鉴权的 AI 反而读不到怎么鉴权。
  if (path === `${ROOT}/manual`) {
    if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });
    let text;
    try {
      text = readFileSync(MANUAL_PATH, "utf8");
    } catch (e) {
      return send(res, 500, { error: `manual not readable: ${String(e.message || e)}` });
    }
    const m = text.match(/^<!--\s*manual-version:\s*(\d+)\s*-->/);
    res.writeHead(200, {
      "Content-Type": "text/markdown; charset=utf-8",
      "X-Manual-Version": m ? m[1] : "0",
    });
    return res.end(text);
  }
  const isMarket = path.startsWith(`${ROOT}/market`) || path === `${ROOT}/pins`;
  const isInvite = path.startsWith(`${ROOT}/invites`);
  const isCards = path.startsWith(`${ROOT}/cards`);
  const isConnectors = path.startsWith(`${ROOT}/connectors`);
  if (!path.startsWith(`${ROOT}/apps`) && !isMarket && !isInvite && !isCards && !isConnectors) {
    return send(res, 404, { error: "not found" });
  }

  // ── 邀请的公开面：兑换 / 取件 ────────────────────────────────
  // 🔴 必须挡在用户面鉴权**之前**：来兑换的是**还没有账号的外部 AI**，
  //    它手上只有一张票。票据本身就是凭据，这两条路径不需要也不该要求登录。
  if (isInvite) {
    const hit = await invites.handlePublic(req, res, { path, now: Date.now(), root: ROOT });
    if (hit) return;
  }

  // ── bot 面：AI 代表某个人管理应用/卡片 ──────────────────────
  // 🔴 必须挡在用户面鉴权**之前**。bot token 不是用户 session，
  //    拿它去问 /v1/user/current 一律 401 —— 这正是 09-02 实测撞到的墙，
  //    也是这条独立路径存在的原因（详见 SPEC-phase2 §B.0 缺口②）。
  // 🔴 也必须挡在 `/apps/:id` 解析之前，否则 "for" 会被当成一个应用 id
  //    （和 `generate` 同一个坑，那次是踩过才发现的）。
  if (path.startsWith(`${ROOT}/apps/for`)) {
    return handleBotContent("app", APP_STORE, req, res, { path, url, prefix: `${ROOT}/apps/for` });
  }
  if (path.startsWith(`${ROOT}/cards/for`)) {
    return handleBotContent("card", CARD_STORE, req, res, { path, url, prefix: `${ROOT}/cards/for` });
  }
  if (path.startsWith(`${ROOT}/connectors/for`)) {
    const hit = await connectors.handleBot(req, res, { path, url, botAuth, now: Date.now(), root: ROOT });
    if (hit) return;
    return send(res, 404, { error: "not found" });
  }

  const token =
    req.headers["token"] ||
    (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
  const uid = await whoami(Array.isArray(token) ? token[0] : token);
  if (!uid) return send(res, 401, { error: "unauthorized" });

  const now = Date.now();

  // ── 市场 / 侧栏钉位 ─────────────────────────────────────────
  // 市场所有接口都要求登录，所以挂在 whoami 之后（未登录 → 上面已经 401）。
  if (isMarket) {
    const hit = await market.handle(req, res, { path, url, uid, now, root: ROOT });
    if (hit) return;
    return send(res, 404, { error: "not found" });
  }

  // ── 邀请的用户面：出票 / 列票 / 同意 / 拒绝 / 撤票 ───────────
  if (isInvite) {
    const hit = await invites.handle(req, res, { path, url, uid, now, root: ROOT });
    if (hit) return;
    return send(res, 404, { error: "not found" });
  }

  // ── 连接器的用户面：注册 / 列表 / 删除 / 代理调用 ────────────
  if (isConnectors) {
    const hit = await connectors.handle(req, res, { path, url, uid, now, root: ROOT });
    if (hit) return;
    return send(res, 404, { error: "not found" });
  }

  const rest = path.slice(`${ROOT}/apps`.length).replace(/^\//, "");

  // 集合
  if (!rest) {
    if (req.method === "GET") {
      // 列表顺手带上"钉了没 / 来源有没有新版" —— 前端不用为这两件事各打一次接口
      return send(res, 200, { apps: market.decorateAppList(uid, q.list.all(uid)) });
    }
    if (req.method === "POST") {
      let body;
      try {
        body = await readJson(req);
      } catch (e) {
        return send(res, 400, { error: String(e.message || e) });
      }
      const name = clip(body.name, 80) || "未命名应用";
      const icon = clip(body.icon, 16);
      const createdBy = body.created_by === "ai" ? "ai" : "human";
      if (body.blueprint == null) return send(res, 400, { error: "blueprint required" });
      // 用户面也过同一道门。先前这里是**直接入库**的 —— 那意味着从前端可以把任意
      // JSON 塞进渲染器，两条入口的判据不一致。共用一份的意义就在这。
      const norm = normalizeForStore(body.blueprint);
      if (!norm.ok) return send(res, 400, { error: norm.error });
      const id = randomUUID();
      q.insert.run(id, uid, name, icon, JSON.stringify(norm.blueprint), createdBy, now, now);
      return send(res, 201, { id, name, icon, created_by: createdBy, created_at: now });
    }
    return send(res, 405, { error: "method not allowed" });
  }

  // ⚠️ 必须在解析 id 之前特判：否则 /apps/generate 会被当成 id="generate"
  //    去查一个根本不存在的应用，返回 404。
  if (rest === "generate") {
    if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
    let body;
    try {
      body = await readJson(req);
    } catch (e) {
      return send(res, 400, { error: String(e.message || e) });
    }
    const prompt = clip(body.prompt, 2000).trim();
    if (!prompt) return send(res, 400, { error: "prompt required" });

    const { blueprint, mode, note } = await generateBlueprint(prompt, LLM);
    const name = clip(body.name, 80) || prompt.slice(0, 24);
    const id = randomUUID();
    // 生成的东西一律记为 ai 造的 —— 哪怕这次是本地兜底生成的，
    // 对用户而言它就是"我说一句话，它给我造的"，来源标记要如实反映这一点。
    q.insert.run(id, uid, name, clip(body.icon, 16) || "✨", JSON.stringify(blueprint), "ai", now, now);
    return send(res, 201, { id, name, mode, note, blueprint });
  }

  // 单个
  const id = decodeURIComponent(rest.split("/")[0]);
  const subAction = rest.split("/")[1] || "";

  // /apps/:id/sync（更新到来源最新版）与 /apps/:id/revert（一键回退）
  if (subAction) {
    const hit = await market.handleAppAction(req, res, { appId: id, action: subAction, uid, now });
    if (hit) return;
    return send(res, 404, { error: "not found" });
  }

  if (req.method === "GET") {
    const row = q.get.get(id, uid);
    if (!row) return send(res, 404, { error: "not found" });
    return send(res, 200, { ...row, blueprint: JSON.parse(row.blueprint) });
  }
  if (req.method === "PUT") {
    const row = q.get.get(id, uid);
    if (!row) return send(res, 404, { error: "not found" });
    let body;
    try {
      body = await readJson(req);
    } catch (e) {
      return send(res, 400, { error: String(e.message || e) });
    }
    let bp = JSON.parse(row.blueprint);
    if (body.blueprint != null) {
      const norm = normalizeForStore(body.blueprint);
      if (!norm.ok) return send(res, 400, { error: norm.error });
      bp = norm.blueprint;
    }
    q.update.run(
      clip(body.name, 80) || row.name,
      clip(body.icon, 16) || row.icon,
      JSON.stringify(bp),
      now, id, uid);
    return send(res, 200, { ok: true });
  }
  if (req.method === "DELETE") {
    q.remove.run(id, uid);
    // 顺带清掉安装关系、侧栏钉位、更新备份 —— 否则"删了再装"会拿到一个已删的 id
    market.onAppDeleted(uid, id);
    return send(res, 200, { ok: true });
  }
  return send(res, 405, { error: "method not allowed" });
}

createServer((req, res) => {
  handle(req, res).catch((e) => {
    // 不把内部错误细节吐给前端，但要在日志里留全（排错靠日志，不靠给用户看堆栈）
    console.error("[yoyoo-superapp]", e);
    if (!res.headersSent) send(res, 500, { error: "internal error" });
  });
}).listen(PORT, () => {
  console.log(`[yoyoo-superapp] listening on :${PORT}  db=${DB_PATH}`);
  console.log(`[yoyoo-superapp] identity via ${HOST_VERIFY_URL}`);
});
