/**
 * `@octo/base` 的最小类型声明 —— 只声明我们真正用到的那几个符号。
 *
 * 为什么不直接用宿主的真实类型：
 *   `@octo/base` 是 link 到宿主源码目录的（不是编译好的 .d.ts），tsc 会一路钻进
 *   它 20 万行源码里做全量检查。而宿主自己有一处历史债 —— `dmworkbase` 的
 *   package.json 声明 react@17，代码却按 18 写，靠 Vite 的 dedupe 在运行时收敛。
 *   结果就是：**它自己的类型错误会淹掉我们自己的**，我们的 typecheck 永远绿不了，
 *   也就永远失去了报警能力。
 *
 * 取舍与兜底：
 *   这样做会失去"宿主改了 API 签名，tsc 立刻告诉我们"的能力。
 *   兜底是构建 —— Vite 编译时解析的是**真实**的 `@octo/base`，签名对不上会当场失败。
 *   也就是说这层风险由构建挡着，不是没人管。
 *
 * 🔴 只有 src/host/ 允许 import 这个模块（见 tests/no-host-leak.test.ts）。
 */
declare module "@octo/base" {
  import type { ReactElement, ReactNode } from "react";

  /** 模块契约（宿主 Service/Module.ts:2-5，就这两个方法） */
  export interface IModule {
    id(): string;
    init(): void;
  }

  /** 一级入口菜单项（宿主 Service/Menus.ts:57-78） */
  export class Menus {
    constructor(
      id: string,
      routePath: string,
      title: string,
      icon: ReactElement,
      selectedIcon: ReactElement,
      onPress?: (reentry?: boolean) => void
    );
    badge?: number;
    onPress?: (reentry?: boolean) => void;
  }

  /** 「+」气泡里的一项（宿主 App.tsx:1753-1759） */
  export interface ChatMenus {
    key?: string;
    icon: string;
    title: string;
    sort?: number;
    onClick?: () => void;
  }

  export interface OctoLoginInfo {
    uid?: string;
    name?: string;
    token?: string;
  }

  /**
   * 左右两栏各自的路由（宿主 Service/Route.tsx: ContextRouteManager）。
   * `setReplaceToRoot` 等 setter 由外壳挂载时注入 —— 外壳没起来时它们是 undefined，
   * 所以调用前必须判空（见 host/octo.tsx 的 mountStage）。这里如实声明成可选。
   */
  export interface ContextRoute {
    setReplaceToRoot?: (view: ReactElement) => void;
    replaceToRoot(view: ReactElement): void;
    push(view: ReactElement): void;
    popToRoot?(): void;
  }

  /**
   * 宿主主外壳（NavRail + 左右分栏）。
   * 只用在 `route.register(..., { hostShell })` 里：直接敲我们的 URL 或刷新时，
   * 先把整个外壳画出来，再由 URL 反推激活哪个入口。
   * 用法与宿主自己的市场模块一致（dmworkmcp/src/module.tsx）。
   */
  export const ChatPage: (props?: Record<string, unknown>) => ReactElement;

  /**
   * 宿主的全局单例。这里只列出我们用到的成员 —— 它实际有 150+ 个导出，
   * 全列出来既没必要，也会诱使我们去用不该用的东西。
   */
  export const WKApp: {
    route: {
      register(
        path: string,
        handler: () => ReactNode,
        opts?: { hostShell?: () => ReactNode }
      ): void;
      syncPath(path: string): void;
    };
    menus: {
      register(sid: string, factory: () => Menus | undefined, sort?: number): void;
      /**
       * 让 NavRail 重画一次。宿主自己也这么用
       * （dmworkbase/src/App.tsx:1618、Pages/Chat/vm.ts:713）；
       * 配合"工厂返回 undefined 即隐藏"就能做运行时显隐 —— 侧栏钉位靠这一对。
       */
      refresh(): void;
    };
    shared: {
      chatMenusRegister(sid: string, f: (param: unknown) => ChatMenus, sort?: number): void;
    };
    /** 窄栏（会话列表那一栏）的路由栈 */
    routeLeft?: ContextRoute;
    /** 主展示区的路由栈 —— 我们的内容推这里，不是推窄栏 */
    routeRight?: ContextRoute;
    loginInfo: OctoLoginInfo;
    /**
     * 宿主的数据层。只声明我们真正调的那一个方法 ——
     * `deleteFriend` 走 `DELETE /v1/friends/:uid`
     * （dmworkdatasource/src/datasource.ts:544），宿主自己的「解除好友关系」
     * 用的也是它（dmworkbase/src/module.tsx:1726）。
     */
    dataSource: {
      commonDataSource: {
        deleteFriend(uid: string): Promise<void>;
      };
    };
    /**
     * 宿主的 HTTP 客户端（baseURL 已指到 `/v1/`）。
     * 我们只用 delete：删 AI 的号走 `DELETE /v1/manager/robots/:robot_id`
     * （octo-server modules/robot/api_manager.go:47）。
     */
    apiClient: {
      delete(path: string, config?: unknown): Promise<unknown>;
    };
  };

  /**
   * 拉一次某个频道的最新信息（含好友标记/在线态），并通知宿主的监听者。
   * 入参类型是宿主的 `ImChannelLike`：**只要 channelID + channelType**，
   * 所以我们不用把 wukongimjssdk 拉成依赖（channelType 1 ＝ 单聊/个人）。
   * 出处：dmworkbase/src/im-runtime/currentChannelRuntime.ts:78。
   */
  export function fetchCurrentImChannelInfo(channel: {
    channelID: string;
    channelType: number;
  }): Promise<unknown>;
}
