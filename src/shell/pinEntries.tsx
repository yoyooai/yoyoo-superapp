/**
 * 侧栏钉位的入口构造 —— 抽成纯函数是为了**能被测到**。
 *
 * 🔴 不许 import 任何 `@octo/*`（tests/no-host-leak.test.ts 守着）。
 *
 * 这里最要紧的一条：pins 为空时 6 个槽位必须全部 `visible() === false`。
 * 少了这条判断，侧栏会凭空多出 6 个空图标 —— 那是把别人家的侧栏当垃圾场。
 * `tests/pin-entries.test.tsx` 里有一条反向验证钉着它：把 visible 去掉就报红。
 */
import React from "react";
import type { HostEntry } from "../host/types";
import { PIN_SLOTS } from "./deeplink";
import { getPinnedAt, requestOpenApp } from "./pinStore";

/** 钉位图标：直接画用户那个应用的 emoji；没有就用一个通用方块 */
export const PinIcon: React.FC<{ emoji?: string }> = ({ emoji }) => (
  <span
    style={{ fontSize: 18, lineHeight: "20px", display: "inline-block", width: 20, textAlign: "center" }}
    aria-hidden
  >
    {emoji || "▫️"}
  </span>
);

/** 「应用」入口那三个 render，钉位原样复用（点钉位进去的就是同一个页面） */
export type EntryRenders = Pick<HostEntry, "render" | "renderSidebar" | "renderStage">;

/**
 * 造 PIN_SLOTS 个钉位入口。
 *
 * @param path   与「应用」共用的路由；"打开哪一个"通过 onPress 传，**不塞进 path**
 *               （宿主路由表以 path 为 key，带 query 会被当成不存在的新路由）
 * @param baseSort 排序基数，钉位排在「应用」之后
 * @param renders 点进去渲染什么（和「应用」完全一样，分栏/整页三件套一起传 ——
 *                只传整页的话，钉位在分栏宿主上会退化成一条挤在窄栏里的页面）
 */
export function buildPinEntries(
  path: string,
  baseSort: number,
  renders: EntryRenders
): HostEntry[] {
  return Array.from({ length: PIN_SLOTS }, (_, i) => ({
    id: `yoyoo-pin-${i + 1}`,
    path,
    title: () => getPinnedAt(i)?.name ?? "",
    sort: baseSort + i,
    // 🔴 没钉满时多出来的槽位一律不显示
    visible: () => !!getPinnedAt(i),
    icon: () => <PinIcon emoji={getPinnedAt(i)?.icon} />,
    ...renders,
    onPress: () => {
      const p = getPinnedAt(i);
      if (p) requestOpenApp(p.appId);
    },
  }));
}
