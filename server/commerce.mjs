/**
 * 「收钱」—— 套餐 / 订单 / 开通。
 *
 * ── 为什么现在做这一层（苏白 2026-09-14）─────────────────────
 * 实查过：这个库里**一张订单表都没有**（plans / orders / 用量 / 额度，一个都不存在）。
 * 不是"做得不好"，是这条链压根不存在 —— 平台今天卖不了任何东西。
 *
 * ── 🔴 这一层只做"不碰钱"的那一段 ──────────────────────────
 * 收款主体和支付密钥在苏白手上（他 09-14 原话「这些都在我手上」），还没给。
 * 所以这一版**刻意不含任何支付通道**：下单之后订单停在「等付款」，
 * 谁也不能把它变成「已付」——除非将来真的接上支付回调。
 * 🔴 绝不给一个"标记为已付"的后门。那种后门上线第一天就会被用来"先开通后补钱"，
 *    然后所有人都会忘了它是个后门。付没付钱只有一个真源：支付平台的回调。
 *
 * ── 三件刻意的取舍 ─────────────────────────────────────────
 *  1. **钱一律用整数分**（`price_cents`）。浮点数算钱迟早差一分，
 *     而差一分在账上就是一笔要人去查的烂账。
 *  2. **开通必须由订单驱动**：`entitlements` 行必须挂在一个 `order_id` 上。
 *     没有订单的开通＝没人说得清这个人为什么有这个权益。
 *  3. **套餐改价不影响已下的单**：订单落库时把当时的名称与金额**抄一份进去**
 *     （`plan_name_at` / `amount_cents`）。
 *     🔴 不抄的话，今天调一次价，历史订单的金额会跟着一起变 —— 那是改账本。
 */
/* ⚠️ 建表那段 SQL 在模板字符串里 —— 注释中一律不许用反引号（同 theme.tsx 那条）。
   写了就会把模板字符串提前截断，报一个指向别处的语法错。 */
import { send, readJson, clip } from "./http-util.mjs";

/** 订单状态。**没有 paid 的入口**，见文件头第二段。 */
const ORDER_STATES = new Set(["pending", "paid", "cancelled", "refunded"]);
/** 一次能买几份 —— 上限只是防手滑/防刷，不是业务规则。 */
const MAX_QTY = 99;

export function initCommerceSchema(db) {
  db.exec(`
    /*
     * 套餐 —— 卖什么。
     * 🔴 price_cents 是**整数分**（见文件头）。period 只有三种，别再加"永久"：
     *    "永久"在账上是一个没有终点的义务，要卖也得是 once + 明确写清楚给多久。
     */
    CREATE TABLE IF NOT EXISTS plans (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      summary       TEXT,                  -- 一句话：买了得到什么
      price_cents   INTEGER NOT NULL,      -- 整数分。0 = 免费套餐（合法）
      currency      TEXT NOT NULL DEFAULT 'CNY',
      period        TEXT NOT NULL,         -- month | year | once
      features_json TEXT,                  -- 给人看的清单 ["10 台 AI","优先支持"]
      quota_json    TEXT,                  -- 给机器看的额度 {"agents":10}
      status        TEXT NOT NULL,         -- on | off（下架不删，历史订单还指着它）
      sort_order    INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );

    /*
     * 订单 —— 谁要买什么。
     * 🔴 plan_name_at / amount_cents 是**下单那一刻抄下来的**，不是查出来的：
     *    套餐以后改名改价，这张单子上的字不许跟着变（见文件头第 3 条）。
     * 🔴 pay_ref 只能由支付回调写。这一版没有回调 ⇒ 它永远是空的，
     *    而没有 pay_ref 的订单**不可能**是 paid（下面 markPaid 里钉死）。
     */
    CREATE TABLE IF NOT EXISTS orders (
      id            TEXT PRIMARY KEY,
      uid           TEXT NOT NULL,
      plan_id       TEXT NOT NULL,
      plan_name_at  TEXT NOT NULL,
      qty           INTEGER NOT NULL,
      amount_cents  INTEGER NOT NULL,      -- 单价 × 份数，下单时算好抄下来
      currency      TEXT NOT NULL,
      status        TEXT NOT NULL,         -- pending | paid | cancelled | refunded
      pay_method    TEXT,                  -- 将来：wechat | alipay …
      pay_ref       TEXT,                  -- 支付平台那边的单号（只有回调能写）
      note          TEXT,
      created_at    INTEGER NOT NULL,
      paid_at       INTEGER,
      closed_at     INTEGER,
      updated_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_orders_uid ON orders(uid, created_at);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

    /*
     * 开通了什么 —— 付完钱之后这个人得到的东西。
     * 🔴 必须挂在一张订单上（order_id NOT NULL）：没有订单的权益，
     *    日后没人说得清他为什么有。要送人情也得先开一张 0 元订单，留下痕迹。
     */
    CREATE TABLE IF NOT EXISTS entitlements (
      id         TEXT PRIMARY KEY,
      uid        TEXT NOT NULL,
      plan_id    TEXT NOT NULL,
      order_id   TEXT NOT NULL,
      state      TEXT NOT NULL,            -- active | expired | revoked
      quota_json TEXT,
      start_at   INTEGER NOT NULL,
      end_at     INTEGER,                  -- null = 不过期（once 类套餐）
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_entitlements_uid ON entitlements(uid, state);
  `);
}

const newId = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const intOr = (v, d) => { const n = Number(v); return Number.isInteger(n) ? n : d; };

export function createCommerce({ db, now = Date.now }) {
  initCommerceSchema(db);
  const nowSec = () => Math.floor(now() / 1000);

  const q = {
    listPlans: db.prepare(`SELECT * FROM plans WHERE status='on' ORDER BY sort_order, created_at`),
    allPlans: db.prepare(`SELECT * FROM plans ORDER BY sort_order, created_at`),
    getPlan: db.prepare(`SELECT * FROM plans WHERE id = ?`),
    insertOrder: db.prepare(`
      INSERT INTO orders (id, uid, plan_id, plan_name_at, qty, amount_cents, currency,
                          status, note, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,'pending',?,?,?)`),
    getOrder: db.prepare(`SELECT * FROM orders WHERE id = ?`),
    listOrders: db.prepare(`SELECT * FROM orders WHERE uid = ? ORDER BY created_at DESC LIMIT ?`),
    cancelOrder: db.prepare(`
      UPDATE orders SET status='cancelled', closed_at=?, updated_at=?
       WHERE id=? AND uid=? AND status='pending'`),
    listEnt: db.prepare(`SELECT * FROM entitlements WHERE uid = ? AND state='active' ORDER BY created_at DESC`),
  };

  const shapePlan = (r) => ({
    id: r.id, name: r.name, summary: r.summary || null,
    price_cents: r.price_cents, currency: r.currency, period: r.period,
    features: safeArr(r.features_json), quota: safeObj(r.quota_json),
    status: r.status,
  });
  const shapeOrder = (r) => ({
    id: r.id, plan_id: r.plan_id, plan_name: r.plan_name_at, qty: r.qty,
    amount_cents: r.amount_cents, currency: r.currency, status: r.status,
    /* 🔴 界面要能照实说"这单还没付钱"，所以把"为什么还没付"一起给出去，
       而不是让界面自己猜一句好听的。 */
    pay_hint: r.status === "pending" ? "等付款（这个平台还没接上支付，暂时收不了钱）" : null,
    pay_method: r.pay_method || null, pay_ref: r.pay_ref || null,
    created_at: r.created_at, paid_at: r.paid_at || null, closed_at: r.closed_at || null,
  });
  function safeArr(s) { try { const v = JSON.parse(s || "[]"); return Array.isArray(v) ? v : []; } catch { return []; } }
  function safeObj(s) { try { const v = JSON.parse(s || "{}"); return v && typeof v === "object" ? v : {}; } catch { return {}; } }

  /** 上架一个套餐（运维用，不开放给用户面）。 */
  function upsertPlan(p) {
    const ts = nowSec();
    const id = clip(p.id, 60) || newId("plan");
    const price = intOr(p.price_cents, null);
    if (price == null || price < 0) return { ok: false, reason: "price_cents 必须是不小于 0 的整数分" };
    if (!["month", "year", "once"].includes(p.period)) return { ok: false, reason: "period 只能是 month/year/once" };
    const exist = q.getPlan.get(id);
    const row = {
      name: clip(p.name, 80) || id,
      summary: p.summary ? clip(p.summary, 200) : null,
      features: JSON.stringify(Array.isArray(p.features) ? p.features.slice(0, 20) : []),
      quota: JSON.stringify(p.quota && typeof p.quota === "object" ? p.quota : {}),
      status: p.status === "off" ? "off" : "on",
      sort: intOr(p.sort_order, 0),
    };
    if (exist) {
      db.prepare(`UPDATE plans SET name=?, summary=?, price_cents=?, currency=?, period=?,
                   features_json=?, quota_json=?, status=?, sort_order=?, updated_at=? WHERE id=?`)
        .run(row.name, row.summary, price, clip(p.currency, 8) || "CNY", p.period,
             row.features, row.quota, row.status, row.sort, ts, id);
    } else {
      db.prepare(`INSERT INTO plans (id,name,summary,price_cents,currency,period,
                   features_json,quota_json,status,sort_order,created_at,updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, row.name, row.summary, price, clip(p.currency, 8) || "CNY", p.period,
             row.features, row.quota, row.status, row.sort, ts, ts);
    }
    return { ok: true, id };
  }

  /**
   * 下单。
   * 🔴 只落一张「等付款」的单子，**不开通任何东西**。
   *    开通只能由"真的收到钱"驱动 —— 这一版没有那条路，所以这里也就到此为止。
   */
  function placeOrder({ uid, planId, qty = 1, note = null }) {
    const plan = q.getPlan.get(String(planId || ""));
    if (!plan) return { ok: false, status: 404, reason: "没有这个套餐" };
    if (plan.status !== "on") return { ok: false, status: 409, reason: "这个套餐已经下架了" };
    const n = intOr(qty, 1);
    if (n < 1 || n > MAX_QTY) return { ok: false, status: 400, reason: `份数要在 1~${MAX_QTY} 之间` };
    const ts = nowSec();
    const id = newId("ord");
    /* 🔴 名称和金额在这一刻抄下来（见文件头第 3 条）。 */
    q.insertOrder.run(id, uid, plan.id, plan.name, n, plan.price_cents * n,
                      plan.currency, note ? clip(note, 200) : null, ts, ts);
    return { ok: true, order: shapeOrder(q.getOrder.get(id)) };
  }

  /**
   * 标记已付 —— **只有支付回调能调这个**，而这一版没有回调。
   * 🔴 强制要求 payRef：没有支付平台那边的单号就不算收到钱。
   *    留这个函数不是为了现在用，是为了把"什么条件下才算付了"这条规矩
   *    写在代码里、并且被测试钉住 —— 免得将来接支付时有人图快绕过它。
   */
  function markPaid({ orderId, payMethod, payRef }) {
    const ref = clip(payRef, 120).trim();
    if (!ref) return { ok: false, reason: "没有支付平台的单号，不算收到钱" };
    const method = clip(payMethod, 40).trim();
    if (!method) return { ok: false, reason: "没说是用什么付的" };
    const o = q.getOrder.get(String(orderId || ""));
    if (!o) return { ok: false, reason: "没有这张单子" };
    if (o.status !== "pending") return { ok: false, reason: `这张单子是「${o.status}」，不能再标已付` };
    const ts = nowSec();
    db.prepare(`UPDATE orders SET status='paid', pay_method=?, pay_ref=?, paid_at=?, updated_at=?
                 WHERE id=? AND status='pending'`).run(method, ref, ts, ts, o.id);
    /* 付了才开通，且开通必须挂在这张单子上（见文件头第 2 条）。 */
    const plan = q.getPlan.get(o.plan_id);
    const end = plan?.period === "month" ? ts + 30 * 86400
              : plan?.period === "year" ? ts + 365 * 86400
              : null;
    db.prepare(`INSERT INTO entitlements (id,uid,plan_id,order_id,state,quota_json,start_at,end_at,created_at,updated_at)
                 VALUES (?,?,?,?,'active',?,?,?,?,?)`)
      .run(newId("ent"), o.uid, o.plan_id, o.id, plan?.quota_json || "{}", ts, end, ts, ts);
    return { ok: true };
  }

  /** 用户面。🔴 只看得到自己的单子和自己的权益。 */
  async function handle(req, res, { path, url, uid, root }) {
    const base = `${root}/commerce`;
    if (path !== base && !path.startsWith(`${base}/`)) return false;
    const rest = path.slice(base.length).replace(/^\//, "");

    if (rest === "plans" && req.method === "GET") {
      send(res, 200, {
        plans: q.listPlans.all().map(shapePlan),
        /* 🔴 当面说清楚现在收不了钱 —— 摆一排"立即购买"却收不了钱，
           比不摆更伤人。这句话由服务端给，界面不许自己改软。 */
        can_pay: false,
        why: "还没接上支付：收款主体和密钥还没配。现在能下单，但付不了款。",
      });
      return true;
    }

    if (rest === "orders" && req.method === "GET") {
      const want = intOr(url?.searchParams?.get("limit"), 50);
      send(res, 200, { orders: q.listOrders.all(uid, Math.min(Math.max(want, 1), 200)).map(shapeOrder) });
      return true;
    }

    if (rest === "orders" && req.method === "POST") {
      let body;
      try { body = await readJson(req); } catch { send(res, 400, { error: "bad json" }); return true; }
      const r = placeOrder({ uid, planId: body?.plan_id, qty: body?.qty, note: body?.note });
      if (!r.ok) { send(res, r.status || 400, { error: r.reason }); return true; }
      send(res, 200, {
        order: r.order,
        next: "这张单子记下了，但**现在还付不了款** —— 支付还没接上。接上之后它会出现在你的待付列表里。",
      });
      return true;
    }

    if (rest.startsWith("orders/") && req.method === "DELETE") {
      const id = decodeURIComponent(rest.slice("orders/".length));
      const r = q.cancelOrder.run(nowSec(), nowSec(), id, uid);
      if (!r.changes) { send(res, 404, { error: "没有这张等付款的单子（可能已经关掉了）" }); return true; }
      send(res, 200, { ok: true });
      return true;
    }

    if (rest === "entitlements" && req.method === "GET") {
      const ts = nowSec();
      const rows = q.listEnt.all(uid).map((e) => ({
        id: e.id, plan_id: e.plan_id, order_id: e.order_id,
        quota: safeObj(e.quota_json),
        start_at: e.start_at, end_at: e.end_at || null,
        /* 过期压过 state：一条过了期的权益不是 active（同审批那条规矩）。 */
        expired: !!e.end_at && e.end_at < ts,
      }));
      send(res, 200, { entitlements: rows.filter((e) => !e.expired) });
      return true;
    }

    send(res, 404, { error: "not found" });
    return true;
  }

  /** 按 id 取一张单（支付那一层要拿它核对金额，见 pay.mjs）。 */
  function getOrder(id) { return q.getOrder.get(String(id || "")) || null; }

  return { handle, upsertPlan, placeOrder, markPaid, getOrder, shapePlan, shapeOrder };
}
