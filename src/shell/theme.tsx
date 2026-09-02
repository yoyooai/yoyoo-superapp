/**
 * 界面样式 —— **照搬宿主自己那套市场的形**。
 *
 * 🔴 出处换过一次，这里写清楚，别再搞错（2026-09-02 苏白问「他们官方的样式就是这个样子的吗？」）：
 *   · v2 抄的是 `octo-marketplace/design/skill-market-full-layout-prototype.html`
 *     —— 那只是仓里的**设计原型**（924 行），不是他们真正上线的样子。抄它的结果偏瘦、偏空。
 *   · v3（本版）改抄**他们真正上线那套**：
 *       `octo-web/packages/dmworkskillmarket/src/index.css`（2913 行，卡片/栅格/工具条/空态）
 *       `octo-web/packages/dmworkmcp/src/index.css`（4491 行，左栏 `.wk-mcp-sidebar`）
 *     尺寸、圆角、字号、字重、间距、hover/焦点行为一律按它们的实测值抄。
 *
 * 苏白 2026-09-02：「它这个现成的，你直接拿过来用就行了，不要我们自己再新研究新琢磨」。
 * 所以这里**只借形不借骨**：CSS 数值照抄，组件代码一行不抄；
 * 颜色一律走 `var(--wk-*, 兜底值)` —— 变量名与宿主同名，所以能跟着我们的品牌换色和
 * 宿主的深色主题走；兜底值是宿主 `semantic.css` 的浅色值，换壳到没有这些变量的宿主也不塌。
 *
 * 🔴 为什么是一段 CSS 字符串而不是 .css 文件：
 *    这个包要能被整个拔走换壳。带一张需要宿主构建流程配合的样式表就多一条耦合
 *    （见 styles.ts 顶部同一条理由）。一段自带的 <style> 谁都能收。
 * 🔴 类名一律 `ysa-` 前缀，且只在 `.ysa-app` 子树内生效 —— 不许污染宿主页面。
 * 🔴 本文件不许 import 任何 `@octo/*`（tests/no-host-leak.test.ts 守着）。
 */
import React from "react";

/** 布局标记：ship-web.sh 靠 grep 这个字符串确认新布局真的打进了包 */
export const LAYOUT_BUILD_MARK = "yoyoo-market-layout/v3";

/**
 * 两个面板的标记（`data-yoyoo-pane` 的值）。
 *
 * 🔴 值本身要够特别，因为构建自检只能 grep **字符串字面量的内容** ——
 *    压缩器会把 `"sidebar"` 改写成 `` `sidebar` ``（引号换成反引号），
 *    所以 grep `data-yoyoo-pane="sidebar"` 这种"代码形状"必然误报。
 *    第一版就是这么栽的。只认内容，不认引号。
 */
export const PANE_SIDEBAR = "yoyoo-pane/sidebar";
export const PANE_STAGE = "yoyoo-pane/stage";

const CSS = `
/* 🔴 三个根各自成立：OCTO 把导航挂窄栏、内容挂主区，那是**两棵不相干的树**，
   样式不能只挂在 .ysa-app 上（挂上去分栏模式下就一条都不生效）。
   .ysa-app 只在不分栏的宿主/预览里出现，负责把两栏拼起来。 */
.ysa-app,.ysa-side,.ysa-main{
  height:100%;
  font-family:var(--wk-font-sans,inherit);
  color:var(--wk-text-primary,#1f2329);
  font-size:13px;
}
/* 左栏＝bg-base（灰），右边内容区＝bg-surface（白）—— 照他们 .wk-mcp-sidebar / .skill-market-page */
.ysa-app{display:grid;grid-template-columns:260px minmax(0,1fr)}
.ysa-app *,.ysa-side *,.ysa-main *{box-sizing:border-box}
.ysa-app button,.ysa-app input,
.ysa-side button,.ysa-side input,
.ysa-main button,.ysa-main input{font:inherit;font-family:inherit}

/* ── 左边：上下切换的地方（照 dmworkmcp .wk-mcp-sidebar）───── */
.ysa-side{
  width:100%;min-height:0;overflow:auto;
  display:flex;flex-direction:column;
  background:var(--wk-bg-base,#f5f6f7);
  border-right:1px solid var(--wk-border-subtle,rgba(0,0,0,.05));
}
.ysa-side-title{
  flex:none;display:flex;align-items:center;gap:12px;
  padding:20px 20px 16px;
  border-bottom:1px solid var(--wk-border-subtle,rgba(0,0,0,.05));
}
.ysa-side-glyph{
  flex:0 0 auto;width:34px;height:34px;display:grid;place-items:center;border-radius:8px;
  background:var(--wk-brand-gradient,var(--wk-brand-primary,#5d67aa));
  color:var(--wk-text-on-brand,#fff);font-size:15px;font-weight:700;line-height:1;
}
.ysa-side-titletext{min-width:0;display:flex;flex-direction:column;gap:2px}
.ysa-side-title b{
  color:var(--wk-text-strong,rgba(28,28,35,.9));
  font-size:15px;font-weight:600;line-height:1.2;
}
.ysa-side-title span{color:var(--wk-text-tertiary,#6b7075);font-size:11px;line-height:1.4}
/* 🔴 必须是 flex column（或 grid + align-content:start）：
   grid 的行会把剩余高度平分给三格 —— 那样"我的应用"会被拉成一个 300px 高的大色块
   （2026-09-02 预览截图里就是这样）。他们用的是 <ul>，天然不拉伸。 */
.ysa-side-menu{flex:1;min-height:0;overflow-y:auto;padding:8px;display:flex;flex-direction:column}
.ysa-side-item{
  width:100%;border:0;background:transparent;border-radius:8px;cursor:pointer;
  display:flex;align-items:center;justify-content:space-between;gap:8px;
  padding:12px;text-align:left;
  color:var(--wk-text-primary,#1f2329);font-size:13px;font-weight:400;
  transition:background 150ms cubic-bezier(.16,1,.3,1);
}
.ysa-side-item:hover{background:var(--wk-bg-item-hover,rgba(46,50,56,.09))}
/* 选中态只改背景、不动字色字重 —— 照他们的注释：否则和未选中项形成视觉断层 */
.ysa-side-item.is-active,.ysa-side-item.is-active:hover{
  background:var(--wk-brand-tint-06,rgba(93,103,170,.06));
}
.ysa-side-item svg{
  width:16px;height:16px;flex:0 0 auto;
  stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;
  color:var(--wk-text-tertiary,#6b7075);
}
.ysa-side-label{min-width:0;display:flex;align-items:center;gap:12px}
.ysa-side-count{
  flex:0 0 auto;padding:1px 8px;border-radius:999px;font-size:11px;line-height:1.6;
  color:var(--wk-brand-primary,#5d67aa);background:var(--wk-brand-tint-15,rgba(93,103,170,.15));
}
.ysa-side-divider{
  height:1px;margin:8px;background:var(--wk-border-default,rgba(0,0,0,.08));
}

/* ── 右边：真实展示的地方（照 .skill-market-page）──────────── */
.ysa-main{
  min-width:0;display:flex;flex-direction:column;overflow:hidden;
  background:var(--wk-bg-surface,#fff);
}
/* 顶栏：标题在左、搜索和主按钮在右，**没有下边框** —— 边框归工具条那一行 */
.ysa-top{
  min-height:64px;display:flex;align-items:center;justify-content:space-between;
  gap:16px;padding:20px 24px 16px;flex-wrap:wrap;
}
.ysa-top-hero{min-width:0}
.ysa-top-actions{flex:0 0 auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ysa-top-title{
  margin:0;color:var(--wk-text-strong,rgba(28,28,35,.9));
  font-size:22px;font-weight:700;line-height:1.2;
  display:flex;align-items:center;gap:8px;
}
.ysa-top-sub{margin:4px 0 0;color:var(--wk-text-tertiary,#6b7075);font-size:13px}
.ysa-spacer{flex:1 1 auto}
.ysa-search{
  min-width:0;width:360px;flex:0 1 360px;
  min-height:40px;display:flex;align-items:center;
  border:1px solid var(--wk-border-subtle,rgba(0,0,0,.05));border-radius:8px;
  background:var(--wk-bg-base,#f5f6f7);color:var(--wk-text-tertiary,#6b7075);
  transition:border-color 150ms cubic-bezier(.16,1,.3,1),box-shadow 150ms cubic-bezier(.16,1,.3,1),background 150ms cubic-bezier(.16,1,.3,1);
}
.ysa-search:focus-within{
  border-color:var(--wk-brand-primary,#5d67aa);background:var(--wk-bg-surface,#fff);
  box-shadow:0 0 0 4px var(--wk-brand-tint-12,rgba(93,103,170,.12));
}
.ysa-search svg{
  width:16px;height:16px;flex:0 0 auto;margin-left:12px;
  stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;
}
.ysa-search input{
  min-width:0;width:100%;height:38px;padding:0 8px;border:0;outline:0;background:transparent;
  color:var(--wk-text-primary,#1f2329);font-size:13px;font-weight:500;
}
/* 主按钮＝他们的 WKButton variant=primary：36 高 / 8 圆角 / 14 字 / 品牌渐变 */
.ysa-primary{
  height:36px;border:0;border-radius:8px;padding:8px 16px;
  background:var(--wk-brand-gradient,var(--wk-brand-primary,#5d67aa));
  color:var(--wk-text-on-brand,#fff);
  display:inline-flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap;
  font-size:14px;font-weight:500;cursor:pointer;
  transition:background 150ms cubic-bezier(.16,1,.3,1),opacity 150ms cubic-bezier(.16,1,.3,1);
}
.ysa-primary:hover{background:var(--wk-brand-gradient-hover,var(--wk-brand-primary,#5d67aa))}
.ysa-primary:disabled{opacity:.5;cursor:default}
.ysa-primary svg{width:15px;height:15px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}

/* 工具条：分类/排序那一行 —— 边框在这里（照 .skill-market-toolbar） */
.ysa-filters{
  display:flex;align-items:center;gap:16px;flex-wrap:wrap;
  padding:12px 24px;border-bottom:1px solid var(--wk-border-subtle,rgba(0,0,0,.05));
}
.ysa-sort-label{color:var(--wk-text-tertiary,#6b7075);font-size:12px}
/* 排序＝一组胶囊里的分段控件（照 .skill-market-sort__options），不是两个光秃秃的字 */
.ysa-sort-options{
  display:inline-flex;align-items:center;gap:4px;max-width:100%;overflow-x:auto;
  padding:2px;border:1px solid var(--wk-border-subtle,rgba(0,0,0,.05));border-radius:999px;
  background:var(--wk-bg-base,#f5f6f7);
  box-shadow:inset 0 0 0 1px var(--wk-bg-surface,#fff);
}
.ysa-sort-option{
  flex:0 0 auto;height:28px;min-width:54px;padding:0 12px;border:0;border-radius:999px;
  background:transparent;color:var(--wk-text-secondary,#555b61);
  font-size:12px;font-weight:500;line-height:1;cursor:pointer;white-space:nowrap;
  display:inline-flex;align-items:center;justify-content:center;gap:2px;
  transition:background 150ms cubic-bezier(.16,1,.3,1),color 150ms cubic-bezier(.16,1,.3,1),box-shadow 150ms cubic-bezier(.16,1,.3,1);
}
.ysa-sort-option:hover{background:var(--wk-bg-hover,#dfe0e2);color:var(--wk-text-strong,rgba(28,28,35,.9))}
.ysa-sort-option.is-active{
  background:var(--wk-bg-surface,#fff);color:var(--wk-text-strong,rgba(28,28,35,.9));
  box-shadow:var(--wk-shadow-sm,0 1px 2px rgba(0,0,0,.06));font-weight:600;
}
/* 独立的次要动作（刷新）：不在分段控件里，别做成假的排序项 */
.ysa-linkbtn{
  border:0;background:transparent;padding:0;cursor:pointer;
  color:var(--wk-text-tertiary,#6b7075);font-size:12px;
}
.ysa-linkbtn:hover{color:var(--wk-text-primary,#1f2329)}

.ysa-content{flex:1;min-height:0;overflow:auto;padding:16px 24px 40px}

/* ── 卡片（照 .skill-market-grid / .skill-market-card 实测值）── */
/* 🔴 上一版是 minmax(320px,432px)：卡片被封了顶宽，宽屏上排两张就一片空白 ——
   苏白截图里"右边一大片白"就是这条。他们用 1fr，卡片自己把整行铺满。 */
.ysa-grid{
  display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,270px),1fr));
  gap:12px;align-items:stretch;
}
.ysa-card{
  position:relative;display:flex;flex-direction:column;min-width:0;min-height:174px;
  padding:16px;border-radius:8px;
  border:1px solid var(--wk-border-subtle,rgba(0,0,0,.05));
  background:var(--wk-bg-surface,#fff);box-shadow:0 1px 3px rgba(0,0,0,.04);
  cursor:pointer;
  transition:border-color 150ms cubic-bezier(.16,1,.3,1),background 150ms cubic-bezier(.16,1,.3,1),box-shadow 150ms cubic-bezier(.16,1,.3,1);
}
.ysa-card:hover,.ysa-card:focus-visible{
  outline:none;border-color:var(--wk-border-strong,rgba(0,0,0,.14));
  box-shadow:0 4px 12px rgba(0,0,0,.08);
}
.ysa-card-top{display:flex;align-items:flex-start;gap:8px}
.ysa-card-icon{
  flex:0 0 42px;width:42px;height:42px;border-radius:8px;overflow:hidden;
  display:flex;align-items:center;justify-content:center;font-size:20px;
  background:var(--wk-bg-elevated,#f2f3f4);color:var(--wk-icon-default,rgba(28,28,35,.6));
}
.ysa-card-head{
  flex:1;min-width:0;min-height:48px;
  display:flex;flex-direction:column;justify-content:center;gap:5px;
}
.ysa-card-title{
  min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  color:var(--wk-text-strong,rgba(28,28,35,.9));font-size:16px;font-weight:700;line-height:1.35;
}
.ysa-card-owner{
  min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  color:var(--wk-text-tertiary,#6b7075);font-size:13px;font-weight:500;line-height:1.35;
}
/* 标签＝描边胶囊（他们的是中性描边，不是一片品牌色底） */
.ysa-tags{display:flex;align-items:center;gap:6px;min-height:24px;margin-top:12px;overflow:hidden;white-space:nowrap}
.ysa-tag{
  flex:0 1 auto;max-width:108px;min-width:0;overflow:hidden;
  padding:3px 8px;border-radius:999px;
  border:1px solid var(--wk-border-default,rgba(0,0,0,.08));
  background:var(--wk-bg-surface,#fff);color:var(--wk-text-primary,#1f2329);
  font-size:12px;text-overflow:ellipsis;white-space:nowrap;
}
.ysa-tag.is-warn{
  border-color:rgba(214,145,32,.35);background:rgba(214,145,32,.1);color:#b8860b;
}
/* 简介固定两行高：一行的和两行的排在一起不会高低不齐（照 .skill-market-card__desc） */
.ysa-desc{
  margin:12px 0 0;min-height:42px;
  color:var(--wk-text-secondary,#555b61);font-size:13px;line-height:1.55;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;
}
/* 卡片底部：左边统计、右边动作，上面一条分隔线，永远贴在卡片底 */
.ysa-card-actions{
  margin-top:auto;padding-top:12px;
  border-top:1px solid var(--wk-border-subtle,rgba(0,0,0,.05));
  display:flex;align-items:center;justify-content:space-between;gap:8px;
}
.ysa-card-stats{
  display:inline-flex;align-items:center;gap:12px;min-width:0;
  color:var(--wk-text-secondary,#555b61);font-size:12px;line-height:1;
}
.ysa-card-btns{display:inline-flex;align-items:center;justify-content:flex-end;gap:8px;flex:0 0 auto}
/* 主动作＝深色小胶囊（照 .skill-market-card__install：26 高 / 76 最小宽 / 12 字） */
.ysa-install{
  height:26px;min-width:76px;padding:0 12px;border:1px solid transparent;border-radius:999px;
  background:var(--wk-text-strong,rgba(28,28,35,.9));color:var(--wk-bg-base,#f5f6f7);
  display:inline-flex;align-items:center;justify-content:center;gap:4px;
  font-size:12px;font-weight:500;line-height:1;cursor:pointer;
  transition:background 150ms cubic-bezier(.16,1,.3,1),color 150ms cubic-bezier(.16,1,.3,1);
}
.ysa-install:hover{background:var(--wk-text-primary,#1f2329)}
.ysa-install:disabled{opacity:.55;cursor:default}
.ysa-ghost{
  height:26px;padding:0 12px;border-radius:999px;cursor:pointer;
  border:1px solid var(--wk-border-default,rgba(0,0,0,.08));background:transparent;
  color:var(--wk-text-secondary,#555b61);font-size:12px;font-weight:500;line-height:1;
  display:inline-flex;align-items:center;justify-content:center;gap:4px;
  transition:background 150ms cubic-bezier(.16,1,.3,1),color 150ms cubic-bezier(.16,1,.3,1);
}
.ysa-ghost:hover{background:var(--wk-bg-item-hover,rgba(46,50,56,.09));color:var(--wk-text-primary,#1f2329)}
.ysa-ghost:disabled{opacity:.55;cursor:default}
/* 详情页顶栏那排动作按钮要按得住，别用卡片里那种 26 高的小胶囊 */
.ysa-ghost.is-lg,.ysa-back{
  height:36px;padding:0 14px;border-radius:8px;font-size:13px;
  border:1px solid var(--wk-border-default,rgba(0,0,0,.08));background:transparent;
  color:var(--wk-text-primary,#1f2329);cursor:pointer;
  display:inline-flex;align-items:center;gap:6px;
}
.ysa-back:hover,.ysa-ghost.is-lg:hover{background:var(--wk-bg-item-hover,rgba(46,50,56,.09))}
.ysa-meta{font-size:12px;color:var(--wk-text-tertiary,#6b7075);margin-top:6px}

/* ── 空态 / 提示条 ─────────────────────────────────────── */
/* 他们的空态是居中的一列（icon+一句话）。我们多给两句和一个能按的按钮 ——
   这一屏是"第一分钟"，不能只写"暂无数据"（见 SuperAppStage 顶部）。形照他们的：居中、不描边。 */
.ysa-empty{
  max-width:460px;margin:48px auto 0;
  display:flex;flex-direction:column;align-items:center;text-align:center;gap:12px;
  color:var(--wk-text-tertiary,#6b7075);font-size:13px;
}
.ysa-empty strong{color:var(--wk-text-secondary,#555b61);font-size:16px}
.ysa-empty p{margin:0;font-size:13px;line-height:1.7}
.ysa-empty-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:4px}
.ysa-err,.ysa-notice{margin:12px 24px 0;padding:10px 12px;border-radius:8px;font-size:13px;line-height:1.6}
.ysa-err{background:rgba(220,60,60,.08);color:#c0392b}
.ysa-notice{
  background:rgba(214,145,32,.08);border:1px solid rgba(214,145,32,.35);
  color:var(--wk-text-secondary,#555b61);
}

/* ── 「造一个」输入条 ──────────────────────────────────── */
.ysa-composer{display:flex;gap:8px;width:100%;max-width:640px}
.ysa-composer input{
  flex:1;min-width:0;height:36px;padding:0 12px;border-radius:8px;
  font-size:13px;font-weight:500;color:var(--wk-text-primary,#1f2329);
  background:var(--wk-bg-base,#f5f6f7);
  border:1px solid var(--wk-border-subtle,rgba(0,0,0,.05));outline:0;
  transition:border-color 150ms cubic-bezier(.16,1,.3,1),box-shadow 150ms cubic-bezier(.16,1,.3,1),background 150ms cubic-bezier(.16,1,.3,1);
}
.ysa-composer input:focus{
  border-color:var(--wk-brand-primary,#5d67aa);background:var(--wk-bg-surface,#fff);
  box-shadow:0 0 0 4px var(--wk-brand-tint-12,rgba(93,103,170,.12));
}

/* ── 详情（右边整块展示，左边导航不动）───────────────── */
.ysa-detail-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.ysa-detail-name{
  color:var(--wk-text-strong,rgba(28,28,35,.9));font-size:22px;font-weight:700;line-height:1.2;
  min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}

/* ── 窄屏：左栏收成一条横着的导航（不是藏起来）────────── */
@media (max-width:860px){
  .ysa-app{grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr)}
  .ysa-side{border-right:0;border-bottom:1px solid var(--wk-border-subtle,rgba(0,0,0,.05));overflow:visible}
  .ysa-side-title{padding:12px 16px 8px;border-bottom:0}
  /* 🔴 flex-direction 必须显式写 row：基础规则是 column，不覆盖的话窄屏会变成
     三个胶囊竖着排（不是他要的"横着一条"）。 */
  .ysa-side-menu{display:flex;flex-direction:row;gap:6px;overflow:auto;padding:0 12px 12px}
  .ysa-side-item{
    width:auto;height:34px;flex:0 0 auto;padding:0 12px;border-radius:999px;
    background:var(--wk-bg-surface,#fff);
  }
  .ysa-side-divider{display:none}
  .ysa-top,.ysa-filters{padding-left:16px;padding-right:16px}
  .ysa-content{padding:16px 16px 40px}
  .ysa-grid{grid-template-columns:minmax(0,1fr)}
  .ysa-search{flex:1 1 100%;width:100%}
}
`;

/**
 * 把样式注进页面。同一棵树里出现多次也只生效一份（同 id 的 <style> 内容相同）。
 * 用 dangerouslySetInnerHTML 是为了不让 React 转义 CSS 里的 `>`。
 */
export const ShellStyles: React.FC = () => (
  <style data-yoyoo-superapp={LAYOUT_BUILD_MARK} dangerouslySetInnerHTML={{ __html: CSS }} />
);

/** 左栏图标 —— 内联 SVG，不依赖宿主图标库（换壳时一起走） */
export const NavIcon: React.FC<{ name: "mine" | "market" | "published" }> = ({ name }) => {
  if (name === "market") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M21 16V8a2 2 0 0 0-1-1.73L13 2.27a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
        <path d="M3.3 7 12 12l8.7-5M12 22V12" />
      </svg>
    );
  }
  if (name === "published") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 19V5" /><path d="m5 12 7-7 7 7" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
};

/** 搜索框里那个放大镜 */
export const SearchIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
  </svg>
);
