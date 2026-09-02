import { test } from "node:test";
import assert from "node:assert/strict";
import { VOCAB, sanitizeBlueprint, normalizeForStore } from "./blueprint.mjs";

test("VOCAB 里有 script（09-03 连接器/沙盒新增）", () => {
  assert.ok(VOCAB.includes("script"));
});

test("script：正常代码通过，字段收敛为 type+code(+title)", () => {
  const r = sanitizeBlueprint({ type: "script", code: "document.getElementById('app').textContent='hi'", title: "看板" });
  assert.equal(r.type, "script");
  assert.equal(r.code, "document.getElementById('app').textContent='hi'");
  assert.equal(r.title, "看板");
  assert.equal(r.children, undefined, "script 节点不该带 children 字段");
});

test("script：code 不是字符串 → 降级成不存在（null）", () => {
  assert.equal(sanitizeBlueprint({ type: "script", code: 12345 }), null);
  assert.equal(sanitizeBlueprint({ type: "script" }), null);
  assert.equal(sanitizeBlueprint({ type: "script", code: {} }), null);
});

test("script：空字符串/纯空白代码 → null（不渲染一个空壳沙盒）", () => {
  assert.equal(sanitizeBlueprint({ type: "script", code: "" }), null);
  assert.equal(sanitizeBlueprint({ type: "script", code: "   \n  " }), null);
});

test("script：超长代码被截断，不是拒绝", () => {
  const long = "x".repeat(30_000);
  const r = sanitizeBlueprint({ type: "script", code: long });
  assert.equal(r.code.length, 20_000);
});

test("script：title 超长被裁到 80", () => {
  const r = sanitizeBlueprint({ type: "script", code: "1", title: "t".repeat(200) });
  assert.equal(r.title.length, 80);
});

test("normalizeForStore：根节点是裸 script 时自动包一层 page", () => {
  const r = normalizeForStore({ type: "script", code: "1" });
  assert.equal(r.ok, true);
  assert.equal(r.blueprint.type, "page");
  assert.equal(r.blueprint.children[0].type, "script");
});

test("script 混在 page.children 里正常收敛", () => {
  const r = normalizeForStore({
    type: "page",
    children: [{ type: "heading", value: "标题" }, { type: "script", code: "1" }],
  });
  assert.equal(r.ok, true);
  assert.equal(r.blueprint.children.length, 2);
  assert.equal(r.blueprint.children[1].type, "script");
});
