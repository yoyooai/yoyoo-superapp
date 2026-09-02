/**
 * 「邀请 AI」客户端 —— 两段：我们自己的票据后端 + 宿主的建号接口。
 *
 * 🔴 本文件不许 import 任何 `@octo/*`（tests/no-host-leak.test.ts 守着）。
 *    宿主地址和用户 token 都由调用方传进来，所以换壳时只换 host/ 那一层。
 *
 * 🔴 为什么建号这一步放在**浏览器里**做，而不是让我们后端代劳：
 *    建号需要一把"能替这个人造号"的钥匙。后端要么长期存它（我们绝不存），
 *    要么每次向用户要（那就等于我们经手他的凭据）。放在浏览器里，
 *    钥匙只在这一次调用里存在，用完就没了，我们后端全程不接触。
 *    ⚠️ 因此：这把 `uk_` 钥匙**不许存、不许打日志、不许发给我们自己的后端**，
 *    每次要用就现取（`userKey()`），用完让它随作用域一起消失。
 *    改动这条前先读上面三行。
 */

/** 我们后端的票据。`code` 只在出票那一次响应里出现。 */
export interface IssuedInvite {
  id: string;
  code: string;
  letter: string;
  require_approval: boolean;
  expires_at: number;
}

/** 票据列表里的一条（通讯录「待确认」靠它） */
export interface InviteRow {
  id: string;
  status: "open" | "pending" | "accepted" | "rejected" | "revoked" | "expired";
  require_approval: boolean;
  bot_uid: string | null;
  claim_name: string | null;
  claim_owner: string | null;
  claim_desc: string | null;
  note: string | null;
  expires_at: number;
  redeemed_at: number | null;
  /**
   * 自报名字已写回宿主的时刻。`null` ＝ 还顶着占位名，等前端回填
   * （只可能出现在「不审批」那条路上；走审批的号建出来名字就是对的）。
   */
  name_applied_at: number | null;
  created_at: number;
}

const DEFAULT_BASE = "/yoyoo/v1";
/** 宿主接口前缀。和宿主 web 自己用的一致（同源，走它的 nginx）。 */
const HOST_BASE = "/v1";

/**
 * 从错误响应里挖出**能给人看的一句话**。
 *
 * 🔴 2026-09-02 线上踩过：宿主的错误信封长这样 ——
 *    `{"error":{"code":"...","message":"...","http_status":400},"msg":"...","status":400}`
 *    也就是说 `error` 是**对象不是字符串**。老代码 `msg = body.error` 直接把它拼进
 *    模板，用户看到的是「取用户钥匙失败：[object Object]」——真正的原因被吃掉了，
 *    排障只能去翻服务端日志。所以这里逐层取值，并且**只接受字符串**。
 *    改这段前先想：拿不到原因的报错，等于没报错。
 */
function pickErrorMessage(body: unknown, status: number): string {
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim() ? v.trim() : undefined;
  const b = (body ?? {}) as Record<string, unknown>;
  const err = (b.error ?? {}) as Record<string, unknown>;
  return (
    str(b.error) ??            // 有些接口 error 就是一句话
    str(err.message) ??        // 宿主信封的正常位置
    str(b.msg) ??
    str(err.code) ??           // 没有文案至少给出错误码，比状态码可查
    `HTTP ${status}`
  );
}

async function jsonOrThrow<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch { /* 空体或非 JSON：pickErrorMessage 会回落到状态码 */ }
    throw new Error(`${what}失败：${pickErrorMessage(body, res.status)}`);
  }
  return (await res.json()) as T;
}

/**
 * 现取这个人的 `uk_` 钥匙。
 *
 * `GET /v1/runtime-onboarding?space_id=…` 是宿主为自家 web 提供的接口，按需
 * **懒创建**并返回该用户的 `uk_`（不是我们发明的东西）。因为是懒创建、可重复取，
 * 所以"钥匙只在出票那一瞬间存在"是错的 —— 只要人登录着，随时能再取一把。
 * 🔴 2026-09-02 我曾据此误判"名字回填做不到"，把 TD-299 写成了死结。**它不是死结。**
 *
 * 🔴 `spaceId` 是**必填**，而且必须由调用方给（`WKApp.shared.currentSpaceId`）。
 *    2026-09-02 线上第一次点击就撞在这里：老代码没传，宿主直接 400
 *    `err.server.botfather.runtime_onboarding_space_required`。
 *    宿主那边是 `c.Query("space_id")` → 退回 `X-Space-Id` header → 两个都空就 400，
 *    **故意不做"取第一个空间"的兜底**（怕钥匙绑到用户没打算用的空间上）。
 *    所以这里两个位置都带上，别删；`space_id` 是请求参数，不是响应里会告诉我们的东西
 *    （响应里那个同名字段只是把请求值回显）。
 *
 * ⚠️ 返回值是凭据：只许在调用方的这一次调用里用掉，不许存、不许打日志、
 *    不许发给我们自己的后端。
 */
async function userKey(token: string, space: string, base: string): Promise<string> {
  const onboarding = await jsonOrThrow<{ api_key?: string }>(
    await fetch(`${base}/runtime-onboarding?space_id=${encodeURIComponent(space)}`, {
      headers: { token, Authorization: token, "X-Space-Id": space },
    }),
    "取用户钥匙"
  );
  if (!onboarding.api_key) throw new Error("取用户钥匙失败：宿主没有返回 api_key");
  return onboarding.api_key;
}

/**
 * 在宿主里建一个 bot 号，返回它的 uid 和连接凭据。
 *
 * 两步都用**这个人自己的登录态**：现取 `uk_` 钥匙（见 `userKey`），再用它调
 * `POST /v1/user/bots`。这一次调用在宿主那边同一秒完成五件事：建号、建机器人记录、
 * 加入空间、和邀请人互为好友、发凭据。
 */
export async function mintBotInHost(
  token: string,
  spaceId: string,
  displayName: string,
  opts: { description?: string; hostBase?: string } = {}
): Promise<{ botUid: string; botToken: string }> {
  const base = opts.hostBase || HOST_BASE;
  const space = (spaceId || "").trim();
  if (!space) throw new Error("建号失败：拿不到当前空间 id");

  const apiKey = await userKey(token, space, base);

  const created = await jsonOrThrow<{ robot_id?: string; bot_token?: string }>(
    await fetch(`${base}/user/bots`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        name: displayName,
        description: opts.description || "",
        space_id: space,
      }),
    }),
    "建号"
  );
  if (!created.robot_id || !created.bot_token) {
    // 宿主返回缺字段时必须当失败：半个号比没有号更难收拾。
    throw new Error("建号失败：宿主没有返回 robot_id / bot_token");
  }
  return { botUid: created.robot_id, botToken: created.bot_token };
}

/**
 * 把宿主里那个号改成它自报的名字。
 *
 * 依据宿主源码 `modules/botfather/api_user.go`：
 *   - 路由 `PUT /v1/user/bots/:bot_id`，鉴权 `authUserAPIKey()` ⇒ 要 `Bearer uk_`
 *   - `req.Name` 非空、`len <= 64` 才受理，否则 400（所以这里先裁到 64）
 *   - 它只调 `UpdateUser{Name}` —— **只动显示名**
 *
 * 🔴 只动显示名这件事很重要：`username`/`short_no`（@handle）**一个都不碰**，
 *    所以这条路不会撞上 TD-301 那个"删号释放名字撞唯一索引"的雷。
 *    显示名在宿主里本来就不查重（两个 AI 同名不冲突），因此也不存在"名字被占用、
 *    要它另起一个"的情况 —— 会被占用的只有 @handle，而 @handle 是建号时定的、
 *    这里改不了。**别在这里加"撞名重试"逻辑，那是照着不存在的问题写代码。**
 */
export async function renameBotInHost(
  token: string,
  spaceId: string,
  botUid: string,
  name: string,
  opts: { description?: string; hostBase?: string } = {}
): Promise<void> {
  const base = opts.hostBase || HOST_BASE;
  const space = (spaceId || "").trim();
  if (!space) throw new Error("改名失败：拿不到当前空间 id");
  const wanted = (name || "").trim().slice(0, 64);
  if (!wanted) throw new Error("改名失败：名字是空的");

  const apiKey = await userKey(token, space, base);

  const body: Record<string, string> = { name: wanted };
  // 描述是可选的：AI 自报了就顺手写上，没报就**不带这个字段**——
  // 带一个空串会被宿主当成"把描述清空"，那是我们没被要求做的事。
  if (opts.description) body.description = opts.description.slice(0, 500);

  await jsonOrThrow<unknown>(
    await fetch(`${base}/user/bots/${encodeURIComponent(botUid)}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    "改名"
  );
}

/**
 * 名字回填器的节奏。
 * 闲着时 5 分钟一轮；有票在外面飘、或有欠账没补上时 30 秒一轮。
 */
export const RECONCILE_HOT_MS = 30_000;
export const RECONCILE_COLD_MS = 300_000;

/**
 * 起一个后台循环，把欠着的名字补上（见 `InviteApi.reconcileNames`）。
 *
 * 🔴 为什么单独抽成一个可测的函数，而不是在 index.tsx 里写个 `for(;;)`：
 *    2026-09-02 的事故（TD-297）就是"逻辑测了、**接线没测**"——冒烟里的宿主是假的，
 *    真正把两头接起来的那段一行都没跑过，苏白第一次点就失败。
 *    循环写在入口文件里 ⇒ 又是一段测不到的接线。所以它在这儿，且时钟可注入。
 *
 * 页面在后台时跳过这一轮：那时人看不见通讯录，改名一点都不急，别白耗电。
 *
 * @returns 停止函数（当前壳内不会卸载，但不给停止手段的循环是漏，别省这一行）
 */
export function startNameReconciler(
  api: Pick<InviteApi, "reconcileNames">,
  opts: {
    hotMs?: number;
    coldMs?: number;
    /** 页面此刻可见吗。默认读 document；给测试和非浏览器环境留口子。 */
    isVisible?: () => boolean;
    sleep?: (ms: number) => Promise<void>;
  } = {}
): () => void {
  const hot = opts.hotMs ?? RECONCILE_HOT_MS;
  const cold = opts.coldMs ?? RECONCILE_COLD_MS;
  const visible =
    opts.isVisible ??
    (() => typeof document === "undefined" || document.visibilityState === "visible");
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let stopped = false;
  void (async () => {
    while (!stopped) {
      let wait = cold;
      if (visible()) {
        try {
          const { watching } = await api.reconcileNames();
          wait = watching ? hot : cold;
        } catch {
          // reconcileNames 自己已经吞掉了单条错误；能到这儿说明是意料外的。
          // 一样不许把循环带走 —— 这是后台自愈，停了就再也不会自己起来。
        }
      }
      if (stopped) return;
      await sleep(wait);
    }
  })();

  return () => { stopped = true; };
}

export class InviteApi {
  /**
   * `getSpaceId` 和 `getToken` 一样必须是**回调**而不是取好的值：
   * 两者都会在会话期间变（换空间／重登），构造时快照下来就会拿旧的去建号。
   */
  constructor(
    private readonly getToken: () => string | undefined,
    private readonly getSpaceId: () => string | undefined,
    private readonly base: string = DEFAULT_BASE,
    private readonly hostBase: string = HOST_BASE
  ) {}

  /**
   * 建号前置。
   * 🔴 这里**只**查登录态，不查 space —— "space 必填"的唯一权威在
   *    `mintBotInHost` 里那一处（它是建号的第一个动作，拦得一样早）。
   *    两处都写会漂移：改了一处另一处顶着，看起来"改了没生效"。
   */
  private mintArgs(): { token: string; spaceId: string } {
    const token = this.getToken();
    if (!token) throw new Error("没有登录态，无法建号");
    return { token, spaceId: (this.getSpaceId() || "").trim() };
  }

  private async req<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = this.getToken();
    const res = await fetch(`${this.base}${path}`, {
      ...init,
      headers: {
        ...(init.headers || {}),
        ...(token ? { token } : {}),
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
    });
    return jsonOrThrow<T>(res, "请求");
  }

  list(): Promise<{ invites: InviteRow[] }> {
    return this.req("/invites");
  }

  /**
   * 出票。
   * - `requireApproval: false`（默认）：**此刻**就在宿主里把号建好，凭据封进票里。
   *   代价是那一刻还不知道对方叫什么，所以先挂一个临时名（人填的备注，或「新的 AI」）。
   *   兑换后它自报的名字由 `reconcileNames()` 回填 —— 见那个方法的注释。
   *   🔴 临时名**不要**再写成「受邀 AI · 待接受」这种状态词：苏白 2026-09-02 就是
   *      照着这几个字去通讯录找"接受"按钮的（那条路上根本没有接受这一步）。
   *      临时名必须长得像个名字。
   * - `requireApproval: true`：只出票，不建号 —— 名字等它自己报，一次就对。
   */
  async issue(opts: {
    requireApproval: boolean;
    inviterName?: string;
    note?: string;
    /** 不审批时给号用的临时名；留空则用「新的 AI」 */
    placeholderName?: string;
  }): Promise<IssuedInvite> {
    if (!opts.requireApproval) {
      const { token, spaceId } = this.mintArgs();
      const { botUid, botToken } = await mintBotInHost(
        token,
        spaceId,
        (opts.placeholderName || "").trim() || "新的 AI",
        { description: "通过邀请函加入", hostBase: this.hostBase }
      );
      return this.req("/invites", {
        method: "POST",
        body: JSON.stringify({
          require_approval: false,
          bot_uid: botUid,
          bot_token: botToken,
          inviter_name: opts.inviterName,
          note: opts.note,
        }),
      });
    }
    return this.req("/invites", {
      method: "POST",
      body: JSON.stringify({
        require_approval: true,
        inviter_name: opts.inviterName,
        note: opts.note,
      }),
    });
  }

  /**
   * 同意一条待确认。**建号发生在这一刻** —— 所以名字直接用对方自报的那个，
   * 不需要人手填，也不需要事后改。这是走审批那条路唯一的好处，别把它做丢。
   */
  async approve(row: InviteRow): Promise<void> {
    const { token, spaceId } = this.mintArgs();
    const { botUid, botToken } = await mintBotInHost(
      token,
      spaceId,
      row.claim_name || "受邀 AI",
      { description: row.claim_desc || "", hostBase: this.hostBase }
    );
    await this.req(`/invites/${encodeURIComponent(row.id)}/approve`, {
      method: "POST",
      body: JSON.stringify({ bot_uid: botUid, bot_token: botToken }),
    });
  }

  /**
   * 名字回填 —— 「不审批」那条路的收尾（苏白 2026-09-02：
   * "默认直接进来，但它总得给自己起个名字，不要顶个「受邀 AI · 待接受」"）。
   *
   * 为什么必须放在这里、由前端定时跑：
   *   出票那一刻还不知道对方叫什么 ⇒ 号只能先挂临时名；
   *   对方兑换时自报的名字落在我们票据库的 `claim_name` 里 ⇒ 名字是有的；
   *   但**改宿主里那个号要用户的 `uk_` 钥匙，只有他的浏览器里有** ⇒ 后端做不了。
   *   ⇒ 唯一的落法：人一打开界面就把欠着的名字补上。**他不需要点任何东西。**
   *
   * 幂等靠后端的 `name_applied_at`：改成功才打回执，回执打不上就下次再来。
   * 🔴 单条失败不许中断整批（一个号被删了不能连累其它号），也不许往上抛 ——
   *    这是后台自愈动作，不是用户发起的操作，弹错只会莫名其妙。
   *
   * @returns `renamed` 这一轮改成功的条数；`watching` 是否还有"随时可能需要回填"的票
   *          （还没被兑换的票，或这轮没改成的欠账）—— 调用方据此决定盯得勤不勤，
   *          省得没事干的时候也每分钟打一次。
   */
  async reconcileNames(): Promise<{ renamed: number; watching: boolean }> {
    const token = this.getToken();
    const spaceId = (this.getSpaceId() || "").trim();
    // 没登录态/没空间：这一轮什么都做不了，但也不能就此断定"没事可盯"——
    // 保持 watching，等下一轮身份就绪。
    if (!token || !spaceId) return { renamed: 0, watching: true };

    let rows: InviteRow[];
    try {
      ({ invites: rows } = await this.list());
    } catch {
      return { renamed: 0, watching: true }; // 拉不到 ≠ 没有，别把网络抖动当"收工"
    }

    const owed = rows.filter(
      (r) => r.status === "accepted" && !!r.bot_uid && !!r.claim_name && !r.name_applied_at
    );

    let done = 0;
    for (const row of owed) {
      try {
        await renameBotInHost(token, spaceId, row.bot_uid!, row.claim_name!, {
          description: row.claim_desc || undefined,
          hostBase: this.hostBase,
        });
        await this.req(`/invites/${encodeURIComponent(row.id)}/name-applied`, {
          method: "POST",
          body: "{}",
        });
        done += 1;
      } catch {
        // 号可能已被删、名字可能超长被宿主拒 —— 都不该让下一条陪葬。
        // 下一轮还会再试；真是永久失败就一直是"欠着"，不会造成脏数据。
      }
    }

    // 还有没被兑换的票 ⇒ 对方随时可能进来，得盯着；这轮没改完的欠账同理。
    const stillOpen = rows.some((r) => r.status === "open");
    return { renamed: done, watching: stillOpen || done < owed.length };
  }

  async reject(id: string): Promise<void> {
    await this.req(`/invites/${encodeURIComponent(id)}/reject`, { method: "POST", body: "{}" });
  }

  async revoke(id: string): Promise<void> {
    await this.req(`/invites/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
}
