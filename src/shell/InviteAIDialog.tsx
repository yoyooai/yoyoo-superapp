/**
 * 「邀请 AI」弹层 —— 通讯录顶上那个入口点开的就是这个。
 *
 * 🔴 不许 import 任何 `@octo/*`（tests/no-host-leak.test.ts 守着）。
 *    所以这里不是 import 宿主的弹窗组件，而是**跟着宿主的设计变量走**
 *    （`var(--wk-*)`，见 styles.ts）—— 长相和它自家的弹窗一致，代码不耦合。
 *    苏白 2026-09-02 要求"直接用他们现有的弹窗"，这是在"不撕掉换壳铁线"
 *    的前提下唯一正确的落法。
 *
 * 这一屏刻意的两件事：
 *  1. **默认不需要审批**（苏白定的）。开关摆在生成按钮旁边，不藏进二级菜单 ——
 *     它决定的是"对方能不能不经你同意就进来"，这种开关必须看得见。
 *  2. **票号只显示一次**，且**只提供"复制整段邀请函"**，不单独给票号的复制按钮。
 *     单独复制票号会让人把裸凭据贴进聊天；整段邀请函里写着"不要贴进聊天记录"。
 */
import React, { useCallback, useEffect, useState } from "react";
import { InviteApi, type InviteRow, type IssuedInvite } from "../api/invite";
import { c, fmtTime } from "./styles";

export interface InviteAIDialogProps {
  api: InviteApi;
  /** 邀请人显示名，写进邀请函开头（"你被邀请加入 XX 的工作空间"） */
  inviterName?: string;
  onClose: () => void;
}

const box: React.CSSProperties = {
  border: "1px solid var(--wk-border-default, #e5e5ea)",
  borderRadius: 10,
  padding: 12,
  fontSize: 13,
  lineHeight: 1.7,
};

const InviteAIDialog: React.FC<InviteAIDialogProps> = ({ api, inviterName, onClose }) => {
  const [requireApproval, setRequireApproval] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<IssuedInvite | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState<InviteRow[]>([]);

  const refresh = useCallback(async () => {
    try {
      const { invites } = await api.list();
      setPending(invites.filter((i) => i.status === "pending"));
    } catch {
      // 待确认列表拉不到不该挡住"发邀请"这件事 —— 静默，主流程照走。
    }
  }, [api]);

  useEffect(() => { void refresh(); }, [refresh]);

  const issue = async () => {
    setBusy(true);
    setError(null);
    try {
      setIssued(await api.issue({
        requireApproval,
        inviterName,
        note: note.trim() || undefined,
        // 同一个输入框既是临时名也是备注：苏白填「小A」时想的就是"给它起个名字"，
        // 把它当备注收着、再另挂一个占位名，就是又骗他一次。
        placeholderName: note.trim() || undefined,
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const copyLetter = async () => {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.letter);
      setCopied(true);
    } catch {
      setError("复制失败，请手动选中下面那段文字复制。");
    }
  };

  const decide = async (row: InviteRow, ok: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (ok) await api.approve(row);
      else await api.reject(row.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={c.modalMask} onClick={onClose}>
      <div style={c.modal} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>邀请 AI</h3>

        {error && <div style={c.err}>{error}</div>}

        {/* ── 待确认（只有开过审批才会有）───────────────────── */}
        {pending.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontSize: 13, opacity: 0.6 }}>待你确认（{pending.length}）</div>
            {pending.map((row) => (
              <div key={row.id} style={box}>
                <div style={{ fontWeight: 600 }}>{row.claim_name || "（没自报名字）"}</div>
                <div style={{ opacity: 0.7 }}>
                  {row.claim_owner ? `负责人：${row.claim_owner}` : "没说谁负责"}
                  {row.claim_desc ? ` · ${row.claim_desc}` : ""}
                </div>
                <div style={{ opacity: 0.45, fontSize: 12 }}>
                  {row.redeemed_at ? `${fmtTime(row.redeemed_at)} 申请进来` : ""}
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                  <button style={c.btn} disabled={busy} onClick={() => void decide(row, true)}>
                    同意
                  </button>
                  <button style={c.ghost} disabled={busy} onClick={() => void decide(row, false)}>
                    拒绝
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── 出票 / 出票结果 ───────────────────────────────── */}
        {!issued ? (
          <>
            {/*
              🔴 2026-09-02 苏白第一次用就被这里骗了（"我没看到哪里有待接受"）：
                 原文案写的是「不会先占用名字，也不会先出现在通讯录里」——
                 那**只在勾了审批时**才成立。默认（不勾）是出票那一刻就在宿主里建号并互为好友，
                 号立刻进通讯录、立刻占用一个占位名。于是同一个弹层里两句话互相打脸：
                 上面说"不会先进通讯录"，下面勾选框说"不勾：对方拿票即进通讯录"。
                 ⇒ 文案必须跟着 requireApproval 走。别再写成一句放之四海的承诺。
            */}
            <p style={{ margin: 0, fontSize: 13, opacity: 0.7, lineHeight: 1.8 }}>
              生成一段邀请函，发给你想请进来的 AI。
              {requireApproval ? (
                <>
                  它自己进来并自报身份 ——
                  <b>你点头之前，它不会占用名字，也不会出现在通讯录里</b>。
                </>
              ) : (
                <>
                  <b>号会在你点「生成邀请」的这一刻就建好</b> —— 它立刻出现在通讯录里，
                  先用你填的临时名；等它自己进来自报身份后，
                  <b>名字会自动换成它报的那个</b>，你不用管。
                  <span style={{ display: "block", marginTop: 4 }}>
                    想要"先申请、你点头才进来"，勾上下面那个框。
                  </span>
                </>
              )}
            </p>

            {/*
              🔴 这个框曾经叫「备注（给自己看的）」，但它长在"起名字"该在的位置上 ——
                 苏白 2026-09-02 往里填了「小A」，以为是给它起名字，结果那个名字
                 一个字都没用上，号顶着「受邀 AI · 待接受」进了通讯录。
                 与其解释"这不是名字框"，不如让它真的是。现在它就是临时名。
            */}
            <input
              style={{ ...c.input, flex: "none" }}
              placeholder={
                requireApproval
                  ? "备注（给自己看的，比如「邀请小X」）"
                  : "先给它起个临时名字（可留空，它进来后会自己改）"
              }
              value={note}
              maxLength={60}
              onChange={(e) => setNote(e.target.value)}
            />

            <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={requireApproval}
                onChange={(e) => setRequireApproval(e.target.checked)}
                style={{ marginTop: 3 }}
              />
              <span>
                需要我审批
                <span style={{ display: "block", opacity: 0.55, fontSize: 12, lineHeight: 1.7 }}>
                  {/*
                    🔴 这句话的历史：初版写「它自报后再改」是假的（那一环没实现），
                       改成「要改得你手动改」是当时的实话。**现在它真的会自动改了** ——
                       前端在你打开界面时用你的登录态改（api/invite.ts `reconcileNames`）。
                       改这句前先确认那个回填器还在跑，别让文案又一次跑到实现前面。
                  */}
                  {requireApproval
                    ? "对方拿票进来后先排队，你点头才成为联系人。名字用它自报的那个，一次就对。"
                    : "不勾：对方拿票即进通讯录，并会主动发一句话自报身份。名字先用你填的临时名，"
                      + "它自报之后自动换成它自己的名字。"}
                </span>
              </span>
            </label>

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
              <button style={c.ghost} onClick={onClose}>取消</button>
              <button style={c.btn} disabled={busy} onClick={() => void issue()}>
                {busy ? "生成中…" : "生成邀请"}
              </button>
            </div>
          </>
        ) : (
          <>
            <div style={c.warnBox}>
              这段话<b>只显示这一次</b>，关掉就看不到了 —— 现在复制走。
              里面那个票号只能用一次，{fmtTime(issued.expires_at)} 前有效。
              <br />
              里面<b>没有</b>凭据，可以直接私发给对方；但<b>不要</b>贴到公开群。
            </div>

            <textarea
              readOnly
              value={issued.letter}
              style={{
                ...c.input,
                flex: "none",
                minHeight: 220,
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: 12,
                lineHeight: 1.6,
                whiteSpace: "pre",
                overflowX: "auto",
              }}
              onFocus={(e) => e.currentTarget.select()}
            />

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button style={c.ghost} onClick={onClose}>完成</button>
              <button style={c.btn} onClick={() => void copyLetter()}>
                {copied ? "已复制 ✓" : "复制整段邀请函"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default InviteAIDialog;
