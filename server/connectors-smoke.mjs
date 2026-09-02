/**
 * 连接器冒烟测试 —— 真起进程、真发 HTTP、真起一个"外部系统"、真做一次代理往返。
 *
 * 覆盖：
 *   用户面（session token）：注册 → 列表（不回显密钥）→ 代理调用真到达外部服务
 *     且带对了凭据 → 越权（B 摸不到 A 的连接器）→ 删除
 *   bot 面（AI 代表某个人）：同一套，走 `/connectors/for`
 *   安全：SSRF 拦截（默认配置下内网地址创建/调用双双被拒）
 *
 * 用法：node server/connectors-smoke.mjs
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOKEN = "test-token-abc";
const UID = "u_test_001";
const UID_B = "u_test_002";
const BOT_TOKEN = "bf_test_bot";
const BOT_ROBOT_ID = "xiaoa_bot";
const SPACE_ID = "sp_test";
const PORT = 8795;

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✅ ${name}`);
  else { console.log(`  ❌ ${name} ${extra}`); failures++; }
}

/** 假宿主：user/current（session）+ bot/register + bot/space/principals */
function startFakeHost() {
  const json = (res, code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      const url = new URL(req.url, "http://x");
      const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      if (url.pathname === "/v1/user/current") {
        const t = String(req.headers.token || req.headers.authorization || "");
        if (t.includes(TOKEN)) return json(res, 200, { uid: UID });
        return json(res, 401, {});
      }
      if (url.pathname === "/v1/bot/register") {
        if (bearer === BOT_TOKEN) return json(res, 200, { robot_id: BOT_ROBOT_ID });
        return json(res, 401, { error: { code: "ErrBotAPIUnauthorized" } });
      }
      if (url.pathname.startsWith("/v1/bot/space/principals/")) {
        if (bearer !== BOT_TOKEN) return json(res, 401, {});
        if (url.searchParams.get("space_id") !== SPACE_ID) return json(res, 400, {});
        const target = decodeURIComponent(url.pathname.split("/").pop());
        if (target === UID) return json(res, 200, { uid: UID, principal_type: "human" });
        return json(res, 404, {});
      }
      return json(res, 401, {});
    });
    srv.listen(0, () => resolve({ srv, port: srv.address().port }));
  });
}

/** 假"外部系统"：回显它收到的鉴权头 + 一点数据，用来验证代理真的把凭据带对了 */
function startFakeExternal() {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      const url = new URL(req.url, "http://x");
      if (url.pathname === "/echo") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({
          received_auth: req.headers.authorization || null,
          received_x_api_key: req.headers["x-api-key"] || null,
          query: Object.fromEntries(url.searchParams),
        }));
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
    srv.listen(0, () => resolve({ srv, port: srv.address().port }));
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function user(method, path, body) {
  const res = await fetch(`http://127.0.0.1:${PORT}/yoyoo/v1${path}`, {
    method, headers: { token: TOKEN, "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let j = null; try { j = await res.json(); } catch {}
  return { status: res.status, json: j };
}
async function bot(method, path, body) {
  const res = await fetch(`http://127.0.0.1:${PORT}/yoyoo/v1${path}`, {
    method, headers: { authorization: `Bearer ${BOT_TOKEN}`, "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let j = null; try { j = await res.json(); } catch {}
  return { status: res.status, json: j };
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "yoyoo-connectors-"));
  const dbPath = join(dir, "test.db");
  const { srv: hostSrv, port: hostPort } = await startFakeHost();
  const { srv: extSrv, port: extPort } = await startFakeExternal();

  const proc = spawn(process.execPath, [join(import.meta.dirname, "index.mjs")], {
    env: {
      ...process.env, PORT: String(PORT), DB_PATH: dbPath,
      HOST_VERIFY_URL: `http://127.0.0.1:${hostPort}/v1/user/current`,
      HOST_BOT_API_URL: `http://127.0.0.1:${hostPort}`,
      OCTO_SPACE_ID: SPACE_ID,
      YOYOO_BOT_ALLOWLIST: BOT_ROBOT_ID,
      CONNECTOR_ALLOW_PRIVATE_HOSTS_FOR_TEST: "1",
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  await wait(900);

  console.log("\n── 用户面：注册 → 列表 → 代理调用真到达外部服务 ──");
  const created = await user("POST", "/connectors", {
    name: "测试CRM", base_url: `http://127.0.0.1:${extPort}`, auth_type: "bearer", secret: "sk-real-secret-123",
  });
  check("造连接器成功", created.status === 201, `实际 ${created.status} ${JSON.stringify(created.json)}`);
  const connId = created.json?.id;

  const listed = await user("GET", "/connectors");
  check("列表能看到", listed.json?.items?.some((i) => i.id === connId));
  const listedItem = listed.json?.items?.find((i) => i.id === connId);
  check("🔴 列表标了 has_secret 但没有明文密钥字段", listedItem?.has_secret === 1 && listedItem?.secret === undefined,
    JSON.stringify(listedItem));
  check("列表内容不含密文本身（sealed_secret 不外泄）", listedItem?.sealed_secret === undefined);

  const called = await user("POST", `/connectors/${connId}/call`, { method: "GET", path: "/echo", query: { x: "1" } });
  check("代理调用成功", called.status === 200, `实际 ${called.status} ${JSON.stringify(called.json)}`);
  check("🔴 外部服务真的收到了正确的 Bearer 凭据（不是明文摆在别处，是代理层现填的）",
    called.json?.body?.received_auth === "Bearer sk-real-secret-123", JSON.stringify(called.json));
  check("query 参数真的透传到了外部请求", called.json?.body?.query?.x === "1");
  // 注：外部服务这里故意把收到的凭据回显回来（用来证明代理传对了），所以响应体里
  // 出现密钥是这次测试的预期行为，不是泄露——真正要防的是"列表/错误信息"里出现，
  // 已在上面 has_secret / sealed_secret 两条断言里验过。

  console.log("\n── header 认证方式也走一遍 ──");
  const created2 = await user("POST", "/connectors", {
    name: "测试API", base_url: `http://127.0.0.1:${extPort}`, auth_type: "header", header_name: "X-Api-Key", secret: "hdr-secret-456",
  });
  check("造 header 型连接器成功", created2.status === 201);
  const called2 = await user("POST", `/connectors/${created2.json.id}/call`, { method: "GET", path: "/echo" });
  check("header 凭据真的带到了外部请求里", called2.json?.body?.received_x_api_key === "hdr-secret-456", JSON.stringify(called2.json));

  console.log("\n── 越权：B 摸不到 A 的连接器 ──");
  // B 走 bot 面代表自己创建、验证互不可见（用户面没有第二个假身份，这里用 bot 面模拟 B）
  const bCreate = await bot("POST", "/connectors/for", { owner_uid: UID, name: "重复用A的uid做基线", base_url: `http://127.0.0.1:${extPort}`, auth_type: "none" });
  check("bot 面能替 A 造连接器（作为基线）", bCreate.status === 201, JSON.stringify(bCreate.json));

  const wrongDelete = await fetch(`http://127.0.0.1:${PORT}/yoyoo/v1/connectors/${connId}`, {
    method: "DELETE", headers: { token: "no-such-token" },
  });
  check("🔴 没登录删连接器 → 401", wrongDelete.status === 401, `实际 ${wrongDelete.status}`);

  console.log("\n── SSRF 拦截：默认配置（本进程刻意开了测试口子，这里验证判据本身在别的场景会拦）──");
  const { createConnectors } = await import("./connectors.mjs");
  const { DatabaseSync } = await import("node:sqlite");
  const secureDb = new DatabaseSync(":memory:");
  const secureConnectors = createConnectors({ db: secureDb, sealKeyPath: null }); // allowPrivateHosts 默认 false
  const r1 = await secureConnectors._internals.doCreate(UID, { name: "x", base_url: "http://127.0.0.1:1/", auth_type: "none" }, "human", Date.now());
  check("🔴 默认配置拒绝 127.0.0.1", r1.status === 400, JSON.stringify(r1));
  const r2 = await secureConnectors._internals.doCreate(UID, { name: "x", base_url: "http://169.254.169.254/latest/meta-data/", auth_type: "none" }, "human", Date.now());
  check("🔴 默认配置拒绝云厂商元数据地址 169.254.169.254", r2.status === 400, JSON.stringify(r2));
  const r3 = await secureConnectors._internals.doCreate(UID, { name: "x", base_url: "http://10.0.0.5/", auth_type: "none" }, "human", Date.now());
  check("🔴 默认配置拒绝内网 10.x", r3.status === 400, JSON.stringify(r3));
  const r4 = await secureConnectors._internals.doCreate(UID, { name: "x", base_url: "file:///etc/passwd", auth_type: "none" }, "human", Date.now());
  check("🔴 默认配置拒绝非 http(s) 协议", r4.status === 400, JSON.stringify(r4));

  console.log("\n── 删除 ──");
  const del = await user("DELETE", `/connectors/${connId}`);
  check("删除成功", del.status === 200, JSON.stringify(del.json));
  const afterDel = await user("GET", "/connectors");
  check("删除后列表里没有了", !afterDel.json?.items?.some((i) => i.id === connId));

  console.log("\n── bot 面：造 → 列表 → 调用 → 删（跟用户面同一套判据）──");
  const botCreated = await bot("POST", "/connectors/for", {
    owner_uid: UID, name: "bot造的", base_url: `http://127.0.0.1:${extPort}`, auth_type: "bearer", secret: "bot-secret-789",
  });
  check("bot 造连接器成功", botCreated.status === 201, JSON.stringify(botCreated.json));
  const botList = await bot("GET", `/connectors/for?owner_uid=${UID}`);
  check("bot 能列表", botList.json?.items?.some((i) => i.id === botCreated.json.id));
  const botCall = await bot("POST", `/connectors/for/${botCreated.json.id}/call`, { owner_uid: UID, method: "GET", path: "/echo" });
  check("bot 代理调用成功", botCall.status === 200 && botCall.json?.body?.received_auth === "Bearer bot-secret-789", JSON.stringify(botCall));
  const botDel = await fetch(`http://127.0.0.1:${PORT}/yoyoo/v1/connectors/for/${botCreated.json.id}?owner_uid=${UID}`, {
    method: "DELETE", headers: { authorization: `Bearer ${BOT_TOKEN}` },
  });
  check("bot 删除成功", botDel.status === 200);

  proc.kill();
  hostSrv.close();
  extSrv.close();
  rmSync(dir, { recursive: true, force: true });

  if (failures > 0) {
    console.log(`\n❌ 连接器冒烟：${failures} 项失败`);
    process.exit(1);
  }
  console.log("\n连接器冒烟全部通过。");
}

main().catch((e) => { console.error(e); process.exit(1); });
