/**
 * Grow Loop 的"内容/渠道系统"桩 —— 09-03 美妆种子用户验收的第二个工作台。
 *
 * 跟 sell-mock.mjs 同一个理由、同一个地位（种子数据，非真实抖音/私域后台——尚未接入）：
 * 验证"连接器+script沙盒"这套机制在第二类业务形状（内容实验，不是任务审批）上
 * 依然成立，不是只为 Sell 量身定做的。
 *
 * 字段对齐美妆经营内核文档 §4.3 Company Memory 的 Content Asset / Experiment 表
 * 与 §3.3 GROW LOOP、§5.3 Grow App 场景表（摇摇水内容/妆舟私域两条子场景）。
 * SPEC 明确 Grow 只要求"50%深度，跑通1条链"——比 Sell 的 70% 浅，这里同样收窄范围：
 * 只做"洞察→AI生成内容变体→人工批准→（模拟）渠道结果回填"这一条链，不做投流/直播。
 */
import { randomUUID } from "node:crypto";
import { send, readJson, clip } from "./http-util.mjs";

/**
 * 种子实验 —— 3 条品牌线 × 5 个渠道，覆盖 pending→ai_generated→approved→measured
 * 全生命周期，时间铺在过去 34 天里。
 *
 * 为什么不是 2 条：Grow 的价值在「跑过一轮、拿到结果、下一轮据此调整」这个闭环上。
 * 只有 2 条待办、0 条有结果，工作台就只能显示一个空的实验列表——看不到 CTR/CVR
 * 对比，也看不出哪条洞察真的成立过，那就不是增长工作台，是个待办清单。
 *
 * 🔴 result_* 三个数字是**人工补录的种子值不是真实渠道回传**（真实渠道尚未接入），
 *    result_source 字段逐条如实标注，前端必须把这个来源显示出来，不许当成真数据。
 */
const SEED_EXPERIMENTS = [
  // ── 待 AI 生成变体（pending）────────────────────────────
  {
    seed_key: "yaoyaoshui-douyin-menkou",
    brand: "摇摇水", channel: "抖音",
    insight: "近两周后台咨询里「油皮夏天不敢用喷雾怕闷痘」这句话反复出现，但现有素材都在讲「清爽」，没人正面回应「闷痘」这个具体顾虑。",
    audience: "18-28岁油痘肌，一二线城市",
    status: "pending", days_ago: 0,
  },
  {
    seed_key: "zhuangzhou-siyu-yunqi",
    brand: "妆舟", channel: "私域(企业微信)",
    insight: "私域里被问最多的问题是「这个精华孕期能不能用」，但商详页和客服话术都没有明确口径，导致这批高意向咨询大概率流失。",
    audience: "备孕/孕期用户，私域老客",
    status: "pending", days_ago: 1,
  },
  {
    seed_key: "sanshi-xiaohongshu-chengfen",
    brand: "叁时", channel: "小红书",
    insight: "搜索「冻干面膜」的笔记里，排名靠前的全在讲「成分表」，我们的素材一直在讲使用感受，在这个词下几乎不出现。",
    audience: "22-35岁成分党，护肤进阶用户",
    status: "pending", days_ago: 2,
  },

  // ── AI 已出变体，等审批（ai_generated）──────────────────
  {
    seed_key: "zhuangzhou-douyin-pingzhang",
    brand: "妆舟", channel: "抖音",
    insight: "换季期「屏障受损」搜索量涨了 3 倍，但用户分不清「屏障受损」和「过敏」，评论区反复在问「我这是不是过敏」——这个认知缺口没人填。",
    audience: "25-40岁敏感肌，换季爆发期",
    status: "ai_generated", days_ago: 4, ai_days_ago: 4,
    ai_variants: [
      { headline: "先别急着停用所有护肤品——分清「屏障受损」和「过敏」，处理方式完全相反", angle: "认知纠偏切入，回答评论区最高频的那个问题，建立专业信任" },
      { headline: "换季脸刺痛发红，我做了三件事，第七天缓过来了", angle: "第一人称真实经历叙事，弱化推销感，适合完播率" },
      { headline: "皮肤科医生怎么看「屏障受损」：三个判断标准", angle: "专业背书角度（需真实合作医生，不可虚构身份）" },
    ],
  },
  {
    seed_key: "yaoyaoshui-siyu-fugou",
    brand: "摇摇水", channel: "私域(企业微信)",
    insight: "喷雾复购周期平均 45 天，但我们的私域触达是固定每周推一次，跟复购节奏完全对不上——用完的时候没人提醒，没用完的时候一直在推。",
    audience: "已购喷雾的私域老客",
    status: "ai_generated", days_ago: 6, ai_days_ago: 5,
    ai_variants: [
      { headline: "按购买日 +38 天触发：「你那瓶差不多该见底了」", angle: "把固定周推改成按个人复购节奏触发，减少无效打扰" },
      { headline: "「夏天用得快，给你留了个补货提醒」", angle: "季节性话术，承认夏季消耗更快这个真实体验" },
      { headline: "空瓶回收 + 复购折扣双钩子", angle: "环保动作叠加复购激励，需先确认回收物流成本" },
    ],
  },

  // ── 已批准、等回填结果（approved）────────────────────────
  {
    seed_key: "sanshi-douyin-lengdong",
    brand: "叁时", channel: "抖音",
    insight: "「冻干」这个工艺点用户完全无感，但看到「化开的那一下」的过程画面时停留时长明显更高——工艺讲不通，过程能看懂。",
    audience: "20-30岁面膜高频使用者",
    status: "approved", days_ago: 10, ai_days_ago: 9, decided_days_ago: 8,
    ai_variants: [
      { headline: "冻干面膜化开的那 5 秒（无配音，纯过程）", angle: "以视觉过程替代工艺解说，赌完播率" },
      { headline: "为什么好面膜是「干」的", angle: "工艺科普角度，作为对照组验证「讲工艺没人看」这个判断" },
    ],
    human_note: "批了。就按纯过程那条投，对照组也留着——我想确认「讲工艺没人看」这件事是真的还是我们自己以为的。",
  },
  {
    seed_key: "zhuangzhou-xiaohongshu-chengfendang",
    brand: "妆舟", channel: "小红书",
    insight: "成分党用户会逐条查成分表，我们的次抛精华配方其实很干净，但从没把完整成分表当卖点亮出来过。",
    audience: "成分党，25-35岁",
    status: "approved", days_ago: 13, ai_days_ago: 12, decided_days_ago: 11,
    ai_variants: [
      { headline: "把整张成分表放大给你看，一条一条讲", angle: "透明度即卖点，适合成分党人群" },
      { headline: "这瓶精华没有的 8 样东西", angle: "反向列举，规避功效宣称风险" },
    ],
    human_note: "同意。注意合规：不能写「零添加」这种绝对化用语，改成具体说明没添加哪几类。",
  },

  // ── 已回收结果（measured）───────────────────────────────
  {
    seed_key: "yaoyaoshui-douyin-youpi-duibi",
    brand: "摇摇水", channel: "抖音",
    insight: "第一轮验证：油皮人群对「控油时长」的敏感度远高于「清爽感」，素材里把「8小时」这个具体数字打出来后互动明显变化。",
    audience: "18-28岁油痘肌",
    status: "measured", days_ago: 21, ai_days_ago: 20, decided_days_ago: 19,
    ai_variants: [
      { headline: "早上喷一次，撑到下班脸还是哑光的", angle: "具体时长场景化表达，不写数字写场景" },
      { headline: "8 小时控油实测（延时摄影）", angle: "把时长做成可视化实证" },
    ],
    human_note: "投了两周，「8小时实测」那条明显更好。结论：油皮要的是可验证的具体承诺，不是形容词。",
    result_ctr: 4.7, result_cvr: 2.9, result_gmv: 68400,
    result_source: "人工补录（抖音后台截图转录，非API回传）", reported_days_ago: 5,
  },
  {
    seed_key: "zhuangzhou-siyu-laoke-huanji",
    brand: "妆舟", channel: "私域(企业微信)",
    insight: "第一轮验证：老客对「换季提醒」类内容的打开率显著高于促销内容，说明私域该做服务不该做投放。",
    audience: "妆舟私域老客，购买≥2次",
    status: "measured", days_ago: 27, ai_days_ago: 26, decided_days_ago: 25,
    ai_variants: [
      { headline: "降温了，你的护肤该换一步", angle: "服务型触达，不带商品链接" },
      { headline: "换季限时 8 折", angle: "促销型触达，作为对照组" },
    ],
    human_note: "服务型那条打开率是促销型的 2.4 倍，且当周复购反而更高。私域策略调整：服务内容和促销内容比例定为 3:1。",
    result_ctr: 12.3, result_cvr: 5.1, result_gmv: 41200,
    result_source: "人工补录（企微后台导出，非API回传）", reported_days_ago: 12,
  },
  {
    seed_key: "sanshi-xiaohongshu-shoufa",
    brand: "叁时", channel: "小红书",
    insight: "第一轮验证：新品首发笔记如果不带「测评」字样，流量明显低——平台在这个类目下更愿意分发测评型内容。",
    audience: "面膜品类泛人群",
    status: "measured", days_ago: 31, ai_days_ago: 30, decided_days_ago: 29,
    ai_variants: [
      { headline: "新品测评｜叁时冻干安瓶面膜真实使用一周", angle: "测评框架，顺平台分发偏好" },
      { headline: "叁时冻干安瓶面膜上新了", angle: "常规上新告知，作为对照组" },
    ],
    human_note: "测评框架那条曝光是对照组的 5 倍多。以后新品首发一律走测评框架，这条写进内容规范。",
    result_ctr: 3.2, result_cvr: 1.8, result_gmv: 23800,
    result_source: "人工补录（小红书蒲公英后台，非API回传）", reported_days_ago: 20,
  },

  // ── 已否决（rejected）──────────────────────────────────
  {
    seed_key: "yaoyaoshui-douyin-kuazhang",
    brand: "摇摇水", channel: "抖音",
    insight: "竞品在打「祛痘」概念数据很好，考虑要不要跟进一版类似角度的素材。",
    audience: "痘肌人群",
    status: "rejected", days_ago: 16, ai_days_ago: 15, decided_days_ago: 15,
    ai_variants: [
      { headline: "（AI 已按合规要求拒绝生成祛痘功效向素材）", angle: "喷雾类目为普通化妆品，宣称祛痘属超范围功效宣称，存在合规风险" },
    ],
    human_note: "否。竞品那么打是他们的风险，不是我们的机会。这类超范围功效宣称一次都不能开口子。",
  },
  {
    seed_key: "sanshi-siyu-shualiang",
    brand: "叁时", channel: "私域(企业微信)",
    insight: "有人提议私域群发抽奖冲一波互动数据，把月度互动指标做上去。",
    audience: "全量私域用户",
    status: "rejected", days_ago: 24, ai_days_ago: 23, decided_days_ago: 23,
    ai_variants: [
      { headline: "全员抽奖，互动即得", angle: "⚠️ 能拉高互动数字，但吸引的是薅羊毛人群，对复购无正向作用" },
    ],
    human_note: "否。指标是用来反映经营的，不是用来做的。AI 这条风险提示提得对，留档。",
  },
];

const DAY = 86_400_000;

/** 幂等补种，理由同 sell-mock：`count===0` 会让新种子永远进不了已非空的线上库。 */
export function initGrowMockSchema(db, nowMs) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS grow_experiments (
      id              TEXT PRIMARY KEY,
      brand           TEXT NOT NULL,
      channel         TEXT NOT NULL,
      audience        TEXT,
      insight         TEXT NOT NULL,
      ai_variants     TEXT,
      ai_generated_at INTEGER,
      status          TEXT NOT NULL DEFAULT 'pending',
      human_note      TEXT,
      decided_at      INTEGER,
      -- 渠道结果：真实渠道尚未接入，回填的是人工补录/模拟数值，来源必须如实标注
      result_ctr      REAL,
      result_cvr      REAL,
      result_gmv      REAL,
      result_source   TEXT,
      reported_at     INTEGER,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
  `);

  const cols = db.prepare(`PRAGMA table_info(grow_experiments)`).all().map((c) => c.name);
  if (!cols.includes("seed_key")) db.exec(`ALTER TABLE grow_experiments ADD COLUMN seed_key TEXT`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_grow_seed_key ON grow_experiments(seed_key) WHERE seed_key IS NOT NULL`);

  const now = nowMs || Date.now();

  // 老种子按 品牌+渠道 认领回来，保住它们身上的真实操作痕迹。
  const claim = db.prepare(`UPDATE grow_experiments SET seed_key=? WHERE brand=? AND channel=? AND seed_key IS NULL`);
  for (const e of SEED_EXPERIMENTS) claim.run(e.seed_key, e.brand, e.channel);

  const ins = db.prepare(`
    INSERT OR IGNORE INTO grow_experiments
      (id,seed_key,brand,channel,audience,insight,ai_variants,ai_generated_at,
       status,human_note,decided_at,result_ctr,result_cvr,result_gmv,result_source,reported_at,
       created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  for (const e of SEED_EXPERIMENTS) {
    const created = now - (e.days_ago || 0) * DAY;
    const aiAt = e.ai_days_ago != null ? now - e.ai_days_ago * DAY : null;
    const decided = e.decided_days_ago != null ? now - e.decided_days_ago * DAY : null;
    const reported = e.reported_days_ago != null ? now - e.reported_days_ago * DAY : null;
    ins.run(
      randomUUID(), e.seed_key, e.brand, e.channel, e.audience, e.insight,
      e.ai_variants ? JSON.stringify(e.ai_variants) : null, aiAt,
      e.status || "pending", e.human_note ?? null, decided,
      e.result_ctr ?? null, e.result_cvr ?? null, e.result_gmv ?? null,
      e.result_source ?? null, reported,
      created, reported || decided || aiAt || created,
    );
  }
}

async function llmVariants({ brand, channel, audience, insight }, llm) {
  const prompt = `你是美妆品牌内容策划。基于一条用户洞察，生成 3 条内容变体（用于A/B测试），
返回 JSON 数组，每条 {"headline":"标题/开头钩子","angle":"这条素材的切入角度一句话说明"}。
不要写夸大疗效或医疗宣称的内容。
品牌：${brand}　渠道：${channel}　目标人群：${audience}
用户洞察：${insight}`;

  if (!llm?.apiKey) {
    return {
      variants: [
        { headline: `${brand}正面回应"${insight.slice(0, 12)}…"`, angle: "本地兜底：未接真模型，占位变体" },
        { headline: "对比实验角度", angle: "本地兜底：未接真模型，占位变体" },
        { headline: "真实用户证言角度", angle: "本地兜底：未接真模型，占位变体" },
      ],
      mode: "local",
    };
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
    if (!Array.isArray(arr) || !arr.length) throw new Error("模型返回空数组");
    return { variants: arr.slice(0, 5).map((v) => ({ headline: clip(String(v.headline || ""), 100), angle: clip(String(v.angle || ""), 200) })), mode: "llm" };
  } catch (e) {
    return {
      variants: [{ headline: "生成失败已回退", angle: `模型调用失败：${String(e.message || e)}` }],
      mode: "local",
    };
  }
}

export function createGrowMock({ db, prefix, secret }) {
  initGrowMockSchema(db);

  // 队列语义：要人动手的（pending / ai_generated）排最前，其余按最近动过的排。
  const qList = db.prepare(`
    SELECT * FROM grow_experiments
    ORDER BY (status IN ('pending','ai_generated')) DESC, COALESCE(updated_at, created_at) DESC`);
  const qGet = db.prepare(`SELECT * FROM grow_experiments WHERE id=?`);
  const qSetVariants = db.prepare(`UPDATE grow_experiments SET ai_variants=?, ai_generated_at=?, updated_at=? WHERE id=?`);
  const qDecide = db.prepare(`UPDATE grow_experiments SET status=?, human_note=?, decided_at=?, updated_at=? WHERE id=?`);
  const qReport = db.prepare(`UPDATE grow_experiments SET status='measured', result_ctr=?, result_cvr=?, result_gmv=?, result_source=?, reported_at=?, updated_at=? WHERE id=?`);

  async function handle(req, res, { path, url, llm, now }) {
    if (!path.startsWith(prefix)) return false;
    const bearer = String(req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
    if (!secret || bearer !== secret) return send(res, 401, { error: "unauthorized" }), true;

    const rel = path.slice(prefix.length);
    if (rel === "/experiments" && req.method === "GET") {
      const items = qList.all().map((r) => ({ ...r, ai_variants: r.ai_variants ? JSON.parse(r.ai_variants) : null }));
      return send(res, 200, { items }), true;
    }

    const seg = rel.slice(1).split("/");
    const id = decodeURIComponent(seg[0] || "");
    const action = seg[1] || "";
    if (!id) return false;
    const row = qGet.get(id);
    if (!row) return send(res, 404, { error: "not found" }), true;

    if (action === "generate" && req.method === "POST") {
      const g = await llmVariants(row, llm);
      qSetVariants.run(JSON.stringify(g.variants), now, now, id);
      if (row.status === "pending") qDecide.run("ai_generated", null, null, now, id);
      return send(res, 200, { id, variants: g.variants, mode: g.mode }), true;
    }
    if (action === "approve" && req.method === "POST") {
      if (row.status === "approved" || row.status === "measured") return send(res, 409, { error: `已处理过（当前状态 ${row.status}）` }), true;
      let body = {}; try { body = await readJson(req); } catch {}
      qDecide.run("approved", clip(body.note, 500) || null, now, now, id);
      return send(res, 200, { id, status: "approved" }), true;
    }
    if (action === "reject" && req.method === "POST") {
      if (row.status === "approved" || row.status === "measured") return send(res, 409, { error: `已处理过（当前状态 ${row.status}）` }), true;
      let body = {}; try { body = await readJson(req); } catch {}
      qDecide.run("rejected", clip(body.note, 500) || null, now, now, id);
      return send(res, 200, { id, status: "rejected" }), true;
    }
    if (action === "report" && req.method === "POST") {
      if (row.status !== "approved") return send(res, 409, { error: "只有已批准的实验才能回填结果" }), true;
      let body = {}; try { body = await readJson(req); } catch {}
      const source = clip(body.source, 100) || "人工补录（无真实渠道回传）";
      qReport.run(Number(body.ctr) || 0, Number(body.cvr) || 0, Number(body.gmv) || 0, source, now, now, id);
      return send(res, 200, { id, status: "measured", result_source: source }), true;
    }
    if (!action && req.method === "GET") return send(res, 200, { ...row, ai_variants: row.ai_variants ? JSON.parse(row.ai_variants) : null }), true;
    return false;
  }

  return { handle };
}
