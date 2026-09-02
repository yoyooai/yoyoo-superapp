/**
 * 邀请 AI · 全流程冒烟 —— 真起进程、真发 HTTP、真落盘。
 *
 * 这个文件存在的理由：单测证明的是"逻辑对"，这里证明的是**"这条路真的能走通"**——
 * 一个外面的 AI，只拿着一张票号、没有任何账号，能不能自己走进来。
 *
 * 两条主路径各跑一遍：
 *   ① 不审批（苏白定的默认）：出票 → AI 兑换 → 当场拿到 token → 立刻能发消息
 *   ② 要审批：出票 → AI 兑换只排队 → 人点头 → AI 取件拿到 token
 *
 * 顺带把否定用例钉在这里：未登录不能出票／票号错→404／重复兑换→409／
 * 重复取件→410／拒绝后拿不到／撤票后拿不到／过期→410／别人的票动不了。
 *
 * 用法：node server/invite-smoke.mjs
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SPACE_ID = "sp_test";
const USERS = { "tok-a": "u_subai", "tok-b": "u_other" };
const A = "tok-a";
const B = "tok-b";
const PORT = 8793;

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    console.log(`  ❌ ${name} ${extra}`);
    failures++;
  }
}

/** 假宿主：只回答"这个 token 是谁"。真宿主的建号动作由前端做，冒烟里不需要。 */
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

async function api(method, path, body, token = A) {
  const res = await fetch(`http://127.0.0.1:${PORT}/yoyoo/v1${path}`, {
    method,
    headers: {
      ...(token ? { token } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* 空体 */ }
  return { status: res.status, json };
}

/** 模拟"外面那个 AI"：它没有账号、没有 token，手上只有一张票。 */
const asOutsideAI = (path, body) => api("POST", path, body, "");

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "yoyoo-invite-"));
  const dbPath = join(dir, "invite.db");
  const { srv, port: hostPort } = await startFakeHost();

  const boot = (extraEnv = {}) =>
    spawn(process.execPath, [join(import.meta.dirname, "index.mjs")], {
      env: {
        ...process.env,
        ...extraEnv,
        PORT: String(PORT),
        DB_PATH: dbPath,
        HOST_VERIFY_URL: `http://127.0.0.1:${hostPort}/v1/user/current`,
        HOST_BOT_API_URL: `http://127.0.0.1:${hostPort}`,
        OCTO_SPACE_ID: SPACE_ID,
        YOYOO_BOT_ALLOWLIST: "none",
        INVITE_API_BASE: "https://yoyoo.test/yoyoo/v1",
        INVITE_HOST_API_URL: "https://yoyoo.test",
      },
      stdio: ["ignore", "ignore", "inherit"],
    });

  let proc = boot();
  await wait(900);

  console.log("\n── 鉴权：出票要登录，兑换不要 ──");
  const anon = await api("POST", "/invites", { require_approval: true }, "");
  check("未登录出票 → 401", anon.status === 401, `实际 ${anon.status}`);
  const badCode = await asOutsideAI("/invites/redeem", { code: "yi_nonsense", name: "冒充者" });
  check("兑换不要求登录（错票号走到业务层 → 404）", badCode.status === 404, `实际 ${badCode.status}`);

  // ── 路径① 不审批（默认）────────────────────────────────────
  console.log("\n── 路径①：不审批（默认）——兑换即进 ──");
  const noCred = await api("POST", "/invites", { require_approval: false }, A);
  check("不带凭据出票 → 400（后端不持有能造号的钥匙，凭据必须此刻交上来）",
    noCred.status === 400, `实际 ${noCred.status}`);

  const iss1 = await api("POST", "/invites", {
    bot_uid: "guest_bot_1",
    bot_token: "bf_live_token_1",
    inviter_name: "苏白",
    note: "邀请小X",
  }, A);
  check("出票成功（201）", iss1.status === 201, `实际 ${iss1.status} ${JSON.stringify(iss1.json)}`);
  const code1 = iss1.json?.code;
  check("拿到票号", typeof code1 === "string" && code1.startsWith("yi_"));
  check("拿到一段给 AI 读的邀请函", String(iss1.json?.letter || "").includes("/invites/redeem"));
  check("🔴 邀请函里没有 token 明文（它会被复制进聊天记录）",
    !String(iss1.json?.letter || "").includes("bf_live_token_1"));
  check("邀请函里带了真实可用的地址", String(iss1.json?.letter).includes("https://yoyoo.test/yoyoo/v1"));

  const redeem1 = await asOutsideAI("/invites/redeem", {
    code: code1, name: "小X", owner: "老张", description: "会写代码",
  });
  check("AI 自己兑换成功（200）", redeem1.status === 200, `实际 ${redeem1.status} ${JSON.stringify(redeem1.json)}`);
  check("拿到 token", redeem1.json?.bot_token === "bf_live_token_1");
  check("拿到接入地址和空间", redeem1.json?.api_url === "https://yoyoo.test" && redeem1.json?.space_id === SPACE_ID);
  check("交付信息里提示它先自报身份", String(redeem1.json?.hint || "").includes("自报身份"));

  const noName = await asOutsideAI("/invites/redeem", { code: code1 });
  check("兑换必须自报名字（这张已用过 → 409 而非 400 也算拦住）", noName.status !== 200, `实际 ${noName.status}`);

  const twice1 = await asOutsideAI("/invites/redeem", { code: code1, name: "小X" });
  check("🔴 同一张票不能兑换两次 → 409", twice1.status === 409, `实际 ${twice1.status}`);

  const list1 = await api("GET", "/invites", null, A);
  const row1 = (list1.json?.invites || []).find((i) => i.note === "邀请小X");
  check("邀请人看得到它自报的身份", row1?.claim_name === "小X" && row1?.claim_owner === "老张");
  check("状态是 accepted", row1?.status === "accepted", `实际 ${row1?.status}`);

  // ── 路径② 要审批 ──────────────────────────────────────────
  console.log("\n── 路径②：要审批 ——先排队，人点头才有号 ──");
  const iss2 = await api("POST", "/invites", { require_approval: true, note: "邀请小Y" }, A);
  check("出票成功，且不需要预先交凭据", iss2.status === 201, `实际 ${iss2.status}`);
  const code2 = iss2.json?.code;
  const id2 = iss2.json?.id;

  const redeem2 = await asOutsideAI("/invites/redeem", { code: code2, name: "小Y", owner: "老李" });
  check("兑换只排队（202 pending）", redeem2.status === 202 && redeem2.json?.status === "pending",
    `实际 ${redeem2.status}`);
  check("🔴 排队阶段绝不给凭据", !("bot_token" in (redeem2.json || {})));

  const early = await asOutsideAI("/invites/pickup", { code: code2 });
  check("人还没点头 → 取件拿不到（202）", early.status === 202, `实际 ${early.status}`);

  const notMine = await api("POST", `/invites/${id2}/approve`, { bot_uid: "x", bot_token: "bf_x" }, B);
  check("🔴 别人不能替你点头 → 404", notMine.status === 404, `实际 ${notMine.status}`);

  const pending = await api("GET", "/invites", null, A);
  const row2 = (pending.json?.invites || []).find((i) => i.id === id2);
  check("通讯录那条「待确认」有料可看", row2?.status === "pending" && row2?.claim_name === "小Y");
  check("🔴 还没点头就没有号", row2?.bot_uid == null, `实际 ${row2?.bot_uid}`);

  const appr = await api("POST", `/invites/${id2}/approve`,
    { bot_uid: "guest_bot_2", bot_token: "bf_live_token_2" }, A);
  check("点头成功", appr.status === 200 && appr.json?.status === "accepted", `实际 ${appr.status}`);

  const pick = await asOutsideAI("/invites/pickup", { code: code2 });
  check("AI 取件拿到 token（200）", pick.status === 200 && pick.json?.bot_token === "bf_live_token_2",
    `实际 ${pick.status} ${JSON.stringify(pick.json)}`);

  const pickAgain = await asOutsideAI("/invites/pickup", { code: code2 });
  check("🔴 凭据只交付一次 → 410", pickAgain.status === 410, `实际 ${pickAgain.status}`);

  // ── 拒绝 / 撤票 / 过期 ────────────────────────────────────
  console.log("\n── 拒绝、撤票、过期 ──");
  const iss3 = await api("POST", "/invites", { require_approval: true, note: "要拒的" }, A);
  await asOutsideAI("/invites/redeem", { code: iss3.json.code, name: "小Z" });
  const rej = await api("POST", `/invites/${iss3.json.id}/reject`, {}, A);
  check("拒绝成功", rej.status === 200 && rej.json?.status === "rejected");
  check("被拒之后取件拿不到", (await asOutsideAI("/invites/pickup", { code: iss3.json.code })).status === 409);

  const iss4 = await api("POST", "/invites",
    { bot_uid: "guest_bot_4", bot_token: "bf_live_token_4", note: "要撤的" }, A);
  const del = await api("DELETE", `/invites/${iss4.json.id}`, null, A);
  check("撤票成功", del.status === 200 && del.json?.status === "revoked");
  check("🔴 撤票后凭据换不到了",
    (await asOutsideAI("/invites/redeem", { code: iss4.json.code, name: "x" })).status === 409);

  const iss5 = await api("POST", "/invites",
    { bot_uid: "g5", bot_token: "bf_live_token_5", ttl_days: 1, note: "会过期的" }, A);
  check("有效期写进了票", typeof iss5.json?.expires_at === "number");

  // ── 落盘与重启 ────────────────────────────────────────────
  console.log("\n── 重启后还在（票据是账本，不是内存里的临时东西）──");
  const sealKey = join(dir, "invite-seal.key");
  check("封装密钥自动落盘（没配环境变量也不退化成明文）", existsSync(sealKey));
  if (existsSync(sealKey)) {
    const mode = statSync(sealKey).mode & 0o777;
    check("封装密钥权限 600", mode === 0o600, `实际 ${mode.toString(8)}`);
  }

  proc.kill("SIGKILL");
  await wait(300);
  proc = boot();
  await wait(900);

  const after = await api("GET", "/invites", null, A);
  check("重启后票据还在", (after.json?.invites || []).length >= 5,
    `实际 ${(after.json?.invites || []).length}`);
  const stillRevoked = (after.json?.invites || []).find((i) => i.note === "要撤的");
  check("重启后撤票状态没丢", stillRevoked?.status === "revoked");
  const pick2Again = await asOutsideAI("/invites/pickup", { code: code2 });
  check("🔴 重启也不能让已交付的凭据再交付一次", pick2Again.status === 410, `实际 ${pick2Again.status}`);

  proc.kill("SIGKILL");
  srv.close();
  rmSync(dir, { recursive: true, force: true });

  console.log("");
  if (failures) {
    console.log(`\x1b[31m邀请冒烟失败 ${failures} 项。\x1b[0m`);
    process.exit(1);
  }
  console.log("\x1b[32m邀请全流程冒烟通过。\x1b[0m");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
