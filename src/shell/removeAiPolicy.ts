/**
 * 「移除 AI」的判断规则 —— 从弹层里拆出来的**纯函数**。
 *
 * 为什么拆：这几条是产品承诺，不是渲染细节 ——
 *  · 不可恢复那档必须**打字确认**才放行
 *  · 没权限（403）必须**如实说**，不许算成功
 *  · 宿主没有某种能力时，那一档**不出现**（而不是点了报错）
 * 它们必须被会报红的测试守着（150 分线第三条）。而这个包没装 jsdom，
 * 所以把判断挪到纯函数层，是"能被真正测到"的唯一干净做法。
 *
 * 🔴 不许 import 任何 `@octo/*`（tests/no-host-leak.test.ts 守着）。
 */

export type RemoveChoice = "contacts" | "account";

export interface RemoveAICapability {
  /** 它在我的通讯录里吗 */
  isFriend: boolean;
  /** 我是它的创建者吗 */
  isOwner: boolean;
  /** 宿主实现了"解除好友关系"吗 */
  hasRemove: boolean;
  /** 宿主实现了"删号"吗 */
  hasDelete: boolean;
}

export interface RemoveChoices {
  canRemove: boolean;
  canDelete: boolean;
}

/**
 * 哪几档可选。
 *
 * 两个条件都要满足：**我有资格**（好友／创建者）且**宿主做得到**。
 * 少了后半条就会画出一个点下去必然报错的按钮 —— 那比没有按钮更糟。
 */
export function availableChoices(cap: RemoveAICapability): RemoveChoices {
  return {
    canRemove: cap.isFriend && cap.hasRemove,
    canDelete: cap.isOwner && cap.hasDelete,
  };
}

/**
 * 默认停在哪一档。
 *
 * 🔴 **可恢复的那档优先**。默认值就是产品建议 ——
 *    把光标默认落在"不可恢复"上，等于把误操作的成本转嫁给用户。
 */
export function defaultChoice(choices: RemoveChoices): RemoveChoice | null {
  if (choices.canRemove) return "contacts";
  if (choices.canDelete) return "account";
  return null;
}

/**
 * 现在能不能点那个执行按钮。
 *
 * · 从通讯录移除：可恢复，选中即可
 * · 彻底删号：**必须把名字原样输一遍**，且名字本身不能为空
 *   （空名字若算通过，一个没设名字的 AI 就变成"点两下就删掉"）
 */
export function isConfirmReady(
  choice: RemoveChoice | null,
  typedName: string,
  targetName: string
): boolean {
  if (choice === "contacts") return true;
  if (choice !== "account") return false;
  const target = targetName.trim();
  if (target === "") return false;
  return typedName.trim() === target;
}

/**
 * 删号这件事在 OCTO 上唯一走得通的路。
 *
 * 2026-09-02 实测：后端 `DELETE /v1/manager/robots/:id` 写好了但**路由没注册**
 * （`modules/robot/1module.go` 只挂了业务路由），线上返回 404 而不是 401。
 * 所以界面上不给删号按钮 —— 给一句能照着做的话。
 */
export const BOTFATHER_NOTE =
  "要彻底删掉一个 AI 的号，目前只有一条路：在 BotFather 那个会话里发 /deletebot，" +
  "按它的提示选择要删哪个。（通讯录顶上那条横幅已经换成「邀请 AI」，" +
  "所以 BotFather 要从聊天列表里找，或在通讯录搜 botfather。）";

/** 权限不够时给的那条唯一可用的替代路径（后端删号要超级管理员） */
export const FORBIDDEN_HINT =
  "你没有删号的权限（后端要求超级管理员）。这个 AI 的号还在。\n" +
  "想删掉自己创建的 AI，可以去 BotFather 那个会话里发 /deletebot。";

/**
 * 把宿主/后端的报错捞成一句人话。
 *
 * 403 单独认：它不是"坏了"，是"你没权限" —— 说成"删除失败"会让人重试到放弃。
 * 兼容两种形状：宿主 apiClient 拦截器加工过的 `{status, msg}`，和裸 axios 错误
 * `{response:{status}, message}`。
 */
export function explainRemoveError(e: unknown): string {
  const err = e as {
    status?: number;
    response?: { status?: number };
    msg?: string;
    message?: string;
  };
  const status = err?.status ?? err?.response?.status;
  if (status === 403) return FORBIDDEN_HINT;
  return err?.msg || err?.message || String(e);
}
