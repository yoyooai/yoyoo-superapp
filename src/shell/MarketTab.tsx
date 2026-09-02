/**
 * 市场 / 我的发布 —— 右边那整块展示区。
 *
 * 布局照搬宿主自己的设计原型（见 theme.tsx 顶部出处）：
 * 顶栏＝标题+搜索+主按钮，筛选条＝排序，下面是卡片网格。
 * 左边那条上下切换的导航在 SuperAppPage 里，这里只管右边。
 *
 * 🔴 不许 import 任何 `@octo/*`（tests/no-host-leak.test.ts 守着）。
 *
 * 界面上的三条诚实（措辞别改软）：
 *  · **安装写的是"装到我这儿"**，不是"安装"两个字了事 —— 用户得知道装完那份是他的、能改。
 *  · **AI 造的如实标注**，不设门槛也不藏（SPEC-market §9-3）。
 *  · **作者发新版只提示不推送**，界面上说清"点了才更新"，别让人以为东西会自己变。
 */
import React, { useCallback, useEffect, useState } from "react";
import { SuperAppApi, type BrowseSort, type Listing, type ListingDetail } from "../api/client";
import { c, fmtTime } from "./styles";
import { SearchIcon } from "./theme";
import PublishDialog from "./PublishDialog";

export interface MarketTabProps {
  api: SuperAppApi;
  /** market＝逛别人的；published＝我发布的（同一份列表，只是加了作者筛选） */
  mode: "market" | "published";
  /** 装完/更新完要刷新"我的应用" */
  onChanged: () => void;
  /** 装完直接打开那一份 */
  onOpenApp: (appId: string) => void;
  /** 「发布我的应用」按钮：把人送回"我的应用"去挑一个 */
  onGoMine: (hint: string) => void;
}

const MarketTab: React.FC<MarketTabProps> = ({ api, mode, onChanged, onOpenApp, onGoMine }) => {
  const mine = mode === "published";
  const [listings, setListings] = useState<Listing[] | null>(null);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<BrowseSort>("new");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ListingDetail | null>(null);
  /** 正在发新版的那条（复用发布弹层的"版本"模式） */
  const [versioning, setVersioning] = useState<Listing | null>(null);
  /** 正在确认下架的那条 —— 下架是对外可见性的改变，要问一句 */
  const [delisting, setDelisting] = useState<Listing | null>(null);

  const load = useCallback(async (keyword: string, s: BrowseSort) => {
    setError(null);
    try {
      const r = await api.browse(keyword, 0, { sort: s, mine });
      setListings(r.listings);
    } catch (e) {
      setListings([]);
      setError(`${mine ? "我的发布" : "市场"}打不开：${e instanceof Error ? e.message : String(e)}`);
    }
  }, [api, mine]);

  // 切换左栏（市场 ↔ 我的发布）时把上一栏的搜索词和结果清掉，
  // 否则会出现"我的发布里搜着别人的关键词"这种看不懂的状态。
  useEffect(() => {
    setQ("");
    setSort("new");
    setListings(null);
    void load("", "new");
  }, [load]);

  const refresh = () => void load(q, sort);

  const pickSort = (s: BrowseSort) => {
    setSort(s);
    void load(q, s);
  };

  const install = async (l: Listing) => {
    setBusyId(l.id);
    setError(null);
    try {
      const r = await api.install(l.id);
      onChanged();
      await load(q, sort);
      onOpenApp(r.app_id);
    } catch (e) {
      setError(`安装失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusyId(null);
    }
  };

  const update = async (l: Listing) => {
    if (!l.my_app_id) return;
    setBusyId(l.id);
    setError(null);
    try {
      await api.sync(l.my_app_id);
      onChanged();
      await load(q, sort);
    } catch (e) {
      setError(`更新失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusyId(null);
    }
  };

  const delist = async (l: Listing) => {
    setBusyId(l.id);
    setError(null);
    try {
      await api.delist(l.id);
      setDelisting(null);
      setNotice("已下架。已经装走的人不受影响 —— 他们那份是自己的副本。");
      await load(q, sort);
    } catch (e) {
      setError(`下架失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusyId(null);
    }
  };

  const openDetail = async (id: string) => {
    setError(null);
    try {
      setDetail(await api.listing(id));
    } catch (e) {
      setError(`打不开：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <>
      {/* 顶栏＝标题在左、搜索和主按钮在右（照 .skill-market-topbar 的 hero + actions 两块） */}
      <header className="ysa-top">
        <div className="ysa-top-hero">
          <h2 className="ysa-top-title">{mine ? "我的发布" : "市场"}</h2>
          <p className="ysa-top-sub">
            {mine
              ? "你发布出去的东西。发新版只会提示装过的人，不会自动改他们那份。"
              : "别人发布的应用。装到你这儿 = 复制一份到你名下，装完就是你的，可以随便改。"}
          </p>
        </div>
        <div className="ysa-top-actions">
          <div className="ysa-search">
            <SearchIcon />
            <input
              type="search"
              value={q}
              placeholder={mine ? "搜我发布过的" : "搜一下，比如：订单、看板"}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void load(q, sort); }}
            />
          </div>
          {mine ? null : (
            <button
              className="ysa-primary"
              onClick={() => onGoMine("挑一个应用点开，里面有「发布到市场」。")}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></svg>
              发布我的应用
            </button>
          )}
        </div>
      </header>

      {/* 排序＝一组胶囊里的分段控件（照 .skill-market-sort__options）；
          「刷新」不是排序项，做成一个次要链接按钮，别混进分段控件里 */}
      <section className="ysa-filters">
        <span className="ysa-sort-label">排序</span>
        <span className="ysa-sort-options" aria-label="排序方式">
          <button
            type="button"
            aria-pressed={sort === "new"}
            className={`ysa-sort-option${sort === "new" ? " is-active" : ""}`}
            onClick={() => pickSort("new")}
          >
            最新
          </button>
          <button
            type="button"
            aria-pressed={sort === "hot"}
            className={`ysa-sort-option${sort === "hot" ? " is-active" : ""}`}
            onClick={() => pickSort("hot")}
          >
            装得最多
          </button>
        </span>
        <span className="ysa-spacer" />
        <button type="button" className="ysa-linkbtn" onClick={refresh}>刷新</button>
      </section>

      {error ? <div className="ysa-err">{error}</div> : null}
      {notice ? <div className="ysa-notice">{notice}</div> : null}

      <section className="ysa-content">
        {listings === null ? (
          <p style={{ opacity: 0.5, fontSize: 14 }}>加载中…</p>
        ) : listings.length === 0 ? (
          <div className="ysa-empty">
            <strong>
              {q
                ? "没搜到这个。"
                : mine
                  ? "你还没发布过任何应用。"
                  : "市场还是空的 —— 第一个发布的人可以是你。"}
            </strong>
            <p>
              到「我的应用」里挑一个，点「发布到市场」，别人就能装走一份自己改。
              发布的是那一版的快照，你之后接着改自己的，不会把别人装走的那份改坏。
            </p>
            <div className="ysa-empty-actions">
              <button className="ysa-primary" onClick={() => onGoMine("挑一个应用点开，里面有「发布到市场」。")}>
                去挑一个来发布
              </button>
            </div>
          </div>
        ) : (
          <div className="ysa-grid">
            {listings.map((l) => (
              /* 整张卡可点＝看详情（照 .skill-market-card：卡片本身是 button 角色，
                 底部真按钮把点击拦下来，不会"想点安装结果开了详情"） */
              <article
                className="ysa-card"
                key={l.id}
                role="button"
                tabIndex={0}
                aria-label={l.name}
                onClick={() => void openDetail(l.id)}
                onKeyDown={(e) => {
                  if (e.target instanceof HTMLElement && e.target.closest("button")) return;
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    void openDetail(l.id);
                  }
                }}
              >
                <div className="ysa-card-top">
                  <span className="ysa-card-icon">{l.icon || "📦"}</span>
                  <div className="ysa-card-head">
                    <div className="ysa-card-title" title={l.name}>{l.name}</div>
                    <div className="ysa-card-owner">
                      {l.created_by === "ai" ? "AI 造的" : "人做的"} · v{l.version}
                    </div>
                  </div>
                </div>
                <p className="ysa-desc">{l.summary}</p>
                <div className="ysa-tags">
                  {l.is_author && !mine ? <span className="ysa-tag">我发布的</span> : null}
                  {l.installed && !mine ? <span className="ysa-tag">已装</span> : null}
                  {l.update_available ? <span className="ysa-tag is-warn">有新版</span> : null}
                </div>
                <div className="ysa-card-actions" onClick={(e) => e.stopPropagation()}>
                  <span className="ysa-card-stats">{l.installs} 人装过</span>
                  <span className="ysa-card-btns">
                  {mine ? (
                    <>
                      <button className="ysa-ghost" disabled={busyId === l.id} onClick={() => setDelisting(l)}>
                        下架
                      </button>
                      <button className="ysa-install" disabled={busyId === l.id} onClick={() => setVersioning(l)}>
                        发新版
                      </button>
                    </>
                  ) : l.update_available ? (
                    <button className="ysa-install" disabled={busyId === l.id} onClick={() => void update(l)}>
                      {busyId === l.id ? "更新中…" : "有新版，更新"}
                    </button>
                  ) : l.installed ? (
                    <button className="ysa-ghost" onClick={() => l.my_app_id && onOpenApp(l.my_app_id)}>
                      打开我那份
                    </button>
                  ) : (
                    <button className="ysa-install" disabled={busyId === l.id} onClick={() => void install(l)}>
                      {busyId === l.id ? "装入中…" : "装到我这儿"}
                    </button>
                  )}
                  </span>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {detail ? (
        <div style={c.modalMask} onClick={() => setDetail(null)}>
          <div style={c.modal} onClick={(e) => e.stopPropagation()}>
            <strong style={{ fontSize: 17 }}>
              {detail.icon ? `${detail.icon} ` : ""}{detail.name}
            </strong>
            <p style={{ margin: 0, fontSize: 14, lineHeight: 1.8, opacity: 0.85 }}>{detail.summary}</p>
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              {detail.created_by === "ai" ? <span style={c.badge}>AI 造的</span> : null}
              {detail.is_author ? <span style={c.badge}>我发布的</span> : null}
              <span style={{ fontSize: 12, opacity: 0.55 }}>
                当前 v{detail.version} · {detail.installs} 人装过
              </span>
            </div>
            <div style={{ fontSize: 12, opacity: 0.7, lineHeight: 1.9 }}>
              <div style={{ marginBottom: 4, opacity: 0.8 }}>版本历史</div>
              {detail.versions.map((v) => (
                <div key={v.version}>
                  v{v.version} · {fmtTime(v.created_at)}{v.note ? ` · ${v.note}` : ""}
                </div>
              ))}
            </div>
            <p style={{ margin: 0, fontSize: 12, opacity: 0.6, lineHeight: 1.8 }}>
              装到你这儿 = 复制一份到你名下，装完就是你的，可以随便改。
              作者以后发新版只会提示你，<strong>不会自动改你那份</strong>。
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <button style={c.ghost} onClick={() => setDetail(null)}>关闭</button>
            </div>
          </div>
        </div>
      ) : null}

      {versioning ? (
        <PublishDialog
          api={api}
          appId={versioning.id}
          appName={versioning.name}
          listingId={versioning.id}
          onClose={() => setVersioning(null)}
          onPublished={() => { setNotice("新版本已发布。装过的人会看到「有新版」，点了才会更新。"); refresh(); }}
        />
      ) : null}

      {delisting ? (
        <div style={c.modalMask} onClick={() => setDelisting(null)}>
          <div style={c.modal} onClick={(e) => e.stopPropagation()}>
            <strong style={{ fontSize: 17 }}>把「{delisting.name}」下架？</strong>
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.8, opacity: 0.8 }}>
              下架之后别人在市场里看不到它，也装不了。
              <strong>已经装走的人不受影响</strong> —— 他们那份是自己的副本，不会消失。
              你的原始应用也还在「我的应用」里。
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <button style={c.ghost} onClick={() => setDelisting(null)}>再想想</button>
              <button
                style={c.btn}
                disabled={busyId === delisting.id}
                onClick={() => void delist(delisting)}
              >
                {busyId === delisting.id ? "下架中…" : "确认下架"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
};

export default MarketTab;
