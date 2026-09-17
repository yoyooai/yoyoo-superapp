/**
 * 应用的「分区」—— 超级应用页上下两栏。
 *
 * 起因（2026-09-15 苏白，OCTO 群）：
 *   「超级应用这里……得在中际旭创里进行一个上下分割栏，上边我们会放一些人事 Agent、
 *     财务 Agent、经营看板啥的，下边放的是我们的 AI 设备 OS 那些东西，
 *     相当于一部分是组织改造，一部分是流程改造」
 *   随后定名（同日）：「组织改造改为 AI Native 组织建设，流程改造改为 AI Native 流程建设」。
 *
 * 为什么是**一列数据**而不是界面里按 id 硬编一张表：
 *   按 id 硬编等于"这个功能只对今天这几个应用成立"。以后 AI 自己造一个应用，
 *   它该落在哪一栏没人答得上来 —— 那才是真正的病根。
 *
 * 为什么是**固定两个键**而不是自由文本：
 *   自由文本会立刻长出「AI native 组织建设」「AI-Native组织建设」三个变体，
 *   界面上就是三栏。要加第三栏是一次明确的决定 —— 往这个表里加一行。
 *
 * 空字符串是合法值，意思是"没分区"。老应用全是这一档，界面上不画分栏标题，
 * 和这个功能上线之前一模一样。
 */

/** 顺序就是界面上从上到下的顺序。 */
export const APP_SECTIONS = [
  { key: "org", label: "AI Native 组织建设", hint: "把人的组织换成人 + AI 的组织：人事、财务、经营看板这类。" },
  { key: "flow", label: "AI Native 流程建设", hint: "把一条业务流程交给 AI 跑：设备 OS、工单、巡检这类。" },
];

const KEYS = new Set(APP_SECTIONS.map((s) => s.key));

/**
 * 规范化一个分区值。
 * @returns {{ok:true, section:string} | {ok:false, error:string}}
 * 传 `undefined` ＝ 这次请求没提分区（调用方应保持原值），由调用方区分；
 * 这里只负责把"给了值"的情况判明白。
 */
export function normalizeSection(raw) {
  const v = String(raw == null ? "" : raw).trim();
  if (!v) return { ok: true, section: "" };
  if (!KEYS.has(v)) {
    return { ok: false, error: `分区只能是 ${[...KEYS].join(" / ")}，或留空表示不分区；收到的是「${v}」` };
  }
  return { ok: true, section: v };
}
