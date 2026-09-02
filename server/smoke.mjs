/**
 * 后端冒烟测试 —— 真起进程、真发 HTTP、真落盘。
 *
 * 重点验的不是"接口返回 200"，而是 P1 的那条判据：
 *   **把服务重启一次，应用还在、还能打开。**
 * 所以第 6 步会杀掉进程、用同一个 db 文件重新起一遍，再查一次。
 * 只在同一个进程里 CRUD 是证明不了"可反复打开"的 —— 那可能只是内存里的假象。
 *
 * 用法：node server/smoke.mjs
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOKEN = "test-token-abc";
const UID = "u_test_001";

// bot 面用的假身份。故意让"规范 uid"与请求里带的 uid 不同（大小写），
// 以此验证我们入库时用的是**宿主返回的那个**，不是请求里那个。
const BOT_TOKEN = "bf_test_bot";
const BOT_ROBOT_ID = "xiaoa_bot";
const OTHER_BOT_TOKEN = "bf_test_other";     // 有效 token，但不在白名单
const OTHER_ROBOT_ID = "somebody_else_bot";
const SPACE_ID = "sp_test";
const OWNER_UID_CANONICAL = UID;
const OWNER_UID_AS_SENT = UID.toUpperCase();  // 调用方写成大写，宿主规范化回小写
const A_BOT_UID = "u_bot_999";                // principal_type = user_bot，不许给它造应用

let failures = 0;

function check(name, cond, extra = "") {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    console.log(`  ❌ ${name} ${extra}`);
    failures++;
  }
}

/**
 * 假宿主。模拟 OCTO 的三个我们真正依赖的端点：
 *   · GET  /v1/user/current               用户面身份（session token）
 *   · POST /v1/bot/register               bot token → robot_id
 *   · GET  /v1/bot/space/principals/:uid  同 Space 成员 + human/user_bot 判定
 *
 * 关键行为都照抄真实语义（都是读它源码 + 测试机实打确认过的）：
 *   · bot 面认 `Authorization: Bearer`，用户面认 `token:` —— 两面不通用
 *   · principals 把"不存在/不在这个 Space/没权限"**收敛成同一个 404**
 *   · principals 返回**规范化后**的 uid
 */
function startFakeHost() {
  const json = (res, code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      const url = new URL(req.url, "http://x");
      const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");

      if (url.pathname === "/v1/bot/register") {
        if (bearer === BOT_TOKEN) return json(res, 200, { robot_id: BOT_ROBOT_ID, name: "小A" });
        if (bearer === OTHER_BOT_TOKEN) return json(res, 200, { robot_id: OTHER_ROBOT_ID });
        return json(res, 401, { error: { code: "ErrBotAPIUnauthorized" } });
      }

      if (url.pathname.startsWith("/v1/bot/space/principals/")) {
        if (bearer !== BOT_TOKEN && bearer !== OTHER_BOT_TOKEN) {
          return json(res, 401, { error: { code: "ErrBotAPIUnauthorized" } });
        }
        if (url.searchParams.get("space_id") !== SPACE_ID) {
          return json(res, 400, { error: { code: "ErrBotAPIRequestInvalid" } });
        }
        const target = decodeURIComponent(url.pathname.split("/").pop());
        if (target.toLowerCase() === OWNER_UID_CANONICAL) {
          return json(res, 200, { uid: OWNER_UID_CANONICAL, principal_type: "human" });
        }
        if (target === A_BOT_UID) {
          return json(res, 200, { uid: A_BOT_UID, principal_type: "user_bot" });
        }
        return json(res, 404, { error: { code: "ErrBotAPIUserNotFound" } });
      }

      // 用户面
      const t = req.headers.token || req.headers.authorization;
      if (t !== TOKEN) return json(res, 401, {});
      return json(res, 200, { uid: UID, name: "测试用户" });
    });
    srv.listen(0, () => resolve({ srv, port: srv.address().port }));
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(port, method, path, body, token = TOKEN) {
  const res = await fetch(`http://127.0.0.1:${port}/yoyoo/v1${path}`, {
    method,
    headers: {
      token,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 空响应体 */
  }
  return { status: res.status, json };
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "yoyoo-smoke-"));
  const dbPath = join(dir, "test.db");
  const { srv, port: hostPort } = await startFakeHost();
  const PORT = 8791; // 固定端口，避免解析随机端口的麻烦

  const boot = (extraEnv = {}) =>
    spawn(process.execPath, [join(import.meta.dirname, "index.mjs")], {
      env: { ...process.env, PORT: String(PORT), DB_PATH: dbPath,
             HOST_VERIFY_URL: `http://127.0.0.1:${hostPort}/v1/user/current`,
             HOST_BOT_API_URL: `http://127.0.0.1:${hostPort}`,
             OCTO_SPACE_ID: SPACE_ID,
             YOYOO_BOT_ALLOWLIST: BOT_ROBOT_ID,
             APP_DEEP_LINK: "https://example.test/superapp?app={id}",
             ...extraEnv },
      stdio: ["ignore", "ignore", "inherit"],
    });

  /** 打 bot 面（Bearer），不带用户 session */
  const botApi = async (path, body, token = BOT_TOKEN) => {
    const res = await fetch(`http://127.0.0.1:${PORT}/yoyoo/v1${path}`, {
      method: "POST",
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "content-type": "application/json",
      },
      body: JSON.stringify(body ?? {}),
    });
    let json = null;
    try { json = await res.json(); } catch { /* 空体 */ }
    return { status: res.status, json };
  };

  console.log("\n── 第一次启动 ──");
  let proc = boot();
  await wait(900);

  const health = await api(PORT, "GET", "/health");
  check("健康检查", health.status === 200 && health.json?.ok === true);

  const noAuth = await api(PORT, "GET", "/apps", null, "wrong-token");
  check("坏 token 被拒（401）", noAuth.status === 401, `实际 ${noAuth.status}`);

  const empty = await api(PORT, "GET", "/apps");
  check("初始列表为空", empty.status === 200 && empty.json.apps.length === 0);

  const created = await api(PORT, "POST", "/apps", {
    name: "我的第一个应用",
    icon: "🧪",
    created_by: "ai",
    blueprint: { type: "page", children: [{ type: "text", value: "hello" }] },
  });
  check("创建应用（201）", created.status === 201, `实际 ${created.status}`);
  check("provenance 记为 ai", created.json?.created_by === "ai");
  const appId = created.json?.id;

  const got = await api(PORT, "GET", `/apps/${appId}`);
  check("能取回详情且 blueprint 是对象",
    got.status === 200 && got.json?.blueprint?.children?.[0]?.value === "hello");

  const noBp = await api(PORT, "POST", "/apps", { name: "缺蓝图" });
  check("缺 blueprint 被拒（400）", noBp.status === 400, `实际 ${noBp.status}`);

  console.log("\n── 一句话生成一个应用 ──");
  const noPrompt = await api(PORT, "POST", "/apps/generate", {});
  check("缺 prompt 被拒（400）", noPrompt.status === 400, `实际 ${noPrompt.status}`);

  const gen = await api(PORT, "POST", "/apps/generate", { prompt: "本周订单统计表" });
  check("生成成功（201）", gen.status === 201, `实际 ${gen.status}`);
  check("未配密钥时回退本地生成", gen.json?.mode === "local", `mode=${gen.json?.mode}`);
  check("产物根节点是 page 且有内容",
    gen.json?.blueprint?.type === "page" && gen.json.blueprint.children?.length > 0);
  check("路由没被 /apps/:id 抢走（不是 404）", gen.status !== 404);

  const listWithGen = await api(PORT, "GET", "/apps");
  check("生成的应用进了列表且标记为 ai 造",
    listWithGen.json.apps.some((a) => a.id === gen.json?.id && a.created_by === "ai"));

  await api(PORT, "DELETE", `/apps/${gen.json?.id}`); // 清掉，免得影响后面的计数

  console.log("\n── bot 面：AI 替某个人造应用（/apps/for）──");
  const goodBlueprint = {
    type: "page",
    children: [
      { type: "heading", value: "磁盘看板", level: 2 },
      { type: "table", columns: ["机器", "用量"], rows: [["展厅", "61%"]] },
    ],
  };

  // —— 三步鉴权，每一步一条否定用例 ——
  const noTok = await botApi("/apps/for", { owner_uid: OWNER_UID_AS_SENT, blueprint: goodBlueprint }, "");
  check("① 不带 bot token → 401", noTok.status === 401, `实际 ${noTok.status}`);

  const badTok = await botApi("/apps/for", { owner_uid: OWNER_UID_AS_SENT, blueprint: goodBlueprint }, "bf_wrong");
  check("① 坏 bot token → 401", badTok.status === 401, `实际 ${badTok.status}`);

  const notAllowed = await botApi(
    "/apps/for", { owner_uid: OWNER_UID_AS_SENT, blueprint: goodBlueprint }, OTHER_BOT_TOKEN);
  check("② 合法 token 但不在白名单 → 403", notAllowed.status === 403, `实际 ${notAllowed.status}`);

  const stranger = await botApi("/apps/for", { owner_uid: "u_stranger", blueprint: goodBlueprint });
  check("③ owner 不在同一个 Space → 403", stranger.status === 403, `实际 ${stranger.status}`);

  const toBot = await botApi("/apps/for", { owner_uid: A_BOT_UID, blueprint: goodBlueprint });
  check("③ owner 是个 bot → 403（不给 bot 名下造应用）", toBot.status === 403, `实际 ${toBot.status}`);

  const noOwner = await botApi("/apps/for", { blueprint: goodBlueprint });
  check("缺 owner_uid → 400", noOwner.status === 400, `实际 ${noOwner.status}`);

  const noBpBot = await botApi("/apps/for", { owner_uid: OWNER_UID_AS_SENT });
  check("缺 blueprint → 400", noBpBot.status === 400, `实际 ${noBpBot.status}`);

  const wrongMethod = await fetch(`http://127.0.0.1:${PORT}/yoyoo/v1/apps/for`, {
    method: "GET", headers: { authorization: `Bearer ${BOT_TOKEN}` },
  });
  check("GET /apps/for → 405（没被当成应用 id 去查，那样会是 404/401）",
    wrongMethod.status === 405, `实际 ${wrongMethod.status}`);

  // —— 正路 ——
  const made = await botApi("/apps/for", {
    owner_uid: OWNER_UID_AS_SENT, name: "磁盘看板", icon: "📊", blueprint: goodBlueprint,
  });
  check("AI 造应用成功（201）", made.status === 201, `实际 ${made.status} ${JSON.stringify(made.json)}`);
  check("owner 用的是宿主返回的规范 uid（不是请求里那个大写的）",
    made.json?.owner_uid === OWNER_UID_CANONICAL, `实际 ${made.json?.owner_uid}`);
  check("provenance 记为 ai", made.json?.created_by === "ai");
  check("返回可点开的深链", typeof made.json?.url === "string" && made.json.url.includes(made.json.id));
  const madeId = made.json?.id;

  // 这条是整件事的意义所在：AI 造的东西，用户用**自己的**身份就能看到、能打开
  const ownerList = await api(PORT, "GET", "/apps");
  check("用户自己的列表里能看到这个应用",
    ownerList.json.apps.some((a) => a.id === madeId && a.created_by === "ai"));
  const ownerOpen = await api(PORT, "GET", `/apps/${madeId}`);
  check("用户能打开它、内容是 AI 写的那份",
    ownerOpen.status === 200 && ownerOpen.json?.blueprint?.children?.[0]?.value === "磁盘看板");

  // AI 产的 JSON 一样要过收敛器
  const dirty = await botApi("/apps/for", {
    owner_uid: OWNER_UID_AS_SENT, name: "畸形",
    blueprint: { type: "page", children: [{ type: "Carousel3D", title: "不认识的组件" }] },
  });
  check("AI 写错组件名 → 降级成 text 而不是报错", dirty.status === 201, `实际 ${dirty.status}`);
  const dirtyOpen = await api(PORT, "GET", `/apps/${dirty.json?.id}`);
  check("降级后内容保住了",
    dirtyOpen.json?.blueprint?.children?.[0]?.type === "text" &&
    dirtyOpen.json?.blueprint?.children?.[0]?.value === "不认识的组件");
  await api(PORT, "DELETE", `/apps/${dirty.json?.id}`);

  const emptyBp = await botApi("/apps/for", { owner_uid: OWNER_UID_AS_SENT, blueprint: { type: "page", children: [] } });
  check("空 blueprint → 400（不许造一个空壳应用）", emptyBp.status === 400, `实际 ${emptyBp.status}`);

  console.log("\n── 杀掉进程，用同一个库重启（P1 的核心判据）──");
  proc.kill("SIGKILL");
  await wait(400);
  proc = boot();
  await wait(900);

  const after = await api(PORT, "GET", "/apps");
  check("重启后列表还在", after.status === 200 && after.json.apps.length === 2,
    `实际 ${after.json?.apps?.length}`);
  const reopened = await api(PORT, "GET", `/apps/${appId}`);
  check("重启后应用还能打开、内容一致",
    reopened.status === 200 && reopened.json?.blueprint?.children?.[0]?.value === "hello");
  const reopenedAi = await api(PORT, "GET", `/apps/${madeId}`);
  check("重启后 AI 造的那个也还在（这条是苏白要的'重启后还在'）",
    reopenedAi.status === 200 && reopenedAi.json?.created_by === "ai");

  console.log("\n── 白名单没配时必须全拒（fail-closed）──");
  proc.kill("SIGKILL");
  await wait(400);
  proc = boot({ YOYOO_BOT_ALLOWLIST: "" });
  await wait(900);
  const closed = await botApi("/apps/for", { owner_uid: OWNER_UID_AS_SENT, blueprint: goodBlueprint });
  check("没配白名单 → 503，绝不放行", closed.status === 503, `实际 ${closed.status}`);
  const stillWorks = await api(PORT, "GET", "/apps");
  check("但用户面不受影响（只关 bot 面这一条路）", stillWorks.status === 200);
  proc.kill("SIGKILL");
  await wait(400);
  proc = boot();
  await wait(900);
  await api(PORT, "DELETE", `/apps/${madeId}`);

  console.log("\n── 隔离性 ──");
  const otherUser = await fetch(`http://127.0.0.1:${PORT}/yoyoo/v1/apps/${appId}`, {
    headers: { token: "wrong-token" },
  });
  check("别人的 token 拿不到我的应用", otherUser.status === 401);

  const del = await api(PORT, "DELETE", `/apps/${appId}`);
  check("删除成功", del.status === 200);
  const gone = await api(PORT, "GET", "/apps");
  check("删除后列表为空", gone.json.apps.length === 0);

  proc.kill("SIGKILL");
  srv.close();
  rmSync(dir, { recursive: true, force: true });

  console.log(
    failures === 0
      ? "\n\x1b[32m全部通过。\x1b[0m\n"
      : `\n\x1b[31m${failures} 项失败。\x1b[0m\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
