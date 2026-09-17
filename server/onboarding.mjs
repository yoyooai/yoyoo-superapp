/**
 * 「上岗」—— 一台 AI 从"有个号"到"真能干活"，中间断在哪一节。
 *
 * ── 为什么有这个模块（苏白 2026-09-14）────────────────────────────
 * 原话要的是「买了就直接给一台能用的 AI」。今天的事实是：**在册 44 台、真正活着 7 台。**
 * 剩下那 37 台不是坏了，是**建出来之后没人把它接上**，而且卡在哪一节谁都看不见 ——
 * 界面上它和活着的那 7 台长得一模一样，只是永远不说话。
 *
 * 所以这一层要修的不是"怎么造号"（invite.mjs 已经很干净），
 * 是**"造完之后那段没人管的路"**：
 *
 *     有号了 ──► 钥匙到手 ──► 连上来过 ──► 还在报
 *       ①           ②            ③           ④
 *
 * 每一台 AI 此刻停在第几关、为什么停、**下一步该点哪个按钮**，就是这个模块的全部输出。
 *
 * ── 三件刻意的取舍（别改回去）──────────────────────────────────
 *
 *  1. **不新造一张表。** 四关的判据全部来自已有的事实：
 *     登记册（谁的号）、票据账本（钥匙交付到哪一步）、状态上报（报没报过、这会儿还在不在）。
 *     🔴 上岗进度是**算出来的**，不是又一处需要有人去维护的状态 ——
 *     多一张表就多一处会和事实对不上的地方，而这一屏存在的意义正是"说真话"。
 *
 *  2. **不画"一键部署"。** 平台没有对方那台机器的控制通道（同 agent_health.actions 那条规矩）。
 *     卡在第③关时我们能给的最大值是**一份照着做就能连上的接入包**，不是替他按下去。
 *     🔴 画一个点不动的"一键启动"比不画更坏：他会以为点了就行，然后继续等一台永远不来的 AI。
 *
 *  3. **接入包里不含凭据。** 和 invite.mjs 第 3 条同源：接入包是要被复制进聊天/文档的东西。
 *     凭据只在票据兑换那一次交付。这里只给"往哪报、报什么、怎么验证成功"。
 *
 * ── 一个诚实的边界 ────────────────────────────────────────────
 * 第④关判定过期用的是**和状态口完全同一条规矩**（`ts + ttl < now`）。
 * 不允许这一屏自己定义一套"多久算掉线"—— 两处口径不一样，人只会更糊涂。
 */
import { send, clip } from "./http-util.mjs";

/** 和 agent-status.mjs 的 DEFAULT_TTL 对齐：上报没说多久算过期时按这个算。 */
const FALLBACK_TTL = 180;

/**
 * 多久以前，说人话。
 * 🔴 不要一路用分钟：「682 分钟前」人得自己去除以 60，
 *    而这一屏存在的意义正是"不用想，照着看"。
 */
function ago(sec) {
  if (sec < 60) return "不到一分钟";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr} 小时`;
  return `${Math.floor(hr / 24)} 天`;
}

/**
 * 四关。`key` 进接口，`title` 直接上界面 —— 界面不许自己另起一套叫法，
 * 否则出问题时人说的关口名和日志里的对不上。
 */
export const GATES = [
  { key: "account",   title: "有号了",   why: "这个号建出来了，并且记在你名下。" },
  { key: "credential", title: "钥匙到手", why: "能连进来的那串凭据已经交到它手上。" },
  { key: "first_report", title: "连上来过", why: "它自己连上来报过一次到。" },
  /*
   * 🔴 U7（09-15 体检）：这一关原来叫「现在在线」。卡在这一关时格子描红，
   *    于是红色那颗上写着"在线"—— 读起来像"在线告警"，意思正好反了。
   *    四关是**里程碑**，名字要能在"没到"的状态下也读得通：
   *    有号了 / 钥匙到手 / 连上来过 / 还在报 —— 红色那颗写「还在报」，
   *    一眼就是"还没做到这一步"。
   */
  { key: "online",    title: "还在报",   why: "最近一次报到还没过期。" },
];

export function createOnboarding({ db, owners, apiBase = "", now = Date.now }) {
  const nowSec = () => Math.floor(now() / 1000);

  /** 表可能还没建（全新库、或某个模块没装）——查不到就当没有，不要炸整条读取面。 */
  const has = (t) =>
    !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(t);

  /**
   * 一台 AI 的票据线索。
   * 取**最近一张**：同一个号可能被重发过多次票，只有最后那张说得清现在的状态。
   */
  function inviteOf(aiUid) {
    if (!has("invites")) return null;
    return db.prepare(
      `SELECT id, status, delivered_at, ack_at, sealed_token, expires_at, created_at
         FROM invites WHERE bot_uid = ? ORDER BY created_at DESC LIMIT 1`
    ).get(aiUid) || null;
  }

  function statusOf(aiUid) {
    if (!has("agent_status")) return null;
    return db.prepare(
      `SELECT ts, ttl, status FROM agent_status WHERE ai_uid = ?`).get(aiUid) || null;
  }

  /**
   * 判定一台 AI 走到哪一关。
   *
   * 返回的 `stuck_at` 是**第一个没过的关**；`action` 是针对那一关的下一步。
   * 🔴 一台卡住的 AI 只给**一个**动作。给三个按钮＝等于没给 ——
   *    这一屏的用处就是"不用想，照着点"。
   */
  function assess(row) {
    const aiUid = row.ai_uid;
    const inv = inviteOf(aiUid);
    const st = statusOf(aiUid);
    const t = nowSec();

    const passed = [];
    const push = (key, note) => passed.push({ key, note: note || null });

    // ① 有号了 —— 能出现在名册里，这一关就是过的（名册只收可核验的登记）。
    push("account", row.source === "invite" ? "邀请建号" :
                    row.source === "claim"  ? "你认领的" : "回传登记");

    /*
     * ② 钥匙到手。
     * 🔴 这里有一种**长得像成功、其实是死局**的状态，必须单独认出来：
     *    票被兑换了（号也建好了），但凭据既没被确认收到、现在也取不回来了
     *    —— 09-10 元知就是这么卡死的（见 invite.mjs 的 DEFAULT_GRACE_MS 注释）。
     *    它在旧界面上和成功的票一模一样，只能等对方来告状。
     */
    let credOk = false, credNote = null, stuckReason = null, action = null;
    if (!inv) {
      // 没有票据线索：认领进来的号本来就得出示过凭据，回传进来的号能报上来也说明有。
      credOk = true;
      credNote = row.source === "claim" ? "认领时已验过凭据" : "无票据记录（非邀请建号）";
    } else if (inv.ack_at) {
      credOk = true; credNote = "对方已确认收到";
    } else if (inv.delivered_at && inv.sealed_token) {
      credOk = true; credNote = "已交付，对方还没确认收到";
    } else if (inv.delivered_at && !inv.sealed_token) {
      credOk = true; credNote = "已交付并已销毁（正常）";
    } else if (inv.status === "accepted" && !inv.delivered_at) {
      credOk = false;
      stuckReason = "票据被兑换了，但凭据没送到它手上——它现在没有能连进来的钥匙。";
      action = { key: "reissue_invite", title: "重发一张邀请", invite_id: inv.id };
    } else if (inv.status === "open") {
      credOk = false;
      const expired = inv.expires_at && inv.expires_at < t;
      stuckReason = expired
        ? "邀请过期了，对方没来得及兑换。"
        : "邀请发出去了，对方还没来兑换。";
      action = expired
        ? { key: "reissue_invite", title: "重发一张邀请", invite_id: inv.id }
        : { key: "wait_redeem", title: "看这张邀请", invite_id: inv.id };
    } else if (inv.status === "pending") {
      credOk = false;
      stuckReason = "对方来兑换了，在等你点头。";
      action = { key: "review_invite", title: "去处理这张邀请", invite_id: inv.id };
    } else {
      credOk = false;
      stuckReason = `这张邀请是「${inv.status}」状态，它拿不到钥匙。`;
      action = { key: "reissue_invite", title: "重发一张邀请", invite_id: inv.id };
    }
    if (credOk) push("credential", credNote);

    // ③ 连上来过 —— 只认"有没有报过一次"，不看报的是什么。
    const everReported = !!(st && st.ts);
    if (credOk) {
      if (everReported) push("first_report", null);
      else {
        stuckReason = "钥匙它有了，但从来没连上来过——那台机器上多半还没把它跑起来。";
        action = { key: "setup_guide", title: "拿接入包", ai_uid: aiUid };
      }
    }

    // ④ 还在报 —— 和状态口同一条规矩：ts + ttl < now 就是过期。
    let online = false;
    if (credOk && everReported) {
      const ttl = st.ttl || FALLBACK_TTL;
      online = st.ts + ttl >= t;
      if (online) push("online", null);
      else {
        stuckReason = `连上来过，但最近一次报到已经是 ${ago(t - st.ts)}前了。`;
        action = { key: "open_health", title: "看它怎么了", ai_uid: aiUid };
      }
    }

    const stage = passed.length;
    const stuckAt = stage >= GATES.length ? null : GATES[stage].key;
    return {
      ai_uid: aiUid,
      ai_name: row.ai_name || null,
      source: row.source,
      since: row.created_at || null,
      stage,                       // 过了几关（0~4）
      total_gates: GATES.length,
      passed,                      // 过了的关 + 各自一句备注
      stuck_at: stuckAt,           // 卡在哪一关的 key；null = 一路通到在线
      why: stuckReason,            // 人话：为什么停在这
      action,                      // 下一步能点的那**一个**动作；在线的没有
      online,
      last_report: st?.ts || null,
      reported_status: everReported ? st.status : null,
    };
  }

  /**
   * 接入包 —— 卡在第③关时给的东西。
   *
   * 🔴 里面**没有凭据**，只有"往哪报、报什么、怎么确认成功"。
   *    凭据是它自己那边已经有的（第②关过了才会走到这一步）。
   * 🔴 这段是**小A 自己在跑的那套**的简化版，不是照着文档编的示例 ——
   *    能不能跑通，我们这边每天都在验。
   */
  function setupKit(aiUid) {
    const base = apiBase || "<本站地址>/eryuan/v1";
    return {
      ai_uid: aiUid,
      report_url: `${base}/agent-status/report`,
      inbox_url: `${base}/agent-status/inbox`,
      auth: "Authorization: Bearer <这个号的连接凭据>",
      how: [
        "在跑这台 AI 的那台机器上，让它每分钟往 report_url 发一次 POST。",
        "身份不用自报——带上它自己的连接凭据，我们去问宿主你是谁。",
        "报到之后这一屏会变成「还在报」，不用回来点任何按钮。",
      ],
      min_body: { status: "idle", activity: "待命", ttl: 180 },
      sample: [
        `curl -sS -X POST "${base}/agent-status/report" \\`,
        `  -H "Authorization: Bearer $BOT_TOKEN" \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -d '{"status":"idle","activity":"待命","ttl":180}'`,
      ].join("\n"),
      verify: "返回 200 就算连上了；401 是凭据不对，503 是这台服务端没开上报口。",
    };
  }

  /** 用户面读取口。只看自己名下的 AI —— 范围直接取自登记册，不另算一套。 */
  async function handle(req, res, { path, url, uid, root }) {
    const base = `${root}/onboarding`;
    if (path !== base && !path.startsWith(`${base}/`)) return false;
    if (req.method !== "GET") {
      send(res, 405, { error: "method not allowed" });
      return true;
    }

    const roster = owners.listOf(uid);

    if (path === `${base}/setup`) {
      const asked = clip(url?.searchParams?.get("ai_uid"), 80).trim();
      if (!asked) {
        send(res, 400, { error: "ai_uid required" });
        return true;
      }
      // 🔴 只能拿自己名下那台的接入包：接入包本身不含凭据，但它泄露"谁有哪台 AI"。
      if (!roster.some((r) => r.ai_uid === asked)) {
        send(res, 403, { error: "not your agent" });
        return true;
      }
      send(res, 200, setupKit(asked));
      return true;
    }

    if (path === base || path === `${base}/`) {
      const agents = roster.map(assess);
      /*
       * 汇总。🔴 `never_connected` 单独给一个数，不和"掉线"合并 ——
       *    前者是"从来没接上"（37 台断的就是这一环），后者是"接上过又断了"，
       *    两者要做的事完全不同：一个是去接，一个是去查。
       */
      const summary = {
        total: agents.length,
        online: agents.filter((a) => a.online).length,
        never_connected: agents.filter((a) => a.stuck_at === "first_report").length,
        no_credential: agents.filter((a) => a.stuck_at === "credential").length,
        offline: agents.filter((a) => a.stuck_at === "online").length,
      };
      // 卡住的排前面：这一屏是拿来干活的，不是拿来欣赏在线数的。
      agents.sort((a, b) => a.stage - b.stage || String(a.ai_name).localeCompare(String(b.ai_name)));
      send(res, 200, { now: nowSec(), gates: GATES, summary, agents });
      return true;
    }

    send(res, 404, { error: "not found" });
    return true;
  }

  return { handle, assess, setupKit, GATES };
}
