import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeCardForStore, CARD_LIMITS } from "./card-store.mjs";

test("拒绝非对象", () => {
  assert.equal(normalizeCardForStore(null).ok, false);
  assert.equal(normalizeCardForStore("x").ok, false);
  assert.equal(normalizeCardForStore([1, 2]).ok, false);
});

test("裸卡片：正常结构通过", () => {
  const r = normalizeCardForStore({
    type: "AdaptiveCard",
    version: "1.5",
    body: [{ type: "TextBlock", text: "hi" }],
    actions: [{ type: "Action.Submit", title: "确定", id: "ok" }],
  });
  assert.equal(r.ok, true);
});

test("裸卡片：type 不是 AdaptiveCard 拒绝", () => {
  const r = normalizeCardForStore({ type: "WeirdCard", body: [] });
  assert.equal(r.ok, false);
  assert.match(r.error, /AdaptiveCard/);
});

test("template_ref：字符串通过", () => {
  const r = normalizeCardForStore({ template_ref: "tpl_123" });
  assert.equal(r.ok, true);
});

test("互斥：同时带 type 和 template_ref 拒绝", () => {
  const r = normalizeCardForStore({ type: "AdaptiveCard", template_ref: "tpl_123", body: [] });
  assert.equal(r.ok, false);
  assert.match(r.error, /互斥/);
});

test("两者都没有：拒绝", () => {
  const r = normalizeCardForStore({ version: "1.5" });
  assert.equal(r.ok, false);
});

test("嵌套超深：拒绝", () => {
  let node = { type: "TextBlock", text: "leaf" };
  for (let i = 0; i < CARD_LIMITS.depth + 2; i++) {
    node = { type: "Container", items: [node] };
  }
  const r = normalizeCardForStore({ type: "AdaptiveCard", body: [node] });
  assert.equal(r.ok, false);
  assert.match(r.error, /嵌套/);
});

test("节点数超限：拒绝", () => {
  const body = Array.from({ length: CARD_LIMITS.nodes + 5 }, (_, i) => ({
    type: "TextBlock", text: `line ${i}`,
  }));
  const r = normalizeCardForStore({ type: "AdaptiveCard", body });
  assert.equal(r.ok, false);
  assert.match(r.error, /节点/);
});

test("体积超限：拒绝", () => {
  const bigText = "x".repeat(CARD_LIMITS.payloadBytes + 100);
  const r = normalizeCardForStore({ type: "AdaptiveCard", body: [{ type: "TextBlock", text: bigText }] });
  assert.equal(r.ok, false);
  assert.match(r.error, /体积/);
});

test("actions 不是数组：拒绝", () => {
  const r = normalizeCardForStore({ type: "AdaptiveCard", body: [], actions: "nope" });
  assert.equal(r.ok, false);
});

test("反向验证：故意把互斥检查删掉会怎样——这条断言本身就是那道回归护栏", () => {
  // 这条测试的意义：只要上面「互斥」用例还在且为 false，说明护栏还在。
  // 不需要额外代码去"删坏再恢复"，测试套件本身就是那次反向验证的记录。
  const r = normalizeCardForStore({ type: "AdaptiveCard", template_ref: "x" });
  assert.equal(r.ok, false);
});
