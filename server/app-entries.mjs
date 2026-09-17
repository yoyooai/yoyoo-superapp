/**
 * 「发现页」入口清单 —— **安卓 App 那一页的正本在这里，不在包里**。
 *
 * 病根（TD-345，09-05 查实）：上游把宫格写死在 `ContextFragment.buildEntries()` 里。
 * 苏白说"要放很多个功能"⇒ 照那个写法，**每加一个功能 = 所有人重装 App**。
 * 所以清单从第一版就走服务端下发：App 里那份只是断网时的兜底。
 *
 * 这个口子刻意做成**公开、只读、无身份**：它只是一张菜单，进去以后每一页各自鉴权。
 * 要它带身份反而多一道会坏的环节（App 还没登录时这一页也得能画出来）。
 *
 * 🔴 `path` 只许站内相对路径。App 侧也会再判一次（两头都判，谁被改坏都拦得住），
 *    但服务端是正本：这里不许出现绝对 URL，否则就是把用户从我们的壳里带去别处。
 */

/**
 * 顺序就是宫格里的顺序。改这里 = 改所有人手机上的发现页（不用重装）。
 * `path` 为空 = 由 App 自己处理（原生页面，如智能总结）。
 */
export const DISCOVER_ENTRIES = [
  { id: "smart_summary", title: "智能总结", title_en: "Smart Summary", path: "" },
  { id: "superapp", title: "超级应用", title_en: "Super Apps", path: "/superapp" },
  { id: "ai_office", title: "AI 办公室", title_en: "AI Office", path: "/office" },
  { id: "channels", title: "渠道", title_en: "Channels", path: "/channels" },
  { id: "a2a", title: "A2A", title_en: "A2A", path: "/a2a" },
  { id: "agents", title: "Agent", title_en: "Agents", path: "/contacts" },
];

/** 站内相对路径判据。空串合法（表示"原生页面，没有网址"）。 */
export function isSafeSitePath(path) {
  if (typeof path !== "string") return false;
  if (path === "") return true;
  if (!path.startsWith("/")) return false;
  if (path.startsWith("//")) return false;
  if (path.includes("\\")) return false;
  if (/[\x00-\x20\x7f]/.test(path)) return false;
  return true;
}

export function createAppEntries({ prefix, entries = DISCOVER_ENTRIES }) {
  const PATH = `${prefix}/app-entries`;

  async function handle(req, res, { path }) {
    if (path !== PATH) return false;
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "method not allowed" }));
      return true;
    }
    // 坏数据不发出去：正本里混进一个绝对 URL 的话，宁可少一项也不把用户带去站外。
    const safe = entries.filter((e) => e && e.id && e.title && isSafeSitePath(e.path || ""));
    const body = Buffer.from(JSON.stringify({ version: 1, entries: safe }), "utf8");
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": body.length,
      // 菜单会变，但不该每次开页都回源 —— 缓存一分钟，改完最多一分钟全员生效。
      "cache-control": "public, max-age=60",
    });
    res.end(req.method === "HEAD" ? undefined : body);
    return true;
  }

  return { handle, PATH };
}
