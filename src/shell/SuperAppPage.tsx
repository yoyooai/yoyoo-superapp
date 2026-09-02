/**
 * 整页外壳 —— **给不分栏的宿主用的兜底**，也是本地预览和测试的入口。
 *
 * OCTO 是分栏的：导航挂在窄栏、内容推进主区（见 host/types.ts 里 renderSidebar
 * 那段注释）。所以在 OCTO 上跑的是 SuperAppSidebar + SuperAppStage 两棵树，
 * 不是这个文件。但这个文件必须永远能单独成立 ——
 * 换壳到一个没有分栏概念的宿主时，它就是全部界面。
 *
 * 两种模式共用同一套组件和同一个 navStore，所以不会出现"分栏那边好了、
 * 整页这边悄悄坏了"的情况。
 *
 * 🔴 不许 import 任何 `@octo/*`（tests/no-host-leak.test.ts 守着）。
 */
import React from "react";
import type { HostAdapter } from "../host/types";
import { ShellStyles } from "./theme";
import SuperAppSidebar from "./SuperAppSidebar";
import SuperAppStage from "./SuperAppStage";

export interface SuperAppPageProps {
  host: HostAdapter;
}

const SuperAppPage: React.FC<SuperAppPageProps> = ({ host }) => (
  <div className="ysa-app">
    <ShellStyles />
    <SuperAppSidebar />
    <SuperAppStage host={host} />
  </div>
);

export default SuperAppPage;
