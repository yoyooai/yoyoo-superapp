/**
 * 「App 登录入口」—— 让**原生 App 的登录态**换成**网页的登录态**。
 *
 * 为什么需要它（病根，见 tech-debt.md TD-345）：
 * 市场/超级应用/助手这些东西是我方加在**网页**里的 React 模块，原生 App 没有
 * 加载它们的代码路径。所以 App 想用这些功能只能开 WebView 装网页——可网页那头
 * **没有"拿 App 的 token 直接换登录态"的入口**（线上 bundle 里唯一读 `?token=` 的
 * 是账号绑定流程）。缺这个口子，点进去就是再登一遍；补上这个口子，
 * App 的发现页里挂几个功能都一样能直接用。
 *
 * 🔴 三条安全底线（写死，不许为了图快绕过）：
 *  1. **凭据不进 URL 查询串**。优先从 `location.hash` 读——fragment 浏览器不发给
 *     服务端，因此不进 nginx access log、不进 Referer。查询串 `?token=` 只作为
 *     兼容路径保留（上游 `WKWebViewActivity` 现在就是这么拼的），但一样即读即擦。
 *  2. **校验必须在服务端做**。页面不相信任何客户端自称的身份：token 交给
 *     `hostUser()` 去问宿主"这是谁"，名字/短号/uid 全部用宿主返回的值，
 *     不用调用方传来的。传了 `uid` 就必须和宿主答案一致，对不上直接 401。
 *  3. **`to` 只许站内相对路径**。`sanitizeReturnTo` 是唯一一份实现（服务端做完
 *     再把结果发给页面），页面不自己判断——两份实现迟早对不上，而对不上的
 *     那一次就是开放重定向。
 *
 * 会话存储的键名形状不是我发明的，是 09-12 用验收账号真登录一次后**量出来的**：
 * sessionStorage 里有一个 `octo.session.sid`（六位随机后缀），其余字段都是
 * `<字段名><后缀>`；localStorage 是镜像（少 `realname_verified` 和 sid 本身）。
 * 所以这里只是按同样的形状写一遍，不改网页前端一行代码。
 */

/** 会话后缀：跟真登录一个形状（六位小写字母数字） */
export function newSid(rand = Math.random) {
  let s = "";
  while (s.length < 6) s += rand().toString(36).slice(2);
  return s.slice(0, 6);
}

/**
 * 回跳地址收口。**这是唯一一份实现**，页面里不许再写一份。
 * 只放行站内绝对路径：必须以 `/` 开头，且不能是 `//host`、`/\host` 这种
 * 会被浏览器当成协议相对地址的写法（那就是开放重定向）。
 */
export function sanitizeReturnTo(raw, { selfPath = "" } = {}) {
  const fallback = "/";
  if (typeof raw !== "string") return fallback;
  const s = raw.trim().slice(0, 512);
  if (!s) return fallback;
  if (!s.startsWith("/")) return fallback;          // 绝对 URL / 相对路径都不要
  if (s.startsWith("//")) return fallback;          // 协议相对 → 站外
  if (s.includes("\\")) return fallback;            // `/\evil.com` 这类等价写法
  if (/[\x00-\x20\x7f]/.test(s)) return fallback;   // 控制字符/空白
  if (selfPath && s.split("?")[0] === selfPath) return fallback; // 别跳回自己，会打转
  return s;
}

/** 宿主返回的用户 → 网页那头认识的两份键值（sessionStorage / localStorage 镜像） */
export function buildSessionEntries(user, token, sid) {
  const str = (v) => (v === undefined || v === null ? "" : String(v));
  const bool = (v) => (v ? "1" : "0");
  // 字段与真登录量出来的一致；缺的按真登录时的默认值给，不编造。
  const fields = {
    token: str(token),
    uid: str(user.uid),
    name: str(user.name),
    short_no: str(user.short_no),
    app_id: str(user.app_id),
    // 网页端自己就是 local + device_flag=1，这两项不是宿主下发的
    login_provider: "local",
    device_flag: "1",
    sex: str(user.sex ?? 1),
    is_work: bool(user.is_work),
    role: str(user.role),
    realname_verified: bool(user.realname_verified),
  };
  const session = { "octo.session.sid": sid };
  for (const [k, v] of Object.entries(fields)) session[`${k}${sid}`] = v;
  // 镜像照抄真登录的范围：不镜像 sid 本身，也不镜像 realname_verified。
  const local = {};
  for (const [k, v] of Object.entries(fields)) {
    if (k === "realname_verified") continue;
    local[`${k}${sid}`] = v;
  }
  // 从 App 进来的人已经在 App 里过过一遍门了，不该再被一屏"二元空间是什么"的
  // 介绍挡住 —— 那一屏是给第一次打开网页的人看的。这一行就是"点进去就是工作台"
  // 这句承诺的最后一步（09-12 真机验收时它挡在工作台前面，实测量出来的）。
  local["octo:onboarding:seen"] = "seen";
  return { session, local };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/**
 * 接住凭据的那一页。**页面本身不含任何人的数据**——凭据在客户端的
 * hash/查询串里，页面只负责读出来、交给服务端验、写进会话存储、然后擦干净。
 */
export function renderEntryPage({ verifyUrl, nonce }) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>正在进入…</title>
<style nonce="${nonce}">
  html,body{height:100%;margin:0}
  body{display:flex;align-items:center;justify-content:center;
       font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
       color:#1d1d1f;background:#f5f5f7}
  .box{text-align:center;padding:24px;max-width:22em}
  .msg{color:#86868b}
  .err{color:#b42318}
  a{color:#0d74ce}
</style></head>
<body><div class="box"><div id="m" class="msg">正在进入…</div></div>
<script nonce="${nonce}">
(function () {
  var VERIFY = ${JSON.stringify(verifyUrl)};
  var el = document.getElementById("m");
  function fail(t) { el.className = "err"; el.textContent = t + "，请重新登录。";
    var a = document.createElement("div"); a.innerHTML = '<a href="/login">去登录页</a>';
    el.parentNode.appendChild(a); }
  var h = location.hash.replace(/^#/, "");
  var p = new URLSearchParams(h || location.search.replace(/^\\?/, ""));
  var token = p.get("token") || "", uid = p.get("uid") || "", to = p.get("to") || "";
  // 先擦后验：不管后面成不成，地址栏和历史里都不许留着凭据。
  try { history.replaceState(null, "", location.pathname); } catch (e) {}
  if (!token) { fail("没有收到登录凭据"); return; }
  fetch(VERIFY, { method: "POST", headers: { "content-type": "application/json" },
                  body: JSON.stringify({ token: token, uid: uid, to: to }) })
    .then(function (r) { return r.json().then(function (j) { return { s: r.status, j: j }; }); })
    .then(function (r) {
      if (r.s !== 200) { fail((r.j && r.j.error) || ("校验没通过（" + r.s + "）")); return; }
      try { Object.keys(r.j.session).forEach(function (k) { sessionStorage.setItem(k, r.j.session[k]); }); }
      catch (e) { fail("浏览器不让写会话存储"); return; }
      try { Object.keys(r.j.local).forEach(function (k) { localStorage.setItem(k, r.j.local[k]); }); } catch (e) {}
      location.replace(r.j.to || "/");
    })
    .catch(function () { fail("连不上服务器"); });
})();
</script></body></html>`;
}

/**
 * @param {object} o
 * @param {(token:string)=>Promise<object|null>} o.hostUser 拿 token 问宿主"这是谁"（返回完整用户）
 * @param {string} o.prefix 对外前缀（形如 /eryuan/v1）
 */
export function createAppLogin({ hostUser, prefix, randomNonce }) {
  const PAGE = `${prefix}/app-login`;
  const VERIFY = `${prefix}/app-login/verify`;
  const nonceOf = randomNonce || (() => Math.random().toString(36).slice(2) + Date.now().toString(36));

  /** @returns {Promise<boolean>} 处理了就返回 true */
  async function handle(req, res, { path }) {
    if (path === PAGE) {
      if (req.method !== "GET" && req.method !== "HEAD") {
        json(res, 405, { error: "method not allowed" });
        return true;
      }
      const nonce = nonceOf();
      const body = Buffer.from(renderEntryPage({ verifyUrl: VERIFY, nonce }), "utf8");
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": body.length,
        // 这一页永远不许被缓存：它是身份交接口，缓存住等于把上一个人的交接过程留在盘上。
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Content-Security-Policy":
          `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; ` +
          `connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      });
      res.end(req.method === "HEAD" ? undefined : body);
      return true;
    }

    if (path === VERIFY) {
      if (req.method !== "POST") {
        json(res, 405, { error: "method not allowed" });
        return true;
      }
      let body;
      try {
        body = await readSmallJson(req);
      } catch {
        json(res, 400, { error: "bad request" });
        return true;
      }
      const token = typeof body.token === "string" ? body.token : "";
      if (!token) {
        json(res, 401, { error: "缺少登录凭据" });
        return true;
      }
      const user = await hostUser(token);
      if (!user || !user.uid) {
        json(res, 401, { error: "登录凭据无效或已过期" });
        return true;
      }
      // 调用方声称的 uid 必须和宿主的答案对上——对不上说明这两样不是一套，一律拒。
      if (body.uid && String(body.uid) !== String(user.uid)) {
        json(res, 401, { error: "凭据与账号对不上" });
        return true;
      }
      const sid = newSid();
      const { session, local } = buildSessionEntries(user, token, sid);
      json(res, 200, {
        sid,
        session,
        local,
        to: sanitizeReturnTo(body.to, { selfPath: PAGE }),
      });
      return true;
    }

    return false;
  }

  return { handle, PAGE, VERIFY };
}

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
  res.end(data);
}

/** 这个口只收很小的一点 JSON，上限给得比通用的紧 */
async function readSmallJson(req, limitBytes = 8 * 1024) {
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
