/**
 * Blueprint 渲染器 —— 把一棵 JSON 树渲染成界面。
 *
 * 这是"AI 画界面"的落点：AI 产出的是数据（blueprint），不是代码，
 * 由我们这边的受控组件来画。所以 AI 画不出我们没允许的东西 —— 安全性来自这个约束本身。
 *
 * 🔴 两条铁规矩：
 *   1. **遇到不认识的组件类型，绝不能崩。** AI 一定会产出我们还没实现的类型，
 *      那是常态不是异常。整页白屏是最坏结果，降级成一个占位块才是对的。
 *   2. **不许 import 宿主的东西**（tests/no-host-leak.test.ts 守着）。
 *      这一层将来要能原样搬到别的壳里，甚至搬到我们自己的 IM 里。
 *
 * 后续（P1b）：这套受控组件会换成 dsh-genui 的 43 个组件，词汇量一次拉满。
 * 现在这版只做最小集合，先把"AI 产 JSON → 落库 → 反复打开"这条管道跑通。
 */
import React from "react";
import ScriptSandbox, { type ConnectorCallRequest } from "./ScriptSandbox";

export interface BlueprintNode {
  type?: string;
  [key: string]: unknown;
}

const S = {
  page: { display: "flex", flexDirection: "column", gap: 16 } as React.CSSProperties,
  h: { margin: 0, fontWeight: 600, lineHeight: 1.35 } as React.CSSProperties,
  text: { margin: 0, lineHeight: 1.7, opacity: 0.85 } as React.CSSProperties,
  card: {
    border: "1px solid var(--wk-border-default, #e5e5ea)",
    borderRadius: 12,
    padding: 16,
    display: "flex",
    flexDirection: "column",
    gap: 10,
  } as React.CSSProperties,
  table: { width: "100%", borderCollapse: "collapse", fontSize: 14 } as React.CSSProperties,
  th: {
    textAlign: "left",
    padding: "8px 10px",
    borderBottom: "1px solid var(--wk-border-default, #e5e5ea)",
    fontWeight: 600,
    whiteSpace: "nowrap",
  } as React.CSSProperties,
  td: {
    padding: "8px 10px",
    borderBottom: "1px solid var(--wk-border-subtle, #f0f0f4)",
  } as React.CSSProperties,
  badge: {
    display: "inline-block",
    padding: "2px 10px",
    borderRadius: 999,
    fontSize: 12,
    background: "var(--wk-brand-tint-10, rgba(93,103,170,.1))",
    color: "var(--wk-brand-primary, #5d67aa)",
  } as React.CSSProperties,
  button: {
    alignSelf: "flex-start",
    padding: "8px 16px",
    borderRadius: 8,
    border: "none",
    cursor: "pointer",
    fontSize: 14,
    background: "var(--wk-brand-primary, #5d67aa)",
    color: "var(--wk-text-on-brand, #fff)",
  } as React.CSSProperties,
  unknown: {
    padding: "10px 12px",
    borderRadius: 8,
    border: "1px dashed var(--wk-border-default, #d5d5dd)",
    fontSize: 13,
    opacity: 0.7,
  } as React.CSSProperties,
};

/** 安全取字符串：AI 可能给任何东西（数字、对象、null） */
const str = (v: unknown, fallback = ""): string =>
  typeof v === "string" ? v
    : typeof v === "number" || typeof v === "boolean" ? String(v)
    : fallback;

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export interface RendererProps {
  node: unknown;
  /** 按钮等交互的回调；不传则按钮只是展示 */
  onAction?: (action: unknown, node: BlueprintNode) => void;
  /**
   * `script` 节点里的代码调连接器时真正发起请求的人。不传的话 script 节点
   * 依然会渲染（沙盒本身不需要它），但里面的 `Yoyoo.connectorCall` 一律收到失败——
   * 宁可"这个上下文没接后端"表现为脚本报错，也不该让沙盒去信任脚本自己声称的身份。
   */
  onConnectorCall?: (connectorId: string, req: ConnectorCallRequest) => Promise<unknown>;
  depth?: number;
}

/** 防御深度炸弹：AI 或恶意输入可能给一棵极深的树 */
const MAX_DEPTH = 24;

export const BlueprintRenderer: React.FC<RendererProps> = ({ node, onAction, onConnectorCall, depth = 0 }) => {
  if (depth > MAX_DEPTH) {
    return <div style={S.unknown}>（嵌套过深，已停止渲染）</div>;
  }
  if (node == null) return null;

  // 裸字符串/数字也当文本渲染 —— AI 经常这么给
  if (typeof node === "string" || typeof node === "number") {
    return <p style={S.text}>{String(node)}</p>;
  }
  if (Array.isArray(node)) {
    return (
      <>
        {node.map((child, i) => (
          <BlueprintRenderer key={i} node={child} onAction={onAction} onConnectorCall={onConnectorCall} depth={depth + 1} />
        ))}
      </>
    );
  }
  if (typeof node !== "object") return null;

  const n = node as BlueprintNode;
  const type = str(n.type, "").toLowerCase();
  const children = (
    <>
      {arr(n.children).map((child, i) => (
        <BlueprintRenderer key={i} node={child} onAction={onAction} onConnectorCall={onConnectorCall} depth={depth + 1} />
      ))}
    </>
  );

  switch (type) {
    case "page":
    case "container":
    case "stack":
      return <div style={S.page}>{children}</div>;

    case "card":
    case "section":
      return (
        <div style={S.card}>
          {n.title ? <h3 style={{ ...S.h, fontSize: 16 }}>{str(n.title)}</h3> : null}
          {children}
        </div>
      );

    case "heading":
    case "title": {
      const level = Math.min(Math.max(Number(n.level) || 2, 1), 4);
      const size = [24, 20, 17, 15][level - 1];
      return <div style={{ ...S.h, fontSize: size }}>{str(n.value ?? n.text ?? n.title)}</div>;
    }

    case "text":
    case "paragraph":
      return <p style={S.text}>{str(n.value ?? n.text ?? n.content)}</p>;

    case "badge":
    case "tag":
      return <span style={S.badge}>{str(n.value ?? n.text ?? n.label)}</span>;

    case "divider":
      return (
        <hr style={{ border: 0, borderTop: "1px solid var(--wk-border-default,#e5e5ea)", margin: 0 }} />
      );

    case "list": {
      const items = arr(n.items);
      if (!items.length) return null;
      return (
        <ul style={{ margin: 0, paddingLeft: 20, lineHeight: 1.9 }}>
          {items.map((it, i) => (
            <li key={i}>{typeof it === "object" && it !== null
              ? <BlueprintRenderer node={it} onAction={onAction} onConnectorCall={onConnectorCall} depth={depth + 1} />
              : str(it)}</li>
          ))}
        </ul>
      );
    }

    case "table": {
      const columns = arr(n.columns).map((c) =>
        typeof c === "object" && c !== null ? str((c as BlueprintNode).title ?? (c as BlueprintNode).name) : str(c));
      const rows = arr(n.rows);
      return (
        // 宽表在窄屏要能自己横向滚，不能把整页撑出横向滚动条
        <div style={{ overflowX: "auto" }}>
          <table style={S.table}>
            {columns.length ? (
              <thead>
                <tr>{columns.map((c, i) => <th key={i} style={S.th}>{c}</th>)}</tr>
              </thead>
            ) : null}
            <tbody>
              {rows.map((row, ri) => (
                <tr key={ri}>
                  {arr(row).map((cell, ci) => <td key={ci} style={S.td}>{str(cell)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }

    case "button":
      return (
        <button
          type="button"
          style={S.button}
          onClick={() => onAction?.(n.action, n)}
        >
          {str(n.label ?? n.text ?? "按钮")}
        </button>
      );

    case "script":
      // 唯一真正执行代码的分支——细节全在 ScriptSandbox 里（隔离 iframe + 锁死出站网络）。
      return (
        <ScriptSandbox
          code={str(n.code)}
          title={typeof n.title === "string" ? n.title : undefined}
          onConnectorCall={onConnectorCall}
        />
      );

    default:
      // 🔴 这里是最重要的一个分支：不认识就降级，绝不抛错。
      // 显示类型名，方便我们知道 AI 想要什么组件、该补哪个。
      return (
        <div style={S.unknown}>
          暂不支持的组件{type ? `：${type}` : ""}
          {arr(n.children).length ? <div style={{ marginTop: 8 }}>{children}</div> : null}
        </div>
      );
  }
};

export default BlueprintRenderer;
