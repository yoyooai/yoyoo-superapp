import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createGrowMock } from "./grow-mock.mjs";

function fakeReqRes(method, headers = {}, bodyObj) {
  const chunks = bodyObj !== undefined ? [Buffer.from(JSON.stringify(bodyObj))] : [];
  const req = { method, headers, async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; } };
  let statusCode, payload;
  const res = { writeHead(c) { statusCode = c; }, end(d) { payload = d ? JSON.parse(d) : undefined; } };
  return { req, res, result: () => ({ status: statusCode, body: payload }) };
}

function setup(secret = "shh") {
  const db = new DatabaseSync(":memory:");
  return createGrowMock({ db, prefix: "/yoyoo/v1/demo/grow-backend", secret });
}

test("没有共享密钥 → 401", async () => {
  const grow = setup();
  const { req, res, result } = fakeReqRes("GET", {});
  const hit = await grow.handle(req, res, { path: "/yoyoo/v1/demo/grow-backend/experiments", url: new URL("http://x/x"), llm: {}, now: Date.now() });
  assert.equal(hit, true);
  assert.equal(result().status, 401);
});

test("列表：种子实验 2 条，pending 状态", async () => {
  const grow = setup();
  const { req, res, result } = fakeReqRes("GET", { authorization: "Bearer shh" });
  await grow.handle(req, res, { path: "/yoyoo/v1/demo/grow-backend/experiments", url: new URL("http://x/x"), llm: {}, now: Date.now() });
  const { body } = result();
  assert.equal(body.items.length, 2);
  assert.ok(body.items.every((e) => e.status === "pending"));
});

test("generate：本地兜底生成变体后状态变 ai_generated", async () => {
  const grow = setup();
  const list = fakeReqRes("GET", { authorization: "Bearer shh" });
  await grow.handle(list.req, list.res, { path: "/yoyoo/v1/demo/grow-backend/experiments", url: new URL("http://x/x"), llm: {}, now: Date.now() });
  const id = list.result().body.items[0].id;

  const gen = fakeReqRes("POST", { authorization: "Bearer shh" });
  await grow.handle(gen.req, gen.res, { path: `/yoyoo/v1/demo/grow-backend/${id}/generate`, url: new URL("http://x/x"), llm: {}, now: Date.now() });
  assert.equal(gen.result().status, 200);
  assert.ok(gen.result().body.variants.length >= 1);

  const detail = fakeReqRes("GET", { authorization: "Bearer shh" });
  await grow.handle(detail.req, detail.res, { path: `/yoyoo/v1/demo/grow-backend/${id}`, url: new URL("http://x/x"), llm: {}, now: Date.now() });
  assert.equal(detail.result().body.status, "ai_generated");
});

test("report：只有已批准的才能回填结果，未批准直接 409", async () => {
  const grow = setup();
  const list = fakeReqRes("GET", { authorization: "Bearer shh" });
  await grow.handle(list.req, list.res, { path: "/yoyoo/v1/demo/grow-backend/experiments", url: new URL("http://x/x"), llm: {}, now: Date.now() });
  const id = list.result().body.items[1].id;

  const rep1 = fakeReqRes("POST", { authorization: "Bearer shh" }, { ctr: 1, cvr: 1, gmv: 1 });
  await grow.handle(rep1.req, rep1.res, { path: `/yoyoo/v1/demo/grow-backend/${id}/report`, url: new URL("http://x/x"), llm: {}, now: Date.now() });
  assert.equal(rep1.result().status, 409);

  const app = fakeReqRes("POST", { authorization: "Bearer shh" }, { note: "同意投放" });
  await grow.handle(app.req, app.res, { path: `/yoyoo/v1/demo/grow-backend/${id}/approve`, url: new URL("http://x/x"), llm: {}, now: Date.now() });
  assert.equal(app.result().status, 200);

  const rep2 = fakeReqRes("POST", { authorization: "Bearer shh" }, { ctr: 3.2, cvr: 1.1, gmv: 12000, source: "人工补录：抖音后台截图" });
  await grow.handle(rep2.req, rep2.res, { path: `/yoyoo/v1/demo/grow-backend/${id}/report`, url: new URL("http://x/x"), llm: {}, now: Date.now() });
  assert.equal(rep2.result().status, 200);
  assert.equal(rep2.result().body.status, "measured");
  assert.equal(rep2.result().body.result_source, "人工补录：抖音后台截图");
});
