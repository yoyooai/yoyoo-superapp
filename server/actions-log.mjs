/**
 * 通用"标记/备注"动作日志 —— 给静态数据类应用（增长/私域/供应链……）加一个
 * 真实能写、能存住的操作入口，不用为每个业务再单独写一个 mock 后端。
 *
 * 09-04 苏白验收总览/增长两个应用时打回：纯 table/list 堆叠没有一处真实交互，
 * 点了没反应。§8.3 script 节点本身没有"持久化状态"的能力（沙盒里的 DOM 状态
 * 刷新就没），必须经 connectorCall 打到一个真的会写库的地方——这个模块就是
 * 那个"真的会写库的地方"，且刻意做成跟具体业务无关（entity_id 是调用方自己定
 * 的字符串，比如一个达人昵称、一个 SKU 编码、一条客诉记录的标识），这样増长/
 * 私域/供应链能共用同一个连接器，不用每个 app 各起一套后端。
 *
 * 语义很窄，只干一件事：给某个 entity 记一条"谁在什么时候标了什么状态/写了什么备注"，
 * 并且"查这个 entity 当前状态"= 它最新的一条记录。不做工作流、不做审批链、
 * 不做多人协作冲突处理——要那些是下一步，现在先把"点了真的存住"这一步做实。
 */
import { randomUUID } from "node:crypto";
import { send, readJson, clip } from "./http-util.mjs";

export function initActionsLogSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_actions (
      id          TEXT PRIMARY KEY,
      app_key     TEXT NOT NULL,
      entity_id   TEXT NOT NULL,
      action      TEXT NOT NULL,
      note        TEXT,
      created_at  INTEGER NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_app_actions_lookup ON app_actions(app_key, entity_id, created_at DESC);`);
}

export function createActionsLog({ db, prefix, secret }) {
  initActionsLogSchema(db);

  const qInsert = db.prepare(
    `INSERT INTO app_actions (id, app_key, entity_id, action, note, created_at) VALUES (?,?,?,?,?,?)`,
  );
  // created_at 精度是毫秒，同一毫秒内连续两次 mark 会撞时间戳——用 rowid 兜底
  // 保证"最新一条"真的是最后写入的那条，不依赖时间戳唯一。
  const qListAll = db.prepare(
    `SELECT * FROM app_actions WHERE app_key=? ORDER BY created_at DESC, rowid DESC`,
  );
  const qListEntity = db.prepare(
    `SELECT * FROM app_actions WHERE app_key=? AND entity_id=? ORDER BY created_at DESC, rowid DESC`,
  );

  async function handle(req, res, { path, url }) {
    if (!path.startsWith(prefix)) return false;
    const bearer = String(req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
    if (!secret || bearer !== secret) return send(res, 401, { error: "unauthorized" }), true;

    const rel = path.slice(prefix.length);

    if (rel === "/mark" && req.method === "POST") {
      let body = {};
      try { body = await readJson(req); } catch { return send(res, 400, { error: "bad json" }), true; }
      const appKey = clip(body.app_key, 80);
      const entityId = clip(body.entity_id, 200);
      const action = clip(body.action, 80);
      if (!appKey || !entityId || !action) {
        return send(res, 400, { error: "app_key/entity_id/action 都不能为空" }), true;
      }
      const row = {
        id: randomUUID(),
        app_key: appKey,
        entity_id: entityId,
        action,
        note: clip(body.note, 500) || null,
        created_at: Date.now(),
      };
      qInsert.run(row.id, row.app_key, row.entity_id, row.action, row.note, row.created_at);
      return send(res, 200, { ok: true, ...row }), true;
    }

    if (rel === "/list" && req.method === "GET") {
      const appKey = clip(url.searchParams.get("app_key"), 80);
      const entityId = clip(url.searchParams.get("entity_id"), 200);
      if (!appKey) return send(res, 400, { error: "app_key 必填" }), true;
      const rows = entityId ? qListEntity.all(appKey, entityId) : qListAll.all(appKey);
      // 每个 entity 只暴露"当前状态"= 最新一条，历史仍然全部存着，只是这里不吐全量
      const latestByEntity = new Map();
      for (const r of rows) {
        if (!latestByEntity.has(r.entity_id)) latestByEntity.set(r.entity_id, r);
      }
      return send(res, 200, { items: rows, latest: Array.from(latestByEntity.values()) }), true;
    }

    return false;
  }

  return { handle };
}
