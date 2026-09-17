/**
 * 组织架构图的「部门层」—— 平台名册里没有、但组织里真实存在的那一层。
 *
 * ── 为什么有这个模块（苏白 2026-09-15 夜 / 覃彩虹 09-15 两轮改口径）──────
 * 平台自带的组织架构图只有 **成员 / AI / 设备** 三支平铺：宿主
 * `listOrgStructure()` 给的就是一份扁平名册，**平台没有"部门"这个维度**。
 * 而客户看组织架构，第一层要的就是部门（内审 / 设备管理），部门底下才是
 * 「真人 ⇄ 对位 Agent」成对的人。这一层信息宿主那边压根没地方存 ⇒ 存在这里。
 *
 * ── 为什么不叫 blueprint（跟交接文里的命名不同，是我改的）────────────
 * 同目录已经有一个 `blueprint.mjs`，那是**应用**的蓝图（模型产的页面 JSON）。
 * 两个都叫 blueprint、意思完全不同，早晚有人 import 错。这个模块和前端
 * `src/shell/orgChart.ts` 是一对，所以叫 org-chart。
 *
 * ── 边界 ─────────────────────────────────────────────────────
 * · **读**：本组织成员都能读（组织架构图本来就是给组织里的人看的）。
 * · **写**：🔴 必须是**管理员或所有者**（role ≥ 1，见 octo-server
 *   `pkg/space/member_role.go`），判据来自 `spaceGate.roleOfViewer()` ——
 *   拿访问者自己的 token 问宿主要来的，**不是前端自报**。
 *   这一条是刻意的：写闸绝不许退化成"是成员就能写"，那等于组织里
 *   任何一个人都能改全组织看到的架构图。
 * · 只有"这台服务器压根没声明任何组织"那一档（spaceId === ''，本地开发/单测）
 *   才跳过角色判定 —— 那一档整个组织隔离都不在，不是后门。
 *
 * 🔴 存进来的 JSON 是**不可信输入**（前端给的），一律过 `sanitizeChart`：
 *    只认白名单字段、逐项限长、限条数。不这么做，这张表就是个任人写的 blob。
 *
 * ── 设备那一段（`devices`）────────────────────────────────────
 * 苏白 09-15 点名每台设备要带 **8 个字段**：设备类型 / 厂家 / 产线 / 机位 /
 * Owner / 关联 Agent / 关联流程 / 简介。这 8 个键在收敛结果里**一个都不许少**，
 * 值允许为空 —— 中际旭创还没给的（厂家、设备类型、机位，见需求稿第八节那 8 条
 * 业务确认项）照实留空，前端画「待确认」，**不编**。
 * 例外：`owner` 连值也必填，缺了整张图 400（一台设备只能有一个 Owner）。
 * `collab`（协作人）不在那 8 个里，是 SPEC 第 3 节定死的虚线协作，另立一格。
 *
 * 🔴 名册里有、图里没有的人，**前端必须把他放进「未分配」**（不许有人从图上消失）。
 *    那条规矩落在前端 `orgChart.ts` 和它的守卫测试里，不在这里 ——
 *    这里只存"谁被安排进了哪个部门"，不存名册本身。
 */
import { send, readJson, clip } from "./http-util.mjs";

/** 一份架构图的上限。够画一个大组织，又不至于让人往里塞文档。 */
const MAX_DEPARTMENTS = 40;
const MAX_MEMBERS_PER_DEPT = 200;
const MAX_STANDALONE = 40;
const MAX_DEVICES = 500;
const MAX_JSON_BYTES = 256 * 1024;

/** 空间管理员起步的 role（octo-server `spaceRoleAdmin = 1`）。 */
const ROLE_ADMIN = 1;

export function initOrgChartSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS org_charts (
      space_id   TEXT PRIMARY KEY,
      json       TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      updated_by TEXT NOT NULL
    );
  `);
}

const str = (v, max = 120) => clip(String(v ?? "").trim(), max);

/** 一对「真人 ⇄ Agent」。两边都允许空：真人未定就写字面量 XXX，照实显示，不编名字。 */
function pair(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const human = str(v.human, 120);
  const agent = str(v.agent, 120);
  const label = str(v.label, 60);
  if (!human && !agent) return null;
  return { human, agent, label };
}

function arr(v, max, fn) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const it of v) {
    if (out.length >= max) break;
    const x = fn(it);
    if (x) out.push(x);
  }
  return out;
}

/**
 * 把前端给的 JSON 收敛成我们认识的形状。认不出来的字段一律丢掉。
 * @returns {{ok:true, chart:object} | {ok:false, reason:string}}
 */
export function sanitizeChart(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, reason: "not an object" };
  }
  const departments = arr(input.departments, MAX_DEPARTMENTS, (d) => {
    if (!d || typeof d !== "object") return null;
    const name = str(d.name, 60);
    if (!name) return null; // 没名字的部门画不出来，也没法引用
    return {
      key: str(d.key, 60) || name,
      name,
      lead: pair(d.lead),
      members: arr(d.members, MAX_MEMBERS_PER_DEPT, pair),
    };
  });
  const standalone = arr(input.standalone, MAX_STANDALONE, (s) => {
    if (!s || typeof s !== "object") return null;
    const name = str(s.name, 60);
    if (!name) return null;
    const p = pair(s);
    return { name, human: p ? p.human : "", agent: p ? p.agent : "" };
  });
  /* 🔴 设备的 8 个业务字段（苏白 09-15 原话：「设备类型、厂家、产线、机位、Owner、
     关联 Agent、关联流程、简介」）—— 收敛结果里这 8 个键**一个都不许少**，
     值可以是空（中际旭创还没给的，照实留空，前端画「待确认」）。
     "键必须在、值可以空" 是刻意的：字段消失了没人看得出来，空值看得出来。 */
  let deviceReject = "";
  const devices = arr(input.devices, MAX_DEVICES, (d) => {
    if (!d || typeof d !== "object") return null;
    const id = str(d.id, 60);
    if (!id) return null;
    const owner = str(d.owner, 120);
    /* 🔴 8 个字段里只有 Owner 连**值**也必填：一台设备只能有一个 Owner，
       没有 Owner 就是"出事没人认账"（SPEC 第 3 节定案）。缺了整张图拒收 ——
       悄悄收下一台没主的设备，比 400 难查得多。 */
    if (!owner && !deviceReject) deviceReject = `device ${id} has no owner`;
    return {
      id,
      uid: str(d.uid, 120),
      type: str(d.type, 60),          // 设备类型
      vendor: str(d.vendor, 60),      // 厂家
      line: str(d.line, 60),          // 产线
      station: str(d.station, 60),    // 机位
      owner,                          // Owner（设备归属，唯一一个值必填的）
      agents: arr(d.agents, 20, (a) => str(a, 120) || null),   // 关联 Agent
      flows: arr(d.flows, 20, (f) => str(f, 120) || null),     // 关联流程
      note: str(d.note, 200),         // 简介
      /* 🔴 数据成色（09-15 夜第十一棒，苏白「你自己根据我给你的内容来生产吧」之后加）：
         需求稿 1.1 白纸黑字 ——「真实接入前，所有数据必须明确标注 Demo 数据」
         「未确认的字段统一标注待确认，不允许自行补充成既定事实」。
         所以现在允许把演示值填满（图不再一片"待确认"），但**默认成色就是 demo**：
         只有显式写 `grade:"confirmed"`（＝中际旭创真确认过）才算真值。
         默认值这个方向是刻意的 —— 漏写一台，它显示成"演示"而不是冒充成"真的"。 */
      grade: d.grade === "confirmed" ? "confirmed" : "demo",
      /* 协作人：不在那 8 个里，但 SPEC 第 3 节定死的虚线归属（李工⇄AR-204 运维、
         王工⇄LR-205 采购）要有地方放 —— 它是"协作"不是"归属"，所以另立一个字段，
         绝不能塞进 owner 里冒充第二个主人。 */
      collab: arr(d.collab, 20, (c) => str(c, 120) || null),
    };
  });
  if (deviceReject) return { ok: false, reason: deviceReject };
  if (!departments.length && !standalone.length && !devices.length) {
    return { ok: false, reason: "empty chart" };
  }
  return {
    ok: true,
    chart: { version: 1, title: str(input.title, 120), departments, standalone, devices },
  };
}

export function createOrgChart({ db, spaceGate = null, now = Date.now }) {
  initOrgChartSchema(db);

  const q = {
    get: db.prepare(`SELECT json, updated_at, updated_by FROM org_charts WHERE space_id = ?`),
    put: db.prepare(`
      INSERT INTO org_charts (space_id, json, updated_at, updated_by) VALUES (?,?,?,?)
      ON CONFLICT(space_id) DO UPDATE SET json=excluded.json,
        updated_at=excluded.updated_at, updated_by=excluded.updated_by`),
  };

  function read(spaceId) {
    const row = q.get.get(spaceId);
    if (!row) return null;
    try {
      return { chart: JSON.parse(row.json), updatedAt: row.updated_at, updatedBy: row.updated_by };
    } catch {
      return null; // 库里是坏 JSON ⇒ 当作没有，别把整页拖垮
    }
  }

  /**
   * 能不能写。
   * @returns {Promise<boolean>}
   */
  async function canEdit({ spaceId, token }) {
    // 「压根没声明组织」那一档：整个组织隔离都不在（本地开发 / 单测）。
    if (!spaceId) return true;
    if (!spaceGate || typeof spaceGate.roleOfViewer !== "function") return false;
    const role = await spaceGate.roleOfViewer(token, spaceId);
    return role !== null && role >= ROLE_ADMIN;
  }

  /**
   * 路由。挂在已鉴权的段里（调用方已经拿到 uid 和 spaceId）。
   * @returns {Promise<boolean>} 命中返回 true
   */
  async function handle(req, res, { path, uid, root, spaceId, token }) {
    if (path !== `${root}/org-chart`) return false;

    if (req.method === "GET") {
      const hit = read(spaceId);
      send(res, 200, {
        chart: hit ? hit.chart : null,
        updatedAt: hit ? hit.updatedAt : 0,
        updatedBy: hit ? hit.updatedBy : "",
        canEdit: await canEdit({ spaceId, token }),
      });
      return true;
    }

    if (req.method === "PUT") {
      if (!(await canEdit({ spaceId, token }))) {
        send(res, 403, { error: "admin only" });
        return true;
      }
      const body = await readJson(req).catch(() => null);
      const out = sanitizeChart(body && body.chart ? body.chart : body);
      if (!out.ok) {
        send(res, 400, { error: `bad chart: ${out.reason}` });
        return true;
      }
      const json = JSON.stringify(out.chart);
      if (Buffer.byteLength(json, "utf8") > MAX_JSON_BYTES) {
        send(res, 413, { error: "chart too large" });
        return true;
      }
      q.put.run(spaceId, json, now(), uid);
      send(res, 200, { ok: true, chart: out.chart });
      return true;
    }

    send(res, 405, { error: "method not allowed" });
    return true;
  }

  return { handle, read, canEdit, sanitizeChart };
}
