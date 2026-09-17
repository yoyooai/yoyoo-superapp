/**
 * 平台出站推送（bot webhook）—— SPEC 第 4 节。
 *
 * ── 病根（09-15 实测，不是猜的）──────────────────────────────
 * 豆包 / 千问 / WorkBuddy 不回消息，不是因为它们收不到、也不是鉴权问题：
 * 它们**没有常驻进程**（体检工具实测空窗 72~175 秒，健康的 <3 秒）。
 * 而平台侧只有**拉取**一条路（AI 自己长轮询 `POST /v1/bot/events`，
 * 见 docs/AI-MANUAL.md §3）—— 没有常驻进程 ＝ 没人去拉 ＝ 收不到。
 *
 * 所以这个模块加的是**另一条方向相反的路**：平台主动 POST 给 AI。
 * 🔴 长轮询那条路**原样保留**：有常驻进程的 AI（小A、小Z）照旧走它。
 *    两条路并存是刻意的 —— 谁都不用改就能继续跑，改的只是"多一条路可选"。
 *
 * ── 三件不自己造的事（都有现成的，照用）────────────────────
 *  · **谁能登记** = `ai-owners.mjs` 的归属登记册（creator）＋ `space.mjs` 的
 *    `roleOfViewer()`（空间管理员，role ≥ 1，判据来自宿主、不是前端自报）。
 *    和 `org-chart.mjs` 的写闸同一条路子，**没有第二套归属规则**。
 *  · **入口鉴权** = 照 `channel-records.mjs` 回传口那两条路：bot 自己的
 *    `Authorization: Bearer bf_…`（走 `bot-auth.mjs` 的 identify），
 *    或我们自己中继用的共享令牌。两条都没有 ⇒ 503 关门，**不是放行**。
 *  · **幂等** = 照 `channel_records` 的做法：稳定主键 + ON CONFLICT 覆盖。
 *    同一条 `message_id` 重推只会覆盖那一行，不会翻倍，也不会再 POST 一次。
 *
 * ── secret 只进不出 ─────────────────────────────────────────
 * 登记的 secret 落库前**封装**（AES-256-GCM，同 connectors.mjs / invite.mjs 的做法），
 * 🔴 任何读取接口只回显**尾 4 位**（`secret_tail`）。列一次登记就把密钥原样吐回来，
 *    等于谁能看列表谁就能伪造签名 —— 那这个签名就白签了。
 *
 * ── 失败了怎么办（SPEC 定的退避 + 我加的熔断）──────────────
 *  · 首发失败 ⇒ 退避重试 3 次：1s / 10s / 60s（SPEC 4.2 写死的三个数）。
 *  · 4 次都不成 ⇒ 这条落**死信**（state=dead），管理面看得见，**不静默丢**。
 *  · 🔴 连续 5 条都进死信 ⇒ 把这个 webhook **停掉**（state=stopped）并记一笔原因。
 *    没有这一条，一台永久失联的机器会让平台无限重试、把自己拖死 ——
 *    "重试到天荒地老"是这类推送最经典的自杀方式。
 *    恢复要一次明确动作：`POST /bot-webhooks/<ai_uid>/resume`（顺带重推死信）。
 *
 * ── 🔴 推成功之后，由平台自己把这条划掉（09-16 苏白追问后加，比推送本身更重要）──
 * 今晚查清的事实：豆包/千问/WorkBuddy 每次醒来都从 `event_id=0` **重读整条队列**，
 * 而且**从不调**平台的 `/events/{id}/ack`（全平台只有小A 自己在调）。于是它们
 * 一秒连发五条、把早就答过的老消息再答一遍 —— 苏白那句"你没有正面回复我的问题"
 * 就是这么来的。**光做推送治不了这一半。**
 *
 * 真药是把回执从"接入方的义务"变成"**平台的副作用**"：扇出时平台把 `event_id`
 * 一起带过来（octo-server `pkg/botwebhook`），我们这边**在对方真的 2xx 之后**
 * 回头调平台的内部口 `POST /v1/internal/bot-events/ack`，把那一条精确划掉。
 * 一个"要求所有接入方都实现对才成立"的设计，就是会一直出事。
 *
 * 🔴 方向是**刻意选偏**的（这三条是这半边的全部安全性）：
 *   1. **只对推成功的那一条划。** 推失败 / 进死信 / 熔断 ⇒ 一个字都不划，
 *      消息老老实实留在队列里 —— 对方哪天回来拉还得拿得到。**宁可重复，不可丢。**
 *   2. **划不掉就不划，绝不假装成功**：内部口调失败只记一笔，投递状态不动。
 *   3. **只对已登记 webhook 的 AI 生效。** 这是结构性的：调用点只有下面
 *      `runChain` 投递成功那一支，而那一支只对登记过、state=active 的 hook 存在。
 *      没登记的（比如小A 自己）**永远没有人替它划** —— 它那条长轮询 + 自己 ack
 *      的老路一个字不变。考卷里第③条钉的就是这个。
 */
import { createHash, createHmac, createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { send, readJson, clip } from "./http-util.mjs";
import { assertUrlSafe } from "./connectors.mjs";

/** SPEC 4.2 写死的三个退避数。首发之外还有这 3 次。 */
export const BACKOFF_MS = [1000, 10_000, 60_000];
/** 首发 + 3 次重试 = 4 次 POST 封顶。**不许改成无限重试。** */
export const MAX_ATTEMPTS = BACKOFF_MS.length + 1;
/** 连续几条死信就把这个 webhook 停掉（熔断）。 */
const DEAD_STREAK_TO_STOP = 5;
/** 单次 POST 的超时。对面没常驻进程时最常见的就是挂着不答。 */
const PUSH_TIMEOUT_MS = 5000;
/** 调平台内部口（划掉那一条）的超时。短：它失败了只是"晚点再说"，不该拖住投递链。 */
const ACK_TIMEOUT_MS = 3000;
/** 单条正文上限，同 channel-records。 */
const MAX_TEXT = 4000;
/** 一次 notify 最多几条 */
const MAX_BATCH = 500;
/** 空间管理员起步的 role（octo-server `spaceRoleAdmin = 1`），同 org-chart.mjs。 */
const ROLE_ADMIN = 1;
/** 路径里被占掉的段，不能当 ai_uid 用。 */
const RESERVED = new Set(["dead-letters", "notify"]);

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const unb64u = (s) => Buffer.from(String(s), "base64url");
const clean = (v, max = 200) => clip(String(v ?? "").trim(), max);

/** 封装密钥：有文件读文件，没有就现生成一把存下来（同 connectors.mjs）。 */
function loadSealSecret(keyPath) {
  if (keyPath && existsSync(keyPath)) {
    return createHash("sha256").update(readFileSync(keyPath)).digest();
  }
  const fresh = randomBytes(32);
  if (keyPath) writeFileSync(keyPath, fresh, { mode: 0o600 });
  return createHash("sha256").update(fresh).digest();
}

/**
 * 签名的**唯一**算法实现。收方（AI 那边）照这一条算就能验。
 *
 * `HMAC-SHA256(secret, "<ts>.<原始 body 字节>")`，输出 `sha256=<hex>`。
 * 🔴 ts 必须进签名：不进的话，任何人录下一次合法请求就能无限重放。
 * 🔴 签的是**发出去的那串原始字节**，不是"解析后再序列化一遍"的等价 JSON ——
 *    同 pay-wechat.mjs 那条教训（语义相同、字节不同，验签必然不过）。
 */
export function signWebhook(secret, ts, rawBody) {
  const mac = createHmac("sha256", String(secret))
    .update(String(ts)).update(".").update(String(rawBody))
    .digest("hex");
  return `sha256=${mac}`;
}

/** 收方验签用的同一份判据（导出是为了让 AI 侧和测试都用这一份，不各写一个）。 */
export function verifyWebhook(secret, ts, rawBody, signature) {
  const want = Buffer.from(signWebhook(secret, ts, rawBody));
  const got = Buffer.from(String(signature || ""));
  if (want.length !== got.length) return false;
  return timingSafeEqual(want, got);
}

export function initBotWebhookSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_webhooks (
      ai_uid        TEXT PRIMARY KEY,   -- 收方 AI（宿主认定的 robot_id）
      url           TEXT NOT NULL,
      sealed_secret TEXT NOT NULL,      -- iv.tag.ciphertext（base64url）；明文不落库
      secret_tail   TEXT NOT NULL,      -- 尾 4 位，界面上认一下"是不是我配的那把"
      space_id      TEXT NOT NULL,
      state         TEXT NOT NULL,      -- active | stopped（连续死信熔断）
      fail_streak   INTEGER NOT NULL,
      last_ok_at    INTEGER,
      last_error    TEXT,
      created_by    TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
    -- 🔴 主键 = ai_uid|message_id：同一条消息重推只覆盖这一行，不会翻倍
    --    （照 channel_records 的做法，见文件头）。
    CREATE TABLE IF NOT EXISTS bot_webhook_deliveries (
      id         TEXT PRIMARY KEY,
      ai_uid     TEXT NOT NULL,
      message_id TEXT NOT NULL,
      conv_id    TEXT NOT NULL,
      from_name  TEXT NOT NULL,
      text       TEXT NOT NULL,
      ts         INTEGER NOT NULL,
      state      TEXT NOT NULL,        -- pending | delivered | dead
      attempts   INTEGER NOT NULL,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      -- 平台队列里那一条的游标。推成功后拿它回头把那条划掉。
      -- 🔴 允许为空：老行、或平台没带过来的，就是"不划"——少划是慢，错划是丢。
      event_id   TEXT,
      acked_at   INTEGER            -- 划掉的时刻；非空＝已经划过，不再重复划
    );
    CREATE INDEX IF NOT EXISTS idx_bwd_ai ON bot_webhook_deliveries(ai_uid, state, updated_at DESC);
  `);
  // 🔴 上面的 CREATE TABLE IF NOT EXISTS 对**已存在**的库是空操作，所以老库不会
  //    自己长出这两列。补一次 ALTER；已经有了就会抛，吞掉即可（同一句跑两遍要安全）。
  for (const col of ["event_id TEXT", "acked_at INTEGER"]) {
    try { db.exec(`ALTER TABLE bot_webhook_deliveries ADD COLUMN ${col}`); } catch { /* 已有 */ }
  }
}

/**
 * @param {object} opts
 * @param {object} opts.db
 * @param {object} [opts.owners]      ai-owners 实例（归属登记册）——判"是不是 creator"
 * @param {object} [opts.spaceGate]   space.mjs 实例 —— 判"是不是空间管理员"
 * @param {object} [opts.botAuth]     bot-auth 实例 —— notify 口的凭据鉴权
 * @param {string} [opts.notifyToken] 我方中继用的共享令牌（env）；没配则那条路关着
 * @param {string} [opts.ackUrl]     平台的内部口：推成功后把那一条划掉。
 *   🔴 **没配 ⇒ 这条路整条关着**，行为逐字回到"只推不划"的今天。和平台侧
 *   `YOYOO_WEBHOOK_FANOUT=0` 是同一个总开关的两头，关任一头都回得去。
 * @param {string} [opts.ackToken]   调那个内部口用的共享令牌 —— **和 notifyToken
 *   同一把**（同一条链路的两头，不该有两个秘密）。没配也是整条关着。
 * @param {string} [opts.sealKeyPath]
 * @param {Function} [opts.fetchImpl] 测试注入
 * @param {Function} [opts.schedule]  退避定时器，测试注入（默认 setTimeout + unref）
 */
export function createBotWebhooks({
  db,
  owners = null,
  spaceGate = null,
  botAuth = null,
  notifyToken = "",
  ackUrl = "",
  ackToken = "",
  sealKeyPath = "",
  allowPrivateHosts = false,
  fetchImpl = null,
  now = Date.now,
  schedule = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  log = console,
}) {
  initBotWebhookSchema(db);
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  const SEAL = loadSealSecret(sealKeyPath);

  // 每条记录一把派生密钥（同 connectors.mjs）：挪用别人的密文在这条上解不开。
  const sealKey = (aiUid) =>
    createHash("sha256").update(SEAL).update("|yoyoo-bot-webhook|").update(String(aiUid)).digest();
  function seal(secret, aiUid) {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", sealKey(aiUid), iv);
    const body = Buffer.concat([c.update(String(secret), "utf8"), c.final()]);
    return [b64u(iv), b64u(c.getAuthTag()), b64u(body)].join(".");
  }
  function unseal(sealed, aiUid) {
    const [iv, tag, body] = String(sealed).split(".");
    const d = createDecipheriv("aes-256-gcm", sealKey(aiUid), unb64u(iv));
    d.setAuthTag(unb64u(tag));
    return Buffer.concat([d.update(unb64u(body)), d.final()]).toString("utf8");
  }

  const q = {
    getHook: db.prepare(`SELECT * FROM bot_webhooks WHERE ai_uid = ?`),
    listHooksBySpace: db.prepare(`SELECT * FROM bot_webhooks WHERE space_id = ? ORDER BY updated_at DESC LIMIT 500`),
    putHook: db.prepare(`
      INSERT INTO bot_webhooks
        (ai_uid,url,sealed_secret,secret_tail,space_id,state,fail_streak,last_ok_at,last_error,created_by,created_at,updated_at)
      VALUES (?,?,?,?,?,'active',0,NULL,NULL,?,?,?)
      ON CONFLICT(ai_uid) DO UPDATE SET
        url=excluded.url, sealed_secret=excluded.sealed_secret, secret_tail=excluded.secret_tail,
        space_id=excluded.space_id, state='active', fail_streak=0, last_error=NULL,
        updated_at=excluded.updated_at`),
    delHook: db.prepare(`DELETE FROM bot_webhooks WHERE ai_uid = ?`),
    hookOk: db.prepare(`UPDATE bot_webhooks SET fail_streak=0, last_ok_at=?, last_error=NULL, updated_at=? WHERE ai_uid=?`),
    hookFail: db.prepare(`UPDATE bot_webhooks SET fail_streak=fail_streak+1, last_error=?, updated_at=? WHERE ai_uid=?`),
    hookStop: db.prepare(`UPDATE bot_webhooks SET state='stopped', last_error=?, updated_at=? WHERE ai_uid=?`),
    hookResume: db.prepare(`UPDATE bot_webhooks SET state='active', fail_streak=0, last_error=NULL, updated_at=? WHERE ai_uid=?`),

    getDelivery: db.prepare(`SELECT * FROM bot_webhook_deliveries WHERE id = ?`),
    upsertDelivery: db.prepare(`
      INSERT INTO bot_webhook_deliveries
        (id,ai_uid,message_id,conv_id,from_name,text,ts,state,attempts,last_error,created_at,updated_at,event_id)
      VALUES (?,?,?,?,?,?,?,'pending',0,NULL,?,?,?)
      -- 🔴 重推同一条：**覆盖**这一行（正文可修正），绝不插第二行。
      ON CONFLICT(id) DO UPDATE SET
        conv_id=excluded.conv_id, from_name=excluded.from_name, text=excluded.text,
        ts=excluded.ts, updated_at=excluded.updated_at, event_id=excluded.event_id`),
    // acked_at 只在真的划掉之后写，且 WHERE 带 acked_at IS NULL：
    // 并发/重推都只会划一次。
    markAcked: db.prepare(`UPDATE bot_webhook_deliveries SET acked_at=? WHERE id=? AND acked_at IS NULL`),
    markAttempt: db.prepare(`UPDATE bot_webhook_deliveries SET attempts=?, state=?, last_error=?, updated_at=? WHERE id=?`),
    listDead: db.prepare(`
      SELECT * FROM bot_webhook_deliveries WHERE ai_uid=? AND state='dead'
       ORDER BY updated_at DESC LIMIT 200`),
    countBy: db.prepare(`SELECT state, COUNT(*) AS n FROM bot_webhook_deliveries WHERE ai_uid=? GROUP BY state`),
  };

  /** 正在路上的投递（含还没到点的重试），防止同一条被并发起两条链。 */
  const inFlight = new Map(); // id -> Promise

  // ── 归属判定：creator 或空间管理员。**沿用现成的两处，不自造第三套。** ──
  /**
   * 🔴 这里**没有**"没声明组织就放行"那一档（org-chart.mjs 有，因为那只是张图）。
   *    这个口写的是一个**出站地址**：登记成功后，发给这个 AI 的每一条消息都会被
   *    POST 到那个 URL。默认放行 = 把别人的消息转寄给任意地址。宁可本地开发多配一步。
   */
  async function canManage({ aiUid, uid, spaceId, token }) {
    if (!aiUid || !uid) return false;
    // ① creator —— 归属登记册里可核验的那条（invite/claim/ingest，见 ai-owners.mjs）
    if (owners?.ownerOf && owners.ownerOf(aiUid) === uid) return true;
    // ② 空间管理员 —— 拿访问者自己的 token 问宿主要来的 role，不是前端自报
    if (!spaceId || !spaceGate?.roleOfViewer) return false;
    const role = await spaceGate.roleOfViewer(token, spaceId);
    return role !== null && role >= ROLE_ADMIN;
  }

  /** 对外形状：🔴 secret 只回尾 4 位，永不回显原文。 */
  function shape(row) {
    const counts = {};
    for (const c of q.countBy.all(row.ai_uid)) counts[c.state] = c.n;
    return {
      ai_uid: row.ai_uid,
      url: row.url,
      secret_tail: row.secret_tail,   // 🔴 只有尾巴。改成回全值 = 签名白签了
      has_secret: true,
      state: row.state,
      fail_streak: row.fail_streak,
      last_ok_at: row.last_ok_at || null,
      last_error: row.last_error || null,
      updated_at: row.updated_at,
      pending: counts.pending || 0,
      delivered: counts.delivered || 0,
      dead: counts.dead || 0,
    };
  }

  /**
   * 登记（或更新）一个 AI 的**收件地址**。
   *
   * 🔴 抽出来是为了让**入驻那一步**（invite.mjs 的 redeem）能直接复用这一份，
   * 而不是在门口另长一套登记逻辑 —— 两套登记迟早在校验口径上分家（一边挡住了
   * 私网地址、另一边没挡），那种分家不会报错，只会某天变成一个 SSRF。
   *
   * 🔴 它**不做归属判定**：谁有资格登记，由调用方证明 ——
   *   · HTTP 口（PUT /bot-webhooks/:ai_uid）：creator 或空间管理员（canManage）。
   *   · 入驻口（POST /invites/redeem）：出示了有效票号，那张票本身就是凭证。
   * 所以这个函数**不可以**被挂到任何没有先证明身份的地方。
   *
   * @returns {{ok:true, webhook:object} | {ok:false, error:string}}
   */
  async function registerInbox({ aiUid, url, secret, spaceId = "", createdBy = "" }) {
    const ai = clean(aiUid, 80);
    const u = clean(url, 500);
    const sec = clean(secret, 200);
    if (!ai) return { ok: false, error: "ai_uid 不能为空" };
    if (!u || !sec) return { ok: false, error: "webhook_url 和 secret 都要有" };
    if (sec.length < 16) return { ok: false, error: "secret 太短（至少 16 位）—— 签名的强度全靠它" };
    // SSRF 那道门用 connectors.mjs 里现成的那一份，不另写一套判据。
    const safe = await assertUrlSafe(u, allowPrivateHosts);
    if (!safe.ok) return { ok: false, error: safe.error };
    const t = now();
    q.putHook.run(
      ai, safe.url.toString(), seal(sec, ai), sec.slice(-4),
      String(spaceId || ""), String(createdBy || ""), t, t);
    return { ok: true, webhook: shape(q.getHook.get(ai)) };
  }

  // ── 推送本身 ───────────────────────────────────────────────
  function bodyOf(row) {
    // SPEC 4.2 点名的五个字段，一个都不少；ai_uid 捎上，收方可能同时代管多个号。
    return JSON.stringify({
      message_id: row.message_id,
      conv_id: row.conv_id,
      from: row.from_name,
      text: row.text,
      ts: row.ts,
      ai_uid: row.ai_uid,
    });
  }

  async function postOnce(hook, row) {
    const raw = bodyOf(row);
    const ts = now();
    const secret = unseal(hook.sealed_secret, hook.ai_uid);
    const res = await doFetch(hook.url, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-eryuan-webhook-ts": String(ts),
        "x-eryuan-webhook-id": row.message_id,
        "x-eryuan-signature": signWebhook(secret, ts, raw),
      },
      body: raw,
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    });
    if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : "no response"}`);
    return true;
  }

  /**
   * 推成功之后，替接入方把平台队列里那一条划掉（`POST /v1/internal/bot-events/ack`）。
   *
   * 🔴 **永不抛**。调用点在投递链的成功分支里，一次抛出就会把已经送达的这条摔进
   * 重试 catch —— "送到了还在重推"比"没划掉"严重得多。所以整个函数体裹在 try 里，
   * 出任何事都只是记一笔。
   *
   * 🔴 **四道闸，少一道就是一个洞**：
   *   · 没配地址/令牌 ⇒ 整条不走（＝今天的行为）。
   *   · 平台没带 event_id 过来 ⇒ 不划（少划是慢，错划是丢）。
   *   · 已经划过（acked_at 非空）⇒ 不重复划。
   *   · 内部口没回 2xx ⇒ **不写 acked_at**，消息留在队列里，对方回来拉还拿得到。
   */
  async function ackDelivered(row) {
    try {
      if (!ackUrl || !ackToken) return false;
      if (!row) return false;
      const eventId = Number(row.event_id);
      if (!Number.isFinite(eventId) || eventId <= 0) return false;
      if (row.acked_at) return false;
      const res = await doFetch(ackUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          "x-yoyoo-ingest-token": ackToken,
        },
        body: JSON.stringify({ robot_id: row.ai_uid, event_id: eventId }),
        signal: AbortSignal.timeout(ACK_TIMEOUT_MS),
      });
      if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : "no response"}`);
      q.markAcked.run(now(), row.id);
      return true;
    } catch (e) {
      // 划不掉就**不划**，绝不假装成功。代价是对方可能再收到一次（幂等由它自己
      // 或下一次推送的 dedup 兜）；反过来假装划掉的代价是这条消息永久消失。
      log.log?.(`[bot-webhooks] ack upstream failed ai=${row?.ai_uid} event=${row?.event_id}: ${e?.message || e}`);
      return false;
    }
  }

  async function runChain(id) {
    for (;;) {
      const row = q.getDelivery.get(id);
      if (!row || row.state !== "pending") return;
      const hook = q.getHook.get(row.ai_uid);
      if (!hook) {  // 登记被删了：这条不再有去处，落死信而不是空转
        q.markAttempt.run(row.attempts, "dead", "webhook removed", now(), id);
        return;
      }
      const attempt = row.attempts + 1;
      try {
        await postOnce(hook, row);
        q.markAttempt.run(attempt, "delivered", null, now(), id);
        q.hookOk.run(now(), now(), row.ai_uid);
        // 🔴 **只有走到这里**（对方真的 2xx）才替它把队列里那条划掉。
        //    位置是刻意的：在 markAttempt 之后、return 之前，而且 ackDelivered
        //    **永不抛** —— 否则一次划不掉会把已经送达的这条摔进下面的 catch，
        //    变成"送到了还在重推"，那比不划严重得多。
        await ackDelivered(q.getDelivery.get(id) || row);
        return;
      } catch (e) {
        const why = clip(String(e?.message || e), 300);
        if (attempt >= MAX_ATTEMPTS) {
          // 🔴 落死信，不静默丢。管理面 `GET /bot-webhooks/dead-letters` 看得见。
          q.markAttempt.run(attempt, "dead", why, now(), id);
          q.hookFail.run(why, now(), row.ai_uid);
          const after = q.getHook.get(row.ai_uid);
          if (after && after.fail_streak >= DEAD_STREAK_TO_STOP && after.state === "active") {
            // 熔断：对面明显不在了，别拿无限重试把平台拖死。
            q.hookStop.run(
              `连续 ${after.fail_streak} 条进死信，已停推（最后一次：${why}）`, now(), row.ai_uid);
            log.log?.(`[bot-webhooks] stopped ai=${row.ai_uid} after ${after.fail_streak} dead letters`);
          }
          return;
        }
        q.markAttempt.run(attempt, "pending", why, now(), id);
        await new Promise((r) => schedule(r, BACKOFF_MS[attempt - 1]));
      }
    }
  }

  function start(id) {
    if (inFlight.has(id)) return inFlight.get(id);
    const p = runChain(id)
      .catch((e) => log.error?.(`[bot-webhooks] chain ${id} crashed: ${e?.message || e}`))
      .finally(() => inFlight.delete(id));
    inFlight.set(id, p);
    return p;
  }

  /**
   * 把一条新消息推给某个 AI。**幂等**：同一个 message_id 再来一次不会翻倍、也不会再 POST。
   * @returns {{ok:boolean, reason?:string, deduped?:boolean, id?:string}}
   */
  function deliver({ aiUid, messageId, convId, from, text, ts, eventId }) {
    const ai = clean(aiUid, 80);
    const mid = clean(messageId, 160);
    const conv = clean(convId, 160);
    const at = Number(ts);
    if (!ai || !mid || !conv || !Number.isFinite(at) || at <= 0) {
      return { ok: false, reason: "message_id / conv_id / ts 缺一不可" };
    }
    const hook = q.getHook.get(ai);
    if (!hook) return { ok: false, reason: "no webhook registered" };
    if (hook.state !== "active") return { ok: false, reason: "webhook stopped" };

    const id = `${ai}|${mid}`;
    const existing = q.getDelivery.get(id);
    // 🔴 已经送到过的，再来一次就是**什么都不做** —— 这是"重推不翻倍"的那一句。
    if (existing && existing.state === "delivered") return { ok: true, deduped: true, id };
    if (existing && inFlight.has(id)) return { ok: true, deduped: true, id };

    const t = now();
    // event_id 存成字符串（sqlite 里这一列是 TEXT），取不到就 null＝"不划"。
    const ev = Number(eventId);
    q.upsertDelivery.run(
      id, ai, mid, conv, clean(from, 80) || "(未知)", clip(String(text ?? ""), MAX_TEXT),
      Math.floor(at), t, t, Number.isFinite(ev) && ev > 0 ? String(Math.floor(ev)) : null);
    if (existing) {
      // 之前死过的重新排队（resume / 重推），状态回 pending，次数从头算。
      q.markAttempt.run(0, "pending", null, t, id);
    }
    start(id);
    return { ok: true, deduped: false, id };
  }

  /** 测试/优雅停机用：等所有在路上的投递跑完。 */
  async function drain() {
    while (inFlight.size) await Promise.all([...inFlight.values()]);
  }

  // ── 入口：消息来源往这里投（挡在用户面鉴权之前）────────────
  /**
   * 鉴权两条路，照 `channel-records.mjs` 回传口：
   *  ① `Authorization: Bearer bf_…` —— 但这条路**只准推给自己**
   *     （ai_uid 必须等于宿主认出来的 robot_id）。否则任何一个准入的 bot
   *     都能往别人的 webhook 上灌任意正文，那是伪造消息，不是推送。
   *  ② 共享令牌（我方中继）—— 它代表平台自己，可以推给任意登记过的 bot。
   * 🔴 两条都没有 ⇒ 503 关门。"没配就放行"在一个公网写入口上等于没有门。
   */
  async function handleNotify(req, res, { path, root }) {
    if (path !== `${root}/bot-webhooks/notify`) return false;
    if (req.method !== "POST") {
      send(res, 405, { error: "method not allowed" });
      return true;
    }
    const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    let callerBot = "";
    if (bearer) {
      if (!botAuth?.identify) {
        send(res, 503, { error: "bot auth not configured" });
        return true;
      }
      const who = await botAuth.identify(bearer);
      if (!who.ok) {
        send(res, who.status, { error: who.error });
        return true;
      }
      callerBot = who.robotId;
    } else {
      if (!notifyToken) {
        send(res, 503, {
          error: "push relay disabled",
          why: "既没带 bot 凭据（Authorization: Bearer bf_…），"
            + "服务端也没配共享令牌 YOYOO_WEBHOOK_NOTIFY_TOKEN。",
        });
        return true;
      }
      if (String(req.headers["x-yoyoo-ingest-token"] || "") !== notifyToken) {
        send(res, 401, { error: "bad relay token" });
        return true;
      }
    }

    let body;
    try {
      body = await readJson(req, 4 * 1024 * 1024);
    } catch {
      send(res, 400, { error: "bad json" });
      return true;
    }
    const rows = Array.isArray(body?.messages) ? body.messages : (body ? [body] : []);
    if (rows.length > MAX_BATCH) {
      send(res, 413, { error: `too many messages (max ${MAX_BATCH})` });
      return true;
    }
    let queued = 0, deduped = 0, skipped = 0;
    const reasons = [];
    for (const m of rows) {
      const ai = clean(m?.ai_uid ?? m?.to_ai_uid, 80);
      if (callerBot && ai !== callerBot) {
        skipped += 1;
        reasons.push("bot 凭据只能推给自己");
        continue;
      }
      const r = deliver({
        aiUid: ai, messageId: m?.message_id, convId: m?.conv_id,
        from: m?.from, text: m?.text, ts: m?.ts,
        // 平台扇出时带过来的队列游标；没带就是没带，那条就只推不划。
        eventId: m?.event_id,
      });
      if (!r.ok) { skipped += 1; reasons.push(r.reason); continue; }
      if (r.deduped) deduped += 1; else queued += 1;
    }
    send(res, 200, { ok: true, queued, deduped, skipped, reasons: [...new Set(reasons)].slice(0, 5) });
    return true;
  }

  // ── 用户面：登记 / 列表 / 删除 / 死信 / 恢复 ────────────────
  async function handle(req, res, { path, uid, root, spaceId, token }) {
    const base = `${root}/bot-webhooks`;
    if (path !== base && !path.startsWith(`${base}/`)) return false;
    const rest = path.slice(base.length).replace(/^\//, "");

    // 列表：只列**我管得到的**那些（我名下的 AI；管理员另加本组织全部）
    if (!rest && req.method === "GET") {
      const mine = new Map();
      for (const r of owners?.listOf ? owners.listOf(uid) : []) {
        const hook = q.getHook.get(r.ai_uid);
        if (hook) mine.set(hook.ai_uid, hook);
      }
      if (spaceId && spaceGate?.roleOfViewer) {
        const role = await spaceGate.roleOfViewer(token, spaceId);
        if (role !== null && role >= ROLE_ADMIN) {
          for (const h of q.listHooksBySpace.all(spaceId)) mine.set(h.ai_uid, h);
        }
      }
      send(res, 200, { webhooks: [...mine.values()].map(shape) });
      return true;
    }

    if (rest === "dead-letters" && req.method === "GET") {
      const out = [];
      for (const r of owners?.listOf ? owners.listOf(uid) : []) {
        if (!(await canManage({ aiUid: r.ai_uid, uid, spaceId, token }))) continue;
        for (const d of q.listDead.all(r.ai_uid)) {
          out.push({
            ai_uid: d.ai_uid, message_id: d.message_id, conv_id: d.conv_id,
            from: d.from_name, ts: d.ts, attempts: d.attempts,
            last_error: d.last_error, updated_at: d.updated_at,
          });
        }
      }
      send(res, 200, { dead_letters: out });
      return true;
    }

    const segs = rest.split("/").filter(Boolean).map((s) => decodeURIComponent(s));
    const aiUid = segs[0] || "";
    if (!aiUid || RESERVED.has(aiUid)) {
      send(res, 404, { error: "not found" });
      return true;
    }

    // 恢复：把停掉的 webhook 重新打开，并把死信重推一遍（SPEC 4.3 那条验收）
    if (segs[1] === "resume" && req.method === "POST") {
      if (!(await canManage({ aiUid, uid, spaceId, token }))) {
        send(res, 403, { error: "not yours", why: "只有这个 AI 的主人或空间管理员能改它的推送设置。" });
        return true;
      }
      const hook = q.getHook.get(aiUid);
      if (!hook) { send(res, 404, { error: "no webhook" }); return true; }
      q.hookResume.run(now(), aiUid);
      const dead = q.listDead.all(aiUid);
      let requeued = 0;
      for (const d of dead) {
        const r = deliver({
          aiUid, messageId: d.message_id, convId: d.conv_id,
          from: d.from_name, text: d.text, ts: d.ts,
        });
        if (r.ok && !r.deduped) requeued += 1;
      }
      send(res, 200, { ok: true, ai_uid: aiUid, requeued });
      return true;
    }
    if (segs.length > 1) { send(res, 404, { error: "not found" }); return true; }

    if (req.method === "GET") {
      if (!(await canManage({ aiUid, uid, spaceId, token }))) {
        send(res, 403, { error: "not yours" });
        return true;
      }
      const hook = q.getHook.get(aiUid);
      send(res, 200, { webhook: hook ? shape(hook) : null });
      return true;
    }

    if (req.method === "PUT") {
      // 🔴 归属判定在最前面：不是主人/管理员，连 URL 都不该被我们记下来。
      if (!(await canManage({ aiUid, uid, spaceId, token }))) {
        send(res, 403, {
          error: "not yours",
          why: "登记推送地址要么是这个 AI 的主人（归属登记册里认得的那个），"
            + "要么是这个组织的管理员。",
        });
        return true;
      }
      let body;
      try { body = await readJson(req); } catch { send(res, 400, { error: "bad json" }); return true; }
      // 校验与落库全在 registerInbox 里（入驻口用的是同一份）。
      const r = await registerInbox({
        aiUid, url: body?.webhook_url ?? body?.url, secret: body?.secret,
        spaceId, createdBy: uid,
      });
      if (!r.ok) { send(res, 400, { error: r.error }); return true; }
      send(res, 200, { ok: true, webhook: r.webhook });
      return true;
    }

    if (req.method === "DELETE") {
      if (!(await canManage({ aiUid, uid, spaceId, token }))) {
        send(res, 403, { error: "not yours" });
        return true;
      }
      const r = q.delHook.run(aiUid);
      if (!r.changes) { send(res, 404, { error: "no webhook" }); return true; }
      send(res, 200, { ok: true });
      return true;
    }

    send(res, 405, { error: "method not allowed" });
    return true;
  }

  return { handle, handleNotify, deliver, drain, canManage, shape, registerInbox, _hook: (ai) => q.getHook.get(ai) };
}
