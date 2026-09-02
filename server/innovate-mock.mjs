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

const SEED_OPPORTUNITY = {
  title: "油痘肌「怕闷痘」焦虑 → 轻量控油喷雾类目机会",
  evidence_source: "Grow工作台·摇摇水内容实验的用户洞察（同一条，手动抄录，非自动打通）",
  evidence_text: "近两周私域/客服咨询里反复出现「油皮夏天不敢用喷雾怕闷痘」，但现有产品线没有专门针对「轻量不闷痘」定位的单品，属于未被满足的细分需求。",
  score: 6,
};

export function initInnovateMockSchema(db) {
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
  const count = db.prepare(`SELECT COUNT(*) AS n FROM innovate_opportunities`).get().n;
  if (count === 0) {
    db.prepare(`
      INSERT INTO innovate_opportunities (id,title,evidence_source,evidence_text,score,status,created_at,updated_at)
      VALUES (?,?,?,?,?,'new',?,?)`).run(
      randomUUID(), SEED_OPPORTUNITY.title, SEED_OPPORTUNITY.evidence_source,
      SEED_OPPORTUNITY.evidence_text, SEED_OPPORTUNITY.score, Date.now(), Date.now());
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

  const qList = db.prepare(`SELECT * FROM innovate_opportunities ORDER BY created_at ASC`);
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
