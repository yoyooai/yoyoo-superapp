/**
 * 应用深链 —— "AI 回一张卡片，点一下直接进到这个应用"的落点。
 *
 * 为什么单独成文件：取参数这件事本身有个**我不确定的地方** ——
 * 宿主前端用 history 路由时参数在 `location.search`，用 hash 路由时在
 * `#/superapp?app=...` 里。我没有把握它以后不换，所以两处都读。
 * 这种"两种都要兼容"的逻辑放在组件的 useEffect 里就没法测（没有 jsdom），
 * 抽成纯函数才能真的被测到，而不是靠我盯着它。
 */

/** URL 里的参数名 */
export const DEEPLINK_PARAM = "app";

/**
 * 构建产物自检标记。`yoyoo-octo/ship-web.sh` 会在打完包的 bundle 里 grep 它，
 * 用来确认"这一版深链代码真的进了这个包"——
 * 压缩器会把变量名压没，但字符串字面量会原样留下，所以标记必须是个字符串。
 */
export const DEEPLINK_BUILD_MARK = "yoyoo-deeplink/v1";

/**
 * 从 search / hash 里取出要打开的应用 id。
 * @param search 形如 `?app=xxx`（`location.search`）
 * @param hash   形如 `#/superapp?app=xxx`（`location.hash`）
 * @returns 应用 id，取不到返回 null
 */
/**
 * 侧栏钉位的槽位数 —— **上限 6，写死**（SPEC-market §4.2）。
 * 理由：这是别人家的侧栏，借一格算客气，填满是失礼，也是给用户造垃圾场。
 * 用户想放更多 ⇒ 该做"我的应用"里的置顶区，不是继续占侧栏。
 * 后端 `market.mjs` 的 `PIN_LIMIT` 必须与它一致（结构测试各自钉着一边）。
 */
export const PIN_SLOTS = 6;

export function parseDeepLinkAppId(search: string, hash: string): string | null {
  const fromSearch = new URLSearchParams(search || "").get(DEEPLINK_PARAM);
  if (fromSearch) return fromSearch;
  const h = hash || "";
  const at = h.indexOf("?");
  if (at < 0) return null;
  return new URLSearchParams(h.slice(at + 1)).get(DEEPLINK_PARAM) || null;
}
