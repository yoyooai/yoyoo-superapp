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

/** 2 条子场景种子——摇摇水内容 + 妆舟私域，对应文档 §3.3 两条子场景 */
const SEED_EXPERIMENTS = [
  {
    brand: "摇摇水", channel: "抖音",
    insight: "近两周后台咨询里「油皮夏天不敢用喷雾怕闷痘」这句话反复出现，但现有素材都在讲「清爽」，没人正面回应「闷痘」这个具体顾虑。",
    audience: "18-28岁油痘肌，一二线城市",
  },
  {
    brand: "妆舟", channel: "私域(企业微信)",
    insight: "私域里被问最多的问题是「这个精华孕期能不能用」，但商详页和客服话术都没有明确口径，导致这批高意向咨询大概率流失。",
    audience: "备孕/孕期用户，私域老客",
  },
];

export function initGrowMockSchema(db) {
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
  const count = db.prepare(`SELECT COUNT(*) AS n FROM grow_experiments`).get().n;
  if (count === 0) {
    const ins = db.prepare(`
      INSERT INTO grow_experiments (id,brand,channel,audience,insight,status,created_at,updated_at)
      VALUES (?,?,?,?,?,'pending',?,?)`);
    const now = Date.now();
    for (const e of SEED_EXPERIMENTS) {
      ins.run(randomUUID(), e.brand, e.channel, e.audience, e.insight, now, now);
    }
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

  const qList = db.prepare(`SELECT * FROM grow_experiments ORDER BY created_at ASC`);
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
