/**
 * 微信支付（v3）—— 只做两件事：**开一张付款码**、**收一条到账回调**。
 *
 * ── 来历（苏白 2026-09-14「我觉得都搞过来吧」）──────────────────────
 * 这一份是照着云效那套里跑了很久的实现搬的（`1/frontend/server/wechat-pay.js`）：
 * 签名、验签、AES-GCM 解密这几段是协议规定的，没有第二种写法，照抄才是对的。
 * 但**有一处我故意没照抄**，见下面"和原版不一样的地方"。
 *
 * ── 🔴 和原版不一样的地方：公钥模式缺公钥时**拒收** ─────────────────
 * 原版遇到"公钥模式但本地没配公钥"，会打一条警告然后**放行**，理由是
 * AES-GCM 的认证标签也能保证完整性。那个理由本身站得住（没有 APIv3 密钥
 * 伪造不出密文），但它把一个"配置没做完"变成了一条**安静的放行路径** ——
 * 而这条路径上流过的是钱。少配一个文件就悄悄降一级校验，这种事没人会发现。
 * 所以这里改成：缺公钥就拒收，并在错误里说清楚缺的是哪个环境变量。
 * 收不到钱是看得见的故障，会有人来修；默默降级不是。
 *
 * ── 零第三方依赖 ───────────────────────────────────────────────────
 * 只用 node: 内置（crypto / fs / https），和本仓其余部分同一条规矩。
 *
 * ── 环境变量（一个都不能少，缺了 isConfigured() 就是 false）──────────
 *   WECHAT_PAY_MCH_ID         商户号
 *   WECHAT_PAY_APP_ID         公众号/应用 appid
 *   WECHAT_PAY_CERT_SERIAL    商户证书序列号
 *   WECHAT_PAY_KEY_PATH       商户私钥 PEM 的路径（apiclient_key.pem）
 *   WECHAT_PAY_API_V3_KEY     APIv3 密钥（32 字节，解密回调用）
 *   WECHAT_PAY_PUB_KEY_PATH   微信支付公钥 PEM（公钥模式验签用；平台证书模式可不配）
 */
import crypto from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import https from "node:https";

const API_HOST = "api.mch.weixin.qq.com";
/** 回调时间戳允许的偏差。超出就当重放，拒收。 */
const NOTIFY_WINDOW_SEC = 5 * 60;
/** 平台证书缓存 12 小时（微信自己也是这个量级的轮换节奏）。 */
const CERT_TTL_MS = 12 * 60 * 60 * 1000;

const env = (k) => process.env[k] || "";

/** 缺哪几项配置 —— 界面要能照实说"缺的是什么"，而不是笼统一句"没配好"。 */
export function missingConfig() {
  return [
    ["WECHAT_PAY_MCH_ID", "商户号"],
    ["WECHAT_PAY_APP_ID", "应用 appid"],
    ["WECHAT_PAY_CERT_SERIAL", "商户证书序列号"],
    ["WECHAT_PAY_KEY_PATH", "商户私钥文件"],
    ["WECHAT_PAY_API_V3_KEY", "APIv3 密钥"],
  ].filter(([k]) => !env(k)).map(([k, label]) => ({ key: k, label }));
}

export function isConfigured() {
  return missingConfig().length === 0;
}

let privateKeyCache = null;
function merchantPrivateKey() {
  if (privateKeyCache) return privateKeyCache;
  const p = env("WECHAT_PAY_KEY_PATH");
  if (!p) throw new Error("没配商户私钥路径（WECHAT_PAY_KEY_PATH）");
  if (!existsSync(p)) throw new Error(`商户私钥文件不存在：${p}`);
  privateKeyCache = readFileSync(p, "utf8");
  return privateKeyCache;
}

/** v3 请求签名。串的格式是协议规定的，一个换行都不能少。 */
function authHeader(method, urlPath, bodyStr, now) {
  const ts = Math.floor(now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString("hex");
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(`${method}\n${urlPath}\n${ts}\n${nonce}\n${bodyStr}\n`);
  const sig = signer.sign(merchantPrivateKey(), "base64");
  return `WECHATPAY2-SHA256-RSA2048 mchid="${env("WECHAT_PAY_MCH_ID")}",`
    + `nonce_str="${nonce}",serial_no="${env("WECHAT_PAY_CERT_SERIAL")}",`
    + `timestamp="${ts}",signature="${sig}"`;
}

/** 真正发请求。测试时整体替换掉（createWechatPay 的 transport 参数）。 */
function httpsRequest(method, urlPath, body, now) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : "";
    const req = https.request({
      hostname: API_HOST, path: urlPath, method,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "eryuan-space/1.0",
        Authorization: authHeader(method, urlPath, bodyStr, now),
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

/** AES-256-GCM 解一段微信给的密文（回调 resource / 平台证书都是这个形状）。 */
function aesGcmDecrypt({ ciphertext, nonce, associated_data }) {
  const key = env("WECHAT_PAY_API_V3_KEY");
  if (!key) throw new Error("没配 APIv3 密钥（WECHAT_PAY_API_V3_KEY）");
  const buf = Buffer.from(ciphertext, "base64");
  const tag = buf.subarray(buf.length - 16);
  const body = buf.subarray(0, buf.length - 16);
  const d = crypto.createDecipheriv("aes-256-gcm", Buffer.from(key, "utf8"), Buffer.from(nonce, "utf8"));
  d.setAuthTag(tag);
  if (associated_data) d.setAAD(Buffer.from(associated_data, "utf8"));
  return Buffer.concat([d.update(body), d.final()]).toString("utf8");
}

export function createWechatPay({ transport = httpsRequest, now = Date.now } = {}) {
  /* 平台证书模式用的缓存。公钥模式走 WECHAT_PAY_PUB_KEY_PATH，不经过这里。 */
  const certs = { map: new Map(), at: 0, inflight: null };

  async function refreshCerts() {
    const resp = await transport("GET", "/v3/certificates", null, now);
    if (resp.status !== 200 || !Array.isArray(resp.data?.data)) {
      return { ok: false, reason: resp.data?.message || `HTTP ${resp.status}` };
    }
    const map = new Map();
    for (const item of resp.data.data) {
      try {
        map.set(item.serial_no, crypto.createPublicKey(aesGcmDecrypt(item.encrypt_certificate)));
      } catch (e) {
        console.error("[wxpay] 平台证书解不开", item.serial_no, e.message);
      }
    }
    certs.map = map; certs.at = now();
    return { ok: true, count: map.size };
  }

  async function platformKey(serial) {
    if (!certs.map.has(serial) || now() - certs.at > CERT_TTL_MS) {
      certs.inflight = certs.inflight || refreshCerts().finally(() => { certs.inflight = null; });
      await certs.inflight;
    }
    return certs.map.get(serial) || null;
  }

  let pubKeyCache = null;
  function configuredPubKey() {
    if (pubKeyCache) return pubKeyCache;
    const p = env("WECHAT_PAY_PUB_KEY_PATH");
    if (!p || !existsSync(p)) return null;
    pubKeyCache = crypto.createPublicKey(readFileSync(p, "utf8"));
    return pubKeyCache;
  }

  /**
   * 开一张扫码付款单。
   * @param amountCents 整数分（和 commerce.mjs 的 amount_cents 同一个单位，别在这里做换算）
   */
  async function createNativeOrder({ outTradeNo, amountCents, description, notifyUrl }) {
    if (!isConfigured()) return { ok: false, reason: "微信支付还没配好", missing: missingConfig() };
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      return { ok: false, reason: "金额必须是大于 0 的整数分" };
    }
    const resp = await transport("POST", "/v3/pay/transactions/native", {
      appid: env("WECHAT_PAY_APP_ID"),
      mchid: env("WECHAT_PAY_MCH_ID"),
      description,
      out_trade_no: outTradeNo,
      notify_url: notifyUrl,
      amount: { total: amountCents, currency: "CNY" },
    }, now);
    if (resp.status === 200 && resp.data?.code_url) return { ok: true, codeUrl: resp.data.code_url };
    return { ok: false, reason: resp.data?.message || resp.data?.code || `HTTP ${resp.status}` };
  }

  /**
   * 验签。
   * 🔴 任何一步不对都返回 ok:false —— 这里没有"放行"的分支（见文件头第二段）。
   */
  async function verifyNotifySignature(headers, rawBody) {
    const ts = headers["wechatpay-timestamp"];
    const nonce = headers["wechatpay-nonce"];
    const sig = headers["wechatpay-signature"];
    const serial = headers["wechatpay-serial"];
    if (!ts || !nonce || !sig || !serial) return { ok: false, reason: "回调少了验签用的头" };

    const t = Number(ts);
    if (!Number.isFinite(t) || Math.abs(now() / 1000 - t) > NOTIFY_WINDOW_SEC) {
      return { ok: false, reason: "回调时间戳不在 5 分钟窗口内（当重放拒收）" };
    }

    const check = (key) => {
      const v = crypto.createVerify("RSA-SHA256");
      v.update(`${ts}\n${nonce}\n${rawBody}\n`);
      return v.verify(key, sig, "base64");
    };

    if (String(serial).startsWith("PUB_KEY_ID_")) {
      const pk = configuredPubKey();
      /* 🔴 原版在这里放行，我们拒收。理由见文件头。 */
      if (!pk) return { ok: false, reason: "这条回调是公钥模式，但没配 WECHAT_PAY_PUB_KEY_PATH —— 验不了签就不收" };
      return check(pk) ? { ok: true, mode: "pubkey" } : { ok: false, reason: "公钥模式验签不通过" };
    }

    const pk = await platformKey(serial);
    if (!pk) return { ok: false, reason: `不认识的平台证书序列号：${serial}` };
    return check(pk) ? { ok: true, mode: "cert" } : { ok: false, reason: "平台证书模式验签不通过" };
  }

  /** 先验签、再解密。两步都过才返回明文。 */
  async function verifyAndDecrypt(headers, rawBody) {
    const v = await verifyNotifySignature(headers, rawBody);
    if (!v.ok) return v;
    let body;
    try { body = JSON.parse(rawBody); } catch { return { ok: false, reason: "回调不是合法 JSON" }; }
    if (!body?.resource) return { ok: false, reason: "回调里没有 resource" };
    try {
      return { ok: true, mode: v.mode, data: JSON.parse(aesGcmDecrypt(body.resource)) };
    } catch (e) {
      return { ok: false, reason: `解密失败：${e.message}` };
    }
  }

  /** 主动查一单（对账用；回调丢了的时候靠它补）。 */
  async function queryOrder(outTradeNo) {
    if (!isConfigured()) return { ok: false, reason: "微信支付还没配好" };
    const path = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}`
      + `?mchid=${encodeURIComponent(env("WECHAT_PAY_MCH_ID"))}`;
    const resp = await transport("GET", path, null, now);
    if (resp.status === 200) return { ok: true, data: resp.data };
    return { ok: false, reason: resp.data?.message || `HTTP ${resp.status}` };
  }

  return { createNativeOrder, verifyNotifySignature, verifyAndDecrypt, queryOrder, isConfigured, missingConfig };
}
