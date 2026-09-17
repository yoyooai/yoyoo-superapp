/**
 * 收钱的最后一段：**把"下了单"变成"真的付了钱"**。
 *
 * ── 这一层存在的意义（commerce.mjs 文件头的那句话的兑现）───────────
 * commerce 那一层刻意留了一句狠话：付没付钱只有一个真源 —— **支付平台的回调**，
 * 并且拒绝提供任何"标记已付"的后门。这个文件就是那条唯一的路。
 * 它一旦存在，commerce.markPaid 就不再是一个没人调的函数；
 * 也正因为它是唯一的路，这里的每一道校验都不能省。
 *
 * ── 🔴 五道闸，少一道就会被人用来白嫖或者赖账 ────────────────────
 *  1. **验签 + 解密**（pay-wechat.mjs 里做）。验不过一律拒收，没有放行分支。
 *  2. **商户号/appid 必须是我们自己的**。不核这一条，别人拿他自己商户号的
 *     真回调打过来，签名是真的、钱却进了他的口袋。
 *  3. **金额必须和订单一分不差**。不核这一条，付 1 分钱就能开通一个年套餐 ——
 *     这是这一族系统最经典的一个洞。
 *  4. **幂等**。微信会重发同一条回调（我们没及时回 SUCCESS 就重发），
 *     重复开通就是白送。判据是订单状态，不是"我们见过这个通知 id 没有"。
 *  5. **只认 SUCCESS**。其余状态（关闭/退款/支付中）一律不开通，
 *     但要回 200，否则微信会一直重发一条注定不会成功的通知。
 *
 * ── 回什么码 ───────────────────────────────────────────────────
 * 微信按响应体判断要不要重发：`{code:"SUCCESS"}` = 别再发了。
 * 所以"我们这边暂时出错了"必须回非 SUCCESS（让它重发），
 * 而"这条通知我们永远也处理不了"（比如金额对不上）要回 SUCCESS 吗？——**不**。
 * 金额对不上是**事故**，要让它一直重发、一直在日志里响，而不是被我们静静吞掉。
 */
import { send, readJson, readRaw, clip } from "./http-util.mjs";

/** 付款码的有效期提示（微信 native 单默认 2 小时，这里只是给界面一句人话）。 */
const CODE_HINT = "扫码付款。付完页面不会自动跳，回到「我的订单」刷新一下就能看到状态。";

export function createPay({ commerce, wx, notifyUrl = "", now = Date.now }) {
  const nowSec = () => Math.floor(now() / 1000);

  /**
   * 用户面：给一张等付款的单开一个付款码。
   * 🔴 只认自己的单、只认 pending。别人的单号拿过来一律 404（不说"这单不是你的"，
   *    那等于告诉他这个单号是存在的）。
   */
  async function handleUser(req, res, { path, uid, root }) {
    const base = `${root}/commerce/orders/`;
    if (!path.startsWith(base) || !path.endsWith("/pay")) return false;
    if (req.method !== "POST") { send(res, 405, { error: "method not allowed" }); return true; }

    const id = decodeURIComponent(path.slice(base.length, path.length - "/pay".length));
    let body = {};
    try { body = await readJson(req); } catch { /* 没有 body 也行，默认微信 */ }
    const method = clip(body?.method, 20) || "wechat";
    if (method !== "wechat") {
      send(res, 400, { error: `暂时只支持微信支付，收到的是「${method}」` });
      return true;
    }

    const order = commerce.getOrder(id);
    if (!order || order.uid !== uid) { send(res, 404, { error: "没有这张单子" }); return true; }
    if (order.status !== "pending") {
      send(res, 409, { error: `这张单子是「${order.status}」，不用再付了` });
      return true;
    }

    /* 🔴 回调地址也是"配置的一部分"：它空着时微信会拒单，报的错却是它那边的话术，
       看起来像密钥不对。所以在这里先自己拦，并且说的是缺哪个环境变量。 */
    if (!notifyUrl) {
      send(res, 503, {
        error: "微信支付还没配好，现在收不了钱",
        missing: [{ key: "WECHAT_PAY_NOTIFY_URL", label: "收款回调地址（必须是外网能打到的 https 地址）" }],
      });
      return true;
    }

    if (!wx.isConfigured()) {
      /* 🔴 照实说缺什么，而不是笼统一句"支付未开通"。
         缺的是配置就说缺配置 —— 这句话是给运维看的，也是给用户一个可信的解释。 */
      send(res, 503, {
        error: "微信支付还没配好，现在收不了钱",
        missing: wx.missingConfig(),
      });
      return true;
    }

    const r = await wx.createNativeOrder({
      outTradeNo: order.id,
      amountCents: order.amount_cents,
      description: order.plan_name_at || "二元空间",
      notifyUrl,
    });
    if (!r.ok) { send(res, 502, { error: r.reason || "开付款码失败", missing: r.missing || null }); return true; }
    send(res, 200, { code_url: r.codeUrl, hint: CODE_HINT, amount_cents: order.amount_cents });
    return true;
  }

  /**
   * 微信回调。**没有用户登录态**，所以必须挂在用户面鉴权之前
   * （同渠道记录回传口那条路径的理由）。
   */
  async function handleNotify(req, res, { path, root }) {
    if (path !== `${root}/commerce/pay/notify/wechat`) return false;
    if (req.method !== "POST") { send(res, 405, { code: "FAIL", message: "method not allowed" }); return true; }

    let raw;
    try { raw = await readRaw(req); } catch (e) {
      send(res, 400, { code: "FAIL", message: String(e.message || e) }); return true;
    }

    const v = await wx.verifyAndDecrypt(req.headers || {}, raw);
    if (!v.ok) {
      console.error("[pay] 回调没通过验签/解密：", v.reason);
      /* 401 + FAIL：微信会重发。验不过就是验不过，不猜、不放行。 */
      send(res, 401, { code: "FAIL", message: v.reason || "verify failed" });
      return true;
    }

    const d = v.data || {};
    const cfg = { mchid: process.env.WECHAT_PAY_MCH_ID || "", appid: process.env.WECHAT_PAY_APP_ID || "" };

    /* 闸② 这笔钱是不是进我们自己的商户号 */
    if (cfg.mchid && d.mchid && String(d.mchid) !== cfg.mchid) {
      console.error("[pay] 回调商户号对不上", d.mchid);
      send(res, 400, { code: "FAIL", message: "mchid mismatch" }); return true;
    }
    if (cfg.appid && d.appid && String(d.appid) !== cfg.appid) {
      console.error("[pay] 回调 appid 对不上", d.appid);
      send(res, 400, { code: "FAIL", message: "appid mismatch" }); return true;
    }

    const orderId = String(d.out_trade_no || "");
    const order = orderId ? commerce.getOrder(orderId) : null;
    if (!order) {
      console.error("[pay] 回调指向一张我们没有的单子", orderId);
      send(res, 404, { code: "FAIL", message: "unknown order" }); return true;
    }

    /* 闸⑤ 只认 SUCCESS。别的状态回 200 SUCCESS，让它别再发了 ——
       这一条和"我们出错了要让它重发"不冲突：这里不是我们出错，是这笔单子没成。 */
    if (String(d.trade_state || "") !== "SUCCESS") {
      send(res, 200, { code: "SUCCESS", message: "not a success notification, acknowledged" });
      return true;
    }

    /* 闸④ 幂等：已经是 paid 就直接认，别再开一份权益。 */
    if (order.status === "paid") {
      send(res, 200, { code: "SUCCESS", message: "already settled" });
      return true;
    }
    if (order.status !== "pending") {
      console.error("[pay] 回调来晚了，单子已经是", order.status, orderId);
      send(res, 200, { code: "SUCCESS", message: `order is ${order.status}` });
      return true;
    }

    /* 闸③ 金额一分都不能差 */
    const paid = Number(d?.amount?.total);
    if (!Number.isInteger(paid) || paid !== order.amount_cents) {
      console.error(`[pay] 🔴 金额对不上：单子 ${order.amount_cents} 分，回调 ${d?.amount?.total}，单号 ${orderId}`);
      /* 🔴 不回 SUCCESS：这是事故，要让它一直响，别被我们静静吞掉。 */
      send(res, 409, { code: "FAIL", message: "amount mismatch" });
      return true;
    }

    const ref = String(d.transaction_id || "");
    if (!ref) {
      console.error("[pay] 回调没有 transaction_id", orderId);
      send(res, 400, { code: "FAIL", message: "missing transaction_id" }); return true;
    }

    const r = commerce.markPaid({ orderId, payMethod: "wechat", payRef: ref });
    if (!r.ok) {
      console.error("[pay] 记账失败：", r.reason, orderId);
      /* 我们这边的问题 ⇒ 非 SUCCESS，让微信重发，别把一笔真钱丢了。 */
      send(res, 500, { code: "FAIL", message: r.reason || "settle failed" });
      return true;
    }
    console.log(`[pay] 收到 ${paid} 分：${orderId} ← ${ref}（${v.mode}）at ${nowSec()}`);
    send(res, 200, { code: "SUCCESS", message: "OK" });
    return true;
  }

  return { handleUser, handleNotify };
}
