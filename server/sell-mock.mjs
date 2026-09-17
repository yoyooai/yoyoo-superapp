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

/**
 * 种子任务 —— 覆盖 6 大区、4 种客户分层、3 条品牌线、全部 4 种生命周期状态。
 *
 * 为什么不是 3 条：3 条只能证明链路通，证明不了"这是个在被真实经营的盘子"。
 * 队列里必须同时有「等AI出建议」「AI出了建议等人拍板」「人已批」「人已否」四种
 * 状态并存，往前翻还得有一个月的历史，工作台才不是刚装好的空壳。
 *
 * `days_ago` 把记录铺在过去 32 天里，所以"本周新增""近30天决策"这类分区
 * 有真东西可算，不是所有记录都挤在同一秒。
 *
 * 🔴 这些是**种子数据不是真实客户订单**，来源标注见 SPEC 附录：
 *    「真实数据+人工补录+少量Mock，每处标明来源」。接入真实 ERP 时整块换掉。
 */
const SEED_TASKS = [
  // ── 等 AI 出建议（pending，无报价）──────────────────────────
  {
    seed_key: "weinuoji-jinghua-xufu",
    customer_name: "薇诺纪（华东连锁美妆集合店）",
    customer_region: "华东", customer_tier: "战略客户",
    request_text: "老客户续采，想要补 300 支「妆舟-镇静修护精华」，但预算比上次紧，问能不能在保持利润的前提下给个更好的价格，另外问了下有没有搭配的新品可以一起推。",
    sku_name: "妆舟-镇静修护精华 30ml",
    sku_cost: 38, sku_list_price: 89, sku_stock: 1200,
    status: "pending", days_ago: 0,
  },
  {
    seed_key: "guangyu-yaoyaoshui-shishui",
    customer_name: "光遇美妆（区域连锁，华南）",
    customer_region: "华南", customer_tier: "普通客户",
    request_text: "新客户第一次下单试水，想先拿 50 支摇摇水的爆款单品试销，问起订量和账期，态度比较谨慎，需要一份稳妥、不激进的报价和说明。",
    sku_name: "摇摇水-清透控油喷雾 100ml",
    sku_cost: 22, sku_list_price: 59, sku_stock: 3400,
    status: "pending", days_ago: 1,
  },
  {
    seed_key: "jiansu-lihe-dujia",
    customer_name: "见素（精品买手店，华北）",
    customer_region: "华北", customer_tier: "普通客户",
    request_text: "对方是精品买手店，量不大但要求陈列独家、包装要有档次感，问能不能给一批「妆舟-镇静修护精华」的礼盒装，数量 80 支，且明确要求价格不能对外泄露给同区域其它渠道。",
    sku_name: "妆舟-镇静修护精华 礼盒装 30ml×2",
    sku_cost: 70, sku_list_price: 169, sku_stock: 260,
    status: "pending", days_ago: 2,
  },
  {
    seed_key: "lanxu-zhibo-gongyinglian",
    customer_name: "岚序（直播供应链，华南·广州）",
    customer_region: "华南", customer_tier: "新客户",
    request_text: "直播机构来问坑位备货，说下周有一场美妆专场，想要摇摇水喷雾备 2000 支，但要求「卖不掉可退」。对方没做过我们的品，退货条款这块需要谨慎，不能照着老客户的条件给。",
    sku_name: "摇摇水-清透控油喷雾 100ml",
    sku_cost: 22, sku_list_price: 59, sku_stock: 3400,
    status: "pending", days_ago: 3,
  },

  // ── AI 已出建议，等人拍板（pending + 已有报价）────────────────
  {
    seed_key: "huahe-mianshuang-buhuo",
    customer_name: "花禾集（连锁，西南·成都）",
    customer_region: "西南", customer_tier: "战略客户",
    request_text: "上一批屏障修护面霜两周就动销完了，这次直接要 500 件，希望能锁一个季度的价格不要中途涨。对方是我们西南最稳的盘子，续约在即。",
    sku_name: "妆舟-屏障修护面霜 50g",
    sku_cost: 45, sku_list_price: 129, sku_stock: 860,
    status: "pending", days_ago: 4,
    ai_quote_amount: 76, ai_quote_reason: "战略客户+500件规模+锁价一季度：按成本1.69倍定价，毛利率40.8%在安全线之上；锁价风险已计入（原料端三个月内无明显涨价预期）。建议接受锁价但写明「原料涨幅超15%可重议」。",
    ai_days_ago: 4,
  },
  {
    seed_key: "shiguang-ka-shangchao",
    customer_name: "拾光美妆（KA商超，华东·上海）",
    customer_region: "华东", customer_tier: "KA客户",
    request_text: "KA 采购提了年框续签，要求在去年基础上再降 8 个点，换取门店数从 42 家扩到 60 家。降点幅度不小，需要算清楚扩店带来的增量能不能覆盖掉降价的损失。",
    sku_name: "叁时-冻干安瓶面膜 5片装",
    sku_cost: 32, sku_list_price: 99, sku_stock: 2100,
    status: "pending", days_ago: 6,
    ai_quote_amount: 58, ai_quote_reason: "⚠️ 降8个点后单价58元，毛利率44.8%仍安全，但需注意：扩店18家的增量必须真实兑现才划算。建议报价挂钩门店数——不足55家时价格回调，写进年框附件。",
    ai_days_ago: 6,
  },
  {
    seed_key: "muMianji-lianso-changsha",
    customer_name: "木棉集（连锁，华中·长沙）",
    customer_region: "华中", customer_tier: "普通客户",
    request_text: "想上次抛精华这个品，但担心客单价太高在长沙卖不动，问能不能先给 100 盒小批量试，卖得动再追加，另外问有没有试用装可以配。",
    sku_name: "妆舟-玻尿酸次抛精华 30支装",
    sku_cost: 60, sku_list_price: 199, sku_stock: 480,
    status: "pending", days_ago: 7,
    ai_quote_amount: 118, ai_quote_reason: "小批量试销100盒：按成本1.97倍定价，毛利率49.2%。小批量不给最优价是对的（否则追加时无法涨回），但建议附赠30份试用装降低对方试错顾虑——试用装成本约240元，远低于丢掉这个渠道的代价。",
    ai_days_ago: 7,
  },

  // ── 人已批准（approved）──────────────────────────────────
  {
    seed_key: "yujian-mianmo-shoudan",
    customer_name: "屿见生活（买手店，华东·杭州）",
    customer_region: "华东", customer_tier: "普通客户",
    request_text: "首单要 120 盒冻干安瓶面膜，对方门店调性偏文艺，希望包装能配合她们的陈列做一版素色外箱。",
    sku_name: "叁时-冻干安瓶面膜 5片装",
    sku_cost: 32, sku_list_price: 99, sku_stock: 2100,
    status: "approved", days_ago: 9, decided_days_ago: 8,
    ai_quote_amount: 62, ai_quote_reason: "首单120盒按成本1.94倍定价，毛利率48.4%。素色外箱属定制需求，建议一次性收200元版费而非摊进单价——摊进去会让后续追加单价降不下来。",
    ai_days_ago: 9,
    human_note: "同意。版费我免了，换她们门店首页陈列位两个月，比200块划算。",
  },
  {
    seed_key: "chaoxi-cs-shenzhen",
    customer_name: "潮汐美研（CS渠道，华南·深圳）",
    customer_region: "华南", customer_tier: "战略客户",
    request_text: "季度补货，喷雾 800 支 + 洁面 600 支打包走，希望打包价能比单品分别下单便宜一些。",
    sku_name: "摇摇水-清透控油喷雾 100ml",
    sku_cost: 22, sku_list_price: 59, sku_stock: 3400,
    status: "approved", days_ago: 12, decided_days_ago: 11,
    ai_quote_amount: 36, ai_quote_reason: "打包1400件的规模：喷雾按成本1.64倍定价，毛利率38.9%。打包让利控制在4%以内即可，对方要的是「有折扣」这个动作本身，不是折扣幅度。",
    ai_days_ago: 12,
    human_note: "按36批了。这家是华南动销最快的，价格稳住比多赚两块重要。",
  },
  {
    seed_key: "beian-lianso-shenyang",
    customer_name: "北岸集合（连锁，东北·沈阳）",
    customer_region: "东北", customer_tier: "普通客户",
    request_text: "冬季主推屏障修护，要 300 件面霜。东北市场干燥，对方希望能提供一份「冬季屏障护理」的导购话术配合销售。",
    sku_name: "妆舟-屏障修护面霜 50g",
    sku_cost: 45, sku_list_price: 129, sku_stock: 860,
    status: "approved", days_ago: 15, decided_days_ago: 14,
    ai_quote_amount: 79, ai_quote_reason: "300件常规量按成本1.76倍定价，毛利率43%。导购话术属内容支持不是折扣，成本极低但能显著提升动销——建议答应，并把这套话术沉淀成可复用物料给其它北方渠道。",
    ai_days_ago: 15,
    human_note: "批了。话术让 Grow 那边出一版，北方几家都能用，别只给沈阳。",
  },
  {
    seed_key: "sanko-dianshang-wuhan",
    customer_name: "三蔻优选（电商分销，华中·武汉）",
    customer_region: "华中", customer_tier: "普通客户",
    request_text: "做电商分销，要 400 盒面膜上自己的店铺，问能不能给控价授权，怕别家乱价把盘子打烂。",
    sku_name: "叁时-冻干安瓶面膜 5片装",
    sku_cost: 32, sku_list_price: 99, sku_stock: 2100,
    status: "approved", days_ago: 20, decided_days_ago: 19,
    ai_quote_amount: 60, ai_quote_reason: "400盒电商分销按成本1.88倍定价，毛利率46.7%。控价授权应当给——线上乱价的损失远大于这一单利润，但必须写明违约条款（低于建议零售价8折即终止供货）。",
    ai_days_ago: 20,
    human_note: "价格和控价条款都同意，违约条款按AI建议写进合同了。",
  },
  {
    seed_key: "yunji-ka-beijing",
    customer_name: "昀集（KA渠道，华北·北京）",
    customer_region: "华北", customer_tier: "KA客户",
    request_text: "年中大促备货，精华 600 支，要求账期从 30 天延到 60 天。",
    sku_name: "妆舟-镇静修护精华 30ml",
    sku_cost: 38, sku_list_price: 89, sku_stock: 1200,
    status: "approved", days_ago: 26, decided_days_ago: 24,
    ai_quote_amount: 64, ai_quote_reason: "600支按成本1.68倍定价，毛利率40.6%。⚠️ 账期从30延到60天等于多占用约2.3万现金两个月，建议要么价格上浮2元覆盖资金成本，要么维持30天账期——不要两样都让。",
    ai_days_ago: 26,
    human_note: "按64走，账期给到45天不是60天，对方接受了。AI提醒的资金占用这点提得对。",
  },

  // ── 人已否决（rejected）──────────────────────────────────
  {
    seed_key: "suye-xibei-xian",
    customer_name: "素野（精品店，西北·西安）",
    customer_region: "西北", customer_tier: "新客户",
    request_text: "新店开业，想要次抛精华 40 盒，但希望按「先铺货后结算、卖不掉全退」的方式合作。",
    sku_name: "妆舟-玻尿酸次抛精华 30支装",
    sku_cost: 60, sku_list_price: 199, sku_stock: 480,
    status: "rejected", days_ago: 17, decided_days_ago: 16,
    ai_quote_amount: 128, ai_quote_reason: "⚠️ 报价可行（毛利率53%），但「先铺货后结算+全退」对新客户风险过高：次抛有效期18个月，退回的货二次销售窗口被压缩。建议改为现结+30%滞销可退。",
    ai_days_ago: 17,
    human_note: "否了。不是价格问题，是全退这个条件不能开口子——开了一家，西北其它几家都会照着要。让业务去谈现结方案。",
  },
  {
    seed_key: "langu-maishoudian-chongqing",
    customer_name: "澜谷生活馆（买手店，西南·重庆）",
    customer_region: "西南", customer_tier: "普通客户",
    request_text: "想拿 60 支精华，但要求价格对标某电商平台的百亿补贴价，说不给这个价就不进。",
    sku_name: "妆舟-镇静修护精华 30ml",
    sku_cost: 38, sku_list_price: 89, sku_stock: 1200,
    status: "rejected", days_ago: 22, decided_days_ago: 21,
    ai_quote_amount: 44, ai_quote_reason: "🔴 对方要求的对标价约42元，成本38元，毛利率仅9.5%——**低于15%毛利底线，不可接受**。即使按底线44元报价，毛利率也只有13.6%，仍不达标。建议拒绝或改推低成本单品。",
    ai_days_ago: 22,
    human_note: "拒了。百亿补贴是平台在贴钱，不是我们的成本结构，这个锚不能认。给她推了摇摇水那条线，量小价低更合适。",
  },
];

const DAY = 86_400_000;

/**
 * 幂等补种。
 *
 * 🔴 为什么不是原来那句 `if (count === 0)`：线上库里已经有被苏白真实点过的记录
 *    （approved/rejected 都有）。`count===0` 意味着**只要表非空就永远不再补种**——
 *    这一批新增的 11 条种子永远进不去线上，本地看着满满当当、线上还是 3 条。
 *
 *    改成按 `seed_key` 幂等：老的 3 条先按客户名回填 seed_key 认领回来（它们身上
 *    可能带着真实操作痕迹，必须保留不能重插），然后整批 INSERT OR IGNORE ——
 *    已存在的跳过，缺的补上。重复部署多少次结果都一样。
 */
export function initSellMockSchema(db, nowMs) {
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

  // seed_key 是后加的列。ADD COLUMN 不能直接带 UNIQUE，所以列加完再建唯一索引，
  // 两步都幂等，重复跑不会报错。
  const cols = db.prepare(`PRAGMA table_info(sell_tasks)`).all().map((c) => c.name);
  if (!cols.includes("seed_key")) {
    db.exec(`ALTER TABLE sell_tasks ADD COLUMN seed_key TEXT`);
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sell_seed_key ON sell_tasks(seed_key) WHERE seed_key IS NOT NULL`);

  const now = nowMs || Date.now();

  // 老种子认领：按客户名把 seed_key 补回去，这样下面的 INSERT OR IGNORE 会跳过它们，
  // 它们身上的 approved/human_note 等真实痕迹原样保留。
  const claim = db.prepare(`UPDATE sell_tasks SET seed_key=? WHERE customer_name=? AND seed_key IS NULL`);
  for (const t of SEED_TASKS) claim.run(t.seed_key, t.customer_name);

  const ins = db.prepare(`
    INSERT OR IGNORE INTO sell_tasks
      (id,seed_key,customer_name,customer_region,customer_tier,request_text,
       sku_name,sku_cost,sku_list_price,sku_stock,
       ai_quote_amount,ai_quote_reason,ai_generated_at,
       status,human_note,decided_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  for (const t of SEED_TASKS) {
    const created = now - (t.days_ago || 0) * DAY;
    const decided = t.decided_days_ago != null ? now - t.decided_days_ago * DAY : null;
    const aiAt = t.ai_days_ago != null ? now - t.ai_days_ago * DAY : null;
    ins.run(
      randomUUID(), t.seed_key, t.customer_name, t.customer_region, t.customer_tier, t.request_text,
      t.sku_name, t.sku_cost, t.sku_list_price, t.sku_stock,
      t.ai_quote_amount ?? null, t.ai_quote_reason ?? null, aiAt,
      t.status || "pending", t.human_note ?? null, decided,
      created, decided || aiAt || created,
    );
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

  // 队列语义：待办的排最上面，其余按最近动过的排前面。
  // （原来是 created_at ASC，最老的一条顶在队首——种子只有3条时看不出问题，
  //  扩到14条以后队首是一个月前已经决策完的单子，等于让人先看垃圾。）
  const qList = db.prepare(`
    SELECT * FROM sell_tasks
    ORDER BY (status = 'pending') DESC, COALESCE(updated_at, created_at) DESC`);
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
