/**
 * 左栏选中项的唯一真源。
 *
 * 🔴 不许 import 任何 `@octo/*`（tests/no-host-leak.test.ts 守着）。
 *
 * 为什么要一个 store，而不是把状态放在页面组件里：
 * 分栏宿主（OCTO）把**导航**挂在窄栏、把**内容**挂在主区，这是两棵互不相干的
 * React 树 —— 谁都不是谁的父组件，props 传不过去。所以选中项必须住在两边都能
 * 读到的地方。整页模式（换壳后没有分栏的宿主）用的是同一份 store，
 * 两种模式因此走同一条代码路径，不会有一边先坏掉。
 */

export type Nav = "mine" | "market" | "published";

/** 左栏三格。顺序＝使用频率：自己的东西在最上面 */
export const NAV_ITEMS: { id: Nav; label: string }[] = [
  { id: "mine", label: "我的应用" },
  { id: "market", label: "市场" },
  { id: "published", label: "我的发布" },
];

let nav: Nav = "mine";
/** 我的应用有几个 —— 左栏那个角标；null ＝ 还没拉到，不显示 */
let appCount: number | null = null;
const listeners = new Set<() => void>();

const notify = () => listeners.forEach((l) => l());

export const getNav = (): Nav => nav;

export function setNav(next: Nav): void {
  if (nav === next) return;
  nav = next;
  notify();
}

export const getAppCount = (): number | null => appCount;

export function setAppCount(n: number | null): void {
  if (appCount === n) return;
  appCount = n;
  notify();
}

export function subscribeNav(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** 仅供测试：把 store 恢复到初始态，免得用例之间互相污染 */
export function resetNavStoreForTest(): void {
  nav = "mine";
  appCount = null;
  listeners.clear();
}
