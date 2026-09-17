/**
 * 工作项（接力棒）—— 「卡片收件箱」这道门的地基。
 *
 * ── 为什么要有它（09-04 苏白在群里点了「开这道门」）─────────────
 * 在此之前，团队协作只做到"大家打开同一个工作台"＝**共享文档**。
 * 每个人得自己去六个模块里翻，看有没有轮到自己的活。真正的 AI-native 协作是：
 * **AI 干完一环，自动把活递给下一个人；人在自己收到的那张卡上就地拍板。**
 * 09-03 那份架构定案文档把这件事写成"卡片是工作的原子——可寻址、有状态、可路由"。
 * 这个文件就是那三个词的落地：
 *   · 可寻址 = 每个工作项有 id，且指回它所属的业务记录（loop + entity_id）
 *   · 有状态 = 一个状态机，**只有一处**（transition()）
 *   · 可路由 = 一张路由表，**只有一处**（ROUTES）
 *
 * ── 个人收件箱：09-04 晚已经通了（原先卡在 TD-313）───────────────
 * 之前这里写着"做不到"，原因是连接器代理不把"现在是谁在调"转发下来，
 * 业务系统这一侧拿不到可信的访问者身份。**09-04 晚补上了**：代理出站时由
 * 服务端写 `x-yoyoo-caller`（见 connectors.mjs 的"调用者身份"一段），
 * 第一方是真 uid、第三方是化名，调用方伪造不了。
 *
 * 于是这里的规矩变成：
 *   · `GET /items`            = **团队看板**（所有未完成的活，标着该谁做）
 *   · `GET /items?mine=1`     = **个人收件箱**（只看轮到我的），身份取自那个头
 *   · 拿不到那个头时 `mine=1` **直接 400**，绝不退化成"用请求里自称的 assignee"——
 *     那是纯自称，改一下就能读别人的收件箱。宁可这个功能不可用，也不给一条越权路。
 *   · `assignee=<uid>` 仍然保留：那是看板的筛选（看板本来就全队可见），
 *     它跟"我的收件箱"不是同一件事，所以不共用同一个参数。
 *
 * ── 一条业务规矩 ────────────────────────────────────────────
 * 完成工作项**必须留理由**（note）。这不是形式：Company Memory 里"人当时为什么
 * 这么定"只有这一个来源。空理由直接 400，别指望前端记得校验。
 */
import { randomUUID } from "node:crypto";
import { send, readJson, clip } from "./http-util.mjs";

/**
 * 工作项种类 → 路由表。**唯一定义处。**
 *
 * `next` = 这一环做完之后自动派生的下一环（null = 到此为止）。
 * `actor` = 下一环该谁干：`ai` 表示交回 AI，`same` 表示还是同一个人。
 *
 * 🔴 不许在别处写 if (kind === "...") 判断下一步 —— 一旦有第二处，
 *    "流程到底怎么走"就没有真源了，这是六份样式表那件事的流程版。
 */
export const ROUTES = {
  // Sell：AI 出了报价 → 人拍板 → 批了就该有人去履约（下一环交回 AI 起草履约）
  approve_quote: { next: "fulfil_order", actor: "ai", label: "报价待拍板" },
  fulfil_order: { next: null, actor: "ai", label: "履约待起草" },
  // Grow：AI 出了素材 → 人审 → 投出去之后要有人回填结果
  approve_creative: { next: "report_metrics", actor: "same", label: "素材待审" },
  report_metrics: { next: null, actor: "same", label: "结果待回填" },
  // Innovate：证据够硬 → 人拍 GO/ITERATE/KILL
  decide_opportunity: { next: null, actor: "same", label: "机会待拍板" },
};

export const STATES = ["open", "done", "cancelled"];

/**
 * 状态机。**唯一定义处。**
 * 只允许 open → done / cancelled。已经终态的再动一次直接拒（409），
 * 跟 Sell 那条"一单只能拍一次板"同一条规矩：记录能被改第二次，就不叫记录。
 */
export function transition(current, action) {
  if (current !== "open") {
    return { ok: false, status: 409, error: `这条已经处理过了（当前状态 ${current}）` };
  }
  if (action === "done") return { ok: true, next: "done" };
  if (action === "cancel") return { ok: true, next: "cancelled" };
  return { ok: false, status: 400, error: `不认识的动作：${action}` };
}

export function initWorklistSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_items (
      id           TEXT PRIMARY KEY,
      kind         TEXT NOT NULL,
      loop         TEXT NOT NULL,
      title        TEXT NOT NULL,
      detail       TEXT,
      entity_id    TEXT,
      entity_ref   TEXT,
      assignee     TEXT NOT NULL,
      created_by   TEXT NOT NULL,
      state        TEXT NOT NULL DEFAULT 'open',
      outcome      TEXT,
      note         TEXT,
      parent_id    TEXT,
      dedupe_key   TEXT,
      created_at   INTEGER NOT NULL,
      done_at      INTEGER,
      done_by      TEXT
    );
  `);
  // 幂等键：同一件事被 AI 重复触发时不该长出第二条待办。
  // （比如"让 AI 再报一次价"点两下，收件箱里不该出现两张一样的卡。）
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_work_dedupe
             ON work_items(dedupe_key) WHERE dedupe_key IS NOT NULL AND state='open'`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_work_state ON work_items(state, created_at DESC)`);
}

/**
 * 挂在 `${prefix}` 下，跟其它业务系统桩一样只认一把共享密钥。
 *
 * 路由：
 *   GET  /items?state=open|done|all&assignee=<uid>   列表（默认 open）
 *   GET  /items?mine=1                              个人收件箱（身份取自 x-yoyoo-caller）
 *   GET  /stats                                     计数（给 KPI 用）
 *   POST /items                                     造一条（AI 或系统调用）
 *   POST /:id/done    { outcome, note }             完成 + 自动派生下一环
 *   POST /:id/cancel  { note }                      取消
 */
/**
 * 从请求里取**服务端派生**的调用者身份。
 * 这个头只可能由连接器代理写（`x-yoyoo-*` 在代理里是保留前缀，用户占不了）。
 * 直连这个桩的人当然能自己捏一个——但直连需要那把共享密钥，
 * 那把密钥的持有者本来就是系统自己。真正要防的是"浏览器里的页面自称是别人"。
 */
function callerOf(req) {
  const v = req.headers["x-yoyoo-caller"];
  return String(Array.isArray(v) ? v[0] : v || "").trim();
}

export function createWorklist({ db, prefix, secret }) {
  initWorklistSchema(db);

  const qList = db.prepare(`
    SELECT * FROM work_items
    WHERE (@state = 'all' OR state = @state)
      AND (@assignee = '' OR assignee = @assignee)
    ORDER BY (state='open') DESC, created_at DESC`);
  const qGet = db.prepare(`SELECT * FROM work_items WHERE id=?`);
  const qIns = db.prepare(`
    INSERT INTO work_items (id,kind,loop,title,detail,entity_id,entity_ref,assignee,created_by,
                            state,parent_id,dedupe_key,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,'open',?,?,?)`);
  const qDone = db.prepare(`UPDATE work_items SET state=?, outcome=?, note=?, done_at=?, done_by=? WHERE id=?`);
  const qStats = db.prepare(`SELECT state, count(*) n FROM work_items GROUP BY state`);
  const qOpenByDedupe = db.prepare(`SELECT * FROM work_items WHERE dedupe_key=? AND state='open'`);

  /** 造一条工作项。`dedupe_key` 已有未完成的同键条目时直接返回那一条（不新建）。 */
  function create({ kind, loop, title, detail, entity_id, entity_ref, assignee, created_by, parent_id, dedupe_key }, now) {
    if (!ROUTES[kind]) return { status: 400, body: { error: `kind 必须是已登记的种类之一：${Object.keys(ROUTES).join("/")}` } };
    if (!String(title || "").trim()) return { status: 400, body: { error: "title 必填——一句话说清要谁做什么" } };
    if (!String(assignee || "").trim()) return { status: 400, body: { error: "assignee 必填——没有人负责的待办等于没有待办" } };

    if (dedupe_key) {
      const exist = qOpenByDedupe.get(dedupe_key);
      if (exist) return { status: 200, body: { ...exist, deduped: true } };
    }
    const id = randomUUID();
    qIns.run(id, kind, String(loop || ""), clip(title, 200), clip(detail, 2000) || null,
      entity_id ? String(entity_id) : null, clip(entity_ref, 200) || null,
      String(assignee), String(created_by || "ai"), parent_id || null, dedupe_key || null, now);
    return { status: 201, body: qGet.get(id) };
  }

  async function handle(req, res, { path, url, now }) {
    if (!path.startsWith(prefix)) return false;

    const bearer = String(req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
    if (!secret || bearer !== secret) return send(res, 401, { error: "unauthorized" }), true;

    const rel = path.slice(prefix.length);
    const ts = now || Date.now();

    if (rel === "/items" && req.method === "GET") {
      const state = String(url.searchParams.get("state") || "open");
      if (!STATES.includes(state) && state !== "all") {
        return send(res, 400, { error: `state 只能是 ${STATES.join("/")} 或 all` }), true;
      }
      const mine = url.searchParams.get("mine") === "1";
      let assignee = String(url.searchParams.get("assignee") || "");
      if (mine) {
        // 🔴 个人收件箱只认服务端派生的身份。两条都不许松：
        //    ①拿不到身份 ⇒ 400，不退化成看板、也不退化成自称的 assignee
        //    ②同时给 assignee ⇒ 400，免得出现"mine=1 但看的是别人"的歧义写法
        const caller = callerOf(req);
        if (!caller) {
          return send(res, 400, {
            error: "mine=1 需要可信的调用者身份（x-yoyoo-caller）——请通过连接器代理调用；不接受请求里自称的 assignee",
          }), true;
        }
        if (assignee) {
          return send(res, 400, { error: "mine=1 和 assignee 不能同时给" }), true;
        }
        assignee = caller;
      }
      return send(res, 200, { items: qList.all({ state, assignee }), mine, viewer: mine ? assignee : undefined }), true;
    }

    if (rel === "/stats" && req.method === "GET") {
      const out = { open: 0, done: 0, cancelled: 0 };
      for (const r of qStats.all()) out[r.state] = r.n;
      return send(res, 200, out), true;
    }

    if (rel === "/items" && req.method === "POST") {
      let body; try { body = await readJson(req); } catch (e) { return send(res, 400, { error: String(e.message || e) }), true; }
      const r = create(body, ts);
      return send(res, r.status, r.body), true;
    }

    const seg = rel.slice(1).split("/");
    const id = decodeURIComponent(seg[0] || "");
    const action = seg[1] || "";
    if (!id || !action) return false;

    const row = qGet.get(id);
    if (!row) return send(res, 404, { error: "not found" }), true;

    if ((action === "done" || action === "cancel") && req.method === "POST") {
      let body = {}; try { body = await readJson(req); } catch {}
      const note = String(body.note || "").trim();
      // 🔴 理由必填。Company Memory 里"人当时为什么这么定"只有这一个来源；
      //    允许空理由 = 这条 Loop 的记录从此不可回溯。
      if (!note) return send(res, 400, { error: "note 必填——这条理由是以后唯一能查到「当时为什么这么定」的地方" }), true;

      const t = transition(row.state, action === "done" ? "done" : "cancel");
      if (!t.ok) return send(res, t.status, { error: t.error }), true;

      const outcome = action === "done" ? (clip(body.outcome, 60) || "done") : "cancelled";
      // 🔴 "是谁拍的板"优先用服务端派生的身份，请求体里的 `by` 只是没有身份时的兜底。
      //    这条记录以后是 Company Memory 里唯一的"当时谁定的"，让它可自称就等于没记。
      const doneBy = callerOf(req) || String(body.by || "human");
      qDone.run(t.next, outcome, clip(note, 1000), ts, doneBy, id);

      // ── 路由：这一环做完，按表派生下一环（表在 ROUTES，此处不判断具体种类）──
      let spawned = null;
      if (t.next === "done") {
        const route = ROUTES[row.kind];
        if (route && route.next) {
          const nextAssignee = route.actor === "ai" ? "ai" : row.assignee;
          const r = create({
            kind: route.next, loop: row.loop,
            title: `${ROUTES[route.next].label}：${row.entity_ref || row.title}`,
            detail: `上一环「${route.label}」已由 ${doneBy} 处理（${outcome}）。理由：${note}`,
            entity_id: row.entity_id, entity_ref: row.entity_ref,
            assignee: nextAssignee, created_by: "system", parent_id: row.id,
            dedupe_key: `${route.next}:${row.entity_id || row.id}`,
          }, ts);
          spawned = r.body;
        }
      }
      return send(res, 200, { id, state: t.next, outcome, spawned }), true;
    }

    return false;
  }

  // `create` 是**对外的**：需求池受理之后要派生工作项，走的就是它。
  // （不放在 _internals 里 —— 那个前缀的意思是"测试才碰"，让生产代码去碰
  //   会让下一个人以为可以随便动它的签名。）
  return { handle, create, _internals: { qGet, qList } };
}

export default createWorklist;
