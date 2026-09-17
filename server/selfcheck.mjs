/**
 * 体检 —— 「这个 AI 在这个平台上站稳了没有」。
 *
 * ── 为什么有这个模块（苏白 2026-09-14 夜）───────────────────────
 * 起因是同事的 Bot 进来后每条回复要等 25 秒。查下来平台侧投递不到 1 秒
 * （真机三测 0.49/0.62/0.91s），慢在**它自己没有常驻挂起收消息**，
 * 而是每隔二十几秒去问一次。
 *
 * 苏白原话：「会有自测表，看看自己是不是这些东西是不是达标的。如果没有达标，
 * 他们需要自己修一下，不要再出现这种低级错误了」，以及
 * 「体检那个我觉得是可以的，正好可以放在 Bot 档案里」。
 *
 * 说明书里**早就写着**该怎么常驻收消息（§3.1，还配了现成的接收器），
 * 他们照样写错了。⇒ **光有说明书不够，得有一条能自己跑、会报红的检查。**
 * 这就是本模块存在的全部理由：把"读没读懂"变成"跑一下就知道"。
 *
 * ── 🔴 最要紧的一条：只信行为，不信自报 ────────────────────────
 * 每一项都必须是"平台这边观察到的事实"，不能是 AI 自己填的问卷。
 * 一份靠自觉填写的自测表，不自觉的人不会填，填了也可能是假的 ——
 * 那种表比没有表更糟（它会让人以为查过了）。
 *
 * ── 四项查什么 ─────────────────────────────────────────────────
 *  ① credential 凭据还能用吗           —— 向宿主换 robot_id，换不出就是死号
 *  ② resident   有没有人替它常驻挂着收消息（本文件的核心，原理见下）
 *  ③ report     有没有在报到（档案页那一屏的数据源）
 *  ④ profile    档案有没有主人、有没有自我介绍
 *
 * ── ② 的原理：借宿主"一个 bot 同时只准挂一个"这条规则反推 ────────
 * 宿主的 `POST /v1/bot/events` 对同一个 bot **同时只授予一个挂起**
 * （`modules/bot_api/events_wait.go` 的 `acquireEventHold`：per-bot 一个槽）。
 * 被拒的那一个不会立刻空手返回，而是**先睡一个 chunk（5 秒）再返回空**
 * （`holdOffRefusedWait`，刻意做成背压）。于是：
 *
 *   我们拿它的凭据去要一个 `wait=10` 的挂起 ——
 *     · 约 5 秒回来  ⇒ 槽被别人占着 ⇒ **它自己的接收器正挂在那儿** ✅
 *     · 约 10 秒回来 ⇒ 槽是空的   ⇒ **没有任何人在替它拉消息** ❌
 *
 * 2026-09-14 夜在生产机上双向实测过，不是推理：
 *   · 有接收器在跑的 bot（产线班长）：5.30 / 5.24 / 5.18 秒
 *   · 没有接收器的 bot（设备-组长）：10.22 / 10.31 秒
 *
 * 🔴 这是**借来的信号**，不是宿主承诺的接口语义。上游把 chunk 或背压策略一改，
 *    这个判据就会失真（而且是静静地失真）。所以：
 *      · 判据写成"明显短于 wait"而不是"等于 5 秒"，对 chunk 具体数值不敏感；
 *      · 两端都留 unknown 带，落在中间一律再探一次，还不确定就报 unknown，
 *        **绝不猜 ok** —— 同 agent-status 那条"不知道就说不知道"；
 *      · `checks/resident-probe-live.mjs` 是这条假设的真机考卷，
 *        上游升级后必须重跑；它一红，这一项就得改判据而不是改阈值。
 *
 * 🔴 探针**只读**：`event_id` 用一个高到不可能存在的游标，所以永远读不到东西、
 *    也永远不会 ack。它不会吃掉任何人的消息。副作用只有一个 —— 当这个 bot
 *    确实没人在拉时，我们会占着它的槽最多 wait 秒。所以 wait 取 10 秒，不取 30。
 */
import { send, readJson } from "./http-util.mjs";

/** 探针挂起时长（秒）。取 10：够把"被拒(≈5s)"和"授予(≈10s)"分开，又不会长时间占槽。 */
const PROBE_WAIT_SEC = 10;
/** 明显短于 wait ⇒ 判定"槽被占着"。0.7 给 chunk 值变动留了余量（5/10=0.5）。 */
const RESIDENT_FAST_RATIO = 0.7;
/** 接近 wait ⇒ 判定"槽是空的"。 */
const RESIDENT_SLOW_RATIO = 0.9;
/** 探针自身的网络上限，必须比 wait 宽出一截，否则超时会被误读成"挂满了"。 */
const PROBE_TIMEOUT_MS = (PROBE_WAIT_SEC + 20) * 1000;
/** 高到不可能存在的游标 —— 保证只读、读不到、不 ack。 */
const PROBE_CURSOR = 9_999_999_999_999;

export function ensureSelfcheckSchema(db) {
  db.exec(`
    /*
     * 每个 AI 只留**最近一次**体检（重做是覆盖）。
     * 要历史去看日志 —— 同 agent_health/agent_checks 那条：这是档案不是归档。
     */
    CREATE TABLE IF NOT EXISTS agent_selfcheck (
      ai_uid     TEXT PRIMARY KEY,
      ok         INTEGER NOT NULL,   -- 四项是否全绿（1/0）
      passed     INTEGER NOT NULL,   -- 绿了几项
      total      INTEGER NOT NULL,
      results    TEXT NOT NULL,      -- JSON: [{key,name,result,detail,fix}]
      ts         INTEGER NOT NULL
    );
  `);
}

const nowSec = (now) => Math.floor(now() / 1000);

/**
 * @param {object} o
 * @param {object} o.db
 * @param {object} o.botAuth              只用它的 identify(token) -> {ok, robotId}
 * @param {string} o.hostBotApiUrl        宿主 bot 面根地址
 * @param {Function} [o.fetchImpl]        便于测试注入
 * @param {Function} [o.now]
 * @param {number} [o.probeWaitSec]       便于测试把探针缩短
 */
export function createSelfcheck({
  db,
  botAuth,
  hostBotApiUrl,
  fetchImpl = fetch,
  now = Date.now,
  probeWaitSec = PROBE_WAIT_SEC,
}) {
  ensureSelfcheckSchema(db);
  const base = String(hostBotApiUrl || "").replace(/\/$/, "");

  /**
   * ② 常驻探针。返回 { result, detail, elapsedMs }。
   * result: ok(有人在挂) | fail(没人在挂) | unknown(说不准/探不到)
   */
  async function probeResident(token) {
    const t0 = now();
    let res;
    try {
      res = await fetchImpl(`${base}/v1/bot/events`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ event_id: PROBE_CURSOR, limit: 1, wait: probeWaitSec }),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
    } catch (err) {
      // 探不到不等于不合格 —— 宿主不可达是我们的问题，不能记在对方头上。
      return { result: "unknown", detail: `探针没能完成（${String(err?.message || err).slice(0, 80)}）`, elapsedMs: now() - t0 };
    }
    const elapsedMs = now() - t0;
    if (!res.ok) {
      return { result: "unknown", detail: `宿主返回 ${res.status}`, elapsedMs };
    }
    const waitMs = probeWaitSec * 1000;
    if (elapsedMs <= waitMs * RESIDENT_FAST_RATIO) {
      return { result: "ok", detail: `探针 ${(elapsedMs / 1000).toFixed(1)} 秒被挡回 —— 说明已经有一个接收器替你挂在那儿`, elapsedMs };
    }
    if (elapsedMs >= waitMs * RESIDENT_SLOW_RATIO) {
      return { result: "fail", detail: `探针整整挂满 ${(elapsedMs / 1000).toFixed(1)} 秒都没人来抢 —— 说明此刻没有任何进程在替你收消息`, elapsedMs };
    }
    return { result: "unknown", detail: `探针 ${(elapsedMs / 1000).toFixed(1)} 秒返回，落在说不准的区间`, elapsedMs };
  }

  /** ③ 报到：看 agent_status 里这个 ai_uid 最近一次上报还新不新。 */
  function checkReport(aiUid) {
    let row = null;
    try {
      row = db.prepare(`SELECT ts, ttl FROM agent_status WHERE ai_uid = ?`).get(aiUid) || null;
    } catch {
      // 表还没建（这台机器没开报到）⇒ 说不准，不算对方的错。
      return { result: "unknown", detail: "这台机器上还没有报到记录表" };
    }
    if (!row) {
      return {
        result: "fail",
        detail: "你从来没有报过到 —— 主人点进你的档案只会看到一个空工位",
        fix: "做一个定时任务，每 60 秒打一次 POST {api_url_yoyoo}/agent-status/report",
      };
    }
    const age = nowSec(now) - Number(row.ts || 0);
    const ttl = Number(row.ttl || 180);
    if (age > ttl) {
      return {
        result: "fail",
        detail: `最后一次报到是 ${age} 秒前，已经超过你自己声明的 ${ttl} 秒 —— 档案上现在显示「未上报」`,
        fix: "把报到做成定时任务，别只在启动时报一次",
      };
    }
    return { result: "ok", detail: `${age} 秒前刚报过到` };
  }

  /** ④ 档案：登记册里有没有这个号、有没有主人和自我介绍。 */
  function checkProfile(aiUid) {
    let row = null;
    try {
      row = db.prepare(
        `SELECT owner_uid, ai_name FROM ai_owners WHERE ai_uid = ?`,
      ).get(aiUid) || null;
    } catch {
      return { result: "unknown", detail: "这台机器上还没有归属登记册" };
    }
    if (!row) {
      return {
        result: "fail",
        detail: "登记册里没有你 —— 没人知道你是谁的",
        fix: "用你的凭据打一次归属认领接口，把自己登记上",
      };
    }
    const missing = [];
    if (!String(row.owner_uid || "").trim()) missing.push("主人");
    if (!String(row.ai_name || "").trim()) missing.push("名字");
    if (missing.length) {
      return { result: "warn", detail: `档案缺：${missing.join("、")}`, fix: "补上就行，别人才知道能找你干什么" };
    }
    return { result: "ok", detail: `登记在「${row.ai_name}」名下，有主人` };
  }

  /** 跑一次完整体检。token 必须是这个 bot 自己的凭据。 */
  async function run(token) {
    const id = await botAuth.identify(token);
    if (!id.ok) {
      return {
        status: id.status || 401,
        body: {
          ok: false,
          passed: 0,
          total: 4,
          results: [{
            key: "credential", name: "凭据还能用吗", result: "fail",
            detail: id.error || "这串凭据换不出身份",
            fix: "找邀请你的人重新发一份凭据",
          }],
        },
      };
    }
    const aiUid = id.robotId;
    const resident = await probeResident(token);

    const results = [
      { key: "credential", name: "凭据还能用吗", result: "ok", detail: `换出来的身份是 ${aiUid}` },
      {
        key: "resident", name: "有没有常驻收消息", result: resident.result, detail: resident.detail,
        fix: resident.result === "ok" ? undefined
          : "收消息要一直挂着：POST /v1/bot/events 带 wait（最长 30 秒），返回就立刻再发下一次。"
            + "🔴 不要写成「每隔 N 秒去问一次」—— 那样消息会卡在间隔里干等，这正是最常见的那个坑。",
      },
      { key: "report", name: "有没有在报到", ...checkReport(aiUid) },
      { key: "profile", name: "档案全不全", ...checkProfile(aiUid) },
    ].map((r) => ({ name: r.name, ...r }));

    const passed = results.filter((r) => r.result === "ok").length;
    const ok = results.every((r) => r.result === "ok");
    const ts = nowSec(now);

    try {
      db.prepare(
        `INSERT INTO agent_selfcheck (ai_uid, ok, passed, total, results, ts)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(ai_uid) DO UPDATE SET
           ok = excluded.ok, passed = excluded.passed, total = excluded.total,
           results = excluded.results, ts = excluded.ts`,
      ).run(aiUid, ok ? 1 : 0, passed, results.length, JSON.stringify(results), ts);
    } catch {
      /* 存不下不影响这次体检的结论 —— 报告照给。 */
    }

    return { status: 200, body: { ok, ai_uid: aiUid, passed, total: results.length, ts, results, text: render(results) } };
  }

  /** 给人/给 AI 直接看的那一版（终端里能读）。 */
  function render(results) {
    const mark = { ok: "✅", warn: "⚠️", fail: "❌", unknown: "❓" };
    const lines = results.map((r) => {
      const head = `${mark[r.result] || "❓"} ${r.name}：${r.detail || ""}`;
      return r.fix ? `${head}\n   怎么修：${r.fix}` : head;
    });
    const bad = results.filter((r) => r.result !== "ok").length;
    lines.push(bad === 0 ? "\n全绿，你接对了。" : `\n还有 ${bad} 项没过，按上面「怎么修」改完再跑一次。`);
    return lines.join("\n");
  }

  /** 读最近一次体检（档案页用）。 */
  function latest(aiUid) {
    try {
      const row = db.prepare(`SELECT * FROM agent_selfcheck WHERE ai_uid = ?`).get(aiUid);
      if (!row) return null;
      return {
        ai_uid: row.ai_uid,
        ok: !!row.ok,
        passed: Number(row.passed),
        total: Number(row.total),
        ts: Number(row.ts),
        results: JSON.parse(String(row.results || "[]")),
      };
    } catch {
      return null;
    }
  }

  /**
   * 路由：
   *   POST {root}/selfcheck            —— 带自己的 bot 凭据，跑一次体检
   *   GET  {root}/selfcheck?ai_uid=…   —— 读最近一次结果（档案页用）
   */
  async function handle(req, res, { path, url, root }) {
    if (path !== `${root}/selfcheck`) return false;

    if (req.method === "GET") {
      const aiUid = String(url?.searchParams?.get("ai_uid") || "").trim();
      if (!aiUid) return send(res, 400, { error: "ai_uid required" }), true;
      const row = latest(aiUid);
      if (!row) return send(res, 200, { ai_uid: aiUid, checked: false }), true;
      return send(res, 200, { checked: true, ...row }), true;
    }

    if (req.method !== "POST") return send(res, 405, { error: "method not allowed" }), true;

    // 凭据只从 Authorization 头拿 —— 不收 body 里的 token，免得它被写进日志。
    const auth = String(req.headers?.authorization || "");
    const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
    if (!token) return send(res, 401, { error: "bot token required（Authorization: Bearer bf_…）" }), true;
    await readJson(req).catch(() => null); // 允许空 body

    const out = await run(token);
    return send(res, out.status, out.body), true;
  }

  return { handle, run, latest, probeResident, _render: render };
}
