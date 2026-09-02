/**
 * 侧栏钉位的内存快照。
 *
 * 🔴 不许 import 任何 `@octo/*`（tests/no-host-leak.test.ts 守着）。
 *
 * 为什么需要一个 store：宿主的菜单工厂是**同步**的（`() => Menus | undefined`），
 * 它不可能等一个网络请求。所以钉位必须先落到内存里，工厂只读内存；
 * 数据变了再调宿主的 refresh() 让它重画一次。
 * 这正是宿主自己按 remoteConfig 做运行时显隐的用法，不用改它一行代码。
 */
import type { AppSummary, SuperAppApi } from "../api/client";

export interface PinnedApp {
  appId: string;
  name: string;
  icon?: string;
}

let pinned: PinnedApp[] = [];
const listeners = new Set<() => void>();

/** 当前钉位（工厂同步读这个） */
export const getPinned = (): PinnedApp[] => pinned;

/** 第 i 个钉位；没有就返回 undefined —— 工厂据此返回 undefined 表示不展示 */
export const getPinnedAt = (i: number): PinnedApp | undefined => pinned[i];

export function setPinned(next: PinnedApp[]): void {
  pinned = next;
  listeners.forEach((l) => l());
}

export function subscribePinned(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

// ── "打开某个应用"的请求通道 ──────────────────────────────────────
// 点侧栏钉位时，宿主自己会跳到 /superapp（那是它的路由），但"要打开哪个应用"
// 只能由我们这边传 —— 不能塞进 path（宿主路由表以 path 为 key，见 host/types.ts 注释）。
// 所以走这条通道：钉位 onPress 发一个请求，页面收到就打开它。

let openRequest: { appId: string; at: number } | null = null;
const openListeners = new Set<(appId: string) => void>();

/**
 * 发一个"打开这个应用"的请求。
 *
 * 🔴 有人在听就当场送达并**清掉**，只有没人听时才挂起。
 *    早先的写法是"既送达又挂起"，结果是：点钉位打开一次之后，
 *    这条请求还留在待办里，5 秒内再进这个页面会**莫名其妙又跳进那个应用**
 *    （用户视角：我明明点了返回，它自己又打开了）。挂起只该是"页面还没挂载"的桥。
 */
export function requestOpenApp(appId: string): void {
  if (openListeners.size > 0) {
    openRequest = null;
    openListeners.forEach((l) => l(appId));
    return;
  }
  openRequest = { appId, at: Date.now() };
}

/**
 * 订阅打开请求。返回退订函数。
 * 页面挂载时若已有**刚刚**发出的请求（点钉位 → 宿主换路由 → 页面才挂载，
 * 这个顺序下监听会晚于请求），也要立刻消费一次 —— 否则第一次点钉位没反应。
 * 5 秒是"刚刚"的界限：超时的请求属于上一次会话，不该在这次挂载时突然弹出来。
 */
export function subscribeOpenApp(l: (appId: string) => void): () => void {
  openListeners.add(l);
  if (openRequest && Date.now() - openRequest.at < 5000) {
    const { appId } = openRequest;
    openRequest = null;
    l(appId);
  }
  return () => openListeners.delete(l);
}

/**
 * 从后端拉一次钉位并填进 store。
 * `/pins` 只给 app_id 和顺序，名字/图标在 `/apps` 里 —— 合起来才够画一个侧栏图标。
 * 拉不到（未登录、后端没起）就清空：**宁可侧栏少几个图标，也不画出打不开的图标。**
 */
export async function loadPinned(api: SuperAppApi): Promise<PinnedApp[]> {
  try {
    const [{ pins }, { apps }] = await Promise.all([api.pins(), api.list()]);
    const byId = new Map<string, AppSummary>(apps.map((a) => [a.id, a]));
    const next = pins
      .slice()
      .sort((a, b) => a.sort - b.sort)
      .map((p) => byId.get(p.app_id))
      .filter((a): a is AppSummary => !!a)
      .map((a) => ({ appId: a.id, name: a.name, icon: a.icon }));
    setPinned(next);
    return next;
  } catch {
    setPinned([]);
    return [];
  }
}
