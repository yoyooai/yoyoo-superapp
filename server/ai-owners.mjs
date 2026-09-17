/**
 * 「这个 AI 是谁的」—— 归属登记册。
 *
 * ── 为什么有这个模块（苏白 2026-09-10）───────────────────────────
 * 原话：「每个人只能看到自己作为 owner 的这个 bot 的内容。举个例子，我只能看到
 *        小A 和元知这些，就是这些 A 属于谁谁就能看到，不属于他的他都看不到。」
 *
 * 渠道记录表里从第一天就存着 `owner_uid`，但那是**回传方自报**的一个字段，
 * 不是一条能拿来做权限判断的事实：谁回传谁说了算，等于没有边界。
 * 这张表就是那条事实——一个 AI 的 uid 对一个人的 uid，且**只用可核验的方式登记**。
 *
 * ── 三种登记来源，可信度递减，都记在 source 里，界面能照实说 ──────
 *   `invite` —— 这个号是通过邀请票在这个人的登录态下建出来的。最硬：
 *                建号那一刻我们就在场，不需要谁自报。
 *   `claim`  —— 人在界面上认领一个已有的号，**必须出示这个号的连接凭据**，
 *                我们拿去问宿主"这串凭据是哪个号的"（`/v1/bot/register`）。
 *                只有 creator 拿得到那串凭据（宿主 `getUserBotToken` 只给 creator），
 *                所以"能出示"≈"是主人"。
 *   `ingest` —— 回传口自报的归属。**最软**，只在这个 AI 还没有任何登记时兜底，
 *                一旦有了 invite/claim 的登记就不再被它改写。
 *
 * 🔴 归属不会被"后来的一条记录"悄悄改掉。
 *    换主人必须是一次明确动作（先 release 再 claim），否则任何一条回传
 *    都能把别人的 AI 划到自己名下 —— 那就等于没有边界。
 *    唯一的例外是 `invite`：它是我们亲眼看着建出来的，可以覆盖软登记。
 */
import { send, readJson, clip } from "./http-util.mjs";

/** 登记来源的硬度。数字大的可以覆盖数字小的，反过来不行。 */
const HARDNESS = { ingest: 1, claim: 2, invite: 3 };

export function initAiOwnerSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_owners (
      ai_uid     TEXT PRIMARY KEY,
      owner_uid  TEXT NOT NULL,
      ai_name    TEXT,
      source     TEXT NOT NULL,        -- invite | claim | ingest（见文件头）
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ai_owners_owner ON ai_owners(owner_uid);
  `);
}

export function createAiOwners({ db, botAuth = null, now = Date.now }) {
  initAiOwnerSchema(db);

  const q = {
    get: db.prepare(`SELECT * FROM ai_owners WHERE ai_uid = ?`),
    listByOwner: db.prepare(
      `SELECT ai_uid, ai_name, source, created_at FROM ai_owners
        WHERE owner_uid = ? ORDER BY created_at`),
    insert: db.prepare(`
      INSERT INTO ai_owners (ai_uid, owner_uid, ai_name, source, created_at, updated_at)
      VALUES (?,?,?,?,?,?)`),
    update: db.prepare(`
      UPDATE ai_owners SET owner_uid=?, ai_name=COALESCE(?, ai_name), source=?, updated_at=?
       WHERE ai_uid=?`),
    touchName: db.prepare(`UPDATE ai_owners SET ai_name=?, updated_at=? WHERE ai_uid=?`),
    remove: db.prepare(`DELETE FROM ai_owners WHERE ai_uid=? AND owner_uid=?`),
  };

  /**
   * 登记一条归属。
   * @returns {{ok:true, changed:boolean} | {ok:false, reason:'conflict', ownerUid:string}}
   */
  function record({ aiUid, ownerUid, aiName = null, source }) {
    const ai = String(aiUid || "").trim();
    const owner = String(ownerUid || "").trim();
    const src = HARDNESS[source] ? source : "ingest";
    if (!ai || !owner) return { ok: false, reason: "missing" };
    const ts = now();
    const existing = q.get.get(ai);
    if (!existing) {
      q.insert.run(ai, owner, aiName, src, ts, ts);
      return { ok: true, changed: true };
    }
    if (existing.owner_uid === owner) {
      // 同一个主人：只把名字补上（名字会变，归属不变）。
      if (aiName && aiName !== existing.ai_name) q.touchName.run(aiName, ts, ai);
      // 硬度升级也记下来（ingest 兜底后来被 claim 证实了）
      if (HARDNESS[src] > HARDNESS[existing.source]) {
        q.update.run(owner, aiName, src, ts, ai);
      }
      return { ok: true, changed: false };
    }
    // 换主人：只允许更硬的来源覆盖更软的。
    if (HARDNESS[src] > HARDNESS[existing.source]) {
      q.update.run(owner, aiName, src, ts, ai);
      return { ok: true, changed: true };
    }
    return { ok: false, reason: "conflict", ownerUid: existing.owner_uid };
  }

  /** 这个人名下登记了哪些 AI（uid 数组，可能是空的）。 */
  const aiUidsOf = (ownerUid) =>
    q.listByOwner.all(String(ownerUid || "")).map((r) => r.ai_uid);

  const listOf = (ownerUid) => q.listByOwner.all(String(ownerUid || ""));
  const ownerOf = (aiUid) => q.get.get(String(aiUid || ""))?.owner_uid || null;

  /** 用户面：看自己名下的 AI / 认领 / 放弃。 */
  async function handle(req, res, { path, uid, root }) {
    const base = `${root}/agents`;
    if (!path.startsWith(base)) return false;
    const rest = path.slice(base.length).replace(/^\//, "");

    if (!rest && req.method === "GET") {
      send(res, 200, { agents: listOf(uid).map((r) => ({
        ai_uid: r.ai_uid, ai_name: r.ai_name, source: r.source, since: r.created_at,
      })) });
      return true;
    }

    /*
     * 认领：**必须出示这个号的连接凭据**。
     * 🔴 别把它退化成"传个 bot_uid 就算我的"——那样任何登录用户都能把别人的 AI
     *    划到自己名下，然后在渠道页读走它的全部聊天记录。这一步是整条可见性
     *    边界的地基，改它之前先想清楚上面这句话。
     */
    if (rest === "claim" && req.method === "POST") {
      if (!botAuth?.identify) {
        send(res, 503, { error: "claim unavailable: bot auth not configured" });
        return true;
      }
      let body;
      try {
        body = await readJson(req);
      } catch (e) {
        send(res, 400, { error: String(e.message || e) });
        return true;
      }
      const botToken = clip(body?.bot_token, 200).trim();
      const claimedUid = clip(body?.bot_uid, 80).trim();
      const aiName = body?.ai_name ? clip(body.ai_name, 80).trim() : null;
      if (!botToken) {
        send(res, 400, {
          error: "bot_token required",
          why: "认领要出示这个号的连接凭据——只有它的主人拿得到，这是我们唯一能核验的东西。",
        });
        return true;
      }
      const who = await botAuth.identify(botToken);
      if (!who.ok) {
        send(res, who.status, { error: who.error });
        return true;
      }
      if (claimedUid && claimedUid !== who.robotId) {
        send(res, 409, {
          error: "bot_uid mismatch",
          why: `这串凭据属于 ${who.robotId}，不是 ${claimedUid}`,
        });
        return true;
      }
      const r = record({ aiUid: who.robotId, ownerUid: uid, aiName, source: "claim" });
      if (!r.ok && r.reason === "conflict") {
        send(res, 409, {
          error: "already claimed by someone else",
          what_to_do: "这个 AI 已经登记在别人名下了。要转移归属，请那个人先在自己的界面上放弃它。",
        });
        return true;
      }
      send(res, 200, { ai_uid: who.robotId, owner_uid: uid, source: "claim" });
      return true;
    }

    // 放弃：只能放弃自己名下的（remove 的 WHERE 里锁着 owner_uid）
    if (rest && rest !== "claim" && req.method === "DELETE") {
      const r = q.remove.run(decodeURIComponent(rest), uid);
      if (!r.changes) {
        send(res, 404, { error: "not found" });
        return true;
      }
      send(res, 200, { ok: true });
      return true;
    }

    send(res, 405, { error: "method not allowed" });
    return true;
  }

  return { handle, record, aiUidsOf, listOf, ownerOf };
}

/**
 * 从票据账本回填归属（启动时跑一次）。
 *
 * 🔴 为什么必须有它：可见性是 09-10 才收紧的，而在那之前建的号（元知、"2"…）
 *    在登记册里一条都没有。不回填的话，收紧上线的那一刻这些 AI 会**集体从界面上消失**，
 *    看起来像"数据没了"。而这份归属并不需要谁重新自报 —— 票据表里
 *    `bot_uid + inviter_uid` 本来就是我们建号时亲眼记下的，是同一件事实。
 *
 * 幂等：record() 里同主人重复登记不算改动；已有更硬来源的不会被覆盖。
 */
export function backfillFromInvites({ db, owners, log = console }) {
  const has = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='invites'`).get();
  if (!has) return 0;
  const rows = db.prepare(
    `SELECT bot_uid, inviter_uid, claim_name FROM invites
      WHERE bot_uid IS NOT NULL AND bot_uid <> '' AND status IN ('open','accepted')`).all();
  let n = 0;
  for (const r of rows) {
    const res = owners.record({
      aiUid: r.bot_uid, ownerUid: r.inviter_uid, aiName: r.claim_name || null, source: "invite",
    });
    if (res.ok && res.changed) n += 1;
  }
  if (n) log.log?.(`[ai-owners] 从票据账本回填 ${n} 条归属`);
  return n;
}
