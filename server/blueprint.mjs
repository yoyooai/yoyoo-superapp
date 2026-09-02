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

/** 渲染器当前支持的组件词汇 —— 这份清单同时用于约束模型和校验产物 */
export const VOCAB = [
  "page", "card", "section", "heading", "text", "badge",
  "divider", "list", "table", "button", "script",
];

/**
 * `script` 节点的代码上限——不是安全边界（安全靠沙盒隔离，见 BlueprintRenderer.tsx
 * 里的 ScriptSandbox），只是防止把一份小说塞进一条应用记录里。
 */
const SCRIPT_CODE_LIMIT = 20_000;

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
    const code = typeof node.code === "string" ? node.code.slice(0, SCRIPT_CODE_LIMIT) : "";
    if (!code.trim()) return null; // 空脚本没有意义，降级成不存在（不渲染一个空壳沙盒）
    out.code = code;
    if (typeof node.title === "string") out.title = node.title.slice(0, 80);
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
  return out;
}

/**
 * 入库前的最后一道门：收敛 + 断言"根节点是 page 且有内容"。
 * 两条入口都必须过这里，而不是各自判一遍 —— 判据也要只有一份。
 *
 * 返回 { ok:true, blueprint } 或 { ok:false, error }。不抛错（调用方都是 HTTP 处理器）。
 */
export function normalizeForStore(raw) {
  const clean = sanitizeBlueprint(raw);
  if (!clean) return { ok: false, error: "blueprint 收敛后是空的" };
  if (clean.type !== "page") {
    // 不是 page 就包一层，而不是拒绝 —— AI 经常直接给一个 card 或一串节点
    return { ok: true, blueprint: { type: "page", children: [clean] } };
  }
  if (!Array.isArray(clean.children) || clean.children.length === 0) {
    return { ok: false, error: "blueprint 里没有任何内容" };
  }
  return { ok: true, blueprint: clean };
}
