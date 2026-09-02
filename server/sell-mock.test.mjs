import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createSellMock } from "./sell-mock.mjs";

function fakeReqRes(method, headers = {}, bodyObj) {
  const chunks = bodyObj !== undefined ? [Buffer.from(JSON.stringify(bodyObj))] : [];
  const req = {
    method,
    headers,
    async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; },
  };
  let statusCode, payload;
  const res = {
    writeHead(code) { statusCode = code; },
    end(data) { payload = data ? JSON.parse(data) : undefined; },
  };
  return { req, res, result: () => ({ status: statusCode, body: payload }) };
}

function setup(secret = "shh") {
  const db = new DatabaseSync(":memory:");
  const sell = createSellMock({ db, prefix: "/yoyoo/v1/demo/sell-backend", secret });
  return sell;
}

test("没有共享密钥 → 401", async () => {
  const sell = setup();
  const { req, res, result } = fakeReqRes("GET", {});
  const hit = await sell.handle(req, res, { path: "/yoyoo/v1/demo/sell-backend/tasks", url: new URL("http://x/tasks"), llm: {}, now: Date.now() });
  assert.equal(hit, true);
  assert.equal(result().status, 401);
});

test("带对密钥 → 能列表，种子任务是 3 条、状态都是 pending", async () => {
  const sell = setup();
  const { req, res, result } = fakeReqRes("GET", { authorization: "Bearer shh" });
  await sell.handle(req, res, { path: "/yoyoo/v1/demo/sell-backend/tasks", url: new URL("http://x/tasks"), llm: {}, now: Date.now() });
  const { status, body } = result();
  assert.equal(status, 200);
  assert.equal(body.items.length, 3);
  assert.ok(body.items.every((t) => t.status === "pending"));
});

test("recommend：本地兜底报价不低于成本 1.15 倍", async () => {
  const sell = setup();
  const list = fakeReqRes("GET", { authorization: "Bearer shh" });
  await sell.handle(list.req, list.res, { path: "/yoyoo/v1/demo/sell-backend/tasks", url: new URL("http://x/tasks"), llm: {}, now: Date.now() });
  const id = list.result().body.items[0].id;
  const cost = list.result().body.items[0].sku_cost;

  const rec = fakeReqRes("POST", { authorization: "Bearer shh" });
  await sell.handle(rec.req, rec.res, { path: `/yoyoo/v1/demo/sell-backend/${id}/recommend`, url: new URL("http://x/x"), llm: {}, now: Date.now() });
  const { status, body } = rec.result();
  assert.equal(status, 200);
  assert.ok(body.ai_quote_amount >= cost * 1.15);
});

test("approve：一旦批准，再次批准/拒绝都是 409（不能处理两次）", async () => {
  const sell = setup();
  const list = fakeReqRes("GET", { authorization: "Bearer shh" });
  await sell.handle(list.req, list.res, { path: "/yoyoo/v1/demo/sell-backend/tasks", url: new URL("http://x/tasks"), llm: {}, now: Date.now() });
  const id = list.result().body.items[0].id;

  const a1 = fakeReqRes("POST", { authorization: "Bearer shh" }, { note: "同意" });
  await sell.handle(a1.req, a1.res, { path: `/yoyoo/v1/demo/sell-backend/${id}/approve`, url: new URL("http://x/x"), llm: {}, now: Date.now() });
  assert.equal(a1.result().status, 200);
  assert.equal(a1.result().body.status, "approved");

  const a2 = fakeReqRes("POST", { authorization: "Bearer shh" }, {});
  await sell.handle(a2.req, a2.res, { path: `/yoyoo/v1/demo/sell-backend/${id}/approve`, url: new URL("http://x/x"), llm: {}, now: Date.now() });
  assert.equal(a2.result().status, 409);

  const r1 = fakeReqRes("POST", { authorization: "Bearer shh" }, {});
  await sell.handle(r1.req, r1.res, { path: `/yoyoo/v1/demo/sell-backend/${id}/reject`, url: new URL("http://x/x"), llm: {}, now: Date.now() });
  assert.equal(r1.result().status, 409, "已批准的任务不该还能被拒绝");
});

test("reject：正常路径写回 human_note", async () => {
  const sell = setup();
  const list = fakeReqRes("GET", { authorization: "Bearer shh" });
  await sell.handle(list.req, list.res, { path: "/yoyoo/v1/demo/sell-backend/tasks", url: new URL("http://x/tasks"), llm: {}, now: Date.now() });
  const id = list.result().body.items[1].id;

  const rej = fakeReqRes("POST", { authorization: "Bearer shh" }, { note: "价格不合适，重新报" });
  await sell.handle(rej.req, rej.res, { path: `/yoyoo/v1/demo/sell-backend/${id}/reject`, url: new URL("http://x/x"), llm: {}, now: Date.now() });
  assert.equal(rej.result().status, 200);
  assert.equal(rej.result().body.status, "rejected");

  const detail = fakeReqRes("GET", { authorization: "Bearer shh" });
  await sell.handle(detail.req, detail.res, { path: `/yoyoo/v1/demo/sell-backend/${id}`, url: new URL("http://x/x"), llm: {}, now: Date.now() });
  assert.equal(detail.result().body.human_note, "价格不合适，重新报");
});
