/**
 * 发布到市场的弹层。
 *
 * 🔴 不许 import 任何 `@octo/*`（tests/no-host-leak.test.ts 守着）。
 *
 * 这一屏承担的是 SPEC-market §5.2 那条我最担心的事：
 * **发布是从私有变公开的不可逆动作。**
 * 所以扫描命中时这里不自动改、也不自动发 —— 把命中了什么原样摆出来，
 * 让作者看着它做决定。两个按钮的措辞也刻意不对称：
 * 「回去改」是主按钮，「仍然发布」是次要的。
 */
import React, { useState } from "react";
import { SensitiveContentError, type SensitiveHit, type SuperAppApi } from "../api/client";
import { c } from "./styles";

export interface PublishDialogProps {
  api: SuperAppApi;
  appId: string;
  appName: string;
  /**
   * 传了就是**发新版**（在「我的发布」里点的），不传就是第一次上架。
   * 两种情况共用这一个弹层，是因为那道私货门对两条路径**必须一模一样** ——
   * 拆成两个弹层，迟早有一个会漏掉确认那一步。
   */
  listingId?: string;
  onClose: () => void;
  onPublished: () => void;
}

const PublishDialog: React.FC<PublishDialogProps> = ({
  api, appId, appName, listingId, onClose, onPublished,
}) => {
  const isVersion = !!listingId;
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hits, setHits] = useState<SensitiveHit[] | null>(null);

  const submit = async (confirmSensitive: boolean) => {
    const s = summary.trim();
    // 第一次上架必须有简介（别人靠它决定装不装）；发新版的更新说明可以不写
    if (!isVersion && !s) { setError("写一句简介吧，别人靠它决定装不装。"); return; }
    setBusy(true);
    setError(null);
    try {
      if (listingId) {
        await api.publishVersion(listingId, { confirmSensitive, note: s || undefined });
      } else {
        await api.publish(appId, s, { confirmSensitive });
      }
      onPublished();
      onClose();
    } catch (e) {
      if (e instanceof SensitiveContentError) {
        setHits(e.detail.hits);
      } else {
        setError(`发布失败：${e instanceof Error ? e.message : String(e)}`);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={c.modalMask} onClick={onClose}>
      <div style={c.modal} onClick={(e) => e.stopPropagation()}>
        <strong style={{ fontSize: 17 }}>
          {isVersion ? `给「${appName}」发一个新版本` : `把「${appName}」发布到市场`}
        </strong>

        {hits ? (
          <>
            <div style={c.warnBox}>
              <strong>先等一下 —— 这里面像是有不该公开的内容：</strong>
              <ul style={{ margin: "8px 0 0", paddingLeft: 20 }}>
                {hits.map((h) => (
                  <li key={h.id}>
                    {h.label}（{h.count} 处）：<code>{h.samples.join("、")}</code>
                  </li>
                ))}
              </ul>
              <div style={{ marginTop: 8, opacity: 0.75 }}>
                发布之后这个空间里的人都能装走一份。已经打了码，我们没有改动你的内容。
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button style={c.btn} onClick={onClose}>回去改</button>
              <button style={c.ghost} disabled={busy} onClick={() => void submit(true)}>
                {busy ? "发布中…" : "我确认，仍然发布"}
              </button>
            </div>
          </>
        ) : (
          <>
            <p style={{ margin: 0, fontSize: 13, opacity: 0.7, lineHeight: 1.8 }}>
              {isVersion ? (
                <>
                  会把你<strong>现在这一版</strong>照一张新快照发出去。装过的人只会看到「有新版」，
                  <strong>点了才更新</strong>，更新前自动备份、可一键回退 —— 你改不动他们那份。
                </>
              ) : (
                <>
                  发布的是<strong>这一版的快照</strong>。你之后接着改自己的应用不会影响已经装走的人；
                  想让他们拿到新的，回来发一个新版本。
                </>
              )}
            </p>
            <input
              style={c.input}
              value={summary}
              maxLength={140}
              placeholder={isVersion ? "这一版改了什么（可不填）" : "一句话说清它能干什么（最多 140 字）"}
              onChange={(e) => setSummary(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void submit(false); }}
              disabled={busy}
            />
            {error ? <div style={c.err}>{error}</div> : null}
            <div style={{ display: "flex", gap: 8 }}>
              <button
                style={c.btn}
                disabled={busy || (!isVersion && !summary.trim())}
                onClick={() => void submit(false)}
              >
                {busy ? "发布中…" : isVersion ? "发布新版本" : "发布"}
              </button>
              <button style={c.ghost} onClick={onClose}>取消</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default PublishDialog;
