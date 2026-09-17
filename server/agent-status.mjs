/**
 * 「这个 AI 此刻在干什么」—— 状态上报（heartbeat）。
 *
 * ── 为什么有这个模块（苏白 2026-09-10 夜）─────────────────────────
 * 原话：「同意，做一级入口，进入后可以看到，然后我觉得没问题了，就开始做真实的数据接入」
 *       「这次是不是就可以接入真实数据了？」
 *
 * 「AI 办公室」那一屏上，**唯一真正的看点是"它此刻在干什么、干到第几步"**。
 * 平台库里本来就有的是：有哪些 AI（`ai_owners`）、最后什么时候说过话
 * （`channel_records.last_ts`）—— 那些是**名册**，不是**处境**。
 * 谁都没在报"我在干活"，所以"接真实数据"不是查库，是**先造这一层**。这个模块就是那一层。
 *
 * ── 字段用通用集，不自造 ─────────────────────────────────────────
 * OTel GenAI / OpenInference / Langfuse 三家的公共交集
 * （调研正本 `workspace/virtual-office-study/README.md` 第 2 节）。
 * 自造一套字段的代价是：以后每接一个别人的 AI 都要写一层翻译。
 *
 * ── 🔴 最要紧的一条：不知道就说不知道 ───────────────────────────
 * `ts + ttl < now` ⇒ 这条状态**过期**，读取面返回 `stale:true`，界面显示「未上报」。
 * **不显示忙、也不假装闲。** 一个不上报的 AI，我们就是不知道它在干什么。
 * 这一整页存在的意义是"看得见真实处境"，拿默认值填满反而是最坏的结果 ——
 * 那就是换一种方式的示例数据，而且这次没有角标提醒人。
 *
 * ── 鉴权：照抄渠道回传口那条已经验证过的路（channel-records.mjs 文件头）──
 *  ① **bot 凭据**（`Authorization: Bearer bf_…`）—— 首选。`ai_uid` 是**我们向宿主问出来的**，
 *     上报方自报的一律不算数。09-10 渠道回传真出过"把 ai_uid 填成主人 uid"的事故，
 *     全部记录错挂在人名下；让服务端去问，这类错就没有存在的余地。
 *  ② 共享令牌（env `YOYOO_AGENT_STATUS_TOKEN`，缺省回退到渠道那把
 *     `YOYOO_CHANNEL_INGEST_TOKEN`）—— 只适合我们自己的机器。
 *  🔴 两条都没配/都不对 ⇒ **一律拒**，绝不"没配就放行"。这是一个公网写入口。
 *
 * ── 可见性：和渠道记录同一套边界 ─────────────────────────────────
 * 读取面按 `ai-owners` 登记册过滤（`scopeAiUids` 由调用方算好传进来）。
 * 🔴 依据不是上报里那个自报的 owner_uid —— 自报的东西不能当权限判据。
 * 🔴 空数组落成 `1=0`，不是"不加条件"。（把"没有可见的 AI"当成"看全部"
 *    是这类过滤最经典的翻车方式，渠道那边同一条注释。）
 */
import { send, readJson, clip } from "./http-util.mjs";

/** 多久没再上报就算过期（秒）。上报方可以自己给更短/更长的。 */
const DEFAULT_TTL = 180;
const MAX_TTL = 3600;
/** 事件流一次最多存几条 / 读几条 —— 这是终端不是文件柜。 */
const MAX_EVENT_BATCH = 200;
const DEFAULT_EVENT_LIMIT = 60;
const MAX_EVENT_LIMIT = 300;
/** 每个 AI 只留最近这么多条事件，多的滚掉（库不是日志归档）。 */
const KEEP_EVENTS_PER_AI = 400;
/** 产出：一次最多报几件 / 每个 AI 留最近几件。同上，这是陈列柜不是网盘。 */
const MAX_ARTIFACT_BATCH = 50;
const KEEP_ARTIFACTS_PER_AI = 200;
const DEFAULT_ARTIFACT_LIMIT = 50;
const MAX_ARTIFACT_LIMIT = 200;

/**
 * 产出的种类。不认识的一律落成 file —— 同 STATUSES 那条：不许替上报方编内容。
 * 刻意只有这几种：界面要按种类给图标，种类无限多就等于没有种类。
 */
const ARTIFACT_KINDS = new Set(["file", "doc", "code", "image", "data", "link", "msg"]);

/*
 * ── 2026-09-14 新增三类：健康 / 记忆 / 备份 ─────────────────────────
 * 苏白 09-14 深夜：「先把阿里云效那版里有用的东西搬过来……健康中心啦、记忆系统啦、
 * 文件管理器啦、备份系统啦」。
 *
 * 🔴 为什么长在这个模块里，而不是各开一个文件：这四样是**同一件事的四个切面**
 *    —— "AI 主动把自己的情况报上来"。上报协议只能有一处真源，散成四个文件
 *    就会变成四套鉴权、四套可见范围、四种过期判定，早晚有一处忘了改。
 * 🔴 与产出（agent_artifacts）同一条规矩：平台存的是**指路条**，不是东西本身。
 *    记忆的内容在 AI 那儿，备份的包也在 AI 那儿；我们只负责"看得见、说得清"。
 */

/** 记忆分层。不认识的落成 other —— 同 ARTIFACT_KINDS 那条：不许替上报方编内容。 */
const MEMORY_TIERS = new Set([
  "identity", "state", "reference", "profile", "session", "archive", "other",
]);
/** 备份一条的结果。不认识的落成 unknown —— 尤其不许默认成 ok。 */
const BACKUP_RESULTS = new Set(["ok", "warn", "fail", "unknown"]);
/** 健康问题的轻重。不认识的落成 info —— 不许把不认识的默默升成 error。 */
const ISSUE_LEVELS = new Set(["info", "warn", "error"]);

/**
 * 一件活的状态。**不认识的一律拒收**（不像 kind/result 那样兜底落值）——
 * 理由写在 agent_tasks 建表注释里：一件活不存在"不知道处在什么状态"的合理情形，
 * 默默落成 todo 会凭空造出一份根本没人报过的待办清单。
 */
const TASK_STATES = new Set(["todo", "doing", "done", "blocked", "cancelled"]);

/** 审批的轻重。不认识落 mid —— 既不许默默降成 low，也不许吓唬成 high。 */
const RISK_LEVELS = new Set(["low", "mid", "high"]);
/** 审批能落到的几种结局。pending 只由上报产生，其余只由人产生。 */
const APPROVAL_DECISIONS = new Set(["approved", "rejected", "withdrawn"]);
/** 问题台账上人能做的几种处置。 */
const ISSUE_HANDLES = new Set(["acked", "fixed", "ignored", "open"]);
/** 巡检结果。不认识落 unknown，绝不默认 ok（同备份那条）。 */
const CHECK_RESULTS = new Set(["ok", "warn", "fail", "unknown"]);

const MAX_APPROVAL_BATCH = 50;
const KEEP_APPROVALS_PER_AI = 200;
const MAX_ISSUE_BATCH = 100;
const KEEP_ISSUES_PER_AI = 300;
const MAX_CHECK_BATCH = 100;
const KEEP_CHECKS_PER_AI = 200;

const MAX_TASK_BATCH = 100;
const KEEP_TASKS_PER_AI = 300;
const MAX_SKILL_BATCH = 200;
const KEEP_SKILLS_PER_AI = 400;
const MAX_ROLE_BATCH = 60;
const KEEP_ROLES_PER_AI = 120;

const MAX_MEMORY_BATCH = 200;
const KEEP_MEMORIES_PER_AI = 800;
const MAX_BACKUP_BATCH = 50;
const KEEP_BACKUPS_PER_AI = 120;
const MAX_ISSUES = 30;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;

/** 认得的状态。别的一律落成 off —— 不认识的状态不许糊弄成 busy。 */
const STATUSES = new Set(["busy", "idle", "wait", "err", "off"]);

export function initAgentStatusSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_status (
      ai_uid     TEXT PRIMARY KEY,
      ai_name    TEXT,
      owner_uid  TEXT,                  -- 只做兜底显示；权限判定不看它
      status     TEXT NOT NULL,         -- busy | idle | wait | err | off
      activity   TEXT,                  -- 此刻在干的那一句（'$ Edit memory/state.md'）
      task       TEXT,                  -- 这件活的名字
      step_i     INTEGER,               -- 第几步
      step_n     INTEGER,               -- 共几步
      progress   REAL,                  -- 0~1
      model      TEXT,
      tokens     TEXT,                  -- 上报方自己说的数，不做换算（各家口径不同）
      place      TEXT,                  -- 可选：它在哪个房间（meet/serv/loun…），页面用
      started_at INTEGER,               -- 这个状态什么时候开始的（秒）
      ts         INTEGER NOT NULL,      -- 这条上报的时刻（秒）
      ttl        INTEGER NOT NULL,      -- 多久没再报就算过期（秒）
      updated_at INTEGER NOT NULL       -- 服务端收到的时刻（毫秒）
    );
    CREATE INDEX IF NOT EXISTS idx_agent_status_owner ON agent_status(owner_uid);

    CREATE TABLE IF NOT EXISTS agent_events (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      ai_uid   TEXT NOT NULL,
      ts       INTEGER NOT NULL,        -- 秒
      kind     TEXT NOT NULL,           -- ok | wr | er | cm（页面终端的四种色）
      text     TEXT NOT NULL,
      status   TEXT                     -- 发生时的状态，时间轴按它折色块
    );
    CREATE INDEX IF NOT EXISTS idx_agent_events_ai ON agent_events(ai_uid, ts);

    /*
     * 「它干出过什么」—— 档案页第二块。
     *
     * 🔴 存的是**指路条**，不是文件本身：title + kind + href(+ summary)。
     *    平台不做网盘 —— 东西在 AI 自己那儿，我们只负责"看得见它做过"。
     *    真要托管文件是另一件事（确认书 22｜资产），不在这一层混着做。
     * 🔴 主键 (ai_uid, key)：key 由上报方给（它那边稳定的标识，如文件路径）。
     *    没给就按 title 兜底 —— 重报同一件事必须是覆盖，不是又长一行。
     *    这和渠道回传用 id 去重是同一条规矩：补历史、修错都只要"再传一遍"。
     */
    CREATE TABLE IF NOT EXISTS agent_artifacts (
      ai_uid     TEXT NOT NULL,
      key        TEXT NOT NULL,
      title      TEXT NOT NULL,
      kind       TEXT NOT NULL,          -- file | doc | code | image | data | link | msg
      href       TEXT,                   -- 可点开的地址；没有就只是陈列
      summary    TEXT,                   -- 一句话：这是什么
      task       TEXT,                   -- 属于哪件活（和 agent_status.task 对得上）
      ts         INTEGER NOT NULL,       -- 产出时刻（秒）
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (ai_uid, key)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_artifacts_ai ON agent_artifacts(ai_uid, ts);

    /*
     * 「这台 AI 还好吗」—— 健康中心（形态取自阿里云效那版的 HealthCenterPage：
     * 实例状态 / 运行时 / 上次心跳 / 系统资源三条 / 当前问题 / 可做的操作）。
     *
     * 🔴 一个 AI 一行（PRIMARY KEY ai_uid）：健康是**此刻**的样子，不是流水。
     *    历史要看时间轴（agent_events），不在这张表里堆。
     * 🔴 三条资源各有两列：*_pct 给进度条（0~1），*_text 是上报方自己的说法
     *    （'1.2 / 4 GB'）。只留百分比就得由界面反推数字，只留文本就画不了条。
     * 🔴 actions 只是**登记它支持哪些自救操作**，不代表平台能替它点。
     *    平台没有它那台机器的控制通道 —— 画一个点不动的按钮比不画更坏。
     */
    CREATE TABLE IF NOT EXISTS agent_health (
      ai_uid     TEXT PRIMARY KEY,
      runtime    TEXT,                   -- 'zylos 0.8.1' 这样的一句
      cpu_pct    REAL, cpu_text  TEXT,
      mem_pct    REAL, mem_text  TEXT,
      disk_pct   REAL, disk_text TEXT,
      issues     TEXT,                   -- JSON 数组 [{level,title,detail,at}]
      actions    TEXT,                   -- JSON 数组 [{key,title,desc,level}]
      ts         INTEGER NOT NULL,       -- 这条健康报告的时刻（秒）
      ttl        INTEGER NOT NULL,       -- 多久不再报就算过期
      updated_at INTEGER NOT NULL
    );

    /*
     * 「它记住了什么」—— 记忆中心（形态取自那版 MemoryPage：一棵记忆文件树 + 大小 + 摘要）。
     *
     * 🔴 存**目录**，不存内容：path / bytes / 摘要。内容在 AI 自己那儿。
     *    把别人的记忆正文抄进平台库，等于平台成了第二份真源，两边永远对不上；
     *    而且那是它最私密的东西，没有理由默认躺在我们库里。
     * 🔴 主键 (ai_uid, path)：重报同一条是覆盖。同 agent_artifacts 那条。
     */
    CREATE TABLE IF NOT EXISTS agent_memories (
      ai_uid     TEXT NOT NULL,
      path       TEXT NOT NULL,          -- 'memory/state.md'
      title      TEXT,                   -- 人话名字；没有就界面拿 path 收尾那段
      tier       TEXT NOT NULL,          -- identity|state|reference|profile|session|archive|other
      bytes      INTEGER,
      summary    TEXT,                   -- 一句话：这里面是什么
      updated_ts INTEGER,                -- 这份记忆自己上次变动的时刻（秒）
      ts         INTEGER NOT NULL,       -- 这条上报的时刻（秒）
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (ai_uid, path)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_memories_ai ON agent_memories(ai_uid, tier, path);

    /*
     * 「备份还在跑吗、取得回来吗」—— 备份中心。
     *
     * 🔴 restorable 是**上报方自己声称**的，界面必须照实说"它说能取回"，
     *    不许显示成平台验证过。真验证是另一件事（要真跑一次恢复），不在这一层假装。
     * 🔴 result 不认识就是 unknown，尤其不许默认成 ok —— 一个静静显示"备份正常"
     *    的看板比没有看板更危险。
     */
    CREATE TABLE IF NOT EXISTS agent_backups (
      ai_uid     TEXT NOT NULL,
      key        TEXT NOT NULL,          -- 这条备份任务的稳定标识
      target     TEXT NOT NULL,          -- 备的是什么（'记忆本体' / '数据库'）
      place      TEXT,                   -- 备到哪（'腾讯COS ap-hongkong' / '本机 vault'）
      bytes      INTEGER,
      result     TEXT NOT NULL,          -- ok | warn | fail | unknown
      restorable INTEGER,                -- 1/0/null：它说能不能取回来（null=没说）
      note       TEXT,
      ts         INTEGER NOT NULL,       -- 上次备份的时刻（秒）
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (ai_uid, key)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_backups_ai ON agent_backups(ai_uid, ts);

    /*
     * 「它手上有哪些活」—— 任务。
     *
     * 🔴 这张表**没有可抄的形态**：那版（阿里云效）features/tasks 下只有一个 scss，
     *    页面根本没写。所以字段是自己定的，定法沿用已有两张表的规矩：
     *    主键 (ai_uid, key) ⇒ 重报同一件活是覆盖，不是又长一行。
     * 🔴 state 不认识**一律拒**（见 TASK_STATES 那条），不做兜底落值：
     *    产出/备份那种"不认识落 file / 落 unknown"是因为那两样确实存在
     *    "说不清是什么"的合理情形；一件活不可能"不知道处在什么状态" ——
     *    真不知道就别报这条。默默落成 todo 会凭空造出一份待办清单。
     * 🔴 blocker 单独一列而不是塞进 detail：界面对 blocked 要单独说一句
     *    「卡在哪」，混在正文里就得靠猜着切。
     */
    CREATE TABLE IF NOT EXISTS agent_tasks (
      ai_uid     TEXT NOT NULL,
      key        TEXT NOT NULL,
      title      TEXT NOT NULL,
      state      TEXT NOT NULL,          -- todo | doing | done | blocked | cancelled
      detail     TEXT,
      priority   INTEGER,                -- 1 最急；null = 它没说（不是"不急"）
      progress   REAL,                   -- 0~1；null = 它没说
      due_ts     INTEGER,                -- 什么时候要
      done_ts    INTEGER,                -- 什么时候干完的
      blocker    TEXT,                   -- 卡在哪（state=blocked 时界面要显示这一句）
      ts         INTEGER NOT NULL,       -- 这条上报的时刻（秒）
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (ai_uid, key)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_tasks_ai ON agent_tasks(ai_uid, state, ts);

    /*
     * 「它会哪些本事」—— 技能。形态取自那版 SkillsPage.vue：
     * 一格一个技能卡，写明开没开、什么版本、一句说明，顶上一行「共 N 个 · 已开启 M 个」。
     *
     * 🔴 那版的卡片**点得动**（点一下开关技能并同步到通道），我们这版**点不动** ——
     *    平台没有它那台机器的控制通道，同健康中心 actions 那条：
     *    画一个点不动的按钮比不画更坏。这里只登记"它说自己会什么"。
     * 🔴 enabled 三态：1 开 / 0 关 / **null 它没说**。null 不许显示成"关着" ——
     *    那是替上报方下结论（同 agent_backups.restorable 那条）。
     */
    CREATE TABLE IF NOT EXISTS agent_skills (
      ai_uid     TEXT NOT NULL,
      key        TEXT NOT NULL,
      name       TEXT NOT NULL,
      summary    TEXT,                   -- 一句话：这个技能干什么
      enabled    INTEGER,                -- 1/0/null：开着 / 关着 / 它没说
      version    TEXT,
      source     TEXT,                   -- 哪来的（内置 / 第三方仓 / 自己写的）
      category   TEXT,
      ts         INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (ai_uid, key)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_skills_ai ON agent_skills(ai_uid, name);

    /*
     * 「它现在是什么角色」—— 角色。形态取自那版 RolesPage.vue：
     * 一张当前角色 + 一列可选角色，每个带一段设定说明。
     *
     * 🔴 同技能那条：那版能点着切角色，我们只读。
     * 🔴 active 三态同 enabled。一个 AI 同时报多个 active=1 时，界面按 ts 最新的那条
     *    当"当前"，其余照实并列 —— 不替它裁决谁才算数。
     */
    CREATE TABLE IF NOT EXISTS agent_roles (
      ai_uid     TEXT NOT NULL,
      key        TEXT NOT NULL,
      name       TEXT NOT NULL,
      summary    TEXT,                   -- 一句话：这个角色是干什么的
      detail     TEXT,                   -- 角色设定正文（它自己给多少算多少）
      active     INTEGER,                -- 1/0/null：在用 / 没在用 / 它没说
      ts         INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (ai_uid, key)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_roles_ai ON agent_roles(ai_uid, active, name);

    /*
     * 「它想干一件要你点头的事」—— 审批与授权。第三批的主心骨。
     *
     * ── 形态取自那版 LifelineWorkbench 的三条审批规则，逐条照搬（它们是对的）──
     *   · 涉及隐私或私域数据的动作必须提交审核
     *   · **审批通过只代表允许执行，不等于动作成功或问题关闭**
     *   · 审核人只看到必要上下文，不获得全量资产可见权
     *
     * ── 🔴 这是这一整套里**第一个平台真能点的按钮**，所以设计要立住 ──────
     *    健康中心那些自救操作点不动，是因为平台没有那台机器的控制通道。
     *    审批不一样：平台不需要去推动 AI，**AI 自己回来拉结果**（handleInbox）。
     *    所以这个按钮点下去是真的有用的 —— 这条差别决定了它该不该画成按钮。
     *
     * ── 🔴 已决的不许被上报改回 pending ────────────────────────────
     *    上报是幂等覆盖的（同产出/备份），但审批**不能**照这条：
     *    AI 重报一次就把"你已经驳回了"抹成"等你批"，等于绕过主人。
     *    覆盖只允许发生在这条仍是 pending 的时候（SQL 的 WHERE 里钉死）。
     *
     * ── 🔴 过期的批准不算数 ────────────────────────────────────
     *    expires_ts 过了就按 expired 读出来，不再是 pending、也不再是 approved。
     *    一张永不失效的授权，就是名片放出去之后最难收回的那种东西。
     */
    CREATE TABLE IF NOT EXISTS agent_approvals (
      ai_uid       TEXT NOT NULL,
      key          TEXT NOT NULL,
      title        TEXT NOT NULL,
      detail       TEXT,                 -- 它为什么要做这件事（给人看的上下文）
      kind         TEXT,                 -- 做什么类型（发消息 / 花钱 / 改配置 / 取数据）
      risk         TEXT NOT NULL,        -- low | mid | high
      state        TEXT NOT NULL,        -- pending | approved | rejected | withdrawn
      requested_ts INTEGER NOT NULL,
      expires_ts   INTEGER,              -- 过了这个点就不算数（null = 它没给期限）
      decided_ts   INTEGER,
      decided_by   TEXT,                 -- 谁批的（平台用户 uid）
      decide_note  TEXT,
      /* AI 有没有回来拉过结果 —— 界面靠它说"它已经知道了"还是"它还不知道" */
      fetched_ts   INTEGER,
      updated_at   INTEGER NOT NULL,
      PRIMARY KEY (ai_uid, key)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_approvals_ai ON agent_approvals(ai_uid, state, requested_ts);

    /*
     * 「有哪些毛病，谁管了」—— 问题台账。
     *
     * 🔴 和 agent_health.issues 的分工：那边是**此刻的快照**（它现在有什么毛病），
     *    这边是**台账**（这个毛病什么时候第一次出现、有没有人接手、修没修好）。
     *    只有快照的话，一个毛病反复出现和一直没修就分不开。
     * 🔴 人标了"修好了"之后 AI 又报同一条 ⇒ **自动重新打开**，并且记下它犯回来了。
     *    这是和审批**相反**的一条：审批不许被上报改回去，问题必须能被事实改回去。
     *    差别在于谁说了算 —— 批不批是人说了算，坏没坏是机器说了算。
     */
    CREATE TABLE IF NOT EXISTS agent_issues (
      ai_uid      TEXT NOT NULL,
      key         TEXT NOT NULL,
      title       TEXT NOT NULL,
      detail      TEXT,
      level       TEXT NOT NULL,         -- info | warn | error
      state       TEXT NOT NULL,         -- open | acked | fixed | ignored
      first_ts    INTEGER NOT NULL,      -- 第一次报上来是什么时候
      last_ts     INTEGER NOT NULL,      -- 最近一次还在报是什么时候
      seen_count  INTEGER NOT NULL,      -- 报过几次（反复出现的看得出来）
      handled_ts  INTEGER,
      handled_by  TEXT,
      handle_note TEXT,
      /* 修好之后又犯过几次 —— 这个数字是"修的不是病根"的铁证 */
      regressed   INTEGER NOT NULL DEFAULT 0,
      updated_at  INTEGER NOT NULL,
      PRIMARY KEY (ai_uid, key)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_issues_ai ON agent_issues(ai_uid, state, level);

    /*
     * 「它自己定时查了什么」—— 巡检记录。形态取自那版的「巡检 Bot 状态」那一块
     * （最近巡检 / 覆盖对象 / 异常对象 / 最近失败原因）。
     *
     * 🔴 result 不认识落 unknown，**绝不默认 ok** —— 同备份那条，
     *    一个静静显示"巡检正常"的看板比没有看板更危险。
     * 🔴 一条巡检任务一行（重报是覆盖），要看历史去日志 —— 同健康那条。
     */
    CREATE TABLE IF NOT EXISTS agent_checks (
      ai_uid      TEXT NOT NULL,
      key         TEXT NOT NULL,
      name        TEXT NOT NULL,
      target      TEXT,                  -- 查的是什么（哪台机器 / 哪个服务）
      result      TEXT NOT NULL,         -- ok | warn | fail | unknown
      summary     TEXT,                  -- 一句话结论
      covered     INTEGER,               -- 覆盖了几个对象
      abnormal    INTEGER,               -- 其中几个不正常
      ts          INTEGER NOT NULL,      -- 最近一次巡检的时刻
      next_ts     INTEGER,               -- 下次什么时候查（它自己说的）
      updated_at  INTEGER NOT NULL,
      PRIMARY KEY (ai_uid, key)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_checks_ai ON agent_checks(ai_uid, result, ts);
  `);
}

const clean = (v, max = 200) => clip(String(v ?? "").trim(), max);
const numOrNull = (v, lo, hi) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(Math.max(n, lo), hi);
};

export function createAgentStatus({
  db, ingestToken = "", botAuth = null, recordOwnership = null, now = Date.now,
}) {
  initAgentStatusSchema(db);

  const q = {
    upsert: db.prepare(`
      INSERT INTO agent_status
        (ai_uid,ai_name,owner_uid,status,activity,task,step_i,step_n,progress,
         model,tokens,place,started_at,ts,ttl,updated_at)
      VALUES (@ai_uid,@ai_name,@owner_uid,@status,@activity,@task,@step_i,@step_n,@progress,
              @model,@tokens,@place,@started_at,@ts,@ttl,@updated_at)
      ON CONFLICT(ai_uid) DO UPDATE SET
        -- 🔴 全部字段都跟着 excluded 走（同渠道回传那条注释）：
        --    幂等的意义是"重报一遍就是对的"。只更新一部分 ⇒ 报错了的字段永久钉在库里。
        --    ai_name/owner_uid 允许上报方留空，留空时保住旧值（COALESCE），
        --    别让一次省略把名字抹掉。
        ai_name=COALESCE(@ai_name, ai_name), owner_uid=COALESCE(@owner_uid, owner_uid),
        status=@status, activity=@activity, task=@task,
        step_i=@step_i, step_n=@step_n, progress=@progress,
        model=@model, tokens=@tokens, place=@place,
        started_at=@started_at, ts=@ts, ttl=@ttl, updated_at=@updated_at
    `),
    addEvent: db.prepare(
      `INSERT INTO agent_events (ai_uid, ts, kind, text, status) VALUES (?,?,?,?,?)`),
    trimEvents: db.prepare(`
      DELETE FROM agent_events WHERE ai_uid = ? AND id NOT IN (
        SELECT id FROM agent_events WHERE ai_uid = ? ORDER BY ts DESC, id DESC LIMIT ?
      )`),
    upsertArtifact: db.prepare(`
      INSERT INTO agent_artifacts (ai_uid,key,title,kind,href,summary,task,ts,updated_at)
      VALUES (@ai_uid,@key,@title,@kind,@href,@summary,@task,@ts,@updated_at)
      ON CONFLICT(ai_uid,key) DO UPDATE SET
        -- 同 agent_status 那条：全字段跟 excluded 走，重报一遍就是对的。
        title=@title, kind=@kind, href=@href, summary=@summary,
        task=@task, ts=@ts, updated_at=@updated_at
    `),
    trimArtifacts: db.prepare(`
      DELETE FROM agent_artifacts WHERE ai_uid = ? AND key NOT IN (
        SELECT key FROM agent_artifacts WHERE ai_uid = ? ORDER BY ts DESC LIMIT ?
      )`),
    upsertHealth: db.prepare(`
      INSERT INTO agent_health
        (ai_uid,runtime,cpu_pct,cpu_text,mem_pct,mem_text,disk_pct,disk_text,
         issues,actions,ts,ttl,updated_at)
      VALUES (@ai_uid,@runtime,@cpu_pct,@cpu_text,@mem_pct,@mem_text,@disk_pct,@disk_text,
              @issues,@actions,@ts,@ttl,@updated_at)
      ON CONFLICT(ai_uid) DO UPDATE SET
        -- 全字段跟 excluded 走（同 agent_status 那条）：重报一遍就是对的。
        runtime=@runtime, cpu_pct=@cpu_pct, cpu_text=@cpu_text,
        mem_pct=@mem_pct, mem_text=@mem_text, disk_pct=@disk_pct, disk_text=@disk_text,
        issues=@issues, actions=@actions, ts=@ts, ttl=@ttl, updated_at=@updated_at
    `),
    upsertMemory: db.prepare(`
      INSERT INTO agent_memories (ai_uid,path,title,tier,bytes,summary,updated_ts,ts,updated_at)
      VALUES (@ai_uid,@path,@title,@tier,@bytes,@summary,@updated_ts,@ts,@updated_at)
      ON CONFLICT(ai_uid,path) DO UPDATE SET
        title=@title, tier=@tier, bytes=@bytes, summary=@summary,
        updated_ts=@updated_ts, ts=@ts, updated_at=@updated_at
    `),
    trimMemories: db.prepare(`
      DELETE FROM agent_memories WHERE ai_uid = ? AND path NOT IN (
        SELECT path FROM agent_memories WHERE ai_uid = ? ORDER BY ts DESC LIMIT ?
      )`),
    upsertBackup: db.prepare(`
      INSERT INTO agent_backups
        (ai_uid,key,target,place,bytes,result,restorable,note,ts,updated_at)
      VALUES (@ai_uid,@key,@target,@place,@bytes,@result,@restorable,@note,@ts,@updated_at)
      ON CONFLICT(ai_uid,key) DO UPDATE SET
        target=@target, place=@place, bytes=@bytes, result=@result,
        restorable=@restorable, note=@note, ts=@ts, updated_at=@updated_at
    `),
    trimBackups: db.prepare(`
      DELETE FROM agent_backups WHERE ai_uid = ? AND key NOT IN (
        SELECT key FROM agent_backups WHERE ai_uid = ? ORDER BY ts DESC LIMIT ?
      )`),

    upsertTask: db.prepare(`
      INSERT INTO agent_tasks
        (ai_uid,key,title,state,detail,priority,progress,due_ts,done_ts,blocker,ts,updated_at)
      VALUES (@ai_uid,@key,@title,@state,@detail,@priority,@progress,@due_ts,@done_ts,@blocker,@ts,@updated_at)
      ON CONFLICT(ai_uid,key) DO UPDATE SET
        title=@title, state=@state, detail=@detail, priority=@priority, progress=@progress,
        due_ts=@due_ts, done_ts=@done_ts, blocker=@blocker, ts=@ts, updated_at=@updated_at
    `),
    /*
     * 🔴 滚存只滚**收尾了的**活（done/cancelled）：没干完的活不管多旧都得留着 ——
     *    一件卡了三个月的活正是最该被看见的那件，按 ts 排序滚掉它等于把问题藏了。
     *    （这和事件/产出那两条"按时间滚"不一样，所以单写一条。）
     */
    trimTasks: db.prepare(`
      DELETE FROM agent_tasks
       WHERE ai_uid = ? AND state IN ('done','cancelled') AND key NOT IN (
        SELECT key FROM agent_tasks
         WHERE ai_uid = ? AND state IN ('done','cancelled') ORDER BY ts DESC LIMIT ?
      )`),

    upsertSkill: db.prepare(`
      INSERT INTO agent_skills
        (ai_uid,key,name,summary,enabled,version,source,category,ts,updated_at)
      VALUES (@ai_uid,@key,@name,@summary,@enabled,@version,@source,@category,@ts,@updated_at)
      ON CONFLICT(ai_uid,key) DO UPDATE SET
        name=@name, summary=@summary, enabled=@enabled, version=@version,
        source=@source, category=@category, ts=@ts, updated_at=@updated_at
    `),
    trimSkills: db.prepare(`
      DELETE FROM agent_skills WHERE ai_uid = ? AND key NOT IN (
        SELECT key FROM agent_skills WHERE ai_uid = ? ORDER BY ts DESC LIMIT ?
      )`),

    upsertRole: db.prepare(`
      INSERT INTO agent_roles
        (ai_uid,key,name,summary,detail,active,ts,updated_at)
      VALUES (@ai_uid,@key,@name,@summary,@detail,@active,@ts,@updated_at)
      ON CONFLICT(ai_uid,key) DO UPDATE SET
        name=@name, summary=@summary, detail=@detail, active=@active,
        ts=@ts, updated_at=@updated_at
    `),
    trimRoles: db.prepare(`
      DELETE FROM agent_roles WHERE ai_uid = ? AND key NOT IN (
        SELECT key FROM agent_roles WHERE ai_uid = ? ORDER BY ts DESC LIMIT ?
      )`),

    /*
     * 🔴 审批的 upsert 和别的都不一样：ON CONFLICT 那支带 WHERE ——
     *    **只有这条还是 pending 时才允许覆盖**。人已经批了/驳了的，
     *    AI 再报一百次也改不动。少了这个 WHERE，上报就成了绕过主人的后门。
     */
    upsertApproval: db.prepare(`
      INSERT INTO agent_approvals
        (ai_uid,key,title,detail,kind,risk,state,requested_ts,expires_ts,
         decided_ts,decided_by,decide_note,fetched_ts,updated_at)
      VALUES (@ai_uid,@key,@title,@detail,@kind,@risk,'pending',@requested_ts,@expires_ts,
              NULL,NULL,NULL,NULL,@updated_at)
      ON CONFLICT(ai_uid,key) DO UPDATE SET
        title=@title, detail=@detail, kind=@kind, risk=@risk,
        requested_ts=@requested_ts, expires_ts=@expires_ts, updated_at=@updated_at
      WHERE agent_approvals.state = 'pending'
    `),
    /** 人做决定。同样带条件：只动还 pending 的那条（并发时后到的不覆盖先到的）。 */
    decideApproval: db.prepare(`
      UPDATE agent_approvals
         SET state=@state, decided_ts=@decided_ts, decided_by=@decided_by,
             decide_note=@decide_note, updated_at=@updated_at
       WHERE ai_uid=@ai_uid AND key=@key AND state='pending'
    `),
    /** 撤回：只有已批准的才谈得上撤回（名片四条里的"可撤回"就落在这）。 */
    withdrawApproval: db.prepare(`
      UPDATE agent_approvals
         SET state='withdrawn', decided_ts=@decided_ts, decided_by=@decided_by,
             decide_note=@decide_note, updated_at=@updated_at
       WHERE ai_uid=@ai_uid AND key=@key AND state='approved'
    `),
    markApprovalFetched: db.prepare(`
      UPDATE agent_approvals SET fetched_ts=@ts, updated_at=@ts
       WHERE ai_uid=@ai_uid AND key=@key
    `),
    trimApprovals: db.prepare(`
      DELETE FROM agent_approvals
       WHERE ai_uid = ? AND state <> 'pending' AND key NOT IN (
        SELECT key FROM agent_approvals
         WHERE ai_uid = ? AND state <> 'pending' ORDER BY requested_ts DESC LIMIT ?
      )`),

    getIssue: db.prepare(
      "SELECT * FROM agent_issues WHERE ai_uid = ? AND key = ?"
    ),
    insertIssue: db.prepare(`
      INSERT INTO agent_issues
        (ai_uid,key,title,detail,level,state,first_ts,last_ts,seen_count,
         handled_ts,handled_by,handle_note,regressed,updated_at)
      VALUES (@ai_uid,@key,@title,@detail,@level,'open',@ts,@ts,1,
              NULL,NULL,NULL,0,@updated_at)
    `),
    /*
     * 🔴 和审批**相反**：问题必须能被事实改回去。
     *    人标了 fixed/ignored 之后 AI 又报同一条 ⇒ 重新 open，并把 regressed 加一。
     *    那个数字是"修的不是病根"的铁证，比任何人的记忆都可靠。
     */
    touchIssue: db.prepare(`
      UPDATE agent_issues
         SET title=@title, detail=@detail, level=@level,
             last_ts=@ts, seen_count=seen_count+1,
             state=CASE WHEN state IN ('fixed','ignored') THEN 'open' ELSE state END,
             regressed=CASE WHEN state IN ('fixed','ignored') THEN regressed+1 ELSE regressed END,
             updated_at=@updated_at
       WHERE ai_uid=@ai_uid AND key=@key
    `),
    handleIssue: db.prepare(`
      UPDATE agent_issues
         SET state=@state, handled_ts=@handled_ts, handled_by=@handled_by,
             handle_note=@handle_note, updated_at=@updated_at
       WHERE ai_uid=@ai_uid AND key=@key
    `),
    trimIssues: db.prepare(`
      DELETE FROM agent_issues
       WHERE ai_uid = ? AND state IN ('fixed','ignored') AND key NOT IN (
        SELECT key FROM agent_issues
         WHERE ai_uid = ? AND state IN ('fixed','ignored') ORDER BY last_ts DESC LIMIT ?
      )`),

    upsertCheck: db.prepare(`
      INSERT INTO agent_checks
        (ai_uid,key,name,target,result,summary,covered,abnormal,ts,next_ts,updated_at)
      VALUES (@ai_uid,@key,@name,@target,@result,@summary,@covered,@abnormal,@ts,@next_ts,@updated_at)
      ON CONFLICT(ai_uid,key) DO UPDATE SET
        name=@name, target=@target, result=@result, summary=@summary,
        covered=@covered, abnormal=@abnormal, ts=@ts, next_ts=@next_ts, updated_at=@updated_at
    `),
    trimChecks: db.prepare(`
      DELETE FROM agent_checks WHERE ai_uid = ? AND key NOT IN (
        SELECT key FROM agent_checks WHERE ai_uid = ? ORDER BY ts DESC LIMIT ?
      )`),
    _cache: new Map(),
  };

  /** 拼出来的语句按文本缓存 prepare（同 channel-records.mjs 的理由：可见范围是变长列表）。 */
  function prep(sql) {
    let st = q._cache.get(sql);
    if (!st) { st = db.prepare(sql); q._cache.set(sql, st); }
    return st;
  }

  /** `null` = 不限制；`[]` = 一个都看不到（必须是 1=0，见文件头）。 */
  function scopeClause(scopeAiUids, col = "ai_uid") {
    if (!scopeAiUids) return { sql: "", params: [] };
    if (!scopeAiUids.length) return { sql: " AND 1=0", params: [] };
    return {
      sql: ` AND ${col} IN (${scopeAiUids.map(() => "?").join(",")})`,
      params: scopeAiUids.slice(),
    };
  }

  /**
   * 一行库记录 → 一条给界面的状态。
   * 🔴 过期判定在**这里**，只有一处 —— 判定散在两处早晚会有一处忘了改。
   */
  function shape(row, nowSec) {
    /*
     * 名册里有、但**一次都没报过**的 AI（row.ts === 0）。
     * 🔴 它和"报过但过期了"要分开：界面上都写「未上报」，但
     *    `reported_status` 为 null 表示"我们从来不知道它在干什么"，
     *    过期的那种还能说一句"最后一次是在忙"。混成一种就丢了这点区别。
     */
    const never = !row.ts;
    const age = never ? null : nowSec - row.ts;
    const stale = never || age > row.ttl;
    return {
      ai_uid: row.ai_uid,
      ai_name: row.ai_name || null,
      // 过期了就**不再声称**它是什么状态。界面照这个显示「未上报」。
      status: stale ? "stale" : row.status,
      reported_status: never ? null : row.status,
      stale,
      never_reported: never,
      age_seconds: age,
      activity: stale ? null : row.activity || null,
      task: stale ? null : row.task || null,
      step: stale ? null : (row.step_n ? [row.step_i || 0, row.step_n] : null),
      progress: stale ? null : (row.progress == null ? null : row.progress),
      model: row.model || null,
      tokens: stale ? null : row.tokens || null,
      place: stale ? null : row.place || null,
      started_at: row.started_at || null,
      ts: row.ts,
      ttl: row.ttl,
    };
  }

  /**
   * 上报口。**挡在用户面鉴权之前**（上报方是 AI 的宿主机，没有 session）。
   * 返回 true = 已处理。
   */
  async function handleReport(req, res, { path, root }) {
    if (path !== `${root}/agent-status/report`) return false;
    if (req.method !== "POST") {
      send(res, 405, { error: "method not allowed" });
      return true;
    }

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
          error: "agent status report disabled",
          why: "既没有带 bot 凭据（Authorization: Bearer bf_…），"
            + "服务端也没有配共享令牌 YOYOO_AGENT_STATUS_TOKEN。",
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
      body = await readJson(req, 256 * 1024);
    } catch {
      send(res, 400, { error: "bad json" });
      return true;
    }

    // 身份以宿主认定的为准；只有共享令牌那条路才用自报的。
    const aiUid = verifiedAiUid || clean(body?.ai_uid, 80);
    if (!aiUid) {
      send(res, 400, { error: "ai_uid is required" });
      return true;
    }
    const rawStatus = clean(body?.status, 16);
    if (!STATUSES.has(rawStatus)) {
      // 不认识的状态**不许**默默变成 busy —— 那是在替上报方编内容。
      send(res, 400, { error: `status must be one of ${[...STATUSES].join("|")}` });
      return true;
    }

    const nowMs = now();
    const nowSec = Math.floor(nowMs / 1000);
    const tsGiven = numOrNull(body?.ts, 0, Number.MAX_SAFE_INTEGER);
    // 上报方的钟可能是歪的，但**未来的时间**会让"过期"判定永远为假 ⇒ 收到现在。
    const ts = tsGiven && tsGiven <= nowSec + 60 ? Math.floor(tsGiven) : nowSec;
    const aiName = body?.ai_name ? clean(body.ai_name, 80) : null;
    const ownerUid = body?.owner_uid ? clean(body.owner_uid, 80) : null;

    const row = {
      ai_uid: aiUid,
      ai_name: aiName,
      owner_uid: ownerUid,
      status: rawStatus,
      activity: body?.activity ? clean(body.activity, 300) : null,
      task: body?.task ? clean(body.task, 300) : null,
      step_i: numOrNull(body?.step_i, 0, 9999),
      step_n: numOrNull(body?.step_n, 0, 9999),
      progress: numOrNull(body?.progress, 0, 1),
      model: body?.model ? clean(body.model, 80) : null,
      tokens: body?.tokens ? clean(body.tokens, 32) : null,
      place: body?.place ? clean(body.place, 24) : null,
      started_at: numOrNull(body?.started_at, 0, Number.MAX_SAFE_INTEGER),
      ts,
      ttl: numOrNull(body?.ttl, 10, MAX_TTL) ?? DEFAULT_TTL,
      updated_at: nowMs,
    };
    q.upsert.run(row);

    /*
     * 兜底登记归属（source: 'ingest'，最软的一档）。同渠道回传：
     * 只在这个 AI 还没有任何登记时才生效，登记册那边挡住覆盖。
     */
    if (ownerUid) recordOwnership?.({ aiUid, ownerUid, aiName, source: "ingest" });

    // 事件（可选，一次几条）—— 页面右侧终端和时间轴都吃它。
    const evs = Array.isArray(body?.events) ? body.events.slice(0, MAX_EVENT_BATCH) : [];
    let stored = 0;
    for (const e of evs) {
      const ets = numOrNull(e?.ts, 0, nowSec + 60);
      const text = clean(e?.text, 300);
      if (!text) continue;
      const kind = ["ok", "wr", "er", "cm"].includes(e?.kind) ? e.kind : "cm";
      q.addEvent.run(aiUid, Math.floor(ets ?? ts), kind, text, clean(e?.status, 16) || rawStatus);
      stored += 1;
    }
    if (stored) q.trimEvents.run(aiUid, aiUid, KEEP_EVENTS_PER_AI);

    /*
     * 产出（可选，一次几件）—— 档案页「它干出过什么」那一块吃它。
     * 🔴 和事件分开存，不是同一张表：事件是**流水**（会滚掉、只看最近），
     *    产出是**陈列**（重报同一件是覆盖、按件去重）。混在一张表里，
     *    要么产出被流水冲掉，要么流水被去重吃掉，两种都错。
     */
    const arts = Array.isArray(body?.artifacts) ? body.artifacts.slice(0, MAX_ARTIFACT_BATCH) : [];
    let artsStored = 0;
    for (const a of arts) {
      const title = clean(a?.title, 200);
      if (!title) continue; // 没名字的东西陈列不出来，丢掉（同事件里没 text 的那条）
      // key 缺省回退到 title：上报方不给稳定标识时，至少保证"同名的是同一件"。
      const key = clean(a?.key, 200) || title;
      const kind = ARTIFACT_KINDS.has(a?.kind) ? a.kind : "file";
      const ats = numOrNull(a?.ts, 0, nowSec + 60);
      q.upsertArtifact.run({
        ai_uid: aiUid,
        key,
        title,
        kind,
        href: a?.href ? clean(a.href, 500) : null,
        summary: a?.summary ? clean(a.summary, 300) : null,
        task: a?.task ? clean(a.task, 300) : null,
        ts: Math.floor(ats ?? ts),
        updated_at: nowMs,
      });
      artsStored += 1;
    }
    if (artsStored) q.trimArtifacts.run(aiUid, aiUid, KEEP_ARTIFACTS_PER_AI);

    /*
     * 健康（可选，一次一份）—— 健康中心那一页吃它。
     * 🔴 `health` 缺席 ≠ 健康清零：不报就保住上一份（连同它自己的 ttl 去判过期）。
     *    心跳每分钟都在发，健康几分钟报一次，把"这次没带"当成"资源归零"就会
     *    每分钟在界面上闪一次假数据。
     */
    const h = body?.health;
    let healthStored = false;
    if (h && typeof h === "object") {
      const issues = (Array.isArray(h.issues) ? h.issues : []).slice(0, MAX_ISSUES)
        .map((i) => ({
          level: ISSUE_LEVELS.has(i?.level) ? i.level : "info",
          title: clean(i?.title, 200) || "健康事件",
          detail: clean(i?.detail, 400) || null,
          at: numOrNull(i?.at, 0, nowSec + 60),
        }))
        .filter((i) => i.title);
      const actions = (Array.isArray(h.actions) ? h.actions : []).slice(0, 12)
        .map((a) => ({
          key: clean(a?.key, 40),
          title: clean(a?.title, 80),
          desc: clean(a?.desc, 200) || null,
          level: clean(a?.level, 40) || null,
        }))
        .filter((a) => a.key && a.title);
      q.upsertHealth.run({
        ai_uid: aiUid,
        runtime: h.runtime ? clean(h.runtime, 120) : null,
        cpu_pct: numOrNull(h.cpu_pct, 0, 1),
        cpu_text: h.cpu_text ? clean(h.cpu_text, 60) : null,
        mem_pct: numOrNull(h.mem_pct, 0, 1),
        mem_text: h.mem_text ? clean(h.mem_text, 60) : null,
        disk_pct: numOrNull(h.disk_pct, 0, 1),
        disk_text: h.disk_text ? clean(h.disk_text, 60) : null,
        issues: JSON.stringify(issues),
        actions: JSON.stringify(actions),
        ts,
        ttl: numOrNull(h.ttl, 10, MAX_TTL) ?? row.ttl,
        updated_at: nowMs,
      });
      healthStored = true;
    }

    /*
     * 记忆目录（可选，一次一批）—— 记忆中心吃它。存目录不存正文，理由见建表注释。
     */
    const mems = Array.isArray(body?.memories) ? body.memories.slice(0, MAX_MEMORY_BATCH) : [];
    let memsStored = 0;
    for (const m of mems) {
      const mpath = clean(m?.path, 300);
      if (!mpath) continue; // 没有路径就不是一份记忆，丢掉（同产出里没 title 的那条）
      q.upsertMemory.run({
        ai_uid: aiUid,
        path: mpath,
        title: m?.title ? clean(m.title, 200) : null,
        tier: MEMORY_TIERS.has(m?.tier) ? m.tier : "other",
        bytes: numOrNull(m?.bytes, 0, Number.MAX_SAFE_INTEGER),
        summary: m?.summary ? clean(m.summary, 300) : null,
        updated_ts: numOrNull(m?.updated_ts, 0, nowSec + 60),
        ts,
        updated_at: nowMs,
      });
      memsStored += 1;
    }
    if (memsStored) q.trimMemories.run(aiUid, aiUid, KEEP_MEMORIES_PER_AI);

    /*
     * 备份（可选，一次一批）—— 备份中心吃它。
     * 🔴 `result` 不认识一律 unknown，**绝不默认 ok**：见建表注释。
     */
    const bks = Array.isArray(body?.backups) ? body.backups.slice(0, MAX_BACKUP_BATCH) : [];
    let bksStored = 0;
    for (const b of bks) {
      const target = clean(b?.target, 200);
      if (!target) continue;
      const key = clean(b?.key, 200) || target;
      const bts = numOrNull(b?.ts, 0, nowSec + 60);
      q.upsertBackup.run({
        ai_uid: aiUid,
        key,
        target,
        place: b?.place ? clean(b.place, 200) : null,
        bytes: numOrNull(b?.bytes, 0, Number.MAX_SAFE_INTEGER),
        result: BACKUP_RESULTS.has(b?.result) ? b.result : "unknown",
        // 没说就是 null（不知道），不是 false（不能取回）—— 这两句话差得远。
        restorable: b?.restorable == null ? null : (b.restorable ? 1 : 0),
        note: b?.note ? clean(b.note, 300) : null,
        ts: Math.floor(bts ?? ts),
        updated_at: nowMs,
      });
      bksStored += 1;
    }
    if (bksStored) q.trimBackups.run(aiUid, aiUid, KEEP_BACKUPS_PER_AI);

    /*
     * 任务（可选，一次一批）—— 任务那一块吃它。
     * 🔴 state 不认识**整条丢掉**，不兜底落值：理由见 TASK_STATES 与建表注释。
     *    丢掉的条数在响应里报回去（tasks_rejected），上报方看得见自己报错了 ——
     *    静静吞掉一条不认识的上报，是让对方永远查不出来的那种坏。
     */
    const tks = Array.isArray(body?.tasks) ? body.tasks.slice(0, MAX_TASK_BATCH) : [];
    let tksStored = 0;
    let tksRejected = 0;
    for (const t of tks) {
      const title = clean(t?.title, 200);
      if (!title) { tksRejected += 1; continue; }
      if (!TASK_STATES.has(t?.state)) { tksRejected += 1; continue; }
      const tts = numOrNull(t?.ts, 0, nowSec + 60);
      q.upsertTask.run({
        ai_uid: aiUid,
        key: clean(t?.key, 200) || title,
        title,
        state: t.state,
        detail: t?.detail ? clean(t.detail, 500) : null,
        priority: numOrNull(t?.priority, 1, 9),
        progress: numOrNull(t?.progress, 0, 1),
        due_ts: numOrNull(t?.due_ts, 0, Number.MAX_SAFE_INTEGER),
        done_ts: numOrNull(t?.done_ts, 0, nowSec + 60),
        blocker: t?.blocker ? clean(t.blocker, 300) : null,
        ts: Math.floor(tts ?? ts),
        updated_at: nowMs,
      });
      tksStored += 1;
    }
    if (tksStored) q.trimTasks.run(aiUid, aiUid, KEEP_TASKS_PER_AI);

    /*
     * 技能（可选，一次一批）—— 技能那一块吃它。
     * 🔴 enabled 三态：没给就是 null（它没说），不是 0。界面照实说。
     */
    const sks = Array.isArray(body?.skills) ? body.skills.slice(0, MAX_SKILL_BATCH) : [];
    let sksStored = 0;
    for (const k of sks) {
      const name = clean(k?.name, 120);
      if (!name) continue;
      const kts = numOrNull(k?.ts, 0, nowSec + 60);
      q.upsertSkill.run({
        ai_uid: aiUid,
        key: clean(k?.key, 200) || name,
        name,
        summary: k?.summary ? clean(k.summary, 300) : null,
        enabled: k?.enabled == null ? null : (k.enabled ? 1 : 0),
        version: k?.version ? clean(k.version, 40) : null,
        source: k?.source ? clean(k.source, 120) : null,
        category: k?.category ? clean(k.category, 60) : null,
        ts: Math.floor(kts ?? ts),
        updated_at: nowMs,
      });
      sksStored += 1;
    }
    if (sksStored) q.trimSkills.run(aiUid, aiUid, KEEP_SKILLS_PER_AI);

    /*
     * 角色（可选，一次一批）—— 角色那一块吃它。同技能：active 三态，只读展示。
     */
    const rls = Array.isArray(body?.roles) ? body.roles.slice(0, MAX_ROLE_BATCH) : [];
    let rlsStored = 0;
    for (const r of rls) {
      const name = clean(r?.name, 120);
      if (!name) continue;
      const rts = numOrNull(r?.ts, 0, nowSec + 60);
      q.upsertRole.run({
        ai_uid: aiUid,
        key: clean(r?.key, 200) || name,
        name,
        summary: r?.summary ? clean(r.summary, 300) : null,
        // 角色设定正文比一句摘要长，但也不是网盘：给个上限，超了就截断。
        detail: r?.detail ? clean(r.detail, 4000) : null,
        active: r?.active == null ? null : (r.active ? 1 : 0),
        ts: Math.floor(rts ?? ts),
        updated_at: nowMs,
      });
      rlsStored += 1;
    }
    if (rlsStored) q.trimRoles.run(aiUid, aiUid, KEEP_ROLES_PER_AI);

    /*
     * 待批的事（可选，一次一批）—— 审批那一块吃它。
     * 🔴 已决的不许被改回 pending：SQL 的 WHERE 钉死了（见 upsertApproval 注释）。
     *    这里额外把"被挡下来的条数"报回去（approvals_locked），
     *    让 AI 知道"这条你已经批过了，别再问"。静静吞掉会让它一直重问。
     */
    const aps = Array.isArray(body?.approvals) ? body.approvals.slice(0, MAX_APPROVAL_BATCH) : [];
    let apsStored = 0;
    let apsLocked = 0;
    for (const a of aps) {
      const title = clean(a?.title, 200);
      if (!title) continue;
      const key = clean(a?.key, 200) || title;
      const ats = numOrNull(a?.requested_ts, 0, nowSec + 60);
      const r = q.upsertApproval.run({
        ai_uid: aiUid,
        key,
        title,
        detail: a?.detail ? clean(a.detail, 800) : null,
        kind: a?.kind ? clean(a.kind, 60) : null,
        // 不认识的轻重落 mid：既不许默默降成 low（会被忽略），也不许吓唬成 high
        risk: RISK_LEVELS.has(a?.risk) ? a.risk : "mid",
        requested_ts: Math.floor(ats ?? ts),
        expires_ts: numOrNull(a?.expires_ts, 0, Number.MAX_SAFE_INTEGER),
        updated_at: nowMs,
      });
      if (r.changes) apsStored += 1;
      else apsLocked += 1; // 已经有人做过决定了，这次上报被挡下
    }
    if (apsStored) q.trimApprovals.run(aiUid, aiUid, KEEP_APPROVALS_PER_AI);

    /*
     * 问题台账（可选，一次一批）。
     * 🔴 第一次见就建账；再见到就把 last_ts / 次数往上加；
     *    人标过 fixed/ignored 之后又见到 ⇒ **自动重新打开并记一次 regressed**
     *    （见 touchIssue 注释：坏没坏是机器说了算）。
     */
    const iss = Array.isArray(body?.issues) ? body.issues.slice(0, MAX_ISSUE_BATCH) : [];
    let issStored = 0;
    for (const i of iss) {
      const title = clean(i?.title, 200);
      if (!title) continue;
      const key = clean(i?.key, 200) || title;
      const its = numOrNull(i?.ts, 0, nowSec + 60);
      const row = {
        ai_uid: aiUid,
        key,
        title,
        detail: i?.detail ? clean(i.detail, 800) : null,
        level: ISSUE_LEVELS.has(i?.level) ? i.level : "info",
        ts: Math.floor(its ?? ts),
        updated_at: nowMs,
      };
      const hit = q.touchIssue.run(row);
      if (!hit.changes) q.insertIssue.run(row);
      issStored += 1;
    }
    if (issStored) q.trimIssues.run(aiUid, aiUid, KEEP_ISSUES_PER_AI);

    /*
     * 巡检记录（可选，一次一批）。result 不认识落 unknown，绝不默认 ok。
     */
    const cks = Array.isArray(body?.checks) ? body.checks.slice(0, MAX_CHECK_BATCH) : [];
    let cksStored = 0;
    for (const c of cks) {
      const name = clean(c?.name, 160);
      if (!name) continue;
      const cts = numOrNull(c?.ts, 0, nowSec + 60);
      q.upsertCheck.run({
        ai_uid: aiUid,
        key: clean(c?.key, 200) || name,
        name,
        target: c?.target ? clean(c.target, 200) : null,
        result: CHECK_RESULTS.has(c?.result) ? c.result : "unknown",
        summary: c?.summary ? clean(c.summary, 300) : null,
        covered: numOrNull(c?.covered, 0, 1000000),
        abnormal: numOrNull(c?.abnormal, 0, 1000000),
        ts: Math.floor(cts ?? ts),
        next_ts: numOrNull(c?.next_ts, 0, Number.MAX_SAFE_INTEGER),
        updated_at: nowMs,
      });
      cksStored += 1;
    }
    if (cksStored) q.trimChecks.run(aiUid, aiUid, KEEP_CHECKS_PER_AI);

    send(res, 200, {
      ok: true, ai_uid: aiUid,
      events_stored: stored, artifacts_stored: artsStored,
      health_stored: healthStored, memories_stored: memsStored, backups_stored: bksStored,
      tasks_stored: tksStored, tasks_rejected: tksRejected,
      skills_stored: sksStored, roles_stored: rlsStored,
      approvals_stored: apsStored, approvals_locked: apsLocked,
      issues_stored: issStored, checks_stored: cksStored,
      ttl: row.ttl,
    });
    return true;
  }

  /**
   * 读取面（挂在用户面鉴权之后）。
   * `scopeAiUids`：这个人看得见哪些 AI（`null` = 不限制，`[]` = 一个都看不到）。
   */
  /**
   * 名册 → 一行"从来没报过"的占位。
   * 苏白 2026-09-10 夜：「咱们二元空间里边这么多 AI 你不显示，你还把外边的给拉进来干什么？
   * 你只显示在我们平台里边的不就行了吗？」
   * ⇒ 这一屏的**人口由平台的归属登记册决定**，不由"谁上报了"决定。
   *   报了的显真状态，没报的摆在工位上灰着 —— 那才是"我们平台的办公室"。
   */
  const placeholder = (r) => ({
    ai_uid: r.ai_uid, ai_name: r.ai_name || null, owner_uid: null,
    status: "off", activity: null, task: null, step_i: null, step_n: null,
    progress: null, model: null, tokens: null, place: null, started_at: null,
    ts: 0, ttl: DEFAULT_TTL,
  });

  /**
   * @param {object} ctx
   * @param {string[]|null} ctx.scopeAiUids 这个人看得见哪些 AI
   * @param {{ai_uid:string,ai_name?:string}[]|null} ctx.roster
   *        这个人在**本平台**名下的 AI 全名册。给了就以它为准（没上报的也要占一个工位）；
   *        `null` ＝ 老行为（只列有状态记录的）。
   */
  async function handle(req, res, { path, url, root, scopeAiUids = null, roster = null }) {
    const base = `${root}/agent-status`;
    if (!path.startsWith(base)) return false;
    if (req.method !== "GET") {
      send(res, 405, { error: "method not allowed" });
      return true;
    }
    const nowSec = Math.floor(now() / 1000);
    const scope = scopeClause(scopeAiUids);
    const scopeInfo = {
      owner_scoped: scopeAiUids !== null,
      visible_agents: scopeAiUids === null ? null : scopeAiUids.length,
    };

    // 切换器选的那个 AI 必须落在可见范围之内（同渠道页那一条）。
    const askedAi = clean(url?.searchParams?.get("ai_uid"), 80);
    if (askedAi && scopeAiUids && !scopeAiUids.includes(askedAi)) {
      send(res, 403, { error: "not your agent", ...scopeInfo });
      return true;
    }

    if (path === base || path === `${base}/`) {
      const reported = prep(
        `SELECT * FROM agent_status WHERE 1=1${scope.sql} ORDER BY ts DESC`
      ).all(...scope.params);
      let raw = reported;
      if (roster) {
        // 名册为准：报过的用真行，没报过的补一行占位；顺序＝先在报的、再没报的。
        const byUid = new Map(reported.map((r) => [r.ai_uid, r]));
        raw = roster.map((r) => byUid.get(r.ai_uid) || placeholder(r));
        // 名册里没有、却报了状态的（理论上不该有，因为可见范围就是从名册算的）也别丢
        for (const r of reported) if (!roster.some((x) => x.ai_uid === r.ai_uid)) raw.push(r);
      }
      const rows = raw.map((r) => shape(r, nowSec))
        .sort((a, b) => Number(a.stale) - Number(b.stale));
      // 界面要能一眼说清"几个在报、几个没报"，别让它自己数。
      const live = rows.filter((r) => !r.stale).length;
      send(res, 200, {
        ...scopeInfo, now: nowSec,
        reporting: live, total: rows.length, agents: rows,
      });
      return true;
    }

    if (path === `${base}/events`) {
      const want = Number(url?.searchParams?.get("limit"));
      const limit = Math.min(
        Math.max(Number.isFinite(want) && want > 0 ? Math.floor(want) : DEFAULT_EVENT_LIMIT, 1),
        MAX_EVENT_LIMIT
      );
      const since = numOrNull(url?.searchParams?.get("since"), 0, Number.MAX_SAFE_INTEGER);
      const parts = [scopeClause(scopeAiUids)];
      if (askedAi) parts.push({ sql: " AND ai_uid = ?", params: [askedAi] });
      if (since) parts.push({ sql: " AND ts >= ?", params: [Math.floor(since)] });
      const where = {
        sql: parts.map((p) => p.sql).join(""),
        params: parts.flatMap((p) => p.params),
      };
      // 倒序取、正序给（界面按时间从早到晚读）—— 同渠道 messages 那条。
      const rows = prep(
        `SELECT ai_uid, ts, kind, text, status FROM agent_events
          WHERE 1=1${where.sql} ORDER BY ts DESC, id DESC LIMIT ?`
      ).all(...where.params, limit).reverse();
      send(res, 200, { ...scopeInfo, ai_uid: askedAi || null, events: rows });
      return true;
    }

    if (path === `${base}/artifacts`) {
      const want = Number(url?.searchParams?.get("limit"));
      const limit = Math.min(
        Math.max(Number.isFinite(want) && want > 0 ? Math.floor(want) : DEFAULT_ARTIFACT_LIMIT, 1),
        MAX_ARTIFACT_LIMIT
      );
      const parts = [scopeClause(scopeAiUids)];
      if (askedAi) parts.push({ sql: " AND ai_uid = ?", params: [askedAi] });
      const where = {
        sql: parts.map((p) => p.sql).join(""),
        params: parts.flatMap((p) => p.params),
      };
      const rows = prep(
        `SELECT ai_uid, key, title, kind, href, summary, task, ts FROM agent_artifacts
          WHERE 1=1${where.sql} ORDER BY ts DESC LIMIT ?`
      ).all(...where.params, limit);
      send(res, 200, { ...scopeInfo, ai_uid: askedAi || null, artifacts: rows });
      return true;
    }

    /* 一次列多少：三个新读取口共用（同 events/artifacts 的夹取方式）。 */
    const listLimit = () => {
      const want = Number(url?.searchParams?.get("limit"));
      return Math.min(
        Math.max(Number.isFinite(want) && want > 0 ? Math.floor(want) : DEFAULT_LIST_LIMIT, 1),
        MAX_LIST_LIMIT
      );
    };
    /* scope + 可选的单个 ai_uid，三个新读取口共用。 */
    const whereFor = () => {
      const parts = [scopeClause(scopeAiUids)];
      if (askedAi) parts.push({ sql: " AND ai_uid = ?", params: [askedAi] });
      return {
        sql: parts.map((x) => x.sql).join(""),
        params: parts.flatMap((x) => x.params),
      };
    };
    /** 库里存的 JSON 文本 → 数组。存坏了就当空数组，不许让一页因此白屏。 */
    const parseArr = (t) => {
      try {
        const v = JSON.parse(t || "[]");
        return Array.isArray(v) ? v : [];
      } catch {
        return [];
      }
    };

    /*
     * 健康中心。形态照阿里云效那版的「健康中心」：
     * 实例状态 / 运行时 / 上次心跳 / 资源三条 / 当前问题 / 它支持哪些自救操作。
     *
     * 🔴 过期判定和状态口用**同一条规矩**：`ts + ttl < now` ⇒ stale，
     *    界面写「未上报」，不显示旧的资源数字。一份三小时前的内存占用
     *    摆在"健康中心"里，比空着更容易骗人。
     * 🔴 名册为准（同状态口）：从没报过的 AI 也要列出来，灰着 ——
     *    "它没接上报"正是这一页最该让人看见的事。
     */
    if (path === `${base}/health`) {
      const where = whereFor();
      const rows = prep(
        `SELECT * FROM agent_health WHERE 1=1${where.sql} ORDER BY ts DESC`
      ).all(...where.params);
      const byUid = new Map(rows.map((r) => [r.ai_uid, r]));
      const names = new Map(
        prep(`SELECT ai_uid, ai_name FROM agent_status WHERE 1=1${where.sql}`)
          .all(...where.params).map((r) => [r.ai_uid, r.ai_name])
      );
      const list = roster && !askedAi ? roster.map((r) => r.ai_uid) : [...byUid.keys()];
      for (const uid of byUid.keys()) if (!list.includes(uid)) list.push(uid);
      const items = list.map((uid) => {
        const r = byUid.get(uid);
        const never = !r;
        const age = never ? null : nowSec - r.ts;
        const stale = never || age > r.ttl;
        const named = roster?.find((x) => x.ai_uid === uid);
        return {
          ai_uid: uid,
          ai_name: named?.ai_name || names.get(uid) || null,
          never_reported: never,
          stale,
          age_seconds: age,
          // 过期就不再声称资源占用是多少 —— 同状态口那条。
          runtime: never ? null : r.runtime || null,
          cpu_pct: stale ? null : r.cpu_pct,
          cpu_text: stale ? null : r.cpu_text || null,
          mem_pct: stale ? null : r.mem_pct,
          mem_text: stale ? null : r.mem_text || null,
          disk_pct: stale ? null : r.disk_pct,
          disk_text: stale ? null : r.disk_text || null,
          issues: never ? [] : parseArr(r.issues),
          actions: never ? [] : parseArr(r.actions),
          ts: never ? 0 : r.ts,
          ttl: never ? DEFAULT_TTL : r.ttl,
        };
      });
      send(res, 200, {
        ...scopeInfo, now: nowSec,
        reporting: items.filter((i) => !i.stale).length,
        total: items.length,
        agents: items,
      });
      return true;
    }

    /*
     * 记忆中心。返回的是**目录**（路径 / 分层 / 大小 / 摘要 / 上次变动），不是正文。
     * 界面按 tier 分组画成一棵树 —— 分组在界面做，这里只保证顺序稳定。
     */
    if (path === `${base}/memories`) {
      const where = whereFor();
      const rows = prep(
        `SELECT ai_uid, path, title, tier, bytes, summary, updated_ts, ts
           FROM agent_memories WHERE 1=1${where.sql}
          ORDER BY ai_uid, tier, path LIMIT ?`
      ).all(...where.params, listLimit());
      send(res, 200, {
        ...scopeInfo, ai_uid: askedAi || null,
        bytes_total: rows.reduce((n, r) => n + (r.bytes || 0), 0),
        memories: rows,
      });
      return true;
    }

    /*
     * 备份中心。`restorable` 原样透传（1/0/null）——
     * null 是"它没说"，界面必须照实说，不许当成"不能取回"。
     */
    if (path === `${base}/backups`) {
      const where = whereFor();
      const rows = prep(
        `SELECT ai_uid, key, target, place, bytes, result, restorable, note, ts
           FROM agent_backups WHERE 1=1${where.sql} ORDER BY ts DESC LIMIT ?`
      ).all(...where.params, listLimit());
      send(res, 200, {
        ...scopeInfo, ai_uid: askedAi || null,
        // 界面顶上那句"有几条没成功" —— 别让它自己数，也别把 unknown 算成成功。
        failing: rows.filter((r) => r.result === "fail" || r.result === "warn").length,
        unknown: rows.filter((r) => r.result === "unknown").length,
        backups: rows,
      });
      return true;
    }

    /*
     * 任务。
     * 🔴 排序不是按时间，是按**要不要管**：blocked → doing → todo → done/cancelled，
     *    同档内再按优先级、时间。一屏任务页最该顶到眼前的是卡住的那件，
     *    按 ts 排会把它埋在一堆刚报的 done 下面。
     */
    if (path === `${base}/tasks`) {
      const where = whereFor();
      const rows = prep(
        `SELECT ai_uid, key, title, state, detail, priority, progress,
                due_ts, done_ts, blocker, ts
           FROM agent_tasks WHERE 1=1${where.sql}
          ORDER BY CASE state WHEN 'blocked' THEN 0 WHEN 'doing' THEN 1
                              WHEN 'todo' THEN 2 ELSE 3 END,
                   COALESCE(priority, 9), ts DESC
          LIMIT ?`
      ).all(...where.params, listLimit());
      const count = (st) => rows.filter((r) => r.state === st).length;
      send(res, 200, {
        ...scopeInfo, ai_uid: askedAi || null,
        // 界面顶上那几个数，别让它自己数（同 backups 那条）。
        doing: count("doing"), todo: count("todo"),
        blocked: count("blocked"), done: count("done"),
        tasks: rows,
      });
      return true;
    }

    /*
     * 技能。
     * 🔴 `enabled` 原样透传（1/0/null）—— null 是"它没说开没开"，
     *    界面不许显示成"关着"（同 backups.restorable 那条）。
     * 🔴 `enabled_count` 只数 `=== 1` 的，null 不算进去 —— 顶上那句
     *    「共 N 个 · 已开启 M 个」必须是真数过的，不是推断的。
     */
    if (path === `${base}/skills`) {
      const where = whereFor();
      const rows = prep(
        `SELECT ai_uid, key, name, summary, enabled, version, source, category, ts
           FROM agent_skills WHERE 1=1${where.sql}
          ORDER BY ai_uid, COALESCE(category,''), name LIMIT ?`
      ).all(...where.params, listLimit());
      send(res, 200, {
        ...scopeInfo, ai_uid: askedAi || null,
        enabled_count: rows.filter((r) => r.enabled === 1).length,
        unknown_count: rows.filter((r) => r.enabled == null).length,
        skills: rows,
      });
      return true;
    }

    /*
     * 角色。active=1 的排前面；一个 AI 报了多个 active 的照实并列，不替它裁决。
     */
    if (path === `${base}/roles`) {
      const where = whereFor();
      const rows = prep(
        `SELECT ai_uid, key, name, summary, detail, active, ts
           FROM agent_roles WHERE 1=1${where.sql}
          ORDER BY ai_uid, active DESC, name LIMIT ?`
      ).all(...where.params, listLimit());
      send(res, 200, {
        ...scopeInfo, ai_uid: askedAi || null,
        active_count: rows.filter((r) => r.active === 1).length,
        roles: rows,
      });
      return true;
    }

    /*
     * 审批与授权。
     *
     * 🔴 过期判定在**读的时候**做，不靠定时任务去改库：
     *    一条 pending 但已经过了期限的，读出来就是 expired，**不再是"等你批"**。
     *    靠定时任务的话，任务一停，界面就会一直摆着一个早就不该点的批准按钮。
     * 🔴 `can_act` 由服务端说了算，界面照着画按钮 —— 让界面自己推断"这条还能不能点"
     *    就等于把规则抄了第二份，两份早晚不一样。
     */
    if (path === `${base}/approvals`) {
      const where = whereFor();
      const rows = prep(
        `SELECT * FROM agent_approvals WHERE 1=1${where.sql}
          ORDER BY CASE state WHEN 'pending' THEN 0 ELSE 1 END,
                   CASE risk WHEN 'high' THEN 0 WHEN 'mid' THEN 1 ELSE 2 END,
                   requested_ts DESC LIMIT ?`
      ).all(...where.params, listLimit());
      const items = rows.map((r) => {
        const expired = !!r.expires_ts && r.expires_ts < nowSec;
        // 过期压过一切：一张过了期的批准，既不是"还能用"也不是"等你批"
        const state = expired && (r.state === "pending" || r.state === "approved")
          ? "expired"
          : r.state;
        return {
          ai_uid: r.ai_uid, key: r.key, title: r.title, detail: r.detail || null,
          kind: r.kind || null, risk: r.risk, state,
          requested_ts: r.requested_ts, expires_ts: r.expires_ts || null,
          decided_ts: r.decided_ts || null, decided_by: r.decided_by || null,
          decide_note: r.decide_note || null,
          // 它回来拉过结果没有 —— 界面据此说"它已经知道了"还是"它还不知道"
          fetched_ts: r.fetched_ts || null,
          // 这条现在能做什么：批/驳 只对 pending，撤回 只对 approved
          can_act: state === "pending" ? ["approved", "rejected"]
            : state === "approved" ? ["withdrawn"] : [],
        };
      });
      send(res, 200, {
        ...scopeInfo, ai_uid: askedAi || null,
        pending: items.filter((i) => i.state === "pending").length,
        high_pending: items.filter((i) => i.state === "pending" && i.risk === "high").length,
        approvals: items,
      });
      return true;
    }

    /*
     * 问题台账。
     * 🔴 `regressed > 0` 的排最前：修完又犯的那条，比一条新问题更值得看 ——
     *    它说明上次修的不是病根。
     */
    if (path === `${base}/issues`) {
      const where = whereFor();
      const rows = prep(
        `SELECT * FROM agent_issues WHERE 1=1${where.sql}
          ORDER BY CASE WHEN regressed > 0 AND state='open' THEN 0
                        WHEN state='open' THEN 1
                        WHEN state='acked' THEN 2 ELSE 3 END,
                   CASE level WHEN 'error' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END,
                   last_ts DESC LIMIT ?`
      ).all(...where.params, listLimit());
      send(res, 200, {
        ...scopeInfo, ai_uid: askedAi || null,
        open: rows.filter((r) => r.state === "open").length,
        regressed: rows.filter((r) => r.regressed > 0).length,
        issues: rows,
      });
      return true;
    }

    /*
     * 巡检记录。
     * 🔴 `stale` 单独给一个字段：一条说好每小时查一次、却三天没再报的巡检，
     *    比一条报 fail 的更危险 —— 前者会安静地让人以为"没消息就是好消息"。
     */
    if (path === `${base}/checks`) {
      const where = whereFor();
      const rows = prep(
        `SELECT * FROM agent_checks WHERE 1=1${where.sql}
          ORDER BY CASE result WHEN 'fail' THEN 0 WHEN 'warn' THEN 1
                               WHEN 'unknown' THEN 2 ELSE 3 END, ts DESC LIMIT ?`
      ).all(...where.params, listLimit());
      const items = rows.map((r) => ({
        ...r,
        // 它自己说了下次什么时候查，结果过了点还没报 ⇒ 这条巡检自己停了
        overdue: !!r.next_ts && r.next_ts < nowSec,
      }));
      send(res, 200, {
        ...scopeInfo, ai_uid: askedAi || null,
        failing: items.filter((i) => i.result === "fail" || i.result === "warn").length,
        overdue: items.filter((i) => i.overdue).length,
        checks: items,
      });
      return true;
    }

    /*
     * 看板（总览）。形态取自那版 DashboardPage.vue 顶上那排数字 + 「我的数字分身」一列。
     *
     * 🔴 那版顶上写的是「收到消息 / 发出消息 / 活跃会话」—— 那几个数在我们这边归
     *    渠道记录管（`/channel-records/agents`），**不在这个口里凑**：
     *    同一个数字有两处算法，早晚有一天两页显示不一样。界面自己取两个口拼。
     * 🔴 这个口只回答一句话：**名下这些 AI，此刻整体怎么样。**
     *    每个数字都来自真实上报，没有一个是推断出来的；没人报的那几项就是 0，
     *    界面照实写「还没有 AI 报过」，不拿 0 冒充"一切正常"。
     * 🔴 `never_reported` 单独给一个数：它和"报过但过期了"是两件事 ——
     *    前者说明这台 AI 压根没接上来（44 台只活 7 台断的就是这一环），
     *    后者说明它接上来过、现在掉线了。混成一个"离线数"就看不出该去修哪头。
     */
    if (path === `${base}/overview`) {
      const where = whereFor();
      const one = (sql, ...extra) => prep(sql).get(...where.params, ...extra) || {};

      // AI 人口：以名册为准（同 health 口），没报过的也算在总数里。
      const healthRows = prep(
        `SELECT ai_uid, ts, ttl, issues FROM agent_health WHERE 1=1${where.sql}`
      ).all(...where.params);
      const byUid = new Map(healthRows.map((r) => [r.ai_uid, r]));
      const uids = roster && !askedAi
        ? roster.map((r) => r.ai_uid)
        : [...new Set([...byUid.keys()])];
      for (const uid of byUid.keys()) if (!uids.includes(uid)) uids.push(uid);

      let reporting = 0, never = 0, stale = 0, errIssues = 0, warnIssues = 0;
      for (const uid of uids) {
        const r = byUid.get(uid);
        if (!r) { never += 1; continue; }
        if (nowSec - r.ts > r.ttl) { stale += 1; continue; }
        reporting += 1;
        for (const i of parseArr(r.issues)) {
          if (i?.level === "error") errIssues += 1;
          else if (i?.level === "warn") warnIssues += 1;
        }
      }

      // 此刻在干活的（状态口那张表，过期的不算 —— 过期就不再声称它在忙）。
      const busyRows = prep(
        `SELECT status, ts, ttl FROM agent_status WHERE 1=1${where.sql}`
      ).all(...where.params);
      const busy = busyRows.filter(
        (r) => r.status === "busy" && nowSec - r.ts <= r.ttl
      ).length;

      const tasks = one(
        `SELECT
           SUM(state='doing')   AS doing,
           SUM(state='todo')    AS todo,
           SUM(state='blocked') AS blocked,
           SUM(state='done')    AS done
         FROM agent_tasks WHERE 1=1${where.sql}`
      );
      const skills = one(
        `SELECT COUNT(*) AS total, SUM(enabled=1) AS enabled
           FROM agent_skills WHERE 1=1${where.sql}`
      );
      const mems = one(
        `SELECT COUNT(*) AS total, SUM(COALESCE(bytes,0)) AS bytes
           FROM agent_memories WHERE 1=1${where.sql}`
      );
      const backups = one(
        `SELECT COUNT(*) AS total,
                SUM(result IN ('fail','warn')) AS failing,
                SUM(result='unknown') AS unknown
           FROM agent_backups WHERE 1=1${where.sql}`
      );
      const arts = one(
        `SELECT COUNT(*) AS total, SUM(ts >= ?) AS recent
           FROM agent_artifacts WHERE 1=1${where.sql}`,
        nowSec - 7 * 86400
      );
      /*
       * 待批的事。🔴 过了期限的不算"等你批" —— 和 /approvals 口同一条规矩，
       *    两处都算一遍是刻意的：看板上的数字必须和点进去看到的条数对得上。
       */
      const approvals = one(
        `SELECT
           SUM(state='pending' AND (expires_ts IS NULL OR expires_ts >= ?))          AS pending,
           SUM(state='pending' AND risk='high' AND (expires_ts IS NULL OR expires_ts >= ?)) AS high
         FROM agent_approvals WHERE 1=1${where.sql}`,
        nowSec, nowSec
      );
      const issues2 = one(
        `SELECT SUM(state='open') AS open, SUM(regressed > 0) AS regressed
           FROM agent_issues WHERE 1=1${where.sql}`
      );
      const checks = one(
        `SELECT COUNT(*) AS total,
                SUM(result IN ('fail','warn')) AS failing,
                SUM(next_ts IS NOT NULL AND next_ts < ?) AS overdue
           FROM agent_checks WHERE 1=1${where.sql}`,
        nowSec
      );

      /*
       * 近 14 天的动静：按天数事件条数。
       * 🔴 这是**上报事件的条数**，不是消息数、更不是 token 用量 ——
       *    界面必须照这个名字说（那版那张图叫「用量趋势」，我们没有用量，
       *    照抄那个标题就是拿一个数字冒充另一个数字）。
       */
      const dayRows = prep(
        `SELECT CAST(ts / 86400 AS INTEGER) AS day, COUNT(*) AS n
           FROM agent_events WHERE ts >= ?${where.sql}
          GROUP BY day ORDER BY day`
      ).all(nowSec - 14 * 86400, ...where.params);
      const today = Math.floor(nowSec / 86400);
      const byDay = new Map(dayRows.map((r) => [r.day, r.n]));
      const activity = [];
      for (let d = today - 13; d <= today; d += 1) {
        activity.push({ day: d * 86400, events: byDay.get(d) || 0 });
      }

      const num = (v) => Number(v || 0);
      send(res, 200, {
        ...scopeInfo, now: nowSec,
        agents: {
          total: uids.length,
          reporting,
          // 两件事分开给，理由见本段开头。
          never_reported: never,
          stale,
          busy,
        },
        issues: { error: errIssues, warn: warnIssues },
        tasks: {
          doing: num(tasks.doing), todo: num(tasks.todo),
          blocked: num(tasks.blocked), done: num(tasks.done),
        },
        skills: { total: num(skills.total), enabled: num(skills.enabled) },
        memories: { total: num(mems.total), bytes: num(mems.bytes) },
        backups: {
          total: num(backups.total), failing: num(backups.failing),
          unknown: num(backups.unknown),
        },
        artifacts: { total: num(arts.total), recent_7d: num(arts.recent) },
        approvals: { pending: num(approvals.pending), high: num(approvals.high) },
        // 🔴 台账里的 open 和 health 里的 issues 不是一个数：前者是"还没人管的账"，
        //    后者是"它此刻自报的毛病"。两个都给，界面分开说。
        issue_ledger: { open: num(issues2.open), regressed: num(issues2.regressed) },
        checks: {
          total: num(checks.total), failing: num(checks.failing), overdue: num(checks.overdue),
        },
        activity_14d: activity,
      });
      return true;
    }

    if (path === `${base}/timeline`) {
      /*
       * 今天这一天：把事件折成色块。
       * 🔴 这里**只用真实事件**，段与段之间的空白就让它空着 ——
       *    脑补"这段时间它应该在忙"就是又一种示例数据。
       */
      /*
       * 🔴 不能写成 `numOrNull(...) ?? 默认值`（09-10 起就是这么错的，09-13 截图时才现形）：
       *    `numOrNull` 对 null 会先 `Number(null)` 得到 0，`Number.isFinite(0)` 为真
       *    ⇒ 它返回的是 **0**，不是 null ⇒ `??` 永远不触发。
       *    后果不报错，只是安静地错：窗口变成"从 1970 年到现在"（查了全部事件），
       *    且响应里 since=0，界面上那行时间显示成「时间未知」。
       *    所以先看参数**在不在**，再谈它是什么。
       */
      const sinceParam = url?.searchParams?.get("since");
      const askedSince = sinceParam == null || sinceParam === ""
        ? null
        : numOrNull(sinceParam, 0, Number.MAX_SAFE_INTEGER);
      const dayStart = askedSince ?? nowSec - 12 * 3600;
      const parts = [scopeClause(scopeAiUids), { sql: " AND ts >= ?", params: [Math.floor(dayStart)] }];
      if (askedAi) parts.push({ sql: " AND ai_uid = ?", params: [askedAi] });
      const where = {
        sql: parts.map((p) => p.sql).join(""),
        params: parts.flatMap((p) => p.params),
      };
      const rows = prep(
        `SELECT ai_uid, ts, status, text FROM agent_events
          WHERE 1=1${where.sql} ORDER BY ai_uid, ts`
      ).all(...where.params);
      const byAi = new Map();
      for (const r of rows) {
        if (!byAi.has(r.ai_uid)) byAi.set(r.ai_uid, []);
        const arr = byAi.get(r.ai_uid);
        const last = arr[arr.length - 1];
        if (last && last.status === r.status) last.end = r.ts;
        else arr.push({ start: r.ts, end: r.ts, status: r.status || "idle", text: r.text });
      }
      send(res, 200, {
        ...scopeInfo, since: Math.floor(dayStart), now: nowSec,
        timeline: Object.fromEntries(byAi),
      });
      return true;
    }

    return false;
  }

  /*
   * ── 人做决定的那个口（POST，挂在用户面鉴权**之后**）────────────────
   *
   * 这是这一整套里**第一个平台真能点的按钮**。它之所以立得住，是因为
   * 平台不需要去推动 AI —— **AI 自己回来拉结果**（下面的 handleInbox）。
   *
   * 🔴 三道闸，缺一不可：
   *   ① 必须登录（调用方保证：这个函数只在 whoami 之后被调）
   *   ② 这个 AI 必须在调用者的可见范围内 —— 否则就是替别人家的 AI 做主
   *   ③ 状态必须还允许这个动作（批/驳只对 pending，撤回只对 approved），
   *      SQL 的 WHERE 再钉一次：并发点两下，只有第一下算数
   */
  async function handleAct(req, res, { path, root, uid, scopeAiUids = null }) {
    const base = `${root}/agent-status`;
    if (!path.startsWith(`${base}/`)) return false;
    const isApprove = path === `${base}/approvals/decide`;
    const isIssue = path === `${base}/issues/handle`;
    if (!isApprove && !isIssue) return false;
    if (req.method !== "POST") {
      send(res, 405, { error: "method not allowed" });
      return true;
    }
    let body;
    try {
      body = await readJson(req, 64 * 1024);
    } catch {
      send(res, 400, { error: "bad json" });
      return true;
    }
    const aiUid = clean(body?.ai_uid, 80);
    const key = clean(body?.key, 200);
    if (!aiUid || !key) {
      send(res, 400, { error: "ai_uid and key are required" });
      return true;
    }
    // 🔴 闸②：不在可见范围内一律拒。空数组＝一个都看不到（同读取面那条）。
    if (scopeAiUids && !scopeAiUids.includes(aiUid)) {
      send(res, 403, { error: "not your agent" });
      return true;
    }
    const nowMs = now();
    const nowSec = Math.floor(nowMs / 1000);
    const note = body?.note ? clean(body.note, 500) : null;

    if (isApprove) {
      const decision = clean(body?.decision, 20);
      if (!APPROVAL_DECISIONS.has(decision)) {
        send(res, 400, { error: `decision must be one of ${[...APPROVAL_DECISIONS].join("|")}` });
        return true;
      }
      const cur = prep(
        "SELECT * FROM agent_approvals WHERE ai_uid = ? AND key = ?"
      ).get(aiUid, key);
      if (!cur) {
        send(res, 404, { error: "no such approval" });
        return true;
      }
      /*
       * 🔴 过期的不许再批：读取面把它显示成 expired，写入面也必须真的拒 ——
       *    两边不一致的话，界面上灰着的按钮用接口照样点得动。
       */
      if (cur.expires_ts && cur.expires_ts < nowSec && cur.state !== "withdrawn") {
        send(res, 409, {
          error: "expired",
          why: "这条已经过了它自己给的期限，过期的批准不算数。让它重新提一次。",
        });
        return true;
      }
      const r = decision === "withdrawn"
        ? q.withdrawApproval.run({
            ai_uid: aiUid, key, decided_ts: nowSec, decided_by: uid,
            decide_note: note, updated_at: nowMs,
          })
        : q.decideApproval.run({
            ai_uid: aiUid, key, state: decision, decided_ts: nowSec, decided_by: uid,
            decide_note: note, updated_at: nowMs,
          });
      if (!r.changes) {
        // 没改动只有一种可能：状态已经不允许这个动作了（别人先点了，或状态不对）
        send(res, 409, {
          error: "state does not allow it",
          state: cur.state,
          why: decision === "withdrawn"
            ? "只有已经批准的才谈得上撤回。"
            : "这条已经有人做过决定了 —— 界面刷新一下就能看到是谁、什么时候。",
        });
        return true;
      }
      /*
       * 🔴 照抄那版审批规则里最该记住的一句：
       *    **审批通过只代表允许执行，不等于动作成功。**
       *    所以这里回的是"已记下"，不是"已办成"。
       */
      send(res, 200, {
        ok: true, ai_uid: aiUid, key, state: decision,
        note: "已记下。批准只代表允许它去做，不代表这件事已经做成 —— 做没做成看它之后报上来的。",
      });
      return true;
    }

    // 问题台账的处置
    const state = clean(body?.state, 20);
    if (!ISSUE_HANDLES.has(state)) {
      send(res, 400, { error: `state must be one of ${[...ISSUE_HANDLES].join("|")}` });
      return true;
    }
    const r = q.handleIssue.run({
      ai_uid: aiUid, key, state,
      // 重新打开时把处置人抹掉：那条账重新变成"没人管"，不是"某人管过"
      handled_ts: state === "open" ? null : nowSec,
      handled_by: state === "open" ? null : uid,
      handle_note: state === "open" ? null : note,
      updated_at: nowMs,
    });
    if (!r.changes) {
      send(res, 404, { error: "no such issue" });
      return true;
    }
    send(res, 200, {
      ok: true, ai_uid: aiUid, key, state,
      note: state === "fixed"
        ? "已记下。它下次再报同一条，这里会自动重新打开并记一次「修完又犯」。"
        : "已记下。",
    });
    return true;
  }

  /*
   * ── AI 回来拉结果的口（GET，bot 凭据，挡在用户面鉴权**之前**）────────
   *
   * 这个口是审批那个按钮能成立的原因：平台没有推给 AI 的通道，
   * 但 AI 有回来问的能力。它问「有什么批给我了」，我们把结果给它，
   * 并记下它已经知道了（fetched_ts）——
   * 界面据此能说清「它还不知道」还是「它已经收到了」。
   *
   * 🔴 身份只认宿主认定的（同上报口）：拿 bot 凭据换出来的 ai_uid 才算数，
   *    自报的一律不认 —— 否则任何一台机器都能来问别人家的批准。
   */
  async function handleInbox(req, res, { path, url, root }) {
    if (path !== `${root}/agent-status/inbox`) return false;
    if (req.method !== "GET") {
      send(res, 405, { error: "method not allowed" });
      return true;
    }
    const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    if (!bearer || !botAuth?.identify) {
      send(res, 401, {
        error: "bot credential required",
        why: "这个口只回答 AI 自己：要带它自己的连接凭据（Authorization: Bearer bf_…）。",
      });
      return true;
    }
    const who = await botAuth.identify(bearer);
    if (!who.ok) {
      send(res, who.status, { error: who.error });
      return true;
    }
    const aiUid = who.robotId;
    const nowSec = Math.floor(now() / 1000);
    const rows = prep(
      `SELECT * FROM agent_approvals
        WHERE ai_uid = ? AND state <> 'pending'
        ORDER BY decided_ts DESC LIMIT 100`
    ).all(aiUid);
    // 默认只给它**还没拉过的**（拉过一次就别再重复执行同一件事）
    const onlyNew = url?.searchParams?.get("all") !== "1";
    const items = rows
      .filter((r) => !onlyNew || !r.fetched_ts)
      .map((r) => {
        const expired = !!r.expires_ts && r.expires_ts < nowSec;
        return {
          key: r.key, title: r.title, kind: r.kind || null, risk: r.risk,
          // 过期压过一切：一张过了期的批准不算批准
          state: expired && r.state === "approved" ? "expired" : r.state,
          decided_ts: r.decided_ts || null, decide_note: r.decide_note || null,
          expires_ts: r.expires_ts || null,
        };
      });
    // 记下它已经知道了。🔴 只标这次真的给出去的那几条。
    for (const it of items) q.markApprovalFetched.run({ ai_uid: aiUid, key: it.key, ts: nowSec });
    send(res, 200, {
      ai_uid: aiUid, now: nowSec, decisions: items,
      note: "批准只代表允许你去做，不代表这件事已经做成。做完了把结果报上来。",
    });
    return true;
  }

  return { handleReport, handle, handleAct, handleInbox, shape };
}
