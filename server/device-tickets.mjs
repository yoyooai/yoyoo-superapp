/**
 * 设备工单看板的后端 —— 「设备AIOS」工单中心从"点一下、刷新就没了"
 * 变成"点一下、谁都能看到、下次打开还在"的那一半（09-08，苏白拍板先做①）。
 *
 * 跟 worklist.mjs 同一个模子：挂在 `${prefix}` 下，只认一把共享密钥，
 * 由「设备AIOS」应用唯一持有的一个连接器代理调用。之所以不копy整套
 * worklist 的 ROUTES/状态机——这里只有一条产线的一块看板，五段流转是
 * 固定的（不需要一张可扩展的路由表），架子越薄，越不容易在下一次改坏。
 *
 * 路由：
 *   GET  /tickets                              全部工单（首次访问自动播种示例数据）
 *   POST /tickets/:id/transition  { to, actor, what, assignee? }
 *        流转一步，追加一条流转记录（时间由服务端打，不是前端编的"刚刚"）
 */
import { randomUUID } from "node:crypto";
import { send, readJson, clip } from "./http-util.mjs";
import { ticketCardParams, actionById } from "./device-tickets-card.mjs";

export const LANES = ["open", "assigned", "doing", "review", "done"];

export function initDeviceTicketsSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS device_tickets (
      id         TEXT PRIMARY KEY,
      device     TEXT NOT NULL,
      title      TEXT NOT NULL,
      priority   TEXT NOT NULL,
      reporter   TEXT NOT NULL,
      assignee   TEXT NOT NULL DEFAULT '',
      lane       TEXT NOT NULL,
      history    TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}

/** "MM-DD HH:mm"，跟前端展示的历史时间戳同一种写法，方便前端不用区分"哪条是服务端打的"。 */
function fmtTime(ts) {
  const d = new Date(ts);
  const p2 = (n) => String(n).padStart(2, "0");
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

// 首次访问自动播种的示例数据——跟前端原来内置的演示数据是同一批，
// 只是现在写进库里、大家看到的是同一份，不再是"每个人的浏览器各自演一遍"。
function seedRows(now) {
  const seed = [
    { device: "耦合封装机-03", title: "耦合光功率未达阈值", priority: "high",
      reporter: "耦合封装机-03(AI)", assignee: "", lane: "open",
      history: [{ t: "09-08 14:05", who: "耦合封装机-03(AI)", what: "监测到耦合光功率低于阈值，自动生成工单" }] },
    { device: "贴片机-01", title: "贴装吸嘴气压偏低", priority: "mid",
      reporter: "贴片机-01(AI)", assignee: "维修工-老李", lane: "assigned",
      history: [
        { t: "09-08 09:10", who: "贴片机-01(AI)", what: "监测到吸嘴气压偏低，自动生成工单" },
        { t: "09-08 09:18", who: "产线班长-王芳", what: "确认工单，派工给 维修工-老李" },
      ] },
    { device: "打线机-02", title: "键合强度抽检不足", priority: "mid",
      reporter: "打线机-02(AI)", assignee: "维修工-老王", lane: "doing",
      history: [
        { t: "09-08 08:22", who: "打线机-02(AI)", what: "抽检键合强度低于标准，自动生成工单" },
        { t: "09-08 08:30", who: "产线班长-王芳", what: "确认工单，派工给 维修工-老王" },
        { t: "09-08 08:41", who: "维修工-老王", what: "开始维修（更换劈刀）" },
      ] },
    { device: "老化测试架-04", title: "腔体温控偏差0.8℃", priority: "low",
      reporter: "老化测试架-04(AI)", assignee: "维修工-老李", lane: "review",
      history: [
        { t: "09-07 16:02", who: "老化测试架-04(AI)", what: "监测到腔体温控偏差超出±0.5℃，自动生成工单" },
        { t: "09-07 16:20", who: "产线班长-王芳", what: "确认工单，派工给 维修工-老李" },
        { t: "09-07 17:05", who: "维修工-老李", what: "完成温控校准，提交验收" },
      ] },
    { device: "打线机-02", title: "劈刀磨损导致键合强度不足", priority: "high",
      reporter: "打线机-02(AI)", assignee: "维修工-老王", lane: "done",
      history: [
        { t: "08-14 08:10", who: "打线机-02(AI)", what: "抽检键合强度不足，自动生成工单" },
        { t: "08-14 08:25", who: "产线班长-王芳", what: "确认工单，派工给 维修工-老王" },
        { t: "08-14 09:02", who: "维修工-老王", what: "更换劈刀，提交验收" },
        { t: "08-14 09:40", who: "产线班长-王芳", what: "验收通过，工单关闭" },
      ] },
    { device: "贴片机-01", title: "视觉对位漂移", priority: "mid",
      reporter: "贴片机-01(AI)", assignee: "维修工-老李", lane: "done",
      history: [
        { t: "07-22 10:15", who: "贴片机-01(AI)", what: "视觉对位偏差超限，自动生成工单" },
        { t: "07-22 10:30", who: "产线班长-王芳", what: "确认工单，派工给 维修工-老李" },
        { t: "07-22 11:12", who: "维修工-老李", what: "重新标定视觉系统，提交验收" },
        { t: "07-22 11:35", who: "产线班长-王芳", what: "验收通过，工单关闭" },
      ] },
  ];
  return seed.map((s) => ({ id: `T-${randomUUID().slice(0, 8)}`, created_at: now, updated_at: now, ...s }));
}

export function createDeviceTickets({ db, prefix, secret }) {
  initDeviceTicketsSchema(db);

  const qAll = db.prepare(`SELECT * FROM device_tickets ORDER BY created_at ASC`);
  const qCount = db.prepare(`SELECT count(*) n FROM device_tickets`);
  const qGet = db.prepare(`SELECT * FROM device_tickets WHERE id=?`);
  const qIns = db.prepare(`
    INSERT INTO device_tickets (id,device,title,priority,reporter,assignee,lane,history,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const qUpdate = db.prepare(`UPDATE device_tickets SET lane=?, assignee=?, history=?, updated_at=? WHERE id=?`);

  function rowOut(row) {
    return { ...row, history: JSON.parse(row.history) };
  }

  /** 没数据时播种一次——保证任何人第一次打开这块看板都不是空的。只做这一件事，幂等。 */
  function ensureSeeded(now) {
    if (qCount.get().n > 0) return;
    for (const t of seedRows(now)) {
      qIns.run(t.id, t.device, t.title, t.priority, t.reporter, t.assignee, t.lane, JSON.stringify(t.history), t.created_at, t.updated_at);
    }
  }

  /**
   * 流转一步的唯一落库处——`/transition`（人在超级应用页面里点）和
   * `/card-action`（人在 OCTO 卡片上点）都走这一个函数，不许各写一份，
   * 否则"两条路各改各的库"迟早会长成两份互相打脸的状态机。
   * 不做鉴权/校验，只管落库；调用方已经确认过 `to` 合法。
   */
  function applyTransition(row, { to, actor, what, assignee }, ts) {
    const history = JSON.parse(row.history);
    history.push({ t: fmtTime(ts), who: actor, what });
    const nextAssignee = clip(assignee, 40).trim() || row.assignee;
    qUpdate.run(to, nextAssignee, JSON.stringify(history), ts, row.id);
    return rowOut({ ...row, lane: to, assignee: nextAssignee, history: JSON.stringify(history), updated_at: ts });
  }

  async function handle(req, res, { path, now }) {
    if (!path.startsWith(prefix)) return false;

    const bearer = String(req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
    if (!secret || bearer !== secret) return send(res, 401, { error: "unauthorized" }), true;

    const rel = path.slice(prefix.length);
    const ts = now || Date.now();

    if (rel === "/tickets" && req.method === "GET") {
      ensureSeeded(ts);
      return send(res, 200, { tickets: qAll.all().map(rowOut) }), true;
    }

    // `/card-action`：OCTO 卡片按钮点击回调（octo-connector 的即时旁路，
    // 见其 config.mjs parseInstantWebhooks 头注）。**刻意不带 :id**——
    // 连接器的登记表只存一个固定 url，识别哪条工单靠 body.data.ticket_id，
    // 不是靠 URL 路径，否则每条工单都要单独登记一个 webhook。
    if (rel === "/card-action" && req.method === "POST") {
      let body; try { body = await readJson(req); } catch (e) { return send(res, 400, { error: String(e.message || e) }), true; }
      const ticketId = decodeURIComponent(String(body.data?.ticket_id || ""));
      const row = ticketId ? qGet.get(ticketId) : null;
      if (!row) return send(res, 404, { ok: false, error: "ticket not found" }), true;

      // 🔴 `to`/`what` 一律**从当前车道 + action_id 现算**（actionById），
      //    绝不信 body.data 里带的 `to`——那份 data 是卡片发出那一刻烤进去的，
      //    群里躺着的卡片可能已经很旧（工单被别的操作动过），信它就会把工单
      //    拽回一个过期状态。这跟 worklist.mjs 的状态机是同一条戒律：
      //    真相只能是"服务端现在的状态"，不能是"客户端记得的状态"。
      const actionId = String(body.action_id || "");
      const act = actionById(row.lane, actionId);
      if (!act) {
        return send(res, 400, {
          ok: false,
          error: `按钮「${actionId}」对当前车道（${row.lane}）已经不适用——工单已经被流转过，这张卡是旧的`,
        }), true;
      }
      const actor = clip(body.operator_name, 40).trim() || clip(body.operator_uid, 40).trim() || "OCTO";
      const updated = applyTransition(row, { to: act.to, actor, what: act.what }, ts);
      return send(res, 200, { ok: true, ticket: updated, card: ticketCardParams(updated) }), true;
    }

    const seg = rel.slice(1).split("/");
    const id = decodeURIComponent(seg[0] || "");
    const action = seg[1] || "";
    if (rel === "/tickets" || rel === "/card-action" || !id || action !== "transition") return false;

    const row = qGet.get(id);
    if (!row) return send(res, 404, { error: "not found" }), true;
    if (req.method !== "POST") return send(res, 405, { error: "method not allowed" }), true;

    let body; try { body = await readJson(req); } catch (e) { return send(res, 400, { error: String(e.message || e) }), true; }
    const to = String(body.to || "");
    if (!LANES.includes(to)) return send(res, 400, { error: `to 必须是 ${LANES.join("/")} 之一` }), true;
    const actor = clip(body.actor, 40).trim();
    const what = clip(body.what, 200).trim();
    if (!actor || !what) return send(res, 400, { error: "actor 和 what 必填——流转记录不能是空的" }), true;
    return send(res, 200, applyTransition(row, { to, actor, what, assignee: body.assignee }, ts)), true;
  }

  return { handle, _internals: { qAll, qGet, ensureSeeded, applyTransition } };
}

export default createDeviceTickets;
