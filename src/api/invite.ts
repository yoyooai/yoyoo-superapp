/**
 * 「邀请 AI」客户端 —— 两段：我们自己的票据后端 + 宿主的建号接口。
 *
 * 🔴 本文件不许 import 任何 `@octo/*`（tests/no-host-leak.test.ts 守着）。
 *    宿主地址和用户 token 都由调用方传进来，所以换壳时只换 host/ 那一层。
 *
 * 🔴 为什么建号这一步放在**浏览器里**做，而不是让我们后端代劳：
 *    建号需要一把"能替这个人造号"的钥匙。后端要么长期存它（我们绝不存），
 *    要么每次向用户要（那就等于我们经手他的凭据）。放在浏览器里，
 *    钥匙只在这一次点击里存在，用完就没了，我们后端全程不接触。
 *    ⚠️ 因此：这把 `uk_` 钥匙**只许在本文件内用一次，不许存、不许打日志、
 *    不许发给我们自己的后端**。改动这条前先读上面三行。
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
 * 在宿主里建一个 bot 号，返回它的 uid 和连接凭据。
 *
 * 两步都用**这个人自己的登录态**：
 *  ① `GET /v1/runtime-onboarding?space_id=…` —— 宿主为自家 web 提供的接口，
 *     按需生成并返回这个用户的 `uk_` 钥匙（懒创建，不是我们发明的东西）。
 *  ② `POST /v1/user/bots` —— 用那把钥匙建号。这一次调用在宿主那边同一秒
 *     完成五件事：建号、建机器人记录、加入空间、和邀请人互为好友、发凭据。
 *
 * 🔴 `spaceId` 是**必填**，而且必须由调用方给（`WKApp.shared.currentSpaceId`）。
 *    2026-09-02 线上第一次点击就撞在这里：老代码没传，宿主直接 400
 *    `err.server.botfather.runtime_onboarding_space_required`。
 *    宿主那边是 `c.Query("space_id")` → 退回 `X-Space-Id` header → 两个都空就 400，
 *    **故意不做"取第一个空间"的兜底**（怕钥匙绑到用户没打算用的空间上）。
 *    所以这里两个位置都带上，别删；`space_id` 是请求参数，不是响应里会告诉我们的东西
 *    （响应里那个同名字段只是把请求值回显）。
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

  const onboarding = await jsonOrThrow<{ api_key?: string }>(
    await fetch(`${base}/runtime-onboarding?space_id=${encodeURIComponent(space)}`, {
      headers: { token, Authorization: token, "X-Space-Id": space },
    }),
    "取用户钥匙"
  );
  const apiKey = onboarding.api_key;
  if (!apiKey) throw new Error("取用户钥匙失败：宿主没有返回 api_key");

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
   *   代价是那一刻还不知道对方叫什么，所以只能先用占位名。
   *   🔴 **占位名目前不会自动变成它自报的名字**（2026-09-02 真机实测：兑换后号仍叫
   *      「受邀 AI · 待接受」）。自报的名字只落在我们票据库的 `claim_name` 里 ——
   *      改宿主里那个号要 `PUT /v1/user/bots/:bot_id` + 用户的 `uk_` 钥匙，而**我们后端
   *      刻意不持有那把钥匙**（见本文件顶部），所以后端改不了，只能由前端在人打开界面时改。
   *      **这一步还没做** → `tech-debt.md` TD-299。别在这里写"会改"，它不会。
   * - `requireApproval: true`：只出票，不建号 —— 名字等它自己报，一次就对。
   */
  async issue(opts: {
    requireApproval: boolean;
    inviterName?: string;
    note?: string;
    /** 不审批时给号用的占位名 */
    placeholderName?: string;
  }): Promise<IssuedInvite> {
    if (!opts.requireApproval) {
      const { token, spaceId } = this.mintArgs();
      const { botUid, botToken } = await mintBotInHost(
        token,
        spaceId,
        opts.placeholderName || "受邀 AI · 待接受",
        { description: "通过邀请函加入，等待对方自报身份", hostBase: this.hostBase }
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

  async reject(id: string): Promise<void> {
    await this.req(`/invites/${encodeURIComponent(id)}/reject`, { method: "POST", body: "{}" });
  }

  async revoke(id: string): Promise<void> {
    await this.req(`/invites/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
}
