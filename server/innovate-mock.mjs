/**
 * Innovate Loop 的"机会/概念测试"桩 —— 09-03 美妆种子用户验收的第三个工作台。
 *
 * 文档原话："Innovate 是30天最深的应用"、"90%深度，主战场"，但也明确"第一阶段
 * 只做 Validation Score 和证据解释，不展示伪造的成功概率"——所以这里刻意收窄：
 * 不做真实开品/自动 GO-KILL，只做"机会→3个可区分假设→概念测试物料→意向信号
 * 累计→人工最终拍板"这一条最小闭环，跟 §3.4 定义的边界一致。
 *
 * Validation Score = 已收集意向信号的**加权求和**，权重表照抄文档§Intent信号表，
 * 不做任何"预测成功率"的包装——那正是文档明令禁止的伪造。
 *
 * 种子机会承接 Grow 工作台挖出的同一条真实洞察（"油痘肌怕喷雾闷痘"），这正是
 * 文档强调的"三个业务场景数据进入同一个 Company Memory"的雏形——本轮还没有
 * 真的统一数据层，这里只是手动把同一条洞察抄了一份过来，如实说明不是自动打通。
 */
import { randomUUID } from "node:crypto";
import { send, readJson, clip } from "./http-util.mjs";

/** 文档 §Intent信号表 权重表——唯一真源，不许在别处另写一份数字 */
export const INTENT_WEIGHTS = {
  exposure: 1,       // 曝光/停留
  click: 2.5,        // 点击/收藏（文档给的是2-3区间，取中位）
  lead: 5.5,         // 留资/试用申请（5-6区间取中位）
  accept_price: 7,   // 接受价格后仍申请
  host_slot: 8,       // 主播愿排测试
  distributor_intent: 9, // 经销商报意向量
  deposit_or_purchase: 10, // 支付可退订金/真实采购
};

/**
 * 种子机会 —— 覆盖 new → hypotheses_generated → concept_ready → testing → decided
 * 全流程，decided 里 GO / ITERATE / KILL 三种结局都有。
 *
 * 为什么不是 1 条：文档把 Innovate 定为"30天最深的应用、90%深度、主战场"。一条
 * 刚建的机会撑不起这个定位——看不到证据怎么累积、看不到 Validation Score 拉开差距、
 * 更看不到"信号收了一堆但全是低质量"和"真金白银下订金"这两种局面长得多不一样。
 * 那正是这个工作台唯一要帮人看清的东西。
 *
 * 🔴 Validation Score 是已收集意向信号的**加权求和**，权重表见上面 INTENT_WEIGHTS。
 *    它衡量的是「已经拿到的证据有多硬」，**不是成功概率** —— 文档明令禁止展示
 *    未经回测的成功率，这条边界在种子数据里也不许破（decision_reason 里不出现
 *    任何百分比形式的成功可能性）。
 */
const SEED_OPPORTUNITIES = [
  // ── 刚建立，等生成假设（new）─────────────────────────────
  {
    seed_key: "youdouji-menbi-penwu",
    title: "油痘肌「怕闷痘」焦虑 → 轻量控油喷雾类目机会",
    evidence_source: "Grow工作台·摇摇水内容实验的用户洞察（同一条，手动抄录，非自动打通）",
    evidence_text: "近两周私域/客服咨询里反复出现「油皮夏天不敢用喷雾怕闷痘」，但现有产品线没有专门针对「轻量不闷痘」定位的单品，属于未被满足的细分需求。",
    score: 6, status: "new", days_ago: 1,
  },
  {
    seed_key: "nanshi-jingjian-huli",
    title: "男士「三步以内」极简护肤 → 精简套组机会",
    evidence_source: "客服会话关键词聚类（人工抽样 200 条，非全量自动分析）",
    evidence_text: "男性用户咨询里高频出现「太麻烦」「几步能搞定」，现有男士线仍按女性护肤的多步骤逻辑组货，步骤数本身就是流失点。",
    score: 5, status: "new", days_ago: 3,
  },

  // ── 已有 A/B/C 假设（hypotheses_generated）──────────────
  {
    seed_key: "huanji-pingzhang-jijiu",
    title: "换季屏障急救 → 短周期修护套装机会",
    evidence_source: "Grow工作台·妆舟抖音实验（换季「屏障受损」搜索量涨3倍）+ 客服咨询量环比",
    evidence_text: "换季期出现集中爆发的「刺痛发红」诉求，但用户要的是「一周内缓过来」的短期方案，现有面霜是长期养护定位，接不住这波急性需求。",
    score: 7, status: "hypotheses_generated", days_ago: 6, hyp_days_ago: 5,
    hypotheses: [
      { label: "A", concept: "7天屏障急救安瓶，一天一支不用挑用量", audience: "换季急性敏感，25-40岁", price_band: "129-159元", format: "次抛安瓶 7支装" },
      { label: "B", concept: "急救面霜+舒缓喷雾双件套，白天晚上分开用", audience: "常年敏感肌，需长期方案", price_band: "199-239元", format: "面霜50g + 喷雾50ml" },
      { label: "C", concept: "单支高浓度急救精华，贵但只要一支", audience: "护肤老手，认成分不认套装", price_band: "89-109元", format: "精华 15ml" },
    ],
  },

  // ── 概念测试物料就绪（concept_ready）────────────────────
  {
    seed_key: "toupi-huli-kuopin",
    title: "头皮护理 → 从面部延伸到头皮的品类扩张机会",
    evidence_source: "站内搜索词报表（人工导出）+ 经销商走访纪要 3 份",
    evidence_text: "「头皮」相关搜索在站内涨得很快但我们没有对应商品，用户搜完直接跳走；两家经销商主动问过有没有头皮线可以搭着卖。",
    score: 8, status: "concept_ready", days_ago: 11, hyp_days_ago: 10, concept_days_ago: 9,
    hypotheses: [
      { label: "A", concept: "头皮舒缓精华水，延续妆舟镇静配方逻辑", audience: "染烫受损人群，25-40岁", price_band: "119-149元", format: "头皮精华水 100ml" },
      { label: "B", concept: "洗前头皮去角质啫喱，解决出油和味道", audience: "油头人群，18-30岁", price_band: "79-99元", format: "去角质啫喱 150ml" },
      { label: "C", concept: "头皮护理套组（水+按摩梳）", audience: "愿意做仪式感护理的女性", price_band: "199-259元", format: "精华水 + 硅胶梳" },
    ],
    chosen_label: "A",
  },

  // ── 正在收意向信号（testing）───────────────────────────
  {
    seed_key: "chunbu-xiufu-jiuzhuang",
    title: "唇部修护 → 医美术后/干敏唇专用线机会",
    evidence_source: "小红书评论区人工抽样 + 私域问卷（回收 148 份，非全量）",
    evidence_text: "干敏唇人群反复提「唇膏越涂越干」，且医美术后护理场景下几乎没有专门的唇部产品，用户在拿面部修护产品硬涂嘴唇。",
    score: 7, status: "testing", days_ago: 15, hyp_days_ago: 14, concept_days_ago: 13,
    hypotheses: [
      { label: "A", concept: "医美术后唇部修护膏，无香精无色素", audience: "医美术后人群", price_band: "79-99元", format: "修护膏 10g" },
      { label: "B", concept: "日常干敏唇修护精华，可打底口红", audience: "长期干敏唇，20-35岁", price_band: "59-79元", format: "唇精华 8ml" },
      { label: "C", concept: "唇部急救面膜，睡前厚敷", audience: "季节性干裂人群", price_band: "89-119元", format: "唇膜 15g" },
    ],
    chosen_label: "B",
    // 信号质量偏高：有留资、有接受价格后仍申请、有主播愿排期
    signals: [
      { type: "exposure", n: 6, note: "概念页曝光" },
      { type: "click", n: 4, note: "点击查看详情/收藏" },
      { type: "lead", n: 3, note: "留资申请试用" },
      { type: "accept_price", n: 2, note: "看到 69 元定价后仍提交申请" },
      { type: "host_slot", n: 1, note: "合作主播确认愿排一场测试" },
    ],
    signal_days_ago: 12,
  },
  {
    seed_key: "fangshai-buyou-qingbo",
    title: "防晒「不油不白」→ 轻薄物理防晒机会",
    evidence_source: "竞品评论区人工抓取（3个竞品各 100 条）+ 客服咨询",
    evidence_text: "防晒品类抱怨集中在「油」和「假白」两件事上，但这是个红海类目，进去要面对成熟大牌的正面竞争，需要证据足够硬才值得投。",
    score: 6, status: "testing", days_ago: 19, hyp_days_ago: 18, concept_days_ago: 17,
    hypotheses: [
      { label: "A", concept: "纯物理防晒乳，主打不假白", audience: "敏感肌+防晒刚需", price_band: "99-129元", format: "防晒乳 40ml" },
      { label: "B", concept: "防晒喷雾，承接摇摇水的喷雾心智", audience: "户外通勤人群", price_band: "79-99元", format: "防晒喷雾 100ml" },
      { label: "C", concept: "防晒+隔离二合一，减少步骤", audience: "怕麻烦的上班族", price_band: "119-149元", format: "隔离防晒霜 30ml" },
    ],
    chosen_label: "B",
    // 🔴 反面样本：信号数量不少，但全堆在最低权重那两档——典型的"看的人多、
    //    肯付出代价的人一个都没有"。工作台要能一眼看出这种局面。
    signals: [
      { type: "exposure", n: 9, note: "概念页曝光" },
      { type: "click", n: 6, note: "点击/收藏" },
      { type: "lead", n: 1, note: "留资 1 例" },
    ],
    signal_days_ago: 16,
  },

  // ── 已拍板（decided）：GO / ITERATE / KILL 三种结局 ────────
  {
    seed_key: "minganji-jiemian-go",
    title: "敏感肌氨基酸洁面 → 补齐清洁环节机会",
    evidence_source: "经销商意向汇总（5家）+ 老客问卷（回收 302 份）",
    evidence_text: "买了修护线的老客普遍还在用别家洁面，清洁这一环是我们体系里的缺口，老客复购意愿明确且经销商愿意报量。",
    score: 9, status: "decided", days_ago: 24, hyp_days_ago: 23, concept_days_ago: 22,
    hypotheses: [
      { label: "A", concept: "氨基酸洁面慕斯，泵头出泡免揉搓", audience: "敏感肌老客", price_band: "69-89元", format: "洁面慕斯 150ml" },
      { label: "B", concept: "洁面膏，主打成本低走量", audience: "价格敏感人群", price_band: "39-59元", format: "洁面膏 100g" },
      { label: "C", concept: "洁面+卸妆二合一", audience: "化妆人群", price_band: "99-129元", format: "卸洗二合一 200ml" },
    ],
    chosen_label: "A",
    signals: [
      { type: "exposure", n: 8 }, { type: "click", n: 6 }, { type: "lead", n: 5 },
      { type: "accept_price", n: 4 }, { type: "distributor_intent", n: 3, note: "3家经销商报意向量共 4200 支" },
      { type: "deposit_or_purchase", n: 2, note: "2家支付可退订金" },
    ],
    signal_days_ago: 21,
    decision: "GO", decided_days_ago: 20,
    decision_reason: "证据里有经销商报量和真实订金，不是只有点击。老客问卷显示清洁缺口真实存在，且我们的修护配方逻辑能直接迁移到洁面上，研发风险低。按假设A推进打样。",
  },
  {
    seed_key: "toupi-tiaoli-iterate",
    title: "抗初老「早C晚A」组合 → 功效线机会",
    evidence_source: "站内搜索词 + 竞品动销数据（第三方平台，人工导出）",
    evidence_text: "早C晚A是成熟心智，搜索量大，但也意味着教育成本低的同时竞争极其充分，我们没有明显差异点。",
    score: 6, status: "decided", days_ago: 28, hyp_days_ago: 27, concept_days_ago: 26,
    hypotheses: [
      { label: "A", concept: "早C晚A双支装，新手友好浓度", audience: "抗初老新手，25-35岁", price_band: "199-259元", format: "精华 2×15ml" },
      { label: "B", concept: "单支A醇，主打高浓度", audience: "刷酸老手", price_band: "159-199元", format: "A醇精华 30ml" },
      { label: "C", concept: "早C晚A+修护面霜三件套", audience: "怕烂脸的谨慎人群", price_band: "329-399元", format: "三件套" },
    ],
    chosen_label: "A",
    signals: [
      { type: "exposure", n: 7 }, { type: "click", n: 5 }, { type: "lead", n: 3 },
      { type: "accept_price", n: 1, note: "接受 229 元定价后仍申请，仅 1 例" },
    ],
    signal_days_ago: 25,
    decision: "ITERATE", decided_days_ago: 24,
    decision_reason: "信号能爬到留资这一档说明需求是真的，但接受价格那一档几乎没人上来，说明我们给的价值主张撑不住这个价格带。不砍掉，回炉重做概念：要么找到真正的差异点，要么换价格带再测一轮。",
  },
  {
    seed_key: "xiangshui-fuxian-kill",
    title: "香氛副线 → 品牌延展机会",
    evidence_source: "内部提案 + 概念页测试",
    evidence_text: "有提议做香氛副线拉高品牌调性，概念页跑了两周收集真实意向。",
    score: 4, status: "decided", days_ago: 33, hyp_days_ago: 32, concept_days_ago: 31,
    hypotheses: [
      { label: "A", concept: "身体香氛喷雾，延续喷雾产品线", audience: "18-28岁女性", price_band: "129-169元", format: "香氛喷雾 100ml" },
      { label: "B", concept: "香薰蜡烛，走礼品场景", audience: "送礼人群", price_band: "159-199元", format: "蜡烛 200g" },
      { label: "C", concept: "固体香膏，便携补香", audience: "通勤人群", price_band: "79-99元", format: "香膏 10g" },
    ],
    chosen_label: "A",
    // 🔴 典型的"曝光很多、没人真的要"——曝光点击一大堆，留资以上一个都没有。
    signals: [
      { type: "exposure", n: 12, note: "概念页曝光（投了两周）" },
      { type: "click", n: 7, note: "点击/收藏" },
    ],
    signal_days_ago: 30,
    decision: "KILL", decided_days_ago: 29,
    decision_reason: "两周下来信号一直卡在曝光和点击这两档，往上一档（留资）零。这说明看的人不少但没人愿意为它付出任何代价，是「随便看看」不是需求。香氛也不在我们的配方能力圈内，供应链要从零建。停掉，不做。",
  },
];

const DAY = 86_400_000;

/** 把种子里 `{type,n}` 的紧凑写法摊成真实信号数组，时间在 signal_days_ago 前后散开。 */
function expandSignals(spec, now, baseDaysAgo) {
  const out = [];
  const base = now - (baseDaysAgo || 0) * DAY;
  let k = 0;
  for (const g of spec || []) {
    for (let i = 0; i < (g.n || 1); i++) {
      out.push({
        type: g.type,
        weight: INTENT_WEIGHTS[g.type],
        note: g.note || null,
        // 每条信号错开几小时，别让它们全挤在同一毫秒——那样时间轴画出来是一根线。
        at: base + k * 3 * 3600_000,
      });
      k++;
    }
  }
  return out;
}

/** 幂等补种，理由同 sell-mock。 */
export function initInnovateMockSchema(db, nowMs) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS innovate_opportunities (
      id                TEXT PRIMARY KEY,
      title             TEXT NOT NULL,
      evidence_source   TEXT NOT NULL,
      evidence_text     TEXT NOT NULL,
      score             REAL NOT NULL,
      status            TEXT NOT NULL DEFAULT 'new',
      hypotheses        TEXT,
      hypotheses_at     INTEGER,
      concept_note      TEXT,
      concept_at        INTEGER,
      intent_signals    TEXT NOT NULL DEFAULT '[]',
      decision          TEXT,
      decision_reason   TEXT,
      decided_at        INTEGER,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL
    );
  `);

  const cols = db.prepare(`PRAGMA table_info(innovate_opportunities)`).all().map((c) => c.name);
  if (!cols.includes("seed_key")) db.exec(`ALTER TABLE innovate_opportunities ADD COLUMN seed_key TEXT`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_inno_seed_key ON innovate_opportunities(seed_key) WHERE seed_key IS NOT NULL`);

  const now = nowMs || Date.now();

  const claim = db.prepare(`UPDATE innovate_opportunities SET seed_key=? WHERE title=? AND seed_key IS NULL`);
  for (const o of SEED_OPPORTUNITIES) claim.run(o.seed_key, o.title);

  const ins = db.prepare(`
    INSERT OR IGNORE INTO innovate_opportunities
      (id,seed_key,title,evidence_source,evidence_text,score,status,
       hypotheses,hypotheses_at,concept_note,concept_at,intent_signals,
       decision,decision_reason,decided_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  for (const o of SEED_OPPORTUNITIES) {
    const created = now - (o.days_ago || 0) * DAY;
    const hypAt = o.hyp_days_ago != null ? now - o.hyp_days_ago * DAY : null;
    const conceptAt = o.concept_days_ago != null ? now - o.concept_days_ago * DAY : null;
    const decidedAt = o.decided_days_ago != null ? now - o.decided_days_ago * DAY : null;
    const signals = expandSignals(o.signals, now, o.signal_days_ago);

    // 概念测试免责声明跟 /concept 接口生成的是同一句话，保持一致。
    const conceptNote = conceptAt
      ? `【概念测试/内测招募】选定假设 ${o.chosen_label || "A"}：本页面用于收集真实意向，非正式销售，`
        + `价格与规格以最终上市为准。参与即视为知情本次为概念验证活动。`
      : null;

    ins.run(
      randomUUID(), o.seed_key, o.title, o.evidence_source, o.evidence_text, o.score, o.status || "new",
      o.hypotheses ? JSON.stringify(o.hypotheses) : null, hypAt,
      conceptNote, conceptAt, JSON.stringify(signals),
      o.decision ?? null, o.decision_reason ?? null, decidedAt,
      created, decidedAt || conceptAt || hypAt || created,
    );
  }
}

function validationScore(signals) {
  return signals.reduce((sum, s) => sum + (INTENT_WEIGHTS[s.type] || 0), 0);
}

async function llmHypotheses({ title, evidence_text }, llm) {
  const prompt = `你是美妆新品创新顾问。基于一个市场机会，生成 3 个互相有明显区分度的商品假设
（A/B/C），返回 JSON 数组，每条 {"label":"A/B/C","concept":"一句话商品概念","audience":"目标人群",
"price_band":"价格带(如 59-79元)","format":"剂型/形态"}。三个假设的人群/价格/形态必须有实质差异，
不能只是换个文案。
机会：${title}
证据：${evidence_text}`;
  if (!llm?.apiKey) {
    return { hypotheses: [
      { label: "A", concept: "（本地兜底）轻量喷雾", audience: "油痘肌新客", price_band: "49-59元", format: "喷雾" },
      { label: "B", concept: "（本地兜底）便携小样装", audience: "尝鲜型客户", price_band: "19-29元", format: "小样喷雾" },
      { label: "C", concept: "（本地兜底）精华+喷雾套装", audience: "高客单老客", price_band: "129-159元", format: "套装" },
    ], mode: "local" };
  }
  try {
    const res = await fetch(`${llm.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${llm.apiKey}` },
      body: JSON.stringify({ model: llm.model, messages: [{ role: "user", content: prompt }], temperature: 0.6 }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`模型网关 ${res.status}`);
    const body = await res.json();
    const text = body?.choices?.[0]?.message?.content || "";
    const m = text.match(/\[[\s\S]*\]/);
    if (!m) throw new Error("模型没返回可解析 JSON 数组");
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr) || arr.length < 2) throw new Error("模型返回假设数量不足");
    return {
      hypotheses: arr.slice(0, 3).map((h) => ({
        label: clip(String(h.label || ""), 4), concept: clip(String(h.concept || ""), 200),
        audience: clip(String(h.audience || ""), 100), price_band: clip(String(h.price_band || ""), 40),
        format: clip(String(h.format || ""), 40),
      })),
      mode: "llm",
    };
  } catch (e) {
    return { hypotheses: [{ label: "A", concept: `生成失败已回退：${String(e.message || e)}`, audience: "", price_band: "", format: "" }], mode: "local" };
  }
}

export function createInnovateMock({ db, prefix, secret }) {
  initInnovateMockSchema(db);

  // 队列语义：没拍板的排前面（那才是要人动手的），已决策的按最近排在后面。
  const qList = db.prepare(`
    SELECT * FROM innovate_opportunities
    ORDER BY (status != 'decided') DESC, COALESCE(updated_at, created_at) DESC`);
  const qGet = db.prepare(`SELECT * FROM innovate_opportunities WHERE id=?`);
  const qSetHyp = db.prepare(`UPDATE innovate_opportunities SET hypotheses=?, hypotheses_at=?, status='hypotheses_generated', updated_at=? WHERE id=?`);
  const qSetConcept = db.prepare(`UPDATE innovate_opportunities SET concept_note=?, concept_at=?, status='concept_ready', updated_at=? WHERE id=?`);
  const qSetSignals = db.prepare(`UPDATE innovate_opportunities SET intent_signals=?, status='testing', updated_at=? WHERE id=?`);
  const qDecide = db.prepare(`UPDATE innovate_opportunities SET decision=?, decision_reason=?, decided_at=?, status='decided', updated_at=? WHERE id=?`);

  function toResp(row) {
    const signals = JSON.parse(row.intent_signals || "[]");
    return {
      ...row,
      hypotheses: row.hypotheses ? JSON.parse(row.hypotheses) : null,
      intent_signals: signals,
      validation_score: validationScore(signals),
    };
  }

  async function handle(req, res, { path, url, llm, now }) {
    if (!path.startsWith(prefix)) return false;
    const bearer = String(req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
    if (!secret || bearer !== secret) return send(res, 401, { error: "unauthorized" }), true;

    const rel = path.slice(prefix.length);
    if (rel === "/opportunities" && req.method === "GET") {
      return send(res, 200, { items: qList.all().map(toResp) }), true;
    }

    const seg = rel.slice(1).split("/");
    const id = decodeURIComponent(seg[0] || "");
    const action = seg[1] || "";
    if (!id) return false;
    const row = qGet.get(id);
    if (!row) return send(res, 404, { error: "not found" }), true;

    if (action === "hypotheses" && req.method === "POST") {
      const g = await llmHypotheses(row, llm);
      qSetHyp.run(JSON.stringify(g.hypotheses), now, now, id);
      return send(res, 200, { id, hypotheses: g.hypotheses, mode: g.mode }), true;
    }
    if (action === "concept" && req.method === "POST") {
      if (!row.hypotheses) return send(res, 409, { error: "还没有商品假设，先造假设" }), true;
      let body = {}; try { body = await readJson(req); } catch {}
      const chosen = clip(body.chosen_label, 4) || "A";
      const note = `【概念测试/内测招募】选定假设 ${chosen}：本页面用于收集真实意向，非正式销售，`
        + `价格与规格以最终上市为准。参与即视为知情本次为概念验证活动。`;
      qSetConcept.run(note, now, now, id);
      return send(res, 200, { id, concept_note: note, chosen_label: chosen }), true;
    }
    if (action === "signal" && req.method === "POST") {
      if (row.status !== "concept_ready" && row.status !== "testing") {
        return send(res, 409, { error: "还没有概念测试物料，不能收信号" }), true;
      }
      let body = {}; try { body = await readJson(req); } catch {}
      const type = String(body.type || "");
      if (!(type in INTENT_WEIGHTS)) {
        return send(res, 400, { error: `type 必须是 ${Object.keys(INTENT_WEIGHTS).join("/")} 之一` }), true;
      }
      const signals = JSON.parse(row.intent_signals || "[]");
      signals.push({ type, weight: INTENT_WEIGHTS[type], note: clip(body.note, 200) || null, at: now });
      qSetSignals.run(JSON.stringify(signals), now, id);
      return send(res, 200, { id, validation_score: validationScore(signals), signals_count: signals.length }), true;
    }
    if (action === "decide" && req.method === "POST") {
      if (row.status === "decided") return send(res, 409, { error: "已经拍过板了" }), true;
      let body = {}; try { body = await readJson(req); } catch {}
      const decision = String(body.decision || "").toUpperCase();
      if (!["GO", "ITERATE", "KILL"].includes(decision)) {
        return send(res, 400, { error: "decision 必须是 GO/ITERATE/KILL 之一" }), true;
      }
      const reason = clip(body.reason, 500).trim();
      if (!reason) return send(res, 400, { error: "reason 必填——人工拍板必须留下理由" }), true;
      qDecide.run(decision, reason, now, now, id);
      return send(res, 200, { id, decision, decision_reason: reason }), true;
    }
    if (!action && req.method === "GET") return send(res, 200, toResp(row)), true;
    return false;
  }

  return { handle };
}
