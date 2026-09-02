/**
 * 🔴 铁线守卫：除了 src/host/，全包不许碰宿主（@octo/*）。
 *
 * 为什么要有这个测试（SPEC.md §0）：
 *   "我们写的所有东西必须能整个拔下来换个壳" —— 这句话如果只写在文档里，
 *   下一个人（包括未来的我）随手 import 一个 @octo/xxx 就把它撕了，而且没人会发现。
 *   所以它必须是一条会报红的线，不是一句约定。
 *
 * 对标：OCTO 自己就是这么守它的插槽边界的
 *   （octo-web/apps/web/src/__tests__/enterpriseModuleSlot.test.ts:5-11
 *     断言宿主入口不许 import @octo/{docs,loop,personal,drive}）。
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SRC = join(__dirname, "..", "src");
/** 唯一允许接触宿主的目录 */
const HOST_DIR = "host";
/** 任何形式的宿主 import：import ... from "@octo/x" / require("@octo/x") / import("@octo/x") */
const HOST_IMPORT = /(?:from\s*|require\s*\(\s*|import\s*\(\s*)["'`]@octo\//;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe("宿主隔离铁线", () => {
  const files = walk(SRC);

  it("src/ 下确实有文件可扫（防止测试因路径写错而空跑通过）", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("除 src/host/ 外，任何文件都不许 import @octo/*", () => {
    const offenders: string[] = [];

    for (const file of files) {
      const rel = relative(SRC, file);
      if (rel.split(sep)[0] === HOST_DIR) continue; // host/ 是唯一豁免
      const src = readFileSync(file, "utf8");
      if (HOST_IMPORT.test(src)) offenders.push(rel);
    }

    expect(
      offenders,
      `这些文件把宿主依赖漏到了 host/ 之外，换壳时会被卡住：\n  ${offenders.join("\n  ")}\n` +
        `修法：把需要的能力加进 src/host/types.ts 的 HostAdapter，再由 host/<宿主>.tsx 实现。`
    ).toEqual([]);
  });

  it("host/types.ts 自己也不许碰宿主（它是契约，必须中立）", () => {
    const src = readFileSync(join(SRC, HOST_DIR, "types.ts"), "utf8");
    expect(HOST_IMPORT.test(src)).toBe(false);
  });
});
