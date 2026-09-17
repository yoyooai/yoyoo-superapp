/**
 * 应用分享到群 —— 让工作台从"一个人的私人物品"变成"一个群能打开的东西"。
 *
 * 起因（09-04 苏白）："怎么把它给发到群里边？怎么让大家都能看得到？同事啥也没进来，
 * 权限也不够。" 查下来根因很硬：`apps` 表每一条查询都带 `WHERE owner_uid=?`，
 * 工作台在数据库里就是他的私人物品，别人打开只会 404。
 *
 * ── 为什么是"分享到群"而不是"同 Space 都能看" ──────────────────
 * 「同 Space 可见」听起来省事，但范围是隐式的：Space 里以后会有客户、外部协作者，
 * 一个开关就把所有工作台摊给所有人，且没人说得清"谁能看见什么"。
 * 苏白的原话是"发到**群**里边"——群本来就是他心里的协作单位，边界清楚、可撤销、
 * 也天然对齐后面卡片路由那条路（发到群 = 路由的雏形）。
 *
 * ── 谁能打开：用访问者自己的凭据证明，不靠服务端特权 ──────────────
 * 判定走宿主 `GET /v1/group/my?space_id=` —— **带 space_id 时返回的是
 * "该 Space 下这个用户加入的所有群"**（不是"保存的群"，我查过实现，语义不同，
 * 这里要的是前者）。用的是访问者请求里那把 token：
 *   · 服务端不持有、也不需要任何特权 token —— 泄露面没有扩大
 *   · 他能证明的只有他自己的身份和他自己的群，冒充不了别人
 *   · 宿主不可达 ⇒ 拒（fail closed，不是"宿主挂了就先信着"）
 *
 * ── 只读是硬边界 ────────────────────────────────────────────
 * 分享出去的只能看不能改：PUT / DELETE 仍然严格锁 owner_uid。
 * 群成员打开拿到的是 `readonly:true` 的副本，改不了别人的东西。
 */
import { send, readJson } from "./http-util.mjs";

/** 群成员关系会变（有人被移出群），缓存必须短。 */
const GROUPS_TTL_MS = 30_000;

export function initAppSharesSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_shares (
      app_id     TEXT NOT NULL,
      group_no   TEXT NOT NULL,
      shared_by  TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (app_id, group_no)
    );
    CREATE INDEX IF NOT EXISTS idx_app_shares_app ON app_shares(app_id);
  `);
}

export function createAppShares({ db, hostGroupsUrl, spaceId, fetchImpl, now = Date.now }) {
  initAppSharesSchema(db);
  const doFetch = fetchImpl || fetch;
  const groupsCache = new Map(); // token -> { groups:Set, at }

  const qSharesOf = db.prepare(`SELECT group_no FROM app_shares WHERE app_id=?`);
  const qInsert = db.prepare(
    `INSERT OR IGNORE INTO app_shares (app_id,group_no,shared_by,created_at) VALUES (?,?,?,?)`);
  const qDelete = db.prepare(`DELETE FROM app_shares WHERE app_id=? AND group_no=?`);
  const qDeleteApp = db.prepare(`DELETE FROM app_shares WHERE app_id=?`);
  const qList = db.prepare(
    `SELECT app_id, group_no, shared_by, created_at FROM app_shares WHERE app_id=? ORDER BY created_at DESC`);
  const qByGroup = db.prepare(`SELECT app_id, group_no FROM app_shares WHERE group_no=?`);

  /** 这个应用被分享到了哪些群。 */
  function groupsFor(appId) {
    return qSharesOf.all(appId).map((r) => r.group_no);
  }

  function shareList(appId) {
    return qList.all(appId);
  }

  function share(appId, groupNo, byUid) {
    qInsert.run(appId, groupNo, byUid, now());
  }

  function unshare(appId, groupNo) {
    qDelete.run(appId, groupNo);
  }

  /** 应用被删掉时，分享记录跟着走，别留孤儿行。 */
  function onAppDeleted(appId) {
    qDeleteApp.run(appId);
  }

  /**
   * 拿访问者自己的 token 去问宿主"你在这个 Space 里加入了哪些群"。
   * 🔴 任何异常一律返回 null＝不可判定，调用方必须当作"不放行"。
   */
  async function groupsOfViewer(token) {
    if (!token) return null;
    const hit = groupsCache.get(token);
    if (hit && now() - hit.at < GROUPS_TTL_MS) return hit.groups;

    const url = `${hostGroupsUrl}?space_id=${encodeURIComponent(spaceId || "")}`;
    let res;
    try {
      res = await doFetch(url, {
        headers: { token, Authorization: token },
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      return null; // 宿主不可达 ⇒ fail closed
    }
    if (!res.ok) return null;

    let body;
    try {
      body = await res.json();
    } catch {
      return null;
    }
    // 宿主直接返数组；也兼容 {data:[...]} 这种包一层的写法。
    const arr = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : null;
    if (!arr) return null;

    const groups = new Set(arr.map((g) => g?.group_no).filter(Boolean));
    groupsCache.set(token, { groups, at: now() });
    return groups;
  }

  /**
   * 这个访问者能不能只读打开这个应用。
   * 能 ⇒ 返回命中的群号；不能 ⇒ null。
   */
  async function canView(appId, token) {
    const shared = groupsFor(appId);
    if (!shared.length) return null; // 没分享给任何群 ⇒ 直接拒，连宿主都不用问

    const mine = await groupsOfViewer(token);
    if (!mine) return null; // 不可判定 ⇒ 拒

    for (const g of shared) if (mine.has(g)) return g;
    return null;
  }

  /**
   * 这个访问者能只读打开哪些别人的应用 —— `canView` 的复数版，给「我的应用」列表用。
   *
   * 起因（09-04 苏白实测）：同事进来「我的应用 0」。应用打得开（深链直达），但列表里
   * 没有——因为列表只查 `owner_uid=自己`。对她而言"我什么都没有"，路只有一条：
   * 别人把链接贴给她。分享要成立，被分享的东西就得出现在她的架子上。
   *
   * 判定和 `canView` 是同一份：访问者自己的 token、宿主不可达就当看不见（fail closed）。
   * 返回 `Map<app_id, group_no>` —— 带上命中的群号，前端可以说清"因为在哪个群才看得到"。
   */
  async function sharedAppsFor(token) {
    const mine = await groupsOfViewer(token);
    if (!mine || mine.size === 0) return new Map();
    const out = new Map();
    for (const g of mine) {
      for (const r of qByGroup.all(g)) {
        if (!out.has(r.app_id)) out.set(r.app_id, r.group_no);
      }
    }
    return out;
  }

  return { groupsFor, shareList, share, unshare, onAppDeleted, canView, groupsOfViewer, sharedAppsFor };
}
