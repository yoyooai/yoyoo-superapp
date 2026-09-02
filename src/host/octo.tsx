/**
 * 宿主适配：OCTO。
 *
 * 🔴 这是全包**唯一**允许 import `@octo/*` 的文件（另加同目录 index.ts 的转发）。
 *    见 SPEC.md §B.1，由 tests/no-host-leak.test.ts 机器守护。
 *
 * 对齐样板：octo-web/packages/dmworkappbot/src/module.tsx（全仓最小的完整模块）。
 * 注意：我们**不改 OCTO 一行代码**，全部通过它的公开注册 API 挂载。
 */
import React from "react";
import {
  IModule,
  WKApp,
  Menus,
  ChatPage,
  fetchCurrentImChannelInfo,
} from "@octo/base";
import type { HostAdapter, HostChatMenu, HostEntry, HostIdentity } from "./types";

/**
 * OCTO 的 IModule 实现。ModuleManager.register() 会同步调用 init()，
 * 所以所有注册动作都必须在 init() 里同步完成。
 */
class OctoHostModule implements IModule {
  constructor(private readonly onInit: (host: HostAdapter) => void) {}

  id(): string {
    // 必须全局唯一 —— ModuleManager 以此为 Map key（Service/Module.ts:13）
    return "YoyooSuperAppModule";
  }

  init(): void {
    if (_initialized) return;
    _initialized = true;
    this.onInit(octoHost);
  }
}

/** 防重复 init：dev 下 HMR 会重跑模块顶层代码（对齐 dmworkappbot 的做法） */
let _initialized = false;
/** 已注册过路由的 path（多入口共用一个 path 时只注册一次） */
const _registeredPaths = new Set<string>();
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    _initialized = false;
    _registeredPaths.clear();
  });
}

/**
 * 把一段内容挂进宿主主展示区。
 *
 * `routeRight` 的 setter 是外壳挂载时才注入的（ContextRouteManager），
 * 外壳还没起来就调会抛 —— 抛在这里等于整个侧栏点不动。所以判空后返回 false，
 * 让调用方降级成整页渲染，而不是把宿主拖垮。
 */
function mountStage(node: React.ReactNode, retriesLeft = 3): boolean {
  if (!React.isValidElement(node)) return false;
  const right = WKApp.routeRight;
  if (!right || typeof right.setReplaceToRoot !== "function") {
    // 直接敲 /superapp 进来时，外壳可能比这次调用晚一步挂上（setter 是它注入的）。
    // 一次失败就放弃的话，症状是"窄栏有导航、右边一片空" —— 比报错更难查。
    // 所以再等两帧试一次；仍然不行才如实返回 false，让调用方整页兜底。
    if (retriesLeft > 0 && typeof setTimeout === "function") {
      setTimeout(() => mountStage(node, retriesLeft - 1), 120);
    }
    return false;
  }
  right.replaceToRoot(node);
  return true;
}

const octoHost: HostAdapter = {
  name: "octo",

  registerEntry(entry: HostEntry): void {
    /**
     * 🔴 OCTO 是**分栏**的：`route.register` 挂的是窄的会话列表栏（MainContentLeft），
     *    右边那块大区域是另一条路由（`WKApp.routeRight`）。
     *    2026-09-02 的事故就是把整页塞给了窄栏 —— 应用被挤成一条 300px 的竖条。
     *    对齐宿主自己的市场（dmworkmcp/src/module.tsx）：窄栏放导航，内容推进主区。
     */
    const split = !!(entry.renderSidebar && entry.renderStage);

    // ① 路由。多个入口共用一个 path（6 个钉位都指向 /superapp）时只注册一次 ——
    //    宿主的路由表以 path 为 key，重复注册是覆盖同一项，白做还容易看错。
    if (!_registeredPaths.has(entry.path)) {
      _registeredPaths.add(entry.path);
      if (split) {
        // hostShell：直接敲 /superapp 或刷新时，宿主要先把整个外壳（NavRail + 分栏）
        // 画出来再由 URL 反推激活哪个入口；不给它，刷新会塌成一条光秃秃的窄栏。
        // 这不是我们发明的用法，是宿主 RouteRegisterOptions 明说的逃生口。
        WKApp.route.register(entry.path, () => <>{entry.renderSidebar!()}</>, {
          hostShell: () => <ChatPage />,
        });
      } else {
        WKApp.route.register(entry.path, () => <>{entry.render()}</>);
      }
    }

    // ② 一级入口：NavRail 图标。
    // 🔴 工厂里的东西**每次画侧栏都现取**：返回 undefined 即隐藏（Service/Menus.ts:15-16），
    //    标题也现取 —— 侧栏钉位就是靠这两点做到"钉了才出现、钉的是谁就显示谁"，
    //    宿主源码一行不改。
    WKApp.menus.register(
      entry.id,
      () => {
        if (entry.visible && !entry.visible()) return undefined;
        const title = typeof entry.title === "function" ? entry.title() : entry.title;
        /**
         * 定义了 onPress，宿主就**不再**跑它自己的默认导航
         * （Pages/Main/index.tsx: `if (menus.onPress) … else popToRoot`），
         * 于是左右两栏都归我们管 —— 和宿主市场模块一字不差的分工。
         * 顺序要紧：先让业务发出"打开哪个应用"的请求，再挂主区
         * （主区挂上时才订阅，晚一步就接不到这次请求）。
         */
        const press = split || entry.onPress
          ? () => {
              entry.onPress?.();
              if (split) {
                WKApp.routeLeft?.popToRoot?.();
                mountStage(entry.renderStage!());
              }
            }
          : undefined;
        return new Menus(
          entry.id, entry.path, title, entry.icon(false), entry.icon(true), press
        );
      },
      entry.sort
    );
  },

  showStage(node: React.ReactNode): boolean {
    return mountStage(node);
  },

  refreshEntries(): void {
    // 宿主自己也是这么用的（dmworkbase/src/App.tsx:1618、Pages/Chat/vm.ts:713）
    WKApp.menus.refresh();
  },

  registerChatMenu(menu: HostChatMenu): void {
    // 宿主自带两项：「发起群聊」(dmworkbase/module.tsx:1052) 和「添加好友」
    // (dmworkcontacts/module.tsx:83)。一个主打人机协作的产品，加人的地方却没有"加 AI"
    // —— 这一项就是补这个缺口，而且走的是公开注册 API，宿主源码一行不改。
    WKApp.shared.chatMenusRegister(menu.id, () => ({
      key: menu.id,
      title: menu.title,
      icon: menu.iconUrl,
      sort: menu.sort ?? 0,
      onClick: menu.onClick,
    }));
  },

  navigate(path: string): void {
    WKApp.route.syncPath(path);
  },

  identity(): HostIdentity | null {
    const li = WKApp.loginInfo;
    if (!li?.uid) return null;
    // spaceId 取宿主自己那个真源：它的 APIClient 拦截器注入 X-Space-Id 用的就是
    // `WKApp.shared.currentSpaceId`（octo-web `apps/web/src/index.tsx`
    // spaceIdCallback）。别改成自己缓存一份 —— 换空间时会拿到旧的。
    const spaceId = (WKApp.shared as { currentSpaceId?: string } | undefined)?.currentSpaceId;
    return { uid: li.uid, name: li.name, token: li.token, spaceId };
  },

  async removeAiFromContacts(uid: string): Promise<void> {
    // 宿主自己的「解除好友关系」走的就是这个（dmworkbase/module.tsx:1726）。
    await WKApp.dataSource.commonDataSource.deleteFriend(uid);
    // 刷一下这个号的 channelInfo —— 不刷的话通讯录和名片上的"已添加"标记要等下次
    // 拉取才变，看起来像"点了没反应"。
    // 传普通对象即可：这一族函数的入参类型是 `ImChannelLike`（只要 channelID +
    // channelType），所以我们不用把 wukongimjssdk 拉成依赖。1 ＝ ChannelTypePerson。
    void fetchCurrentImChannelInfo({ channelID: uid, channelType: 1 });
  },

  // 🔴 **刻意不实现 `deleteAiAccount`** —— 2026-09-02 实测，别删这段：
  //
  // 后端确实写好了 `DELETE /v1/manager/robots/:robot_id`
  // （octo-server `modules/robot/api_manager.go:47`，handler `robotDelete` 会先断 IM
  // 连接、清心跳与事件队列，再做软删除），**但 `modules/robot/1module.go` 从来没有
  // 注册这个 Manager 路由** —— 它只 `SetupAPI: New(ctx)`（业务路由）。group / message /
  // backup / common 那几个模块都注册了自己的 Manager，robot 漏了。
  //
  // 线上实测（https://yoyoo.cosark.com.cn）：
  //   DELETE /v1/friends/xxx          → 401（路由在，鉴权挡住）
  //   DELETE /v1/manager/robots/xxx   → 404（**路由根本不在**）
  //
  // 所以这一档在这个宿主上**做不到**。按 removeAiPolicy 的规则，宿主没实现 ⇒
  // 那一档在弹层里不出现，而不是画一个点下去必然 404 的按钮。
  // 想真做，得改 octo-server 注册那个路由 + 重新部署后端（而且它还要求超级管理员），
  // 那是另一件事，等苏白拍板。现在唯一能删号的路是 BotFather 的 `/deletebot`。
};

/** 造一个能交给 OCTO 注册的模块对象 */
export function createOctoModule(onInit: (host: HostAdapter) => void): IModule {
  return new OctoHostModule(onInit);
}
