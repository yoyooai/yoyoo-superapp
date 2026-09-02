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
 */
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { generateBlueprint } from "./generate.mjs";
import { normalizeForStore } from "./blueprint.mjs";
import { createBotAuth } from "./bot-auth.mjs";
import { createMarket } from "./market.mjs";
import { createInvites } from "./invite.mjs";
import { send, readJson, clip } from "./http-util.mjs";

const PORT = Number(process.env.PORT || 8790);
const DB_PATH = process.env.DB_PATH || "./data/yoyoo-superapp.db";
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

// ── HTTP 小工具 ─────────────────────────────────────────────────
// send / readJson / clip 已抬到 http-util.mjs —— market.mjs 要用同一份，
// 留在这里会让"请求体上限"这类安全参数出现第二个值。

/** 应用深链。没配模板就返回 null —— 宁可不给链接，也不给一个瞎猜出来的地址 */
const deepLink = (id) =>
  APP_DEEP_LINK ? APP_DEEP_LINK.replace("{id}", encodeURIComponent(id)) : null;

// ── 路由 ────────────────────────────────────────────────────────
const ROOT = "/yoyoo/v1";

async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  const path = url.pathname;

  if (path === `${ROOT}/health`) {
    return send(res, 200, { ok: true, service: "yoyoo-superapp", ts: Date.now() });
  }
  const isMarket = path.startsWith(`${ROOT}/market`) || path === `${ROOT}/pins`;
  const isInvite = path.startsWith(`${ROOT}/invites`);
  if (!path.startsWith(`${ROOT}/apps`) && !isMarket && !isInvite) {
    return send(res, 404, { error: "not found" });
  }

  // ── 邀请的公开面：兑换 / 取件 ────────────────────────────────
  // 🔴 必须挡在用户面鉴权**之前**：来兑换的是**还没有账号的外部 AI**，
  //    它手上只有一张票。票据本身就是凭据，这两条路径不需要也不该要求登录。
  if (isInvite) {
    const hit = await invites.handlePublic(req, res, { path, now: Date.now(), root: ROOT });
    if (hit) return;
  }

  // ── bot 面：AI 替某个人造应用 ────────────────────────────────
  // 🔴 必须挡在用户面鉴权**之前**。bot token 不是用户 session，
  //    拿它去问 /v1/user/current 一律 401 —— 这正是 09-02 实测撞到的墙，
  //    也是这条独立路径存在的原因（详见 SPEC-phase2 §B.0 缺口②）。
  // 🔴 也必须挡在 `/apps/:id` 解析之前，否则 "for" 会被当成一个应用 id
  //    （和 `generate` 同一个坑，那次是踩过才发现的）。
  if (path === `${ROOT}/apps/for`) {
    if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
    let body;
    try {
      body = await readJson(req);
    } catch (e) {
      return send(res, 400, { error: String(e.message || e) });
    }
    const botToken = String(req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
    const auth = await botAuth.verify(botToken, body.owner_uid);
    if (!auth.ok) return send(res, auth.status, { error: auth.error });

    if (body.blueprint == null) return send(res, 400, { error: "blueprint required" });
    // AI 产的 JSON 一样是不可信输入 —— 我自己写的也不例外，我一样会写错组件名。
    const norm = normalizeForStore(body.blueprint);
    if (!norm.ok) return send(res, 400, { error: norm.error });

    const ts = Date.now();
    const id = randomUUID();
    const name = clip(body.name, 80) || "AI 造的应用";
    const icon = clip(body.icon, 16) || "✨";
    // owner 用宿主返回的规范 uid，不用请求里带来的那个字符串。
    q.insert.run(id, auth.ownerUid, name, icon, JSON.stringify(norm.blueprint), "ai", ts, ts);
    console.log(
      `[yoyoo-superapp] /apps/for robot=${auth.robotId} owner=${auth.ownerUid} app=${id} name=${JSON.stringify(name)}`);
    return send(res, 201, {
      id, name, icon,
      owner_uid: auth.ownerUid,
      created_by: "ai",
      created_at: ts,
      url: deepLink(id),
    });
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
