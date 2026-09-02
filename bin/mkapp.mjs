#!/usr/bin/env node
/**
 * mkapp —— 小A 在聊天里"说一句就造个应用"时用的那只手。
 *
 * 分工（这条界线是 SPEC-phase2 §B.2 定的，别糊掉）：
 *   · **blueprint 由我自己产**，不在这里调模型。这个脚本不聪明也不该聪明，
 *     它只做一件事：把我产的 JSON 交给我们自己的后端，换回一个 id 和一条链接。
 *   · 应用页里那个输入框走的是另一条路（server/generate.mjs 调模型），
 *     那条是**没有我在场时**的兜底，两条都留着。
 *
 * 用法：
 *   echo '{"type":"page","children":[...]}' | \
 *     node bin/mkapp.mjs --name "磁盘看板" --icon 📊
 *
 *   node bin/mkapp.mjs --name "磁盘看板" --blueprint ./bp.json
 *   node bin/mkapp.mjs --owner <uid> ...        # 默认造给 .env 里的 OCTO_OWNER_UID
 *   node bin/mkapp.mjs --dry-run ...           # 只打印将要发出去的东西
 *
 * 配置一律从 ~/zylos/.env 读（token 等同密码，绝不进命令行参数 ——
 * 命令行参数会进 shell history 和 ps 输出）。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function loadEnv() {
  const out = {};
  try {
    const txt = readFileSync(join(homedir(), "zylos", ".env"), "utf8");
    for (const line of txt.split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) out[m[1]] = m[2];
    }
  } catch {
    /* 没有 .env 就靠 process.env */
  }
  return { ...out, ...process.env };
}

function parseArgs(argv) {
  const a = { };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--dry-run") { a.dryRun = true; continue; }
    if (!k.startsWith("--")) continue;
    a[k.slice(2)] = argv[++i];
  }
  return a;
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

const die = (msg) => { console.error(`mkapp: ${msg}`); process.exit(1); };

const env = loadEnv();
const args = parseArgs(process.argv.slice(2));

const base = (args.url || env.OCTO_API_URL || "").replace(/\/$/, "");
const token = env.OCTO_BOT_TOKEN || "";
const owner = args.owner || env.OCTO_OWNER_UID || "";
if (!base) die("没有 OCTO_API_URL");
if (!token) die("没有 OCTO_BOT_TOKEN");
if (!owner) die("没有 owner uid（给 --owner，或在 .env 配 OCTO_OWNER_UID）");

let raw;
if (args.blueprint && args.blueprint !== "-") {
  try { raw = readFileSync(args.blueprint, "utf8"); }
  catch (e) { die(`读不到 ${args.blueprint}：${e.message}`); }
} else {
  raw = await readStdin();
}
if (!raw.trim()) die("blueprint 是空的（从 stdin 给，或用 --blueprint <file>）");

let blueprint;
try { blueprint = JSON.parse(raw); }
catch (e) { die(`blueprint 不是合法 JSON：${e.message}`); }

const body = {
  owner_uid: owner,
  name: args.name || "",
  icon: args.icon || "",
  blueprint,
};

if (args.dryRun) {
  console.log(JSON.stringify({ to: `${base}/yoyoo/v1/apps/for`, body }, null, 2));
  process.exit(0);
}

const res = await fetch(`${base}/yoyoo/v1/apps/for`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(20_000),
});
const text = await res.text();
if (!res.ok) {
  // 后端刻意不解释"为什么不合格"（那会变成身份枚举器），所以这里只能如实转述。
  die(`后端返回 ${res.status}: ${text.slice(0, 300)}`);
}
// 正常输出就是后端那份 JSON —— 里面的 `url` 就是可以贴给对方点的链接。
console.log(text.trim());
