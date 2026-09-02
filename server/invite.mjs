/**
 * 邀请 AI · 票据服务（苏白 2026-09-02 夜定稿）
 *
 * 要修的病根：宿主把**「造一个新 AI」当成了「邀请一个已有的 AI」**。
 * 于是想请一个外面的 AI 进来，只能先造个空壳再把它绑上去 —— 那条又长又丑的
 * `npx ... bind --bot-token ...` 命令就是这么来的，而且它一出手就占了名字、
 * 占了通讯录一格，哪怕对方根本没答应。
 *
 * 这一层只干一件事：**把"发邀请"和"造号"拆开**。
 *   出票（不占名字） → 对方自己来兑换并自报身份 → （可选）你点头 → 才有号
 *
 * 三个刻意的设计取舍（别改回去）：
 *
 *  1. **我们绝不持有用户凭据。** 建号只能在"人正在浏览器里"的时候发生，由前端
 *     用他自己的登录态调宿主现成的接口，然后把结果交给我们封进票里。
 *     后端存一把"能随时替他造号"的钥匙，是这套东西里最不该有的东西。
 *
 *  2. **票据原文不落库。** 库里只有 `code_hash`（sha256）。
 *     🔴 而 bot token 的封装密钥是**从票据原文派生**的（no-approval 路径）——
 *     所以"库被抄走"和"票被抄走"任一单独发生都拿不到 token，必须两者兼得。
 *     这是刻意的：票据是一张能换到"以某个身份连进来"的凭据，按凭据对待。
 *
 *  3. **token 绝不写进邀请函文本。** 邀请函是要被复制到微信/邮件里的东西，
 *     写进去就等于把凭据丢进聊天记录（09-02 已经真发生过一次：那个测试 bot
 *     的 token 贴进了微信）。所以邀请函里只有**一次性票号**，token 只在
 *     TLS 直连兑换接口时交付，且**只交付一次**。
 */
import { randomUUID, randomBytes, createHash, createCipheriv, createDecipheriv, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { send, readJson, clip } from "./http-util.mjs";

/** 票据默认有效期（天）。苏白定的默认值。 */
export const DEFAULT_TTL_DAYS = 7;
/** 有效期上限 —— 长期有效的票等于长期敞着的门。 */
const MAX_TTL_DAYS = 30;

/**
 * 兑换失败限流：同一 IP 每分钟 20 次。
 * 票号是 256 位随机数，穷举不现实；这道闸不是防爆破，是防**把接口当探测器刷日志**。
 */
const REDEEM_WINDOW_MS = 60_000;
const REDEEM_FAIL_MAX = 20;

export function initInviteSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS invites (
      id            TEXT PRIMARY KEY,
      code_hash     TEXT NOT NULL UNIQUE,
      inviter_uid   TEXT NOT NULL,
      space_id      TEXT NOT NULL,
      require_approval INTEGER NOT NULL DEFAULT 0,
      status        TEXT NOT NULL,          -- open|pending|accepted|rejected|revoked
      bot_uid       TEXT,
      sealed_token  TEXT,                   -- iv.tag.ciphertext（base64url），交付后清空
      claim_name    TEXT,
      claim_owner   TEXT,
      claim_desc    TEXT,
      note          TEXT,                   -- 出票时的备注（给自己看的）
      expires_at    INTEGER NOT NULL,
      redeemed_at   INTEGER,
      decided_at    INTEGER,
      delivered_at  INTEGER,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_invites_inviter
      ON invites(inviter_uid, created_at DESC);
  `);
}

// ── 封装 ────────────────────────────────────────────────────────
/**
 * 服务端封装密钥。没配环境变量时**自动生成并落盘 0600**，
 * 而不是退化成明文存储 —— "忘了配"必须等于"依然是密封的"，不能等于"敞着"。
 */
function loadSealSecret({ envValue, keyPath }) {
  if (envValue) return createHash("sha256").update(envValue).digest();
  if (keyPath && existsSync(keyPath)) {
    return createHash("sha256").update(readFileSync(keyPath)).digest();
  }
  const fresh = randomBytes(32);
  if (keyPath) writeFileSync(keyPath, fresh, { mode: 0o600 });
  return createHash("sha256").update(fresh).digest();
}

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const unb64u = (s) => Buffer.from(String(s), "base64url");

/** 票号：256 位随机。它就是钥匙，所以长度按钥匙给。 */
function newCode() {
  return `yi_${randomBytes(32).toString("base64url")}`;
}
const hashCode = (code) => createHash("sha256").update(String(code)).digest("hex");

export function createInvites({ db, spaceId, apiBase, sealSecretEnv, sealKeyPath, hostApiUrl }) {
  initInviteSchema(db);
  const SEAL = loadSealSecret({ envValue: sealSecretEnv, keyPath: sealKeyPath });

  /**
   * 封装密钥派生。
   * `material` = 票据原文（不需审批：库+票两者兼得才解得开）
   *            或 code_hash（走审批：出票时还没有 token，那一刻拿不到原文）
   */
  const sealKey = (material) =>
    createHash("sha256").update(SEAL).update("|yoyoo-invite|").update(String(material)).digest();

  function seal(token, material) {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", sealKey(material), iv);
    const body = Buffer.concat([c.update(String(token), "utf8"), c.final()]);
    return [b64u(iv), b64u(c.getAuthTag()), b64u(body)].join(".");
  }

  function unseal(sealed, material) {
    const [iv, tag, body] = String(sealed).split(".");
    const d = createDecipheriv("aes-256-gcm", sealKey(material), unb64u(iv));
    d.setAuthTag(unb64u(tag));
    return Buffer.concat([d.update(unb64u(body)), d.final()]).toString("utf8");
  }

  const q = {
    insert: db.prepare(`
      INSERT INTO invites
        (id, code_hash, inviter_uid, space_id, require_approval, status,
         bot_uid, sealed_token, note, expires_at, created_at, updated_at)
      VALUES (?,?,?,?,?,'open',?,?,?,?,?,?)`),
    byHash: db.prepare(`SELECT * FROM invites WHERE code_hash = ?`),
    byId: db.prepare(`SELECT * FROM invites WHERE id = ? AND inviter_uid = ?`),
    listMine: db.prepare(`
      SELECT id, status, require_approval, bot_uid, claim_name, claim_owner, claim_desc,
             note, expires_at, redeemed_at, decided_at, delivered_at, created_at
        FROM invites WHERE inviter_uid = ? ORDER BY created_at DESC LIMIT 200`),
    markRedeemed: db.prepare(`
      UPDATE invites SET status=?, claim_name=?, claim_owner=?, claim_desc=?,
             redeemed_at=?, updated_at=? WHERE id=?`),
    attachToken: db.prepare(`
      UPDATE invites SET status='accepted', bot_uid=?, sealed_token=?,
             decided_at=?, updated_at=? WHERE id=?`),
    setStatus: db.prepare(`UPDATE invites SET status=?, decided_at=?, updated_at=? WHERE id=?`),
    consumeToken: db.prepare(`
      UPDATE invites SET sealed_token=NULL, delivered_at=?, updated_at=? WHERE id=?`),
  };

  // ── 兑换失败限流（内存即可：进程重启后重新计数，不是安全边界）──
  const fails = new Map(); // ip -> { n, at }
  function tooManyFails(ip) {
    const hit = fails.get(ip);
    if (!hit || Date.now() - hit.at > REDEEM_WINDOW_MS) return false;
    return hit.n >= REDEEM_FAIL_MAX;
  }
  function noteFail(ip) {
    const hit = fails.get(ip);
    if (!hit || Date.now() - hit.at > REDEEM_WINDOW_MS) fails.set(ip, { n: 1, at: Date.now() });
    else hit.n += 1;
  }

  const expired = (row, now) => now > row.expires_at;

  /**
   * 邀请函 —— **写给 AI 看的，不是写给人看的**。
   * 苏白原话是"弹出来一段话直接发给你，你看到就自己进来"。所以这段话必须做到：
   * 一个从没见过这个系统的 AI 读完就知道下一步打什么请求，不需要人转述。
   */
  function letter({ code, requireApproval, inviterName }) {
    const base = apiBase || "<本站地址>/yoyoo/v1";
    return [
      `你被邀请加入 ${inviterName || "一个"} 的工作空间（Yoyoo）。这张邀请函是给你（AI）读的。`,
      ``,
      `请用下面这张一次性票号自己进来，并自报身份：`,
      ``,
      `  curl -X POST ${base}/invites/redeem \\`,
      `    -H 'content-type: application/json' \\`,
      `    -d '{"code":"${code}",`,
      `         "name":"你的名字",`,
      `         "owner":"谁负责你",`,
      `         "description":"你能干什么"}'`,
      ``,
      requireApproval
        ? `兑换后你会拿到 {"status":"pending"} —— 说明邀请人要先过一眼。他点头之后，`
          + `用同一个票号打 ${base}/invites/pickup 取你的连接凭据（token）。`
        : `兑换成功会直接返回你的连接凭据（token）和接入地址，你立刻就能说话。`,
      `拿到 token 后**第一件事**：给邀请人发一条单聊消息，自报身份、说你来了。`,
      ``,
      `注意：票号只能用一次（谁先兑换就是谁），${DEFAULT_TTL_DAYS} 天内有效；`,
      `token 也只交付一次，拿到请自己存好。`,
      // ⚠️ 措辞刻意区分两件事：这段话**就是要发给受邀 AI 的**（私聊/私信没问题），
      //    真正不该做的是把它贴到公开群或长期留存的文档里。第一版这里写的是
      //    "不要贴进聊天记录"，那和它自己的用法直接打架 —— 改了。
      `这段话可以直接私发给受邀的 AI；但不要贴到公开群或长期留存的文档里。`,
      `token 则任何时候都不该出现在聊天里。`,
    ].join("\n");
  }

  /** 交付给 AI 的接入信息。地址用配置值，不猜。 */
  const connectInfo = (row, token) => ({
    status: "accepted",
    bot_uid: row.bot_uid,
    bot_token: token,
    api_url: hostApiUrl || null,
    space_id: row.space_id,
    hint: "拿到 token 的第一件事：给邀请人发一条单聊消息自报身份。token 只交付这一次。",
  });

  // ── 公开面（无需登录：票据本身就是凭据）─────────────────────
  async function handlePublic(req, res, { path, now, root }) {
    const isRedeem = path === `${root}/invites/redeem`;
    const isPickup = path === `${root}/invites/pickup`;
    if (!isRedeem && !isPickup) return false;
    if (req.method !== "POST") return send(res, 405, { error: "method not allowed" }), true;

    const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "?")
      .split(",")[0].trim();
    if (tooManyFails(ip)) return send(res, 429, { error: "too many attempts" }), true;

    let body;
    try {
      body = await readJson(req);
    } catch (e) {
      return send(res, 400, { error: String(e.message || e) }), true;
    }
    const code = clip(body.code, 200).trim();
    if (!code) return send(res, 400, { error: "code required" }), true;

    const row = q.byHash.get(hashCode(code));
    // 票不存在和票已作废一律给同一个回答 —— 不当"这个票号存在吗"的探测器。
    if (!row) {
      noteFail(ip);
      return send(res, 404, { error: "invite not found or no longer valid" }), true;
    }
    if (expired(row, now) && row.status === "open") {
      return send(res, 410, { error: "invite expired" }), true;
    }

    if (isRedeem) {
      if (row.status !== "open") {
        noteFail(ip);
        return send(res, 409, { error: `invite already ${row.status}` }), true;
      }
      const claim = {
        name: clip(body.name, 60).trim(),
        owner: clip(body.owner, 60).trim(),
        desc: clip(body.description, 500).trim(),
      };
      if (!claim.name) return send(res, 400, { error: "name required（请自报名字）" }), true;

      if (row.require_approval) {
        // 走审批：只排队。**此刻不建号、不占名字、不进通讯录** —— 这是整件事的重点。
        q.markRedeemed.run("pending", claim.name, claim.owner, claim.desc, now, now, row.id);
        return send(res, 202, {
          status: "pending",
          message: "已收到，等邀请人确认。确认后用同一个票号打 /invites/pickup 取 token。",
        }), true;
      }

      // 不审批（默认）：号在出票那一刻就建好了，token 封在票里 —— 现在交付，且只交付这一次。
      if (!row.sealed_token) {
        return send(res, 409, { error: "invite has no credential sealed（出票时未附凭据）" }), true;
      }
      let token;
      try {
        token = unseal(row.sealed_token, code);
      } catch {
        return send(res, 500, { error: "seal broken" }), true;
      }
      q.markRedeemed.run("accepted", claim.name, claim.owner, claim.desc, now, now, row.id);
      q.consumeToken.run(now, now, row.id);
      console.log(`[invite] redeem ok id=${row.id} bot=${row.bot_uid} name=${JSON.stringify(claim.name)}`);
      return send(res, 200, connectInfo(row, token)), true;
    }

    // pickup：走审批那条路，邀请人点头之后来取
    if (row.status === "pending") {
      return send(res, 202, { status: "pending", message: "邀请人还没确认。" }), true;
    }
    if (row.status !== "accepted") {
      return send(res, 409, { error: `invite ${row.status}` }), true;
    }
    if (!row.sealed_token) {
      return send(res, 410, { error: "credential already delivered（token 只交付一次）" }), true;
    }
    let token;
    try {
      // 审批路径的封装料是 code_hash：出票那一刻还没有 token，也就拿不到票据原文。
      token = unseal(row.sealed_token, row.code_hash);
    } catch {
      return send(res, 500, { error: "seal broken" }), true;
    }
    q.consumeToken.run(now, now, row.id);
    console.log(`[invite] pickup ok id=${row.id} bot=${row.bot_uid}`);
    return send(res, 200, connectInfo(row, token)), true;
  }

  // ── 用户面（需登录）─────────────────────────────────────────
  async function handle(req, res, { path, uid, now, root }) {
    if (!path.startsWith(`${root}/invites`)) return false;
    const rest = path.slice(`${root}/invites`.length).replace(/^\//, "");

    // 集合
    if (!rest) {
      if (req.method === "GET") {
        const rows = q.listMine.all(uid).map((r) => ({
          ...r,
          require_approval: !!r.require_approval,
          // 过期但没人兑换的票，列表里直接显示成 expired（不改库，读时判定）
          status: r.status === "open" && now > r.expires_at ? "expired" : r.status,
        }));
        return send(res, 200, { invites: rows }), true;
      }
      if (req.method !== "POST") return send(res, 405, { error: "method not allowed" }), true;

      let body;
      try {
        body = await readJson(req);
      } catch (e) {
        return send(res, 400, { error: String(e.message || e) }), true;
      }
      const requireApproval = body.require_approval === true ? 1 : 0;
      const ttlDays = Math.min(
        Math.max(Number(body.ttl_days) || DEFAULT_TTL_DAYS, 1), MAX_TTL_DAYS);
      const botUid = clip(body.bot_uid, 80).trim();
      const botToken = clip(body.bot_token, 200).trim();

      // 🔴 不审批这条路必须在出票时就把号建好并把凭据交上来。
      //    我们不替他保管能造号的钥匙 ⇒ 建号只能发生在"他人在浏览器里"的时刻，
      //    而不审批意味着兑换时他可能不在 ⇒ 只剩"出票即建号"这一种可能。
      if (!requireApproval && (!botUid || !botToken)) {
        return send(res, 400, {
          error: "bot_uid + bot_token required when require_approval is false",
          why: "不审批时凭据必须在出票那一刻就封进票里（后端不持有能造号的用户凭据）",
        }), true;
      }

      const code = newCode();
      const id = randomUUID();
      const sealed = requireApproval ? null : seal(botToken, code);
      q.insert.run(
        id, hashCode(code), uid, spaceId || "", requireApproval,
        requireApproval ? null : botUid, sealed,
        clip(body.note, 200), now + ttlDays * 86_400_000, now, now);

      console.log(`[invite] issued id=${id} approval=${requireApproval} bot=${botUid || "-"}`);
      return send(res, 201, {
        id,
        // 票号**只在这一次响应里出现**（库里只有它的哈希）。前端负责让人复制走。
        code,
        letter: letter({ code, requireApproval, inviterName: clip(body.inviter_name, 40) }),
        require_approval: !!requireApproval,
        expires_at: now + ttlDays * 86_400_000,
      }), true;
    }

    const [id, action] = rest.split("/");
    const row = q.byId.get(id, uid);
    if (!row) return send(res, 404, { error: "not found" }), true;

    // 同意：前端**在这一刻**用他自己的登录态建号，把结果交上来封存待取。
    if (action === "approve") {
      if (req.method !== "POST") return send(res, 405, { error: "method not allowed" }), true;
      if (row.status !== "pending") {
        return send(res, 409, { error: `invite is ${row.status}, nothing to approve` }), true;
      }
      let body;
      try {
        body = await readJson(req);
      } catch (e) {
        return send(res, 400, { error: String(e.message || e) }), true;
      }
      const botUid = clip(body.bot_uid, 80).trim();
      const botToken = clip(body.bot_token, 200).trim();
      if (!botUid || !botToken) {
        return send(res, 400, { error: "bot_uid + bot_token required" }), true;
      }
      q.attachToken.run(botUid, seal(botToken, row.code_hash), now, now, row.id);
      console.log(`[invite] approved id=${row.id} bot=${botUid}`);
      return send(res, 200, { id: row.id, status: "accepted" }), true;
    }

    if (action === "reject") {
      if (req.method !== "POST") return send(res, 405, { error: "method not allowed" }), true;
      if (row.status !== "pending") {
        return send(res, 409, { error: `invite is ${row.status}, nothing to reject` }), true;
      }
      q.setStatus.run("rejected", now, now, row.id);
      return send(res, 200, { id: row.id, status: "rejected" }), true;
    }

    // 撤票：还没被兑换的票随时可以作废（凭据也一起抹掉）
    if (!action) {
      if (req.method === "DELETE") {
        q.setStatus.run("revoked", now, now, row.id);
        q.consumeToken.run(now, now, row.id);
        return send(res, 200, { id: row.id, status: "revoked" }), true;
      }
      if (req.method === "GET") {
        const { sealed_token, code_hash, ...safe } = row;
        return send(res, 200, {
          ...safe,
          require_approval: !!row.require_approval,
          credential_pending: !!sealed_token,
        }), true;
      }
      return send(res, 405, { error: "method not allowed" }), true;
    }

    return send(res, 404, { error: "not found" }), true;
  }

  return { handle, handlePublic, letter, _internals: { seal, unseal, hashCode, newCode } };
}
