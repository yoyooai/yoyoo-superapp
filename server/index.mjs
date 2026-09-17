/**
 * 二元空间 超级应用 · 后端（P1）
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
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { generateBlueprint } from "./generate.mjs";
import { normalizeForStore } from "./blueprint.mjs";
import { normalizeCardForStore } from "./card-store.mjs";
import { createBotAuth } from "./bot-auth.mjs";
import { createMarket } from "./market.mjs";
import { createInvites } from "./invite.mjs";
import { createAppDownload } from "./app-download.mjs";
import { createConnectors } from "./connectors.mjs";
import { createChannelRecords } from "./channel-records.mjs";
import { createOrgChart } from "./org-chart.mjs";
import { createBotWebhooks } from "./bot-webhooks.mjs";
import { createAgentStatus } from "./agent-status.mjs";
import { createAiOwners, backfillFromInvites } from "./ai-owners.mjs";
import { createOnboarding } from "./onboarding.mjs";
import { createMeGrowth } from "./me-growth.mjs";
import { createSelfcheck } from "./selfcheck.mjs";
import { createCommerce } from "./commerce.mjs";
import { createUsage } from "./usage.mjs";
import { createWechatPay } from "./pay-wechat.mjs";
import { createPay } from "./pay.mjs";
import { createPublicServices } from "./public-services.mjs";
import { createSellMock } from "./sell-mock.mjs";
import { createGrowMock } from "./grow-mock.mjs";
import { createInnovateMock } from "./innovate-mock.mjs";
import { createCompanyMemory } from "./company-memory.mjs";
import { createActionsLog } from "./actions-log.mjs";
import { createWorklist } from "./worklist.mjs";
import { createDeviceTickets } from "./device-tickets.mjs";
import { createIntake } from "./intake.mjs";
import { createAppShares } from "./app-shares.mjs";
import { createSpaceGate } from "./space.mjs";
import { APP_SECTIONS, normalizeSection } from "./app-sections.mjs";
import { createAppLogin } from "./app-login.mjs";
import { createAppEntries } from "./app-entries.mjs";
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
// 接入指南（`/start`）—— 邀请函里唯一那个链接指向它。
// 和说明书分开的理由（苏白 09-14 夜：「邀请的内容太长了，给他一个链接让他自己去读」）：
// 说明书是**全集**，读完要很久；`/start` 是**十分钟接完的那一页**，
// 邀请函里只放一句话 + 这个链接 + 一把钥匙。路径解析同 MANUAL_PATH。
const START_PATH = process.env.START_PATH
  || join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "AI-START.md");
// 「AI 办公室」那一屏：一个**自包含单文件**（画布 + 精灵图内联成 data URI，零外部请求），
// 正本在 workspace/ai-office，本仓只存成品（bin/sync-ai-office.sh 同步）。
// 摊平发布的理由同 MANUAL_PATH（09-03 踩过 `../` 找不到的 500）。
const OFFICE_PATH = process.env.OFFICE_PATH
  || join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "ai-office.html");
// 「中际旭创 Demo 站」：一个**独立网页**，平台里的应用只是它的入口
// （09-14 苏白定的形态：应用＝入口，真东西是一个独立网页，能内嵌就嵌、不能就跳转）。
// 它是 Vite 打出来的多文件站（html + js + css + 字体），所以不像 office 那样单文件读，
// 而是整目录静态服务。正本在 workspace/zjxc-site，本仓只存成品。
// 🔴 站是按 `/eryuan/v1/site/zjxc/` 这个 base 打的包，换路径必须重打，否则资源全 404。
const SITE_ROOT = process.env.SITE_ROOT
  || join(dirname(fileURLToPath(import.meta.url)), "..", "assets");
const SITE_MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};
// 750KB 的页面每次请求现读一遍不值当（说明书才几 KB，那条可以现读）。
// 缓存住，但按 mtime 失效 —— 重发新版本不用重启容器。
let officeCache = null;
const HOST_VERIFY_URL =
  process.env.HOST_VERIFY_URL || "http://octo-server:8090/v1/user/current";
const HOST_BOT_API_URL = process.env.HOST_BOT_API_URL || "http://octo-server:8090";
// 判定"访问者在这个 Space 里加入了哪些群"。带 space_id 时宿主返回的是**加入的群**
// （不带才是"保存的群"，语义不同，这里要的是前者）——分享可见性就靠它。
const HOST_GROUPS_URL =
  process.env.HOST_GROUPS_URL || "http://octo-server:8090/v1/group/my";
/*
 * 宿主的"你加入了哪些组织"—— 组织隔离的成员资格就问这一个口。
 * 实测（09-15，小A总管账号）：`GET /v1/space/my` 带 `token` 头，直接返数组，
 * 元素形如 `{space_id, name, role, status, ...}`。
 */
const HOST_SPACES_URL =
  process.env.HOST_SPACES_URL || "http://octo-server:8090/v1/space/my";
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
    space_id    TEXT NOT NULL DEFAULT '',
    name        TEXT NOT NULL,
    icon        TEXT,
    blueprint   TEXT NOT NULL,
    -- 超级应用页上下分栏用（''＝不分区）。取值见 server/app-sections.mjs。
    section     TEXT NOT NULL DEFAULT '',
    created_by  TEXT NOT NULL DEFAULT 'human',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_apps_owner ON apps(space_id, owner_uid, updated_at DESC);
  -- cards：跟 apps 是对称的两张账本（§ SPEC-ai-manual-and-authoring.md）——
  -- 结构一模一样，只是内容列叫 card 不叫 blueprint。建表放在这里（跟 apps 一起，
  -- 由我们自己拥有），market.mjs 只负责后面 ALTER 两个市场需要的来源列，
  -- 这个顺序是硬依赖：createMarket() 必须在这张表建完之后调用。
  CREATE TABLE IF NOT EXISTS cards (
    id          TEXT PRIMARY KEY,
    owner_uid   TEXT NOT NULL,
    space_id    TEXT NOT NULL DEFAULT '',
    name        TEXT NOT NULL,
    icon        TEXT,
    card        TEXT NOT NULL,
    created_by  TEXT NOT NULL DEFAULT 'human',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_cards_owner ON cards(space_id, owner_uid, updated_at DESC);
`);

/*
 * ── 老库补列：把"只认人"的两张账本补成"认人也认组织" ──────────────
 * 09-15 苏白批的组织隔离，数据层的第一刀。已经在跑的库里这两张表没有 `space_id`，
 * `CREATE TABLE IF NOT EXISTS` 对它们不起作用 —— 必须显式补列 + 回填。
 *
 * 回填成 `OCTO_SPACE_ID`：这台服务器声明的那个组织，就是这些老数据当初所在的地方。
 * （个别应该归别的组织的，另有一次性纠正脚本，不写进这里 —— 代码里写死某几个
 *  应用 id 是一次性数据问题伪装成代码。）
 */
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((c) => c.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  return true;
}
for (const t of ["apps", "cards"]) {
  if (ensureColumn(t, "space_id", "space_id TEXT NOT NULL DEFAULT ''")) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${t}_space ON ${t}(space_id, owner_uid, updated_at DESC)`);
  }
  // 回填是幂等的：只动还空着的行，跑多少次结果一样。
  const backfill = process.env.OCTO_SPACE_ID || "";
  if (backfill) db.prepare(`UPDATE ${t} SET space_id=? WHERE space_id=''`).run(backfill);
}
/*
 * 老库补 `section` 列（09-15 苏白要的上下分栏）。
 * **不回填** —— 空就是"没分区"，界面上不画分栏标题，跟上线前一模一样。
 * 猜一个分区填进去，等于替用户做了一个他没做过的决定。
 */
ensureColumn("apps", "section", "section TEXT NOT NULL DEFAULT ''");

/*
 * 🔴 每一条都带 `space_id=?`，位置固定在 `owner_uid` 之后 ——
 * 组织隔离是在 SQL 里隔的，不是在路由里"记得加一句判断"隔的。
 * 想绕过它就得改这里，而改这里会被 `space-isolation.test.mjs` 当场拦下。
 */
const q = {
  list: db.prepare(
    `SELECT id,name,icon,section,created_by,created_at,updated_at FROM apps
      WHERE owner_uid=? AND space_id=? ORDER BY updated_at DESC LIMIT 200`),
  get: db.prepare(`SELECT * FROM apps WHERE id=? AND owner_uid=? AND space_id=?`),
  // 🔴 不带 owner 条件（但仍带组织条件）。单独用等于绕过权限——
  //    调用点**只有**分享校验通过的那一处。
  getAny: db.prepare(`SELECT * FROM apps WHERE id=? AND space_id=?`),
  insert: db.prepare(
    `INSERT INTO apps (id,owner_uid,space_id,name,icon,blueprint,section,created_by,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`),
  update: db.prepare(
    `UPDATE apps SET name=?, icon=?, blueprint=?, section=?, updated_at=? WHERE id=? AND owner_uid=? AND space_id=?`),
  remove: db.prepare(`DELETE FROM apps WHERE id=? AND owner_uid=? AND space_id=?`),
};

const qCards = {
  list: db.prepare(
    `SELECT id,name,icon,created_by,created_at,updated_at FROM cards
      WHERE owner_uid=? AND space_id=? ORDER BY updated_at DESC LIMIT 200`),
  get: db.prepare(`SELECT * FROM cards WHERE id=? AND owner_uid=? AND space_id=?`),
  insert: db.prepare(
    `INSERT INTO cards (id,owner_uid,space_id,name,icon,card,created_by,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`),
  update: db.prepare(
    `UPDATE cards SET name=?, icon=?, card=?, updated_at=? WHERE id=? AND owner_uid=? AND space_id=?`),
  remove: db.prepare(`DELETE FROM cards WHERE id=? AND owner_uid=? AND space_id=?`),
};

// ── 身份 ────────────────────────────────────────────────────────
/**
 * 拿宿主 token 去问宿主"这是谁"。
 * 带一个很短的缓存：不是为了性能，是为了别把宿主的登录接口当水龙头拧
 * （每翻一次列表就打一次它的鉴权接口，是很不客气的做法）。
 */
const identityCache = new Map(); // token -> { user, at }
const IDENTITY_TTL_MS = 60_000;

/**
 * 完整的"这是谁"。绝大多数路由只要 uid（用下面的 whoami），
 * 只有「App 登录入口」要连名字/短号一起交给网页 —— 所以缓存里存整份，
 * 别为了多几个字段再去打宿主第二次。
 */
async function hostUser(token) {
  if (!token) return null;
  const hit = identityCache.get(token);
  if (hit && Date.now() - hit.at < IDENTITY_TTL_MS) return hit.user;

  try {
    const res = await fetch(HOST_VERIFY_URL, {
      headers: { token, Authorization: token },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    const user = body?.uid ? body : body?.data?.uid ? body.data : null;
    if (!user) return null;
    identityCache.set(token, { user, at: Date.now() });
    return user;
  } catch {
    return null; // 宿主不可达时一律当未登录 —— fail closed，不放行
  }
}

async function whoami(token) {
  const user = await hostUser(token);
  return user ? user.uid : null;
}

// ── 市场（我们自己的货架；建表 + 给 apps 补两列都在里面）─────────
// 🔴 不寄生宿主的市场：它那四种货位是 MySQL ENUM 写死的，塞第五种要动它的骨头。
//    详见 SPEC-market.md §0。
const market = createMarket({
  db,
  // 🔴 这里**故意不传组织**：市场是一个组织一份，用哪一份由每次请求带的
  //    `x-space-id` 决定（见 market.mjs 文件头）。传一个默认组织进去，
  //    就是 09-15 那个"发布进 A、浏览查 B"的洞。
  // 钉位判"打不打得开"，不判"是不是你的"。`appShares` 在下面才建，
  // 这里用函数体内引用（调用发生在请求期，那时早就初始化好了）。
  canOpenApp: async ({ appId, uid, token, spaceId }) =>
    !!q.get.get(appId, uid, spaceId || "") || !!(await appShares.canView(appId, token)),
});

// 组织闸：这次请求算在哪个组织名下（详见 space.mjs 文件头）。
const spaceGate = createSpaceGate({
  hostSpacesUrl: HOST_SPACES_URL,
  defaultSpaceId: process.env.OCTO_SPACE_ID || "",
});

/*
 * ── 组织架构图的「部门层」────────────────────────────────────
 * 宿主名册是扁平的（成员/AI/设备），没有"部门"。这一层存在我们这边。
 * 写闸＝空间管理员及以上，判据来自 spaceGate.roleOfViewer（宿主给的角色），
 * 所以必须建在 spaceGate 之后。详见 org-chart.mjs 文件头。
 */
const orgChart = createOrgChart({ db, spaceGate });

// 分享到群：让工作台从"一个人的私人物品"变成"一个群能只读打开的东西"。
// 可见性判定用**访问者自己的 token**问宿主要他加入的群，服务端不持特权 token。
const appShares = createAppShares({
  db,
  hostGroupsUrl: HOST_GROUPS_URL,
  spaceId: process.env.OCTO_SPACE_ID || "",
});

/*
 * ── 「这个 AI 是谁的」归属登记册 ────────────────────────────────
 * 苏白 09-10：「每个人只能看到自己作为 owner 的这个 bot 的内容」。
 * 渠道页的可见范围就从这里算出来。必须建在 invites / channelRecords 之前 ——
 * 那两个模块都要往里写（建号那一刻、回传那一刻）。
 */
const aiOwners = createAiOwners({ db, botAuth });

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
  // 凭据交付后还能重取多久（毫秒）。默认 24 小时，见 invite.mjs 的 DEFAULT_GRACE_MS。
  graceMs: Number(process.env.INVITE_GRACE_MS) || undefined,
  // 建号那一刻就把"这个号是谁的"记下来（最硬的一档归属，见 ai-owners.mjs）。
  recordOwnership: (r) => aiOwners.record(r),
  /* 🔴 写成箭头函数而不是直接传 usage.agentQuotaGate：usage 在下面才建出来
     （它要先有 entitlements 表）。这里只在**请求发生时**才去拿它。 */
  agentQuotaGate: (a) => usage.agentQuotaGate(a),
  /* 「留一个能收消息的网址」——入驻那一步顺手把收件地址登记掉（09-16 苏白：
     "不能让他在进来注册的时候，就直接按照我们的方式去交出他自己的这个地址"）。
     🔴 二选一、不是必填：不填就还是"你自己一直挂着来取"，老住户一个字不受影响。
     🔴 同样是箭头函数：botWebhooks 在下面才建出来（理由同上面那条）。
     🔴 复用它的 registerInbox —— 门口不另长一套登记。 */
  registerInbox: (a) => botWebhooks.registerInbox(a),
});

// App 安装包下载口（登录页那两个按钮的落点，见 app-download.mjs 开头）。
// 包放在 `/data/downloads/`（宿主机目录挂进来，容器重建不丢）。
const appDownload = createAppDownload({
  dir: process.env.DOWNLOAD_DIR || `${dirname(DB_PATH)}/downloads`,
});

/*
 * 收紧可见性之前，先把票据账本里已有的归属补进登记册。
 * 不补的话，09-10 之前建的那些号会在收紧上线那一刻集体从界面上消失
 * ——看起来像"数据没了"，其实只是没人登记过它们是谁的。
 */
backfillFromInvites({ db, owners: aiOwners });

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
  // 连接器随应用一起出借 —— 判据全在 connectors.mjs 的 `lenderFor` 文件注释里，
  // 这里只提供它需要的两样东西：应用是谁的、这个人能不能看这个应用。
  resolveLenderUid: connectorLenderForApp,
  // 第一方主机名单：下游是我们自己的系统时，代理转发**真 uid**（不是化名）。
  // 由服务端配置决定，用户改不了——所以它不是一个"用户能自己扩大的信任范围"。
  // 空 = 一个都不算第一方（默认最保守）。
  firstPartyHosts: String(process.env.CONNECTOR_FIRST_PARTY_HOSTS || "").split(","),
});

// ── 外部渠道消息记录（微信/飞书…回传上来的那些）──────────────────
// 回传口的令牌只从环境读；没配就 503 关门（见 channel-records.mjs 文件头）。
const channelRecords = createChannelRecords({
  db,
  ingestToken: process.env.YOYOO_CHANNEL_INGEST_TOKEN || "",
  // 回传方自报的归属只当兜底：登记册那边挡着，覆盖不了已核验的归属。
  recordOwnership: (r) => aiOwners.record(r),
  // 让 AI 能用**它自己的**连接凭据回传（身份由宿主认定，不是自报）。
  botAuth,
});

/*
 * ── 平台出站推送（SPEC 第 4 节）──────────────────────────────
 * 长轮询那条路**原样留着**；这一条是给没有常驻进程的 AI（豆包/千问/WorkBuddy）
 * 加的反方向通道：有新消息 → 平台 POST 到它登记的 webhook_url，带 HMAC 签名。
 * 归属判定沿用 aiOwners（creator）+ spaceGate（空间管理员），不另立一套。
 */
const botWebhooks = createBotWebhooks({
  db,
  owners: aiOwners,
  spaceGate,
  botAuth,
  // 我方中继用的共享令牌；没配那条路就关着（bot 凭据那条照旧可用）。
  notifyToken: process.env.YOYOO_WEBHOOK_NOTIFY_TOKEN || "",
  // 🔴 推成功之后由平台自己把那条划掉（09-16）。豆包/千问/WorkBuddy 从不自己
  //    回执，每次醒来都从头重读队列，于是把老消息一遍遍再答一遍。这两个变量
  //    **没配就整条关着** —— 行为逐字回到"只推不划"的今天。
  //    令牌复用 NOTIFY_TOKEN 那一把：同一条链路的两头，不该有两个秘密。
  ackUrl: process.env.YOYOO_WEBHOOK_ACK_URL || "",
  ackToken: process.env.YOYOO_WEBHOOK_NOTIFY_TOKEN || "",
  sealKeyPath: `${dirname(DB_PATH)}/bot-webhook-seal.key`,
});

// ── AI 状态上报（「AI 办公室」那一屏的真实数据源）────────────────
// 苏白 09-10：「就开始做真实的数据接入」。平台库里本来只有"名册"，
// 没有"此刻在干什么" —— 这个模块就是缺的那一层（见 agent-status.mjs 文件头）。
// 令牌单独一把；没配就回退到渠道那把（同一台机器在报，不必发两个秘密）。
const agentStatus = createAgentStatus({
  db,
  ingestToken:
    process.env.YOYOO_AGENT_STATUS_TOKEN || process.env.YOYOO_CHANNEL_INGEST_TOKEN || "",
  botAuth,
  recordOwnership: (r) => aiOwners.record(r),
});

/**
 * 渠道记录按主人过滤的开关。
 * 默认**开**（苏白 09-10 定的边界）；`YOYOO_OWNER_SCOPE=0` 可以临时退回旧行为
 * ——留这个开关是为了出事能一键回退，不是为了长期两种行为并存。
 */
// ── 上岗进度（「买了就给一台能用的 AI」断在哪一节）────────────
// 苏白 09-14：在册 44 台只活 7 台，断的不是造号，是造完之后那段没人管的路。
// 🔴 这一层**不新造表**：四关全部由登记册 + 票据账本 + 状态上报算出来（见 onboarding.mjs 文件头）。
const onboarding = createOnboarding({
  db,
  owners: aiOwners,
  apiBase: process.env.INVITE_API_BASE || "",
});

// ── 体检（苏白 09-14 夜：「正好可以放在 Bot 档案里」）────────────
// 只信行为不信自报：四项全是平台这边观察到的事实，详见 selfcheck.mjs 文件头。
const selfcheck = createSelfcheck({ db, botAuth, hostBotApiUrl: HOST_BOT_API_URL });

// ── 收钱（套餐 / 订单 / 开通）────────────────────────────────
// 🔴 这一版**刻意不含支付通道**：收款主体和密钥还在苏白手上（09-14「这些都在我手上」）。
//    下单之后订单停在「等付款」，没有任何后门能把它变成「已付」——
//    付没付钱只有一个真源：支付平台的回调。详见 commerce.mjs 文件头。
/*
 * 「我的」那三件（数字名片 / 成长关系 / 新手任务）+ 隐形能力 + 收益。
 * 🔴 同 onboarding：**不新造表**，全部由已有事实算出来。详见 me-growth.mjs 文件头。
 */
const meGrowth = createMeGrowth({ db, owners: aiOwners, spaceId: process.env.OCTO_SPACE_ID || "" });

const commerce = createCommerce({ db });
/*
 * 用量与额度 —— 必须建在 commerce 之后：额度的真源是 entitlements 那张表，
 * 而那张表由 createCommerce 建。顺序反了会在启动那一刻就报"no such table"。
 */
const usage = createUsage({ db });
/*
 * 收钱的最后一段：把"下了单"变成"真的付了钱"。
 * 🔴 唯一能把订单改成已付的路就是它（commerce.mjs 里没有后门）。
 *    没配微信支付时它照样挂着 —— 但每一条路都会照实说"还没配好、缺的是什么",
 *    而不是给一个点了没反应的按钮。
 */
const wechatPay = createWechatPay();
const pay = createPay({
  commerce, wx: wechatPay,
  /* 回调地址必须是外网能打到的 https。没配就在下单那一步照实说缺它。 */
  notifyUrl: process.env.WECHAT_PAY_NOTIFY_URL || "",
});

// ── 公共服务（发现页第四格）────────────────────────────────
// 替大家跑重活的那几台机器。长在我们自己的库里，不是宿主货架的第五种类型 ——
// 它那四种是 MySQL ENUM 写死的，加一种要动它的骨头。详见 public-services.mjs 文件头。
const publicServices = createPublicServices({ db });

const OWNER_SCOPE = process.env.YOYOO_OWNER_SCOPE !== "0";

/**
 * "这次调用能不能用别人的连接器"——唯一的裁决点。
 * 放在 index.mjs 是因为它要同时看 apps 表和分享关系，而 connectors.mjs 刻意不认识应用。
 *
 * 三道闸，全通过才出借（任何一道拿不准都返回 null＝不出借）：
 *   ①这个应用存在，且**不是**访问者自己的（自己的走原路，压根不该到这）
 *   ②访问者确实能只读打开它 —— 用他自己的 token 走宿主群成员校验
 *   ③这个连接器**确实是这个应用在用的** —— id 出现在该应用蓝图里。
 *     没有这一条，就等于"能看某个应用 ⇒ 能调 owner 名下任意连接器"，
 *     那是拿着别人的密钥去打别人的系统。蓝图只有 owner 写得了，
 *     所以"借出哪几个"永远由 owner 说了算，访问者扩不了范围。
 */
async function connectorLenderForApp({ connectorId, viewerUid, viewerToken, appId, spaceId }) {
  const app = q.getAny.get(appId, spaceId || "");
  if (!app) return null;
  if (app.owner_uid === viewerUid) return null;
  const via = await appShares.canView(appId, viewerToken);
  if (!via) return null;
  // 蓝图存的是 JSON 文本，连接器 id 是 UUID（脚本里以字面量出现）——
  // 直接在文本里找这一整串就够判定，且不会误命中（UUID 够长）。
  if (!String(app.blueprint || "").includes(connectorId)) return null;
  return app.owner_uid;
}

// ── 对外路径前缀 ───────────────────────────────────────────────
// 🔴 这个平台对外只有一个名字：**二元空间**。路径里也不许再出现别的品牌名，
//    所以正式前缀是 `/eryuan/v1`（"二元"）。`/space/v1` 更好看但被宿主占了
//    （宿主 nginx 里 `location ~ ^/space(/.*)?$` 会 301 去后台），不能用。
const ROOT = "/eryuan/v1";
// 老前缀：**永久别名，不许删。** 已经进来的 AI 手里存的接入地址是这个，而
// token 只交付一次、我们改不了它记住的地址 —— 停掉老前缀就是把它们集体踢下线。
// 进门处统一归一化成 ROOT，后面所有路由只认一种写法（见 handle() 开头）。
const LEGACY_ROOTS = ["/yoyoo/v1"];

// ── App 登录入口（原生 App 的登录态 → 网页的登录态，见 app-login.mjs 文件头）──
const appLogin = createAppLogin({ hostUser, prefix: ROOT });
// ── 发现页入口清单（安卓 App 那一页的正本，见 app-entries.mjs 文件头）──
const appEntries = createAppEntries({ prefix: ROOT });
function canonicalPath(pathname) {
  for (const legacy of LEGACY_ROOTS) {
    if (pathname === legacy) return ROOT;
    if (pathname.startsWith(`${legacy}/`)) return ROOT + pathname.slice(legacy.length);
  }
  return pathname;
}

// ── Sell Loop 桩（09-03 美妆种子用户验收，见 sell-mock.mjs 文件头）──────
// 只在配了共享密钥时挂载——没配就是这条演示线关着，不给自己留一个没有凭据保护的口子。
const SELL_MOCK_SECRET = process.env.SELL_MOCK_SECRET || "";
const sellMock = SELL_MOCK_SECRET
  ? createSellMock({ db, prefix: `${ROOT}/demo/sell-backend`, secret: SELL_MOCK_SECRET })
  : null;
const GROW_MOCK_SECRET = process.env.GROW_MOCK_SECRET || "";
const growMock = GROW_MOCK_SECRET
  ? createGrowMock({ db, prefix: `${ROOT}/demo/grow-backend`, secret: GROW_MOCK_SECRET })
  : null;
const INNOVATE_MOCK_SECRET = process.env.INNOVATE_MOCK_SECRET || "";
const innovateMock = INNOVATE_MOCK_SECRET
  ? createInnovateMock({ db, prefix: `${ROOT}/demo/innovate-backend`, secret: INNOVATE_MOCK_SECRET })
  : null;
const MEMORY_MOCK_SECRET = process.env.MEMORY_MOCK_SECRET || "";
const companyMemory = MEMORY_MOCK_SECRET
  ? createCompanyMemory({ db, prefix: `${ROOT}/demo/company-memory`, secret: MEMORY_MOCK_SECRET })
  : null;
// ── 通用"标记/备注"动作日志（09-04 补，见 actions-log.mjs 文件头）──────
// 跟具体业务无关，増长/私域/供应链等新应用共用同一个连接器即可，不用一个个再起后端。
const ACTIONS_LOG_SECRET = process.env.ACTIONS_LOG_SECRET || "";
const actionsLog = ACTIONS_LOG_SECRET
  ? createActionsLog({ db, prefix: `${ROOT}/demo/actions-log`, secret: ACTIONS_LOG_SECRET })
  : null;
// ── 工作项（接力棒）：团队看板 + 个人收件箱（`?mine=1`，认代理转发的调用者身份）──
// 见 worklist.mjs 文件头；身份那一层在 connectors.mjs 的"调用者身份"一段。
const WORKLIST_SECRET = process.env.WORKLIST_SECRET || "";
const worklist = WORKLIST_SECRET
  ? createWorklist({ db, prefix: `${ROOT}/demo/worklist`, secret: WORKLIST_SECRET })
  : null;
// ── 需求池（会议/聊天 → 需求 → 任务）：AI 只出草稿，人点一下才入池 ──
// 受理后派生的待办交给 worklist —— 待办长什么样只有那一处说了算。
const INTAKE_SECRET = process.env.INTAKE_SECRET || "";
const intake = INTAKE_SECRET
  ? createIntake({
      db, prefix: `${ROOT}/demo/intake`, secret: INTAKE_SECRET,
      createWorkItem: worklist ? worklist.create : null,
    })
  : null;
// ── 设备工单看板（「设备AIOS」工单中心用）：09-08 苏白拍板先给它一个真存储 ──
// 同一个模子（挂在 prefix 下，只认共享密钥），见 device-tickets.mjs 文件头。
const DEVICE_TICKETS_SECRET = process.env.DEVICE_TICKETS_SECRET || "";
const deviceTickets = DEVICE_TICKETS_SECRET
  ? createDeviceTickets({ db, prefix: `${ROOT}/demo/device-tickets`, secret: DEVICE_TICKETS_SECRET })
  : null;

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
/*
 * ── bot 面算在哪个组织名下 ────────────────────────────────────
 * AI 来存东西时手上只有自己的连接凭据，没有用户登录态，所以问不出"当前组织"。
 * 这一档一律算在这台服务器声明的组织（`OCTO_SPACE_ID`）名下 —— 跟组织隔离之前
 * 的行为完全一致，不会让谁的东西突然不见。
 * 🔴 已知缺口：等 `ai_owners` 也分组织之后（下一刀），这里要改成"按这台 AI 的
 *    归属组织"。在那之前，一台 AI 只服务一个组织。
 */
const BOT_SPACE_ID = process.env.OCTO_SPACE_ID || "";

/*
 * ── bot 面写进别的组织：`space_id` 这一位 ─────────────────────
 * 起因（09-15 苏白，OCTO 群）：「你直接改动代码，或者你直接加到那个组织不就可以了吗？」
 *
 * 为什么"把 bot 拉进那个组织"解决不了：bot 手上那把 `bf_…` 不是登录态，
 * 拿它问宿主 `GET /v1/space/my` 返 401（实测）。**平台问不出"这个 bot 属于哪些组织"**，
 * 所以哪怕真把它拉进去了，上面那行仍然钉在自己那一个组织上。
 *
 * 判成员资格的三条路，为什么选第三条：
 *   ①按 bot 自己的登录态判 —— 没有登录态，走不通（就是上面那条）
 *   ②谁传什么组织就写什么组织 —— 等于任何一台被允许调这个口的 AI，
 *     都能往别人组织里塞东西。这是后门，不做。
 *   ③**运维在配置里显式声明这台服务器的 bot 可以写哪几个组织** —— 采用。
 *     权限来源是部署这台服务器的人，不是请求里的一个字符串；
 *     名单写在 env 里，谁能写哪个组织一眼看得见。
 *
 * 缺省行为一个字没变：不传 `space_id` ⇒ 仍然是 `OCTO_SPACE_ID`。
 * 🔴 等 `ai_owners` 也分组织之后，这里应该换成"按这台 AI 的归属组织"，
 *    那时这份名单就可以退役。在那之前它是诚实的表达，不是将就。
 */
const BOT_SPACE_ALLOW = new Set(
  [BOT_SPACE_ID, ...String(process.env.OCTO_BOT_SPACE_IDS || "").split(",")]
    .map((s) => s.trim())
    .filter(Boolean)
);

/**
 * 这一次请求写进哪个组织。
 * 返回 `{ ok:true, spaceId }` 或 `{ ok:false, status, error }` —— 调用方必须当作可能失败。
 */
function resolveBotSpace(raw) {
  const want = String(raw == null ? "" : raw).trim();
  if (!want) return { ok: true, spaceId: BOT_SPACE_ID };
  if (want === BOT_SPACE_ID) return { ok: true, spaceId: want };
  if (!BOT_SPACE_ALLOW.has(want)) {
    return {
      ok: false,
      status: 403,
      error: `这台服务器的 bot 不能写组织 ${want}；要放行请把它加进 OCTO_BOT_SPACE_IDS`,
    };
  }
  return { ok: true, spaceId: want };
}

/** 读那三条（列表 / 详情 / 删）两种内容完全对称，`space_id` 钉成本次请求那个。 */
const botScoped = (st, spaceId) => ({
  list: { all: (uid) => st.list.all(uid, spaceId) },
  get: { get: (id, uid) => st.get.get(id, uid, spaceId) },
  remove: { run: (id, uid) => st.remove.run(id, uid, spaceId) },
});

/*
 * 写入用**具名参数**，不用位置参数。
 *
 * 为什么（09-15 加 `section` 列时踩到的）：应用有分区、卡片没有，两边的列不再对称。
 * 位置参数下，`handleBotContent` 那一句 `store.insert.run(a,b,c,…)` 要同时对两种
 * 内容成立，加一列就得在共用代码里写"如果是应用就多塞一个" —— 那是把差异藏进
 * 调用方。改成具名之后，多出来的那一列由 APP_STORE 自己消化，卡片那边一个字不用改。
 */
const APP_STORE = (spaceId) => ({
  contentKey: "blueprint",
  defaultName: "AI 造的应用",
  hasSection: true,
  ...botScoped(q, spaceId),
  create: ({ id, ownerUid, name, icon, content, section, ts }) =>
    q.insert.run(id, ownerUid, spaceId, name, icon, content, section || "", "ai", ts, ts),
  save: ({ id, ownerUid, name, icon, content, section, ts }) =>
    q.update.run(name, icon, content, section || "", ts, id, ownerUid, spaceId),
  normalize: (raw, opts) => normalizeForStore(raw, opts),
  deepLink,
});
const CARD_STORE = (spaceId) => ({
  contentKey: "card",
  defaultName: "AI 造的卡片",
  hasSection: false, // 卡片不分区：分区是"应用摆在超级应用页哪一栏"，卡片不在那一页上
  ...botScoped(qCards, spaceId),
  create: ({ id, ownerUid, name, icon, content, ts }) =>
    qCards.insert.run(id, ownerUid, spaceId, name, icon, content, "ai", ts, ts),
  save: ({ id, ownerUid, name, icon, content, ts }) =>
    qCards.update.run(name, icon, content, ts, id, ownerUid, spaceId),
  normalize: (raw, opts) => normalizeCardForStore(raw, opts),
  deepLink: () => null, // 卡片没有独立深链页面，装完就在"我的卡片"列表里
});

/**
 * bot 面对某一种内容（app|card）的全套 CRUD + 市场操作。
 * `prefix` 形如 `/eryuan/v1/apps/for` 或 `/eryuan/v1/cards/for`。
 *
 * 路由表（`rel` = path 去掉 prefix 之后剩下的部分）：
 *   ''                     GET 列表 / POST 造一个新的
 *   '/market'              GET 逛市场
 *   '/market/:id/install'  POST 装
 *   '/:id'                 GET 详情 / POST 编辑（局部更新） / DELETE 删除
 *   '/:id/publish'         POST 发布到市场
 *   '/:id/share'           POST 分享到群（只 app）/ '/:id/unshare' 取消
 *
 * 每一步都先 `botAuth.verify(token, ownerUid)`——owner_uid 从 query（GET）或
 * body（POST/DELETE 也走 body，浏览器 DELETE 带 body 不方便，所以 DELETE 走 query）里取，
 * 跟 `/apps/for` 创建时的规矩一致：**永远用宿主返回的规范 uid，不用请求里那个字符串**。
 */
async function handleBotContent(kind, makeStore, req, res, { path, url, prefix }) {
  const rel = path.slice(prefix.length);
  const botToken = String(req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");

  // 写进哪个组织。用 `x-space-id` 这个头，和用户面同一个名字 —— GET/POST/DELETE
  // 走同一条路，不用在读 body 之前先猜一次。不带就是这台服务器自己那个组织。
  const space = resolveBotSpace(req.headers["x-space-id"]);
  if (!space.ok) return send(res, space.status, { error: space.error });
  const store = makeStore(space.spaceId);

  // 🔴 owner 的成员资格按**这次要写进的组织**问，不是按服务器默认那个 ——
  //    否则会把应用记在一个不在目标组织里的人名下，谁都看不见。
  async function authFor(ownerUidRaw) {
    return botAuth.verify(botToken, ownerUidRaw, space.spaceId);
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
    }, space.spaceId);
    return send(res, r.status, r.body);
  }
  if (rel.startsWith("/market/")) {
    const seg = rel.slice("/market/".length).split("/");
    const listingId = decodeURIComponent(seg[0] || "");
    const action = seg[1] || "";
    /*
     * 🔴 下架（09-15 夜补）：在这之前 bot 能发布、不能下架 —— 这个不对称是真踩到的：
     *   我把一条应用建错了作者，删掉应用之后，它在市场里的卡片还挂着，
     *   而且谁都撤不掉（下架只有用户面那条路，要作者本人的登录态）。
     *   发布和下架必须是一对。作者校验在 market 那边做（只有作者能下架）。
     */
    if (action === "delist") {
      if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
      const rb = await readBodyOr400();
      if (!rb.ok) return send(res, 400, { error: rb.error });
      const auth = await authFor(rb.body.owner_uid);
      if (!auth.ok) return send(res, auth.status, { error: auth.error });
      const r = market.doDelist(kind, auth.ownerUid, listingId, Date.now(), space.spaceId);
      return send(res, r.status, r.body);
    }
    if (action !== "install") return send(res, 404, { error: "not found" });
    if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
    const rb = await readBodyOr400();
    if (!rb.ok) return send(res, 400, { error: rb.error });
    const auth = await authFor(rb.body.owner_uid);
    if (!auth.ok) return send(res, auth.status, { error: auth.error });
    const r = market.doInstall(kind, auth.ownerUid, listingId, Date.now(), space.spaceId);
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
      const sec = store.hasSection ? normalizeSection(body.section) : { ok: true, section: "" };
      if (!sec.ok) return send(res, 400, { error: sec.error });
      store.create({ id, ownerUid: auth.ownerUid, name, icon, content: JSON.stringify(content), section: sec.section, ts });
      console.log(`[yoyoo-superapp] ${prefix} create robot=${auth.robotId} owner=${auth.ownerUid} space=${space.spaceId || "(none)"} id=${id}`);
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
    }, Date.now(), space.spaceId);
    return send(res, r.status, r.body);
  }
  // ── /:id/share 与 /:id/unshare（只有 app 有分享概念）───────────
  // 让小A 在聊天里一句话就能把工作台分享进某个群，不用人去后台点。
  if (action === "share" || action === "unshare") {
    if (kind !== "app") return send(res, 404, { error: "not found" });
    if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
    const rb = await readBodyOr400();
    if (!rb.ok) return send(res, 400, { error: rb.error });
    const body = rb.body;
    const auth = await authFor(body.owner_uid);
    if (!auth.ok) return send(res, auth.status, { error: auth.error });

    // 🔴 只有 owner 能决定自己的应用分享去哪 —— 先确认这个应用真的是他的。
    if (!store.get.get(contentId, auth.ownerUid)) return send(res, 404, { error: "not found" });

    const groupNo = String(body.group_no || "").trim();
    if (!groupNo) return send(res, 400, { error: "group_no 必填" });

    if (action === "share") appShares.share(contentId, groupNo, auth.ownerUid);
    else appShares.unshare(contentId, groupNo);

    return send(res, 200, { ok: true, shared_to: appShares.groupsFor(contentId) });
  }

  if (action) return send(res, 404, { error: "not found" });

  if (req.method === "GET") {
    const auth = await authFor(url.searchParams.get("owner_uid"));
    if (!auth.ok) return send(res, auth.status, { error: auth.error });
    const row = store.get.get(contentId, auth.ownerUid);
    if (!row) return send(res, 404, { error: "not found" });
    return send(res, 200, {
      ...row,
      [store.contentKey]: JSON.parse(row[store.contentKey]),
      // 分享状态一并带上。第一版没带，排查"分享还在不在"时这里返回 undefined，
      // 差点被误读成分享记录被删了 —— 查询接口少一个字段，会让人对着好数据做错判断。
      ...(kind === "app" ? { section: row.section || "", shared_to: appShares.groupsFor(contentId) } : {}),
    });
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
      // 更新 ⇒ 把前一版交给设计闸做棘轮判定（违规条数只许变少或持平）。
      // 不传 prev 就会被当成新建走严格档，存量内容改一个字都存不回去。
      const norm = store.normalize(body[store.contentKey], { prev: content });
      if (!norm.ok) return send(res, 400, { error: norm.error });
      content = norm.blueprint ?? norm.card;
    }
    // 不传 `section` ＝ 不动它（跟 name/icon/blueprint 一个规矩）。
    let section = row.section || "";
    if (store.hasSection && body.section !== undefined) {
      const sec = normalizeSection(body.section);
      if (!sec.ok) return send(res, 400, { error: sec.error });
      section = sec.section;
    }
    store.save({
      id: contentId, ownerUid: auth.ownerUid,
      name: clip(body.name, 80) || row.name,
      icon: clip(body.icon, 16) || row.icon,
      content: JSON.stringify(content), section, ts: Date.now(),
    });
    return send(res, 200, { ok: true });
  }
  if (req.method === "DELETE") {
    const auth = await authFor(url.searchParams.get("owner_uid"));
    if (!auth.ok) return send(res, auth.status, { error: auth.error });
    if (!store.get.get(contentId, auth.ownerUid)) return send(res, 404, { error: "not found" });
    store.remove.run(contentId, auth.ownerUid);
    market.onAppDeleted(auth.ownerUid, contentId);
    if (kind === "app") appShares.onAppDeleted(contentId);
    return send(res, 200, { ok: true });
  }
  return send(res, 405, { error: "method not allowed" });
}

// ── 路由 ────────────────────────────────────────────────────────
// 前缀常量 ROOT / LEGACY_ROOTS / canonicalPath 在文件上半部声明（桩挂载要用）。

async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  // 老前缀在这一行就被归一化成 ROOT —— 下面每条路由都只写 ROOT 一种形式。
  // 别在下面再判断老前缀：多一处判断就多一个会漏改的地方。
  const path = canonicalPath(url.pathname);

  // 分区清单 —— 公开只读。前端拿它画分栏标题，不自己抄一份写死的表。
  if (path === `${ROOT}/app-sections`) {
    if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });
    return send(res, 200, { sections: APP_SECTIONS });
  }
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

  // 接入指南：和说明书同样**公开、不需要 token**（理由同上一段）。
  if (path === `${ROOT}/start`) {
    if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });
    let text;
    try {
      text = readFileSync(START_PATH, "utf8");
    } catch (e) {
      return send(res, 500, { error: `start guide not readable: ${String(e.message || e)}` });
    }
    const m = text.match(/^<!--\s*start-version:\s*(\d+)\s*-->/);
    res.writeHead(200, {
      "Content-Type": "text/markdown; charset=utf-8",
      "X-Start-Version": m ? m[1] : "0",
    });
    return res.end(text);
  }

  // 安装包下载：公开、不需要身份 —— 这是给还没有账号的人用的，要 token 就是死循环。
  // 地址形如 `${ROOT}/download/android`；宿主 `app_version` 表里那一行要指向它，
  // 否则登录页按钮拿到 204、什么都不会发生（2026-09-13 的原始症状）。
  if (path.startsWith(`${ROOT}/download/`)) {
    const os = path.slice(`${ROOT}/download/`.length);
    if (await appDownload.handle(req, res, { os })) return;
  }

  // App 登录入口：页面本身公开（它就是用来换登录态的，要 token 才给页面是死循环），
  // 真正的校验在它的 /verify 上，且一律服务端问宿主。
  if (path === `${ROOT}/app-login` || path === `${ROOT}/app-login/verify`) {
    if (await appLogin.handle(req, res, { path })) return;
  }

  // 发现页的菜单：公开只读，没有身份 —— App 还没登录时这一页也得画得出来。
  if (path === `${ROOT}/app-entries`) {
    if (await appEntries.handle(req, res, { path })) return;
  }

  // AI 办公室：公开、不需要 token —— 它是壳里 iframe 直接加载的一页，
  // 加载时机在 React 拿到身份之前；要 token 只会换来一屏白。
  // 页面本身**不含任何人的数据**（目前是示例数据），公开没有暴露面。
  if (path === `${ROOT}/office`) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return send(res, 405, { error: "method not allowed" });
    }
    try {
      const st = statSync(OFFICE_PATH);
      if (!officeCache || officeCache.mtimeMs !== st.mtimeMs) {
        const body = readFileSync(OFFICE_PATH);
        officeCache = {
          mtimeMs: st.mtimeMs,
          body,
          // 强校验符：内容变了它必变，内容没变它必不变（mtime + 字节数）。
          etag: `"${Math.floor(st.mtimeMs).toString(36)}-${body.length.toString(36)}"`,
          lastModified: new Date(st.mtimeMs).toUTCString(),
        };
      }
    } catch (e) {
      return send(res, 500, { error: `office page not readable: ${String(e.message || e)}` });
    }
    /*
     * 🔴 2026-09-15：这一页是 **3.3MB 的自包含单文件**，而原先只发了
     *    `Cache-Control: no-cache`、**没有任何校验符** ⇒ 浏览器每次回源问，
     *    服务端每次只能整份重发。点一次办公室重下 3.3MB，慢得能看见半成品
     *    （苏白报的「打开的时候会有一部分旧的缓存」就是那半成品）。
     *    补上 ETag / Last-Modified 之后，没改过的那次回应是一个 304 空包。
     *    `no-cache` 保留 —— 我们要的是"每次问一句"，不是"缓存一天"：
     *    发布之后必须立刻拿到新的，不能等缓存过期。
     */
    const etag = officeCache.etag;
    const inm = req.headers["if-none-match"];
    const ims = req.headers["if-modified-since"];
    const fresh =
      (typeof inm === "string" && inm.split(",").some((v) => v.trim() === etag)) ||
      (!inm && typeof ims === "string" && ims === officeCache.lastModified);
    if (fresh) {
      res.writeHead(304, {
        ETag: etag,
        "Last-Modified": officeCache.lastModified,
        "Cache-Control": "no-cache",
      });
      return res.end();
    }
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": officeCache.body.length,
      ETag: etag,
      "Last-Modified": officeCache.lastModified,
      // 自包含单文件、内容随发布变 —— 让浏览器缓存但每次回源问一句。
      "Cache-Control": "no-cache",
    });
    // HEAD 只要头（前端用它探"这一页在不在"，见 shell/OfficePage.tsx）
    return req.method === "HEAD" ? res.end() : res.end(officeCache.body);
  }

  // 独立网页站（第一个是中际旭创 Demo）。公开只读，跟 /office 同理：
  // 壳里 iframe 直接加载，加载时机在拿到身份之前，要 token 只会换来一屏白；
  // 页面本身是演示数据，不含任何人的数据。
  if (path.startsWith(`${ROOT}/site/`)) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return send(res, 405, { error: "method not allowed" });
    }
    // 🔴 路径穿越：先 normalize 再校验前缀。少了这一步，`..%2f..%2fetc/passwd`
    //    能把容器里任意文件读走 —— 这是静态目录服务唯一真正危险的地方。
    const rel = decodeURIComponent(path.slice(`${ROOT}/site/`.length));
    const full = normalize(join(SITE_ROOT, rel));
    const base = normalize(SITE_ROOT);
    if (!full.startsWith(base + "/")) return send(res, 403, { error: "forbidden" });
    // 目录或无扩展名 ⇒ 给该站的 index.html（hash 路由，所有页面同一个入口）
    let file = full;
    try {
      if (!extname(file) || statSync(file).isDirectory()) file = join(file, "index.html");
    } catch {
      file = join(full, "index.html");
    }
    let body;
    let st;
    try {
      body = readFileSync(file);
      st = statSync(file);
    } catch {
      return send(res, 404, { error: "not found" });
    }
    const ext = extname(file).toLowerCase();
    /*
     * 🔴 长缓存**只给文件名里带内容指纹的资源**（Vite/Next 那种 `index-DOY9_Ef7.js`）。
     *
     * 09-15 踩的坑：这里原来是"非 .html 一律 max-age=1年 + immutable"。
     * `zjxc-aios` 那个站是手写的，文件名固定就叫 `app.js` / `styles.css` ——
     * 于是每一个打开过这个站的浏览器，把旧的 app.js **锁死一年**。
     * 后果是覃彩虹连着两次反馈"你说改好的东西我这边根本没变"：
     * 我们发了，她那边一个字节都没重新下载。
     * 发布了却送不到，比没发布更糟 —— 它会让两边都以为是对方在胡说。
     *
     * 判据只能是"名字里有没有指纹"，不能是"是不是 .js"：
     * 指纹名改内容必改名，长缓存才是安全的；固定名必须每次回源问一句。
     */
    const hashed = /-[A-Za-z0-9_]{8,}\.[a-z0-9]+$/.test(basename(file));
    // 弱 ETag：改动必然改 size 或 mtime。回源问一句很便宜，304 不传正文。
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, { ETag: etag, "Cache-Control": hashed ? "public, max-age=31536000, immutable" : "no-cache" });
      return res.end();
    }
    res.writeHead(200, {
      "Content-Type": SITE_MIME[ext] || "application/octet-stream",
      "Content-Length": body.length,
      ETag: etag,
      "Last-Modified": new Date(st.mtimeMs).toUTCString(),
      "Cache-Control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
    });
    return req.method === "HEAD" ? res.end() : res.end(body);
  }

  // Sell 桩：自己的鉴权（共享密钥），挡在 apps/market/... 那道门之前——
  // 它本来就不属于那几类，硬塞进那道门只会被 404 掉。
  if (sellMock && path.startsWith(`${ROOT}/demo/sell-backend`)) {
    const hit = await sellMock.handle(req, res, { path, url, llm: LLM, now: Date.now() });
    if (hit) return;
    return send(res, 404, { error: "not found" });
  }
  if (growMock && path.startsWith(`${ROOT}/demo/grow-backend`)) {
    const hit = await growMock.handle(req, res, { path, url, llm: LLM, now: Date.now() });
    if (hit) return;
    return send(res, 404, { error: "not found" });
  }
  if (innovateMock && path.startsWith(`${ROOT}/demo/innovate-backend`)) {
    const hit = await innovateMock.handle(req, res, { path, url, llm: LLM, now: Date.now() });
    if (hit) return;
    return send(res, 404, { error: "not found" });
  }
  if (companyMemory && path.startsWith(`${ROOT}/demo/company-memory`)) {
    const hit = await companyMemory.handle(req, res, { path });
    if (hit) return;
    return send(res, 404, { error: "not found" });
  }
  if (actionsLog && path.startsWith(`${ROOT}/demo/actions-log`)) {
    const hit = await actionsLog.handle(req, res, { path, url });
    if (hit) return;
    return send(res, 404, { error: "not found" });
  }
  if (worklist && path.startsWith(`${ROOT}/demo/worklist`)) {
    const hit = await worklist.handle(req, res, { path, url, now: Date.now() });
    if (hit) return;
    return send(res, 404, { error: "not found" });
  }
  if (deviceTickets && path.startsWith(`${ROOT}/demo/device-tickets`)) {
    const hit = await deviceTickets.handle(req, res, { path, now: Date.now() });
    if (hit) return;
    return send(res, 404, { error: "not found" });
  }
  if (intake && path.startsWith(`${ROOT}/demo/intake`)) {
    const hit = await intake.handle(req, res, { path, url, now: Date.now() });
    if (hit) return;
    return send(res, 404, { error: "not found" });
  }

  const isMarket = path.startsWith(`${ROOT}/market`) || path === `${ROOT}/pins`;
  const isInvite = path.startsWith(`${ROOT}/invites`);
  const isCards = path.startsWith(`${ROOT}/cards`);
  const isConnectors = path.startsWith(`${ROOT}/connectors`);
  const isChannelRecords = path.startsWith(`${ROOT}/channel-records`);
  const isAgents = path.startsWith(`${ROOT}/agents`);
  const isAgentStatus = path.startsWith(`${ROOT}/agent-status`);
  const isOnboarding = path.startsWith(`${ROOT}/onboarding`);
  const isSelfcheck = path === `${ROOT}/selfcheck`;
  const isCommerce = path.startsWith(`${ROOT}/commerce`);
  const isPublicServices = path.startsWith(`${ROOT}/public-services`);
  const isUsage = path.startsWith(`${ROOT}/usage`);
  const isMe = path.startsWith(`${ROOT}/me`);
  // 🔴 新增一条路由必须同时加进下面这张白名单 —— 漏了就是 404，
  //    而且是"路由写得好好的却怎么都不通"那种最难查的 404（09-16 栽过一次）。
  const isOrgChart = path === `${ROOT}/org-chart`;
  const isBotWebhooks = path.startsWith(`${ROOT}/bot-webhooks`);
  if (
    !path.startsWith(`${ROOT}/apps`) && !isMarket && !isInvite && !isCards &&
    !isConnectors && !isChannelRecords && !isAgents && !isAgentStatus &&
    !isOnboarding && !isCommerce && !isPublicServices && !isUsage && !isSelfcheck &&
    !isMe && !isOrgChart && !isBotWebhooks
  ) {
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

  // ── 支付回调口：**必须挡在用户面鉴权之前** ────────────────────
  //    来敲门的是微信的服务器，它没有、也不该有用户登录态。
  //    它带的凭据是**签名**，由 pay-wechat.mjs 验；验不过就拒收。
  if (await pay.handleNotify(req, res, { path, root: ROOT })) return;

  // ── 渠道记录回传口：**必须挡在用户面鉴权之前** ────────────────
  //    回传方是 AI 的宿主机，没有用户 session（同 bot 面那几条路径的理由）。
  if (await channelRecords.handleIngest(req, res, { path, root: ROOT })) return;

  // ── 出站推送的投递口：**必须挡在用户面鉴权之前** ────────────────
  //    来投递的是平台自己的中继或 AI 自己的机器，都没有用户 session。
  if (await botWebhooks.handleNotify(req, res, { path, root: ROOT })) return;

  // ── AI 状态上报口：同上，上报方是 AI 的宿主机，没有用户 session ──
  if (await agentStatus.handleReport(req, res, { path, root: ROOT })) return;

  // ── 体检口：**必须挡在用户面鉴权之前** —— 来体检的是 AI 自己，
  //    它手上只有自己的连接凭据（同上报口的理由）。GET 那一支是档案页读结果用的。
  if (await selfcheck.handle(req, res, { path, url, root: ROOT })) return;

  // ── AI 回来拉审批结果的口：同上，问的是 AI 自己，带的是它自己的连接凭据 ──
  //    这个口是「审批」那个按钮能立住的原因：平台推不动 AI，但 AI 会回来问。
  if (await agentStatus.handleInbox(req, res, { path, url, root: ROOT })) return;

  const token =
    req.headers["token"] ||
    (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
  const uid = await whoami(Array.isArray(token) ? token[0] : token);
  if (!uid) return send(res, 401, { error: "unauthorized" });

  /*
   * ── 这次请求算在哪个组织名下 ──────────────────────────────
   * 前端把当前组织放在 `x-space-id` 头里（`WKApp.shared.currentSpaceId`）。
   * 🔴 头是客户端说的，所以**服务端必须验**：拿访问者自己的 token 去问宿主
   *    "你在哪些组织"，不在里面就 403。详见 space.mjs 文件头。
   */
  const spaceHit = await spaceGate.resolve({
    token: Array.isArray(token) ? token[0] : token,
    headerSpaceId: req.headers["x-space-id"],
  });
  if (spaceHit.error) return send(res, spaceHit.status, { error: spaceHit.error });
  const spaceId = spaceHit.spaceId;

  const now = Date.now();

  // ── 市场 / 侧栏钉位 ─────────────────────────────────────────
  // 市场所有接口都要求登录，所以挂在 whoami 之后（未登录 → 上面已经 401）。
  if (isMarket) {
    const hit = await market.handle(req, res, {
      path, url, uid, now, root: ROOT, spaceId,
      token: Array.isArray(token) ? token[0] : token,
    });
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
    const hit = await connectors.handle(req, res, {
      path, url, uid, now, root: ROOT, spaceId,
      // 出借判定要拿访问者自己的 token 去问宿主"你在哪些群"——服务端不代持凭据。
      token: Array.isArray(token) ? token[0] : token,
    });
    if (hit) return;
    return send(res, 404, { error: "not found" });
  }

  // ── 组织架构图的部门层（读：本组织成员；写：管理员及以上）──
  if (isOrgChart) {
    const hit = await orgChart.handle(req, res, {
      path, uid, root: ROOT, spaceId,
      token: Array.isArray(token) ? token[0] : token,
    });
    if (hit) return;
  }

  // ── 出站推送的登记面（主人或空间管理员）──────────────────────
  if (isBotWebhooks) {
    const hit = await botWebhooks.handle(req, res, {
      path, uid, root: ROOT, spaceId,
      token: Array.isArray(token) ? token[0] : token,
    });
    if (hit) return;
    return send(res, 404, { error: "not found" });
  }

  // ── 我名下有哪些 AI（归属登记册的用户面）──────────────────
  if (isAgents) {
    const hit = await aiOwners.handle(req, res, { path, uid, root: ROOT });
    if (hit) return;
    return send(res, 404, { error: "not found" });
  }

  // ── 上岗进度：我名下每台 AI 走到第几关、卡在哪、下一步点什么 ──
  if (isOnboarding) {
    const hit = await onboarding.handle(req, res, { path, url, uid, root: ROOT });
    if (hit) return;
    return send(res, 404, { error: "not found" });
  }

  // ── 「我的」：数字名片 / 成长关系 / 新手任务 / 隐形能力 / 收益 ──
  //    名字要连带给出去（名片上得有名字），所以这里再取一次完整身份 ——
  //    hostUser 有 60 秒缓存，不会因此多打宿主一次。
  if (isMe) {
    const u = await hostUser(Array.isArray(token) ? token[0] : token);
    const hit = await meGrowth.handle(req, res, {
      path, url, uid, viewerName: u?.name || u?.nickname || null, root: ROOT,
    });
    if (hit) return;
    return send(res, 404, { error: "not found" });
  }

  // ── 收钱：套餐 / 我的订单 / 我开通了什么 ─────────────────
  if (isCommerce) {
    /* 开付款码：路径形如 /commerce/orders/:id/pay。
       🔴 必须排在 commerce.handle 前面 —— 否则会被它那条 orders/ 的分支吃掉。 */
    if (await pay.handleUser(req, res, { path, uid, root: ROOT })) return;
    const hit = await commerce.handle(req, res, { path, url, uid, root: ROOT });
    if (hit) return;
    return send(res, 404, { error: "not found" });
  }

  // ── 用量与额度：这个月用了多少、额度还剩多少 ───────────────
  if (isUsage) {
    const hit = await usage.handle(req, res, { path, url, uid, root: ROOT });
    if (hit) return;
    return send(res, 404, { error: "not found" });
  }

  // ── 公共服务：谁登记了哪台替大家跑重活的机器 ─────────────
  // 读是全空间可见（这是一张公共货架）；改 / 删只有登记人自己。
  if (isPublicServices) {
    const hit = await publicServices.handle(req, res, { path, url, uid, root: ROOT });
    if (hit) return;
    return send(res, 404, { error: "not found" });
  }

  // ── 渠道记录的读取面：只看得到自己名下 AI 的记录 ───────────
  // 苏白 09-10：「这些 A 属于谁谁就能看到，不属于他的他都看不到」。
  // 可见范围来自**可核验的归属登记**，不是记录里那个自报的 owner_uid 字段。
  if (isChannelRecords) {
    const hit = await channelRecords.handle(req, res, {
      path, url, root: ROOT,
      scopeAiUids: OWNER_SCOPE ? aiOwners.aiUidsOf(uid) : null,
    });
    if (hit) return;
    return send(res, 404, { error: "not found" });
  }

  // ── AI 状态的读取面：同一套边界（只看得到自己名下 AI 的状态）────
  if (isAgentStatus) {
    // ── 人做决定（批 / 驳 / 撤回 / 处置问题）：POST，要登录、要在可见范围内 ──
    //    放在 handle 之前：handle 只认 GET，POST 会被它 405 掉。
    const acted = await agentStatus.handleAct(req, res, {
      path, root: ROOT, uid,
      scopeAiUids: OWNER_SCOPE ? aiOwners.aiUidsOf(uid) : null,
    });
    if (acted) return;
    const hit = await agentStatus.handle(req, res, {
      path, url, root: ROOT,
      scopeAiUids: OWNER_SCOPE ? aiOwners.aiUidsOf(uid) : null,
      // 🔴 名册以**本平台的归属登记册**为准（苏白 09-10 夜：「只显示在我们平台里边的」）。
      //    没上报的 AI 也要占一个工位、灰着写「未上报」——
      //    这一屏是"我们平台的办公室"，不是"谁装了上报脚本谁才存在"。
      roster: aiOwners.listOf(uid),
    });
    if (hit) return;
    return send(res, 404, { error: "not found" });
  }

  const rest = path.slice(`${ROOT}/apps`.length).replace(/^\//, "");

  // 集合
  if (!rest) {
    if (req.method === "GET") {
      // 列表顺手带上"钉了没 / 来源有没有新版" —— 前端不用为这两件事各打一次接口
      const mine = market.decorateAppList(uid, q.list.all(uid, spaceId));

      // 别人分享到"我在的群"里的工作台也要出现在这里。
      // 🔴 09-04 苏白实测：同事进来「我的应用 0」。应用其实打得开（深链直达），
      //    但列表只查 `owner_uid=自己` —— 对她而言就是"我这儿什么都没有"，
      //    唯一的路是等别人把链接贴给她。分享要成立，被分享的东西就得上她的架子。
      //    标 `readonly:true` + `shared_via_group`，让前端说得清"这是别人的，我只能看"。
      const sharedIds = await appShares.sharedAppsFor(Array.isArray(token) ? token[0] : token);
      const sharedRows = [];
      const groupOf = new Map();
      for (const [appId, groupNo] of sharedIds) {
        const row = q.getAny.get(appId, spaceId);
        if (!row || row.owner_uid === uid) continue; // 自己的已经在上面了，不重复
        groupOf.set(row.id, groupNo);
        sharedRows.push({
          id: row.id, name: row.name, icon: row.icon, section: row.section || "",
          created_by: row.created_by, created_at: row.created_at, updated_at: row.updated_at,
        });
      }
      // 走同一个 decorateAppList：钉位是**按人**存的，别人分享来的一样钉得住，
      // 自己写一份"pinned: false"会让列表和侧栏各说各话。
      const shared = market.decorateAppList(uid, sharedRows).map((a) => ({
        ...a, readonly: true, shared_via_group: groupOf.get(a.id),
      }));
      shared.sort((a, b) => b.updated_at - a.updated_at);
      return send(res, 200, { apps: [...mine, ...shared] });
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
      const sec = normalizeSection(body.section);
      if (!sec.ok) return send(res, 400, { error: sec.error });
      q.insert.run(id, uid, spaceId, name, icon, JSON.stringify(norm.blueprint), sec.section, createdBy, now, now);
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

    // 🔴 09-15 堵洞：这里原来是 `q.insert.run(..., JSON.stringify(blueprint), ...)`，
    //    **直接入库，连 normalizeForStore 都不过**。也就是说"我说一句话，AI 给我造个应用"
    //    这条路绕开了全部判据 —— 而它恰恰是最该被守住的一条（写代码的是模型，不是人，
    //    模型最容易干的就是在模块里手搓一份 CSS）。三条入库路里它漏得最狠。
    //    过门的另一个好处：模型偶尔吐出结构怪异的东西，也能被收敛器兜住而不是存进去炸。
    const norm = normalizeForStore(blueprint);
    if (!norm.ok) {
      // 生成物不合格不静默降级 —— 静默改写比报错更糟（design-lint 开头那句）。
      // 如实告诉用户"造出来的不合规"，并把人话原样带上，他能照着再说一遍需求。
      return send(res, 422, { error: `生成的应用没通过设计检查：\n${norm.error}`, mode, note });
    }
    const stored = norm.blueprint;
    const name = clip(body.name, 80) || prompt.slice(0, 24);
    const id = randomUUID();
    // 生成的东西一律记为 ai 造的 —— 哪怕这次是本地兜底生成的，
    // 对用户而言它就是"我说一句话，它给我造的"，来源标记要如实反映这一点。
    q.insert.run(id, uid, spaceId, name, clip(body.icon, 16) || "✨", JSON.stringify(stored), "", "ai", now, now);
    return send(res, 201, { id, name, mode, note, blueprint: stored });
  }

  // 单个
  const id = decodeURIComponent(rest.split("/")[0]);
  const subAction = rest.split("/")[1] || "";

  // /apps/:id/sync（更新到来源最新版）与 /apps/:id/revert（一键回退）
  if (subAction) {
    const hit = await market.handleAppAction(req, res, { appId: id, action: subAction, uid, now, spaceId });
    if (hit) return;
    return send(res, 404, { error: "not found" });
  }

  if (req.method === "GET") {
    const row = q.get.get(id, uid, spaceId);
    if (row) {
      return send(res, 200, {
        ...row,
        blueprint: JSON.parse(row.blueprint),
        readonly: false,
        shared_to: appShares.groupsFor(id),
      });
    }

    // 不是自己的 —— 但它可能被分享到了某个群，而这个人正好在那个群里。
    // 🔴 判定用**访问者请求里那把 token**（不是服务端的特权凭据）：他只能证明
    //    自己的身份和自己的群。宿主不可达 / 没分享 / 不在群里，一律落到下面的 404。
    const viewerToken = Array.isArray(token) ? token[0] : token;
    const viaGroup = await appShares.canView(id, viewerToken);
    if (viaGroup) {
      const shared = q.getAny.get(id, spaceId);
      if (shared) {
        return send(res, 200, {
          ...shared,
          blueprint: JSON.parse(shared.blueprint),
          // 只读是硬边界：PUT / DELETE 仍然锁 owner_uid，改不了别人的东西。
          readonly: true,
          shared_via_group: viaGroup,
        });
      }
    }

    // 🔴 无权限和不存在返回同一个 404 —— 不泄露"这个 id 是否存在"。
    return send(res, 404, { error: "not found" });
  }
  if (req.method === "PUT") {
    const row = q.get.get(id, uid, spaceId);
    if (!row) return send(res, 404, { error: "not found" });
    let body;
    try {
      body = await readJson(req);
    } catch (e) {
      return send(res, 400, { error: String(e.message || e) });
    }
    let bp = JSON.parse(row.blueprint);
    if (body.blueprint != null) {
      // 更新 ⇒ 棘轮（见 design-gate.mjs）。prev 是库里那一版。
      const norm = normalizeForStore(body.blueprint, { prev: bp });
      if (!norm.ok) return send(res, 400, { error: norm.error });
      bp = norm.blueprint;
    }
    let section = row.section || "";
    if (body.section !== undefined) {
      const sec = normalizeSection(body.section);
      if (!sec.ok) return send(res, 400, { error: sec.error });
      section = sec.section;
    }
    q.update.run(
      clip(body.name, 80) || row.name,
      clip(body.icon, 16) || row.icon,
      JSON.stringify(bp),
      section,
      now, id, uid, spaceId);
    return send(res, 200, { ok: true });
  }
  if (req.method === "DELETE") {
    // 🔴 必须先确认这个应用真的是他的，再做任何清理。
    //    第一版没有这道检查，因为 `q.remove` 自带 `AND owner_uid=?`，看起来"删不到就无害"。
    //    但下面两行清理**不带 owner 条件**：`appShares.onAppDeleted(id)` 会把别人应用的
    //    分享记录整条删掉。实测过——用一个刚建的同事账号 DELETE 一次，
    //    苏白分享给全群的工作台当场对所有人失效，接口还返回 200 说成功了。
    //    应用本身没被删，所以这个洞很安静：没人会发现是谁弄的。
    //    教训：判断"这个操作有没有危险"要看**整段处理里的每一次写**，
    //    不能因为第一行自带 owner 条件就认为整段都安全。
    const own = q.get.get(id, uid, spaceId);
    if (!own) return send(res, 404, { error: "not found" });

    q.remove.run(id, uid, spaceId);
    // 顺带清掉安装关系、侧栏钉位、更新备份 —— 否则"删了再装"会拿到一个已删的 id
    market.onAppDeleted(uid, id);
    appShares.onAppDeleted(id); // 分享记录跟着走，别留孤儿行
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
}).listen(PORT, function () {
  // 打**实际绑定**的端口，不是配置值：PORT=0 表示"系统随便给一个"，
  // 照着配置值打就永远是 ":0"，测试和运维都没法据此连上来。
  const actual = this.address().port;
  console.log(`[yoyoo-superapp] listening on :${actual}  db=${DB_PATH}`);
  console.log(`[yoyoo-superapp] identity via ${HOST_VERIFY_URL}`);
});
