/**
 * 邀请票据单测。
 *
 * 这里的判据围绕**三条不能被无声改坏的性质**（invite.mjs 文件头那三条取舍）：
 *   ① 库里既没有票号原文、也没有明文 token；两者任一单独泄露都换不到凭据
 *   ② 凭据只交付一次
 *   ③ 走审批时，兑换那一刻**绝不**产生号或凭据
 * 每条都配一条反向断言 —— 把实现改回"明文存 token"或"兑换即给"必须报红。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createInvites, DEFAULT_TTL_DAYS } from "./invite.mjs";

const ROOT = "/yoyoo/v1";
const UID = "u_subai";

/** 极简 res 假件：把状态码和 JSON body 收下来。 */
function fakeRes() {
  return {
    code: 0, body: null, headers: null,
    writeHead(c, h) { this.code = c; this.headers = h; },
    end(data) { this.body = data ? JSON.parse(data) : null; },
  };
}

/** 极简 req 假件：node:http 的 req 是 async iterable，这里照那个形状给。 */
function fakeReq(method, payload, headers = {}) {
  const chunks = payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))];
  return {
    method,
    headers: { "content-type": "application/json", ...headers },
    socket: { remoteAddress: "10.0.0.1" },
    async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; },
  };
}

function harness() {
  const db = new DatabaseSync(":memory:");
  const inv = createInvites({
    db,
    spaceId: "sp_1",
    apiBase: "https://example.test/yoyoo/v1",
    hostApiUrl: "https://example.test",
    sealSecretEnv: "test-seal-secret",
    sealKeyPath: "", // 单测不落盘
  });
  const user = async (method, path, payload) => {
    const res = fakeRes();
    const hit = await inv.handle(fakeReq(method, payload), res,
      { path: `${ROOT}${path}`, uid: UID, now: Date.now(), root: ROOT });
    return { hit, ...res };
  };
  const pub = async (path, payload, now = Date.now()) => {
    const res = fakeRes();
    const hit = await inv.handlePublic(fakeReq("POST", payload), res,
      { path: `${ROOT}${path}`, now, root: ROOT });
    return { hit, ...res };
  };
  const rows = () => db.prepare("SELECT * FROM invites").all();
  return { db, inv, user, pub, rows };
}

const issueDirect = (h, extra = {}) =>
  h.user("POST", "/invites", { bot_uid: "guest_bot", bot_token: "bf_secret_token", ...extra });

// ── ① 出票 ─────────────────────────────────────────────────────

test("不审批出票必须带凭据，否则 400", async () => {
  const h = harness();
  const r = await h.user("POST", "/invites", { require_approval: false });
  assert.equal(r.code, 400);
  assert.match(r.body.error, /bot_uid/);
});

test("出票返回票号和一段给 AI 读的邀请函", async () => {
  const h = harness();
  const r = await issueDirect(h);
  assert.equal(r.code, 201);
  assert.match(r.body.code, /^yi_/);
  assert.match(r.body.letter, /invites\/redeem/);
  assert.match(r.body.letter, new RegExp(r.body.code.replace(/[-_]/g, "\\$&")));
  assert.equal(r.body.require_approval, false);
});

test("🔴 邀请函里绝不能出现 token 明文（它会被复制进聊天记录）", async () => {
  const h = harness();
  const r = await issueDirect(h);
  assert.ok(!r.body.letter.includes("bf_secret_token"),
    "邀请函泄露了 bot token —— 这条改坏必须报红");
});

test("🔴 库里没有票号原文，也没有明文 token", async () => {
  const h = harness();
  const r = await issueDirect(h);
  const dump = JSON.stringify(h.rows());
  assert.ok(!dump.includes(r.body.code), "库里出现了票号原文");
  assert.ok(!dump.includes("bf_secret_token"), "库里出现了明文 token");
});

test("🔴 只有库、没有票号，解不开凭据（这条是那三条性质的地基）", async () => {
  const h = harness();
  const iss = await issueDirect(h);
  const row = h.rows()[0];
  const { unseal } = h.inv._internals;

  assert.ok(row.sealed_token?.includes("."), "凭据必须是密封态（iv.tag.密文）");
  // 有票号 ⇒ 解得开
  assert.equal(unseal(row.sealed_token, iss.body.code), "bf_secret_token");
  // 只有库、票号不对 ⇒ 必须解不开（GCM 校验失败直接抛）
  assert.throws(() => unseal(row.sealed_token, "yi_" + "A".repeat(43)));
  // 拿错票号走正门也命不中任何票
  const r = await h.pub("/invites/redeem", { code: "yi_" + "A".repeat(43), name: "冒充者" });
  assert.equal(r.code, 404);
});

// ── ② 兑换（默认不审批）────────────────────────────────────────

test("兑换成功拿到 token 和接入信息", async () => {
  const h = harness();
  const iss = await issueDirect(h);
  const r = await h.pub("/invites/redeem", {
    code: iss.body.code, name: "小X", owner: "某人", description: "会写代码",
  });
  assert.equal(r.code, 200);
  assert.equal(r.body.bot_token, "bf_secret_token");
  assert.equal(r.body.bot_uid, "guest_bot");
  assert.equal(r.body.space_id, "sp_1");
  assert.equal(r.body.api_url, "https://example.test");
});

test("兑换必须自报名字", async () => {
  const h = harness();
  const iss = await issueDirect(h);
  const r = await h.pub("/invites/redeem", { code: iss.body.code });
  assert.equal(r.code, 400);
});

test("🔴 凭据只交付一次：第二次兑换必须失败，且库里密文已抹掉", async () => {
  const h = harness();
  const iss = await issueDirect(h);
  await h.pub("/invites/redeem", { code: iss.body.code, name: "小X" });
  const again = await h.pub("/invites/redeem", { code: iss.body.code, name: "小X" });
  assert.equal(again.code, 409);
  assert.equal(h.rows()[0].sealed_token, null, "交付后必须抹掉密文");
});

test("兑换会记下对方自报的身份，供人核对", async () => {
  const h = harness();
  const iss = await issueDirect(h);
  await h.pub("/invites/redeem", {
    code: iss.body.code, name: "小X", owner: "老张", description: "写代码",
  });
  const list = await h.user("GET", "/invites");
  assert.equal(list.body.invites[0].claim_name, "小X");
  assert.equal(list.body.invites[0].claim_owner, "老张");
});

test("不存在的票号和作废的票给同样的回答（不当探测器）", async () => {
  const h = harness();
  const r = await h.pub("/invites/redeem", { code: "yi_nope", name: "x" });
  assert.equal(r.code, 404);
  assert.match(r.body.error, /not found or no longer valid/);
});

test("过期的票兑换 410", async () => {
  const h = harness();
  const iss = await issueDirect(h, { ttl_days: 1 });
  const later = Date.now() + 2 * 86_400_000;
  const r = await h.pub("/invites/redeem", { code: iss.body.code, name: "小X" }, later);
  assert.equal(r.code, 410);
});

// ── ③ 审批路径 ─────────────────────────────────────────────────

test("🔴 走审批：兑换那一刻不产生号、不产生凭据，只排队", async () => {
  const h = harness();
  const iss = await h.user("POST", "/invites", { require_approval: true });
  assert.equal(iss.code, 201);

  const r = await h.pub("/invites/redeem", { code: iss.body.code, name: "小X", owner: "老张" });
  assert.equal(r.code, 202);
  assert.equal(r.body.status, "pending");
  assert.ok(!("bot_token" in r.body), "待审批阶段绝不能给出凭据");

  const row = h.rows()[0];
  assert.equal(row.status, "pending");
  assert.equal(row.bot_uid, null, "还没点头就不该有号");
  assert.equal(row.sealed_token, null, "还没点头就不该有凭据");
});

test("走审批：点头前取件拿不到东西，点头后拿到，再取拿不到", async () => {
  const h = harness();
  const iss = await h.user("POST", "/invites", { require_approval: true });
  const code = iss.body.code;
  await h.pub("/invites/redeem", { code, name: "小X" });

  const early = await h.pub("/invites/pickup", { code });
  assert.equal(early.code, 202);

  const ok = await h.user("POST", `/invites/${iss.body.id}/approve`,
    { bot_uid: "guest_bot", bot_token: "bf_after_approval" });
  assert.equal(ok.code, 200);
  assert.equal(ok.body.status, "accepted");

  const got = await h.pub("/invites/pickup", { code });
  assert.equal(got.code, 200);
  assert.equal(got.body.bot_token, "bf_after_approval");

  const twice = await h.pub("/invites/pickup", { code });
  assert.equal(twice.code, 410, "凭据只交付一次");
});

test("拒绝之后取件拿不到，票也不能再兑换", async () => {
  const h = harness();
  const iss = await h.user("POST", "/invites", { require_approval: true });
  const code = iss.body.code;
  await h.pub("/invites/redeem", { code, name: "小X" });

  const rej = await h.user("POST", `/invites/${iss.body.id}/reject`, {});
  assert.equal(rej.code, 200);
  assert.equal(rej.body.status, "rejected");

  assert.equal((await h.pub("/invites/pickup", { code })).code, 409);
  assert.equal((await h.pub("/invites/redeem", { code, name: "小X" })).code, 409);
});

test("没人兑换的票不能被批准（没有待办就没有可批的东西）", async () => {
  const h = harness();
  const iss = await h.user("POST", "/invites", { require_approval: true });
  const r = await h.user("POST", `/invites/${iss.body.id}/approve`,
    { bot_uid: "b", bot_token: "bf_x" });
  assert.equal(r.code, 409);
});

// ── ④ 撤票与越权 ───────────────────────────────────────────────

test("撤票后凭据一起抹掉，票不能再兑换", async () => {
  const h = harness();
  const iss = await issueDirect(h);
  const del = await h.user("DELETE", `/invites/${iss.body.id}`);
  assert.equal(del.code, 200);
  assert.equal(h.rows()[0].sealed_token, null);
  assert.equal((await h.pub("/invites/redeem", { code: iss.body.code, name: "x" })).code, 409);
});

test("🔴 别人的票看不见也动不了", async () => {
  const h = harness();
  const iss = await issueDirect(h);
  const res = fakeRes();
  await h.inv.handle(fakeReq("GET"), res,
    { path: `${ROOT}/invites/${iss.body.id}`, uid: "u_someone_else", now: Date.now(), root: ROOT });
  assert.equal(res.code, 404);
});

test("单票详情不回显票号哈希与密文", async () => {
  const h = harness();
  const iss = await issueDirect(h);
  const r = await h.user("GET", `/invites/${iss.body.id}`);
  assert.equal(r.code, 200);
  assert.ok(!("sealed_token" in r.body));
  assert.ok(!("code_hash" in r.body));
  assert.equal(r.body.credential_pending, true);
});

test("有效期上限收口（30 天），默认值是 7 天", async () => {
  const h = harness();
  assert.equal(DEFAULT_TTL_DAYS, 7);
  const r = await issueDirect(h, { ttl_days: 9999 });
  const days = Math.round((r.body.expires_at - Date.now()) / 86_400_000);
  assert.equal(days, 30);
});
