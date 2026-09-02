/** 只用来截图看界面：真组件 + 真样式，数据用假的 fetch 喂。发布前眼睛过一遍。 */
import React from "react";
import { createRoot } from "react-dom/client";
import SuperAppSidebar from "../src/shell/SuperAppSidebar";
import SuperAppStage from "../src/shell/SuperAppStage";
import type { HostAdapter } from "../src/host/types";

const now = 1756800000000;
const apps = [
  { id: "a1", name: "本周订单统计表", icon: "📊", created_by: "ai", created_at: now, updated_at: now, pinned: true },
  { id: "a2", name: "客户跟进看板", icon: "🗂️", created_by: "human", created_at: now, updated_at: now - 86400000 },
  { id: "a3", name: "会议纪要模板", icon: "📝", created_by: "ai", created_at: now, updated_at: now - 172800000, source_listing_id: "l1", update_available: true },
];
const listings = [
  { id: "l1", name: "会议纪要模板", icon: "📝", summary: "开完会填三栏：结论、待办、谁来做。装走之后随便改成你们组的样子。", created_by: "ai", author_uid: "u_other", version: 3, installs: 12, created_at: now, updated_at: now, installed: true, my_app_id: "a3", my_version: 2, update_available: true, is_author: false },
  { id: "l2", name: "报销单", icon: "🧾", summary: "填一张就能交的报销单，带金额合计。", created_by: "human", author_uid: "u_other", version: 1, installs: 5, created_at: now, updated_at: now, installed: false, my_app_id: null, my_version: null, update_available: false, is_author: false },
  { id: "l3", name: "本周订单统计表", icon: "📊", summary: "按天汇总订单量和金额，空表也能看清结构。", created_by: "ai", author_uid: "u_test", version: 2, installs: 3, created_at: now, updated_at: now, installed: false, my_app_id: null, my_version: null, update_available: false, is_author: true },
];

const orig = window.fetch;
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(typeof input === "string" ? input : (input as Request).url ?? input);
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
  if (url.includes("/apps") && !url.includes("/market")) return json({ apps });
  if (url.includes("/market/listings")) {
    const mine = url.includes("mine=1");
    return json({ listings: mine ? listings.filter((l) => l.is_author) : listings, page: 0, page_size: 30, sort: "new", mine });
  }
  if (url.includes("/pins")) return json({ pins: [{ app_id: "a1", sort: 0 }], limit: 6 });
  return orig(input as never, init);
};

const host: HostAdapter = {
  name: "preview",
  registerEntry: () => undefined,
  navigate: () => undefined,
  identity: () => ({ uid: "u_test", token: "t" }),
};

/**
 * 模拟宿主的分栏：左边是宿主给的窄栏（照它实际宽度 ~300px），右边是主展示区。
 * 两棵**互不相干**的树 —— 和线上一模一样，这样预览才有意义。
 */
function HostMock() {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "300px minmax(0,1fr)", height: "100%" }}>
      <div style={{ height: "100%", overflow: "hidden", borderRight: "1px solid #e7e8ed" }}>
        <SuperAppSidebar />
      </div>
      <div style={{ height: "100%", overflow: "hidden" }}>
        <SuperAppStage host={host} />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<HostMock />);
