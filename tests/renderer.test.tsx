/**
 * Blueprint 渲染器的健壮性测试。
 *
 * 这里测的重点不是"好看"，而是**打不死**：
 * blueprint 是 AI 产出的，它迟早会给出我们没实现的组件、错类型的字段、
 * 甚至一棵极深的树。渲染器唯一不可接受的行为是**整页崩掉**。
 *
 * 用 renderToStaticMarkup 而不是 jsdom + testing-library：
 * 我们要验的是"渲染不抛异常、内容出现在输出里"，服务端渲染足够，
 * 而且省掉两个不小的依赖 —— 这个包要保持能被搬走。
 */
import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import BlueprintRenderer from "../src/runtime/BlueprintRenderer";

const render = (node: unknown) =>
  renderToStaticMarkup(<BlueprintRenderer node={node} />);

describe("BlueprintRenderer · 正常渲染", () => {
  it("渲染一棵典型的页面树", () => {
    const html = render({
      type: "page",
      children: [
        { type: "heading", value: "本月订单", level: 2 },
        { type: "text", value: "一共 3 单" },
        { type: "badge", value: "已完成" },
        { type: "list", items: ["甲", "乙"] },
        {
          type: "table",
          columns: ["名称", "金额"],
          rows: [["咖啡", 28], ["茶", 18]],
        },
      ],
    });
    expect(html).toContain("本月订单");
    expect(html).toContain("一共 3 单");
    expect(html).toContain("已完成");
    expect(html).toContain("咖啡");
    expect(html).toContain("28");
  });

  it("裸字符串和数组也能渲染（AI 经常直接给这个）", () => {
    expect(render("光秃秃一句话")).toContain("光秃秃一句话");
    expect(render([{ type: "text", value: "甲" }, { type: "text", value: "乙" }]))
      .toContain("乙");
  });

  it("宽表包在可横向滚动的容器里（不能把整页撑出横向滚动条）", () => {
    const html = render({ type: "table", columns: ["a"], rows: [["b"]] });
    expect(html).toContain("overflow-x:auto");
  });
});

describe("BlueprintRenderer · 打不死", () => {
  it("不认识的组件类型 → 降级成占位，不抛错", () => {
    const html = render({ type: "quantum-flux-capacitor", children: [{ type: "text", value: "内层还在" }] });
    expect(html).toContain("暂不支持的组件");
    expect(html).toContain("quantum-flux-capacitor"); // 要报出类型名，我们才知道该补什么
    expect(html).toContain("内层还在");               // 子节点不能跟着一起丢
  });

  it("各种畸形输入都不抛异常", () => {
    const junk: unknown[] = [
      null,
      undefined,
      0,
      "",
      [],
      {},
      { type: null },
      { type: 123 },
      { type: "text", value: { nested: "object" } },   // value 给了对象
      { type: "list", items: "不是数组" },
      { type: "table", columns: null, rows: "什么鬼" },
      { type: "page", children: "不是数组" },
      { type: "heading", level: 99 },
      { type: "heading", level: -5 },
    ];
    for (const j of junk) {
      expect(() => render(j), `输入：${JSON.stringify(j)}`).not.toThrow();
    }
  });

  it("超深嵌套会被截断而不是把栈撑爆", () => {
    let node: Record<string, unknown> = { type: "text", value: "底" };
    for (let i = 0; i < 200; i++) node = { type: "page", children: [node] };
    let html = "";
    expect(() => { html = render(node); }).not.toThrow();
    expect(html).toContain("嵌套过深");
  });

  it("表格行列数不齐也不崩", () => {
    const html = render({
      type: "table",
      columns: ["a", "b", "c"],
      rows: [["只有一列"], ["三", "列", "齐"], "整行不是数组"],
    });
    expect(html).toContain("只有一列");
    expect(html).toContain("三");
  });
});
