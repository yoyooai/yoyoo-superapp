/**
 * 卡片入库前的校验 —— 跟 blueprint.mjs 同一个地位："两个入口共用的唯一一份"。
 *
 * 卡片有两种合法形状（照抄 octo-connector/src/card.mjs 的规则，那边是发送时的判据，
 * 这边是入库/上架时的判据，**不允许出现第二套限额数字**——都从同一份 LIMITS 抄来）：
 *   ①「裸卡片」：`{type:"AdaptiveCard", version, body:[...], actions:[...]}`
 *   ②「模板引用」：`{template_ref:"..."}`
 * 两者互斥——同时出现直接拒绝（宿主的规则，我们照抄）。
 *
 * 这里不追求覆盖 AdaptiveCard 全部校验逻辑（那是发送时宿主自己会做的事），
 * 只挡两类东西：结构性垃圾（不是对象/超限额）、以及"两种形状同时给"这种连宿主
 * 都会拒的错误，让作者在存进库那一刻就发现，而不是等真正发送时才报错。
 */

// 与 octo-connector/src/card.mjs 的 LIMITS 保持同一份数字（那边写的是宿主实测值）。
export const CARD_LIMITS = {
  payloadBytes: 512 * 1024,
  nodes: 200,
  depth: 16,
};

function countNodesAndDepth(card) {
  let nodes = 0;
  let maxDepth = 0;
  let failure = null;

  const walkAction = (a) => {
    if (failure) return;
    nodes++;
    if (a && Array.isArray(a.actions)) a.actions.forEach(walkAction);
  };
  const walk = (items, depth) => {
    if (failure) return;
    maxDepth = Math.max(maxDepth, depth);
    if (depth > CARD_LIMITS.depth) { failure = `卡片嵌套超过 ${CARD_LIMITS.depth} 层`; return; }
    if (!Array.isArray(items)) { failure = "body/items 必须是数组"; return; }
    for (const el of items) {
      if (failure) return;
      nodes++;
      if (el && Array.isArray(el.items)) walk(el.items, depth + 1);
      if (el && Array.isArray(el.columns)) {
        for (const col of el.columns) {
          if (col && Array.isArray(col.items)) walk(col.items, depth + 1);
        }
      }
      if (el && Array.isArray(el.actions)) el.actions.forEach(walkAction);
    }
  };

  if (card.body !== undefined) walk(card.body, 1);
  if (!failure && card.actions !== undefined) {
    if (!Array.isArray(card.actions)) failure = "card.actions 必须是数组";
    else card.actions.forEach(walkAction);
  }
  if (failure) return { ok: false, error: failure };
  if (nodes > CARD_LIMITS.nodes) {
    return { ok: false, error: `卡片节点 ${nodes} 个，超过上限 ${CARD_LIMITS.nodes}` };
  }
  return { ok: true, nodes };
}

/**
 * 入库前的最后一道门。返回 { ok:true, card } 或 { ok:false, error }。不抛错。
 */
export function normalizeCardForStore(raw) {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "card 必须是一个 JSON 对象" };
  }
  const bytes = Buffer.byteLength(JSON.stringify(raw), "utf8");
  if (bytes > CARD_LIMITS.payloadBytes) {
    return { ok: false, error: `卡片体积 ${bytes} 字节，超过上限 ${CARD_LIMITS.payloadBytes}` };
  }

  const hasType = raw.type !== undefined;
  const hasTemplateRef = raw.template_ref !== undefined;
  if (hasType && hasTemplateRef) {
    return { ok: false, error: "raw 卡片不能同时带 template_ref（两者互斥）" };
  }
  if (!hasType && !hasTemplateRef) {
    return { ok: false, error: "card 必须有 type（裸卡片）或 template_ref（模板引用）之一" };
  }

  if (hasTemplateRef) {
    if (typeof raw.template_ref !== "string" || !raw.template_ref.trim()) {
      return { ok: false, error: "template_ref 必须是非空字符串" };
    }
    return { ok: true, card: raw };
  }

  if (raw.type !== "AdaptiveCard") {
    return { ok: false, error: `card.type 只能是 AdaptiveCard，当前=${raw.type}` };
  }
  const shape = countNodesAndDepth(raw);
  if (!shape.ok) return shape;
  return { ok: true, card: raw };
}
