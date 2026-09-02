/**
 * 09-03「说明书机制 + AI 造/改/管应用与卡片」冒烟测试 —— 真起进程、真发 HTTP。
 *
 * 覆盖 SPEC-ai-manual-and-authoring.md §三、§四 新增的 bot 面接口：
 *   应用：POST /apps/for/:id（改）、DELETE /apps/for/:id（删）、
 *         POST /apps/for/:id/publish、GET /apps/for/market、
 *         POST /apps/for/market/:id/install
 *   卡片：POST /cards/for（造）、GET /cards/for（列表）、GET /cards/for/:id（详情）、
 *         POST /cards/for/:id（改）、DELETE /cards/for/:id（删）、
 *         POST /cards/for/:id/publish、GET /cards/for/market、
 *         POST /cards/for/market/:id/install
 *   说明书：GET /manual
 *
 * 不重复验证 smoke.mjs / market-smoke.mjs 已经验过的东西（应用创建、市场发布/
 * 安装的应用侧全套语义）——这里只验**新增的部分**，以及"应用和卡片走的是同一套
 * 判据"这件事本身（用几乎相同的步骤各走一遍，两边都要绿）。
 *
 * 用法：node server/bot-authoring-smoke.mjs
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BOT_TOKEN = "bf_test_bot";
const BOT_ROBOT_ID = "xiaoa_bot";
const SPACE_ID = "sp_test";
const OWNER_UID = "u_test_001";
const OWNER_B_UID = "u_test_002";
const PORT = 8794;

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✅ ${name}`);
  else { console.log(`  ❌ ${name} ${extra}`); failures++; }
}

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
        if (bearer === BOT_TOKEN) return json(res, 200, { robot_id: BOT_ROBOT_ID });
        return json(res, 401, { error: { code: "ErrBotAPIUnauthorized" } });
      }
      if (url.pathname.startsWith("/v1/bot/space/principals/")) {
        if (bearer !== BOT_TOKEN) return json(res, 401, {});
        if (url.searchParams.get("space_id") !== SPACE_ID) return json(res, 400, {});
        const target = decodeURIComponent(url.pathname.split("/").pop());
        if (target === OWNER_UID) return json(res, 200, { uid: OWNER_UID, principal_type: "human" });
        if (target === OWNER_B_UID) return json(res, 200, { uid: OWNER_B_UID, principal_type: "human" });
        return json(res, 404, {});
      }
      return json(res, 401, {});
    });
    srv.listen(0, () => resolve({ srv, port: srv.address().port }));
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function bot(method, path, body, token = BOT_TOKEN) {
  const res = await fetch(`http://127.0.0.1:${PORT}/yoyoo/v1${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let j = null;
  try { j = await res.json(); } catch { /* 空体或非 JSON（说明书是 markdown） */ }
  return { status: res.status, json: j };
}

async function raw(method, path, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
}

const goodBlueprint = { type: "page", children: [{ type: "text", value: "v1" }] };
const goodCard = { type: "AdaptiveCard", version: "1.5", body: [{ type: "TextBlock", text: "hi" }] };

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "yoyoo-bot-authoring-"));
  const dbPath = join(dir, "test.db");
  const { srv, port: hostPort } = await startFakeHost();

  const proc = spawn(process.execPath, [join(import.meta.dirname, "index.mjs")], {
    env: {
      ...process.env, PORT: String(PORT), DB_PATH: dbPath,
      HOST_VERIFY_URL: `http://127.0.0.1:${hostPort}/v1/user/current`,
      HOST_BOT_API_URL: `http://127.0.0.1:${hostPort}`,
      OCTO_SPACE_ID: SPACE_ID,
      YOYOO_BOT_ALLOWLIST: BOT_ROBOT_ID,
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  await wait(900);

  console.log("\n── 说明书：公开、无需鉴权 ──");
  const manual = await raw("GET", "/yoyoo/v1/manual");
  check("200", manual.status === 200);
  check("带版本号响应头", /^\d+$/.test(manual.headers.get("x-manual-version") || ""), `实际 ${manual.headers.get("x-manual-version")}`);
  check("内容里提到 Yoyoo 不是 OCTO 那句", manual.text.includes("不要说\"OCTO\""));
  check("Content-Type 是 markdown", (manual.headers.get("content-type") || "").includes("text/markdown"));

  // ══════════════════════════════════════════════════════════════
  console.log("\n── 应用：造 → 改 → 发布 → 逛市场 → 装 → 删 ──");

  const created = await bot("POST", "/apps/for", { owner_uid: OWNER_UID, name: "看板", icon: "📊", blueprint: goodBlueprint });
  check("造应用成功", created.status === 201, `实际 ${created.status} ${JSON.stringify(created.json)}`);
  const appId = created.json?.id;

  const editOtherApp = await bot("POST", `/apps/for/${appId}`, { owner_uid: OWNER_B_UID, blueprint: goodBlueprint });
  check("🔴 B 不能改 A 的应用 → 404（不能靠 owner_uid 越权改别人的）", editOtherApp.status === 404, `实际 ${editOtherApp.status}`);

  const edited = await bot("POST", `/apps/for/${appId}`, {
    owner_uid: OWNER_UID, name: "看板v2",
    blueprint: { type: "page", children: [{ type: "text", value: "v2" }] },
  });
  check("改应用成功", edited.status === 200, `实际 ${edited.status} ${JSON.stringify(edited.json)}`);

  const afterEdit = await bot("GET", `/apps/for/${appId}?owner_uid=${OWNER_UID}`);
  check("改动真的落库了", afterEdit.json?.blueprint?.children?.[0]?.value === "v2");
  check("只传 blueprint 不传 name 时，name 用改之前传的新值", afterEdit.json?.name === "看板v2");

  const editBadBlueprint = await bot("POST", `/apps/for/${appId}`, { owner_uid: OWNER_UID, blueprint: null });
  // blueprint:null 按"不传"处理（=== null 判断），应用原样不变，返回 200
  check("blueprint 传 null 视为不改，仍然 200", editBadBlueprint.status === 200);

  const published = await bot("POST", `/apps/for/${appId}/publish`, { owner_uid: OWNER_UID, summary: "一个看板应用" });
  check("发布成功", published.status === 201, `实际 ${published.status} ${JSON.stringify(published.json)}`);
  const listingId = published.json?.id;

  const republish = await bot("POST", `/apps/for/${appId}/publish`, { owner_uid: OWNER_UID, summary: "再发一次" });
  check("重复发布同一个应用 → 409（叫他发新版）", republish.status === 409, `实际 ${republish.status}`);

  const browse = await bot("GET", `/apps/for/market?owner_uid=${OWNER_B_UID}`);
  check("B 能逛到市场里的应用", browse.status === 200 && browse.json?.listings?.some((l) => l.id === listingId));
  check("市场列表不含 blueprint（逛市场不等于拿走实现）",
    browse.json.listings.every((l) => l.blueprint === undefined));

  const install = await bot("POST", `/apps/for/market/${listingId}/install`, { owner_uid: OWNER_B_UID });
  check("B 装成功", install.status === 201, `实际 ${install.status} ${JSON.stringify(install.json)}`);
  const installedAppId = install.json?.app_id;
  check("装出来是一条新的、不是作者那条", installedAppId && installedAppId !== appId);

  const bOpensInstalled = await bot("GET", `/apps/for/${installedAppId}?owner_uid=${OWNER_B_UID}`);
  check("B 能打开装来的应用，内容是发布时那份（v2）",
    bOpensInstalled.json?.blueprint?.children?.[0]?.value === "v2");

  const delOther = await bot("DELETE", `/apps/for/${appId}?owner_uid=${OWNER_B_UID}`);
  check("🔴 B 不能删 A 的应用 → 404", delOther.status === 404, `实际 ${delOther.status}`);

  const del = await bot("DELETE", `/apps/for/${appId}?owner_uid=${OWNER_UID}`);
  check("删应用成功", del.status === 200, `实际 ${del.status}`);
  const afterDel = await bot("GET", `/apps/for/${appId}?owner_uid=${OWNER_UID}`);
  check("删掉之后再取 → 404", afterDel.status === 404);
  check("🔴 B 装的那份没受影响（安装是复制，不是活引用）",
    (await bot("GET", `/apps/for/${installedAppId}?owner_uid=${OWNER_B_UID}`)).status === 200);

  // ══════════════════════════════════════════════════════════════
  console.log("\n── 卡片：造 → 列表 → 改 → 发布 → 逛市场 → 装 → 删（跟应用同一套判据）──");

  const badCard = await bot("POST", "/cards/for", { owner_uid: OWNER_UID, name: "坏卡片", card: { version: "1.5" } });
  check("造卡片时结构不合法 → 400（走的是 card-store 的收敛器）", badCard.status === 400, `实际 ${badCard.status}`);

  const cardCreated = await bot("POST", "/cards/for", { owner_uid: OWNER_UID, name: "打卡卡片", icon: "📇", card: goodCard });
  check("造卡片成功", cardCreated.status === 201, `实际 ${cardCreated.status} ${JSON.stringify(cardCreated.json)}`);
  const cardId = cardCreated.json?.id;
  check("provenance 记为 ai", cardCreated.json?.created_by === "ai");
  check("卡片没有深链（url 是 null）", cardCreated.json?.url === null);

  const cardList = await bot("GET", `/cards/for?owner_uid=${OWNER_UID}`);
  check("列表能看到刚造的卡片", cardList.json?.items?.some((c) => c.id === cardId));

  const cardGot = await bot("GET", `/cards/for/${cardId}?owner_uid=${OWNER_UID}`);
  check("详情拿到的 card 是对象且内容对", cardGot.json?.card?.body?.[0]?.text === "hi");

  const cardEdited = await bot("POST", `/cards/for/${cardId}`, {
    owner_uid: OWNER_UID,
    card: { type: "AdaptiveCard", version: "1.5", body: [{ type: "TextBlock", text: "v2" }] },
  });
  check("改卡片成功", cardEdited.status === 200, `实际 ${cardEdited.status}`);
  const cardEditBad = await bot("POST", `/cards/for/${cardId}`, { owner_uid: OWNER_UID, card: { version: "x" } });
  check("改成不合法结构 → 400（编辑同样过收敛器，不是只在创建时查一次）", cardEditBad.status === 400);

  const cardPublished = await bot("POST", `/cards/for/${cardId}/publish`, { owner_uid: OWNER_UID, summary: "一张打卡卡片" });
  check("卡片发布成功", cardPublished.status === 201, `实际 ${cardPublished.status} ${JSON.stringify(cardPublished.json)}`);
  const cardListingId = cardPublished.json?.id;

  const cardBrowse = await bot("GET", `/cards/for/market?owner_uid=${OWNER_B_UID}`);
  check("B 能逛到市场里的卡片", cardBrowse.status === 200 && cardBrowse.json?.listings?.some((l) => l.id === cardListingId));

  const appBrowseFromCardMarket = await bot("GET", `/apps/for/market?owner_uid=${OWNER_B_UID}`);
  check("🔴 应用市场里看不到卡片（kind 隔开了两种货架）",
    !appBrowseFromCardMarket.json.listings.some((l) => l.id === cardListingId));

  const cardInstall = await bot("POST", `/cards/for/market/${cardListingId}/install`, { owner_uid: OWNER_B_UID });
  check("B 装卡片成功", cardInstall.status === 201, `实际 ${cardInstall.status}`);
  const installedCardId = cardInstall.json?.app_id;

  const bOpensCard = await bot("GET", `/cards/for/${installedCardId}?owner_uid=${OWNER_B_UID}`);
  check("B 能打开装来的卡片，内容是发布时那份（v2）", bOpensCard.json?.card?.body?.[0]?.text === "v2");

  const cardDel = await bot("DELETE", `/cards/for/${cardId}?owner_uid=${OWNER_UID}`);
  check("删卡片成功", cardDel.status === 200);
  check("删掉之后再取 → 404", (await bot("GET", `/cards/for/${cardId}?owner_uid=${OWNER_UID}`)).status === 404);
  check("🔴 B 装的那份卡片没受影响", (await bot("GET", `/cards/for/${installedCardId}?owner_uid=${OWNER_B_UID}`)).status === 200);

  // ══════════════════════════════════════════════════════════════
  console.log("\n── 越权与白名单（应用/卡片两边各抽一条，不重复验 bot-auth 全套）──");
  const noToken = await bot("GET", "/cards/for?owner_uid=" + OWNER_UID, undefined, "");
  check("不带 token 造卡片路径也拦 → 401", noToken.status === 401, `实际 ${noToken.status}`);

  console.log("\n── 重启后卡片也还在（跟应用同一条 P1 判据）──");
  proc.kill();
  await wait(300);
  const proc2 = spawn(process.execPath, [join(import.meta.dirname, "index.mjs")], {
    env: {
      ...process.env, PORT: String(PORT), DB_PATH: dbPath,
      HOST_VERIFY_URL: `http://127.0.0.1:${hostPort}/v1/user/current`,
      HOST_BOT_API_URL: `http://127.0.0.1:${hostPort}`,
      OCTO_SPACE_ID: SPACE_ID,
      YOYOO_BOT_ALLOWLIST: BOT_ROBOT_ID,
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  await wait(900);
  const afterRestart = await bot("GET", `/cards/for/${installedCardId}?owner_uid=${OWNER_B_UID}`);
  check("重启后 B 装的卡片还在、还能打开", afterRestart.status === 200 && afterRestart.json?.card?.body?.[0]?.text === "v2");

  proc2.kill();
  srv.close();
  rmSync(dir, { recursive: true, force: true });

  if (failures > 0) {
    console.log(`\n\x1b[31m${failures} 项失败。\x1b[0m`);
    process.exit(1);
  }
  console.log("\n\x1b[32m全部通过。\x1b[0m");
}

main().catch((e) => { console.error(e); process.exit(1); });
