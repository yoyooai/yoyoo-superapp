/**
 * 「用多少算多少」—— 用量与额度。
 *
 * ── 为什么是这一件（苏白 2026-09-14）─────────────────────────────
 * 09-14 他先定「只做用量与额度，其余先不管」，当晚改口「我觉得都搞过来吧」。
 * 这一块是四块里最先做的，因为它是另外三块的地基：
 * 没有"这个人用了多少"，卖套餐就是卖一张空头支票 —— 买完谁也说不清买到了什么。
 *
 * ── 🔴 这一层最要紧的一条规矩：只数真数得到的 ────────────────────
 * 平台**量不到 token**。AI 跑在它自己的机器上，调的是别处的大脑网关，
 * 那一笔笔账记在网关那边，压根不经过这里。
 * 所以这一版**不折算、不估算、不按条数乘一个系数假装是 token**——
 * 数不到的东西一律进 unmetered 名单，界面照实说"这一项我们这边数不到"。
 * 这不是偷懒：一个编出来的用量数字，会被人拿去对账、拿去付钱、拿去吵架。
 * 宁可少一栏，不要一栏假的。（同"没探过活不许说在线"那条底线。）
 *
 * ── 归属认哪张表 ───────────────────────────────────────────────
 * 只认 ai_owners。channel_records 里也有一列 owner_uid，但那是**回传方自报**的，
 * 谁回传谁说了算（见 ai-owners.mjs 文件头）。拿自报字段算账，
 * 等于让被计费的一方自己填账单。
 *
 * ── 额度从哪来 / 超了会怎样 ────────────────────────────────────
 * 额度只有一个真源：已开通权益（entitlements.quota_json），而权益只能由付过的订单开出来
 * （见 commerce.mjs）。**没有买过套餐的人没有额度上限** —— 这是现状，不是我新加的宽松：
 * 平台今天本来就不限，凭空给所有人加一道墙会把现在正常用的人一起拦住。
 * 有额度的人才拦，且只拦"再开一台新 AI"这一个动作（invite 出票口）。
 * 已经在跑的 AI 不会因为超额被掐断 —— 掐断正在干活的 AI 是一种对用户的破坏，
 * 不能由一条计数规则自动做出这种决定。
 */
/* ⚠️ 本文件有模板字符串 SQL —— 注释里一律不许出现反引号（同 commerce.mjs / theme.tsx）。 */
import { send } from "./http-util.mjs";

/**
 * 🔴 按北京时间切月，不用服务器本地时区。
 *    容器里 TZ 常常是 UTC，靠 new Date() 的本地月份会让"这个月"在每月 1 号
 *    凌晨 0~8 点整整错一个月 —— 而这正是有人会来对账的时刻。
 */
const TZ_OFFSET_SEC = 8 * 3600;

/** 秒级时间戳 → "YYYY-MM"（北京时间）。 */
export function monthKeyOf(tsSec) {
  const d = new Date((tsSec + TZ_OFFSET_SEC) * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** "YYYY-MM" → [起, 止)，秒级，北京时间的月初到下月初。 */
export function monthRange(key) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(key || ""));
  if (!m) return null;
  const y = Number(m[1]); const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  const start = Date.UTC(y, mo - 1, 1) / 1000 - TZ_OFFSET_SEC;
  const end = Date.UTC(mo === 12 ? y + 1 : y, mo === 12 ? 0 : mo, 1) / 1000 - TZ_OFFSET_SEC;
  return [start, end];
}

/**
 * 这一版**数得到**的项。key 要和 quota_json 里的键名对得上，
 * 否则买到的额度和量到的用量各说各话。
 */
const METERED = [
  { key: "agents", label: "AI 台数", unit: "台", kind: "now" },
  { key: "messages", label: "消息条数", unit: "条", kind: "month" },
];

/**
 * 🔴 数不到的项要**点名写在这里**，而不是从界面上悄悄消失。
 *    消失了，人只会以为"我没用"；写出来，人才知道"这里还没有尺子"。
 */
const UNMETERED = [
  {
    key: "tokens",
    label: "大脑用量（token）",
    why: "AI 在它自己的机器上调大脑，这笔账记在大脑网关那边，不经过这个平台。我们这边没有计量点，所以不给数字，也不拿条数折算。",
  },
  {
    key: "storage",
    label: "占了多少存储",
    why: "文件存在各自的机器上，平台只留了索引，量不到真实占用。",
  },
];

const isPosInt = (v) => Number.isInteger(v) && v > 0;

export function createUsage({ db, now = Date.now }) {
  const nowSec = () => Math.floor(now() / 1000);

  const q = {
    myAis: db.prepare(`SELECT ai_uid, ai_name FROM ai_owners WHERE owner_uid = ? ORDER BY created_at`),
    countAis: db.prepare(`SELECT COUNT(*) AS n FROM ai_owners WHERE owner_uid = ?`),
    activeEnt: db.prepare(`
      SELECT quota_json, end_at FROM entitlements
       WHERE uid = ? AND state = 'active'`),
  };

  /** 名下每台 AI 的 uid。空数组要单独处理：IN () 是语法错。 */
  const myAiUids = (uid) => q.myAis.all(uid).map((r) => r.ai_uid);

  /**
   * 我现在手上的额度 —— 把所有还有效的权益**加起来**。
   * 🔴 买两份就是两份：同一个人买了两个套餐，额度相加而不是取最大值，
   *    否则第二笔钱等于白付。
   */
  function quotaFor(uid) {
    const ts = nowSec();
    const out = {};
    for (const row of q.activeEnt.all(uid)) {
      if (row.end_at && row.end_at < ts) continue;  // 过期压过 state（同 commerce 那条）
      let obj;
      try { obj = JSON.parse(row.quota_json || "{}"); } catch { obj = null; }
      if (!obj || typeof obj !== "object") continue;
      for (const [k, v] of Object.entries(obj)) {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) continue;
        out[k] = (out[k] || 0) + Math.floor(n);
      }
    }
    return out;
  }

  /** 这个月这些 AI 一共收发了多少条。归属只认 ai_owners（见文件头）。 */
  function messageCounts(aiUids, from, to) {
    const base = { in: 0, out: 0, total: 0 };
    if (!aiUids.length) return base;
    const holes = aiUids.map(() => "?").join(",");
    const rows = db.prepare(`
      SELECT direction, COUNT(*) AS n FROM channel_records
       WHERE ai_uid IN (${holes}) AND ts >= ? AND ts < ?
       GROUP BY direction`).all(...aiUids, from, to);
    for (const r of rows) {
      if (r.direction === "in") base.in = r.n;
      else if (r.direction === "out") base.out = r.n;
    }
    base.total = base.in + base.out;
    return base;
  }

  /** 每台 AI 一行。界面按"一块一张卡"画。 */
  function perAi(uid, from, to) {
    const ais = q.myAis.all(uid);
    if (!ais.length) return [];
    const holes = ais.map(() => "?").join(",");
    const rows = db.prepare(`
      SELECT ai_uid, direction, COUNT(*) AS n FROM channel_records
       WHERE ai_uid IN (${holes}) AND ts >= ? AND ts < ?
       GROUP BY ai_uid, direction`).all(...ais.map((a) => a.ai_uid), from, to);
    const byUid = new Map();
    for (const r of rows) {
      const cur = byUid.get(r.ai_uid) || { in: 0, out: 0 };
      if (r.direction === "in") cur.in = r.n; else if (r.direction === "out") cur.out = r.n;
      byUid.set(r.ai_uid, cur);
    }
    return ais.map((a) => {
      const c = byUid.get(a.ai_uid) || { in: 0, out: 0 };
      return {
        ai_uid: a.ai_uid,
        ai_name: a.ai_name || a.ai_uid,   // 🔴 取不到名字就显示 uid，不编一个好看的
        messages_in: c.in, messages_out: c.out, messages: c.in + c.out,
        /* 一条都没有的时候要照实说"这个月它没动静"，而不是画个 0 让人以为坏了。 */
        idle: c.in + c.out === 0,
      };
    }).sort((a, b) => b.messages - a.messages);
  }

  /** 有数据的月份，给界面做月份选择用（永远含当月，哪怕当月是空的）。 */
  function monthsWithData(uid) {
    const aiUids = myAiUids(uid);
    const cur = monthKeyOf(nowSec());
    if (!aiUids.length) return [cur];
    const holes = aiUids.map(() => "?").join(",");
    const rows = db.prepare(`
      SELECT MIN(ts) AS lo, MAX(ts) AS hi FROM channel_records WHERE ai_uid IN (${holes})`)
      .all(...aiUids);
    const lo = rows?.[0]?.lo; const hi = rows?.[0]?.hi;
    if (!lo || !hi) return [cur];
    const out = new Set([cur]);
    /* 从最早一条走到最晚一条，逐月列出来。上限 36 个月，防止一条脏数据
       （比如 ts 写成了 1970）把这个列表撑成几千项。 */
    let k = monthKeyOf(lo);
    for (let i = 0; i < 36; i++) {
      out.add(k);
      if (k === monthKeyOf(hi)) break;
      const [y, m] = k.split("-").map(Number);
      k = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
    }
    return [...out].sort().reverse();
  }

  /**
   * 总账。
   * 🔴 返回里同时给 quota 和 has_quota：界面不许把"没有额度上限"画成"额度 0"，
   *    那会让一个正常能用的人以为自己被停了。
   */
  function summary(uid, monthKey) {
    const key = monthRange(monthKey) ? monthKey : monthKeyOf(nowSec());
    const [from, to] = monthRange(key);
    const aiUids = myAiUids(uid);
    const msg = messageCounts(aiUids, from, to);
    const quota = quotaFor(uid);
    const agents = q.countAis.get(uid)?.n || 0;

    const used = { agents, messages: msg.total, messages_in: msg.in, messages_out: msg.out };
    const items = METERED.map((m) => {
      const limit = isPosInt(quota[m.key]) ? quota[m.key] : null;
      const u = used[m.key] || 0;
      return {
        key: m.key, label: m.label, unit: m.unit, kind: m.kind,
        used: u,
        limit,                                   // null = 这一项没有额度上限
        left: limit == null ? null : Math.max(limit - u, 0),
        over: limit != null && u > limit,
        /* 百分比只在真有上限时给；没有上限时给 null，别让界面画一根永远 0% 的条 */
        percent: limit == null || limit === 0 ? null : Math.min(Math.round((u / limit) * 100), 999),
      };
    });

    return {
      month: key,
      months: monthsWithData(uid),
      has_quota: Object.keys(quota).length > 0,
      /* 🔴 这句话由服务端给，界面照抄，不许自己改软（同 commerce 的 can_pay/why）。 */
      why_no_quota: Object.keys(quota).length > 0 ? null
        : "你还没有开通任何套餐。现在不限量 —— 也就是说这些用量没有任何保障，平台随时可能收紧。",
      items,
      unmetered: UNMETERED,
      counted_ai: aiUids.length,
      /* 数的是哪些 AI、按什么算的，摆在明处让人能核。 */
      how: "只数登记在你名下的 AI（归属表），按北京时间切月；一条消息不分长短都算一条。",
      /* 界面要能当面说"你还能再开几台"，而不是等人点下去才告诉他不行。 */
      can_add_ai: agentQuotaGate({ uid }),
    };
  }

  /**
   * 再开一台新 AI 之前问一句：额度还够吗。
   * 🔴 没有额度的人一律放行（见文件头）。这不是后门 —— 这是"平台本来就不限"的事实，
   *    而不是绕过某个限制。有额度的人则真拦，拦的理由说人话。
   */
  function agentQuotaGate({ uid }) {
    const quota = quotaFor(uid);
    const limit = isPosInt(quota.agents) ? quota.agents : null;
    const used = q.countAis.get(uid)?.n || 0;
    if (limit == null) return { allowed: true, limit: null, used };
    if (used >= limit) {
      return {
        allowed: false, limit, used,
        reason: `你名下已经有 ${used} 台 AI，已开通的套餐一共给 ${limit} 台。要再开一台，先去「套餐」加一份。`,
      };
    }
    return { allowed: true, limit, used };
  }

  async function handle(req, res, { path, url, uid, root }) {
    const base = `${root}/usage`;
    if (path !== base && !path.startsWith(`${base}/`)) return false;
    const rest = path.slice(base.length).replace(/^\//, "");
    if (req.method !== "GET") { send(res, 405, { error: "method not allowed" }); return true; }

    const month = url?.searchParams?.get("month") || "";

    if (rest === "summary" || rest === "") {
      send(res, 200, summary(uid, month));
      return true;
    }
    /*
     * 「我还能不能再开一台」—— 界面在**动手建号之前**问这一句。
     * 🔴 为什么必须有这条独立的路：不审批那条路是**前端先在宿主里把号建出来**、
     *    再回来出票。等到出票口才拦，号已经建在宿主里了 —— 拦下来只会留下一个
     *    没人认领的孤儿号。所以拦要拦在动手之前；出票口那道闸是兜底，不是唯一的闸。
     */
    if (rest === "can-add-ai") {
      const g = agentQuotaGate({ uid });
      send(res, 200, {
        allowed: g.allowed, limit: g.limit ?? null, used: g.used,
        reason: g.reason || null,
      });
      return true;
    }

    if (rest === "by-ai") {
      const key = monthRange(month) ? month : monthKeyOf(nowSec());
      const [from, to] = monthRange(key);
      send(res, 200, { month: key, rows: perAi(uid, from, to) });
      return true;
    }
    send(res, 404, { error: "not found" });
    return true;
  }

  return { handle, summary, perAi, quotaFor, agentQuotaGate, monthsWithData };
}
