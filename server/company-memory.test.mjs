import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createCompanyMemory } from "./company-memory.mjs";
import { createSellMock } from "./sell-mock.mjs";
import { createGrowMock } from "./grow-mock.mjs";
import { createInnovateMock } from "./innovate-mock.mjs";

function fakeReqRes(method, headers = {}, bodyObj) {
  const chunks = bodyObj !== undefined ? [Buffer.from(JSON.stringify(bodyObj))] : [];
  const req = { method, headers, async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; } };
  let statusCode, payload;
  const res = { writeHead(c) { statusCode = c; }, end(d) { payload = d ? JSON.parse(d) : undefined; } };
  return { req, res, result: () => ({ status: statusCode, body: payload }) };
}

test("三张业务表都不存在时（空db）：feed/agents 不崩，返回空/零", async () => {
  const db = new DatabaseSync(":memory:");
  const mem = createCompanyMemory({ db, prefix: "/yoyoo/v1/demo/company-memory", secret: "shh" });
  const feed = fakeReqRes("GET", { authorization: "Bearer shh" });
  await mem.handle(feed.req, feed.res, { path: "/yoyoo/v1/demo/company-memory/feed" });
  assert.equal(feed.result().status, 200);
  assert.deepEqual(feed.result().body.items, []);

  const agents = fakeReqRes("GET", { authorization: "Bearer shh" });
  await mem.handle(agents.req, agents.res, { path: "/yoyoo/v1/demo/company-memory/agents" });
  assert.equal(agents.result().status, 200);
  assert.equal(agents.result().body.items.length, 8);
  assert.ok(agents.result().body.items.every((a) => a.task_count === 0));
  assert.ok(agents.result().body.items.every((a) => a.cost === null), "没接埋点就该是null，不能编数字");
});

test("没有共享密钥 → 401", async () => {
  const db = new DatabaseSync(":memory:");
  const mem = createCompanyMemory({ db, prefix: "/yoyoo/v1/demo/company-memory", secret: "shh" });
  const { req, res, result } = fakeReqRes("GET", {});
  const hit = await mem.handle(req, res, { path: "/yoyoo/v1/demo/company-memory/feed" });
  assert.equal(hit, true);
  assert.equal(result().status, 401);
});

test("三个业务表都建好并有数据后：feed 汇总三条 loop，agents 计数是真实计算的", async () => {
  const db = new DatabaseSync(":memory:");
  createSellMock({ db, prefix: "/x", secret: "s" });     // 建表+种子3条
  createGrowMock({ db, prefix: "/x", secret: "s" });     // 建表+种子2条
  createInnovateMock({ db, prefix: "/x", secret: "s" }); // 建表+种子1条
  const mem = createCompanyMemory({ db, prefix: "/yoyoo/v1/demo/company-memory", secret: "shh" });

  const feed = fakeReqRes("GET", { authorization: "Bearer shh" });
  await mem.handle(feed.req, feed.res, { path: "/yoyoo/v1/demo/company-memory/feed" });
  const items = feed.result().body.items;
  assert.equal(items.length, 6, "3+2+1=6 条种子事实");
  assert.ok(items.some((i) => i.loop === "Sell"));
  assert.ok(items.some((i) => i.loop === "Grow"));
  assert.ok(items.some((i) => i.loop === "Innovate"));

  const agents = fakeReqRes("GET", { authorization: "Bearer shh" });
  await mem.handle(agents.req, agents.res, { path: "/yoyoo/v1/demo/company-memory/agents" });
  const list = agents.result().body.items;
  const parse = (name) => list.find((a) => a.name === name);
  assert.equal(parse("需求解析Agent").task_count, 3, "3个种子客户任务");
  assert.equal(parse("内容Agent").task_count, 0, "种子实验还没生成过变体，AI还没动手过");
  assert.equal(parse("机会Agent").task_count, 1, "1个种子机会");
});
