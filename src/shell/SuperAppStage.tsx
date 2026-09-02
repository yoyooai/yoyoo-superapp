/**
 * 右边那块"真实展示的地方"。
 *
 * 在 OCTO 里它被推进宿主的**主展示区**（`host.showStage`），左边那条导航是另一棵树，
 * 靠 navStore 对话（见 navStore.ts 顶部）。换壳到没有分栏的宿主时，
 * SuperAppPage 把它和导航包成整页 —— 同一份代码，两种壳。
 *
 * 🔴 本文件（以及 shell/ runtime/ api/ 下的一切）不许 import 任何 `@octo/*`。
 *    需要宿主能力时只能通过传进来的 HostAdapter。由 tests/no-host-leak.test.ts 守。
 *
 * 关于空态 —— 这里是整个产品最要紧的一屏：
 *   我们批评 OCTO"第一分钟是空的"，那自己这一屏就不能是一句"暂无数据"。
 *   所以空态必须做到三件事：说清这是什么、给一个立刻能按的动作、按完真的有东西。
 *
 * 关于市场（SPEC-market）：市场是**我们自己的货架**，不寄生宿主那个。
 *   界面上三处措辞是刻意的，别改软：
 *     · 「装到我这儿」而不是「安装」—— 装完那份就是你的，能改。
 *     · 「有新版，更新」而不是自动变新 —— 作者无权改你的东西。
 *     · 「钉到侧栏」有上限 6 —— 那是别人家的侧栏，借一格算客气。
 */
import React, { useCallback, useEffect, useState } from "react";
import type { HostAdapter } from "../host/types";
import { SuperAppApi, type AppDetail, type AppSummary } from "../api/client";
import BlueprintRenderer from "../runtime/BlueprintRenderer";
import { DEEPLINK_BUILD_MARK, PIN_SLOTS, parseDeepLinkAppId } from "./deeplink";
import { PANE_STAGE, SearchIcon, ShellStyles } from "./theme";
import { fmtTime } from "./styles";
import { getNav, setAppCount, setNav, subscribeNav } from "./navStore";
import MarketTab from "./MarketTab";
import PublishDialog from "./PublishDialog";
import { getPinned, loadPinned, subscribeOpenApp } from "./pinStore";

export interface SuperAppStageProps {
  host: HostAdapter;
}

/** 空态里那个按钮造出来的东西 —— 一个真能看的样例，不是 "Hello World" */
function sampleBlueprint() {
  return {
    type: "page",
    children: [
      { type: "heading", value: "本周待办", level: 2 },
      { type: "text", value: "这一页是由蓝图（一段 JSON）渲染出来的，不是写死的页面。" },
      {
        type: "table",
        columns: ["事项", "状态"],
        rows: [
          ["把正式服务器定下来", "进行中"],
          ["接上 AI 生成", "待开始"],
        ],
      },
      { type: "divider" },
      { type: "badge", value: "示例应用" },
    ],
  };
}

const SuperAppStage: React.FC<SuperAppStageProps> = ({ host }) => {
  const [api] = useState(() => new SuperAppApi(() => host.identity()?.token));
  const [, forceNav] = useState(0);
  const [apps, setApps] = useState<AppSummary[] | null>(null);
  const [open, setOpen] = useState<AppDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [q, setQ] = useState("");
  const [publishing, setPublishing] = useState<AppSummary | AppDetail | null>(null);
  /** 上一次生成走的是真模型还是本地兜底 —— 要如实告诉用户，不能含糊 */
  const [lastMode, setLastMode] = useState<"llm" | "local" | null>(null);

  const nav = getNav();

  // 左栏换了一格就重画（左栏在另一棵树里，只能靠 store 通知）。
  // 顺带把详情关掉：切到「市场」却还停在某个应用的详情上，是说不通的。
  useEffect(() => subscribeNav(() => {
    setOpen(null);
    setNotice(null);
    setError(null);
    forceNav((n) => n + 1);
  }), []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const { apps } = await api.list();
      setApps(apps);
      setAppCount(apps.length); // 左栏那个角标
      // 顺手把侧栏钉位刷成最新（改了名字、删了应用都要反映到侧栏上）
      void loadPinned(api);
    } catch (e) {
      setApps([]);
      setAppCount(null);
      setError(
        e instanceof Error && e.message.includes("401")
          ? "还没登录，或者登录信息拿不到。"
          : `连不上应用服务：${e instanceof Error ? e.message : String(e)}`
      );
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const openApp = useCallback(async (id: string) => {
    setError(null);
    try {
      setOpen(await api.get(id));
    } catch (e) {
      setError(`打开失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }, [api]);

  /**
   * 点侧栏钉位 → 直接打开那个应用。
   * 请求走 pinStore 的通道，不是塞在 URL 里（宿主的路由表以 path 为 key）。
   */
  useEffect(() => subscribeOpenApp((appId) => {
    setNav("mine");
    void openApp(appId);
  }), [openApp]);

  /**
   * 深链：`/superapp?app=<id>` 直接打开这一个应用。
   *
   * 这是"AI 在聊天里回一张卡片、点一下就进到这个应用"的落地点 ——
   * 没有它，卡片按钮最多只能把人扔到应用列表，再让人自己找一遍，
   * "第一分钟"就断在这里。
   *
   * 取参数的逻辑在 `deeplink.ts`（纯函数，有测试）；这里只负责"拿到 id 就打开"。
   */
  useEffect(() => {
    if (typeof window === "undefined") return;
    const id = parseDeepLinkAppId(window.location.search, window.location.hash);
    if (!id) return;
    // 留一行：深链进来的和自己点进来的，出问题时要能分得清。
    console.info(DEEPLINK_BUILD_MARK, id);
    void openApp(id);
    // 打开后把参数抹掉：否则点「返回」再刷新又会被弹回详情页。
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("app");
      window.history?.replaceState?.(null, "", url.toString());
    } catch {
      /* 宿主环境不给 history 就算了，不值得为它报错 */
    }
  }, [openApp]);

  const createSample = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.create({
        name: "我的第一个应用",
        icon: "🗒️",
        created_by: "ai",
        blueprint: sampleBlueprint(),
      });
      await load();
    } catch (e) {
      setError(`创建失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const generate = async () => {
    const p = prompt.trim();
    if (!p || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.generate(p);
      setLastMode(r.mode);
      setPrompt("");
      await load();
      // 生成完直接打开 —— 让人立刻看见自己那句话变成了什么
      await openApp(r.id);
    } catch (e) {
      setError(`生成失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  /**
   * 钉 / 取消钉。
   * 上限由后端兜（超了 400），这里先在界面上说清楚 ——
   * 让人点下去才被拒绝是很差的体验。
   */
  const togglePin = async (app: AppSummary | AppDetail) => {
    setError(null);
    setNotice(null);
    const current = getPinned().map((p) => p.appId);
    const has = current.includes(app.id);
    if (!has && current.length >= PIN_SLOTS) {
      setNotice(`侧栏最多钉 ${PIN_SLOTS} 个。先取消一个再钉这个 —— 那是共用的侧栏，占满了反而难找。`);
      return;
    }
    const next = has ? current.filter((id) => id !== app.id) : [...current, app.id];
    try {
      await api.setPins(next);
      await loadPinned(api);
      await load();
    } catch (e) {
      setError(`钉位没改成：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const syncApp = async (app: AppDetail) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await api.sync(app.id);
      if (r.updated) {
        setNotice(`已更新到 v${r.version}。旧的那份留了备份，不满意可以回退。`);
        setOpen(await api.get(app.id));
      } else {
        setNotice("已经是最新的了。");
      }
      await load();
    } catch (e) {
      setError(`更新失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const revertApp = async (app: AppDetail) => {
    setBusy(true);
    setError(null);
    try {
      await api.revert(app.id);
      setNotice("已回退到更新前那一份。");
      setOpen(await api.get(app.id));
      await load();
    } catch (e) {
      setError(`回退失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const removeApp = async (app: AppDetail) => {
    setBusy(true);
    setError(null);
    try {
      await api.remove(app.id);
      setOpen(null);
      await load();
    } catch (e) {
      setError(`删除失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const pinnedIds = new Set(getPinned().map((p) => p.appId));
  const visibleApps = apps === null
    ? null
    : q.trim()
      ? apps.filter((a) => a.name.toLowerCase().includes(q.trim().toLowerCase()))
      : apps;

  // ── 详情（左边导航不动，详情长在这块里）────────────────────
  if (open) {
    const isPinned = pinnedIds.has(open.id);
    return (
      <main className="ysa-main" data-yoyoo-pane={PANE_STAGE}>
        <ShellStyles />
        <header className="ysa-top">
          <div className="ysa-top-hero">
            <div className="ysa-detail-head">
              <button className="ysa-back" onClick={() => { setOpen(null); setNotice(null); }}>← 返回</button>
              <span className="ysa-detail-name">
                {open.icon ? `${open.icon} ` : ""}{open.name}
              </span>
              {open.created_by === "ai" ? <span className="ysa-tag">AI 造的</span> : null}
              {open.source_listing_id ? <span className="ysa-tag">装来的</span> : null}
            </div>
          </div>
          <div className="ysa-top-actions">
            <button className="ysa-ghost is-lg" onClick={() => void togglePin(open)}>
              {isPinned ? "从侧栏取下" : "钉到侧栏"}
            </button>
            <button className="ysa-ghost is-lg" onClick={() => setPublishing(open)}>发布到市场</button>
            {open.source_listing_id ? (
              <>
                <button className="ysa-ghost is-lg" disabled={busy} onClick={() => void syncApp(open)}>
                  更新到最新版
                </button>
                <button className="ysa-ghost is-lg" disabled={busy} onClick={() => void revertApp(open)}>
                  回退上一次更新
                </button>
              </>
            ) : null}
            <button className="ysa-ghost is-lg" disabled={busy} onClick={() => void removeApp(open)}>删除</button>
          </div>
        </header>

        {error ? <div className="ysa-err">{error}</div> : null}
        {notice ? <div className="ysa-notice">{notice}</div> : null}

        <section className="ysa-content">
          <BlueprintRenderer node={open.blueprint} />
        </section>

        {publishing ? (
          <PublishDialog
            api={api}
            appId={publishing.id}
            appName={publishing.name}
            onClose={() => setPublishing(null)}
            onPublished={() => { setNotice("已发布到市场。"); void load(); }}
          />
        ) : null}
      </main>
    );
  }

  // ── 市场 / 我的发布 ────────────────────────────────────────
  if (nav === "market" || nav === "published") {
    return (
      <main className="ysa-main" data-yoyoo-pane={PANE_STAGE}>
        <ShellStyles />
        <MarketTab
          api={api}
          mode={nav}
          onChanged={() => void load()}
          onOpenApp={(id) => { setNav("mine"); void openApp(id); }}
          onGoMine={(hint) => { setNav("mine"); setNotice(hint); }}
        />
      </main>
    );
  }

  // ── 我的应用 / 空态 ────────────────────────────────────────
  return (
    <main className="ysa-main" data-yoyoo-pane={PANE_STAGE}>
      <ShellStyles />
      {/* 顶栏＝标题在左、搜索和按钮在右（照 .skill-market-topbar 的 hero + actions 两块） */}
      <header className="ysa-top">
        <div className="ysa-top-hero">
          <h2 className="ysa-top-title">我的应用</h2>
          <p className="ysa-top-sub">AI 造出来的东西住在这里 —— 而且下次还能打开。</p>
        </div>
        <div className="ysa-top-actions">
          <div className="ysa-search">
            <SearchIcon />
            <input
              type="search"
              value={q}
              placeholder="搜我的应用"
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          {/* 主按钮只留给下面那句"造出来" —— 两个品牌色按钮抢同一件事，人会不知道该按哪个 */}
          <button className="ysa-ghost is-lg" onClick={createSample} disabled={busy}>
            {busy ? "正在造…" : "造一个示例"}
          </button>
        </div>
      </header>

      <section className="ysa-filters">
        <div className="ysa-composer">
          <input
            value={prompt}
            placeholder="说一句话，比如：帮我做一个本周订单统计表"
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void generate(); }}
            disabled={busy}
          />
          <button className="ysa-primary" onClick={generate} disabled={busy || !prompt.trim()}>
            {busy ? "正在造…" : "造出来"}
          </button>
        </div>
      </section>

      {error ? <div className="ysa-err">{error}</div> : null}
      {notice ? <div className="ysa-notice">{notice}</div> : null}
      {lastMode === "local" ? (
        <div className="ysa-notice">
          当前还没接上模型，这一个是按结构套出来的。接上模型后，同样一句话会生成真正贴合你需求的内容。
        </div>
      ) : null}

      <section className="ysa-content">
        {visibleApps === null ? (
          <p style={{ opacity: 0.5, fontSize: 14 }}>加载中…</p>
        ) : visibleApps.length === 0 ? (
          <div className="ysa-empty">
            <strong>
              {q.trim() ? "没搜到这个名字的应用。" : "这里还什么都没有 —— 但不用你从零开始。"}
            </strong>
            <p>
              应用不是写出来的，是<strong>描述</strong>出来的：一段 JSON 蓝图，界面就长出来了。
              先造一个看看它长什么样，你随时可以删掉。也可以去「市场」装一个别人做好的。
            </p>
            <div className="ysa-empty-actions">
              <button className="ysa-primary" onClick={createSample} disabled={busy}>
                {busy ? "正在造…" : "造一个给我看看"}
              </button>
              <button className="ysa-ghost" onClick={() => setNav("market")}>去市场逛逛</button>
            </div>
          </div>
        ) : (
          <div className="ysa-grid">
            {visibleApps.map((a) => (
              /* 整张卡可点＝打开（照他们 .skill-market-card 的做法：卡片本身是 button 角色，
                 底部那排真按钮把点击拦下来，不会"想点发布结果打开了应用"） */
              <article
                className="ysa-card"
                key={a.id}
                role="button"
                tabIndex={0}
                aria-label={a.name}
                onClick={() => void openApp(a.id)}
                onKeyDown={(e) => {
                  if (e.target instanceof HTMLElement && e.target.closest("button")) return;
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    void openApp(a.id);
                  }
                }}
              >
                <div className="ysa-card-top">
                  <span className="ysa-card-icon">{a.icon || "📦"}</span>
                  <div className="ysa-card-head">
                    <div className="ysa-card-title" title={a.name}>{a.name}</div>
                    <div className="ysa-card-owner">
                      {a.created_by === "ai" ? "AI 造的" : "我做的"}
                      {a.source_listing_id ? " · 从市场装来的" : ""}
                    </div>
                  </div>
                </div>
                <div className="ysa-tags">
                  {a.pinned ? <span className="ysa-tag">已钉侧栏</span> : null}
                  {a.update_available ? <span className="ysa-tag is-warn">有新版</span> : null}
                </div>
                <div className="ysa-card-actions" onClick={(e) => e.stopPropagation()}>
                  <span className="ysa-card-stats">{fmtTime(a.updated_at).slice(0, 10)} 改过</span>
                  <span className="ysa-card-btns">
                    <button className="ysa-ghost" onClick={() => setPublishing(a)}>发布到市场</button>
                    <button className="ysa-install" onClick={() => void openApp(a.id)}>打开</button>
                  </span>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {publishing ? (
        <PublishDialog
          api={api}
          appId={publishing.id}
          appName={publishing.name}
          onClose={() => setPublishing(null)}
          onPublished={() => { setNotice("已发布到市场。"); void load(); }}
        />
      ) : null}
    </main>
  );
};

export default SuperAppStage;
