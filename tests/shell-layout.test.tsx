/**
 * 布局守卫 —— 苏白 2026-09-02 定的那条：
 * **左边是上下切换的地方，右边是真实展示的地方。**
 *
 * 为什么要机器守：上一版是"页签横在顶上"，他的原话是"那个位置太小了"。
 * 这种事只写在注释里，下一个人（包括未来的我）为了少写几行又会把它拍回一列，
 * 而且所有功能测试照样全绿。所以它必须是一条会报红的线。
 *
 * 用 renderToStaticMarkup 而不是 jsdom + testing-library：这里验的是
 * "首屏结构长对了"，服务端渲染足够（useEffect 不跑 = 不会发请求），
 * 而且省掉两个不小的依赖 —— 这个包要保持能被搬走。
 */
import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SuperAppPage from "../src/shell/SuperAppPage";
import { LAYOUT_BUILD_MARK } from "../src/shell/theme";
import type { HostAdapter } from "../src/host/types";

/** 一个什么都不做的宿主 —— 我们只看首屏画成什么样 */
const fakeHost: HostAdapter = {
  name: "test",
  registerEntry: () => undefined,
  navigate: () => undefined,
  identity: () => ({ uid: "u_test", token: "t" }),
};

const html = () => renderToStaticMarkup(<SuperAppPage host={fakeHost} />);

describe("整页布局：左边切换 / 右边展示", () => {
  it("有左栏，而且左栏里是三格上下排列的导航", () => {
    const out = html();
    expect(out).toContain("ysa-side");
    expect(out).toContain("ysa-side-menu");
    for (const label of ["我的应用", "市场", "我的发布"]) {
      expect(out, `左栏少了「${label}」这一格`).toContain(label);
    }
    // 三格必须都是 side-item（而不是被塞回顶部页签）
    const items = out.match(/class="ysa-side-item[^"]*"/g) || [];
    expect(items.length, "左栏导航项数量不对 —— 布局可能被改回横排页签了").toBe(3);
  });

  it("有右栏，且顶栏/内容区分开（不是一列灌到底）", () => {
    const out = html();
    expect(out).toContain("ysa-main");
    expect(out).toContain("ysa-top");
    expect(out).toContain("ysa-content");
  });

  it("两栏栅格真的写在样式里（260px + 剩下的全给右边）", () => {
    const out = html();
    expect(out).toContain(LAYOUT_BUILD_MARK);
    expect(
      out.includes("grid-template-columns:260px minmax(0,1fr)"),
      "两栏栅格没了 —— 右边那块又会被压窄"
    ).toBe(true);
  });

  it("窄屏不把左栏藏掉，而是收成一条横着的导航", () => {
    const out = html();
    // 原型是 display:none 直接藏掉；我们刻意不那么做 ——
    // 藏掉之后手机上就没法切换了。
    expect(out).toContain("@media (max-width:860px)");
    expect(out).not.toMatch(/\.ysa-side\{display:none/);
    // 宽屏竖着排、窄屏横着排 —— 两条都得显式写。
    // v3 踩过：基础规则从 grid 改成 flex column 后，窄屏那条没写 row，
    // 三个胶囊就竖了起来（预览截图里当场看见）。
    expect(out).toMatch(/\.ysa-side-menu\{[^}]*flex-direction:column/);
    expect(out).toMatch(/@media \(max-width:860px\)\{[\s\S]*\.ysa-side-menu\{[^}]*flex-direction:row/);
  });

  it("左栏三格不会被拉高填满整条栏", () => {
    const out = html();
    // 🔴 v3 踩过：`.ysa-side-menu` 用 grid + flex:1，三行把剩余高度平分，
    //    "我的应用"变成一个 300px 高的大色块。flex column 天然不拉伸。
    expect(out).not.toMatch(/\.ysa-side-menu\{[^}]*display:grid/);
  });

  it("卡片栅格铺满整行 —— 不许再给卡片封顶宽", () => {
    const out = html();
    // 🔴 病根记录：v2 写的是 `minmax(320px,432px)`，卡片被封了顶宽，
    //    宽屏上排两张之后右边一大片空白（苏白 2026-09-02 截图问"他们官方就是这样吗"）。
    //    他们上线那套用的是 1fr，卡片自己把整行铺满。改回去要报红。
    expect(
      out.includes("minmax(min(100%,270px),1fr)"),
      "卡片栅格不是铺满整行的写法 —— 宽屏上又会空出一大块"
    ).toBe(true);
    expect(
      out,
      "卡片又被封了顶宽（minmax 的第二个值不是 1fr）"
    ).not.toMatch(/\.ysa-grid\{[^}]*minmax\([^)]*px\s*,\s*\d+px\)/);
    // 卡片等高：他们靠 min-height + 底部动作区 margin-top:auto，一行一句的卡片不会高低不齐
    expect(out.includes("min-height:174px"), "卡片最小高度没了 —— 卡片会高低不齐").toBe(true);
  });

  it("样式只在自己的子树里生效，不污染宿主页面", () => {
    const out = html();
    const css = out
      .slice(out.indexOf(">", out.indexOf("<style")) + 1, out.indexOf("</style>"))
      .replace(/\/\*[\s\S]*?\*\//g, ""); // 注释里也有 `.ysa-` 之类的字，先去掉

    // 每个 `{` 前面那段就是选择器；@media 是块，本身不产生选择器
    const bad: string[] = [];
    for (const chunk of css.split("{")) {
      const sel = chunk.split(/[}]/).pop()?.trim();
      if (!sel || sel.startsWith("@")) continue;
      const scoped = sel.split(",").every((one) => one.trim().startsWith(".ysa-"));
      if (!scoped) bad.push(sel);
    }
    expect(bad, `这些选择器会漏到宿主页面上：\n  ${bad.join("\n  ")}`).toEqual([]);
  });
});
