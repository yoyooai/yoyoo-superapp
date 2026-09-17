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
 * 凭据交付宽限窗口（毫秒）。默认 24 小时，可用 env `YOYOO_INVITE_GRACE_MS` 收紧。
 *
 * 🔴 为什么必须有它（2026-09-10 元知实测，苏白把报告转过来那次）：
 *    老规矩是"交付即销毁"——响应一发出去，库里的密文立刻抹掉。
 *    结果是：**只要那一次响应没被对方成功保存，票和凭据同时消失**。
 *    元知就是这么卡死的：它的解析器只认 `token` / `data.token`，
 *    我们给的字段叫 `bot_token` ⇒ 它判定"没拿到"，把响应删了重试，
 *    第二次得到 409 `invite already accepted` —— 票被吃掉、凭据拿不回来、
 *    只能求人重新发一张（还会在宿主里留下一个用不上的空号）。
 *
 *    根因不是它解析错，是**我们把"发送成功"当成了"送达成功"**。
 *    网络中断、进程崩溃、写盘失败都会复现同一个死局。
 *    所以交付改成两段：先 delivered（密文留着，同一张票可以再取），
 *    对方确认收到打一次 `/invites/ack` 才真正销毁；没人 ack 就等宽限窗口到点自动销毁。
 *    "只交付一次"这条性质没有丢——它现在的准确表述是
 *    **"只向持有这张票的人交付，且窗口关上后再也拿不到"**。
 */
export const DEFAULT_GRACE_MS = 24 * 60 * 60 * 1000;

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
      name_applied_at INTEGER,              -- 自报名字已写回宿主的时刻（见下）
      ack_at        INTEGER,                -- 对方确认"凭据我收到了"的时刻（收到即销毁密文）
      seal_material TEXT,                   -- 'code' | 'code_hash'：这份密文是拿什么派生的密钥封的
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_invites_inviter
      ON invites(inviter_uid, created_at DESC);
  `);

  /*
   * `name_applied_at` —— 「不审批」那条路的名字回填标记（苏白 2026-09-02 定：
   * "默认直接进来，但它总得给自己起个名字，不要顶个「受邀 AI · 待接受」"）。
   *
   * 为什么这一列在**我们**库里而不是靠宿主判断：改宿主里那个号的名字要用户的
   * `uk_` 钥匙，只有他的浏览器里有 ⇒ 回填只能由前端做。后端唯一能做的是记住
   * "这一条回填过了"，否则前端每次打开都会重复 PUT 一遍。
   * 老库没有这一列，补列（`ADD COLUMN` 重复执行会抛，所以先读 table_info 判断，
   * 不用 try/catch —— 吞异常会把"表结构真的错了"一起吞掉。同 market.mjs）。
   */
  const cols = new Set(db.prepare(`PRAGMA table_info(invites)`).all().map((r) => r.name));
  if (!cols.has("name_applied_at")) {
    db.exec(`ALTER TABLE invites ADD COLUMN name_applied_at INTEGER`);
  }
  // 09-10 新增的两列，同样要补（老库里没有）。
  if (!cols.has("ack_at")) {
    db.exec(`ALTER TABLE invites ADD COLUMN ack_at INTEGER`);
  }
  if (!cols.has("seal_material")) {
    /*
     * 老库里的密文没有这一列，得推断出来：
     *   · 走审批（require_approval=1）的密文是出票后 approve 时封的 ⇒ 料是 code_hash
     *   · 不审批的是出票那一刻用票据原文封的           ⇒ 料是 code
     * 这个推断和老代码 unseal 时写死的选择完全一致，所以补列不会改变任何一条老数据的可解性。
     */
    db.exec(`ALTER TABLE invites ADD COLUMN seal_material TEXT`);
    db.exec(`UPDATE invites SET seal_material =
               CASE WHEN require_approval = 1 THEN 'code_hash' ELSE 'code' END
             WHERE sealed_token IS NOT NULL AND seal_material IS NULL`);
  }
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

export function createInvites({
  db, spaceId, apiBase, sealSecretEnv, sealKeyPath, hostApiUrl,
  graceMs = DEFAULT_GRACE_MS,
  /**
   * 号归到谁名下 —— 由 ai-owners 登记册接住（可不传，本模块不依赖它）。
   * 🔴 归属必须在**建号那一刻**登记，不能等以后靠谁自报：
   *    出票和同意都发生在邀请人的登录态里，这一刻我们亲眼看着号是谁的，
   *    是整条链上可信度最高的一个瞬间。错过它，后面就只剩"谁说了算"。
   */
  recordOwnership = null,
  /**
   * 「还能不能再开一台」—— 额度闸（可不传，本模块不依赖它）。
   * 🔴 出票口这道闸是**兜底**，不是唯一的闸：不审批那条路是前端先建号再回来出票，
   *    真正该拦的时刻在它动手之前（界面先问 /usage/can-add-ai）。
   *    但闸必须也钉在服务端 —— 只靠界面自觉的限制，等于没有限制。
   */
  agentQuotaGate = null,
  /**
   * 「留一个能收消息的网址」—— 入驻时**顺手**把收件地址登记掉（可不传）。
   *
   * 🔴 为什么做在门口（09-16 苏白）：以前是进来之后再一家一家去要地址，
   *    要不到就只能干等。门口定好规矩，以后进来一个算一个。
   * 🔴 **二选一，不是必填**：给一个收件地址，**或者**你自己一直挂着来取。
   *    有些接入方确实拿不出公网地址，一刀切必填会把本来好好的挡在门外。
   * 🔴 复用 bot-webhooks 的 registerInbox（同一份校验、同一张表），
   *    门口不另长一套登记 —— 两套登记迟早在校验口径上分家。
   */
  registerInbox = null,
}) {
  initInviteSchema(db);
  const SEAL = loadSealSecret({ envValue: sealSecretEnv, keyPath: sealKeyPath });
  const GRACE = Math.max(0, Number(graceMs) || 0);

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
         bot_uid, sealed_token, seal_material, note, expires_at, created_at, updated_at)
      VALUES (?,?,?,?,?,'open',?,?,?,?,?,?,?)`),
    byHash: db.prepare(`SELECT * FROM invites WHERE code_hash = ?`),
    byId: db.prepare(`SELECT * FROM invites WHERE id = ? AND inviter_uid = ?`),
    listMine: db.prepare(`
      SELECT id, status, require_approval, bot_uid, claim_name, claim_owner, claim_desc,
             note, expires_at, redeemed_at, decided_at, delivered_at, ack_at,
             name_applied_at, created_at,
             -- 界面要能一眼看出"这张票现在还能不能把凭据取回来"，
             -- 所以把"密文还在吗"作为布尔值给出去（密文本身永远不出库）。
             (sealed_token IS NOT NULL) AS credential_available
        FROM invites WHERE inviter_uid = ? ORDER BY created_at DESC LIMIT 200`),
    markNameApplied: db.prepare(`
      UPDATE invites SET name_applied_at=?, updated_at=? WHERE id=?`),
    markRedeemed: db.prepare(`
      UPDATE invites SET status=?, claim_name=?, claim_owner=?, claim_desc=?,
             redeemed_at=?, updated_at=? WHERE id=?`),
    attachToken: db.prepare(`
      UPDATE invites SET status='accepted', bot_uid=?, sealed_token=?, seal_material='code_hash',
             decided_at=?, updated_at=? WHERE id=?`),
    setStatus: db.prepare(`UPDATE invites SET status=?, decided_at=?, updated_at=? WHERE id=?`),
    /**
     * 交付：**只记时刻，不销毁密文**（见 DEFAULT_GRACE_MS 那段）。
     * 重复交付时保留第一次的 delivered_at —— 宽限窗口是从"第一次发出去"起算的，
     * 每取一次就续期的话，一个不停重试的客户端能把窗口无限延长。
     */
    markDelivered: db.prepare(`
      UPDATE invites SET delivered_at=COALESCE(delivered_at, ?), updated_at=? WHERE id=?`),
    /** 真正销毁密文（对方 ack、宽限到点、撤票、拒绝）。 */
    wipeToken: db.prepare(`
      UPDATE invites SET sealed_token=NULL, seal_material=NULL, updated_at=? WHERE id=?`),
    markAcked: db.prepare(`
      UPDATE invites SET sealed_token=NULL, seal_material=NULL, ack_at=?, updated_at=? WHERE id=?`),
    reseal: db.prepare(`
      UPDATE invites SET sealed_token=?, seal_material='code_hash', bot_uid=COALESCE(?, bot_uid),
             delivered_at=NULL, ack_at=NULL, updated_at=? WHERE id=?`),
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
   *
   * 🔴 2026-09-14 夜苏白亲自定的形状：**一句话 + 一个链接 + 一把钥匙**。
   *    他的原话：「现在邀请 Bot 的内容也太长了……把他的情况讲清楚，然后给他一个链接，
   *    让他自己去读这个地方的所有东西；再给他一个授权 ID 或者密钥，只要能让他连接
   *    进来就可以了。你看人家 QQ 邮箱的 Agent 那些都多么简单，包括 HXA……」
   *
   * 上一版把"怎么收消息、怎么报到、响应长什么样、出错怎么办"全塞进了信里 ——
   * 八十多行。每一条都是踩出来的教训，但**信不是教训的收纳柜**：
   * 一封读不完的信，和一封没读的信，效果是一样的。
   *
   * 所以那些教训没有被删，是被**搬了家**：
   *   · 怎么接（含"别写成定时轮询"那个坑）→ `/start`，十分钟读完的一页
   *   · 全部功能细节                        → `/manual`
   *   · "接没接对"                          → `/selfcheck`，一条命令自己跑，会报红
   * 信里只留三样：你来到哪儿、钥匙怎么拿、接下来去哪一页。
   *
   * 🔴 唯一保留在信里的两条，因为它们**只在这一刻有用、错过就没机会说**：
   *    ① 响应里 `bot_token` 和 `token` 是同一把钥匙（元知那次就是认不出字段名，
   *       判定"没拿到"，而票号已经被消费 —— 代价是一整张票作废）；
   *    ② 没存住凭据怎么补救（不补这句，对方遇到解析失败只会以为完了）。
   */
  function letter({ code, requireApproval, inviterName, ttlDays = DEFAULT_TTL_DAYS }) {
    const base = apiBase || "<本站地址>/eryuan/v1";
    return [
      `你被邀请加入「二元空间」—— 邀请你的是 ${inviterName || "这里的一位成员"}。`,
      `这里人和 AI 同一本通讯录、同一个群、同一条消息流；你进来是**成员**，不是插件。`,
      ``,
      `**① 拿钥匙**（票只能用一次，${ttlDays} 天内有效）：`,
      ``,
      `  curl -X POST ${base}/invites/redeem \\`,
      `    -H 'content-type: application/json' \\`,
      `    -d '{"code":"${code}","name":"你的名字","owner":"谁负责你","description":"你能干什么"}'`,
      ``,
      requireApproval
        ? `会先回 {"status":"pending"}，等邀请人点头后用同一个票号打 ${base}/invites/pickup 取。`
        : null, // 不需要审批时这一行整条不出现（不是留一个空行）
      `返回里 **bot_token**（"token" 是同义别名）是凭据，**api_url** 是地址，先存好再做别的。`,
      `你报的 name 会成为显示名，别报占位符。没存住也别慌：只要没打过第 ③ 步、`,
      `还在宽限期内，同一个票号再兑换一次会原样再给你一份（"redelivered": true）。`,
      ``,
      `**② 照这一页接进来**，十分钟够了：${base}/start`,
      ``,
      `收消息、发消息、报到都在里面，末尾有一条自测命令 —— **跑到全绿才算接好**。`,
      `（第 3 步「报到」别跳过：跳了不报错，但主人点进你只会看到一个空工位。）`,
      ``,
      `**③ 接好了回一句**：给邀请人发条单聊说你来了，并确认收到：`,
      ``,
      `  curl -X POST ${base}/invites/ack -H 'content-type: application/json' -d '{"code":"${code}"}'`,
      ``,
      `这个平台对外只有一个名字：**二元空间**（代码和日志里的别的字样都是内部旧名，别对外提）。`,
      `这段可以私发给受邀的 AI，别贴公开群；token 任何时候都不该出现在聊天里。`,
    ].filter((line) => line !== null).join("\n");
  }

  /** 交付给 AI 的接入信息。地址用配置值，不猜。 */
  const connectInfo = (row, token, extra = {}) => ({
    status: "accepted",
    // 🔴 契约版本号（2026-09-10 加）：让客户端能判断"我认识这个形状吗"，
    //    而不是靠猜字段名。改字段名必须同时把这个版本号往上抬。
    credential_schema: "eryuan.invite.v1",
    bot_uid: row.bot_uid,
    bot_token: token,
    /*
     * 🔴 `token` 是 `bot_token` 的**别名**，不是第二份凭据（2026-09-10 加）。
     *    元知的解析器只认 `token` / `data.token`，我们只给 `bot_token` ⇒ 它判定
     *    "没拿到"，而那一刻票号已经被消费了。别名花不了什么，却挡掉一整类死局。
     *    ⚠️ 别把它挪到 `data` 里去凑第三种形状 —— 两个字段已经覆盖了实际见过的
     *    两种假设，再加只是让契约更糊。
     */
    token,
    api_url: hostApiUrl || null,
    space_id: row.space_id,
    // 程序化可读的说明书地址——不用 AI 从邀请函的自然语言正文里解析链接。
    manual_url: apiBase ? `${apiBase}/manual` : null,
    // 🔴 bootstrap 目标（2026-09-03 元知实测卡点A的病根）：邀请函要求"拿到 token 第一件事
    //    给邀请人发单聊自报身份"，但过去这个响应只给了 bot 自己的信息，没告诉它"邀请人是谁、
    //    往哪发"——新 AI 想主动报到却没有目标 ID，只能干等邀请人先开口。这不是权限问题，
    //    是目标发现链路断了。这里补上：邀请人 uid + 一个可直接喂给 /v1/bot/sendMessage 的
    //    单聊目标。OCTO/WuKongIM 单聊 channel_type=1、channel_id 就是对方 uid
    //    （见 octo-connector/src/target.mjs：`1 = 单聊（channel_id 是对方 uid）`），
    //    与元知实测"拿 from_uid 当 channel_id 发通了"一致。inviter_uid 在 invites 表里
    //    NOT NULL，出票那一刻就是登录的邀请人，一定有值。
    inviter_uid: row.inviter_uid,
    bootstrap_dm_target: { channel_id: row.inviter_uid, channel_type: 1 },
    hint: "拿到 token 的第一件事：用 bootstrap_dm_target 给邀请人发一条单聊、自报身份"
      + "（POST {api_url}/v1/bot/sendMessage，channel_id=bootstrap_dm_target.channel_id，"
      + "channel_type=1）——不用等邀请人先开口。"
      + "存好凭据之后请打一次 ack_url（POST，body 里带同一个 code），"
      + "打过之后这张票的密文才会真正销毁；没打的话它会在宽限窗口到点后自动销毁。"
      + "进来后请先读一遍 manual_url；这个平台对外只叫二元空间，别提内部实现名字或旧名。",
    // 🔴 二选一，说人话（09-16 苏白）：不许出现"回调""签名算法"这类词。
    how_you_get_messages:
      "收消息有两条路，挑一条就行："
      + "① 留一个能收消息的网址 —— 兑换这张票时带上 webhook_url（我们送消息去的网址）"
      + "和 secret（一串至少 16 位的暗号）。有新消息我们直接送到那里，你不用一直挂着，"
      + "关机再开也不会漏。"
      + "② 你自己一直挂着来取 —— 什么都不用填，保持进程常驻、不停来问有没有新消息。"
      + "🔴 挑第二条的话，进程一断你就真的收不到了（这是目前最常见的「它不理人」的原因）。"
      + "两条随时可以换：什么时候想改成我们送，来留一个网址就行。",
    /*
     * 🔴 交付确认（2026-09-10）：这是"发送成功 ≠ 送达成功"的那道补丁。
     *    在 ack 之前，同一张票**可以再取一次同样的凭据** —— 解析失败、进程崩溃、
     *    网络断在半路都还有救。ack 之后（或窗口到点）才不可逆。
     */
    ack_url: apiBase ? `${apiBase}/invites/ack` : null,
    recoverable_until: extra.recoverableUntil ?? null,
    redelivered: !!extra.redelivered,
    // 「留一个能收消息的网址」这件事的结局（09-16）。false 不是失败，
    // 是"你选了自己一直挂着来取"那条路 —— 二选一，两条都正常。
    inbox_registered: !!extra.inbox_registered,
    inbox_note: extra.inbox_note ?? null,
  });

  /**
   * 用这张票该用什么料来解密文。
   * 出票即封的（不审批）用票据原文；approve / reissue 时封的用 code_hash
   * ——后两者发生时服务端手里只有 code_hash，拿不到票据原文。
   * 老库没有 seal_material 列时按 require_approval 推断（同 initInviteSchema 的补列逻辑）。
   */
  const materialFor = (row, code) =>
    (row.seal_material || (row.require_approval ? "code_hash" : "code")) === "code_hash"
      ? row.code_hash
      : code;

  /** 宽限窗口到点了吗（没交付过就还没开始计时）。 */
  const graceOver = (row, now) =>
    !!row.delivered_at && now > row.delivered_at + GRACE;

  /**
   * 惰性销毁：任何一次公开面访问都先看一眼"这张票的宽限窗口是不是已经过了"。
   *
   * 🔴 刻意用惰性而不是定时任务：定时任务是一个"不跑也没人发现"的东西，
   *    而销毁没做等于凭据永久留在库里。挂在访问路径上，被访问就一定被执行；
   *    没人访问的票留着密文也没有交付面（只有拿着票号才走得到这里）。
   *    ⚠️ 别把它改成"顺手续期" —— 窗口从第一次交付起算，见 markDelivered。
   */
  function sweepGrace(row, now) {
    if (row.sealed_token && graceOver(row, now)) {
      q.wipeToken.run(now, row.id);
      return { ...row, sealed_token: null, seal_material: null };
    }
    return row;
  }

  /** 窗口关上之后的那句话：必须说清"下一步找谁、做什么"，而不是只丢一个状态。 */
  const lostCredential = (row) => ({
    error: "credential no longer recoverable",
    status: row.status,
    reason: row.ack_at
      ? "你已经确认收到过凭据（打过 /invites/ack），密文当时就销毁了。"
      : "凭据已交付，可取回的宽限窗口已经关闭。",
    what_to_do:
      "请邀请人在「邀请 AI」列表里对这张票点「重新发凭据」——"
      + "他不需要重新建号，你的号还在，只是把凭据重新封进这张票；"
      + "之后你用**同一个票号**打 /invites/pickup 就能取到。",
  });

  // ── 公开面（无需登录：票据本身就是凭据）─────────────────────
  /**
   * 收下（可选的）收件地址。**二选一的执行处。**
   *
   * 三种结局：
   *   · 两个字段都没给 ⇒ `{ok:true, registered:false}` —— 走"你自己一直挂着来取"
   *     那条路，行为与今天**一个字不差**。老住户、拿不出公网地址的接入方都落在这里。
   *   · 给全了且合法 ⇒ 登记掉，以后有新消息我们直接送过去。
   *   · 只给一半 / 不是个正经网址 ⇒ `{ok:false}`，**当场拒绝并说人话**，
   *     而且票**没有被消耗**（调用点都在消票之前）—— 改对了再来一次就行。
   */
  async function takeInbox({ botUid, ownerUid, body }) {
    // 两个名字都认：`inbox_url` 是说明书里教的那个（说人话），
    // `webhook_url` 与平台既有的登记口同名（老接入方照着那边写的也能用）。
    // 🔴 只是一个别名，不是第二套登记 —— 底下走的还是同一个 registerInbox。
    const url = clip(body?.inbox_url ?? body?.webhook_url, 500).trim();
    const secret = clip(body?.secret, 200).trim();
    if (!url && !secret) return { ok: true, registered: false };   // ← 二选一的另一半
    if (!url || !secret) {
      return { ok: false, error:
        "要留收件地址的话，网址和暗号得一起给：inbox_url 是我们把新消息送去的网址，"
        + "secret 是一串至少 16 位的暗号（我们每次送信都用它证明这封信确实是我们发的）。"
        + "也可以两个都不填 —— 那就是你自己一直挂着来取，我们就不送了。" };
    }
    if (!registerInbox) return { ok: true, registered: false };    // 平台没开这条路
    if (!botUid) {
      return { ok: false, error:
        "这张票要邀请人先点头，现在号还没建好，地址存不下来。"
        + "等邀请人确认之后用同一个票号来取凭据时，把网址和暗号再带一次就行。" };
    }
    const r = await registerInbox({ aiUid: botUid, url, secret, spaceId, createdBy: ownerUid });
    if (!r.ok) {
      return { ok: false, error: `这个网址我们收不下：${r.error}` };
    }
    return { ok: true, registered: true };
  }

  /** 告诉对方"地址这件事最后怎么了"，说人话，不提内部名词。 */
  const inboxNote = (registered) => registered
    ? "已经记下你的收件地址：以后有新消息，我们直接送到那里，你不用一直挂着。"
    : "你没留收件地址，那就照老规矩：你自己一直挂着来取，我们不主动送。"
      + "什么时候想改成我们送，随时来留一个。";

  async function handlePublic(req, res, { path, now, root }) {
    const isRedeem = path === `${root}/invites/redeem`;
    const isPickup = path === `${root}/invites/pickup`;
    const isAck = path === `${root}/invites/ack`;
    if (!isRedeem && !isPickup && !isAck) return false;
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

    const found = q.byHash.get(hashCode(code));
    // 票不存在和票已作废一律给同一个回答 —— 不当"这个票号存在吗"的探测器。
    if (!found) {
      noteFail(ip);
      return send(res, 404, { error: "invite not found or no longer valid" }), true;
    }
    const row = sweepGrace(found, now);
    if (expired(row, now) && row.status === "open") {
      return send(res, 410, { error: "invite expired" }), true;
    }

    /*
     * ack —— 「凭据我存好了，可以销毁了」。
     * 幂等：重复打只回 ok，不报错（重试是它该做的事，不是错误）。
     * 只认票号本身作为凭据，跟 redeem/pickup 同一道门。
     */
    if (isAck) {
      if (row.status !== "accepted") {
        return send(res, 409, { error: `invite is ${row.status}, nothing to acknowledge` }), true;
      }
      if (row.sealed_token) q.markAcked.run(now, now, row.id);
      return send(res, 200, {
        ok: true,
        acked_at: row.ack_at || now,
        message: "凭据已销毁，这张票再也取不出东西了。",
      }), true;
    }

    if (isRedeem) {
      /*
       * 🔴 重取（2026-09-10）：票已经被这张票自己兑换过、密文还在宽限窗口内 ⇒
       *    **原样再给一次**，而不是甩一个 409 让对方去求人重发。
       *    能走到这里的前提是请求方拿着正确的票号 —— 也就是第一次兑换的同一个人，
       *    所以这不放宽任何人的访问面，只是把"响应丢了"从死局降级成重试。
       */
      if (row.status === "accepted" && row.sealed_token && !row.require_approval) {
        let token;
        try {
          token = unseal(row.sealed_token, materialFor(row, code));
        } catch {
          return send(res, 500, { error: "seal broken" }), true;
        }
        console.log(`[invite] redeem re-deliver id=${row.id} bot=${row.bot_uid}`);
        return send(res, 200, connectInfo(row, token, {
          redelivered: true,
          recoverableUntil: (row.delivered_at || now) + GRACE,
        })), true;
      }
      if (row.status === "accepted" && !row.sealed_token) {
        return send(res, 409, lostCredential(row)), true;
      }
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
        // 地址这件事在这条路上要等号建好才登记得了；这里先把"只给一半"挡掉，
        // 免得对方以为留成功了。🔴 挡在消票之前。
        const early = await takeInbox({ botUid: null, ownerUid: row.inviter_uid, body });
        if (!early.ok && (clip(body?.inbox_url ?? body?.webhook_url, 500).trim()
                          || clip(body?.secret, 200).trim())) {
          return send(res, 400, { error: early.error }), true;
        }
        // 走审批：只排队。**此刻不建号、不占名字、不进通讯录** —— 这是整件事的重点。
        q.markRedeemed.run("pending", claim.name, claim.owner, claim.desc, now, now, row.id);
        return send(res, 202, {
          status: "pending",
          message: "已收到，等邀请人确认。确认后用同一个票号打 /invites/pickup 取 token。",
        }), true;
      }

      // 不审批（默认）：号在出票那一刻就建好了，token 封在票里 —— 现在交付。
      if (!row.sealed_token) {
        return send(res, 409, { error: "invite has no credential sealed（出票时未附凭据）" }), true;
      }
      let token;
      try {
        token = unseal(row.sealed_token, materialFor(row, code));
      } catch {
        return send(res, 500, { error: "seal broken" }), true;
      }
      // 🔴 收件地址**在消票之前**收：地址填错就当场拒，而票还没被吃掉 ——
      //    改对了再来一次就行，不用去求人重发。没填地址的一律直接通过。
      const inbox = await takeInbox({ botUid: row.bot_uid, ownerUid: row.inviter_uid, body });
      if (!inbox.ok) return send(res, 400, { error: inbox.error }), true;
      q.markRedeemed.run("accepted", claim.name, claim.owner, claim.desc, now, now, row.id);
      q.markDelivered.run(now, now, row.id);
      // 名字是它自报的，归属早在出票那一刻就定了 —— 这里只补名字，不动归属。
      recordOwnership?.({
        aiUid: row.bot_uid, ownerUid: row.inviter_uid, aiName: claim.name, source: "invite",
      });
      console.log(`[invite] redeem ok id=${row.id} bot=${row.bot_uid} name=${JSON.stringify(claim.name)}`
        + ` inbox=${inbox.registered ? "yes" : "no"}`);
      return send(res, 200, connectInfo(row, token, {
        recoverableUntil: now + GRACE,
        inbox_registered: inbox.registered,
        inbox_note: inboxNote(inbox.registered),
      })), true;
    }

    // pickup：走审批那条路，邀请人点头之后来取
    if (row.status === "pending") {
      return send(res, 202, { status: "pending", message: "邀请人还没确认。" }), true;
    }
    if (row.status !== "accepted") {
      return send(res, 409, { error: `invite ${row.status}` }), true;
    }
    if (!row.sealed_token) {
      return send(res, 410, lostCredential(row)), true;
    }
    let token;
    try {
      // 审批 / 重发那条路的封装料是 code_hash：那一刻服务端拿不到票据原文。
      token = unseal(row.sealed_token, materialFor(row, code));
    } catch {
      return send(res, 500, { error: "seal broken" }), true;
    }
    // 审批那条路的号是在这一刻之前才建好的，所以"留地址"这件事在这里补上。
    // 同样挡在 markDelivered 之前，同样是二选一：没填就照老规矩。
    const inbox = await takeInbox({ botUid: row.bot_uid, ownerUid: row.inviter_uid, body });
    if (!inbox.ok) return send(res, 400, { error: inbox.error }), true;
    const redelivered = !!row.delivered_at;
    q.markDelivered.run(now, now, row.id);
    console.log(`[invite] pickup ok id=${row.id} bot=${row.bot_uid}${redelivered ? " (re-deliver)" : ""}`);
    return send(res, 200, connectInfo(row, token, {
      redelivered,
      recoverableUntil: (row.delivered_at || now) + GRACE,
      inbox_registered: inbox.registered,
      inbox_note: inboxNote(inbox.registered),
    })), true;
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

      /* 🔴 额度不够就不出票。没买过套餐的人这里一律放行（见 usage.mjs 文件头）。 */
      const gate = agentQuotaGate?.({ uid });
      if (gate && gate.allowed === false) {
        return send(res, 409, {
          error: gate.reason || "额度不够了",
          quota: { limit: gate.limit ?? null, used: gate.used ?? null },
        }), true;
      }

      const code = newCode();
      const id = randomUUID();
      const sealed = requireApproval ? null : seal(botToken, code);
      q.insert.run(
        id, hashCode(code), uid, spaceId || "", requireApproval,
        requireApproval ? null : botUid, sealed, sealed ? "code" : null,
        clip(body.note, 200), now + ttlDays * 86_400_000, now, now);

      if (!requireApproval && botUid) {
        recordOwnership?.({ aiUid: botUid, ownerUid: uid, source: "invite" });
      }
      console.log(`[invite] issued id=${id} approval=${requireApproval} bot=${botUid || "-"}`);
      return send(res, 201, {
        id,
        // 票号**只在这一次响应里出现**（库里只有它的哈希）。前端负责让人复制走。
        code,
        letter: letter({ code, requireApproval, inviterName: clip(body.inviter_name, 40), ttlDays }),
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
      // 走审批那条路建号时用的就是它自报的名字 ⇒ 名字一次就对，没有要回填的东西。
      // 立刻打上标记，否则前端的回填器会把这条也当"待改名"，白打一次宿主。
      q.markNameApplied.run(now, now, row.id);
      recordOwnership?.({
        aiUid: botUid, ownerUid: uid, aiName: row.claim_name || null, source: "invite",
      });
      console.log(`[invite] approved id=${row.id} bot=${botUid}`);
      return send(res, 200, { id: row.id, status: "accepted" }), true;
    }

    /*
     * 「重新发凭据」—— 09-10 元知那个死局的**人这一侧的出口**。
     *
     * 前端拿这个人自己的登录态去宿主 `GET /v1/user/bots/:bot_id/token` 把凭据重取一遍
     * （宿主本来就支持：creator 才读得到、还校验这个号在不在当前 Space），
     * 再交到这里重新封进同一张票。**号不重建**——重建会在宿主里留下一个用不上的空号，
     * 还要重新加好友、重新进空间，对面拿到的又是一个新身份。
     *
     * 🔴 后端依旧不接触"能造号的钥匙"（见文件头取舍 1）：这里收到的是**这一个号的
     *    连接凭据**，跟出票时收到的是同一种东西，不是能替他造号的 uk_。
     * 🔴 重封用 code_hash 作料：这一刻服务端手里没有票据原文（库里只有哈希）。
     *    所以取件必须走 materialFor()，别写死。
     */
    if (action === "reissue") {
      if (req.method !== "POST") return send(res, 405, { error: "method not allowed" }), true;
      if (row.status !== "accepted") {
        return send(res, 409, {
          error: `invite is ${row.status}, nothing to re-issue`,
          what_to_do: "只有已经兑换过（accepted）的票才谈得上重发凭据；还没被兑换的票直接让对方兑换即可。",
        }), true;
      }
      let body;
      try {
        body = await readJson(req);
      } catch (e) {
        return send(res, 400, { error: String(e.message || e) }), true;
      }
      const botToken = clip(body.bot_token, 200).trim();
      const botUid = clip(body.bot_uid, 80).trim();
      if (!botToken) return send(res, 400, { error: "bot_token required" }), true;
      // 传了 bot_uid 就要跟票上的对得上 —— 防止把 A 号的凭据封进 B 号的票。
      if (botUid && row.bot_uid && botUid !== row.bot_uid) {
        return send(res, 409, {
          error: "bot_uid mismatch",
          why: `这张票上的号是 ${row.bot_uid}，收到的是 ${botUid}`,
        }), true;
      }
      q.reseal.run(seal(botToken, row.code_hash), botUid || null, now, row.id);
      console.log(`[invite] reissue id=${row.id} bot=${row.bot_uid}`);
      return send(res, 200, {
        id: row.id,
        status: "accepted",
        credential_available: true,
        // 对面要做的事只有一句话，前端照抄给人看，人再转给 AI。
        message: "凭据已重新封进这张票。让对方用**同一个票号**打 POST /invites/pickup 取。",
      }), true;
    }

    /*
     * 名字回填完成回执（苏白 2026-09-02 定的默认路径体验）。
     *
     * 流程：不审批出票 ⇒ 号先用占位名建好 → AI 兑换时自报名字（落 claim_name）
     *      → **前端**在人打开界面时用他的登录态把宿主里那个号改名 → 打这个回执。
     * 后端在这里**只记一个时刻**：它没有能改名的钥匙，也不该有（见文件头取舍 1）。
     * 幂等：重复打只是把时刻覆盖一次，不报错 —— 回执丢包时前端会重试。
     */
    if (action === "name-applied") {
      if (req.method !== "POST") return send(res, 405, { error: "method not allowed" }), true;
      if (row.status !== "accepted" || !row.bot_uid) {
        return send(res, 409, {
          error: `invite is ${row.status}, no bot to rename`,
        }), true;
      }
      q.markNameApplied.run(now, now, row.id);
      return send(res, 200, { id: row.id, name_applied_at: now }), true;
    }

    if (action === "reject") {
      if (req.method !== "POST") return send(res, 405, { error: "method not allowed" }), true;
      if (row.status !== "pending") {
        return send(res, 409, { error: `invite is ${row.status}, nothing to reject` }), true;
      }
      q.setStatus.run("rejected", now, now, row.id);
      // 拒绝也是明确的销毁意图（走审批那条路此刻通常还没有密文，但别依赖"通常"）。
      q.wipeToken.run(now, row.id);
      return send(res, 200, { id: row.id, status: "rejected" }), true;
    }

    // 撤票：还没被兑换的票随时可以作废（凭据也一起抹掉）
    if (!action) {
      if (req.method === "DELETE") {
        q.setStatus.run("revoked", now, now, row.id);
        // 撤票是**明确的销毁意图**，不给宽限窗口。
        q.wipeToken.run(now, row.id);
        return send(res, 200, { id: row.id, status: "revoked" }), true;
      }
      if (req.method === "GET") {
        const { sealed_token, code_hash, ...safe } = row;
        return send(res, 200, {
          ...safe,
          require_approval: !!row.require_approval,
          credential_pending: !!sealed_token,
          // 密文还在 ＝ 这张票现在还能把凭据取回来（重发按钮据此决定要不要出现）
          credential_available: !!sealed_token,
          recoverable_until: sealed_token && row.delivered_at
            ? row.delivered_at + GRACE : null,
        }), true;
      }
      return send(res, 405, { error: "method not allowed" }), true;
    }

    return send(res, 404, { error: "not found" }), true;
  }

  return { handle, handlePublic, letter, _internals: { seal, unseal, hashCode, newCode } };
}
