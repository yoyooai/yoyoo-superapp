/**
 * ScriptSandbox 的安全边界守卫测试。
 *
 * 这三条断言对应 ScriptSandbox.tsx 文件头写的三条硬约束——它们是"会被下一个人
 * 顺手删掉/改松"的那种东西（比如为了方便调试临时加个 allow-same-origin，
 * 提交时忘了改回来），所以钉成会报红的测试，不只是注释里的承诺。
 *
 * 用 renderToStaticMarkup，不引 jsdom——跟 remove-ai.test.tsx 同一个取舍，
 * 这个包要保持能被整个搬走（tests/no-host-leak.test.ts 守着同一条线）。
 */
import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ScriptSandbox from "../src/runtime/ScriptSandbox";
import { BlueprintRenderer } from "../src/runtime/BlueprintRenderer";

describe("ScriptSandbox 安全边界", () => {
  it("iframe 的 sandbox 属性只有 allow-scripts，绝不带 allow-same-origin", () => {
    const html = renderToStaticMarkup(<ScriptSandbox code="1" />);
    const m = html.match(/sandbox="([^"]*)"/);
    expect(m, "没找到 sandbox 属性").not.toBeNull();
    expect(m![1]).toBe("allow-scripts");
    expect(m![1]).not.toMatch(/allow-same-origin/);
  });

  it("srcDoc 里带着锁死出站网络的 CSP（default-src 'none'）", () => {
    const html = renderToStaticMarkup(<ScriptSandbox code="1" />);
    const m = html.match(/srcdoc="([^"]*)"/i);
    expect(m, "没找到 srcDoc").not.toBeNull();
    const decoded = m![1].replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
    expect(decoded).toMatch(/Content-Security-Policy/);
    expect(decoded).toMatch(/default-src 'none'/);
  });

  it("用户代码被原样嵌入沙盒文档里（而不是被吞掉或转义到不可执行）", () => {
    const marker = "window.__probe_marker_12345__=1";
    const html = renderToStaticMarkup(<ScriptSandbox code={marker} />);
    const m = html.match(/srcdoc="([^"]*)"/i);
    const decoded = m![1].replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
    expect(decoded).toContain(marker);
  });

  it("代码里带 </script> 也不会提前闭合沙盒的 <script> 标签", () => {
    const evil = "1</script><script>window.__escaped__=true";
    const html = renderToStaticMarkup(<ScriptSandbox code={evil} />);
    const m = html.match(/srcdoc="([^"]*)"/i);
    const decoded = m![1].replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
    // 转义后不应该出现真正能被 HTML 解析器识别的 </script 序列
    expect(decoded).not.toMatch(/<\/script/i);
  });

  it("BlueprintRenderer 遇到 script 节点会落到 ScriptSandbox（真渲染出 iframe）", () => {
    const html = renderToStaticMarkup(
      <BlueprintRenderer node={{ type: "page", children: [{ type: "script", code: "1", title: "看板" }] }} />
    );
    expect(html).toContain("<iframe");
    expect(html).toContain("看板");
  });

  it("没传 onConnectorCall 时依然渲染（不崩），只是脚本调用会失败——这一点由 ScriptSandbox 内部逻辑保证，这里只验证不崩", () => {
    expect(() => renderToStaticMarkup(<ScriptSandbox code="1" />)).not.toThrow();
  });
});
