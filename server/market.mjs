/**
 * 超级应用市场 · 后端（SPEC-market.md §3~§5）
 *
 * 这一层的立场：**市场完全长在我们自己的账本里**，不动宿主任何一张表。
 * 宿主只回答"这个人是谁"（沿用 index.mjs 的 whoami），剩下的归属、快照、
 * 安装关系、侧栏钉位全在这个 SQLite 文件里 —— 所以整个换壳时生态不会丢，
 * 这正是不寄生宿主市场的全部理由（§0）。
 *
 * 三个关键决定（为什么这么写，别改回去）：
 *  · **发布 = 照快照，不是活引用**（§2.1）。listing_versions 存独立蓝图副本。
 *    活引用的后果：作者改坏自己的应用 → 所有装过的人当场一起坏。
 *  · **安装 = 复制到你名下**（§2.2）。在 apps 里给安装者插新记录，记来源。
 *    装完就是他的，改坏也只坏他那份。
 *  · **更新是通知不是推送**（§2.3）。作者发新版只让 update_available 变 true，
 *    安装者点了才覆盖，且**先备份旧蓝图**可一键回退。
 *    自动推送 = 作者对所有安装者的数据有写权限，不给。
 */
import { randomUUID } from "node:crypto";
import { normalizeForStore } from "./blueprint.mjs";
import { scanForSecrets } from "./secrets.mjs";
import { send, readJson, clip } from "./http-util.mjs";

/**
 * 侧栏钉位上限。**写死 6**（§4.2）——
 * 这是别人家的侧栏，借一格算客气，填满是失礼，也是给用户造垃圾场。
 * 用户想放更多 ⇒ 该做"我的应用"里的置顶区，不是继续占侧栏。
 */
export const PIN_LIMIT = 6;

/**
 * 发布/发新版限流：每人每分钟 3 次（§5.8）。
 * 上限可用 `YOYOO_PUBLISH_MAX` 覆盖 —— 运维要放宽或收紧时不用改代码，
 * 冒烟测试也靠它把"限流真的会拦"和"正常流程别被自己的限流卡住"分开验。
 */
const PUBLISH_WINDOW_MS = 60_000;
export const PUBLISH_MAX_DEFAULT = 3;

/**
 * 建表 + 给 apps 补两列。
 * `ADD COLUMN` 在 node:sqlite 里重复执行会抛 —— 所以先读 table_info 判断，
 * 而不是 try/catch 吞掉（吞掉会把"表结构真的错了"也一起吞掉）。
 */
export function initMarketSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS listings (
      id          TEXT PRIMARY KEY,
      space_id    TEXT NOT NULL,
      author_uid  TEXT NOT NULL,
      app_id      TEXT NOT NULL,
      name        TEXT NOT NULL,
      icon        TEXT,
      summary     TEXT NOT NULL,
      created_by  TEXT NOT NULL DEFAULT 'human',
      version     INTEGER NOT NULL,
      status      TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_listings_browse
      ON listings(space_id, status, updated_at DESC);
    CREATE TABLE IF NOT EXISTS listing_versions (
      listing_id  TEXT NOT NULL,
      version     INTEGER NOT NULL,
      blueprint   TEXT NOT NULL,
      note        TEXT,
      created_at  INTEGER NOT NULL,
      PRIMARY KEY (listing_id, version)
    );
    CREATE TABLE IF NOT EXISTS installs (
      listing_id  TEXT NOT NULL,
      uid         TEXT NOT NULL,
      app_id      TEXT NOT NULL,
      version     INTEGER NOT NULL,
      created_at  INTEGER NOT NULL,
      PRIMARY KEY (listing_id, uid)
    );
    CREATE TABLE IF NOT EXISTS pins (
      uid         TEXT NOT NULL,
      app_id      TEXT NOT NULL,
      sort        INTEGER NOT NULL,
      PRIMARY KEY (uid, app_id)
    );
    CREATE TABLE IF NOT EXISTS app_backups (
      app_id       TEXT PRIMARY KEY,
      blueprint    TEXT NOT NULL,
      from_version INTEGER,
      created_at   INTEGER NOT NULL
    );
  `);

  // apps 加两列：从市场装来的记来源；老数据为 NULL ＝"自己造的"
  const cols = new Set(db.prepare(`PRAGMA table_info(apps)`).all().map((r) => r.name));
  if (!cols.has("source_listing_id")) {
    db.exec(`ALTER TABLE apps ADD COLUMN source_listing_id TEXT`);
  }
  if (!cols.has("source_version")) {
    db.exec(`ALTER TABLE apps ADD COLUMN source_version INTEGER`);
  }
}

/**
 * 排序白名单。
 *
 * 🔴 ORDER BY 不能用占位符，只能拼进 SQL —— 所以拼进去的字符串**只允许**
 *    从这张表里取，绝不允许是请求里那个字符串本身。请求参数只用来当 key，
 *    key 不在表里就落回 `new`。这条是这个文件里唯一一处字符串拼 SQL，
 *    structure.test.mjs 有一条测试钉着它。
 */
const BROWSE_ORDER = {
  new: "l.updated_at DESC",
  hot: "installs DESC, l.updated_at DESC",
};

/**
 * 浏览用的 SQL。**不含 blueprint** —— 逛市场不等于拿走全部实现（§4.1 铁线）。
 *
 * @param {{sort?: string, mine?: boolean}} o
 *   sort: 见 BROWSE_ORDER；mine: 只看我发布的（「我的发布」那一栏）
 */
function browseSql({ sort, mine }) {
  const order = BROWSE_ORDER[sort] || BROWSE_ORDER.new;
  return `
      SELECT l.id, l.author_uid, l.name, l.icon, l.summary, l.created_by,
             l.version, l.created_at, l.updated_at,
             (SELECT COUNT(*) FROM installs i WHERE i.listing_id = l.id) AS installs,
             (SELECT i.app_id  FROM installs i WHERE i.listing_id = l.id AND i.uid = ?) AS my_app_id,
             (SELECT i.version FROM installs i WHERE i.listing_id = l.id AND i.uid = ?) AS my_version
        FROM listings l
       WHERE l.space_id = ? AND l.status = 'listed'
         AND (? = '' OR l.name LIKE ? OR l.summary LIKE ?)
         ${mine ? "AND l.author_uid = ?" : ""}
       ORDER BY ${order}
       LIMIT ? OFFSET ?`;
}

/**
 * @param {object} o
 * @param {import("node:sqlite").DatabaseSync} o.db
 * @param {string} o.spaceId   本期单 Space；跨 Space 一律 404（§5.5）
 */
export function createMarket({ db, spaceId }) {
  initMarketSchema(db);

  const q = {
    // 浏览：不含蓝图（§4.1 铁线 —— 逛市场不等于拿走全部实现）。
    // 四种组合各编译一条，运行时**按 key 取**，不在请求路径上拼 SQL。
    browse: db.prepare(browseSql({ sort: "new", mine: false })),
    browseHot: db.prepare(browseSql({ sort: "hot", mine: false })),
    browseMine: db.prepare(browseSql({ sort: "new", mine: true })),
    browseMineHot: db.prepare(browseSql({ sort: "hot", mine: true })),
    byId: db.prepare(`SELECT * FROM listings WHERE id = ?`),
    versions: db.prepare(`
      SELECT version, note, created_at FROM listing_versions
       WHERE listing_id = ? ORDER BY version DESC LIMIT 50`),
    versionBlueprint: db.prepare(
      `SELECT blueprint FROM listing_versions WHERE listing_id = ? AND version = ?`),
    insertListing: db.prepare(`
      INSERT INTO listings
        (id, space_id, author_uid, app_id, name, icon, summary, created_by,
         version, status, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,'listed',?,?)`),
    insertVersion: db.prepare(`
      INSERT INTO listing_versions (listing_id, version, blueprint, note, created_at)
      VALUES (?,?,?,?,?)`),
    bumpVersion: db.prepare(
      `UPDATE listings SET version=?, name=?, icon=?, updated_at=? WHERE id=?`),
    delist: db.prepare(`UPDATE listings SET status='delisted', updated_at=? WHERE id=?`),
    listingByAppAndAuthor: db.prepare(
      `SELECT * FROM listings WHERE app_id = ? AND author_uid = ?`),
    installCount: db.prepare(`SELECT COUNT(*) AS n FROM installs WHERE listing_id = ?`),
    myInstall: db.prepare(`SELECT * FROM installs WHERE listing_id = ? AND uid = ?`),
    insertInstall: db.prepare(`
      INSERT INTO installs (listing_id, uid, app_id, version, created_at) VALUES (?,?,?,?,?)`),
    setInstallVersion: db.prepare(
      `UPDATE installs SET version=? WHERE listing_id=? AND uid=?`),

    // apps 侧
    appGet: db.prepare(`SELECT * FROM apps WHERE id = ? AND owner_uid = ?`),
    appInsertFromMarket: db.prepare(`
      INSERT INTO apps (id, owner_uid, name, icon, blueprint, created_by,
                        created_at, updated_at, source_listing_id, source_version)
      VALUES (?,?,?,?,?,?,?,?,?,?)`),
    appSetBlueprint: db.prepare(`
      UPDATE apps SET blueprint=?, source_version=?, updated_at=? WHERE id=? AND owner_uid=?`),
    appOwned: db.prepare(`SELECT id FROM apps WHERE id = ? AND owner_uid = ?`),

    backupPut: db.prepare(`
      INSERT INTO app_backups (app_id, blueprint, from_version, created_at)
      VALUES (?,?,?,?)
      ON CONFLICT(app_id) DO UPDATE SET
        blueprint=excluded.blueprint,
        from_version=excluded.from_version,
        created_at=excluded.created_at`),
    backupGet: db.prepare(`SELECT * FROM app_backups WHERE app_id = ?`),
    backupDel: db.prepare(`DELETE FROM app_backups WHERE app_id = ?`),

    pinsGet: db.prepare(`SELECT app_id, sort FROM pins WHERE uid = ? ORDER BY sort`),
    pinsClear: db.prepare(`DELETE FROM pins WHERE uid = ?`),
    pinsAdd: db.prepare(`INSERT INTO pins (uid, app_id, sort) VALUES (?,?,?)`),
  };

  /**
   * 发布限流。内存态：重启后清零 —— 这是限流不是配额，够用。
   *
   * 🔴 刻意拆成"看一眼"和"记一笔"两步：额度**只有发布真的成功了才扣**。
   *    发布带私货被拦下（409）是一次合法的两步流程 —— 作者被告知命中了什么，
   *    然后带确认再发一次。如果拦下也扣额度，他等于被自己的谨慎惩罚，
   *    三次里有两次浪费在同一个应用上。
   */
  const publishMax = Number(process.env.YOYOO_PUBLISH_MAX || PUBLISH_MAX_DEFAULT);
  const publishLog = new Map(); // uid -> number[]
  const recentPublishes = (uid, now) =>
    (publishLog.get(uid) || []).filter((t) => now - t < PUBLISH_WINDOW_MS);

  /** 看一眼额度够不够，不扣 */
  function rateExceeded(uid, now) {
    const arr = recentPublishes(uid, now);
    publishLog.set(uid, arr);
    return arr.length >= publishMax;
  }
  /** 发布成功后记一笔 */
  function ratePunch(uid, now) {
    const arr = recentPublishes(uid, now);
    arr.push(now);
    publishLog.set(uid, arr);
  }

  /**
   * 取一条对当前用户"可见"的 listing。
   * 🔴 不存在 / 跨 Space / 已下架 一律收敛成 404（§5.4、§5.5）——
   *    区分开来就等于告诉外面"这个 id 存在但你看不到"。
   */
  function visibleListing(id, { allowDelisted = false } = {}) {
    const row = q.byId.get(id);
    if (!row) return null;
    if (row.space_id !== spaceId) return null;
    if (!allowDelisted && row.status !== "listed") return null;
    return row;
  }

  /** 把作者当前应用照一张快照（入库前仍过收敛器 —— §5.1，判据只有一份） */
  function snapshot(appRow) {
    const norm = normalizeForStore(JSON.parse(appRow.blueprint));
    if (!norm.ok) return { ok: false, error: `蓝图不合法：${norm.error}` };
    return { ok: true, blueprint: norm.blueprint };
  }

  /**
   * 路由。命中返回 true，未命中返回 false（让 index.mjs 继续走它自己的分支）。
   * 进来时 uid 已经过鉴权 —— 市场所有接口都要求登录（§6 否定用例：未登录 401）。
   */
  async function handle(req, res, { path, url, uid, now, root }) {
    const rel = path.slice(root.length); // 形如 /market/listings/xxx

    // ── 侧栏钉位 ────────────────────────────────────────────────
    if (rel === "/pins") {
      if (req.method === "GET") {
        return send(res, 200, { pins: q.pinsGet.all(uid), limit: PIN_LIMIT }), true;
      }
      if (req.method === "PUT") {
        let body;
        try {
          body = await readJson(req);
        } catch (e) {
          return send(res, 400, { error: String(e.message || e) }), true;
        }
        const ids = Array.isArray(body.app_ids) ? body.app_ids.map(String) : null;
        if (!ids) return send(res, 400, { error: "app_ids required" }), true;
        const uniq = [...new Set(ids)];
        if (uniq.length > PIN_LIMIT) {
          return send(res, 400, { error: `侧栏最多钉 ${PIN_LIMIT} 个`, limit: PIN_LIMIT }), true;
        }
        // 只能钉自己名下的应用 —— 否则可以拿别人的 app_id 钉出一个打不开的图标
        for (const id of uniq) {
          if (!q.appOwned.get(id, uid)) {
            return send(res, 404, { error: "not found" }), true;
          }
        }
        q.pinsClear.run(uid);
        uniq.forEach((id, i) => q.pinsAdd.run(uid, id, i));
        return send(res, 200, { pins: q.pinsGet.all(uid), limit: PIN_LIMIT }), true;
      }
      return send(res, 405, { error: "method not allowed" }), true;
    }

    // ── 市场 ────────────────────────────────────────────────────
    if (rel === "/market/listings") {
      if (req.method === "GET") {
        const raw = clip(url.searchParams.get("q") || "", 80).trim();
        const like = `%${raw.replace(/[%_]/g, (m) => `\\${m}`)}%`;
        const page = Math.max(0, Number(url.searchParams.get("page") || 0) | 0);
        const size = 30;
        // 排序与「只看我发的」都只当 key 用：非法值一律落回默认，不进 SQL
        const hot = url.searchParams.get("sort") === "hot";
        const mine = url.searchParams.get("mine") === "1";
        const stmt = mine
          ? (hot ? q.browseMineHot : q.browseMine)
          : (hot ? q.browseHot : q.browse);
        const args = mine
          ? [uid, uid, spaceId, raw, like, like, uid, size, page * size]
          : [uid, uid, spaceId, raw, like, like, size, page * size];
        const rows = stmt.all(...args).map((r) => ({
          ...r,
          installed: r.my_app_id != null,
          update_available: r.my_app_id != null && r.version > r.my_version,
          // 谁发的：界面上「我的发布」要据此给出发新版/下架，别人的不给
          is_author: r.author_uid === uid,
        }));
        return send(res, 200, {
          listings: rows, page, page_size: size,
          sort: hot ? "hot" : "new", mine,
        }), true;
      }
      if (req.method === "POST") {
        let body;
        try {
          body = await readJson(req);
        } catch (e) {
          return send(res, 400, { error: String(e.message || e) }), true;
        }
        const appId = clip(body.app_id, 64);
        const summary = clip(body.summary, 140).trim();
        if (!appId) return send(res, 400, { error: "app_id required" }), true;
        if (!summary) return send(res, 400, { error: "summary required" }), true;

        const app = q.appGet.get(appId, uid);
        if (!app) return send(res, 404, { error: "not found" }), true;

        const already = q.listingByAppAndAuthor.get(appId, uid);
        if (already && already.status === "listed") {
          return send(res, 409, {
            error: "这个应用已经上架了，要更新请发新版本",
            listing_id: already.id,
          }), true;
        }
        if (rateExceeded(uid, now)) {
          return send(res, 429, { error: "发布太频繁，稍等一分钟" }), true;
        }

        const snap = snapshot(app);
        if (!snap.ok) return send(res, 400, { error: snap.error }), true;

        // 🔴 不可逆动作的门：命中私货就拦下并如实告知，不静默发布、不静默删改
        const scan = scanForSecrets({ blueprint: snap.blueprint, summary, name: app.name });
        if (!scan.clean && body.confirm_sensitive !== true) {
          return send(res, 409, {
            error: "sensitive_content",
            message: "这个应用里像是有不该公开的内容，确认后才发布",
            hits: scan.hits,
          }), true;
        }

        const id = randomUUID();
        q.insertListing.run(
          id, spaceId, uid, appId, app.name, app.icon, summary,
          app.created_by === "ai" ? "ai" : "human", 1, now, now);
        q.insertVersion.run(id, 1, JSON.stringify(snap.blueprint), clip(body.note, 200) || null, now);
        ratePunch(uid, now);
        console.log(`[yoyoo-market] publish listing=${id} app=${appId} author=${uid}`);
        return send(res, 201, { id, version: 1, status: "listed" }), true;
      }
      return send(res, 405, { error: "method not allowed" }), true;
    }

    if (rel.startsWith("/market/listings/")) {
      const seg = rel.slice("/market/listings/".length).split("/");
      const listingId = decodeURIComponent(seg[0] || "");
      const action = seg[1] || "";

      // 发新版
      if (action === "versions") {
        if (req.method !== "POST") return send(res, 405, { error: "method not allowed" }), true;
        const row = visibleListing(listingId);
        if (!row) return send(res, 404, { error: "not found" }), true;
        if (row.author_uid !== uid) return send(res, 403, { error: "只有作者能发新版" }), true;
        let body;
        try {
          body = await readJson(req);
        } catch (e) {
          return send(res, 400, { error: String(e.message || e) }), true;
        }
        if (rateExceeded(uid, now)) {
          return send(res, 429, { error: "发布太频繁，稍等一分钟" }), true;
        }
        const app = q.appGet.get(row.app_id, uid);
        if (!app) return send(res, 404, { error: "原始应用已不在，无法发新版" }), true;
        const snap = snapshot(app);
        if (!snap.ok) return send(res, 400, { error: snap.error }), true;
        const scan = scanForSecrets({ blueprint: snap.blueprint, name: app.name });
        if (!scan.clean && body.confirm_sensitive !== true) {
          return send(res, 409, {
            error: "sensitive_content",
            message: "这一版里像是有不该公开的内容，确认后才发布",
            hits: scan.hits,
          }), true;
        }
        const next = row.version + 1;
        q.insertVersion.run(listingId, next, JSON.stringify(snap.blueprint), clip(body.note, 200) || null, now);
        q.bumpVersion.run(next, app.name, app.icon, now, listingId);
        ratePunch(uid, now);
        console.log(`[yoyoo-market] new version listing=${listingId} v${next}`);
        return send(res, 201, { id: listingId, version: next }), true;
      }

      // 安装
      if (action === "install") {
        if (req.method !== "POST") return send(res, 405, { error: "method not allowed" }), true;
        const row = visibleListing(listingId);
        if (!row) return send(res, 404, { error: "not found" }), true;

        // 幂等：装过就返回已有那条，不产生第二份（§5.8）
        const mine = q.myInstall.get(listingId, uid);
        if (mine) {
          return send(res, 200, { app_id: mine.app_id, version: mine.version, already: true }), true;
        }

        const v = q.versionBlueprint.get(listingId, row.version);
        if (!v) return send(res, 500, { error: "快照缺失" }), true;
        // 快照入库前再过一次收敛器 —— 判据只有一份，路径多一条也不例外
        const norm = normalizeForStore(JSON.parse(v.blueprint));
        if (!norm.ok) return send(res, 500, { error: "快照不合法" }), true;

        const newAppId = randomUUID();
        q.appInsertFromMarket.run(
          newAppId, uid, row.name, row.icon, JSON.stringify(norm.blueprint),
          row.created_by, now, now, listingId, row.version);
        q.insertInstall.run(listingId, uid, newAppId, row.version, now);
        console.log(`[yoyoo-market] install listing=${listingId} uid=${uid} app=${newAppId}`);
        return send(res, 201, {
          app_id: newAppId,
          version: row.version,
          installs: q.installCount.get(listingId).n,
        }), true;
      }

      if (action) return send(res, 404, { error: "not found" }), true;

      // 详情 / 下架
      if (req.method === "GET") {
        const row = visibleListing(listingId, { allowDelisted: false });
        if (!row) return send(res, 404, { error: "not found" }), true;
        const mine = q.myInstall.get(listingId, uid);
        return send(res, 200, {
          id: row.id,
          name: row.name,
          icon: row.icon,
          summary: row.summary,
          created_by: row.created_by,
          author_uid: row.author_uid,
          version: row.version,
          created_at: row.created_at,
          updated_at: row.updated_at,
          installs: q.installCount.get(listingId).n,
          is_author: row.author_uid === uid,
          installed: !!mine,
          my_version: mine ? mine.version : null,
          update_available: !!mine && row.version > mine.version,
          versions: q.versions.all(listingId),
          // 🔴 详情**仍不含蓝图**：浏览不等于拿走实现（§4.1）
        }), true;
      }
      if (req.method === "DELETE") {
        const row = visibleListing(listingId);
        if (!row) return send(res, 404, { error: "not found" }), true;
        if (row.author_uid !== uid) return send(res, 403, { error: "只有作者能下架" }), true;
        // 下架不删数据：已装的人是副本，不受影响（§5.6）
        q.delist.run(now, listingId);
        return send(res, 200, { ok: true, status: "delisted" }), true;
      }
      return send(res, 405, { error: "method not allowed" }), true;
    }

    return false;
  }

  /**
   * `/apps/:id/sync` 与 `/apps/:id/revert` —— 挂在 apps 命名空间下，
   * 由 index.mjs 在解析出 id 之后转进来。
   */
  async function handleAppAction(req, res, { appId, action, uid, now }) {
    const app = q.appGet.get(appId, uid);
    if (!app) return send(res, 404, { error: "not found" }), true;

    if (action === "sync") {
      if (req.method !== "POST") return send(res, 405, { error: "method not allowed" }), true;
      if (!app.source_listing_id) {
        return send(res, 400, { error: "这个应用不是从市场装的，没有来源可更新" }), true;
      }
      const row = visibleListing(app.source_listing_id);
      if (!row) return send(res, 404, { error: "来源已下架或不存在" }), true;
      if (row.version <= (app.source_version ?? 0)) {
        return send(res, 200, { ok: true, updated: false, version: app.source_version }), true;
      }
      const v = q.versionBlueprint.get(row.id, row.version);
      if (!v) return send(res, 500, { error: "快照缺失" }), true;
      const norm = normalizeForStore(JSON.parse(v.blueprint));
      if (!norm.ok) return send(res, 500, { error: "快照不合法" }), true;

      // 先备份再覆盖 —— "一键回退"的前提（§2.3）
      q.backupPut.run(appId, app.blueprint, app.source_version ?? null, now);
      q.appSetBlueprint.run(JSON.stringify(norm.blueprint), row.version, now, appId, uid);
      q.setInstallVersion.run(row.version, row.id, uid);
      return send(res, 200, { ok: true, updated: true, version: row.version }), true;
    }

    if (action === "revert") {
      if (req.method !== "POST") return send(res, 405, { error: "method not allowed" }), true;
      const b = q.backupGet.get(appId);
      if (!b) return send(res, 404, { error: "没有可回退的备份" }), true;
      q.appSetBlueprint.run(b.blueprint, b.from_version ?? null, now, appId, uid);
      if (app.source_listing_id) {
        q.setInstallVersion.run(b.from_version ?? 0, app.source_listing_id, uid);
      }
      q.backupDel.run(appId);
      return send(res, 200, { ok: true, version: b.from_version ?? null }), true;
    }

    return false;
  }

  /**
   * 应用被删掉时的清理。
   * 🔴 不做这件事会有一个很难看的洞：安装是幂等的（装过就返回已有那条），
   *    可用户把装来的应用删了之后，installs 那条还在 ⇒ 他再点"安装"会拿到一个
   *    **已经不存在的 app_id**，界面上表现为"装了但打不开"。
   *    删应用同时删掉安装关系和钉位，重装才回到正常语义。
   *    安装数随之 -1 也是对的：他确实不再装着了（§5.7 安装数是实时统计）。
   */
  const installsDelByApp = db.prepare(`DELETE FROM installs WHERE uid = ? AND app_id = ?`);
  const pinsDelByApp = db.prepare(`DELETE FROM pins WHERE uid = ? AND app_id = ?`);
  function onAppDeleted(uid, appId) {
    installsDelByApp.run(uid, appId);
    pinsDelByApp.run(uid, appId);
    q.backupDel.run(appId);
  }

  /** 给 GET /apps 列表用：算出每条应用"有没有更新" */
  const listExtras = db.prepare(`
    SELECT a.id,
           a.source_listing_id,
           a.source_version,
           l.version AS latest_version,
           l.status  AS source_status
      FROM apps a JOIN listings l ON l.id = a.source_listing_id
     WHERE a.owner_uid = ?`);

  function decorateAppList(uid, apps) {
    const byId = new Map(listExtras.all(uid).map((r) => [r.id, r]));
    const pinned = new Set(q.pinsGet.all(uid).map((r) => r.app_id));
    return apps.map((a) => {
      const x = byId.get(a.id);
      return {
        ...a,
        pinned: pinned.has(a.id),
        source_listing_id: x ? x.source_listing_id : null,
        update_available: !!x && x.source_status === "listed" && x.latest_version > x.source_version,
      };
    });
  }

  return { handle, handleAppAction, decorateAppList, onAppDeleted, PIN_LIMIT };
}
