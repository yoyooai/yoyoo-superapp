/**
 * 「公共服务」—— 替大家跑重活的那几台机器（生图 / 做 PPT / 跑浏览器 / 跑 Python / 出视频）。
 *
 * ── 为什么单独一层（苏白 2026-09-14 定「发现」四格）─────────────
 * 发现页四格：SkillHub / 工具调用 / 专家 / 公共服务。
 * 前三格的货**已经有现成的货架**（宿主 marketplace 的 skills / mcp_servers / experts，
 * 建表就有版本、校验、上下架，还带 created_by_bot_uid —— AI 本来就能自己上架）。
 * 第四格没有：宿主的货架类型是 MySQL ENUM 写死的四种，塞第五种要动它的骨头 ⇒
 * 撞上那条铁线「要动它骨头的就不做」。所以公共服务长在**我们自己的库**里。
 *
 * 这也符合它本来的性质：公共服务不是"一件可以装到你 AI 上的货"，
 * 是"一台你可以去调的机器"。它不下发文件，它出力。
 *
 * ── 🔴 三条诚实底线（写死在这一层，界面不许改软）──────────────
 *  1. **不存凭据。** 只存"要不要凭据、找谁要"（auth_hint）。
 *     一张登记表一旦开始存别人的 key，它就成了全站最值钱的攻击目标。
 *  2. **不替它体检。** 我们没有探活；所以一律不声称它"在线/正常"。
 *     能说的只有"谁在什么时候报过一次可用"（last_seen_*），和这句话本身。
 *     🔴 服务端不主动去 fetch 登记进来的地址 —— 那是把服务器变成任人指挥的跳板（SSRF）。
 *  3. **报可用性的人要留名。** 报的是"我用过，通了"，不是"系统检测正常"。
 *
 * ── 谁能改 ────────────────────────────────────────────────
 * 登记：任何登录用户（这是一张公共货架，不是私人清单）。
 * 改 / 下架 / 删：**只有登记人自己**。别人报可用性可以，改别人的登记不行。
 */
/* ⚠️ 建表 SQL 在模板字符串里 —— 注释中一律不许用反引号（同 theme.tsx / commerce.mjs 那条）。 */
import { randomUUID } from "node:crypto";
import { send, readJson, clip } from "./http-util.mjs";

/** 重活的种类。留 other 是因为我们一定想不全，但不留 ENUM 就会变成垃圾桶。 */
export const SERVICE_KINDS = new Set(["image", "doc", "browser", "code", "video", "data", "other"]);
const KIND_MAX = 20;
const NAME_MAX = 60;
const SUMMARY_MAX = 140;
const ENDPOINT_MAX = 500;
const HOW_MAX = 4000;
const AUTH_MAX = 200;

export function initPublicServiceSchema(db) {
  db.exec(`
    /*
     * 一台公共服务。
     * 🔴 这里**没有** credential / token / secret 列，是刻意的（见文件头第 1 条）。
     * 🔴 也没有 online 列：我们不探活，就不许有一个字段让界面去写"在线"。
     */
    CREATE TABLE IF NOT EXISTS public_services (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      kind         TEXT NOT NULL,          -- image | doc | browser | code | video | data | other
      summary      TEXT,                   -- 一句话：它替你干什么重活
      endpoint     TEXT NOT NULL,          -- 去哪儿调它
      how          TEXT,                   -- 怎么用（给 AI 看的一段说明，可以是 markdown）
      auth_hint    TEXT,                   -- 要不要凭据、找谁要。**不存凭据本身**
      owner_uid    TEXT NOT NULL,          -- 谁登记的（只有他能改）
      owner_name   TEXT,                   -- 登记时抄一份，省得列表还要回查
      status       TEXT NOT NULL,          -- on | off（下架不删：别人的说明里可能还引着它）
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );

    /*
     * 「我用过，通了」——**人报的**，不是系统检测的。
     * 一条一行、留名留时间，界面才敢照实说"某人某时报过一次可用"。
     */
    CREATE TABLE IF NOT EXISTS public_service_reports (
      id           TEXT PRIMARY KEY,
      service_id   TEXT NOT NULL,
      by_uid       TEXT NOT NULL,
      by_name      TEXT,
      ok           INTEGER NOT NULL,       -- 1 = 通了；0 = 没通
      note         TEXT,
      ts           INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ps_reports ON public_service_reports (service_id, ts DESC);
  `);
}

export function createPublicServices({ db, now = Date.now }) {
  initPublicServiceSchema(db);
  const nowSec = () => Math.floor(now() / 1000);

  const q = {
    listOn: db.prepare(`SELECT * FROM public_services WHERE status='on' ORDER BY created_at DESC`),
    listAll: db.prepare(`SELECT * FROM public_services ORDER BY created_at DESC`),
    get: db.prepare(`SELECT * FROM public_services WHERE id = ?`),
    insert: db.prepare(`
      INSERT INTO public_services (id, name, kind, summary, endpoint, how, auth_hint,
                                   owner_uid, owner_name, status, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`),
    update: db.prepare(`
      UPDATE public_services
         SET name=?, kind=?, summary=?, endpoint=?, how=?, auth_hint=?, status=?, updated_at=?
       WHERE id=? AND owner_uid=?`),
    del: db.prepare(`DELETE FROM public_services WHERE id=? AND owner_uid=?`),
    addReport: db.prepare(`
      INSERT INTO public_service_reports (id, service_id, by_uid, by_name, ok, note, ts)
      VALUES (?,?,?,?,?,?,?)`),
    lastReport: db.prepare(`
      SELECT * FROM public_service_reports WHERE service_id = ? ORDER BY ts DESC LIMIT 1`),
    reports: db.prepare(`
      SELECT * FROM public_service_reports WHERE service_id = ? ORDER BY ts DESC LIMIT 20`),
  };

  /**
   * 一条登记在界面上长什么样。
   * 🔴 `last_ok` 只描述"有人报过"，绝不换算成"在线"。措辞也在这里定死，
   *    免得每个界面各编一句，编着编着就编出"运行正常"。
   */
  function shape(r, { uid } = {}) {
    const last = q.lastReport.get(r.id) || null;
    return {
      id: r.id,
      name: r.name,
      kind: r.kind,
      summary: r.summary || null,
      endpoint: r.endpoint,
      how: r.how || null,
      auth_hint: r.auth_hint || null,
      owner_uid: r.owner_uid,
      owner_name: r.owner_name || null,
      status: r.status,
      mine: !!uid && r.owner_uid === uid,
      created_at: r.created_at,
      updated_at: r.updated_at,
      /* 平台没替任何人验过 —— 这句话跟着数据一起走，界面删不掉。 */
      verified_by_platform: false,
      last_report: last
        ? { ok: !!last.ok, by_name: last.by_name || null, note: last.note || null, ts: last.ts }
        : null,
    };
  }

  function validate(body, { partial = false } = {}) {
    const name = clip(body?.name, NAME_MAX).trim();
    const kind = clip(body?.kind, KIND_MAX).trim() || "other";
    const endpoint = clip(body?.endpoint, ENDPOINT_MAX).trim();
    if (!partial || body?.name !== undefined) {
      if (!name) return { ok: false, reason: "名字不能为空" };
    }
    if (!SERVICE_KINDS.has(kind)) {
      return { ok: false, reason: `kind 只能是 ${[...SERVICE_KINDS].join(" / ")}` };
    }
    if (!partial || body?.endpoint !== undefined) {
      if (!endpoint) return { ok: false, reason: "调用地址不能为空 —— 登记一台调不到的机器没有意义" };
      if (!/^https?:\/\//i.test(endpoint)) {
        return { ok: false, reason: "调用地址要以 http:// 或 https:// 开头" };
      }
    }
    /* 🔴 把明显是凭据的东西挡在门外。不是万无一失的过滤，是一道"别往这儿放"的提醒闸：
       真正的保证是这张表压根没有存凭据的列。 */
    const how = clip(body?.how, HOW_MAX);
    const authHint = clip(body?.auth_hint, AUTH_MAX);
    const suspect = /\b(sk-[A-Za-z0-9]{16,}|bf_[A-Za-z0-9]{16,}|AKID[A-Za-z0-9]{16,})\b/;
    if (suspect.test(how) || suspect.test(authHint)) {
      return {
        ok: false,
        reason: "这段说明里像是带了一把真钥匙。这张表不存凭据 —— 只写「要凭据，找谁要」。",
      };
    }
    return {
      ok: true,
      value: {
        name, kind, endpoint,
        summary: clip(body?.summary, SUMMARY_MAX).trim(),
        how, auth_hint: authHint,
        status: body?.status === "off" ? "off" : "on",
      },
    };
  }

  /** 登记一台。返回 {ok, service} 或 {ok:false, reason}。 */
  function register({ uid, name: ownerName, body }) {
    const v = validate(body);
    if (!v.ok) return v;
    const ts = nowSec();
    const id = randomUUID();
    q.insert.run(
      id, v.value.name, v.value.kind, v.value.summary, v.value.endpoint,
      v.value.how, v.value.auth_hint, uid, clip(ownerName, NAME_MAX) || null,
      v.value.status, ts, ts
    );
    return { ok: true, service: shape(q.get.get(id), { uid }) };
  }

  async function handle(req, res, { path, url, uid, root }) {
    const base = `${root}/public-services`;
    if (path !== base && !path.startsWith(`${base}/`)) return false;
    const rest = path.slice(base.length).replace(/^\//, "");

    if (rest === "" && req.method === "GET") {
      const wantAll = url?.searchParams?.get("all") === "1";
      const rows = (wantAll ? q.listAll.all() : q.listOn.all()).map((r) => shape(r, { uid }));
      send(res, 200, {
        services: rows,
        /* 🔴 空不空都带上这句：这一格的全部可信度就建立在"谁验的"讲清楚了没有。 */
        note: "这些是登记上来的机器。平台没有替你验过它们此刻在不在 —— 下面写的「有人报过」就是字面意思。",
      });
      return true;
    }

    if (rest === "" && req.method === "POST") {
      let body;
      try { body = await readJson(req); } catch { send(res, 400, { error: "bad json" }); return true; }
      const r = register({ uid, name: body?.owner_name, body });
      if (!r.ok) { send(res, 400, { error: r.reason }); return true; }
      send(res, 200, { service: r.service });
      return true;
    }

    const id = rest.includes("/") ? rest.slice(0, rest.indexOf("/")) : rest;
    const tail = rest.includes("/") ? rest.slice(id.length + 1) : "";
    const row = id ? q.get.get(decodeURIComponent(id)) : null;

    if (!row) { send(res, 404, { error: "没有这台公共服务" }); return true; }

    if (!tail && req.method === "GET") {
      send(res, 200, {
        service: shape(row, { uid }),
        reports: q.reports.all(row.id).map((r) => ({
          ok: !!r.ok, by_name: r.by_name || null, note: r.note || null, ts: r.ts,
        })),
      });
      return true;
    }

    if (!tail && (req.method === "PUT" || req.method === "PATCH")) {
      if (row.owner_uid !== uid) {
        send(res, 403, { error: "只有登记它的人能改" });
        return true;
      }
      let body;
      try { body = await readJson(req); } catch { send(res, 400, { error: "bad json" }); return true; }
      const merged = {
        name: body?.name ?? row.name,
        kind: body?.kind ?? row.kind,
        summary: body?.summary ?? row.summary,
        endpoint: body?.endpoint ?? row.endpoint,
        how: body?.how ?? row.how,
        auth_hint: body?.auth_hint ?? row.auth_hint,
        status: body?.status ?? row.status,
      };
      const v = validate(merged);
      if (!v.ok) { send(res, 400, { error: v.reason }); return true; }
      q.update.run(
        v.value.name, v.value.kind, v.value.summary, v.value.endpoint,
        v.value.how, v.value.auth_hint, v.value.status, nowSec(), row.id, uid
      );
      send(res, 200, { service: shape(q.get.get(row.id), { uid }) });
      return true;
    }

    if (!tail && req.method === "DELETE") {
      const r = q.del.run(row.id, uid);
      if (!r.changes) { send(res, 403, { error: "只有登记它的人能删" }); return true; }
      send(res, 200, { ok: true });
      return true;
    }

    /* 「我用过，通了」/「我用过，没通」—— 任何登录用户都能报，报了留名。 */
    if (tail === "report" && req.method === "POST") {
      let body;
      try { body = await readJson(req); } catch { send(res, 400, { error: "bad json" }); return true; }
      if (typeof body?.ok !== "boolean") {
        send(res, 400, { error: "要说清是通了还是没通（ok: true / false）" });
        return true;
      }
      q.addReport.run(
        randomUUID(), row.id, uid, clip(body?.by_name, NAME_MAX) || null,
        body.ok ? 1 : 0, clip(body?.note, SUMMARY_MAX), nowSec()
      );
      send(res, 200, {
        ok: true,
        service: shape(q.get.get(row.id), { uid }),
        note: "记下了。这是**你**报的一次结果，不是平台的体检结论。",
      });
      return true;
    }

    send(res, 404, { error: "not found" });
    return true;
  }

  return { handle, register, shape, validate };
}
