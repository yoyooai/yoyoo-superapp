/**
 * Sell Loop 的"客户业务系统"桩 —— 09-03 美妆种子用户验收的第一个真实工作台。
 *
 * 二元现在还没有一套可对接的真实 ToB 系统 API（SPEC 附录允许"真实数据+人工补录+
 * 少量Mock，每处标明来源"），所以这里先起一个**结构真实、内容是种子数据**的桩，
 * 挂在我们自己域名下、用连接器去接它——这不是走个过场：它验证的是"连接器+script
 * 沙盒"这条新机制的完整链路（注册连接器→加密存密钥→script 里发起调用→代理转发→
 * 真实业务系统响应→人工批准/修改→写回结果），跟接一个真的客户 ERP 除了"桩不是真系统"
 * 这一点，别的地方完全一样。等接进真实客户系统时，换掉的只是这一个模块的实现，
 * 连接器/script 那一层不用动一行。
 *
 * 字段对齐 SPEC-ai-manual-and-authoring.md 之外的另一份唯二真源——
 * 「二元 AI Native 美妆经营内核」文档 §4.4 Company Memory 数据模型 Customer/SKU 表：
 *   Customer: id/类型/区域/历史订单/偏好/限制
 *   SKU:      id/品牌/品类/价格/功效/库存/成本
 * 这里只取 Sell 流程真正要用到的子集，不是照抄整份 schema。
 */
import { randomUUID } from "node:crypto";
import { send, readJson, clip } from "./http-util.mjs";

/** 3-5 个高频客户的种子任务——SPEC §3.2「只选3-5个高频客户，不要全量迁移」 */
const SEED_TASKS = [
  {
    customer_name: "薇诺纪（华东连锁美妆集合店）",
    customer_region: "华东",
    customer_tier: "战略客户",
    request_text: "老客户续采，想要补 300 支「妆舟-镇静修护精华」，但预算比上次紧，问能不能在保持利润的前提下给个更好的价格，另外问了下有没有搭配的新品可以一起推。",
    sku_name: "妆舟-镇静修护精华 30ml",
    sku_cost: 38, sku_list_price: 89, sku_stock: 1200,
  },
  {
    customer_name: "光遇美妆（区域连锁，华南）",
    customer_region: "华南",
    customer_tier: "普通客户",
    request_text: "新客户第一次下单试水，想先拿 50 支摇摇水的爆款单品试销，问起订量和账期，态度比较谨慎，需要一份稳妥、不激进的报价和说明。",
    sku_name: "摇摇水-清透控油喷雾 100ml",
    sku_cost: 22, sku_list_price: 59, sku_stock: 3400,
  },
  {
    customer_name: "见素（精品买手店，华北）",
    customer_region: "华北",
    customer_tier: "普通客户",
    request_text: "对方是精品买手店，量不大但要求陈列独家、包装要有档次感，问能不能给一批「妆舟-镇静修护精华」的礼盒装，数量 80 支，且明确要求价格不能对外泄露给同区域其它渠道。",
    sku_name: "妆舟-镇静修护精华 礼盒装 30ml×2",
    sku_cost: 70, sku_list_price: 169, sku_stock: 260,
  },
];

export function initSellMockSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sell_tasks (
      id              TEXT PRIMARY KEY,
      customer_name   TEXT NOT NULL,
      customer_region TEXT,
      customer_tier   TEXT,
      request_text    TEXT NOT NULL,
      sku_name        TEXT,
      sku_cost        REAL,
      sku_list_price  REAL,
      sku_stock       INTEGER,
      ai_quote_amount REAL,
      ai_quote_reason TEXT,
      ai_generated_at INTEGER,
      status          TEXT NOT NULL DEFAULT 'pending',
      human_note      TEXT,
      decided_at      INTEGER,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
  `);
  const count = db.prepare(`SELECT COUNT(*) AS n FROM sell_tasks`).get().n;
  if (count === 0) {
    const ins = db.prepare(`
      INSERT INTO sell_tasks (id,customer_name,customer_region,customer_tier,request_text,
        sku_name,sku_cost,sku_list_price,sku_stock,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?)`);
    const now = Date.now();
    for (const t of SEED_TASKS) {
      ins.run(randomUUID(), t.customer_name, t.customer_region, t.customer_tier, t.request_text,
        t.sku_name, t.sku_cost, t.sku_list_price, t.sku_stock, now, now);
    }
  }
}

async function llmQuote({ customer_name, customer_tier, request_text, sku_name, sku_cost, sku_list_price, sku_stock }, llm) {
  const prompt = `你是美妆经销业务的报价助手。基于以下信息生成一份报价建议，返回 JSON：
{"quote_amount": 单价数字(元), "reason": "一句话中文报价理由，需体现客户分层/毛利安全线/库存情况"}
毛利底线：单价不得低于成本的 1.15 倍。
客户：${customer_name}（${customer_tier}）
需求：${request_text}
商品：${sku_name}，成本 ¥${sku_cost}，标准零售价 ¥${sku_list_price}，库存 ${sku_stock} 件`;

  if (!llm?.apiKey) {
    // 本地兜底：成本*1.3，四舍五入到整数，保证不低于毛利底线
    const amount = Math.max(Math.round(sku_cost * 1.3), Math.ceil(sku_cost * 1.15));
    return { quote_amount: amount, reason: "（本地兜底：未接真模型）按成本1.3倍估算，已守住成本1.15倍的毛利底线" };
  }
  try {
    const res = await fetch(`${llm.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${llm.apiKey}` },
      body: JSON.stringify({
        model: llm.model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`模型网关 ${res.status}`);
    const body = await res.json();
    const text = body?.choices?.[0]?.message?.content || "";
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("模型没返回可解析 JSON");
    const parsed = JSON.parse(m[0]);
    const amount = Number(parsed.quote_amount);
    if (!Number.isFinite(amount) || amount < sku_cost * 1.15) {
      return { quote_amount: Math.ceil(sku_cost * 1.15), reason: `模型报价未通过毛利底线复核，已改用成本1.15倍兜底（模型原话：${String(parsed.reason || "").slice(0, 100)}）` };
    }
    return { quote_amount: amount, reason: clip(String(parsed.reason || ""), 300) };
  } catch (e) {
    const amount = Math.max(Math.round(sku_cost * 1.3), Math.ceil(sku_cost * 1.15));
    return { quote_amount: amount, reason: `（模型调用失败：${String(e.message || e)}，已回退本地估算）按成本1.3倍估算` };
  }
}

/**
 * 挂在 `${prefix}` 下（比如 `${ROOT}/demo/sell-backend`）。
 * 只认一把共享密钥（`Authorization: Bearer <secret>`）——证明"连接器的凭据真的到了
 * 业务系统这一侧、且被真的校验"，不是摆设。
 */
export function createSellMock({ db, prefix, secret }) {
  initSellMockSchema(db);

  const qList = db.prepare(`SELECT * FROM sell_tasks ORDER BY created_at ASC`);
  const qGet = db.prepare(`SELECT * FROM sell_tasks WHERE id=?`);
  const qSetQuote = db.prepare(`UPDATE sell_tasks SET ai_quote_amount=?, ai_quote_reason=?, ai_generated_at=?, updated_at=? WHERE id=?`);
  const qDecide = db.prepare(`UPDATE sell_tasks SET status=?, human_note=?, decided_at=?, updated_at=? WHERE id=?`);

  async function handle(req, res, { path, url, llm, now }) {
    if (!path.startsWith(prefix)) return false;

    const bearer = String(req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
    if (!secret || bearer !== secret) {
      return send(res, 401, { error: "unauthorized" }), true;
    }

    const rel = path.slice(prefix.length);

    if (rel === "/tasks" && req.method === "GET") {
      return send(res, 200, { items: qList.all() }), true;
    }

    const seg = rel.slice(1).split("/");
    const id = decodeURIComponent(seg[0] || "");
    const action = seg[1] || "";
    if (!id) return false;

    const row = qGet.get(id);
    if (!row) return send(res, 404, { error: "not found" }), true;

    if (action === "recommend" && req.method === "POST") {
      const q = await llmQuote(row, llm);
      qSetQuote.run(q.quote_amount, q.reason, now, now, id);
      return send(res, 200, { id, ai_quote_amount: q.quote_amount, ai_quote_reason: q.reason }), true;
    }
    if (action === "approve" && req.method === "POST") {
      if (row.status !== "pending") return send(res, 409, { error: `已处理过（当前状态 ${row.status}）` }), true;
      let body = {}; try { body = await readJson(req); } catch {}
      qDecide.run("approved", clip(body.note, 500) || null, now, now, id);
      return send(res, 200, { id, status: "approved" }), true;
    }
    if (action === "reject" && req.method === "POST") {
      if (row.status !== "pending") return send(res, 409, { error: `已处理过（当前状态 ${row.status}）` }), true;
      let body = {}; try { body = await readJson(req); } catch {}
      qDecide.run("rejected", clip(body.note, 500) || null, now, now, id);
      return send(res, 200, { id, status: "rejected" }), true;
    }
    if (!action && req.method === "GET") {
      return send(res, 200, row), true;
    }
    return false;
  }

  return { handle };
}
