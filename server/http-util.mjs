/**
 * HTTP 小工具 —— index.mjs 与 market.mjs 共用的**唯一一份**。
 *
 * 抬成独立模块的理由和 blueprint.mjs 一样：市场那批路由需要同样的
 * `send` / `readJson` / `clip`。留在 index.mjs 里的话，market.mjs 要么去 import 一个
 * 名字叫"入口"的模块，要么就地抄一份 —— 后者会让"请求体上限"这种安全参数
 * 出现两个值，而且是静悄悄地。
 */

export function send(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(data);
}

export async function readJson(req, limitBytes = 512 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limitBytes) throw new Error("payload too large");
    chunks.push(c);
  }
  if (!size) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * 原文读取 —— 只给**要验签**的回调用（微信/支付宝的签名签的是原始字节串）。
 * 🔴 不能先 JSON.parse 再 stringify 回去：那样得到的是"语义相同、字节不同"的另一段文本，
 *    验签必然不过，而报出来的错会指向"签名不对"，让人以为是密钥配错了。
 */
export async function readRaw(req, limitBytes = 512 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limitBytes) throw new Error("payload too large");
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** 字符串长度收口，防止有人（或 AI）塞一篇小说进来 */
export const clip = (s, n) => (typeof s === "string" ? s.slice(0, n) : "");
