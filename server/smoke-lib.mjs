/**
 * 冒烟测试的两条公共护栏 —— **只有这一份实现**，七支冒烟共用。
 *
 * 🔴 为什么有这个文件（2026-09-15）：`bot-authoring-smoke` 红了 9 条、全是 401，
 *    查了半天跟代码无关 —— 一个上一轮遗留的 `index.mjs` **孤儿进程**占着 8794，
 *    假宿主起不来，请求全打到那个陌生进程上。日志里看不出任何原因。
 *
 *    孤儿是冒烟自己漏杀出来的：中途一抛异常就 `process.exit(1)`，
 *    spawn 出来的服务端留在世上。七支里有三支**压根没写 kill**。
 *    一次漏杀，之后每一次跑都红，而且红得没道理 —— 这是最贵的一种红。
 *
 * ① `assertPortFree(port)`：起跑前先探端口，被占就当场喊停。
 *    宁可一句话说清"端口被占"，也不要对着陌生人跑完、报一堆假红。
 * ② `track(child)`：起出来的子进程一律记账，进程任何走法（正常结束／抛异常／
 *    Ctrl-C／被 kill）都收走。不再生孤儿。
 */
import { createServer } from "node:http";

const spawned = new Set();

function reapAll() {
  for (const p of spawned) {
    try { p.kill(); } catch { /* 已经没了就算了 */ }
  }
  spawned.clear();
}

process.on("exit", reapAll);
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { reapAll(); process.exit(1); });
}

/** 记账一个子进程。原样返回，方便写成 `const p = track(spawn(...))`。 */
export function track(child) {
  spawned.add(child);
  return child;
}

/** 端口被别人占着就喊停 —— 不对着陌生进程跑测试。 */
export async function assertPortFree(port) {
  const busy = await new Promise((resolve) => {
    const s = createServer();
    s.once("error", (e) => resolve(e.code === "EADDRINUSE"));
    s.once("listening", () => s.close(() => resolve(false)));
    s.listen(port, "127.0.0.1");
  });
  if (!busy) return;
  console.error(
    `\n\x1b[31m端口 ${port} 已被占用 —— 这支冒烟不会对着别人的进程跑。\x1b[0m\n` +
    `先看是谁：  ss -lntp | grep ${port}\n` +
    `多半是上一轮遗留的 server/index.mjs 孤儿，kill 掉再跑。\n`
  );
  process.exit(1);
}
