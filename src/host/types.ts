/**
 * 宿主适配层的契约 —— 这是整个包唯一知道"我被挂在别人身上"的地方。
 *
 * 🔴 铁线（SPEC.md §B.1，由 tests/no-host-leak.test.ts 机器守护）：
 *    只有 src/host/ 下的文件可以 import 宿主的东西（@octo/*）。
 *    shell/ runtime/ api/ 一律只依赖本文件的接口。
 *
 * 这样换宿主时只需新写一个 host/<name>.tsx，业务代码零改动。
 */
import type { ReactElement, ReactNode } from "react";

/** 一级入口（宿主侧边栏里的那个图标） */
export interface HostEntry {
  /** 全局唯一 id，宿主拿它当注册表的 key */
  id: string;
  /** 路由路径，如 "/superapp" */
  path: string;
  /**
   * 入口标题（已翻译好的文本，宿主不负责翻译）。
   * 传函数表示"每次画侧栏时现取" —— 钉位的标题会随用户钉的应用变。
   */
  title: string | (() => string);
  /** 排序权重，越大越靠下；OCTO 现有 6 个入口用的是 1000~5000 段 */
  sort: number;
  /** 图标；active 表示选中态 */
  icon: (active: boolean) => ReactElement;
  /**
   * 点开后渲染什么（**整页**：自带导航 + 内容）。
   * 宿主不分栏、或分栏能力不可用时走这条 —— 永远要能单独成立。
   */
  render: () => ReactNode;
  /**
   * 分栏宿主专用：窄栏（导航）里画什么。
   *
   * 🔴 为什么需要这一对（2026-09-02 的教训，别删这段）：
   *    OCTO 的 `route.register(path, handler)` 把 handler 挂在**窄的会话列表栏**里，
   *    右边那块大区域是另一条路由（routeRight）。我们一开始把整页塞给它，
   *    结果整个应用被挤在一条 ~300px 的窄栏里 —— 苏白的原话是"那个位置太小了"。
   *    宿主自己的市场就是分开挂的：窄栏放导航，内容推进主区。
   *    所以这是**宿主能力**，必须走适配层，不能让业务代码去够 WKApp。
   */
  renderSidebar?: () => ReactNode;
  /** 分栏宿主专用：主展示区里画什么。与 renderSidebar 成对出现才生效 */
  renderStage?: () => ReactNode;
  /**
   * 当前要不要显示这个入口。省略 = 一直显示。
   *
   * 🔴 侧栏钉位靠它：注册 6 个槽位，没钉满时多出来的槽位返回 false。
   *    宿主自己就是这么按 remoteConfig 做运行时显隐的
   *    （dmworkbase/src/Service/Menus.ts:15-16 注释原文：
   *     "工厂可返回 undefined 表示「当前不展示该菜单」…配合 refresh() 可实现运行时显隐"），
   *    所以不用改宿主一行代码。
   *    换壳后新宿主若不支持动态入口，钉功能降级为"我的应用里的置顶区"，其它照跑。
   */
  visible?: () => boolean;
  /**
   * 点这个入口时额外要做的事（宿主自己的跳转照常发生）。
   *
   * 🔴 钉位靠它把"要打开哪个应用"传出去，而**不是**把 app id 塞进 path。
   *    宿主的路由表以 path 为 key（Service/Route.tsx: `normalizeRoutePath` 后
   *    直接当 endpoint 名），`/superapp?app=xxx` 会被当成一个**不存在的新路由**，
   *    点下去是空白页。这条注释留着，防止以后又有人想走 query 那条捷径。
   */
  onPress?: () => void;
}

/** 当前登录者 —— 我们自己的后端要靠它认人 */
export interface HostIdentity {
  uid: string;
  name?: string;
  token?: string;
  /**
   * 当前所在空间的 id。
   * 🔴 建号（邀请 AI）必须带它 —— 宿主的 `runtime-onboarding` 没有空间就 400，
   *    且故意不做"取第一个空间"的兜底。换壳时如果新宿主没有空间概念，这里给
   *    空字符串，建号那条路会明确报"拿不到当前空间 id"而不是静默串到别的空间。
   */
  spaceId?: string;
}

/** 聊天页「+」气泡里的一项 */
export interface HostChatMenu {
  id: string;
  title: string;
  /** 图标 URL；用 data URI 可以避免依赖宿主的静态资源 */
  iconUrl: string;
  sort?: number;
  onClick: () => void;
}

/**
 * 宿主能力集。新增一个宿主 = 实现这个接口。
 * 故意做得很窄：能力越少，越容易换壳。
 */
export interface HostAdapter {
  /** 宿主名，日志和排错用 */
  readonly name: string;
  /** 注册一个一级入口 + 它的路由 */
  registerEntry(entry: HostEntry): void;
  /**
   * 往「+」气泡里加一项。
   * 可选 —— 不是每个宿主都有这个位置；没有就不实现，调用方需判空。
   */
  registerChatMenu?(menu: HostChatMenu): void;
  /**
   * 让宿主重画一次侧栏（钉位变了要用）。
   * 可选 —— 宿主不支持就不实现，调用方判空；钉功能随之降级，别的功能不受影响。
   */
  refreshEntries?(): void;
  /**
   * 把内容送进宿主的**主展示区**（窄栏之外那块大的）。
   * 返回 false ＝ 这个宿主没有分栏、或此刻还没准备好；调用方应当自己整页渲染。
   * 可选 —— 不是每个宿主都有主区；没有就不实现，调用方判空。
   */
  showStage?(node: ReactNode): boolean;
  /** 主动跳转 */
  navigate(path: string): void;
  /** 当前登录者；拿不到返回 null（未登录 / 宿主没实现） */
  identity(): HostIdentity | null;
  /**
   * 把一个 AI 从**我的通讯录**里移除（只解除好友关系，号还在，可以再加回来）。
   *
   * 🔴 为什么这也算"宿主能力"而不是我们的业务：解除关系之后要不要清会话、
   *    清哪些缓存，是宿主自己那套 IM 运行时的事（它自己的 removeFriend 就带这些收尾）。
   *    我们只决定"要不要移除、怎么问用户"。
   * 可选 —— 宿主没有好友概念就不实现，调用方判空后把这一档藏掉。
   */
  removeAiFromContacts?(uid: string): Promise<void>;
  /**
   * **彻底删除**一个 AI 的账号（号没了，凭据一并失效，不可恢复）。
   *
   * 可选 —— 宿主没有这个能力就不实现，调用方判空后把这一档藏掉。
   * 🔴 OCTO 现在**没有**这个能力：后端 `DELETE /v1/manager/robots/:id` 写好了但
   *    路由没注册，线上实测 404（详见 host/octo.tsx 里那段）。所以 host/octo.tsx
   *    刻意不实现它 —— 契约留在这里，是为了换壳到有这条路由的宿主时能直接接上。
   */
  deleteAiAccount?(uid: string): Promise<void>;
}
