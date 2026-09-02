/**
 * 「移除这个 AI」弹层 —— AI 名片底部那一行点开的就是这个。
 *
 * 🔴 不许 import 任何 `@octo/*`（tests/no-host-leak.test.ts 守着）。
 *    宿主能力通过 props 里的两个回调传进来（由 host/ 适配层实现）。
 *
 * 起因：苏白 2026-09-02「我没看到在哪里删除啊」。查证结果是**两处都堵着**：
 * 人的名片那条「解除好友关系」对同空间用户故意不渲染（宿主防误删同事），
 * AI 名片则压根没做删除项。宿主的默认值针对"同空间＝同事"，我们的用法是
 * "AI 进进出出" —— 所以只给 AI 开这一支。
 *
 * 这一屏刻意的三件事：
 *  1. **把"删"拆成两档，且把后果写在选项里**，不写在事后的确认弹窗里。
 *     苏白问过"现在这个 AI 支持删除吗" —— 那时我得用三段话解释"删"有三种意思。
 *     一个界面如果需要旁边有人解释，那是界面的问题。
 *  2. **可恢复的那档是默认建议**（放上面、写明"可以再加回来"）；不可恢复那档
 *     要**打字确认**（输入它的名字），且按钮在名字对上之前是禁用的。
 *  3. **做不到的事如实说，并给能照着做的那条路**。
 *     实测（09-02）：OCTO 后端删号接口 `DELETE /v1/manager/robots/:id` 写好了但
 *     路由没注册，线上 404 —— 所以删号那一档在这个宿主上**不出现**（不是画个假按钮），
 *     改成一句话指向唯一走得通的 BotFather `/deletebot`。
 *     万一将来宿主挂上了那条路由，它还要求超级管理员 ⇒ 403 也单独说人话。
 *     一句都不许把失败说成成功。
 */
import React, { useState } from "react";
import { c } from "./styles";
import {
  availableChoices,
  BOTFATHER_NOTE,
  defaultChoice,
  explainRemoveError,
  isConfirmReady,
  type RemoveChoice,
} from "./removeAiPolicy";

/** 宿主传进来的被移除对象 */
export interface RemoveAITarget {
  uid: string;
  /** 显示名（备注优先），用于打字确认 */
  name: string;
  /** 是不是我的联系人 —— 决定"从通讯录移除"这一档要不要出现 */
  isFriend: boolean;
  /** 我是不是它的创建者 —— 决定"彻底删除"这一档要不要出现 */
  isOwner: boolean;
}

export interface RemoveAIDialogProps {
  target: RemoveAITarget;
  /** 只解除好友关系。宿主没这能力就不传 ⇒ 这一档不出现 */
  onRemoveFromContacts?: () => Promise<void>;
  /** 彻底删号。宿主没这能力就不传 ⇒ 这一档不出现 */
  onDeleteAccount?: () => Promise<void>;
  /** 关掉这个弹层 */
  onClose: () => void;
  /** 删成功之后通知宿主收尾（关掉那张名片）—— 关不关宿主的弹窗是宿主的事 */
  onDone?: () => void;
}

const option = (selected: boolean): React.CSSProperties => ({
  border: selected
    ? "1px solid var(--wk-brand-primary, #6C4AF7)"
    : "1px solid var(--wk-border-default, #e5e5ea)",
  borderRadius: 10,
  padding: "12px 14px",
  fontSize: 13,
  lineHeight: 1.7,
  cursor: "pointer",
  display: "flex",
  gap: 10,
  alignItems: "flex-start",
  textAlign: "left",
  background: "transparent",
  color: "inherit",
  width: "100%",
});

const RemoveAIDialog: React.FC<RemoveAIDialogProps> = ({
  target,
  onRemoveFromContacts,
  onDeleteAccount,
  onClose,
  onDone,
}) => {
  // 能选哪几档、默认停在哪、什么时候放行 —— 全部由 removeAiPolicy 决定（有测试守着）。
  const { canRemove, canDelete } = availableChoices({
    isFriend: target.isFriend,
    isOwner: target.isOwner,
    hasRemove: !!onRemoveFromContacts,
    hasDelete: !!onDeleteAccount,
  });
  const [choice, setChoice] = useState<RemoveChoice | null>(
    defaultChoice({ canRemove, canDelete })
  );
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = isConfirmReady(choice, typed, target.name);

  const run = async () => {
    if (!choice || !ready) return;
    setBusy(true);
    setError(null);
    try {
      if (choice === "contacts") await onRemoveFromContacts?.();
      else await onDeleteAccount?.();
      onDone?.();
      onClose();
    } catch (e) {
      // 🔴 失败时**不调 onDone / onClose** —— 名片留着、错误显示出来。
      //    把失败悄悄关掉等于告诉用户"删好了"。
      setError(explainRemoveError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={c.modalMask} onClick={onClose}>
      <div style={c.modal} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>
          移除「{target.name}」
        </h3>

        {error && <div style={{ ...c.err, whiteSpace: "pre-wrap" }}>{error}</div>}

        {!canRemove && !canDelete ? (
          /* 两档都不可用 —— 如实说为什么，并给唯一可用的那条路。
             🔴 逐条按**真实原因**写：不许笼统说"你不是创建者"，
             因为最常见的情形恰恰是"你是创建者，但这台机器上删号的接口没挂"。 */
          <>
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.9 }}>
              这个 AI 现在没有可以由你执行的移除操作：
              {!target.isFriend && (
                <>
                  <br />· 它<b>不在你的通讯录里</b>，没有好友关系可以解除；
                </>
              )}
              {target.isFriend && !onRemoveFromContacts && (
                <>
                  <br />· 这个界面拿不到"解除好友关系"的能力（宿主没提供）；
                </>
              )}
              {!target.isOwner && (
                <>
                  <br />· 你<b>不是它的创建者</b>，所以不能删它的号。
                </>
              )}
              {target.isOwner && !onDeleteAccount && (
                <>
                  <br />· 你是它的创建者，但<b>这台机器上没有删号这条路</b>：
                  后端那个接口写好了却没挂上（实测 404）。
                </>
              )}
            </p>
            <div style={c.warnBox}>{BOTFATHER_NOTE}</div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button style={c.ghost} onClick={onClose}>
                知道了
              </button>
            </div>
          </>
        ) : (
          <>
            <p style={{ margin: 0, fontSize: 13, opacity: 0.7, lineHeight: 1.8 }}>
              「移除」有两种，后果不一样，选一个：
            </p>

            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {canRemove && (
                <button
                  type="button"
                  style={option(choice === "contacts")}
                  onClick={() => setChoice("contacts")}
                >
                  <input
                    type="radio"
                    checked={choice === "contacts"}
                    readOnly
                    style={{ marginTop: 4 }}
                  />
                  <span>
                    <b>从通讯录移除</b>
                    <span style={{ display: "block", opacity: 0.6, fontSize: 12 }}>
                      只解除好友关系。它的号还在，聊天记录也留着。
                      之后可以在「全部联系人 → 只看 AI」里重新添加它。
                      <br />
                      ⚠️ 它和你在同一个空间，所以移除之后它<b>仍然可以给你发消息</b> ——
                      这不是"清退"，是"从名单里划掉"。
                    </span>
                  </span>
                </button>
              )}

              {canDelete && (
                <button
                  type="button"
                  style={option(choice === "account")}
                  onClick={() => setChoice("account")}
                >
                  <input
                    type="radio"
                    checked={choice === "account"}
                    readOnly
                    style={{ marginTop: 4 }}
                  />
                  <span>
                    <b>彻底删除这个 AI</b>
                    <span style={{ display: "block", opacity: 0.6, fontSize: 12 }}>
                      把它的号一起删掉：连接当场断开，它的凭据立刻失效，
                      <b>不可恢复</b>。别人也不会再看到这个 AI。
                    </span>
                  </span>
                </button>
              )}
            </div>

            {/* 我是创建者、却没有删号那一档 ⇒ 告诉他删号在哪儿。
                不说的话他会以为"这产品不能删 AI"，而实际是入口在另一个地方。 */}
            {target.isOwner && !canDelete && (
              <div style={{ fontSize: 12, opacity: 0.6, lineHeight: 1.8 }}>
                {BOTFATHER_NOTE}
              </div>
            )}

            {choice === "account" && (
              <>
                <div style={c.warnBox}>
                  这一步<b>不可撤销</b>。确认请把它的名字原样输一遍：
                  <b>{target.name}</b>
                </div>
                <input
                  style={{ ...c.input, flex: "none" }}
                  placeholder="输入上面那个名字"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                />
              </>
            )}

            <div
              style={{
                display: "flex",
                gap: 8,
                justifyContent: "flex-end",
                marginTop: 4,
              }}
            >
              <button style={c.ghost} onClick={onClose}>
                取消
              </button>
              <button
                style={{ ...c.btn, opacity: ready && !busy ? 1 : 0.5 }}
                disabled={!ready || busy}
                onClick={() => void run()}
              >
                {busy
                  ? "处理中…"
                  : choice === "account"
                    ? "彻底删除"
                    : "从通讯录移除"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default RemoveAIDialog;
