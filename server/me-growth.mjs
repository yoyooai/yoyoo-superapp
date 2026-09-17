/**
 * 「我的」这一页背后的三件事：**数字名片 · 成长关系 · 新手任务**
 * （苏白 09-14 给的 Figma 手机稿 `01 我的 / 内容全览`、`02 Agent / 内容全览`）。
 *
 * ── 一条贯穿全文件的规矩：数字必须能追到事实 ──────────────────────
 * 设计稿上写的是「默契度 78%」「收益 ¥12,560.80」。那是设计稿里的示意值。
 * 这一层**一个都不照抄**：每个数字要么由库里已有的事实算出来、要么就老老实实是 0，
 * 并且把"怎么算的"和"缺哪一块"一起给出去。
 * 理由是苏白 09-14 已经骂过一次的病：看板一屏 14 个数字 13 个是 0，
 * 而更坏的那一版是——13 个 0 被填成了好看的假数。
 * 🔴 所以每个接口都带 `how`（这个数怎么算的）。界面必须把它显示出来
 *    （和中际旭创看板那颗「这个数怎么算的」同一条规矩）。
 *
 * ── 不新造表 ──────────────────────────────────────────────────
 * 同 onboarding.mjs 第 1 条：三件事全部由已有事实算出来 ——
 * 登记册(`ai_owners`) / 状态上报(`agent_status` `agent_events` `agent_memories`
 * `agent_tasks`) / 渠道记录(`channel_records`) / 应用与市场(`apps` `listings`
 * `installs`) / 订单(`orders`)。
 * 多一张表就多一处会和事实对不上的地方，而这三屏存在的意义正是"说真话"。
 *
 * ── 一个诚实的边界（必须照实说出去）──────────────────────────────
 * 默契度只量得到**平台看得见的部分**。一台 AI 在它自己机器上跟你聊了一万句，
 * 只要它没往上报，这里就是 0 分。
 * 🔴 那种情况必须说成「它那边还没往上报」，**不许**说成「你们还不熟」——
 *    把"我们没数据"说成"你做得不够"是最恶劣的一种假话。
 */
import { send, clip } from "./http-util.mjs";

/**
 * 五个阶段，名字直接取自设计稿（`初识 / 了解 / 默契 / 信赖 / 最佳拍档`）。
 * `at` ＝ 进入这一阶段所需的点数。界面不许自己另起一套叫法或另定一套门槛。
 */
export const STAGES = [
  { key: "met",     name: "初识",     at: 0 },
  { key: "know",    name: "了解",     at: 20 },
  { key: "tacit",   name: "默契",     at: 45 },
  { key: "trust",   name: "信赖",     at: 70 },
  { key: "partner", name: "最佳拍档", at: 90 },
];

/**
 * 默契度的五个因子。
 *
 * 每个因子都是"库里数得出来的一件事"，各自封顶 —— 封顶是刻意的：
 * 不封顶的话，一台每分钟上报一次的机器人会靠刷条数变成「最佳拍档」，
 * 而那恰恰不是默契。
 *
 * 🔴 `label` 是给人看的那句话，`how` 是"这个分怎么来的"。两者都要发给界面。
 */
export const FACTORS = [
  { key: "days",     label: "在一起多久",   cap: 20, per: 1,    unit: "天",
    how: "从它记到你名下那天算起，一天 1 分，最多 20 分。" },
  { key: "reports",  label: "它报过多少动静", cap: 25, per: 0.5,  unit: "条",
    how: "它主动上报的每一条动静 0.5 分，最多 25 分。" },
  { key: "memories", label: "它记住了多少",  cap: 20, per: 1,    unit: "条",
    how: "它报上来的每一份记忆 1 分，最多 20 分。" },
  { key: "tasks",    label: "它干完多少活",  cap: 20, per: 2,    unit: "件",
    how: "它报「干完了」的每一件活 2 分，最多 20 分。" },
  { key: "talks",    label: "你们来回多少句", cap: 15, per: 0.25, unit: "句",
    how: "渠道里你和它来回的每一句 0.25 分，最多 15 分。" },
];

/** 满分 100 —— 由封顶之和保证，改了上面的 cap 这里自动跟着变。 */
export const FULL_SCORE = FACTORS.reduce((a, f) => a + f.cap, 0);

/** 分数落在哪个阶段；返回当前阶段和下一阶段（已在顶端时 next 为 null）。 */
export function stageOf(score) {
  let i = 0;
  for (let k = 0; k < STAGES.length; k++) if (score >= STAGES[k].at) i = k;
  return { stage: STAGES[i], next: STAGES[i + 1] || null, index: i };
}

export function createMeGrowth({ db, owners, spaceId = "", now = Date.now }) {
  const nowSec = () => Math.floor(now() / 1000);

  /** 表可能还没建（全新库 / 某个模块没装）——查不到当 0，不要炸整条读取面。 */
  const has = (t) =>
    !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(t);
  const count = (table, where, ...args) => {
    if (!has(table)) return 0;
    try {
      return db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...args)?.n || 0;
    } catch {
      return 0; // 老库少一列时当 0，而不是让「我的」整页打不开
    }
  };

  /* ── 数字名片 ────────────────────────────────────────────────── */

  /**
   * 名片上只放**别人认得出你**的东西：你是谁、你在这儿多久、你手上有什么、你给出去了什么。
   * 🔴 不放余额、不放订单、不放任何只跟你自己有关的钱 —— 名片是要递出去的。
   */
  function card(uid, viewerName) {
    const roster = owners.listOf(uid);
    const since = roster.reduce(
      (min, r) => (r.created_at && (!min || r.created_at < min) ? r.created_at : min), null);
    const days = since ? Math.max(1, Math.floor((nowSec() - since) / 86400) + 1) : 0;
    const online = roster.filter((r) => isReporting(r.ai_uid)).length;
    const apps = count("apps", "owner_uid = ?", uid);
    const listed = count("listings", "author_uid = ? AND status = 'listed'", uid);
    const installs = installsOfAuthor(uid);
    return {
      uid,
      name: viewerName || null,
      since: since || null,
      days,
      agents: { total: roster.length, reporting: online },
      apps,
      listed,
      installs,
      /* 🔴 "在这儿多久"以**第一台 AI 记到名下**那天为准，不是注册那天 ——
         注册时间在宿主那边，我们拿不到；拿不到就不编一个。 */
      how: {
        days: since
          ? "从你名下第一台 AI 登记那天算起（注册时间在宿主那边，平台这边读不到）。"
          : "还没有 AI 记到你名下，所以这里还没有天数。",
        installs: "别人把你上架的东西装到自己名下的次数。",
      },
    };
  }

  function isReporting(aiUid) {
    if (!has("agent_status")) return false;
    const r = db.prepare(`SELECT ts, ttl FROM agent_status WHERE ai_uid = ?`).get(aiUid);
    if (!r?.ts) return false;
    return r.ts + (r.ttl || 180) >= nowSec();
  }

  function installsOfAuthor(uid) {
    if (!has("installs") || !has("listings")) return 0;
    try {
      return db.prepare(
        `SELECT COUNT(*) AS n FROM installs i
           JOIN listings l ON l.id = i.listing_id
          WHERE l.author_uid = ?`).get(uid)?.n || 0;
    } catch { return 0; }
  }

  /* ── 成长关系 ────────────────────────────────────────────────── */

  /** 一台 AI 的五个因子的**原始条数**（还没换算成分）。 */
  function rawOf(row) {
    const ai = row.ai_uid;
    const days = row.created_at ? Math.max(0, Math.floor((nowSec() - row.created_at) / 86400)) : 0;
    return {
      days,
      reports: count("agent_events", "ai_uid = ?", ai),
      memories: count("agent_memories", "ai_uid = ?", ai),
      tasks: count("agent_tasks", "ai_uid = ? AND state = 'done'", ai),
      talks: count("channel_records", "ai_uid = ?", ai),
    };
  }

  /**
   * 一台 AI 的成长。
   *
   * 🔴 `silent` 为真时界面必须换一套话术：这台 AI **从来没往上报过**，
   *    它的 0 分说的是"平台看不见"，不是"你们不熟"。
   */
  function growthOf(row) {
    const raw = rawOf(row);
    const parts = FACTORS.map((f) => {
      const n = raw[f.key] || 0;
      const pts = Math.min(f.cap, Math.floor(n * f.per));
      return { key: f.key, label: f.label, unit: f.unit, n, points: pts, cap: f.cap, how: f.how };
    });
    const score = parts.reduce((a, p) => a + p.points, 0);
    const { stage, next } = stageOf(score);
    const everReported = raw.reports > 0 || raw.memories > 0 || raw.tasks > 0 || raw.talks > 0;
    return {
      ai_uid: row.ai_uid,
      ai_name: row.ai_name || row.ai_uid,
      days: raw.days,
      score,
      full: FULL_SCORE,
      stage: stage.key,
      stage_name: stage.name,
      stages: STAGES.map((s) => ({ key: s.key, name: s.name, at: s.at, reached: score >= s.at })),
      next_stage: next ? { key: next.key, name: next.name, at: next.at, gap: next.at - score } : null,
      parts,
      /* 🔴 这一条决定界面说哪句话，不许由前端自己猜 */
      silent: !everReported,
      why: everReported
        ? null
        : "这台 AI 还没往平台报过任何东西 —— 这里的 0 说的是「平台看不见」，不是「你们不熟」。",
      /** 下一步：给**一个**动作，针对当前最欠的那个因子（同 onboarding 的规矩）。 */
      next_move: nextMove(parts, everReported),
    };
  }

  /**
   * 最欠的那一项 ＝ 离封顶差得最多的那一项。
   * 🔴 只给一个。给三条建议等于没给 —— 这一块的用处是"不用想，照着做"。
   */
  function nextMove(parts, everReported) {
    if (!everReported) {
      return { key: "connect", text: "先让它接上来往平台报一次", to: "onboarding" };
    }
    const worst = [...parts].sort((a, b) => (b.cap - b.points) - (a.cap - a.points))[0];
    if (!worst || worst.points >= worst.cap) return null;
    const TEXT = {
      days: "再过些日子就会涨，这一项急不来",
      reports: "让它把每天做的事报上来",
      memories: "让它把记忆同步上来",
      tasks: "给它派一件活，干完让它报「干完了」",
      talks: "在渠道里跟它多聊几句",
    };
    return { key: worst.key, text: TEXT[worst.key] || worst.label, to: worst.key };
  }

  /* ── 新手任务 ────────────────────────────────────────────────── */

  /**
   * 六件事。每一件的"做完没有"都**由库里的事实判定**，不是让人自己打勾 ——
   * 自己打勾的清单三天之后就只剩装饰作用。
   *
   * 🔴 顺序就是该做的顺序：没有第一台 AI，后面五件都没有意义。
   */
  function tasks(uid) {
    const roster = owners.listOf(uid);
    const aiUids = roster.map((r) => r.ai_uid);
    const anyOf = (table, col = "ai_uid") =>
      aiUids.some((a) => count(table, `${col} = ?`, a) > 0);
    const outside = aiUids.some(
      (a) => count("channel_records", "ai_uid = ? AND channel <> 'eryuan'", a) > 0);

    const list = [
      { key: "have_ai", title: "请一台 AI 进来", why: "平台上的每一件事都从这一步开始",
        done: roster.length > 0, to: "contacts", cta: "邀请 AI" },
      { key: "reported", title: "让它接上来报个到", why: "它报过一次，你才看得见它在不在",
        done: aiUids.some(isReporting) || anyOf("agent_events"),
        to: "onboarding", cta: "看它卡在哪一步" },
      { key: "talked", title: "跟它说第一句话", why: "对话是这套东西的主干，不是附加功能",
        done: anyOf("channel_records"), to: "chat", cta: "去说一句" },
      { key: "made_app", title: "让它造一个应用", why: "它干出来的东西要有个住的地方",
        done: count("apps", "owner_uid = ?", uid) > 0, to: "superapp", cta: "造一个" },
      { key: "shared", title: "把一个应用放到市场上", why: "放上去，组织里其他人才装得到",
        done: count("listings", "author_uid = ? AND status = 'listed'", uid) > 0,
        to: "market", cta: "去上架" },
      { key: "channel", title: "把它接到一条外面的渠道", why: "它得能在微信/飞书那边替你干活",
        done: outside, to: "channels", cta: "去接一条" },
    ];
    const done = list.filter((t) => t.done).length;
    return {
      total: list.length,
      done,
      /* 下一件该做的＝**第一件没做完的**。全做完给 null，界面据此换成"都做完了"。 */
      next: list.find((t) => !t.done)?.key || null,
      tasks: list,
      how: "每一条做没做完都是从库里查出来的，不是你自己打的勾。",
    };
  }

  /* ── 隐形能力 与 收益 ────────────────────────────────────────── */

  /**
   * 「我的隐形能力」＝ 你放出去、别人能用的那些本事。
   * 今天平台上这件事的真身就是**你上架到市场的东西**（应用/技能/卡片）。
   * 🔴 设计稿上每张卡带「¥39 / 次」：这一版**不发价格**，因为收钱通道还没接
   *    （commerce.mjs 文件头：收款主体和支付密钥在苏白手上）。
   *    标一个收不到的价，比不标更坏 —— 别人点了会以为能买。
   */
  function capabilities(uid) {
    if (!has("listings")) return { items: [], how: "还没有市场这张表。" };
    const rows = db.prepare(
      `SELECT id, app_id, kind, name, icon, summary, version, updated_at
         FROM listings WHERE author_uid = ? AND status = 'listed'
        ORDER BY updated_at DESC`).all(uid);
    const items = rows.map((r) => ({
      ...r,
      installs: count("installs", "listing_id = ?", r.id),
    }));
    return {
      items,
      how: "这里是你上架到应用市场、别人装得到的东西。装的次数是真实安装数。",
      /* 🔴 明着说为什么没有价格，而不是悄悄不画 */
      pricing: null,
      pricing_why: "还不能给能力标价 —— 收钱通道还没接上，标了也收不到。",
    };
  }

  /**
   * 「我的收益」。
   *
   * 🔴 今天这里**只可能是 0**，而且必须说清为什么：平台没有任何一条已付的订单
   *    （commerce.mjs 刻意不含支付通道，也刻意没有"标记为已付"的后门）。
   *    所以这一块给的不是一个假数，是**真 0 ＋ 还差哪一块 ＋ 已经攒下的分子**
   *    （你的东西被装了多少次 —— 那是将来变成钱的那个数）。
   */
  function earnings(uid) {
    const paidCents = has("orders")
      ? (db.prepare(
          `SELECT COALESCE(SUM(amount_cents),0) AS c FROM orders WHERE uid = ? AND status = 'paid'`
        ).get(uid)?.c || 0)
      : 0;
    return {
      /* 能力收益 / 分销收益 ＝ 设计稿里那两栏，如实给 0（没有这两条账） */
      capability_cents: 0,
      referral_cents: 0,
      total_cents: 0,
      /* 你自己花出去的（已付订单）——**不算收益**，单独一行，免得被看成收入 */
      spent_cents: paidCents,
      installs: installsOfAuthor(uid),
      how: "收益＝别人为你的能力付过的钱。平台目前一分钱都还没收过，所以这里是 0。",
      missing: "差的是支付通道（收款主体和密钥还没接进来）。接上之前，任何非 0 的数都是假的。",
    };
  }

  /* ── 路由 ────────────────────────────────────────────────────── */

  async function handle(req, res, { path, url, uid, viewerName, root }) {
    const base = `${root}/me`;
    if (path !== base && !path.startsWith(`${base}/`)) return false;
    if (req.method !== "GET") {
      send(res, 405, { error: "method not allowed" });
      return true;
    }

    if (path === `${base}/card`) { send(res, 200, card(uid, viewerName)); return true; }
    if (path === `${base}/tasks`) { send(res, 200, tasks(uid)); return true; }
    if (path === `${base}/capabilities`) { send(res, 200, capabilities(uid)); return true; }
    if (path === `${base}/earnings`) { send(res, 200, earnings(uid)); return true; }

    if (path === `${base}/growth`) {
      const roster = owners.listOf(uid);
      const asked = clip(url?.searchParams?.get("ai_uid"), 80).trim();
      if (asked) {
        const row = roster.find((r) => r.ai_uid === asked);
        // 🔴 只能看自己名下那台 —— 同 onboarding/setup 那条：别泄露"谁有哪台 AI"
        if (!row) { send(res, 403, { error: "not your agent" }); return true; }
        send(res, 200, growthOf(row));
        return true;
      }
      const items = roster.map(growthOf);
      send(res, 200, {
        items,
        full: FULL_SCORE,
        /* 🔴 汇总只给"最熟的那一台"，不给平均分：把一台熟的和五台没接上的
           平均成一个数，那个数谁也不认识。 */
        best: items.slice().sort((a, b) => b.score - a.score)[0] || null,
        silent: items.filter((i) => i.silent).length,
        how: "默契度由五件库里数得出来的事算出来，每件各自封顶，满分 100。",
      });
      return true;
    }

    send(res, 404, { error: "not found" });
    return true;
  }

  return { handle, card, tasks, growthOf, capabilities, earnings, spaceId };
}
