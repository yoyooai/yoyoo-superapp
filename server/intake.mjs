/**
 * 需求池 —— 「会议 → 需求 → 任务」这条线的中间那一段。
 *
 * ── 由来 ────────────────────────────────────────────────────
 * 09-04 晚项文清在群里提：录音卡片 → 自动归纳会议里的需求 → 进需求池 →
 * 自动拆任务 → 自动调研 → 写进看板。苏白："需求池按你的开发进度来吧。"
 *
 * 我判断它**不是新的一块地，是「工作项」的上游**：需求池装的是
 * "谁提的、认不认、拆成了哪几件、卡在谁那儿" —— 跟 worklist 同一层（人 + 状态），
 * 所以它直接把确认后的需求交给 `worklist.create`，不自己另造一套待办。
 *
 * ── 两处刻意卡住人手（这是这个模块的全部重点）──────────────────
 *  1. **AI 只出草稿。** 会议纪要里提炼需求会漏、也会自己加戏。所以
 *     `POST /drafts` 造出来的东西恒定是 `draft`，**没有任何参数能让它直接变成已受理**。
 *     自动写进看板的只能是"待确认"。
 *  2. **自动调研只给材料 + 出处。** `evidence` 每一条必须带 `source`，
 *     没有出处的一律 400 —— AI 给结论、人照着执行，是我们已经吃过亏的那类错：
 *     它错的时候和对的时候长得一模一样。
 *
 * ── 一条业务规矩（跟 worklist 同一条）────────────────────────
 * 拍板必须留理由（note）。这条理由是以后唯一能查到"当时为什么这么定"的地方。
 * 而且"谁拍的"取自**服务端派生的调用者身份**（x-yoyoo-caller，见 connectors.mjs），
 * 不取请求体里自称的 by —— 记录能被自称，就不叫记录。
 *
 * ── 这一版刻意没做的 ────────────────────────────────────────
 * **录音入口没做**，因为语音转文字那端我们拿不到音频（TD-290/291）。
 * 入口先收文字：`source` 可以是 `meeting`（纪要粘贴）/`chat`（转发聊天记录）/`manual`。
 * 音频通了只是多一个入口，这条链的其余部分不用改 —— 所以不必等它。
 */
import { randomUUID } from "node:crypto";
import { send, readJson, clip } from "./http-util.mjs";

export const SOURCES = new Set(["meeting", "chat", "manual"]);
export const STATES = ["draft", "accepted", "rejected"];

/**
 * 状态机。**唯一定义处。** 只允许 draft → accepted / rejected。
 * 已经拍过板的再拍一次直接 409 —— 跟"一单只能拍一次板"同一条规矩。
 */
export function transition(current, action) {
  if (current !== "draft") {
    return { ok: false, status: 409, error: `这条已经拍过板了（当前状态 ${current}）` };
  }
  if (action === "accept") return { ok: true, next: "accepted" };
  if (action === "reject") return { ok: true, next: "rejected" };
  return { ok: false, status: 400, error: `不认识的动作：${action}` };
}

/**
 * 校验 AI 给的证据。**每条必须有出处**，且只收"材料"，不收结论。
 * 返回 { ok, error?, value? }
 */
export function normalizeEvidence(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "evidence 必须是数组" };
  if (raw.length > 20) return { ok: false, error: "evidence 最多 20 条" };
  const out = [];
  for (const [i, e] of raw.entries()) {
    if (!e || typeof e !== "object" || Array.isArray(e)) {
      return { ok: false, error: `evidence[${i}] 必须是对象` };
    }
    const source = String(e.source || "").trim();
    const text = String(e.text || "").trim();
    if (!source) {
      return {
        ok: false,
        error: `evidence[${i}] 缺 source —— 自动调研只给材料和出处，不给结论。` +
               `没有出处的一句话，读的人没法判断它对不对。`,
      };
    }
    if (!text) return { ok: false, error: `evidence[${i}] 缺 text` };
    out.push({ text: clip(text, 500), source: clip(source, 300) });
  }
  return { ok: true, value: out };
}

export function initIntakeSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS intake_items (
      id           TEXT PRIMARY KEY,
      title        TEXT NOT NULL,
      detail       TEXT,
      source       TEXT NOT NULL,        -- meeting | chat | manual
      source_ref   TEXT,                 -- 哪场会 / 哪个会话，人要能顺着回去看
      raw_excerpt  TEXT,                 -- 原话片段：AI 归纳错了，人得能对照原文
      proposer     TEXT,                 -- 谁提的（会上是谁说的）
      evidence     TEXT,                 -- JSON 数组，每条 { text, source }
      state        TEXT NOT NULL DEFAULT 'draft',
      created_by   TEXT NOT NULL,        -- ai | human
      created_at   INTEGER NOT NULL,
      decided_by   TEXT,
      decided_at   INTEGER,
      decide_note  TEXT,
      assignee     TEXT,                 -- 受理后交给谁（拍板时给）
      work_item_id TEXT,                 -- 受理后派生出的那条工作项
      dedupe_key   TEXT
    );
  `);
  // 同一场会被重复归纳时不该长出第二条待确认的需求
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_intake_dedupe
             ON intake_items(dedupe_key) WHERE dedupe_key IS NOT NULL AND state='draft'`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_intake_state ON intake_items(state, created_at DESC)`);
}

/** 从请求里取服务端派生的调用者身份（同 worklist.mjs，理由见那边的注释） */
function callerOf(req) {
  const v = req.headers["x-yoyoo-caller"];
  return String(Array.isArray(v) ? v[0] : v || "").trim();
}

const row2out = (r) => ({ ...r, evidence: r.evidence ? JSON.parse(r.evidence) : [] });

/**
 * 挂在 `${prefix}` 下，跟其它业务后端一样只认一把共享密钥。
 *
 * 路由：
 *   GET  /items?state=draft|accepted|rejected|all   列表（默认 draft ＝待确认）
 *   GET  /stats                                     计数（给 KPI 用）
 *   POST /drafts        { title, detail?, source, ... }   AI 归纳出的草稿（恒定 draft）
 *   POST /:id/accept    { note, assignee }                人拍板受理 ⇒ 自动派生工作项
 *   POST /:id/reject    { note }                          人拍板否掉
 *
 * `createWorkItem` 由 index.mjs 注入（就是 worklist 的 create）——需求池不自己造待办，
 * 待办长什么样、下一环是谁，只有 worklist 那一处说了算。
 */
export function createIntake({ db, prefix, secret, createWorkItem = null }) {
  initIntakeSchema(db);

  const qList = db.prepare(`
    SELECT * FROM intake_items
    WHERE (@state = 'all' OR state = @state)
    ORDER BY (state='draft') DESC, created_at DESC`);
  const qGet = db.prepare(`SELECT * FROM intake_items WHERE id=?`);
  const qOpenByDedupe = db.prepare(`SELECT * FROM intake_items WHERE dedupe_key=? AND state='draft'`);
  const qIns = db.prepare(`
    INSERT INTO intake_items (id,title,detail,source,source_ref,raw_excerpt,proposer,evidence,
                              state,created_by,created_at,dedupe_key)
    VALUES (?,?,?,?,?,?,?,?,'draft',?,?,?)`);
  const qDecide = db.prepare(`
    UPDATE intake_items SET state=?, decided_by=?, decided_at=?, decide_note=?, assignee=?, work_item_id=?
    WHERE id=?`);
  const qStats = db.prepare(`SELECT state, count(*) n FROM intake_items GROUP BY state`);

  /** 造一条草稿。**恒定是 draft** —— 没有参数能绕过这一点。 */
  function createDraft(body, now, createdBy) {
    const title = String(body.title || "").trim();
    if (!title) return { status: 400, body: { error: "title 必填——一句话说清这是个什么需求" } };
    const source = String(body.source || "").trim();
    if (!SOURCES.has(source)) {
      return { status: 400, body: { error: `source 必须是 ${[...SOURCES].join("/")} 之一` } };
    }
    const ev = normalizeEvidence(body.evidence);
    if (!ev.ok) return { status: 400, body: { error: ev.error } };

    const dedupe = body.dedupe_key ? String(body.dedupe_key) : null;
    if (dedupe) {
      const exist = qOpenByDedupe.get(dedupe);
      if (exist) return { status: 200, body: { ...row2out(exist), deduped: true } };
    }
    const id = randomUUID();
    qIns.run(id, clip(title, 200), clip(body.detail, 2000) || null, source,
      clip(body.source_ref, 200) || null, clip(body.raw_excerpt, 2000) || null,
      clip(body.proposer, 120) || null, JSON.stringify(ev.value),
      createdBy, now, dedupe);
    return { status: 201, body: row2out(qGet.get(id)) };
  }

  async function handle(req, res, { path, url, now }) {
    if (!path.startsWith(prefix)) return false;

    const bearer = String(req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
    if (!secret || bearer !== secret) return send(res, 401, { error: "unauthorized" }), true;

    const rel = path.slice(prefix.length);
    const ts = now || Date.now();

    if (rel === "/items" && req.method === "GET") {
      const state = String(url.searchParams.get("state") || "draft");
      if (!STATES.includes(state) && state !== "all") {
        return send(res, 400, { error: `state 只能是 ${STATES.join("/")} 或 all` }), true;
      }
      return send(res, 200, { items: qList.all({ state }).map(row2out) }), true;
    }

    if (rel === "/stats" && req.method === "GET") {
      const out = { draft: 0, accepted: 0, rejected: 0 };
      for (const r of qStats.all()) out[r.state] = r.n;
      return send(res, 200, out), true;
    }

    if (rel === "/drafts" && req.method === "POST") {
      let body; try { body = await readJson(req); } catch (e) { return send(res, 400, { error: String(e.message || e) }), true; }
      // 🔴 造草稿的是 AI 还是人，看的是**服务端知不知道调用者**，不是请求体里写了什么：
      //    带得出可信身份的是人在点，带不出的是后台在跑。
      const createdBy = callerOf(req) ? "human" : "ai";
      const r = createDraft(body, ts, createdBy);
      return send(res, r.status, r.body), true;
    }

    const seg = rel.slice(1).split("/");
    const id = decodeURIComponent(seg[0] || "");
    const action = seg[1] || "";
    if (!id || !action) return false;

    const row = qGet.get(id);
    if (!row) return send(res, 404, { error: "not found" }), true;

    if ((action === "accept" || action === "reject") && req.method === "POST") {
      let body = {}; try { body = await readJson(req); } catch {}
      const note = String(body.note || "").trim();
      if (!note) {
        return send(res, 400, {
          error: "note 必填——这条理由是以后唯一能查到「当时为什么这么定」的地方",
        }), true;
      }
      const t = transition(row.state, action);
      if (!t.ok) return send(res, t.status, { error: t.error }), true;

      const decidedBy = callerOf(req) || String(body.by || "human");

      // 受理 ⇒ 派生一条工作项。**待办长什么样只有 worklist 说了算**，这里不自己造。
      let spawned = null;
      if (t.next === "accepted") {
        const assignee = String(body.assignee || "").trim();
        if (!assignee) {
          return send(res, 400, {
            error: "assignee 必填——受理一个需求就是把它交给某个人，没有人负责的需求等于没受理",
          }), true;
        }
        if (!createWorkItem) {
          return send(res, 503, { error: "工作项后端没挂上，受理会变成一条走不下去的记录，已拒绝" }), true;
        }
        const r = createWorkItem({
          kind: "decide_opportunity", loop: "intake",
          title: `需求待拆解：${row.title}`,
          detail: `来自${row.source === "meeting" ? "会议" : row.source === "chat" ? "聊天" : "手工录入"}` +
                  `${row.source_ref ? `（${row.source_ref}）` : ""}。` +
                  `受理人 ${decidedBy} 的理由：${note}`,
          entity_id: row.id, entity_ref: row.title,
          assignee, created_by: "system",
          dedupe_key: `intake:${row.id}`,
        }, ts);
        if (r.status >= 400) return send(res, r.status, r.body), true;
        spawned = r.body;
        qDecide.run(t.next, decidedBy, ts, clip(note, 1000), assignee, spawned.id, id);
      } else {
        qDecide.run(t.next, decidedBy, ts, clip(note, 1000), null, null, id);
      }
      return send(res, 200, { id, state: t.next, decided_by: decidedBy, spawned }), true;
    }

    return false;
  }

  return { handle, _internals: { createDraft, qGet, qList } };
}

export default createIntake;
