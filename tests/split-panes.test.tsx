/**
 * 分栏守卫 —— 钉住 2026-09-02 那次事故的病根。
 *
 * 事故经过：OCTO 的 `route.register(path, handler)` 把 handler 挂在**窄的会话列表栏**，
 * 右边那块大区域是另一条路由（routeRight）。我们把整页塞给了它，于是整个应用被挤在
 * 一条 ~300px 的竖条里，按钮叠在一起、文字一个字一行。苏白截图问"这是什么情况？"。
 *
 * 所以这里守三件事：
 *  1. 导航那棵树里**不许**出现内容区（否则又是"整页塞窄栏"）；
 *  2. 内容那棵树里**不许**出现导航（否则内容区里又长出一条侧栏）；
 *  3. 装配时**三个 render 必须一起给**，而且内容必须推给主区路由。
 *
 * 第 3 条只能靠读源码守：装配那段要碰 `@octo/base`（真宿主），测试里跑不起来。
 * 读源码不如跑代码，但比没有强 —— 它挡的正是"下一个人图省事只传一个 render"。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SuperAppSidebar from "../src/shell/SuperAppSidebar";
import SuperAppStage from "../src/shell/SuperAppStage";
import { setNav } from "../src/shell/navStore";
import { PANE_SIDEBAR, PANE_STAGE } from "../src/shell/theme";
import type { HostAdapter } from "../src/host/types";

const fakeHost: HostAdapter = {
  name: "test",
  registerEntry: () => undefined,
  navigate: () => undefined,
  identity: () => ({ uid: "u_test", token: "t" }),
};

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");

/**
 * 只留标记，去掉自带的 <style>。
 * 样式表里当然会提到 `.ysa-side-item` 这类类名（两棵树共用一份 CSS），
 * 不去掉的话"内容区里有没有导航"这种断言会被样式表骗过去 —— 我们要看的是**画了什么**。
 */
const markupOnly = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, "");

describe("分栏：导航一棵树，内容另一棵树", () => {
  beforeEach(() => setNav("mine"));

  it("导航那棵树只有导航 —— 不带内容区（否则又会被挤进窄栏）", () => {
    const out = markupOnly(renderToStaticMarkup(<SuperAppSidebar />));
    expect(out).toContain("ysa-side");
    // 这个标记是构建自检（ship-web.sh）唯一能抓的证据，丢了＝上线时没人拦
    expect(out).toContain(PANE_SIDEBAR);
    expect((out.match(/class="ysa-side-item[^"]*"/g) || []).length).toBe(3);
    expect(out, "导航里混进了内容区 —— 分栏就白分了").not.toContain("ysa-content");
    expect(out).not.toContain("ysa-top-title");
  });

  it("内容那棵树只有内容 —— 不带导航（否则内容区里又长一条侧栏）", () => {
    const out = markupOnly(renderToStaticMarkup(<SuperAppStage host={fakeHost} />));
    expect(out).toContain("ysa-main");
    expect(out).toContain(PANE_STAGE);
    expect(out).toContain("ysa-content");
    expect(out, "内容区里混进了导航").not.toContain("ysa-side-item");
  });

  it("两棵树靠 navStore 对话：切到市场，内容区跟着换", () => {
    setNav("market");
    const stage = markupOnly(renderToStaticMarkup(<SuperAppStage host={fakeHost} />));
    expect(stage).toContain("市场");
    expect(stage).not.toContain("说一句话，比如");
    const side = markupOnly(renderToStaticMarkup(<SuperAppSidebar />));
    // 选中态也在另一棵树里同步了
    expect(side).toMatch(/class="ysa-side-item is-active"[^>]*>.*?市场/s);
  });

  it("🔴 装配时三个 render 一起给（含 6 个钉位入口）", () => {
    const src = read("src/index.tsx");
    expect(src, "少了 renderSidebar —— 分栏宿主会把整页塞进窄栏").toMatch(/renderSidebar:\s*\(\)\s*=>/);
    expect(src, "少了 renderStage —— 内容进不了主区").toMatch(/renderStage:\s*\(\)\s*=>/);
    // 钉位必须复用同一套 render，不能只给整页
    expect(src).toMatch(/buildPinEntries\([^)]*entryRenders\)/);
  });

  it("🔴 适配层把导航挂窄栏、把内容推主区（不是两个都挂窄栏）", () => {
    const src = read("src/host/octo.tsx");
    // 窄栏路由拿到的是 renderSidebar
    expect(src).toMatch(/route\.register\(\s*entry\.path,\s*\(\)\s*=>\s*<>\{entry\.renderSidebar!\(\)\}<\/>/);
    // 内容走 routeRight
    expect(src).toMatch(/WKApp\.routeRight/);
    expect(src).toMatch(/replaceToRoot\(node\)/);
    // 直接敲 URL / 刷新时要先画外壳，否则塌成一条光秃秃的窄栏
    expect(src).toMatch(/hostShell:/);
    // 主区 setter 没就绪时必须降级返回 false，不许让侧栏点不动
    expect(src).toMatch(/setReplaceToRoot" ?!== ?"function"|typeof right\.setReplaceToRoot !== "function"/);
  });
});
