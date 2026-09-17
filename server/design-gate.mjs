/**
 * 设计闸门 —— 把 `design-lint.mjs` 的判据**接到真实入库路径上**。
 *
 * 🔴 为什么需要这个文件（09-15 查出来的病根）：
 * `design-lint.mjs` 开头亲口写着"判据要在造应用时就挡住违规，而不是等发布前才发现"，
 * 但 grep 全仓的结果是：**真实入库路径一次都没调用过它**。
 * 引它的只有测试文件和 `bin/mkapp.mjs`/`bin/updateapp.mjs` 两个手工脚手架 ——
 * 也就是说，"美不美"实际上全靠**我记得跑那个脚本**。
 * 一个靠人记性守的规则等于没有规则：09-08 那份"又短又少又丑"就是这么长出来的，
 * 而且当时检查器全绿，因为根本没人调用它。
 *
 * ⚠️ 尤其是 `POST /apps/generate`（"我说一句话，AI 给我造个应用"）——
 * 那是**最该被守住的一条路**（写代码的是模型，不是人），却是唯一一条连
 * `normalizeForStore` 都不过、直接 `q.insert` 的路。三条门里它漏得最狠。
 *
 * ## 为什么是棘轮，不是一刀切
 * 实测线上 16 个应用里 **4 个不合格**（432 / 62 / 17 / 286 条）。
 * 如果新旧一律严格档，这 4 个应用**改一个字都存不回去** —— 等于把它们冻死，
 * 而且冻死的方式很隐蔽：用户点保存，弹一句他看不懂的话，东西没存上。
 * 所以按它们自己注释里那个词来：**棘轮**。
 *   · 新建（没有前一版）⇒ 严格档，一条都不许有
 *   · 更新（有前一版）  ⇒ 违规条数只许**变少或持平**，变多就拒
 * 效果是存量可以带着病继续改（不冻死），但只能越改越干净，回不去。
 *
 * ## 为什么应用和卡片判据不同（09-15 实测后改的）
 * 交接文档里我上一轮写的是"卡片同一套判据"。**实测不成立**：
 * 卡片是 AdaptiveCard 声明式 JSON，没有 `code`、没有 `<style>`、没有 CSS ——
 * 对它跑 `lintBlueprintDesign()` 永远返回 0 条。那不是"守住了"，是**空动作**，
 * 比不做更糟：它会在测试里显示为绿，让人以为卡片这条路也被管住了。
 *
 * 卡片形态上真正对应的那条病是**枚举**：宿主对 AdaptiveCard 属性层
 * **不做白名单**（见 `octo-connector/src/card.mjs` 开头的查证），
 * 颜色靠 `color` / `style` 落在宿主 HostConfig 的几档里才会随主题走。
 * 写 `"color":"#e11d48"` 不会报错 —— 宿主**静默忽略**，渲染成默认色。
 * 于是作者以为自己设了颜色，实际没有，且深色模式下必然失效。
 * 这正是 design-lint 第一条判据（"不许写死颜色"）在卡片形态上的样子。
 */

import { lintBlueprintDesign, formatDesignOffenders } from "./design-lint.mjs";

/**
 * AdaptiveCard 里 `color` / `style` 的合法取值（合并成一个集合）。
 *
 * 不同元素上枚举本来不同（TextBlock.color 七档、Container.style 六档、
 * Action.style 三档），这里**故意合并、故意宽松** —— 我们要挡的是
 * "写死 #hex / 写 red 这种 CSS 色名"，不是替宿主做精确的 schema 校验
 * （那是宿主自己的事，重复实现一份必然与它漂移）。
 * 误报的代价见 design-lint 开头那段：一旦有人不信这个检查，就会去找绕过法。
 */
const CARD_COLOR_VALUES = new Set([
  "default", "dark", "light", "accent", "good", "warning", "attention",
]);
const CARD_STYLE_VALUES = new Set([
  "default", "emphasis", "good", "attention", "warning", "accent",
  "positive", "destructive",
]);

/**
 * 卡片的违规项。返回 `[{ rule, label, detail }]`，与 design-lint 同一种形状，
 * 这样 `formatDesignOffenders()` 能直接复用，人话只有一处定义。
 */
export function lintCardDesign(card) {
  const offenders = [];
  const walk = (node, path) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((n, i) => walk(n, `${path}[${i}]`));
      return;
    }
    const here = typeof node.type === "string" && node.type ? node.type : path;
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === "string") {
        const low = v.trim().toLowerCase();
        if (k === "color" && !CARD_COLOR_VALUES.has(low)) {
          offenders.push({ rule: "cardcolor", label: here, detail: `color: ${v}` });
        } else if (k === "style" && !CARD_STYLE_VALUES.has(low)) {
          offenders.push({ rule: "cardstyle", label: here, detail: `style: ${v}` });
        }
        continue;
      }
      walk(v, `${path}.${k}`);
    }
  };
  walk(card, "card");
  return offenders;
}

const CARD_WHY = {
  cardcolor:
    "卡片颜色只能用宿主那几档（default/dark/light/accent/good/warning/attention）：" +
    "写死色值宿主会**静默忽略**渲染成默认色，你以为设了其实没设，深色模式下必然失效",
  cardstyle:
    "卡片 style 只能用宿主那几档（default/emphasis/good/attention/warning/accent/" +
    "positive/destructive）：其余值宿主认不得，等于没写",
};

/** 卡片违规的人话。与 design-lint 的 formatDesignOffenders 输出同一种形状。 */
export function formatCardOffenders(offenders) {
  if (!offenders.length) return "";
  const byRule = new Map();
  for (const o of offenders) {
    if (!byRule.has(o.rule)) byRule.set(o.rule, []);
    byRule.get(o.rule).push(`${o.label}: ${o.detail}`);
  }
  return [...byRule.entries()]
    .map(([rule, hits]) => `· ${CARD_WHY[rule]}\n    ${hits.slice(0, 8).join("\n    ")}`)
    .join("\n");
}

/**
 * 棘轮判定。**这是本文件唯一对外的决策点** —— 应用和卡片都走它，
 * 两种内容只在"用哪个 lint / 哪个 format"上不同，棘轮规则本身只有一份。
 *
 * @param {object} next  这次要存的内容
 * @param {object|null} prev  前一版（更新时传；新建传 null/undefined）
 * @param {{lint:Function, format:Function, what:string}} kind
 * @returns {{ok:true, ratchet?:object} | {ok:false, error:string}}
 */
function gate(next, prev, kind) {
  const offenders = kind.lint(next);
  if (!offenders.length) return { ok: true };

  const detail = kind.format(offenders);

  // 新建：严格档。一条都不许有 —— 新东西没有历史包袱，没有理由带病出生。
  if (prev == null) {
    return {
      ok: false,
      error:
        `这个${kind.what}不符合设计正本，有 ${offenders.length} 条要改：\n${detail}\n` +
        `（新造的${kind.what}走严格档。已有的${kind.what}可以带着旧问题继续改，但只能越改越少。）`,
    };
  }

  // 更新：棘轮。只许变少或持平。
  let before;
  try {
    before = kind.lint(prev).length;
  } catch {
    // 前一版解析不了（脏数据）⇒ 不拿它当基线，按严格档之外的最宽处理：放行。
    // 理由：基线不可信时拒绝，等于因为**旧数据的毛病**罚现在这次修改。
    return { ok: true, ratchet: { before: null, after: offenders.length, note: "前一版无法解析，本次不做棘轮判定" } };
  }
  if (offenders.length <= before) {
    return { ok: true, ratchet: { before, after: offenders.length } };
  }
  return {
    ok: false,
    error:
      `这次改动让设计违规从 ${before} 条涨到了 ${offenders.length} 条。\n${detail}\n` +
      `（存量${kind.what}可以带着旧问题改，但条数只能变少或持平，不能变多。）`,
  };
}

const APP_KIND = { lint: lintBlueprintDesign, format: formatDesignOffenders, what: "应用" };
const CARD_KIND = { lint: lintCardDesign, format: formatCardOffenders, what: "卡片" };

/** 应用（蓝图）的设计闸。`prev` 是前一版蓝图对象，新建时不传。 */
export function gateBlueprint(next, prev) {
  return gate(next, prev, APP_KIND);
}

/** 卡片的设计闸。`prev` 是前一版卡片对象，新建时不传。 */
export function gateCard(next, prev) {
  return gate(next, prev, CARD_KIND);
}
