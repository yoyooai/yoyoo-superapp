/**
 * 左边那条"上下切换的地方"。
 *
 * 在 OCTO 里它被挂进宿主的**窄栏**（会话列表那一栏），内容在主区
 * —— 两棵树，靠 navStore 对话（见 navStore.ts 顶部）。
 * 换壳到没有分栏的宿主时，它和内容一起被 SuperAppPage 包成整页，代码不用改。
 *
 * 🔴 不许 import 任何 `@octo/*`（tests/no-host-leak.test.ts 守着）。
 */
import React, { useEffect, useState } from "react";
import { NavIcon, PANE_SIDEBAR, ShellStyles } from "./theme";
import { NAV_ITEMS, getAppCount, getNav, setNav, subscribeNav } from "./navStore";

/** 订阅 navStore，store 一变就重画 */
function useNavStore(): void {
  const [, force] = useState(0);
  useEffect(() => subscribeNav(() => force((n) => n + 1)), []);
}

const SuperAppSidebar: React.FC = () => {
  useNavStore();
  const nav = getNav();
  const count = getAppCount();

  return (
    <aside className="ysa-side" data-yoyoo-pane={PANE_SIDEBAR}>
      <ShellStyles />
      {/* 头部照他们 .wk-mcp-sidebar__brand 的形：一个方形字标 + 两行标题 */}
      <div className="ysa-side-title">
        <span className="ysa-side-glyph" aria-hidden="true">Y</span>
        <span className="ysa-side-titletext">
          <b>应用</b>
          <span>AI 造出来的东西住在这里</span>
        </span>
      </div>
      <nav className="ysa-side-menu" aria-label="应用导航">
        {NAV_ITEMS.map((item) => (
          <React.Fragment key={item.id}>
            {/* 「我的发布」是"我的东西"，和上面两格逛的地方不是一回事 —— 照他们的做法用一条线分开 */}
            {item.id === "published" ? (
              <span className="ysa-side-divider" role="separator" aria-hidden="true" />
            ) : null}
            <button
              className={`ysa-side-item${nav === item.id ? " is-active" : ""}`}
              onClick={() => setNav(item.id)}
            >
              <span className="ysa-side-label">
                <NavIcon name={item.id} />
                {item.label}
              </span>
              {item.id === "mine" && count !== null ? (
                <span className="ysa-side-count">{count}</span>
              ) : null}
            </button>
          </React.Fragment>
        ))}
      </nav>
    </aside>
  );
};

export default SuperAppSidebar;
