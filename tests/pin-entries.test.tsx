/**
 * 侧栏钉位 —— SPEC-market §6 的前端两条：
 *   · 钉位工厂在 pins 为空时不显示（不留 6 个空图标在侧栏）
 *   · **反向验证**：把 visible 判断去掉 → 空图标出现 → 这里必须报红
 *
 * 反向验证怎么做到"必须红"：下面那条 `visible` 断言是**唯一**挡住空图标的东西。
 * 谁把 buildPinEntries 里的 `visible: () => !!getPinnedAt(i)` 删了或改成恒 true，
 * "pins 为空时全部不显示"当场失败。这就是 150 分线第三条要的"不能被无声撤销"。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { buildPinEntries } from "../src/shell/pinEntries";
import {
  getPinned, setPinned, subscribeOpenApp, subscribePinned, type PinnedApp,
} from "../src/shell/pinStore";
import { PIN_SLOTS } from "../src/shell/deeplink";

const RENDERS = { render: () => null, renderSidebar: () => null, renderStage: () => null };
const entries = () => buildPinEntries("/superapp", 6110, RENDERS);

const A: PinnedApp = { appId: "app-a", name: "订单看板", icon: "📊" };
const B: PinnedApp = { appId: "app-b", name: "本周待办" };

describe("侧栏钉位", () => {
  beforeEach(() => setPinned([]));

  it("永远只注册 PIN_SLOTS 个槽位（借一格算客气，填满是失礼）", () => {
    expect(entries()).toHaveLength(PIN_SLOTS);
    expect(PIN_SLOTS).toBe(6);
  });

  it("🔴 pins 为空时，6 个槽位全部不显示", () => {
    for (const e of entries()) {
      expect(e.visible?.()).toBe(false);
    }
  });

  it("钉了一个，只有第 1 个槽位显示，其余仍然不显示", () => {
    setPinned([A]);
    const es = entries();
    expect(es[0].visible?.()).toBe(true);
    expect(typeof es[0].title === "function" ? es[0].title() : es[0].title).toBe("订单看板");
    for (const e of es.slice(1)) expect(e.visible?.()).toBe(false);
  });

  it("标题和图标是现取的 —— 改了名字，侧栏跟着变（不用重新注册）", () => {
    setPinned([A]);
    const e = entries()[0];
    setPinned([{ ...A, name: "改过名的看板" }]);
    expect(typeof e.title === "function" ? e.title() : e.title).toBe("改过名的看板");
  });

  it("所有槽位共用「应用」那一个路由，绝不把 app id 塞进 path", () => {
    setPinned([A, B]);
    for (const e of entries()) {
      expect(e.path).toBe("/superapp");
      // 带 query 的 path 会被宿主当成一个不存在的新路由，点下去是空白页
      expect(e.path).not.toContain("?");
    }
  });

  it("点钉位发出打开请求（这是 app id 唯一的传递通道）", () => {
    setPinned([A, B]);
    const seen: string[] = [];
    const off = subscribeOpenApp((id) => seen.push(id));
    entries()[1].onPress?.();
    off();
    expect(seen).toEqual(["app-b"]);
  });

  it("🔴 送达过的请求不许留在待办里（否则返回后会自己又跳回去）", () => {
    setPinned([A]);
    const first: string[] = [];
    const off1 = subscribeOpenApp((id) => first.push(id));
    entries()[0].onPress?.();
    off1();
    expect(first).toEqual(["app-a"]);
    // 再挂载一次页面：不该收到任何"上一次的"请求
    const second: string[] = [];
    const off2 = subscribeOpenApp((id) => second.push(id));
    off2();
    expect(second).toEqual([]);
  });

  it("页面还没挂载时发的请求会被挂起，挂载后补送一次", () => {
    setPinned([A]);
    entries()[0].onPress?.(); // 此刻没有监听者
    const seen: string[] = [];
    const off = subscribeOpenApp((id) => seen.push(id));
    off();
    expect(seen).toEqual(["app-a"]);
  });

  it("没钉的槽位被点到也不发请求（防御：宿主若误画出来）", () => {
    const seen: string[] = [];
    const off = subscribeOpenApp((id) => seen.push(id));
    entries()[3].onPress?.();
    off();
    expect(seen).toEqual([]);
  });

  it("钉位变了会通知订阅者（宿主据此重画侧栏）", () => {
    let hits = 0;
    const off = subscribePinned(() => { hits++; });
    setPinned([A]);
    setPinned([A, B]);
    off();
    setPinned([]);
    expect(hits).toBe(2); // 退订之后那次不算
    expect(getPinned()).toEqual([]);
  });
});
