/**
 * 内联样式表 —— 两个页签共用的**唯一一份**。
 *
 * 为什么是内联对象而不是 CSS 文件：这个包要能被整个拔走换壳，
 * 带一张需要宿主构建流程配合的样式表就多一条耦合。
 * 颜色一律走 `var(--wk-*, 兜底值)`：宿主给了就跟着宿主的主题走（含深色），
 * 没给就用兜底值 —— 换壳后不会变成一片白底黑字的裸页面。
 *
 * 🔴 本文件不许 import 任何 `@octo/*`（tests/no-host-leak.test.ts 守着）。
 */
import type React from "react";

export const c = {
  page: {
    height: "100%",
    overflow: "auto",
    padding: "28px 32px 48px",
    background: "var(--wk-bg-default, #fff)",
    color: "var(--wk-text-primary, #1c1c23)",
  } as React.CSSProperties,
  h1: { fontSize: 22, fontWeight: 600, margin: "0 0 4px" } as React.CSSProperties,
  sub: { margin: "0 0 20px", opacity: 0.6, fontSize: 13 } as React.CSSProperties,
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
    gap: 12,
  } as React.CSSProperties,
  card: {
    textAlign: "left",
    border: "1px solid var(--wk-border-default, #e5e5ea)",
    borderRadius: 12,
    padding: 16,
    cursor: "pointer",
    background: "transparent",
    color: "inherit",
    font: "inherit",
    display: "flex",
    flexDirection: "column",
    gap: 8,
  } as React.CSSProperties,
  btn: {
    padding: "9px 18px",
    borderRadius: 8,
    border: "none",
    cursor: "pointer",
    fontSize: 14,
    background: "var(--wk-brand-primary, #5d67aa)",
    color: "var(--wk-text-on-brand, #fff)",
  } as React.CSSProperties,
  ghost: {
    padding: "7px 14px",
    borderRadius: 8,
    cursor: "pointer",
    fontSize: 13,
    background: "transparent",
    border: "1px solid var(--wk-border-default, #e5e5ea)",
    color: "inherit",
  } as React.CSSProperties,
  empty: {
    border: "1px dashed var(--wk-border-default, #d8d8e0)",
    borderRadius: 16,
    padding: "40px 32px",
    maxWidth: 560,
    display: "flex",
    flexDirection: "column",
    gap: 14,
    alignItems: "flex-start",
  } as React.CSSProperties,
  badge: {
    fontSize: 11,
    padding: "1px 8px",
    borderRadius: 999,
    background: "var(--wk-brand-tint-10, rgba(93,103,170,.1))",
    color: "var(--wk-brand-primary, #5d67aa)",
  } as React.CSSProperties,
  /** "有更新"这类需要被看见的提示，用暖色和品牌色区分开 */
  badgeWarn: {
    fontSize: 11,
    padding: "1px 8px",
    borderRadius: 999,
    background: "rgba(214,145,32,.12)",
    color: "#b8860b",
  } as React.CSSProperties,
  composer: { display: "flex", gap: 8, marginBottom: 8, maxWidth: 640 } as React.CSSProperties,
  input: {
    flex: 1,
    minWidth: 0,
    padding: "9px 14px",
    borderRadius: 8,
    fontSize: 14,
    color: "inherit",
    background: "transparent",
    border: "1px solid var(--wk-border-default, #e5e5ea)",
  } as React.CSSProperties,
  hint: { margin: "0 0 20px", fontSize: 12, opacity: 0.55, maxWidth: 640, lineHeight: 1.7 } as React.CSSProperties,
  err: {
    padding: "10px 14px",
    borderRadius: 8,
    fontSize: 13,
    background: "rgba(220,60,60,.08)",
    color: "#c0392b",
    marginBottom: 16,
  } as React.CSSProperties,
  tabs: {
    display: "flex",
    gap: 4,
    marginBottom: 20,
    borderBottom: "1px solid var(--wk-border-default, #e5e5ea)",
  } as React.CSSProperties,
  tab: (active: boolean): React.CSSProperties => ({
    padding: "8px 14px",
    fontSize: 14,
    cursor: "pointer",
    background: "transparent",
    border: "none",
    borderBottom: `2px solid ${active ? "var(--wk-brand-primary, #5d67aa)" : "transparent"}`,
    color: active ? "var(--wk-brand-primary, #5d67aa)" : "inherit",
    opacity: active ? 1 : 0.65,
    fontWeight: active ? 600 : 400,
    marginBottom: -1,
  }),
  /** 弹层：发布确认、私货命中清单都用它 */
  modalMask: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,.35)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
  } as React.CSSProperties,
  modal: {
    width: "min(520px, calc(100vw - 48px))",
    maxHeight: "calc(100vh - 96px)",
    overflow: "auto",
    borderRadius: 16,
    padding: 24,
    background: "var(--wk-bg-default, #fff)",
    color: "var(--wk-text-primary, #1c1c23)",
    boxShadow: "0 18px 48px rgba(0,0,0,.22)",
    display: "flex",
    flexDirection: "column",
    gap: 14,
  } as React.CSSProperties,
  warnBox: {
    border: "1px solid rgba(214,145,32,.4)",
    background: "rgba(214,145,32,.08)",
    borderRadius: 10,
    padding: 14,
    fontSize: 13,
    lineHeight: 1.8,
  } as React.CSSProperties,
};

export const fmtTime = (ms: number): string => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
