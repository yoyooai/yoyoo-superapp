import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createInnovateMock, INTENT_WEIGHTS } from "./innovate-mock.mjs";

function fakeReqRes(method, headers = {}, bodyObj) {
  const chunks = bodyObj !== undefined ? [Buffer.from(JSON.stringify(bodyObj))] : [];
  const req = { method, headers, async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; } };
  let statusCode, payload;
  const res = { writeHead(c) { statusCode = c; }, end(d) { payload = d ? JSON.parse(d) : undefined; } };
  return { req, res, result: () => ({ status: statusCode, body: payload }) };
}

function setup(secret = "shh") {
  const db = new DatabaseSync(":memory:");
  return createInnovateMock({ db, prefix: "/yoyoo/v1/demo/innovate-backend", secret });
}

async function getOnlyId(mock) {
  const { req, res, result } = fakeReqRes("GET", { authorization: "Bearer shh" });
  await mock.handle(req, res, { path: "/yoyoo/v1/demo/innovate-backend/opportunities", url: new URL("http://x/x"), llm: {}, now: Date.now() });
  return result().body.items[0].id;
}

test("没有共享密钥 → 401", async () => {
  const mock = setup();
  const { req, res, result } = fakeReqRes("GET", {});
  const hit = await mock.handle(req, res, { path: "/yoyoo/v1/demo/innovate-backend/opportunities", url: new URL("http://x/x"), llm: {}, now: Date.now() });
  assert.equal(hit, true);
  assert.equal(result().status, 401);
});

test("种子机会 1 条，status=new，validation_score 初始为 0", async () => {
  const mock = setup();
  const { req, res, result } = fakeReqRes("GET", { authorization: "Bearer shh" });
  await mock.handle(req, res, { path: "/yoyoo/v1/demo/innovate-backend/opportunities", url: new URL("http://x/x"), llm: {}, now: Date.now() });
  const item = result().body.items[0];
  assert.equal(item.status, "new");
  assert.equal(item.validation_score, 0);
});

test("signal：还没造概念测试物料就收信号 → 409", async () => {
  const mock = setup();
  const id = await getOnlyId(mock);
  const { req, res, result } = fakeReqRes("POST", { authorization: "Bearer shh" }, { type: "click" });
  await mock.handle(req, res, { path: `/yoyoo/v1/demo/innovate-backend/${id}/signal`, url: new URL("http://x/x"), llm: {}, now: Date.now() });
  assert.equal(result().status, 409);
});

test("完整闭环：hypotheses → concept → 多条 signal → validation_score 正确累加 → decide", async () => {
  const mock = setup();
  const id = await getOnlyId(mock);
  const now = Date.now();

  const hyp = fakeReqRes("POST", { authorization: "Bearer shh" });
  await mock.handle(hyp.req, hyp.res, { path: `/yoyoo/v1/demo/innovate-backend/${id}/hypotheses`, url: new URL("http://x/x"), llm: {}, now });
  assert.equal(hyp.result().status, 200);
  assert.ok(hyp.result().body.hypotheses.length >= 2, "三个假设至少要有区分度，本地兜底也给了3个");

  const con = fakeReqRes("POST", { authorization: "Bearer shh" }, { chosen_label: "A" });
  await mock.handle(con.req, con.res, { path: `/yoyoo/v1/demo/innovate-backend/${id}/concept`, url: new URL("http://x/x"), llm: {}, now });
  assert.equal(con.result().status, 200);
  assert.match(con.result().body.concept_note, /概念测试/, "文档硬性要求：必须写明概念测试字样");

  const s1 = fakeReqRes("POST", { authorization: "Bearer shh" }, { type: "click" });
  await mock.handle(s1.req, s1.res, { path: `/yoyoo/v1/demo/innovate-backend/${id}/signal`, url: new URL("http://x/x"), llm: {}, now });
  assert.equal(s1.result().body.validation_score, INTENT_WEIGHTS.click);

  const s2 = fakeReqRes("POST", { authorization: "Bearer shh" }, { type: "lead" });
  await mock.handle(s2.req, s2.res, { path: `/yoyoo/v1/demo/innovate-backend/${id}/signal`, url: new URL("http://x/x"), llm: {}, now });
  assert.equal(s2.result().body.validation_score, INTENT_WEIGHTS.click + INTENT_WEIGHTS.lead);

  const badType = fakeReqRes("POST", { authorization: "Bearer shh" }, { type: "made_up_type" });
  await mock.handle(badType.req, badType.res, { path: `/yoyoo/v1/demo/innovate-backend/${id}/signal`, url: new URL("http://x/x"), llm: {}, now });
  assert.equal(badType.result().status, 400, "瞎编的信号类型必须拒绝，不能悄悄记 weight=0");

  const noReason = fakeReqRes("POST", { authorization: "Bearer shh" }, { decision: "GO" });
  await mock.handle(noReason.req, noReason.res, { path: `/yoyoo/v1/demo/innovate-backend/${id}/decide`, url: new URL("http://x/x"), llm: {}, now });
  assert.equal(noReason.result().status, 400, "没写理由不许拍板——文档要求人工Owner必须记录理由");

  const decide = fakeReqRes("POST", { authorization: "Bearer shh" }, { decision: "iterate", reason: "信号够但价格带需要迭代" });
  await mock.handle(decide.req, decide.res, { path: `/yoyoo/v1/demo/innovate-backend/${id}/decide`, url: new URL("http://x/x"), llm: {}, now });
  assert.equal(decide.result().status, 200);
  assert.equal(decide.result().body.decision, "ITERATE");

  const again = fakeReqRes("POST", { authorization: "Bearer shh" }, { decision: "GO", reason: "改主意了" });
  await mock.handle(again.req, again.res, { path: `/yoyoo/v1/demo/innovate-backend/${id}/decide`, url: new URL("http://x/x"), llm: {}, now });
  assert.equal(again.result().status, 409, "已经拍过板的机会不许再拍第二次");
});
