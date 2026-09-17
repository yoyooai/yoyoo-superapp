/**
 * 连接器 —— 让用户（或代表用户的 AI）把自己的外部系统接进来，供应用/卡片读写。
 *
 * 09-03 苏白拍板方向："每个用户一个工作台，通过连接器接自己的外部东西"，
 * 且明确"AI 写的代码在用户浏览器里跑，密钥不直接写进代码里，通过连接器在后台换取"。
 * 这个模块就是那个"后台换取"——它是唯一持有外部凭据的地方。
 *
 * 三条刻意的设计取舍：
 *
 *  1. **凭据加密落库，且从不回显原文。** 列表/详情接口只返回 `has_secret: boolean`，
 *     `call` 接口内部解出来用完即弃，绝不出现在响应体、日志、错误信息里。
 *     加密算法照抄 invite.mjs 的 AES-256-GCM 封装（同一个模式，独立一份密钥文件——
 *     两处凭据一份被破不牵连另一份，见文件末尾说明）。
 *
 *  2. **代理调用，不是转发密钥。** 应用/卡片（跑在浏览器里的代码）只知道
 *     "connector_id + 要调用的 path"，不知道也拿不到真实的 base_url 和密钥。
 *     真正的出站 HTTP 请求由**这一层在服务端发起**，密钥只在这一次请求里现用现弃。
 *
 *  3. **SSRF 是这层最大的安全面，不是次要细节。** base_url 由用户自己填，
 *     如果不校验，这个"代理"就是一个现成的内网探测器——用我们的服务器去连
 *     它自己内网里任何一台机器。所以创建时校验一次、**每次调用前重新解析校验
 *     一次**（防 DNS rebinding：注册时是公网地址，调用时 DNS 已经改指向内网），
 *     且关掉自动跟随跳转（跳转目标同样可能是内网）。
 */
import { randomUUID, randomBytes, createHash, createHmac, createCipheriv, createDecipheriv } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { lookup as dnsLookup } from "node:dns/promises";
import { send, readJson, clip } from "./http-util.mjs";

const AUTH_TYPES = new Set(["none", "bearer", "header", "basic"]);
// 🔴 出站请求里这个前缀下的头**一律由服务端写**，任何用户可控的地方都不许占用它
//    （否则用户把自己的认证头命名成 x-yoyoo-caller，就等于自己给自己签了一张身份）。
const CALLER_HEADER_PREFIX = "x-yoyoo-";
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
// 🔴 09-03 真撞过：Innovate 桩接了真 LLM 网关生成假设，单次调用实测 9.5s，
//    10s 的外层超时几乎必炸（代理本身还要再加一跳的开销，撞线概率更高）。
//    外层超时必须明显宽于"一个正常业务系统可能的慢响应"，不能只按"网络调用
//    该多快"的直觉设，AI 生成类下游天然更慢。
const CALL_TIMEOUT_MS = 30_000;
const CALL_BODY_LIMIT = 2 * 1024 * 1024; // 2MB，响应体读到这就截断拒绝
const MAX_CONNECTORS_PER_OWNER = 20;

// ── 限流：按 owner 算，跟 invite.mjs 的兑换限流同一个理由——
//    这不是防爆破，是防"把 call 接口当成免费的匿名代理来打别的网站"。
const CALL_WINDOW_MS = 60_000;
const CALL_MAX_PER_WINDOW = 60;
const callWindows = new Map(); // owner_uid -> { count, resetAt }

function rateLimited(ownerUid, now) {
  const w = callWindows.get(ownerUid);
  if (!w || now >= w.resetAt) {
    callWindows.set(ownerUid, { count: 1, resetAt: now + CALL_WINDOW_MS });
    return false;
  }
  w.count += 1;
  return w.count > CALL_MAX_PER_WINDOW;
}

// ── SSRF 拦截：字面量私网/回环/链路本地地址 ──────────────────────
// 跟 secrets.mjs 的 private_ip/internal_host 规则同一份判断标准，这里独立一份是因为
// 那边扫的是"文本里有没有疑似内网地址"（宽松、可以误报），这边要的是"这个地址
// 到底是不是私网"（必须准，误判会把用户正常的连接器拦掉）——两个问题不一样，
// 判据也不能共用同一份正则。
function isPrivateOrLoopbackIPv4(ip) {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 127) return true; // 回环
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 链路本地（含云厂商元数据 169.254.169.254）
  if (a === 0) return true;
  return false;
}
function isPrivateOrLoopbackIPv6(ip) {
  const t = ip.toLowerCase();
  return t === "::1" || t.startsWith("fe80:") || t.startsWith("fc") || t.startsWith("fd");
}
function isBlockedHostLiteral(hostname) {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan")) return true;
  return false;
}

/**
 * 校验一个 URL 能不能被连接器使用。做两层检查：
 *   ①协议只许 http/https  ②主机名/字面量 IP 不许落在私网范围
 * 主机名会走一次真实 DNS 解析，挡"域名注册时指向公网、调用时改指向内网"这种绕法
 * （不是万无一失——DNS 结果可能在这次校验和真正发起请求之间的极短窗口再变一次，
 * 这是已知的、没有完全解法的时间窗风险，此处不假装解决，只做到"每次调用都重新查"）。
 *
 * `allowPrivateHosts` 只给测试用——生产环境（index.mjs 里 createConnectors 的调用点）
 * 永远不传这个参数，默认值是"拦"。测试要用真实 HTTP 往返验证代理逻辑，而真实的
 * 假外部服务只能起在 localhost，不给测试开这个口子就测不了 doCall 的真实网络路径。
 */
export async function assertUrlSafe(rawUrl, allowPrivateHosts = false) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return { ok: false, error: "base_url 不是一个合法的 URL" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, error: "base_url 协议只能是 http/https" };
  }
  if (allowPrivateHosts) return { ok: true, url: u };
  const hostname = u.hostname.replace(/^\[|\]$/g, "");
  if (isBlockedHostLiteral(hostname)) {
    return { ok: false, error: "base_url 不能指向本机/内部域名" };
  }
  if (isPrivateOrLoopbackIPv4(hostname) || isPrivateOrLoopbackIPv6(hostname)) {
    return { ok: false, error: "base_url 不能是内网/回环地址" };
  }
  try {
    const results = await dnsLookup(hostname, { all: true, verbatim: true });
    for (const r of results) {
      if (r.family === 4 && isPrivateOrLoopbackIPv4(r.address)) {
        return { ok: false, error: "base_url 解析到了内网地址" };
      }
      if (r.family === 6 && isPrivateOrLoopbackIPv6(r.address)) {
        return { ok: false, error: "base_url 解析到了内网地址" };
      }
    }
  } catch {
    return { ok: false, error: "base_url 域名解析失败" };
  }
  return { ok: true, url: u };
}

// ── 加密 ────────────────────────────────────────────────────────
// 与 invite.mjs 同一套 AES-256-GCM 封装模式，独立成一份密钥文件（不共用 invite
// 的密钥/派生材料）——两处凭据的"性质"不同（一个是一次性票据，一个是长期外部
// 凭据），刻意不让它们的破解面互相牵连。算法层面完全一致，是"照抄同一份判据"，
// 不是"另造一套没验证过的加密"。
function loadSealSecret(keyPath) {
  if (keyPath && existsSync(keyPath)) {
    return createHash("sha256").update(readFileSync(keyPath)).digest();
  }
  const fresh = randomBytes(32);
  if (keyPath) writeFileSync(keyPath, fresh, { mode: 0o600 });
  return createHash("sha256").update(fresh).digest();
}
const b64u = (buf) => Buffer.from(buf).toString("base64url");
const unb64u = (s) => Buffer.from(String(s), "base64url");

export function initConnectorSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS connectors (
      id            TEXT PRIMARY KEY,
      owner_uid     TEXT NOT NULL,
      name          TEXT NOT NULL,
      base_url      TEXT NOT NULL,
      auth_type     TEXT NOT NULL,        -- none | bearer | header | basic
      header_name   TEXT,                 -- 仅 auth_type=header 时有值
      sealed_secret TEXT,                 -- iv.tag.ciphertext（base64url）；auth_type=none 时为 NULL
      created_by    TEXT NOT NULL DEFAULT 'human',
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_connectors_owner ON connectors(owner_uid, updated_at DESC);
  `);
  // 「把调用者身份转发给这个连接器」——默认 0（关）。
  // 这是隐私开关，不是功能开关：下游是用户自己注册的第三方系统，
  // 默认转发等于我们替用户把"谁在用"告诉了别人。所以默认关、一个个开。
  const cols = db.prepare(`PRAGMA table_info(connectors)`).all().map((c) => c.name);
  if (!cols.includes("forward_caller")) {
    db.exec(`ALTER TABLE connectors ADD COLUMN forward_caller INTEGER NOT NULL DEFAULT 0`);
  }
}

export function createConnectors({ db, sealKeyPath, allowPrivateHosts = false, resolveLenderUid = null, firstPartyHosts = [] }) {
  initConnectorSchema(db);
  const SEAL = loadSealSecret(sealKeyPath);

  // 派生材料用 connector id —— 每条记录的封装密钥都不一样，
  // 挪用别的记录的密文在这条记录上解不开（同 invite.mjs 的思路）。
  const sealKey = (connectorId) =>
    createHash("sha256").update(SEAL).update("|yoyoo-connector|").update(String(connectorId)).digest();

  function seal(secret, connectorId) {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", sealKey(connectorId), iv);
    const body = Buffer.concat([c.update(String(secret), "utf8"), c.final()]);
    return [b64u(iv), b64u(c.getAuthTag()), b64u(body)].join(".");
  }
  function unseal(sealed, connectorId) {
    const [iv, tag, body] = String(sealed).split(".");
    const d = createDecipheriv("aes-256-gcm", sealKey(connectorId), unb64u(iv));
    d.setAuthTag(unb64u(tag));
    return Buffer.concat([d.update(unb64u(body)), d.final()]).toString("utf8");
  }

  /**
   * 调用者化名 —— 转发给第三方时用它，**不发我们的真 uid**。
   *
   * `HMAC(封装密钥, 连接器id + uid)`：
   *  · 同一个人在同一个连接器上永远是同一个值 —— 下游才能做"只看轮到我的活"；
   *  · 换一个连接器就是另一个值 —— 两个第三方拿各自的日志对不上是同一个人；
   *  · 不可逆 —— 拿到化名也反推不回我们的用户 id。
   * 这三条缺一条，这个头就从"够用的身份"变成"泄露用户"。
   */
  const callerAlias = (connectorId, callerUid) =>
    createHmac("sha256", SEAL)
      .update("yoyoo-caller|").update(String(connectorId)).update("|").update(String(callerUid))
      .digest("base64url").slice(0, 22);

  // 第一方 = 下游就是我们自己的系统（由服务端配置决定，用户改不了）。
  // 对自己人发真 uid 不构成对外披露，也省掉一层化名映射。
  const FIRST_PARTY = new Set(
    (Array.isArray(firstPartyHosts) ? firstPartyHosts : String(firstPartyHosts || "").split(","))
      .map((h) => String(h).trim().toLowerCase()).filter(Boolean));
  const isFirstParty = (hostname) => FIRST_PARTY.has(String(hostname).toLowerCase());

  const qList = db.prepare(
    `SELECT id,name,base_url,auth_type,header_name,forward_caller,created_by,created_at,updated_at,
            (sealed_secret IS NOT NULL) AS has_secret
       FROM connectors WHERE owner_uid=? ORDER BY updated_at DESC LIMIT 200`);
  const qGet = db.prepare(`SELECT * FROM connectors WHERE id=? AND owner_uid=?`);
  const qCount = db.prepare(`SELECT COUNT(*) AS n FROM connectors WHERE owner_uid=?`);
  const qInsert = db.prepare(
    `INSERT INTO connectors (id,owner_uid,name,base_url,auth_type,header_name,sealed_secret,created_by,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const qRemove = db.prepare(`DELETE FROM connectors WHERE id=? AND owner_uid=?`);
  const qSetForward = db.prepare(
    `UPDATE connectors SET forward_caller=?, updated_at=? WHERE id=? AND owner_uid=?`);

  /** 造一个连接器。返回 { status, body }。不抛错——调用方按 http 语义处理。 */
  async function doCreate(ownerUid, { name, base_url, auth_type, secret, header_name }, createdBy, now) {
    if (!clip(name, 80).trim()) return { status: 400, body: { error: "name required" } };
    if (!AUTH_TYPES.has(auth_type)) {
      return { status: 400, body: { error: `auth_type 必须是 ${[...AUTH_TYPES].join("/")} 之一` } };
    }
    if (auth_type === "header" && !clip(header_name, 80).trim()) {
      return { status: 400, body: { error: "auth_type=header 时 header_name 必填" } };
    }
    // 🔴 用户不能占用调用者身份的头名 —— 占上了就等于自己给自己签身份。
    if (auth_type === "header" &&
        clip(header_name, 80).trim().toLowerCase().startsWith(CALLER_HEADER_PREFIX)) {
      return { status: 400, body: { error: `header_name 不能以 ${CALLER_HEADER_PREFIX} 开头——这个前缀留给服务端写的调用者身份` } };
    }
    if (auth_type !== "none" && !String(secret || "").trim()) {
      return { status: 400, body: { error: "该 auth_type 需要提供 secret" } };
    }
    const check = await assertUrlSafe(base_url, allowPrivateHosts);
    if (!check.ok) return { status: 400, body: { error: check.error } };

    const count = qCount.get(ownerUid).n;
    if (count >= MAX_CONNECTORS_PER_OWNER) {
      return { status: 429, body: { error: `每个用户最多 ${MAX_CONNECTORS_PER_OWNER} 个连接器` } };
    }

    const id = randomUUID();
    const sealedSecret = auth_type === "none" ? null : seal(secret, id);
    qInsert.run(
      id, ownerUid, clip(name, 80).trim(), check.url.toString(), auth_type,
      auth_type === "header" ? clip(header_name, 80).trim() : null,
      sealedSecret, createdBy, now, now);
    return {
      status: 201,
      body: { id, name: clip(name, 80).trim(), base_url: check.url.toString(), auth_type, created_by: createdBy, created_at: now },
    };
  }

  function doList(ownerUid) {
    return { status: 200, body: { items: qList.all(ownerUid) } };
  }

  function doRemove(ownerUid, id) {
    const row = qGet.get(id, ownerUid);
    if (!row) return { status: 404, body: { error: "not found" } };
    qRemove.run(id, ownerUid);
    return { status: 200, body: { ok: true } };
  }

  /** 开/关"把调用者身份（化名）转发给这个连接器"。只有 owner 能改。 */
  function doSetForwardCaller(ownerUid, id, on) {
    if (typeof on !== "boolean") return { status: 400, body: { error: "forward_caller 必须是 true/false" } };
    const row = qGet.get(id, ownerUid);
    if (!row) return { status: 404, body: { error: "not found" } };
    qSetForward.run(on ? 1 : 0, Date.now(), id, ownerUid);
    return { status: 200, body: { id, forward_caller: on } };
  }

  /**
   * 代理调用。这是唯一真正发起外部 HTTP 请求、唯一解密凭据的地方。
   * body: { method, path, query?, body? }
   *   path 必须是相对路径（拼在 base_url 后面）——不许调用方指定一个新的 host，
   *   否则"连接器"就形同虚设，等于给了一个任意目标的代理。
   */
  async function doCall(ownerUid, id, { method, path, query, body: reqBody }, fetchImpl = fetch, now = Date.now(), callerUid = ownerUid, callerKind = "human") {
    const rateKey = callerUid;
    const row = qGet.get(id, ownerUid);
    if (!row) return { status: 404, body: { error: "not found" } };

    // 🔴 限流按**发起人**算，不按连接器主人算。连接器随应用出借之后，一个群里
    //    十个人共用 owner 的额度，任何一个人刷几下就把老板自己锁在门外了——
    //    限流是"防某个人把代理当免费出口打别人网站"，那就该记在那个人头上。
    if (rateLimited(rateKey, now)) {
      return { status: 429, body: { error: "调用太频繁，请稍后再试" } };
    }

    const m = String(method || "GET").toUpperCase();
    if (!HTTP_METHODS.has(m)) return { status: 400, body: { error: `method 必须是 ${[...HTTP_METHODS].join("/")} 之一` } };
    if (typeof path !== "string" || !path.startsWith("/")) {
      return { status: 400, body: { error: "path 必须是以 / 开头的相对路径" } };
    }

    // 每次调用都重新校验一次 base_url——防 DNS rebinding（注册时是公网，
    // 调用时域名已被改指向内网）。代价是每次调用多一次 DNS 查询，可接受。
    const check = await assertUrlSafe(row.base_url, allowPrivateHosts);
    if (!check.ok) {
      return { status: 502, body: { error: `连接器地址现在校验不安全，已阻止：${check.error}` } };
    }

    const target = new URL(check.url.toString());
    // path 是相对连接器 base_url 的——只拼路径和查询串，绝不允许覆盖 host。
    const basePath = target.pathname.endsWith("/") ? target.pathname.slice(0, -1) : target.pathname;
    target.pathname = basePath + path;
    if (query && typeof query === "object") {
      for (const [k, v] of Object.entries(query)) target.searchParams.set(k, String(v));
    }

    const headers = { accept: "application/json, text/plain, */*" };
    if (row.auth_type !== "none") {
      let secretPlain;
      try {
        secretPlain = unseal(row.sealed_secret, row.id);
      } catch {
        return { status: 500, body: { error: "凭据解密失败（seal broken）" } };
      }
      if (row.auth_type === "bearer") headers.authorization = `Bearer ${secretPlain}`;
      else if (row.auth_type === "header") headers[row.header_name.toLowerCase()] = secretPlain;
      else if (row.auth_type === "basic") headers.authorization = `Basic ${Buffer.from(secretPlain, "utf8").toString("base64")}`;
      secretPlain = null; // 用完即弃，不留在闭包变量里
    }

    // ── 调用者身份：服务端派生，调用方伪造不了（TD-313）──────────────
    // 顺序很重要：**最后**写，且先抹掉同前缀的任何头。认证头的名字是用户填的，
    // 新注册的已经拦住了，但库里可能有旧记录——所以这里再抹一次，不靠上游守规矩。
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase().startsWith(CALLER_HEADER_PREFIX)) delete headers[k];
    }
    if (isFirstParty(target.hostname)) {
      headers["x-yoyoo-caller"] = String(callerUid);
      headers["x-yoyoo-caller-scope"] = "uid";     // 真名：下游是我们自己的系统
      headers["x-yoyoo-caller-kind"] = callerKind; // human = 人点的，ai = AI 代调
    } else if (row.forward_caller) {
      headers["x-yoyoo-caller"] = callerAlias(id, callerUid);
      headers["x-yoyoo-caller-scope"] = "alias";   // 化名：第三方永远只拿得到这个
      headers["x-yoyoo-caller-kind"] = callerKind;
    }
    // 没开转发、又不是第一方 ⇒ 一个字节都不发。

    let fetchBody;
    if (reqBody !== undefined && m !== "GET" && m !== "DELETE") {
      headers["content-type"] = "application/json";
      fetchBody = JSON.stringify(reqBody);
    }

    let res;
    try {
      res = await fetchImpl(target.toString(), {
        method: m,
        headers,
        body: fetchBody,
        redirect: "manual", // 跳转目标可能是内网，绝不自动跟随
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch (e) {
      // 🔴 错误信息不能包含 headers/密钥——fetch 的 TypeError 不会带这些，但仍然
      //    只取 message，不把整个 error 对象序列化出去。
      return { status: 502, body: { error: `外部请求失败：${String(e.message || e)}` } };
    }

    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
      return { status: 502, body: { error: "连接器收到跳转响应，已阻止自动跟随（可能指向内网）" } };
    }

    const reader = res.body?.getReader?.();
    let text = "";
    if (reader) {
      let total = 0;
      const dec = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > CALL_BODY_LIMIT) {
          try { await reader.cancel(); } catch {}
          return { status: 502, body: { error: "外部响应体过大，已中止" } };
        }
        text += dec.decode(value, { stream: true });
      }
    } else {
      text = await res.text();
    }

    const contentType = res.headers.get("content-type") || "";
    let parsed = text;
    if (contentType.includes("application/json") && text) {
      try { parsed = JSON.parse(text); } catch { /* 保留原文本，不是每个"json"都真的合法 */ }
    }
    return { status: 200, body: { status: res.status, content_type: contentType, body: parsed } };
  }

  /** 这个连接器是不是他自己的。用于判断要不要走"随应用出借"那条路。 */
  function ownedBy(uid, id) {
    return !!qGet.get(id, uid);
  }

  /**
   * 连接器随应用一起出借 —— 09-04 苏白实测出来的洞。
   *
   * 现象：同事能只读打开分享给群的工作台，但六个模块全是 0 + "加载失败"。
   * 根因不在分享（分享是通的），在**取数**：连接器按 `owner_uid` 严格私有，
   * 页面里每一次 `connectorCall` 都拿访问者自己的身份去查，一律 404。
   * 也就是说，我们把"能看见这个应用"和"这个应用能取到数"当成了两件事，
   * 而对用户来说它们是同一件——打得开却全是空白，比打不开更让人以为东西坏了。
   *
   * 所以：**应用被借出去的时候，它自己用的那几个连接器要跟着一起借出去。**
   *
   * 边界（这三条缺一条这里就变成越权通道，不是可选的收紧）：
   *  ①访问者必须真能看这个应用 —— 用他自己的 token 走宿主群成员校验（`canView`），
   *    服务端不持特权凭据，宿主不可达就是拒。
   *  ②连接器必须**确实是这个应用在用的**（id 出现在该应用蓝图里）——否则就成了
   *    "借一个应用的壳，调 owner 名下任意连接器"，那是拿别人的密钥打别人的系统。
   *  ③蓝图只有 owner 能写。所以"借哪几个连接器"这件事**始终由 owner 决定**，
   *    访问者无法自己扩大范围。
   *
   * 换来的代价，写在这里不装看不见：群成员因此能以 owner 的身份对这些连接器
   * 发起**写**请求（批准报价那一类）。这是 09-04 苏白明确要的"权限先开到最大"，
   * 且正是协作本身要的动作；收紧的口子留在 `resolveLenderUid` 这一个函数里——
   * 以后要按动作分级（读放行/写要本人），改这一处就够，不用翻遍调用点。
   */
  async function lenderFor({ connectorId, viewerUid, viewerToken, appId, spaceId }) {
    if (!resolveLenderUid || !appId || !viewerToken) return null;
    try {
      return await resolveLenderUid({ connectorId, viewerUid, viewerToken, appId, spaceId });
    } catch {
      return null; // 判定不了就是不放行
    }
  }

  // ── 路由：用户面（session token，uid 来自宿主 whoami）─────────
  // 挂在 `${root}/connectors` 下。
  async function handle(req, res, { path, url, uid, now, root, token, spaceId = "" }) {
    const rel = path.slice(`${root}/connectors`.length);
    if (rel === "" || rel === "/") {
      if (req.method === "GET") { const r = doList(uid); return send(res, r.status, r.body), true; }
      if (req.method === "POST") {
        let body; try { body = await readJson(req); } catch (e) { return send(res, 400, { error: String(e.message || e) }), true; }
        const r = await doCreate(uid, body, "human", now);
        return send(res, r.status, r.body), true;
      }
      return send(res, 405, { error: "method not allowed" }), true;
    }
    const seg = rel.slice(1).split("/");
    const id = decodeURIComponent(seg[0] || "");
    const action = seg[1] || "";
    if (!id) return false;
    if (action === "call") {
      if (req.method !== "POST") return send(res, 405, { error: "method not allowed" }), true;
      let body; try { body = await readJson(req); } catch (e) { return send(res, 400, { error: String(e.message || e) }), true; }
      // 自己的连接器走自己的身份；不是自己的，看能不能"随应用出借"（见 lenderFor）。
      let actingUid = uid;
      if (!ownedBy(uid, id)) {
        const lender = await lenderFor({
          connectorId: id, viewerUid: uid, viewerToken: token, appId: body.app_id, spaceId,
        });
        if (lender) actingUid = lender;
      }
      const r = await doCall(actingUid, id, body, undefined, now, uid);
      return send(res, r.status, r.body), true;
    }
    if (!action && req.method === "PATCH") {
      // 只有 owner 能开关"转发调用者身份"——借用者改不了别人的隐私设置。
      let body; try { body = await readJson(req); } catch (e) { return send(res, 400, { error: String(e.message || e) }), true; }
      const r = doSetForwardCaller(uid, id, body.forward_caller);
      return send(res, r.status, r.body), true;
    }
    if (!action && req.method === "DELETE") {
      // 🔴 删除永远只认自己 —— 出借只出借"用"，不出借"改/删"。
      const r = doRemove(uid, id);
      return send(res, r.status, r.body), true;
    }
    return false;
  }

  // ── 路由：bot 面（AI 代表某个人操作）─────────────────────────
  // 挂在 `${root}/connectors/for` 下，风格与 index.mjs 里 apps/for 一致：
  // body 只读一次，owner_uid 从**同一份已读的 body/query**里取出后再交给 botAuth 验证
  // ——不能先读一次 body 认证、再读第二次取数据，请求流只能读一遍。
  async function handleBot(req, res, { path, url, botAuth, now, root }) {
    const prefix = `${root}/connectors/for`;
    const rel = path.slice(prefix.length);
    async function authFor(ownerUidRaw) {
      return botAuth.verify(String(req.headers["authorization"] || "").replace(/^Bearer\s+/i, ""), ownerUidRaw);
    }
    if (rel === "") {
      if (req.method === "GET") {
        const auth = await authFor(url.searchParams.get("owner_uid"));
        if (!auth.ok) return send(res, auth.status, { error: auth.error }), true;
        const r = doList(auth.ownerUid);
        return send(res, r.status, r.body), true;
      }
      if (req.method === "POST") {
        let body; try { body = await readJson(req); } catch (e) { return send(res, 400, { error: String(e.message || e) }), true; }
        const auth = await authFor(body.owner_uid);
        if (!auth.ok) return send(res, auth.status, { error: auth.error }), true;
        const r = await doCreate(auth.ownerUid, body, "ai", now);
        return send(res, r.status, r.body), true;
      }
      return send(res, 405, { error: "method not allowed" }), true;
    }
    const seg = rel.slice(1).split("/");
    const id = decodeURIComponent(seg[0] || "");
    const action = seg[1] || "";
    if (!id) return false;
    if (action === "call") {
      if (req.method !== "POST") return send(res, 405, { error: "method not allowed" }), true;
      let body; try { body = await readJson(req); } catch (e) { return send(res, 400, { error: String(e.message || e) }), true; }
      const auth = await authFor(body.owner_uid);
      if (!auth.ok) return send(res, auth.status, { error: auth.error }), true;
      const r = await doCall(auth.ownerUid, id, body, undefined, now, auth.ownerUid, "ai");
      return send(res, r.status, r.body), true;
    }
    if (!action && req.method === "DELETE") {
      const auth = await authFor(url.searchParams.get("owner_uid"));
      if (!auth.ok) return send(res, auth.status, { error: auth.error }), true;
      const r = doRemove(auth.ownerUid, id);
      return send(res, r.status, r.body), true;
    }
    return false;
  }

  return {
    handle, handleBot,
    _internals: { doCreate, doList, doRemove, doCall, doSetForwardCaller, callerAlias, isFirstParty, assertUrlSafe, seal, unseal, ownedBy, lenderFor },
  };
}
