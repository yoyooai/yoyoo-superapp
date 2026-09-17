/**
 * 设计正本检查器 —— **规则的唯一实现处**。
 *
 * 09-04 晚苏白点名"设计风格是接下来的重点"。风格要守得住，靠的不是口号，
 * 是三样东西：一份正本（`src/runtime/designTokens.ts` + `componentCss.ts`）、
 * 一批会报红的判据、以及**判据在造新应用时就挡住违规**，而不是等发布前才发现。
 *
 * 为什么把规则搬到这里，而不是留在测试文件里：
 * 原来这三条判据写在 `company-brain-blueprint.test.mjs` 里，只扫**那一个**蓝图。
 * 下一个超级应用（哪怕是 AI 自己在聊天里造的）不经过那个文件，等于不受任何约束——
 * "六个模块看起来不像同一个产品"这件事会在应用之间原样复发一遍。
 * 规则只能有一处定义：测试引它，脚手架也引它，造应用的那只手先过这一关。
 *
 * 三条判据（都对着一次真实的病）：
 *  ①不许写死颜色 —— 深色模式下失效，且六个模块会慢慢各长各的
 *  ②不许写死字体 —— 同上，第三刀之前整个工作台只有一个字族，层次只能靠加粗堆
 *  ③不许重新定义组件 —— 组件长什么样只能有一处定义，覆盖了别人看不到
 */

/** 组件层已经定义过的类名。模块要局部微调请用新类名，不要覆盖组件本身。 */
export const COMPONENT_SELECTORS = [
  "card", "kpi", "kpis", "badge", "btn", "sec", "chip", "chips", "empty", "sbar",
  "tbl", "dec", "figs", "fig", "state", "skel", "ask", "hd", "wrap", "tl", "mbar",
  // 09-08 第四刀新增：图表原语 + 从六份重复里收敛出来的模块组件
  "viz", "lg", "bars", "brow", "bt", "bv", "bl", "dev", "dt", "dumb", "meter",
  "spark", "heat", "tip", "person", "kanban", "lane", "tk", "qa", "steps", "cmp",
];

/**
 * 去掉合法的 var(--y-xxx) 之后，还剩下的 #hex 就是手写的。
 *
 * 🔴 09-08 修一个真误报：原来是 `#[0-9A-Fa-f]{3,8}`，把**批次号**
 *    `占位批次 #A0908-017` 报成了写死颜色（`#A0908` 是 5 位）。
 *    CSS 颜色只有 3/4/6/8 位这四种长度，中间的 5/7 位都不是颜色。
 *    误报的代价不是"多报一条"——是让人开始不信这个检查器，
 *    然后就会有人加 `// eslint-disable` 那种绕过法，整道闸门就废了。
 */
export function handwrittenColors(text) {
  const stripped = String(text).replace(/var\(--y-[a-z0-9-]+\)/g, "V");
  const re = /#(?:[0-9A-Fa-f]{8}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{4}|[0-9A-Fa-f]{3})(?![0-9A-Fa-f])/g;
  return [...new Set(stripped.match(re) || [])];
}

/**
 * 手写的字体族（`inherit` 与正本 token 之外的一切）。
 *
 * 🔴 2026-09-04 晚：苏白看过三字族（衬线大标题/等宽小标签）的改前改后，
 *    结论是**旧的更好看**，那一层已整体撤回。所以这里只认 `--y-font` 这一个字族 ——
 *    留着 `--y-font-display|-mono` 会更糟：写了也没人定义它，模块拿到的是空值，
 *    界面上悄悄退回浏览器默认字，而检查还是绿的。
 *    这条规则本身与"长什么样"无关，它只管"别在模块里自己写字体名"，所以保留。
 */
export function handwrittenFonts(text) {
  const out = [];
  // 值里可能带引号（`font-family:"PingFang SC"`），甚至是 JS 字符串里被转义过的引号，
  // 所以只以 `;` / `}` 收尾，不在引号处提前断开 —— 断开了报出来的是半截，人看不懂。
  for (const m of String(text).matchAll(/font-family\s*:\s*([^;}]{1,120})/g)) {
    const v = m[1].trim().replace(/\\/g, "");
    if (v === "inherit") continue;
    if (/^var\(--y-font\)$/.test(v)) continue;
    out.push(v);
  }
  return [...new Set(out)];
}

/**
 * 模块代码是 JS 字符串，样式表往往带着转义（`\n` `\"`）。**先还原再解析** ——
 * 不还原就会把 `\n.qa{…}` 读成一坨，规则体划不准，而划不准就不该放过去。
 */
function unescapeCss(raw) {
  return String(raw)
    .replace(/\\n/g, "\n").replace(/\\r/g, "")
    .replace(/\\"/g, '"').replace(/\\'/g, "'");
}

/** 一条 CSS 规则体里，除自定义属性（`--x:y`）之外的声明。空数组＝这条只是在转指配色 */
function realDeclarations(body) {
  return String(body).split(";").map((d) => d.trim()).filter(Boolean)
    .filter((d) => !/^--[a-zA-Z0-9-]+\s*:/.test(d));
}

/**
 * 模块自己的 <style> 里重新定义了哪些组件类。
 *
 * 🔴 09-08 修一个真误报：**只声明自定义属性**的规则（`.wrap{--y-accent:var(--y-scene-cost)}`）
 *    不是"重定义组件"，是这份正本明确许可的**配色转指**。旧实现在整段 <style> 上
 *    直接测 `\.wrap\s*[{,]`，于是唯一合法的转指写法一直被报红 —— 合法路径被拦死，
 *    人就只会去找不合法的路径绕开检查。所以要逐条规则看，且看规则体。
 */
export function redefinedComponents(text) {
  const out = [];
  for (const m of String(text).matchAll(/<style>([\s\S]*?)<\/style>/g)) {
    const css = unescapeCss(m[1]);
    for (const r of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!realDeclarations(r[2]).length) continue; // 只转指配色 ⇒ 放行
      const sel = `${r[1]}{`;
      for (const name of COMPONENT_SELECTORS) {
        if (new RegExp(`\\.${name}\\s*[{,]`).test(sel)) out.push(`.${name}`);
      }
    }
  }
  return [...new Set(out)];
}


/**
 * 🔴 **第四条判据（09-08 第四刀）：模块里不许自己写 CSS。**
 *
 * 为什么必须有这一条 —— 这是 09-08"又短又少又丑"的**结构性病根**：
 * 前三条只禁"重新定义**已有**组件"（`.card{` 之类），却**没禁自造新组件**。
 * 上面那行注释还亲口开了这个后门："模块要局部微调请用新类名"。
 * 我就从这个后门走了出去：设备 AIOS v5 的六个模块里，各带一份 ~2000 字
 * **一模一样**的自造样式（`.contact/.avatar/.kanban/.klane/.tcard/.prio/
 * .barrow/.qa/.principle/.pcard…`）—— 正是这份文件开头声讨的那个病，
 * 换了个名字（"新类名"而不是"覆盖"）又长了回来，而且检查全绿。
 *
 * 后果有两层，第二层才是要命的：
 *   ①一致性又回到"靠我记得复制同一份"，六个模块必然各自漂
 *   ②**审美回到"我当天的手感"** —— 共享层是一次性投入、可以照着检验单校准，
 *     模块里手搓的 CSS 每次都是现场发挥。苏白 09-08 的原话是
 *     "如果你不改变工作方式，不管怎么做，出来都是这种臭臭的东西"，
 *     指的就是这件事：不把这条路堵死，改一版还是同一个下限。
 *
 * 合法的例外只有一个：**只声明自定义属性**（把 `--y-accent` 转指到某个
 * `--y-scene-*`）。那是"选一档正本里已有的配色"，不是自己造样式。
 * 要新组件 ⇒ 加进 `src/runtime/componentCss.ts`，六个模块一起受益。
 */
export function selfDefinedCss(text) {
  const out = [];
  for (const m of String(text).matchAll(/<style>([\s\S]*?)<\/style>/g)) {
    const css = unescapeCss(m[1]);
    // @media / @keyframes / @supports 一律不许：它们是"造样式"，不是"选配色"，
    // 而且嵌套花括号会让下面的逐条解析读不准 —— 读不准就不该放过去。
    for (const at of css.matchAll(/@(media|keyframes|supports|font-face|import)\b/g)) {
      out.push(`@${at[1]}`);
    }
    for (const r of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sel = r[1].trim().replace(/\s+/g, " ");
      if (!sel || sel.startsWith("@")) continue;
      // 只有自定义属性声明（--x: y）＝合法转指；出现任何普通属性就是在造样式
      const real = realDeclarations(r[2]);
      if (real.length) out.push(`${sel} { ${real[0]}${real.length > 1 ? "; …" : ""} }`);
    }
  }
  return [...new Set(out)];
}

/**
 * 🔴 **第五条判据：元素 `style=` 属性只准放"数据几何"。**
 *
 * 条形有多长、点在哪个位置，这些是**数据**，只能内联（正本没法预知 87.3%）。
 * 但颜色、字体、内外边距、边框内联进去，就等于绕过第四条判据继续自己写样式 ——
 * 只是把 `<style>` 换成了 `style=`。所以白名单只留几何量。
 */
const GEOMETRY_PROPS = /^(--[a-zA-Z0-9-]+|width|height|min-width|min-height|max-width|max-height|left|right|top|bottom|flex-basis)$/;

export function inlineStyleOffenders(text) {
  const out = [];
  // style="..." / style=\"...\"（JS 字符串里的转义写法）都要认
  for (const m of String(text).matchAll(/style\s*=\s*(?:\\?["'])([^"'\\]*)/g)) {
    for (const d of m[1].split(";")) {
      const [prop] = d.split(":");
      const name = (prop || "").trim();
      if (!name) continue;
      if (!GEOMETRY_PROPS.test(name)) out.push(name);
    }
  }
  return [...new Set(out)];
}

/**
 * 把蓝图里所有会变成页面的代码摘出来，按"模块"分组。
 * 结构可能是 page→tabs→tab→children[script]，也可能是 page→children[script]，
 * 所以这里递归走，遇到带 label 的层就把它当模块名。
 */
export function collectModules(blueprint) {
  const mods = [];
  const walk = (node, label) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const n of node) walk(n, label); return; }
    const here = typeof node.label === "string" && node.label ? node.label : label;
    if (typeof node.code === "string" && node.code) {
      const last = mods[mods.length - 1];
      if (last && last.label === here) last.code += node.code;
      else mods.push({ label: here || "(未命名)", code: node.code });
    }
    for (const k of ["children", "tabs", "body"]) if (node[k]) walk(node[k], here);
  };
  walk(blueprint, "");
  return mods;
}

/**
 * 检查一份蓝图。返回 `[{ rule, label, detail }]`，空数组＝合格。
 * **不改任何东西** —— 静默改写比漏报更糟，作者会以为自己写出去的是原样。
 */
export function lintBlueprintDesign(blueprint, opts = {}) {
  // 🔴 `grandfathered` 只给**09-08 之前就已上线**的应用用（棘轮：只能变短，不能变长）。
  //    新造的应用一律走严格档 —— 默认值就是严格，忘记传参不会漏检。
  const lax = opts.grandfathered === true;
  const offenders = [];
  for (const { label, code } of collectModules(blueprint)) {
    for (const c of handwrittenColors(code)) offenders.push({ rule: "color", label, detail: c });
    for (const f of handwrittenFonts(code)) offenders.push({ rule: "font", label, detail: f });
    for (const s of redefinedComponents(code)) offenders.push({ rule: "component", label, detail: s });
    if (!lax) {
      for (const d of selfDefinedCss(code)) offenders.push({ rule: "selfcss", label, detail: d });
      for (const g of inlineStyleOffenders(code)) offenders.push({ rule: "inline", label, detail: g });
    }
  }
  return offenders;
}

const WHY = {
  color: "颜色只能来自设计正本 var(--y-*)：写死的色在深色模式下会失效，六个模块也会慢慢各长各的",
  font: "字体只能来自 --y-font：一个模块自己写字体名，整套就开始不像同一个产品",
  component: "组件长什么样只能有一处定义（src/runtime/componentCss.ts）：覆盖组件本身，别的模块看不到",
  selfcss: "模块里不许自己写 CSS：要新组件请加进 src/runtime/componentCss.ts（六份重复的自造样式＝审美回到当天手感，09-08 的病根）",
  inline: "style= 只准放数据几何（width/height/left/…）：颜色字体边距内联进去，等于把自己写样式换个地方继续",
};

/** 把检查结果写成人能直接照着改的一段话 */
export function formatDesignOffenders(offenders) {
  if (!offenders.length) return "";
  const byRule = new Map();
  for (const o of offenders) {
    if (!byRule.has(o.rule)) byRule.set(o.rule, []);
    byRule.get(o.rule).push(`${o.label}: ${o.detail}`);
  }
  return [...byRule.entries()]
    .map(([rule, hits]) => `· ${WHY[rule]}\n    ${hits.slice(0, 8).join("\n    ")}`)
    .join("\n");
}
