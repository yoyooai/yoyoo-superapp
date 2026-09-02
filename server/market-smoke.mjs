/**
 * 市场后端冒烟 —— 真起进程、真发 HTTP、真落盘。SPEC-market §6。
 *
 * 两条重点判据（不是"接口返回 200"）：
 *  1. **快照不可变**：作者发布后把自己的应用改坏，listing 那一版的蓝图逐字节不变。
 *     这条防的就是 §2.1 那个坑 —— 活引用会让作者一手把所有安装者一起改坏。
 *  2. **安装 = 复制到你名下**：安装者改自己那份，作者那份和 listing 都不动。
 *
 * 另外把 §6 的否定用例全部钉在这里：未登录 401 / 非作者 403 / 装下架的 404 /
 * 装不存在的 404 / 钉超过 6 个 400 / 重复安装不产生第二份 / 发布带私货被拦 409。
 *
 * 用法：node server/market-smoke.mjs
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SPACE_ID = "sp_test";
// 两个用户：A 是作者，B 是安装者。市场的意义只有在"两个人"之间才成立。
const USERS = { "tok-a": "u_author", "tok-b": "u_buyer" };
const A = "tok-a";
const B = "tok-b";

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    console.log(`  ❌ ${name} ${extra}`);
    failures++;
  }
}

function startFakeHost() {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      const t = String(req.headers.token || req.headers.authorization || "");
      const uid = USERS[t];
      res.writeHead(uid ? 200 : 401, { "content-type": "application/json" });
      res.end(JSON.stringify(uid ? { uid, name: uid } : {}));
    });
    srv.listen(0, () => resolve({ srv, port: srv.address().port }));
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 8792;

async function api(method, path, body, token = A) {
  const res = await fetch(`http://127.0.0.1:${PORT}/yoyoo/v1${path}`, {
    method,
    headers: { ...(token ? { token } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* 空体 */ }
  return { status: res.status, json };
}

const page = (text) => ({ type: "page", children: [{ type: "text", value: text }] });

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "yoyoo-market-"));
  const dbPath = join(dir, "market.db");
  const { srv, port: hostPort } = await startFakeHost();

  // 主流程本身要发好几次布，用生产默认的 3 次/分钟会被自己的限流卡住。
  // 所以正常流程放宽额度，"限流真的会拦"单独起一个进程去验（见最后一节）。
  const boot = (extraEnv = {}) =>
    spawn(process.execPath, [join(import.meta.dirname, "index.mjs")], {
      env: {
        ...process.env,
        YOYOO_PUBLISH_MAX: "100",
        ...extraEnv,
        PORT: String(PORT),
        DB_PATH: dbPath,
        HOST_VERIFY_URL: `http://127.0.0.1:${hostPort}/v1/user/current`,
        HOST_BOT_API_URL: `http://127.0.0.1:${hostPort}`,
        OCTO_SPACE_ID: SPACE_ID,
        YOYOO_BOT_ALLOWLIST: "none",
        APP_DEEP_LINK: "https://example.test/superapp?app={id}",
      },
      stdio: ["ignore", "ignore", "inherit"],
    });

  let proc = boot();
  await wait(900);

  console.log("\n── 鉴权：市场也要求登录 ──");
  const anon = await api("GET", "/market/listings", null, "");
  check("未登录逛市场 → 401", anon.status === 401, `实际 ${anon.status}`);
  const anonPin = await api("GET", "/pins", null, "bad-token");
  check("坏 token 读钉位 → 401", anonPin.status === 401, `实际 ${anonPin.status}`);

  console.log("\n── 作者发布 ──");
  const mk = await api("POST", "/apps", { name: "订单看板", icon: "📊", blueprint: page("v1 内容") }, A);
  check("作者建了个应用", mk.status === 201, `实际 ${mk.status}`);
  const appA = mk.json?.id;

  const noSummary = await api("POST", "/market/listings", { app_id: appA }, A);
  check("发布缺简介 → 400", noSummary.status === 400, `实际 ${noSummary.status}`);

  const notMine = await api("POST", "/market/listings", { app_id: "no-such-app", summary: "x" }, A);
  check("发布一个不存在的应用 → 404", notMine.status === 404, `实际 ${notMine.status}`);

  const pub = await api("POST", "/market/listings", { app_id: appA, summary: "看今天的订单" }, A);
  check("发布成功（201）", pub.status === 201, `实际 ${pub.status} ${JSON.stringify(pub.json)}`);
  check("首版是 v1", pub.json?.version === 1);
  const listingId = pub.json?.id;

  const dup = await api("POST", "/market/listings", { app_id: appA, summary: "再发一次" }, A);
  check("同一个应用重复上架 → 409（叫他发新版）", dup.status === 409, `实际 ${dup.status}`);

  console.log("\n── 私货扫描：不可逆动作的门 ──");
  const dirty = await api("POST", "/apps", {
    name: "带私货的应用",
    blueprint: page("内网 10.0.0.9，key=sk-abcdefghijklmnopqrstuvwxyz01"),
  }, A);
  const dirtyId = dirty.json?.id;
  const blocked = await api("POST", "/market/listings", { app_id: dirtyId, summary: "内部用" }, A);
  check("蓝图里有私货 → 409 拦下", blocked.status === 409 && blocked.json?.error === "sensitive_content",
    `实际 ${blocked.status} ${JSON.stringify(blocked.json)}`);
  check("如实告诉他命中了什么", Array.isArray(blocked.json?.hits) && blocked.json.hits.length >= 2,
    JSON.stringify(blocked.json?.hits));
  check("命中项不回显原文（打了码）",
    !JSON.stringify(blocked.json).includes("sk-abcdefghijklmnopqrstuvwxyz01"));
  const confirmed = await api("POST", "/market/listings",
    { app_id: dirtyId, summary: "内部用", confirm_sensitive: true }, A);
  check("作者显式确认后可以发（我们不替他决定）", confirmed.status === 201, `实际 ${confirmed.status}`);
  await api("DELETE", `/market/listings/${confirmed.json?.id}`, null, A); // 下架，免得干扰后面计数

  console.log("\n── 逛市场：不下发蓝图 ──");
  const browse = await api("GET", "/market/listings", null, B);
  check("B 能看到 A 发的东西", browse.status === 200 && browse.json.listings.some((l) => l.id === listingId));
  const card = browse.json.listings.find((l) => l.id === listingId);
  check("🔴 列表里没有 blueprint 字段（逛≠拿走实现）", card && !("blueprint" in card), JSON.stringify(Object.keys(card || {})));
  check("列表带来源标记（human/ai）", card?.created_by === "human", `实际 ${card?.created_by}`);
  check("未安装时 installed=false", card?.installed === false);

  const detail = await api("GET", `/market/listings/${listingId}`, null, B);
  check("详情也不含 blueprint", detail.status === 200 && !("blueprint" in detail.json));
  check("详情带版本历史", Array.isArray(detail.json?.versions) && detail.json.versions.length === 1);
  check("B 不是作者", detail.json?.is_author === false);

  const noSuch = await api("GET", "/market/listings/00000000-0000-0000-0000-000000000000", null, B);
  check("不存在的 listing → 404", noSuch.status === 404, `实际 ${noSuch.status}`);

  console.log("\n── 安装 = 复制到你名下 ──");
  const inst = await api("POST", `/market/listings/${listingId}/install`, {}, B);
  check("安装成功（201）", inst.status === 201, `实际 ${inst.status} ${JSON.stringify(inst.json)}`);
  const appB = inst.json?.app_id;
  check("装出来的是一条新应用（不是作者那条）", appB && appB !== appA);
  check("安装数变 1", inst.json?.installs === 1, `实际 ${inst.json?.installs}`);

  const openB = await api("GET", `/apps/${appB}`, null, B);
  check("B 能打开它，内容是 v1", openB.status === 200 && openB.json?.blueprint?.children?.[0]?.value === "v1 内容");
  check("B 那条记着来源", openB.json?.source_listing_id === listingId && openB.json?.source_version === 1);

  const crossOpen = await api("GET", `/apps/${appB}`, null, A);
  check("A 打不开 B 装的那份（各自名下）", crossOpen.status === 404, `实际 ${crossOpen.status}`);

  const again = await api("POST", `/market/listings/${listingId}/install`, {}, B);
  check("重复安装 → 返回同一条，不产生第二份",
    again.status === 200 && again.json?.app_id === appB && again.json?.already === true,
    JSON.stringify(again.json));
  const bList = await api("GET", "/apps", null, B);
  check("B 名下只有一条", bList.json.apps.length === 1, `实际 ${bList.json.apps.length}`);

  console.log("\n── 快照不可变（§2.1 那个坑）──");
  await api("PUT", `/apps/${appA}`, { blueprint: page("作者把它改坏了") }, A);
  const stillV1 = await api("POST", `/market/listings/${listingId}/install`, {}, B);
  check("作者改自己的应用后，B 那份没被动过",
    (await api("GET", `/apps/${appB}`, null, B)).json?.blueprint?.children?.[0]?.value === "v1 内容");
  const detail2 = await api("GET", `/market/listings/${listingId}`, null, B);
  check("listing 还停在 v1（改应用不等于发新版）", detail2.json?.version === 1, `实际 ${detail2.json?.version}`);
  check("重复安装仍幂等", stillV1.status === 200);

  console.log("\n── 发新版 = 通知，不是推送（§2.3）──");
  const byOther = await api("POST", `/market/listings/${listingId}/versions`, { note: "偷发" }, B);
  check("非作者发新版 → 403", byOther.status === 403, `实际 ${byOther.status}`);

  const v2 = await api("POST", `/market/listings/${listingId}/versions`, { note: "改了标题" }, A);
  check("作者发 v2 成功", v2.status === 201 && v2.json?.version === 2, `实际 ${JSON.stringify(v2.json)}`);

  const bList2 = await api("GET", "/apps", null, B);
  check("B 的列表提示「有更新」（但内容没被改）",
    bList2.json.apps[0]?.update_available === true, JSON.stringify(bList2.json.apps[0]));
  const bStill = await api("GET", `/apps/${appB}`, null, B);
  check("🔴 没点更新之前，B 的内容仍是 v1（没有被推送）",
    bStill.json?.blueprint?.children?.[0]?.value === "v1 内容");

  const synced = await api("POST", `/apps/${appB}/sync`, {}, B);
  check("B 点了更新 → 200 且真的更新了", synced.status === 200 && synced.json?.updated === true,
    JSON.stringify(synced.json));
  const bAfter = await api("GET", `/apps/${appB}`, null, B);
  check("更新后拿到的是作者当前那份", bAfter.json?.blueprint?.children?.[0]?.value === "作者把它改坏了");
  const syncAgain = await api("POST", `/apps/${appB}/sync`, {}, B);
  check("已是最新时再点 → updated=false（不报错）",
    syncAgain.status === 200 && syncAgain.json?.updated === false);

  const reverted = await api("POST", `/apps/${appB}/revert`, {}, B);
  check("一键回退到更新前那份", reverted.status === 200, `实际 ${reverted.status}`);
  const bReverted = await api("GET", `/apps/${appB}`, null, B);
  check("回退后内容回到 v1", bReverted.json?.blueprint?.children?.[0]?.value === "v1 内容",
    bReverted.json?.blueprint?.children?.[0]?.value);
  const revertTwice = await api("POST", `/apps/${appB}/revert`, {}, B);
  check("没有备份时回退 → 404（不静默成功）", revertTwice.status === 404, `实际 ${revertTwice.status}`);

  const ownApp = await api("POST", "/apps", { name: "自己造的", blueprint: page("x") }, B);
  const syncOwn = await api("POST", `/apps/${ownApp.json?.id}/sync`, {}, B);
  check("自己造的应用点更新 → 400（没有来源）", syncOwn.status === 400, `实际 ${syncOwn.status}`);

  console.log("\n── 侧栏钉位（上限 6）──");
  const pins0 = await api("GET", "/pins", null, B);
  check("初始没有钉位，且回报上限", pins0.json?.pins.length === 0 && pins0.json?.limit === 6);
  const pinOk = await api("PUT", "/pins", { app_ids: [appB] }, B);
  check("钉一个成功", pinOk.status === 200 && pinOk.json.pins.length === 1, `实际 ${pinOk.status}`);
  const pinOther = await api("PUT", "/pins", { app_ids: [appA] }, B);
  check("钉别人名下的应用 → 404（不许钉出打不开的图标）", pinOther.status === 404, `实际 ${pinOther.status}`);
  const tooMany = await api("PUT", "/pins", { app_ids: ["1", "2", "3", "4", "5", "6", "7"] }, B);
  check("钉 7 个 → 400（上限 6）", tooMany.status === 400, `实际 ${tooMany.status}`);
  const listPinned = await api("GET", "/apps", null, B);
  check("列表里带 pinned 标记", listPinned.json.apps.find((a) => a.id === appB)?.pinned === true);

  console.log("\n── 下架：不删数据，已装的人不受影响（§5.6）──");
  const delistByOther = await api("DELETE", `/market/listings/${listingId}`, null, B);
  check("非作者下架 → 403", delistByOther.status === 403, `实际 ${delistByOther.status}`);
  const delist = await api("DELETE", `/market/listings/${listingId}`, null, A);
  check("作者下架成功", delist.status === 200);
  const browse2 = await api("GET", "/market/listings", null, B);
  check("下架后不再出现在列表里", !browse2.json.listings.some((l) => l.id === listingId));
  const detail3 = await api("GET", `/market/listings/${listingId}`, null, B);
  check("下架的详情 → 404（不泄露'存在但下架'）", detail3.status === 404, `实际 ${detail3.status}`);
  const installDelisted = await api("POST", `/market/listings/${listingId}/install`, {}, B);
  check("装下架的 → 404", installDelisted.status === 404, `实际 ${installDelisted.status}`);
  const bStillHas = await api("GET", `/apps/${appB}`, null, B);
  check("🔴 已装的人照样能打开（他那份是副本）", bStillHas.status === 200);

  console.log("\n── 删掉装来的应用后，重装要能正常（那个残留洞）──");
  // 先恢复上架，才能验重装
  const pub2 = await api("POST", "/market/listings", { app_id: appA, summary: "再上架" }, A);
  check("重新上架成功（下架后可再发）", pub2.status === 201, `实际 ${pub2.status} ${JSON.stringify(pub2.json)}`);
  const l2 = pub2.json?.id;
  const i2 = await api("POST", `/market/listings/${l2}/install`, {}, B);
  check("B 装了新 listing", i2.status === 201);
  await api("DELETE", `/apps/${i2.json?.app_id}`, null, B);
  const reinstall = await api("POST", `/market/listings/${l2}/install`, {}, B);
  check("🔴 删掉后重装 → 拿到一条新的可用应用（不是已删的旧 id）",
    reinstall.status === 201 && reinstall.json?.app_id !== i2.json?.app_id,
    JSON.stringify(reinstall.json));
  const reopened = await api("GET", `/apps/${reinstall.json?.app_id}`, null, B);
  check("重装的能打开", reopened.status === 200);
  check("删应用时钉位也清了", !(await api("GET", "/pins", null, B)).json.pins.some((p) => p.app_id === i2.json?.app_id));

  console.log("\n── 限流（单独起一个额度=2 的进程验它真的会拦）──");
  proc.kill("SIGKILL");
  await wait(400);
  proc = boot({ YOYOO_PUBLISH_MAX: "2" });
  await wait(900);
  const codes = [];
  for (let i = 0; i < 4; i++) {
    const r = await api("POST", `/market/listings/${l2}/versions`, { note: `v${i}` }, A);
    codes.push(r.status);
  }
  check("前两次放行、之后 429", codes[0] === 201 && codes[1] === 201 && codes[2] === 429,
    `实际 ${codes.join(",")}`);

  const blocked2 = await api("POST", "/market/listings", { app_id: dirtyId, summary: "带私货" }, B);
  check("限流是按人算的（B 不受 A 的额度影响）", blocked2.status !== 429, `实际 ${blocked2.status}`);

  console.log("\n── 被拦下的发布不扣额度（作者的谨慎不该被惩罚）──");
  proc.kill("SIGKILL");
  await wait(400);
  proc = boot({ YOYOO_PUBLISH_MAX: "2" });
  await wait(900);
  const mkDirty = await api("POST", "/apps", {
    name: "又一个带私货的", blueprint: page("token=sk-zzzzzzzzzzzzzzzzzzzzzz"),
  }, B);
  for (let i = 0; i < 3; i++) {
    const r = await api("POST", "/market/listings", { app_id: mkDirty.json?.id, summary: "试" }, B);
    if (r.status !== 409) { check(`第 ${i + 1} 次被拦下应当是 409`, false, `实际 ${r.status}`); break; }
  }
  const finallyOk = await api("POST", "/market/listings",
    { app_id: mkDirty.json?.id, summary: "试", confirm_sensitive: true }, B);
  check("被拦 3 次后仍能成功发布（额度没被拦下的请求吃掉）",
    finallyOk.status === 201, `实际 ${finallyOk.status} ${JSON.stringify(finallyOk.json)}`);

  console.log("\n── 排序与「我的发布」（左栏那一格靠它）──");
  // 此刻上架中的有两条：l2（作者 A，被装过 1 次）、finallyOk（作者 B，0 次装）
  const mineA = await api("GET", "/market/listings?mine=1", null, A);
  check("A 的「我的发布」里只有 A 发的",
    mineA.status === 200 && mineA.json.listings.length > 0
      && mineA.json.listings.every((l) => l.is_author === true)
      && mineA.json.listings.some((l) => l.id === l2),
    JSON.stringify(mineA.json.listings.map((l) => [l.id, l.is_author])));
  const mineB = await api("GET", "/market/listings?mine=1", null, B);
  check("🔴 B 的「我的发布」里看不到 A 发的（别人的东西不许混进来）",
    !mineB.json.listings.some((l) => l.id === l2),
    JSON.stringify(mineB.json.listings.map((l) => l.id)));
  const allForB = await api("GET", "/market/listings", null, B);
  check("不带 mine 时照样看得到别人的", allForB.json.listings.some((l) => l.id === l2));
  check("列表带 is_author 标记", allForB.json.listings.find((l) => l.id === l2)?.is_author === false);

  const hot = await api("GET", "/market/listings?sort=hot", null, B);
  check("sort=hot：装得最多的排前面",
    hot.status === 200 && hot.json.sort === "hot" && hot.json.listings[0]?.id === l2,
    JSON.stringify(hot.json.listings.map((l) => [l.id, l.installs])));
  const fresh = await api("GET", "/market/listings?sort=new", null, B);
  check("sort=new：最近发的排前面",
    fresh.json.listings[0]?.id === finallyOk.json?.id,
    JSON.stringify(fresh.json.listings.map((l) => [l.id, l.updated_at])));
  // 🔴 ORDER BY 是唯一一处拼进 SQL 的地方 —— 乱传必须落回默认，而不是被拼进去
  const junk = await api("GET",
    `/market/listings?sort=${encodeURIComponent("l.updated_at; DROP TABLE listings;--")}`, null, B);
  check("乱传 sort → 落回默认，不炸也不执行",
    junk.status === 200 && junk.json.sort === "new" && junk.json.listings.length >= 2,
    `实际 ${junk.status} ${JSON.stringify(junk.json?.sort)}`);
  const tableAlive = await api("GET", "/market/listings", null, B);
  check("listings 表还在（上一条没被当 SQL 执行）", tableAlive.status === 200);

  console.log("\n── 重启后市场数据还在 ──");
  proc.kill("SIGKILL");
  await wait(400);
  proc = boot();
  await wait(900);
  const afterBoot = await api("GET", "/market/listings", null, B);
  check("重启后 listing 还在", afterBoot.status === 200 && afterBoot.json.listings.some((l) => l.id === l2));
  const afterInstall = await api("GET", `/apps/${reinstall.json?.app_id}`, null, B);
  check("重启后装来的应用还能打开", afterInstall.status === 200);
  const afterPins = await api("GET", "/pins", null, B);
  check("重启后钉位还在", afterPins.status === 200);

  proc.kill("SIGKILL");
  srv.close();
  rmSync(dir, { recursive: true, force: true });

  console.log(failures === 0
    ? "\n\x1b[32m市场冒烟全部通过。\x1b[0m\n"
    : `\n\x1b[31m${failures} 项失败。\x1b[0m\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
