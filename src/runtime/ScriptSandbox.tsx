/**
 * script 节点的落点 —— 唯一一处真正执行 AI 写的代码的地方。
 *
 * 09-03 苏白拍板方向："AI 写的代码在用户浏览器里跑，密钥不直接写进代码里，
 * 通过连接器在后台换取"。这个组件就是那句话的落地，三条硬约束缺一不可：
 *
 *  1. **不跑在我们服务器上。** 这段代码从始至终只存在于这个 iframe 里，
 *     跟"我们的机器会不会被一段写坏/使坏的代码拖垮"这个问题彻底无关——
 *     最坏情况只发生在这一个用户自己的浏览器标签页里。
 *
 *  2. **iframe 故意不给 `allow-same-origin`。** 这一条决定了这段代码进不了
 *     我们的页面——读不到 cookie/localStorage/父页面 DOM，也不能同源请求
 *     宿主或我们的后端接口。它活在一个每次都不同的、谁也不认识的源里。
 *
 *  3. **CSP 把 iframe 自己的出站网络也锁死（`default-src 'none'`）。**
 *     只有第 2 条其实不够——没有 allow-same-origin 的 iframe 仍然能自己发起
 *     跨域 fetch，把页面上的数据发去任何第三方地址。锁死之后，这段代码唯一
 *     能碰到外面的路，只剩 `postMessage` 到父页面，而父页面只认一种消息
 *     （`connectorCall`），其余一律不理。**外部数据访问被迫全部收拢到"连接器"
 *     这一个受控出口**——这正是加这一层安全绳的意义，不是可有可无的装饰。
 *
 * 密钥本身完全不出现在这个文件、这个 iframe、这次请求的任何一步——
 * 它只活在 connectors.mjs 那一层，代理调用完成后就地丢弃。
 */
import React, { useEffect, useRef, useState } from "react";

export interface ConnectorCallRequest {
  method?: string;
  path?: string;
  query?: Record<string, string>;
  body?: unknown;
}

export interface ScriptSandboxProps {
  code: string;
  title?: string;
  /** 真正发起代理调用的人——不传就是"这个上下文没接后端"，脚本的调用会立刻收到错误 */
  onConnectorCall?: (connectorId: string, req: ConnectorCallRequest) => Promise<unknown>;
}

const CALL_TIMEOUT_MS = 20_000;

/** 转义 `</script`，防止脚本内容提前闭合我们拼出来的 <script> 标签而逃出沙盒文档结构 */
function escapeForInlineScript(code: string): string {
  return code.replace(/<\/script/gi, "<\\/script");
}

function buildSrcDoc(code: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:">
<style>body{margin:0;padding:12px;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#1a1a1a}</style>
</head><body>
<div id="app"></div>
<script>
(function () {
  "use strict";
  var pending = Object.create(null);
  var seq = 0;
  window.Yoyoo = {
    connectorCall: function (connectorId, req) {
      var callId = "c" + (++seq);
      return new Promise(function (resolve, reject) {
        var timer = setTimeout(function () {
          delete pending[callId];
          reject(new Error("connectorCall 超时（" + ${CALL_TIMEOUT_MS} + "ms 没有响应）"));
        }, ${CALL_TIMEOUT_MS});
        pending[callId] = { resolve: resolve, reject: reject, timer: timer };
        parent.postMessage({ type: "yoyoo:connectorCall", callId: callId, connectorId: connectorId, req: req || {} }, "*");
      });
    }
  };
  window.addEventListener("message", function (ev) {
    var data = ev.data;
    if (!data || data.type !== "yoyoo:connectorCallResult") return;
    var p = pending[data.callId];
    if (!p) return;
    clearTimeout(p.timer);
    delete pending[data.callId];
    if (data.ok) p.resolve(data.result);
    else p.reject(new Error(String(data.error || "connectorCall 失败")));
  });
  try {
    ${escapeForInlineScript(code)}
  } catch (e) {
    var el = document.getElementById("app");
    if (el) el.textContent = "脚本出错：" + (e && e.message ? e.message : String(e));
  }
})();
</script>
</body></html>`;
}

export const ScriptSandbox: React.FC<ScriptSandboxProps> = ({ code, title, onConnectorCall }) => {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [srcDoc] = useState(() => buildSrcDoc(code));

  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      const win = iframeRef.current?.contentWindow;
      // 🔴 只认这一个 iframe 发来的消息——页面上可能同时挂着好几个 script 节点，
      //    不做来源校验会串话（A 的回调打到 B 头上）。
      if (!win || ev.source !== win) return;
      const data = ev.data as { type?: string; callId?: string; connectorId?: string; req?: ConnectorCallRequest };
      if (!data || data.type !== "yoyoo:connectorCall") return;

      const reply = (payload: Record<string, unknown>) => {
        win.postMessage({ type: "yoyoo:connectorCallResult", callId: data.callId, ...payload }, "*");
      };
      if (!onConnectorCall) {
        reply({ ok: false, error: "这个上下文还不支持连接器调用" });
        return;
      }
      if (!data.connectorId || typeof data.connectorId !== "string") {
        reply({ ok: false, error: "connectorId 必须是字符串" });
        return;
      }
      onConnectorCall(data.connectorId, data.req || {})
        .then((result) => reply({ ok: true, result }))
        .catch((e) => reply({ ok: false, error: String(e?.message || e) }));
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onConnectorCall]);

  return (
    <div style={{ border: "1px solid var(--wk-border-default, #e5e5ea)", borderRadius: 12, overflow: "hidden" }}>
      {title ? (
        <div style={{ padding: "8px 12px", fontSize: 13, fontWeight: 600, borderBottom: "1px solid var(--wk-border-default, #e5e5ea)" }}>
          {title}
        </div>
      ) : null}
      <iframe
        ref={iframeRef}
        // 🔴 故意不给 allow-same-origin：这一条本身就是安全边界，不是可调的性能选项。
        sandbox="allow-scripts"
        srcDoc={srcDoc}
        style={{ width: "100%", minHeight: 220, border: "none", display: "block" }}
        title={title || "自定义应用"}
      />
    </div>
  );
};

export default ScriptSandbox;
