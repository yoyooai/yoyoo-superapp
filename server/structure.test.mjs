/**
 * 结构测试 —— 守 SPEC-phase2 §D-3「不能被无声撤销」。
 *
 * 这些断言不测行为，测的是**结构没有被悄悄改回去**。
 * 行为测试（smoke.mjs）挡不住这一类回退：把 sanitize 复制一份回 generate.mjs，
 * 所有行为测试照样全绿，可两条入口从此各有一份判据 —— 半年后它们就漂了。
 *
 * 用法：node --test server/*.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = import.meta.dirname;
const read = (f) => readFileSync(join(dir, f), "utf8");

test("sanitizeBlueprint 只有一份实现（在 blueprint.mjs 里）", () => {
  const def = /function\s+sanitizeBlueprint/g;
  assert.match(read("blueprint.mjs"), def, "blueprint.mjs 里应当有唯一的定义");
  for (const f of ["generate.mjs", "index.mjs", "bot-auth.mjs", "market.mjs"]) {
    assert.doesNotMatch(
      read(f), def,
      `${f} 里出现了 sanitizeBlueprint 的定义 —— 判据被复制成两份了，改回 import`);
  }
});

test("三条写入路径都过 normalizeForStore", () => {
  const src = read("index.mjs");
  // POST /apps（用户面）、POST /apps/for（bot 面）、PUT /apps/:id
  const hits = src.match(/normalizeForStore\(/g) || [];
  assert.ok(hits.length >= 3,
    `index.mjs 里 normalizeForStore 只出现 ${hits.length} 次，应当 >=3（三条写入路径各一次）`);
  // 反向：不许再出现"直接把请求里的 blueprint 塞进库"
  assert.doesNotMatch(
    src, /JSON\.stringify\(body\.blueprint\)/,
    "有一条路径把 body.blueprint 直接入库了 —— 必须先过 normalizeForStore");
});

test("/apps/for 挡在用户面鉴权之前", () => {
  const src = read("index.mjs");
  const forAt = src.indexOf("`${ROOT}/apps/for`");
  const whoamiAt = src.indexOf("const uid = await whoami(");
  assert.ok(forAt > 0 && whoamiAt > 0, "两处锚点都应存在");
  assert.ok(forAt < whoamiAt,
    "/apps/for 的分支跑到了用户面鉴权后面 —— bot token 会被 401 挡掉，这条路就废了");
});

test("bot 白名单 fail-closed：没配等于全拒", () => {
  const src = read("bot-auth.mjs");
  assert.match(src, /allow\.size === 0/,
    "bot-auth.mjs 里没有'白名单为空则拒'的分支 —— 没配就敞着是这类接口最常见的死法");
});

// ── 市场（SPEC-market §6）─────────────────────────────────────────

test("市场的应用/卡片两种内容都过各自唯一的收敛器（判据只有一份，09-03 泛化后）", () => {
  const src = read("market.mjs");
  assert.match(src, /import \{ normalizeForStore \} from "\.\/blueprint\.mjs"/,
    "market.mjs 必须 import 那份唯一的收敛器，不许自己判");
  assert.match(src, /import \{ normalizeCardForStore \} from "\.\/card-store\.mjs"/,
    "market.mjs 必须 import 卡片那份唯一的收敛器，不许自己判");
  // 09-03 泛化后，发布/安装两条路径共用 STORES[kind].normalize 这一个入口
  // （不再是各自直接调用），sync 覆盖仍是 handleAppAction 里的直接调用 —— 三处都要在。
  assert.match(src, /normalize:\s*\(raw\)\s*=>\s*normalizeForStore\(raw\)/,
    "STORES.app 没有把 normalize 接到 normalizeForStore 上");
  assert.match(src, /normalize:\s*\(raw\)\s*=>\s*normalizeCardForStore\(raw\)/,
    "STORES.card 没有把 normalize 接到 normalizeCardForStore 上");
  const storeCalls = (src.match(/store\.normalize\(/g) || []).length;
  assert.ok(storeCalls >= 2,
    `market.mjs 里 store.normalize( 只出现 ${storeCalls} 次，应当 >=2（快照发布一次、安装一次）`);
  assert.match(src, /normalizeForStore\(JSON\.parse\(v\.blueprint\)\)/,
    "handleAppAction 的 sync 分支不再直接调用 normalizeForStore —— 更新覆盖这条路径不能绕过收敛器");
  assert.doesNotMatch(src, /JSON\.stringify\(body\.blueprint\)/,
    "有一条市场路径把请求里的 blueprint 直接入库了");
});

test("逛市场不下发蓝图（列表与详情都不含 blueprint 字段）", () => {
  const src = read("market.mjs");
  // 浏览用的那条 SQL 不许 select 到 blueprint —— 否则"浏览"就等于"拿走全部实现"。
  // 锚点是 browseSql()：四种排序/筛选组合共用它，改哪一种都逃不掉这条。
  const browse = src.slice(src.indexOf("function browseSql("), src.indexOf("export function createMarket"));
  assert.ok(browse.length > 0, "找不到 browseSql，锚点变了");
  assert.doesNotMatch(browse, /blueprint/,
    "市场列表把 blueprint 也查出来了 —— 逛一圈就等于把所有人的实现拿走");
});

test("排序只能来自白名单（ORDER BY 是这里唯一一处拼 SQL）", () => {
  // 防的是这条死法：为了加个排序，把 `?sort=` 里的字符串直接拼进 ORDER BY。
  // 占位符管不了 ORDER BY，所以只能靠"值必须来自固定表"这条结构约束兜。
  const src = read("market.mjs");
  const fn = src.slice(src.indexOf("function browseSql("), src.indexOf("export function createMarket"));
  assert.match(fn, /const order = BROWSE_ORDER\[sort\] \|\| BROWSE_ORDER\.new;/,
    "排序值不是从白名单取的 —— 请求里的字符串可能被拼进 ORDER BY");
  assert.match(fn, /ORDER BY \$\{order\}/,
    "ORDER BY 后面插的不是那个受控的 order 变量");
  // 请求参数只许当 key 用，不许原样落进 SQL 文本
  const handler = src.slice(src.indexOf('if (rel === "/market/listings")'), src.indexOf('if (req.method === "POST")'));
  assert.doesNotMatch(handler, /browseSql\(/,
    "在请求路径上现拼 SQL 了 —— 四条语句必须是启动时编译好的");
});

test("发布必须先过私货扫描（不可逆动作的门不许绕过）", () => {
  const src = read("market.mjs");
  assert.match(src, /import \{ scanForSecrets \} from "\.\/secrets\.mjs"/);
  const hits = src.match(/scanForSecrets\(/g) || [];
  assert.ok(hits.length >= 2,
    `发布与发新版都要扫，scanForSecrets 只出现 ${hits.length} 次`);
  assert.match(src, /sensitive_content/,
    "命中后必须返回可识别的 sensitive_content，让前端能把命中项摆给作者看");
});

test("下架不删数据（已装的人是副本，不受影响）", () => {
  const src = read("market.mjs");
  assert.match(src, /UPDATE listings SET status='delisted'/,
    "下架应当是改状态");
  assert.doesNotMatch(src, /DELETE FROM listings/,
    "出现了删 listing 的语句 —— 下架必须留数据（§5.6）");
  assert.doesNotMatch(src, /DELETE FROM listing_versions/,
    "快照是不可变的，不许删（§2.1 靠它兜底）");
});

test("侧栏钉位上限写死在一个常数里（不是散落的字面量）", () => {
  const src = read("market.mjs");
  assert.match(src, /export const PIN_LIMIT = 6;/,
    "PIN_LIMIT 应当是一个导出的常数 —— 苏白要改成 3 或 10 时只动这一处");
});

test("上线脚本按目录发全部运行时模块，不许写死文件名清单", () => {
  // 这条防的是一个很难查的死法：新增一个 server 模块、忘了加进 ship.sh 的清单，
  // 线上 index.mjs import 一个不存在的文件 → 容器起不来 → 症状是"服务突然全挂"，
  // 看起来跟这次改动毫无关系。市场这一批就差点这么发出去。
  const sh = readFileSync(join(dir, "..", "deploy", "ship.sh"), "utf8");
  const syncBlock = sh.slice(sh.indexOf("同步后端代码"), sh.indexOf("备份线上库"));
  assert.ok(syncBlock.length > 0, "找不到同步段，ship.sh 结构变了");
  assert.match(syncBlock, /server\/\*\.mjs/,
    "同步段没有按目录取文件 —— 又写死清单了");
  assert.doesNotMatch(syncBlock, /server\/(index|market|secrets|http-util|blueprint|generate|bot-auth)\.mjs/,
    "同步段里出现了写死的模块名 —— 下一个新模块会被漏掉");
});

test("私货扫描规则表非空（防止被清空后测试照样绿）", async () => {
  const { SECRET_RULE_COUNT } = await import("./secrets.mjs");
  assert.ok(SECRET_RULE_COUNT >= 8,
    `扫描规则只剩 ${SECRET_RULE_COUNT} 条 —— 规则表被削了`);
});
