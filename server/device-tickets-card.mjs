/**
 * 设备工单 → OCTO 卡片参数。②的地基：让工单不只是活在超级应用页面里，
 * 还能被推成一张能在 OCTO 群里流转、分享、被 @ 的真卡片（09-08，苏白拍板续做②）。
 *
 * 这里只产**参数**（喂给 octo-connector/src/card.mjs 的 `buildCard()`），
 * 不拼 AdaptiveCard 信封本身——信封形状、限额、`Action.Submit.id` 必填这些规矩
 * 只有 card.mjs 一处定义，这里再抄一遍就是"两份路由表"那个坑的卡片版。
 *
 * 按钮只登记"下一步"，不是任意跳转：跟 device-tickets.mjs 的 LANES 同一条流水线
 * （open→assigned→doing→review→done），唯一的例外是 review 可以"打回重修"退回 doing——
 * 这是09-08原话要的"待验收还能打回重修（不是单行道）"。
 */

/** 每个车道允许点出的下一步。`to` 就是 device-tickets `/transition` 要的目标车道。 */
const NEXT_ACTIONS = {
  open: [{ id: "to_assigned", title: "确认工单", to: "assigned", what: "OCTO卡片操作：确认工单并派工" }],
  assigned: [{ id: "to_doing", title: "开始维修", to: "doing", what: "OCTO卡片操作：开始维修" }],
  doing: [{ id: "to_review", title: "提交验收", to: "review", what: "OCTO卡片操作：提交验收" }],
  review: [
    { id: "to_done", title: "验收通过", to: "done", what: "OCTO卡片操作：验收通过，工单关闭" },
    { id: "to_doing", title: "打回重修", to: "doing", what: "OCTO卡片操作：验收不通过，打回重修" },
  ],
  done: [],
};

const LANE_LABEL = { open: "待确认", assigned: "已派工", doing: "维修中", review: "待验收", done: "已关闭" };
const LANE_TONE = { open: "attention", assigned: "warning", doing: "warning", review: "accent", done: "good" };
const PRIORITY_LABEL = { high: "高", mid: "中", low: "低" };

/**
 * ticket（device-tickets.mjs 的行形状）→ buildCard() 参数。
 * 纯函数：不碰网络、不碰 id 生成，方便钉着测。
 */
export function ticketCardParams(ticket) {
  const lane = ticket.lane;
  const history = Array.isArray(ticket.history) ? ticket.history : [];
  const recent = history.slice(-3);

  return {
    kicker: `设备工单 · ${ticket.device}`,
    icon: "wrench",
    badge: { text: LANE_LABEL[lane] || lane, tone: LANE_TONE[lane] || "default" },
    title: ticket.title,
    subtitle: `优先级：${PRIORITY_LABEL[ticket.priority] || ticket.priority}`,
    facts: [
      { title: "报修", value: ticket.reporter || "—" },
      { title: "处理人", value: ticket.assignee || "待指派" },
    ],
    lines: recent.map((h) => `${h.t} ${h.who}：${h.what}`),
    actions: (NEXT_ACTIONS[lane] || []).map((a) => ({
      id: a.id,
      title: a.title,
      // `instant` 是喊 octo-connector 走即时旁路的暗号（见其 config.mjs
      // parseInstantWebhooks 头注）——`to`/`what` 仍然带着，但服务端收到
      // card-action 时不会信这两个字段，只当备份/调试用，见 device-tickets.mjs。
      data: { instant: "device_tickets", ticket_id: ticket.id, to: a.to, what: a.what },
    })),
    footnote: lane === "done" ? "已关闭，不再接受操作" : "点了我立刻收到回调",
  };
}

/** 给 click 回调用：从 action_id 反查这条动作该往哪个车道走、留什么话。 */
export function actionById(lane, actionId) {
  return (NEXT_ACTIONS[lane] || []).find((a) => a.id === actionId) || null;
}

export default ticketCardParams;
