/**
 * 外部渠道消息记录（微信 / 飞书 / …）—— 「渠道」页右边看到的真实内容就是它。
 *
 * ── 为什么有这个模块（苏白 2026-09-09 夜）───────────────────────
 * 他问：「我现在飞书和微信不是都接入了吗？为什么你这里显示没有呢？」
 * 他说得对：这些渠道**是通的**，通在**AI 自己身上**（小A 就在微信/飞书上收发），
 * 只是记录一直留在 AI 那台机器上，平台这边从来没有存放它们的地方。
 * 这个模块就是那个地方：AI 把自己的渠道记录**回传**过来，平台存下来，渠道页直接看。
 *
 * ── 边界（09-09 先放宽，09-10 按他的要求收紧）──────────────────
 * 09-09 他说：「先把功能实现了，把权限开大点无所谓，反正都是自己在用，自己在测试」。
 * 09-10 他把边界定死了：「每个人只能看到自己作为 owner 的这个 bot 的内容…
 *        这些 A 属于谁谁就能看到，不属于他的他都看不到。」
 *
 * 所以现在：**读取按主人过滤**（`ownerScope` 开关，默认开）。
 * 🔴 过滤依据不是记录里那个自报的 `owner_uid` 字段 —— 自报的东西不能拿来当权限判据
 *    （谁回传谁说了算 ＝ 没有边界）。依据是 `ai-owners` 登记册里可核验的归属，
 *    由调用方把"这个人名下有哪些 AI"算好传进来（`scopeAiUids`）。
 * 🔴 这里的 `ai_uid`/`owner_uid` 两列从第一天就存着，所以这次收紧是加一个 WHERE，
 *    没有重刷历史 —— 当初坚持空着也要存下来，就是为了今天这一下。
 *
 * ── 回传口的鉴权（两条路）──────────────────────────────────────
 * 回传方是**没有用户 session 的机器**（AI 的宿主机），所以它不能走用户面鉴权。
 *
 *  ① **它自己的 bot 凭据**（`Authorization: Bearer bf_…`）—— 首选，09-10 加。
 *     这条路上 `ai_uid` 是**我们向宿主问出来的**（`/v1/bot/register`），
 *     不是回传方自报的 ⇒ 谁也没法把自己的记录挂到别人名下。
 *     受邀进来的 AI 手上本来就有这串凭据，不需要我们再发一个共享秘密给它 ——
 *     发共享秘密给每个新 AI 才是真正走不通的那条路（一个人泄露，全体重置）。
 *
 *  ② 共享令牌（env `YOYOO_CHANNEL_INGEST_TOKEN`）—— 兼容既有回传器。
 *     这条路上 `ai_uid` 只能靠自报，所以它只适合我们自己的机器。
 *
 * 🔴 两条路都没配/都不对时 `POST /ingest` **一律拒绝**，绝不"没配就放行"——
 *    那等于把一个公网写入口敞开着（这一条是刻意写死的，别改成默认放行）。
 */
import { send, readJson, clip } from "./http-util.mjs";

/** 单条正文上限。渠道里有人会贴很长的东西，但记录页不是文件柜。 */
const MAX_TEXT = 4000;
/** 一次回传最多几条 —— 防止一发把库和内存打满 */
const MAX_BATCH = 2000;
/** 消息列表默认/最大条数 */
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

export function initChannelRecordSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_records (
      id          TEXT PRIMARY KEY,     -- 回传方给的稳定 id（同一条重复回传会覆盖，不会翻倍）
      channel     TEXT NOT NULL,        -- wechat | feishu | …（渠道的机器名，界面另有中文名）
      ai_uid      TEXT NOT NULL,        -- 这条记录是哪个 AI 收发的（回传方自报）
      ai_name     TEXT,                 -- 那个 AI 的显示名（回传方自报；只用来做名字兜底）
      owner_uid   TEXT,                 -- 那个 AI 的主人；收紧可见性时用（现在不过滤）
      conv_id     TEXT NOT NULL,        -- 渠道内的会话 id（已归一，不含逐条消息的后缀）
      conv_name   TEXT NOT NULL,        -- 显示名；取不到就是 conv_id 本身，不编好看的假名
      conv_kind   TEXT NOT NULL,        -- dm | group
      direction   TEXT NOT NULL,        -- in（别人说的）| out（AI 说的）
      from_name   TEXT NOT NULL,
      ts          INTEGER NOT NULL,     -- 秒
      text        TEXT NOT NULL,
      ingested_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chrec_conv ON channel_records(channel, conv_id, ts);
    CREATE INDEX IF NOT EXISTS idx_chrec_channel ON channel_records(channel, ts DESC);
  `);
  // 🔴 老库补列（09-10 加的 ai_name）。CREATE TABLE IF NOT EXISTS 对已存在的表
  //    什么都不做 ⇒ 不补这一句，线上老库会因为缺列而**整个模块起不来**。
  const cols = db.prepare("PRAGMA table_info(channel_records)").all().map((c) => c.name);
  if (!cols.includes("ai_name")) db.exec("ALTER TABLE channel_records ADD COLUMN ai_name TEXT");
}

const clean = (v, max = 200) => clip(String(v ?? "").trim(), max);

export function createChannelRecords({
  db, ingestToken = "", recordOwnership = null, botAuth = null,
}) {
  initChannelRecordSchema(db);

  const q = {
    upsert: db.prepare(`
      INSERT INTO channel_records
        (id,channel,ai_uid,ai_name,owner_uid,conv_id,conv_name,conv_kind,direction,from_name,ts,text,ingested_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        -- 🔴 ai_uid / owner_uid 必须在这里更新（2026-09-10）：
        --    回传方一开始把 ai_uid 填成了**主人的 uid**（.env 里 OCTO_BOT_UID 被填错），
        --    小A 在平台上的真 uid 是 287iwx0ivku315c1a83_bot（反引号在模板字符串里会截断，别加）。
        --    发现后要能"重传即修正"，
        --    而第一版这里只更新 conv_name/text ⇒ 错的归属会永久钉在库里，只能清库重来。
        --    幂等的意义就是"重传一遍就是对的"，所以这些可修正字段都要跟着 excluded 走。
        ai_uid=excluded.ai_uid, ai_name=excluded.ai_name, owner_uid=excluded.owner_uid,
        conv_name=excluded.conv_name, conv_kind=excluded.conv_kind,
        direction=excluded.direction, from_name=excluded.from_name, ts=excluded.ts,
        text=excluded.text, ingested_at=excluded.ingested_at
    `),
    /*
     * ── 读取面的查询都是**拼出来的**，不是写死的 prepare ──────────────
     * 原因只有一个：可见范围是一个**变长的 uid 列表**（这个人名下有几个 AI 就有几个），
     * SQLite 的参数占位符没有"传一个数组"这回事 ⇒ 要么按个数拼占位符，
     * 要么把过滤挪到 JS 里做。后者是错的：分页/聚合都在 SQL 里，
     * 在 JS 里过滤等于先把别人的数据读出来再假装没看见。
     * 所以按个数缓存 prepare（同一个人反复看是同一条语句，不会真的每次编译）。
     */
    _cache: new Map(),
  };

  /** 按 SQL 文本缓存 prepare —— 拼出来的语句只有有限几种形状。 */
  function prep(sql) {
    let st = q._cache.get(sql);
    if (!st) {
      st = db.prepare(sql);
      q._cache.set(sql, st);
    }
    return st;
  }

  /**
   * 可见范围 → 一段 SQL 条件 + 参数。
   * `null` ＝ 不限制（开关关掉时）；`[]` ＝ **一个都看不到**（登记册里没有他的 AI）。
   * 🔴 空数组必须落成 `1=0` 而不是"不加条件"：把"没有可见的 AI"当成"看全部"
   *    是这类过滤最经典的一种翻车方式。
   */
  function scopeClause(scopeAiUids) {
    if (!scopeAiUids) return { sql: "", params: [] };
    if (!scopeAiUids.length) return { sql: " AND 1=0", params: [] };
    return {
      sql: ` AND ai_uid IN (${scopeAiUids.map(() => "?").join(",")})`,
      params: scopeAiUids.slice(),
    };
  }

  /** 单个 Agent 过滤（界面上的切换器）叠在可见范围之上，不能代替它。 */
  function aiClause(aiUid) {
    return aiUid ? { sql: " AND ai_uid = ?", params: [aiUid] } : { sql: "", params: [] };
  }

  const combine = (...parts) => ({
    sql: parts.map((p) => p.sql).join(""),
    params: parts.flatMap((p) => p.params),
  });

  const reads = {
    summary(where) {
      return prep(
        `SELECT channel, COUNT(*) AS messages, COUNT(DISTINCT conv_id) AS conversations,
                MAX(ts) AS last_ts, MAX(ingested_at) AS last_ingest
           FROM channel_records WHERE 1=1${where.sql}
          GROUP BY channel ORDER BY last_ts DESC`
      ).all(...where.params);
    },
    agents(where) {
      return prep(
        `SELECT ai_uid, MAX(ai_name) AS ai_name, MAX(owner_uid) AS owner_uid,
                COUNT(*) AS messages,
                COUNT(DISTINCT channel || ':' || conv_id) AS conversations,
                MAX(ts) AS last_ts, GROUP_CONCAT(DISTINCT channel) AS channels
           FROM channel_records WHERE 1=1${where.sql}
          GROUP BY ai_uid ORDER BY last_ts DESC`
      ).all(...where.params);
    },
    agentsInChannel(channel, where) {
      return prep(
        `SELECT ai_uid, MAX(ai_name) AS ai_name, MAX(owner_uid) AS owner_uid,
                COUNT(*) AS messages, COUNT(DISTINCT conv_id) AS conversations,
                MAX(ts) AS last_ts, GROUP_CONCAT(DISTINCT channel) AS channels
           FROM channel_records WHERE channel = ?${where.sql}
          GROUP BY ai_uid ORDER BY last_ts DESC`
      ).all(channel, ...where.params);
    },
    conversations(channel, where) {
      return prep(
        `SELECT conv_id, conv_kind, MAX(conv_name) AS conv_name,
                COUNT(*) AS messages, MAX(ts) AS last_ts
           FROM channel_records WHERE channel = ?${where.sql}
          GROUP BY conv_id, conv_kind ORDER BY last_ts DESC LIMIT 200`
      ).all(channel, ...where.params);
    },
    lastText(channel, convId, where) {
      return prep(
        `SELECT text, direction, from_name FROM channel_records
          WHERE channel = ? AND conv_id = ?${where.sql}
          ORDER BY ts DESC, rowid DESC LIMIT 1`
      ).get(channel, convId, ...where.params);
    },
    messages(channel, convId, where, limit) {
      return prep(
        `SELECT id, ts, direction, from_name, text, ai_uid FROM channel_records
          WHERE channel = ? AND conv_id = ?${where.sql}
          ORDER BY ts DESC, rowid DESC LIMIT ?`
      ).all(channel, convId, ...where.params, limit);
    },
  };

  /**
   * 回传口。**挡在用户面鉴权之前**（回传方没有 session）。
   * 返回 true ＝ 已处理，调用方不要再往下走。
   */
  async function handleIngest(req, res, { path, root }) {
    if (path !== `${root}/channel-records/ingest`) return false;
    if (req.method !== "POST") {
      send(res, 405, { error: "method not allowed" });
      return true;
    }
    /*
     * 鉴权。先看 bot 凭据那条路（它更强：ai_uid 由宿主认定，不是自报），
     * 没带就退回共享令牌。两条都不成立 ⇒ 拒。
     * `verifiedAiUid` 非空时，下面会**无视 body 里自报的 ai_uid**。
     */
    let verifiedAiUid = null;
    const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    if (bearer && botAuth?.identify) {
      const who = await botAuth.identify(bearer);
      if (!who.ok) {
        send(res, who.status, { error: who.error });
        return true;
      }
      verifiedAiUid = who.robotId;
    } else {
      // 🔴 没配令牌 = 关门，不是放行
      if (!ingestToken) {
        send(res, 503, {
          error: "ingest disabled",
          why: "既没有带 bot 凭据（Authorization: Bearer bf_…），"
            + "服务端也没有配共享令牌 YOYOO_CHANNEL_INGEST_TOKEN。",
        });
        return true;
      }
      const given = String(req.headers["x-yoyoo-ingest-token"] || "");
      if (given !== ingestToken) {
        send(res, 401, { error: "bad ingest token" });
        return true;
      }
    }
    let body;
    try {
      // 一批 2000 条可能超过默认 512KB 上限，显式放到 4MB
      body = await readJson(req, 4 * 1024 * 1024);
    } catch {
      send(res, 400, { error: "bad json" });
      return true;
    }
    const channel = clean(body?.channel, 40);
    // 🔴 走 bot 凭据那条路时，身份**以宿主认定的为准**，body 里写什么都不算数。
    //    （09-10 就真出过一次身份填错：回传器把 ai_uid 填成了主人的 uid，
    //      于是全部记录错挂在人名下。让服务端去问，这类错就没有存在的余地。）
    const aiUid = verifiedAiUid || clean(body?.ai_uid, 80);
    // 显示名是**兜底**用的：界面优先用宿主名册里的名字（那是权威的），
    // 名册里查不到时才用这个 —— 比摆一串 uid 好，比编一个名字诚实。
    const aiName = body?.ai_name ? clean(body.ai_name, 80) : null;
    const ownerUid = body?.owner_uid ? clean(body.owner_uid, 80) : null;
    const rows = Array.isArray(body?.messages) ? body.messages : [];
    if (!channel || !aiUid) {
      send(res, 400, { error: "channel and ai_uid are required" });
      return true;
    }
    if (rows.length > MAX_BATCH) {
      send(res, 413, { error: `too many messages (max ${MAX_BATCH})` });
      return true;
    }
    /*
     * 兜底登记归属（source: 'ingest'，最软的一档，见 ai-owners.mjs 文件头）。
     * 🔴 只在这个 AI 还没有任何登记时才生效 —— 登记册那边会挡住覆盖。
     *    自报的归属不能改写已核验的归属，否则回传口就成了归属篡改口。
     */
    if (ownerUid) {
      recordOwnership?.({ aiUid, ownerUid, aiName, source: "ingest" });
    }

    const now = Date.now();
    let stored = 0;
    let skipped = 0;
    for (const m of rows) {
      const id = clean(m?.id, 160);
      const convId = clean(m?.conv_id, 160);
      const ts = Number(m?.ts);
      const text = clip(String(m?.text ?? ""), MAX_TEXT);
      // 缺 id / 会话 / 时间的一律丢掉：没有它们这条记录没法定位，也没法去重
      if (!id || !convId || !Number.isFinite(ts) || ts <= 0) {
        skipped += 1;
        continue;
      }
      q.upsert.run(
        id,
        channel,
        aiUid,
        aiName,
        ownerUid,
        convId,
        clean(m?.conv_name, 200) || convId,
        m?.conv_kind === "group" ? "group" : "dm",
        m?.direction === "out" ? "out" : "in",
        clean(m?.from_name, 80) || "(未知)",
        Math.floor(ts),
        text,
        now
      );
      stored += 1;
    }
    send(res, 200, { ok: true, stored, skipped });
    return true;
  }

  /**
   * 读取面（挂在用户面鉴权之后）。
   *
   * `scopeAiUids`：这个人**看得见哪些 AI**（由调用方从 ai-owners 登记册算好）。
   *   `null`  ＝ 不限制（开关关掉时的老行为）
   *   `[]`    ＝ 一个都看不到（他名下还没登记 AI）—— 响应里会明说，
   *             否则界面会呈现成"平台上什么记录都没有"，那是在说谎。
   */
  async function handle(req, res, { path, url, root, scopeAiUids = null }) {
    const base = `${root}/channel-records`;
    if (!path.startsWith(base)) return false;
    if (req.method !== "GET") {
      send(res, 405, { error: "method not allowed" });
      return true;
    }

    const scope = scopeClause(scopeAiUids);
    /** 空态自证：界面要能说清"这是没有记录，还是你名下没有 AI"。 */
    const scopeInfo = {
      owner_scoped: scopeAiUids !== null,
      visible_agents: scopeAiUids === null ? null : scopeAiUids.length,
    };

    // 🔴 切换器选的那个 Agent 必须**落在可见范围之内**：
    //    不校验的话，随手把 ai_uid= 换成别人的 uid 就绕过了整条边界。
    const askedAi = clean(url.searchParams.get("ai_uid"), 80);
    if (askedAi && scopeAiUids && !scopeAiUids.includes(askedAi)) {
      send(res, 403, { error: "not your agent", ...scopeInfo });
      return true;
    }
    const aiUid = askedAi;
    const where = combine(scope, aiClause(aiUid));

    if (path === `${base}/summary`) {
      send(res, 200, { ai_uid: aiUid || null, ...scopeInfo, channels: reads.summary(where) });
      return true;
    }

    // 有哪些 Agent 回传过记录（切换器的选项）。可选 `channel=` 只看某条渠道里的。
    if (path === `${base}/agents`) {
      const channel = clean(url.searchParams.get("channel"), 40);
      const rows = (channel ? reads.agentsInChannel(channel, scope) : reads.agents(scope)).map((a) => ({
        ai_uid: a.ai_uid,
        ai_name: a.ai_name || null,
        owner_uid: a.owner_uid || null,
        messages: a.messages,
        conversations: a.conversations,
        last_ts: a.last_ts,
        // GROUP_CONCAT 给的是 "wechat,feishu" 这样的串，切成数组再给前端 ——
        // 让界面去 split 是把存储细节漏到界面里。
        channels: String(a.channels || "").split(",").filter(Boolean),
      }));
      send(res, 200, { channel: channel || null, ...scopeInfo, agents: rows });
      return true;
    }

    if (path === `${base}/conversations`) {
      const channel = clean(url.searchParams.get("channel"), 40);
      if (!channel) {
        send(res, 400, { error: "channel is required" });
        return true;
      }
      const list = reads.conversations(channel, where).map((c) => {
        // 🔴 预览也要跟着同一套过滤：不然选了「只看小A」，列表里的最后一句
        //    可能是另一个 Agent 说的 —— 那就是把过滤条件说了谎。
        const last = reads.lastText(channel, c.conv_id, where);
        return {
          conv_id: c.conv_id,
          conv_name: c.conv_name,
          conv_kind: c.conv_kind,
          messages: c.messages,
          last_ts: c.last_ts,
          last_text: last ? last.text : "",
          last_from: last ? last.from_name : "",
        };
      });
      send(res, 200, { channel, ai_uid: aiUid || null, ...scopeInfo, conversations: list });
      return true;
    }

    if (path === `${base}/messages`) {
      const channel = clean(url.searchParams.get("channel"), 40);
      const convId = clean(url.searchParams.get("conv_id"), 160);
      if (!channel || !convId) {
        send(res, 400, { error: "channel and conv_id are required" });
        return true;
      }
      const want = Number(url.searchParams.get("limit"));
      const limit = Math.min(
        Math.max(Number.isFinite(want) && want > 0 ? Math.floor(want) : DEFAULT_LIMIT, 1),
        MAX_LIMIT
      );
      // 取最近 limit 条（倒序取，正序给 —— 界面按时间从早到晚读）
      const rows = reads.messages(channel, convId, where, limit).reverse();
      send(res, 200, { channel, conv_id: convId, ai_uid: aiUid || null, ...scopeInfo, messages: rows });
      return true;
    }

    return false;
  }

  return { handle, handleIngest };
}
