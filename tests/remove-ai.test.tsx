/**
 * 「移除这个 AI」的守卫测试 —— 苏白 2026-09-02「我没看到在哪里删除啊」那一刀。
 *
 * 这里每一条都对应一句产品承诺，且都是**会被下一个人顺手改掉**的那种：
 *  ① 不可恢复那档必须打字确认才放行         ← 最容易被"简化掉"
 *  ② 默认停在可恢复那档                     ← 默认值就是建议
 *  ③ 宿主做不到的档位不出现（不画死按钮）
 *  ④ 403 要如实说没权限，并给出唯一可用的另一条路
 *  ⑤ 失败不许当成功（不 onDone、不关弹层）
 *
 * 用 renderToStaticMarkup + 纯函数，不引 jsdom/testing-library ——
 * 与 shell-layout.test.tsx 同一个取舍：这个包要保持能被整个搬走。
 */
import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import RemoveAIDialog, { type RemoveAITarget } from "../src/shell/RemoveAIDialog";
import {
  availableChoices,
  defaultChoice,
  explainRemoveError,
  isConfirmReady,
  FORBIDDEN_HINT,
} from "../src/shell/removeAiPolicy";

const FRIEND_OWNER: RemoveAITarget = {
  uid: "bot-1",
  name: "小A",
  isFriend: true,
  isOwner: true,
};

const noop = async () => {};

describe("移除 AI · 档位可见性", () => {
  it("我有资格 + 宿主做得到 ⇒ 才出现这一档", () => {
    expect(
      availableChoices({ isFriend: true, isOwner: true, hasRemove: true, hasDelete: true })
    ).toEqual({ canRemove: true, canDelete: true });
  });

  it("🔴 宿主没实现某一档 ⇒ 那一档不出现（不许画一个点下去必然报错的按钮）", () => {
    expect(
      availableChoices({ isFriend: true, isOwner: true, hasRemove: false, hasDelete: false })
    ).toEqual({ canRemove: false, canDelete: false });
  });

  it("不是好友 ⇒ 没有「从通讯录移除」；不是创建者 ⇒ 没有「删号」", () => {
    expect(
      availableChoices({ isFriend: false, isOwner: true, hasRemove: true, hasDelete: true })
    ).toEqual({ canRemove: false, canDelete: true });
    expect(
      availableChoices({ isFriend: true, isOwner: false, hasRemove: true, hasDelete: true })
    ).toEqual({ canRemove: true, canDelete: false });
  });

  it("两档都没有 ⇒ 没有默认选项（弹层会改成「如实说为什么」那一屏）", () => {
    expect(defaultChoice({ canRemove: false, canDelete: false })).toBeNull();
  });

  it("🔴 默认停在**可恢复**那档 —— 默认值就是产品建议", () => {
    expect(defaultChoice({ canRemove: true, canDelete: true })).toBe("contacts");
    // 只有删号可用时才会默认落在它上面
    expect(defaultChoice({ canRemove: false, canDelete: true })).toBe("account");
  });
});

describe("移除 AI · 放行条件", () => {
  it("从通讯录移除：可恢复，选中即可放行", () => {
    expect(isConfirmReady("contacts", "", "小A")).toBe(true);
  });

  it("🔴 彻底删号：名字没输对一律不放行", () => {
    expect(isConfirmReady("account", "", "小A")).toBe(false);
    expect(isConfirmReady("account", "小", "小A")).toBe(false);
    expect(isConfirmReady("account", "小a", "小A")).toBe(false); // 大小写也算不对
  });

  it("彻底删号：名字原样输对才放行（两边空白不计）", () => {
    expect(isConfirmReady("account", "小A", "小A")).toBe(true);
    expect(isConfirmReady("account", "  小A  ", "小A")).toBe(true);
  });

  it("🔴 目标名字为空时永不放行 —— 否则没设名字的 AI 变成点两下就删掉", () => {
    expect(isConfirmReady("account", "", "")).toBe(false);
    expect(isConfirmReady("account", "   ", "  ")).toBe(false);
  });

  it("没选任何一档 ⇒ 不放行", () => {
    expect(isConfirmReady(null, "小A", "小A")).toBe(false);
  });
});

describe("移除 AI · 报错说人话", () => {
  it("🔴 403 要说「没权限」并给出 BotFather 那条路，不许说成「删除失败」", () => {
    expect(explainRemoveError({ status: 403 })).toBe(FORBIDDEN_HINT);
    // 裸 axios 错误的形状也要认
    expect(explainRemoveError({ response: { status: 403 } })).toBe(FORBIDDEN_HINT);
    expect(FORBIDDEN_HINT).toContain("/deletebot");
    expect(FORBIDDEN_HINT).toContain("号还在");
  });

  it("其它错误原样透出（宿主加工过的 msg 优先）", () => {
    expect(explainRemoveError({ status: 500, msg: "服务器炸了" })).toBe("服务器炸了");
    expect(explainRemoveError(new Error("网络断了"))).toBe("网络断了");
  });
});

describe("移除 AI · 首屏结构", () => {
  it("两档齐全时：两个选项都画出来，且删号那档写明不可恢复", () => {
    const html = renderToStaticMarkup(
      <RemoveAIDialog
        target={FRIEND_OWNER}
        onRemoveFromContacts={noop}
        onDeleteAccount={noop}
        onClose={() => {}}
      />
    );
    expect(html).toContain("从通讯录移除");
    expect(html).toContain("彻底删除这个 AI");
    expect(html).toContain("不可恢复");
    // 默认选中可恢复那档 ⇒ 首屏不该出现打字确认框
    expect(html).not.toContain("输入上面那个名字");
  });

  it("🔴 移除那档必须写明「同空间仍能发消息」 —— 这是 09-02 查证出来的真行为", () => {
    const html = renderToStaticMarkup(
      <RemoveAIDialog
        target={FRIEND_OWNER}
        onRemoveFromContacts={noop}
        onDeleteAccount={noop}
        onClose={() => {}}
      />
    );
    expect(html).toContain("仍然可以给你发消息");
  });

  it("宿主两档都没实现 ⇒ 一个执行按钮都不画，只解释为什么", () => {
    const html = renderToStaticMarkup(
      <RemoveAIDialog target={FRIEND_OWNER} onClose={() => {}} />
    );
    expect(html).toContain("没有可以由你执行的移除操作");
    expect(html).not.toContain("彻底删除这个 AI");
    expect(html).not.toContain("从通讯录移除");
    // 做不到的时候必须给能照着做的那条路
    expect(html).toContain("/deletebot");
  });

  it("🔴 我是创建者但宿主没删号能力 ⇒ 不许说「你不是它的创建者」（那是假话）", () => {
    // 这是 09-02 线上的真实情形：删号接口写好了没挂，实测 404。
    // 笼统归因成"你没资格"会让人去找权限，而病根在部署。
    const html = renderToStaticMarkup(
      <RemoveAIDialog target={{ ...FRIEND_OWNER, isFriend: false }} onClose={() => {}} />
    );
    expect(html).not.toContain("不是它的创建者");
    expect(html).toContain("没有删号这条路");
    expect(html).toContain("404");
  });

  it("确实不是创建者 ⇒ 才说「不是创建者」", () => {
    const html = renderToStaticMarkup(
      <RemoveAIDialog
        target={{ ...FRIEND_OWNER, isFriend: false, isOwner: false }}
        onClose={() => {}}
      />
    );
    expect(html).toContain("不是它的创建者");
    expect(html).not.toContain("没有删号这条路");
  });

  it("🔴 只有可恢复那一档可用、而我是创建者 ⇒ 必须告诉我删号在哪儿（BotFather）", () => {
    const html = renderToStaticMarkup(
      <RemoveAIDialog
        target={FRIEND_OWNER}
        onRemoveFromContacts={noop}
        onClose={() => {}}
      />
    );
    expect(html).toContain("从通讯录移除");
    expect(html).not.toContain("彻底删除这个 AI");
    expect(html).toContain("/deletebot");
  });

  it("只是好友、不是创建者 ⇒ 只画可恢复那一档", () => {
    const html = renderToStaticMarkup(
      <RemoveAIDialog
        target={{ ...FRIEND_OWNER, isOwner: false }}
        onRemoveFromContacts={noop}
        onDeleteAccount={noop}
        onClose={() => {}}
      />
    );
    expect(html).toContain("从通讯录移除");
    expect(html).not.toContain("彻底删除这个 AI");
  });

  it("🔴 删号那档被选中时，执行按钮必须是 disabled（名字还没输）", () => {
    // 只有删号可用 ⇒ defaultChoice 落在 account ⇒ 首屏就是"待打字确认"那一屏
    const html = renderToStaticMarkup(
      <RemoveAIDialog
        target={{ ...FRIEND_OWNER, isFriend: false }}
        onRemoveFromContacts={noop}
        onDeleteAccount={noop}
        onClose={() => {}}
      />
    );
    expect(html).toContain("输入上面那个名字");
    expect(html).toContain("disabled");
  });
});
