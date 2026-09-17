/**
 * blueprint 词汇表与收敛器 —— **两个入口共用的唯一一份**。
 *
 * 为什么单独成一个模块（而不是留在 generate.mjs 里）：
 * 造应用现在有两条入口，以后还会更多 ——
 *   ①用户在应用页打字   → generate.mjs 调模型产 JSON
 *   ②小A 在聊天里说一句 → 我自己产 JSON，走 /apps/for
 * 两条都是"模型产物"，都必须当**不可信输入**处理。
 * 放在 generate.mjs 里的话，第二条入口就得 import 一个名字叫"生成"的模块才能做校验，
 * 迟早有人（包括我）觉得别扭，就地复制一份 —— 那一刻这道门就出现了两个版本，
 * 而且是**静悄悄**出现的。所以把它抬成独立模块，谁都只能 import 这一份。
 *
 * 🔴 `server/structure.test.mjs` 有一条测试直接 grep：generate.mjs 里不许再出现
 *    `function sanitizeBlueprint`。谁复制一份回去，测试立刻报红。
 */

import { gateBlueprint } from "./design-gate.mjs";

/** 渲染器当前支持的组件词汇 —— 这份清单同时用于约束模型和校验产物 */
export const VOCAB = [
  "page", "card", "section", "heading", "text", "badge",
  "divider", "list", "table", "button", "script",
  // 09-03 GenUI 升级：仪表盘级组件（借 dsh-genui 设计，见 docs/PLAN-genui-sample-20260903.md）
  "stat", "chart", "tabs", "keyvalue", "row",
  // 09-15 网页应用：一整个网页当成一个应用嵌进来（半屏内嵌 / 全屏 / 新标签）
  "webview",
];

/**
 * 收敛按钮/交互的 action —— 这是"修活按钮"的后端半边（病根之一是这里没保留 action）。
 * 只认两种 kind，其余一律丢弃（返回 undefined）→ 渲染端把无 action 的按钮画成禁用态，
 * 杜绝"点了没反应"再次出现（诚实交互，抄 dsh-genui）。
 *   - connector: 走后端受控代理查真数据（密钥藏后端，见 connectors.mjs）
 *   - local:     纯前端交互（切 tab、排序等），不回后端
 */
function sanitizeAction(a) {
  if (!a || typeof a !== "object" || Array.isArray(a)) return undefined;
  const kind = String(a.kind || "").toLowerCase();
  if (kind === "connector") {
    const connectorId = typeof a.connectorId === "string" ? a.connectorId.slice(0, 120) : "";
    if (!connectorId) return undefined;
    const req = a.req && typeof a.req === "object" && !Array.isArray(a.req) ? a.req : {};
    const outReq = {};
    if (typeof req.method === "string") outReq.method = req.method.slice(0, 10).toUpperCase();
    if (typeof req.path === "string") outReq.path = req.path.slice(0, 500);
    if (req.query && typeof req.query === "object" && !Array.isArray(req.query)) {
      outReq.query = {};
      for (const k of Object.keys(req.query).slice(0, 20)) {
        outReq.query[String(k).slice(0, 60)] = String(req.query[k]).slice(0, 200);
      }
    }
    return { kind: "connector", connectorId, req: outReq };
  }
  if (kind === "local") {
    const op = typeof a.op === "string" ? a.op.slice(0, 40) : "";
    if (!op) return undefined;
    const out = { kind: "local", op };
    if (typeof a.target === "string") out.target = a.target.slice(0, 120);
    return out;
  }
  return undefined; // 未知 kind → 丢弃，前端渲染禁用态
}

/**
 * 收敛 `webview` 的地址 —— 这是"AI 造的应用里嵌一个真网页"唯一的入口，
 * 所以这一关决定了它能把用户送到哪里去。放行三种写法：
 *
 *  · `/` 开头的**站内路径**（例：`/eryuan/v1/site/zjxc/`）—— 同源，最常见的一种：
 *    AI 把自己做好的网页发布到我们的站点目录，再用一个应用把它摆出来。
 *  · `https://` 开头的**绝对网址** —— 外站，跨源，浏览器自己把它关在另一个源里。
 *  · `http://` 开头的**明文外站** —— 只能**新标签打开**，见下面那段。
 *
 * ── 关于 `http://`（2026-09-15 苏白定的两档）────────────────────────
 * 他的原话：「如果能在内部打开，就直接内部可以小范围先展开。然后如果在外部的话，
 * 也可以直接跳转到就是外部新的标签页打开，都是可以的。」
 *
 * 我们的站是 https，明文页嵌进来会被浏览器当混合内容拦掉 —— 所以它**不能内嵌**。
 * 但"不能内嵌"不等于"不能用"：新标签打开是完全正常的一档。
 * 早先这里直接拒收 http，理由是"会变成一块永远打不开的白板"——
 * 那个理由只在"一定要内嵌"的前提下成立。现在前端认得这一档（`canEmbed()`，
 * 见 runtime/WebView.tsx）：http 一律不画 iframe，画一张说清楚的卡 + 一个大按钮。
 * 白板的病因此在**前端**根治，入库这一关就不必再替它挡。
 *
 * 明确挡掉的两类，每一类都对着一个真问题：
 *  · `javascript:` / `data:` / `blob:` —— 这三个在 iframe 里等于在我们的页面上执行别人的代码。
 *  · `//host/path`（协议相对）—— 看着像路径，其实是换了一个站点。
 *    这是最容易被看漏的一种，所以单独判一次。
 *
 * 返回空字符串 ＝ 不合法，由调用方转成入库拒绝（不静默丢弃：静默的后果是
 * 用户拿到一个空应用却不知道为什么 —— 跟 TD-309 同一类病）。
 */
export function sanitizeWebUrl(raw) {
  if (typeof raw !== "string") return "";
  const url = raw.trim();
  if (!url || url.length > 2000) return "";
  if (url.startsWith("//")) return "";                  // 协议相对 ＝ 换站点，不是站内路径
  if (url.startsWith("/")) return url;                  // 站内路径
  if (/^https?:\/\/[^\s/?#]+/i.test(url)) return url;  // 外站：https 可内嵌，http 只能新标签
  return "";
}

/** 收敛一个数字，非数字给 fallback，用于 chart 数据点/stat 数值 */
function num(v, fallback = 0) {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * `script` 节点的代码上限——不是安全边界（安全靠沙盒隔离，见 BlueprintRenderer.tsx
 * 里的 ScriptSandbox），只是防止把一份小说塞进一条应用记录里。
 */
const SCRIPT_CODE_LIMIT = 20_000;

/**
 * 超长脚本用抛错传出去（`sanitizeBlueprint` 是递归的，没有别的错误通道），
 * 由 `normalizeForStore` 兜住转成 400。
 */
class BlueprintReject extends Error {}

/**
 * 把任意结构收敛成渲染器认识的样子。
 * 不认识的组件类型不是丢掉，而是降级成 text —— 丢掉会让用户看见"少了一块"，
 * 降级至少保住内容。
 */
export function sanitizeBlueprint(node, depth = 0) {
  if (depth > 12 || node == null) return null;
  if (typeof node === "string" || typeof node === "number") {
    return { type: "text", value: String(node) };
  }
  if (Array.isArray(node)) {
    return { type: "page", children: node.map((n) => sanitizeBlueprint(n, depth + 1)).filter(Boolean) };
  }
  if (typeof node !== "object") return null;

  const type = String(node.type || "").toLowerCase();
  const out = { type: VOCAB.includes(type) ? type : "text" };

  if (out.type === "text" && !VOCAB.includes(type)) {
    // 不认识 → 降级成文本，尽量保住它想表达的内容
    out.value = String(node.value ?? node.text ?? node.title ?? node.label ?? "");
    if (!out.value) return null;
    return out;
  }

  // `script` 单独一条分支——它没有 title/items/children 这些字段，只有一段代码。
  // 安全性完全不来自这里的校验（代码内容不做静态分析，那是骗自己），
  // 而来自渲染端把它丢进一个没有 allow-same-origin、CSP 锁死出站网络的沙盒 iframe
  // （见 BlueprintRenderer.tsx 的 ScriptSandbox）。这里只做"不是字符串/超长"这类结构性拦截。
  if (out.type === "script") {
    const code = typeof node.code === "string" ? node.code : "";
    // 🔴 09-04 改判：超长**拒绝**，不再截断。
    //    原来是 `code.slice(0, LIMIT)`，理由是"跟 title/label 一样裁一刀就好"。
    //    但那两个是文本，裁短了还是能读；**代码裁一刀就是语法坏掉的代码** ——
    //    存进去、发出去、在用户浏览器里炸，报错还指向别处，没人会想到是被裁了。
    //    这跟 TD-309（归一化白名单静默丢字段）是同一类病：出错不响。
    //    真实触发过：09-04 给 CSS 接正本，"总览"模块涨到 20053 字，
    //    只超 53 字，按老行为会被无声截断发出去。
    if (code.length > SCRIPT_CODE_LIMIT) {
      throw new BlueprintReject(
        `script 代码 ${code.length} 字，超过上限 ${SCRIPT_CODE_LIMIT} —— 拒绝入库（截断会产生语法损坏的代码）`);
    }
    if (!code.trim()) return null; // 空脚本没有意义，降级成不存在（不渲染一个空壳沙盒）
    out.code = code;
    if (typeof node.title === "string") out.title = node.title.slice(0, 80);
    return out;
  }

  // `webview` 单独一条分支 —— 它没有 children/items，只有一个地址。
  // 🔴 地址不合法时**拒绝入库**，不降级：一个打不开的网页应用，
  //    在界面上和"我们坏了"长得一模一样，用户没有任何线索知道是地址写错了。
  if (out.type === "webview") {
    const raw = node.url ?? node.src ?? node.href;
    const url = sanitizeWebUrl(raw);
    if (!url) {
      throw new BlueprintReject(
        `webview 的地址不合法：只收 http(s):// 开头的网址，或 / 开头的站内路径（收到：${String(raw ?? "").slice(0, 120)}）`);
    }
    out.url = url;
    if (typeof node.title === "string") out.title = node.title.slice(0, 80);
    // 地址栏下面那行小字：告诉用户这一屏是什么，比一条裸地址有用
    if (typeof node.note === "string") out.note = node.note.slice(0, 200);
    const h = Number(node.height);
    if (Number.isFinite(h) && h >= 200 && h <= 2000) out.height = Math.round(h);
    return out;
  }

  for (const k of ["value", "text", "title", "label"]) {
    if (typeof node[k] === "string") out[k] = node[k].slice(0, 2000);
  }
  if (typeof node.level === "number") out.level = Math.min(Math.max(node.level, 1), 4);
  if (Array.isArray(node.items)) out.items = node.items.slice(0, 200).map((i) => String(i).slice(0, 500));
  if (Array.isArray(node.columns)) out.columns = node.columns.slice(0, 20).map((c) => String(c).slice(0, 100));
  if (Array.isArray(node.rows)) {
    out.rows = node.rows.slice(0, 200).map((r) =>
      (Array.isArray(r) ? r : [r]).slice(0, 20).map((c) => String(c).slice(0, 300)));
  }
  if (Array.isArray(node.children)) {
    out.children = node.children.slice(0, 100)
      .map((c) => sanitizeBlueprint(c, depth + 1)).filter(Boolean);
  }

  // ── 09-03 GenUI 升级：交互/仪表盘组件的专属字段 ──
  // button 的 action：这是"修活按钮"的后端半边。无 action 的按钮不再被静默丢弃字段，
  // 而是渲染端画成禁用态（诚实交互）。
  if (out.type === "button") {
    const action = sanitizeAction(node.action);
    if (action) out.action = action;
  }

  // stat 指标卡：value 允许是数字（通用循环只留字符串），额外 delta/unit/tone。
  if (out.type === "stat") {
    if (out.value === undefined && (typeof node.value === "number")) out.value = String(node.value);
    if (typeof node.delta === "string") out.delta = node.delta.slice(0, 100);
    else if (typeof node.delta === "number") out.delta = String(node.delta);
    if (typeof node.unit === "string") out.unit = node.unit.slice(0, 40);
    const tone = String(node.tone || "").toLowerCase();
    if (["up", "down", "warn", "default"].includes(tone)) out.tone = tone;
  }

  // chart 图表：目前支持 bar / line。labels 是 x 轴，series 是多条数据线。
  if (out.type === "chart") {
    const ct = String(node.chartType || node.kind || "bar").toLowerCase();
    out.chartType = ["bar", "line"].includes(ct) ? ct : "bar";
    if (Array.isArray(node.labels)) {
      out.labels = node.labels.slice(0, 50).map((l) => String(l).slice(0, 60));
    }
    if (Array.isArray(node.series)) {
      out.series = node.series.slice(0, 10).map((s) => {
        const one = {};
        if (s && typeof s === "object" && !Array.isArray(s)) {
          if (typeof s.name === "string") one.name = s.name.slice(0, 60);
          one.data = Array.isArray(s.data) ? s.data.slice(0, 100).map((d) => num(d)) : [];
        } else if (Array.isArray(s)) {
          one.data = s.slice(0, 100).map((d) => num(d));
        } else {
          one.data = [];
        }
        return one;
      }).filter((s) => s.data.length > 0);
    }
  }

  // tabs 标签页：每个 tab 有 label + children（递归收敛），本地切换零往返。
  // 🔴 orientation 必须留下来：它决定渲染成顶部标签还是左侧栏工作台。
  //    白名单式归一化的通病是"多写的字段被静默丢掉"——丢了不报错，
  //    只是用户看到的从工作台退回一页平铺，最难查。所以这里显式放行，
  //    并且只认这两个值（别的值一律当 top，不让任意字符串穿到前端）。
  if (out.type === "tabs" && node.orientation === "side") out.orientation = "side";
  if (out.type === "tabs" && Array.isArray(node.tabs)) {
    out.tabs = node.tabs.slice(0, 12).map((t) => {
      if (!t || typeof t !== "object") return null;
      const tab = { label: typeof t.label === "string" ? t.label.slice(0, 60) : "标签" };
      if (Array.isArray(t.children)) {
        tab.children = t.children.slice(0, 50)
          .map((c) => sanitizeBlueprint(c, depth + 1)).filter(Boolean);
      } else {
        tab.children = [];
      }
      return tab;
    }).filter(Boolean);
  }

  // keyvalue 键值对：pairs = [{k, v}]，用于"字段:值"这类展示。
  if (out.type === "keyvalue" && Array.isArray(node.pairs)) {
    out.pairs = node.pairs.slice(0, 50).map((p) => {
      if (!p || typeof p !== "object") return null;
      return { k: String(p.k ?? p.key ?? "").slice(0, 120), v: String(p.v ?? p.value ?? "").slice(0, 300) };
    }).filter((p) => p && p.k);
  }

  return out;
}

/**
 * 入库前的最后一道门：收敛 + 断言"根节点是 page 且有内容"。
 * 两条入口都必须过这里，而不是各自判一遍 —— 判据也要只有一份。
 *
 * 返回 { ok:true, blueprint } 或 { ok:false, error }。不抛错（调用方都是 HTTP 处理器）。
 */
export function normalizeForStore(raw, opts = {}) {
  let clean;
  try {
    clean = sanitizeBlueprint(raw);
  } catch (e) {
    if (e instanceof BlueprintReject) return { ok: false, error: e.message };
    throw e;
  }
  if (!clean) return { ok: false, error: "blueprint 收敛后是空的" };
  let blueprint;
  if (clean.type !== "page") {
    // 不是 page 就包一层，而不是拒绝 —— AI 经常直接给一个 card 或一串节点
    blueprint = { type: "page", children: [clean] };
  } else {
    if (!Array.isArray(clean.children) || clean.children.length === 0) {
      return { ok: false, error: "blueprint 里没有任何内容" };
    }
    blueprint = clean;
  }

  // 🔴 设计闸（09-15 接上）。在这里、而不是在各个路由里 —— `normalizeForStore` 是
  //    应用入库的**唯一一道门**（用户面 POST/PUT、bot 面 /apps/for 都过它），
  //    判据挂在门上才不会有人从旁边绕过去。绕过去的代价见 design-gate.mjs 开头。
  //    `opts.prev` = 前一版蓝图：不传＝新建＝严格档；传了＝更新＝棘轮（只许变少）。
  const g = gateBlueprint(blueprint, opts.prev);
  if (!g.ok) return { ok: false, error: g.error };
  return { ok: true, blueprint, ratchet: g.ratchet };
}
