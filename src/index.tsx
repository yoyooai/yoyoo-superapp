/**
 * Enterprise slot 入口 —— OCTO 的 `virtual:octo-enterprise-modules` 契约。
 *
 * 契约来源：octo-web/apps/web/src/enterprise-modules.d.ts
 *           octo-web/apps/web/vite.enterpriseHtml.ts:62-92（代码生成器逐个 named import）
 *
 * 三个导出：
 *   - registerEnterpriseModules(ctx)      必需，缺了直接构建/运行报错
 *   - getEnterpriseStandaloneHandlers()   必需，且必须返回数组
 *   - getEnterpriseMockHandlers()         可选，存在就必须是函数且返回数组
 *
 * 我们不改 OCTO 一行代码；本文件是两边唯一的接触面。
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { createOctoModule } from "./host/octo";
import InviteAIDialog from "./shell/InviteAIDialog";
import RemoveAIDialog, { type RemoveAITarget } from "./shell/RemoveAIDialog";
import { InviteApi } from "./api/invite";
import type { HostAdapter } from "./host/types";
import SuperAppPage from "./shell/SuperAppPage";
import SuperAppSidebar from "./shell/SuperAppSidebar";
import SuperAppStage from "./shell/SuperAppStage";
import { SuperAppApi } from "./api/client";
import { loadPinned, subscribePinned } from "./shell/pinStore";
import { buildPinEntries } from "./shell/pinEntries";

/** 一级入口的位置：OCTO 自带入口用到 6000（appbot），我们排在它后面 */
const ENTRY_SORT = 6100;
const ENTRY_ID = "yoyoo-superapp";
const ENTRY_PATH = "/superapp";
/** 与 yoyoo-octo/ux-patch 里插入宿主的钩子名保持一致 —— 改名要两边一起改 */
const ONBOARDING_FINISHED_HOOK = "__yoyooOnboardingFinished";
/** 与 yoyoo-octo/invite-patch 里插入宿主的钩子名保持一致 —— 改名要两边一起改 */
const INVITE_AI_HOOK = "__yoyooInviteAI";
/** 与 yoyoo-octo/delete-patch 里插入宿主的钩子名保持一致 —— 改名要两边一起改 */
const REMOVE_AI_HOOK = "__yoyooRemoveAI";

/**
 * 把「邀请 AI」弹层挂到 body 上。
 *
 * 为什么自己挂一个 root 而不是塞进壳内某个页面：这个入口在**通讯录**里，
 * 那是宿主的页面，我们没有它的渲染树。开一个一次性 portal 是唯一不碰它的做法，
 * 关掉就整个卸掉，不在宿主页面里留残骸。
 */
function openInviteDialog(api: InviteApi, inviterName?: string): void {
  const holder = document.createElement("div");
  holder.setAttribute("data-yoyoo", "invite-ai");
  document.body.appendChild(holder);
  const root = createRoot(holder);
  const close = () => {
    // 先卸载再摘 DOM；反了会在 React 18 下留一条 unmount 警告。
    setTimeout(() => {
      root.unmount();
      holder.remove();
    }, 0);
  };
  root.render(<InviteAIDialog api={api} inviterName={inviterName} onClose={close} />);
}

/**
 * 把「移除这个 AI」弹层挂到 body 上。理由同 openInviteDialog：
 * 入口在**宿主的 AI 名片**里，我们没有它的渲染树，开一次性 portal 是唯一不碰它的做法。
 */
function openRemoveDialog(host: HostAdapter, payload: unknown): void {
  const p = payload as Partial<RemoveAITarget> & { onDone?: () => void };
  // 宿主传来的东西一律当外部输入校验：uid 缺了就什么都不做（静默，别弹一个空壳）。
  if (!p || typeof p.uid !== "string" || !p.uid) return;
  const target: RemoveAITarget = {
    uid: p.uid,
    name: typeof p.name === "string" && p.name ? p.name : p.uid,
    isFriend: p.isFriend === true,
    isOwner: p.isOwner === true,
  };

  const holder = document.createElement("div");
  holder.setAttribute("data-yoyoo", "remove-ai");
  document.body.appendChild(holder);
  const root = createRoot(holder);
  const close = () => {
    setTimeout(() => {
      root.unmount();
      holder.remove();
    }, 0);
  };
  root.render(
    <RemoveAIDialog
      target={target}
      // 判空转发：宿主没实现某一档 ⇒ 那一档在弹层里不出现（而不是点了报错）。
      onRemoveFromContacts={
        host.removeAiFromContacts
          ? () => host.removeAiFromContacts!(target.uid)
          : undefined
      }
      onDeleteAccount={
        host.deleteAiAccount ? () => host.deleteAiAccount!(target.uid) : undefined
      }
      onClose={close}
      onDone={p.onDone}
    />
  );
}

/** 入口图标：四个方块里长出一个 —— "应用"的意思 */
const SuperAppIcon: React.FC<{ active?: boolean }> = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
    <g fill="currentColor">
      <rect x="2" y="2" width="7" height="7" rx="2" />
      <rect x="2" y="11" width="7" height="7" rx="2" />
      <rect x="11" y="11" width="7" height="7" rx="2" />
      <path d="M14.5 2a1 1 0 0 1 1 1v1.5H17a1 1 0 1 1 0 2h-1.5V8a1 1 0 1 1-2 0V6.5H12a1 1 0 1 1 0-2h1.5V3a1 1 0 0 1 1-1Z" />
    </g>
  </svg>
);

/**
 * 「添加 AI」的图标 —— 用 data URI 内联，不依赖宿主静态资源，换壳时一起走。
 * （宿主自带的两项用的是 import 进来的 png，那种做法搬不动。）
 */
const ADD_AI_ICON =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">` +
      `<rect x="5" y="9" width="18" height="14" rx="4" fill="none" stroke="#5d67aa" stroke-width="2"/>` +
      `<circle cx="11" cy="16" r="1.6" fill="#5d67aa"/><circle cx="17" cy="16" r="1.6" fill="#5d67aa"/>` +
      `<path d="M14 9V5" stroke="#5d67aa" stroke-width="2" stroke-linecap="round"/>` +
      `<circle cx="14" cy="4" r="1.8" fill="#5d67aa"/>` +
      `</svg>`
  );

/** 装配：把宿主能力接到我们的界面上。换宿主时只有 host 参数会变。 */
function mount(host: HostAdapter): void {
  /**
   * 🔴 三个 render 一起给，不是重复：
   *    · 分栏宿主（OCTO）→ 导航挂窄栏（renderSidebar）、内容推主区（renderStage）
   *    · 不分栏的宿主   → 整页（render），自带导航
   *    2026-09-02 的事故就是只给了整页，被宿主塞进一条 ~300px 的窄栏里。
   *    详见 host/types.ts 里 renderSidebar 那段。
   */
  const entryRenders = {
    render: () => <SuperAppPage host={host} />,
    renderSidebar: () => <SuperAppSidebar />,
    renderStage: () => <SuperAppStage host={host} />,
  };

  host.registerEntry({
    id: ENTRY_ID,
    path: ENTRY_PATH,
    title: "应用",
    sort: ENTRY_SORT,
    icon: (active) => <SuperAppIcon active={active} />,
    ...entryRenders,
  });

  // 「第一分钟」修复之一：一个主打人机协作的产品，"+"里只有"发起群聊/添加好友"，
  // 没有"添加 AI"。补上，并且不改宿主一行代码。
  // 宿主没有这个位置时（换壳后）方法不存在，判空跳过即可。
  host.registerChatMenu?.({
    id: "yoyoo.chatmenus.addai",
    title: "添加 AI",
    iconUrl: ADD_AI_ICON,
    onClick: () => host.navigate(ENTRY_PATH),
  });

  // ── 侧栏钉位（SPEC-market §4.2）────────────────────────────────
  // 注册 6 个槽位，工厂读内存里的钉位快照：钉了就画一个图标，没钉就返回 undefined。
  // 🔴 默认侧栏仍然只有一个「应用」入口 —— 钉出来的是用户自己选的。
  for (const entry of buildPinEntries(ENTRY_PATH, ENTRY_SORT + 10, entryRenders)) {
    host.registerEntry(entry);
  }

  // 钉位变了就让宿主重画侧栏。宿主不支持 refresh 就静静降级（判空）。
  subscribePinned(() => host.refreshEntries?.());

  // 冷启动时把钉位捞进内存。身份可能还没就绪（init 跑得比登录早），
  // 所以等到拿得到 token 再拉；等不到就算了 —— 用户进一次「应用」页也会刷新它。
  void (async () => {
    const api = new SuperAppApi(() => host.identity()?.token);
    for (let i = 0; i < 20; i++) {
      if (host.identity()?.token) {
        await loadPinned(api);
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  })();

  // 「邀请 AI」：通讯录顶上那个入口被点时，宿主只"喊一声"，弹层在我们这边。
  // 与 ONBOARDING_FINISHED_HOOK 同一套做法（宿主开一个洞，去哪/长什么样归我们），
  // 所以 invite-patch 那个补丁只有几行、且换壳时自然失效不留残骸。
  (window as unknown as Record<string, undefined | (() => void)>)[INVITE_AI_HOOK] = () => {
    const identity = host.identity();
    if (!identity?.token) return; // 没登录态就没法建号，静默不弹（宿主那条入口本来也在登录后才可见）
    openInviteDialog(
      new InviteApi(
        () => host.identity()?.token,
        () => host.identity()?.spaceId
      ),
      identity.name
    );
  };

  // 「移除这个 AI」：AI 名片底部那一行被点时，宿主只"喊一声"，两档选择在我们这边。
  // 🔴 与「邀请 AI」成对：邀请函管"外面没号的 AI 进来"，这里管"已经进来的出去"。
  //    宿主原来只有进没有出（人的名片对同空间隐藏了解除好友，AI 名片压根没做）。
  (
    window as unknown as Record<string, undefined | ((p: unknown) => void)>
  )[REMOVE_AI_HOOK] = (payload: unknown) => openRemoveDialog(host, payload);

  // 「第一分钟」修复之二：接住引导结束的那一刻，别把人扔在空页面上。
  // 宿主侧只被加了一行"喊一声"（ux-patch），去哪是我们这边决定的。
  // 用可选钩子而不是改宿主跳转逻辑，换壳时这段自然失效，不留残骸。
  (window as unknown as Record<string, undefined | (() => void)>)[
    ONBOARDING_FINISHED_HOOK
  ] = () => host.navigate(ENTRY_PATH);
}

export interface EnterpriseModulesContext {
  registerModule(module: unknown): void;
}

export function registerEnterpriseModules(context: EnterpriseModulesContext): void {
  context.registerModule(createOctoModule(mount));
}

export function getEnterpriseStandaloneHandlers(): unknown[] {
  // P0 走壳内路由即可；脱壳整页（绕过 NavRail）留给后续需要时再加。
  return [];
}

export function getEnterpriseMockHandlers(): unknown[] {
  return [];
}
