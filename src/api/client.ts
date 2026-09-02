/**
 * 我们自己后端的客户端。
 *
 * 🔴 本文件不许 import 任何 `@octo/*`（tests/no-host-leak.test.ts 守着）。
 *    需要身份时，由调用方把 HostAdapter 取到的 token 传进来 ——
 *    这样换宿主时这一层完全不用动。
 */

/** 列表里的一条（不含 blueprint，省流量） */
export interface AppSummary {
  id: string;
  name: string;
  icon?: string;
  created_by: "human" | "ai";
  created_at: number;
  updated_at: number;
  /** 钉在侧栏了没（后端顺手带上，省一次请求） */
  pinned?: boolean;
  /** 从市场装来的：来源 listing */
  source_listing_id?: string | null;
  /** 作者发了新版而我还没更新 —— 只是提示，不会自动推给我 */
  update_available?: boolean;
}

/** 打开一个应用时拿到的完整数据 */
export interface AppDetail extends AppSummary {
  owner_uid: string;
  blueprint: unknown;
  /** 从市场装来的才有；自己造的是 null */
  source_listing_id?: string | null;
  source_version?: number | null;
}

// ── 市场 ──────────────────────────────────────────────────────────
// 🔴 列表与详情**都不含 blueprint** —— 逛市场不等于拿走全部实现。
//    这不是省流量，是边界：后端那条 SQL 有结构测试钉着。

/** 市场卡片 */
export interface Listing {
  id: string;
  name: string;
  icon?: string;
  summary: string;
  created_by: "human" | "ai";
  author_uid: string;
  version: number;
  installs: number;
  created_at: number;
  updated_at: number;
  /** 我装过没有 */
  installed: boolean;
  /** 我装的那一份的 app_id */
  my_app_id: string | null;
  my_version: number | null;
  /** 作者发了新版而我还没更新 */
  update_available: boolean;
  /** 是我发布的 —— 「我的发布」那一栏据此给出发新版/下架 */
  is_author: boolean;
}

/** 逛市场的排序：最新 / 装得最多。值是 key，后端有白名单，乱传落回 new */
export type BrowseSort = "new" | "hot";

export interface ListingDetail extends Omit<Listing, "my_app_id" | "installed"> {
  is_author: boolean;
  installed: boolean;
  versions: { version: number; note: string | null; created_at: number }[];
}

/** 发布被私货扫描拦下时后端回的东西 */
export interface SensitiveHit {
  id: string;
  label: string;
  count: number;
  /** 已打码的片段 —— 后端刻意不回显原文 */
  samples: string[];
}

export interface SensitiveBlocked {
  error: "sensitive_content";
  message: string;
  hits: SensitiveHit[];
}

export interface PinList {
  pins: { app_id: string; sort: number }[];
  limit: number;
}

export interface CreateAppInput {
  name: string;
  icon?: string;
  blueprint: unknown;
  created_by?: "human" | "ai";
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * 发布被私货扫描拦下时抛这个 —— 界面要把命中项**原样摆给作者看**，
 * 让他自己决定改掉还是确认发布。我们不替他决定，也不静默删改。
 */
export class SensitiveContentError extends ApiError {
  constructor(readonly detail: SensitiveBlocked) {
    super(409, detail.message);
    this.name = "SensitiveContentError";
  }
}

/**
 * 默认走同源 `/yoyoo/v1` —— 由宿主的 nginx 反代到我们的后端。
 * 同源的好处：不需要 CORS，也不需要把后端地址编译进包里
 * （编译进去就意味着换一个部署环境要重新构建，那是很蠢的耦合）。
 */
const DEFAULT_BASE = "/yoyoo/v1";

export class SuperAppApi {
  constructor(
    private readonly getToken: () => string | undefined,
    private readonly base: string = DEFAULT_BASE
  ) {}

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
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as Partial<SensitiveBlocked> & { error?: string };
        // 私货拦截不是普通错误：它带着"命中了什么"，界面要展示，不能被压成一行字
        if (res.status === 409 && body?.error === "sensitive_content") {
          throw new SensitiveContentError(body as SensitiveBlocked);
        }
        if (body?.error) msg = body.error;
      } catch (e) {
        if (e instanceof SensitiveContentError) throw e;
        /* 响应体不是 JSON，就用状态码当消息 */
      }
      throw new ApiError(res.status, msg);
    }
    return (await res.json()) as T;
  }

  list(): Promise<{ apps: AppSummary[] }> {
    return this.req("/apps");
  }

  get(id: string): Promise<AppDetail> {
    return this.req(`/apps/${encodeURIComponent(id)}`);
  }

  create(input: CreateAppInput): Promise<AppSummary> {
    return this.req("/apps", { method: "POST", body: JSON.stringify(input) });
  }

  /**
   * 一句话生成一个应用。
   * `mode` 告诉调用方这次是真模型还是本地兜底 —— 界面上要如实显示，
   * 不能让人以为"AI 给我造的"其实是套模板套出来的。
   */
  generate(prompt: string, opts: { name?: string; icon?: string } = {}): Promise<{
    id: string;
    name: string;
    mode: "llm" | "local";
    note?: string;
    blueprint: unknown;
  }> {
    return this.req("/apps/generate", {
      method: "POST",
      body: JSON.stringify({ prompt, ...opts }),
    });
  }

  remove(id: string): Promise<{ ok: true }> {
    return this.req(`/apps/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  health(): Promise<{ ok: boolean }> {
    return this.req("/health");
  }

  // ── 市场 ────────────────────────────────────────────────────
  /**
   * 逛市场。`mine` = 只看我发布的（「我的发布」那一栏）。
   * 排序在后端做，不在前端排 —— 前端只拿得到当前这一页，
   * 在一页里排出来的"最热"是假的。
   */
  browse(
    q = "",
    page = 0,
    opts: { sort?: BrowseSort; mine?: boolean } = {}
  ): Promise<{ listings: Listing[]; page: number; page_size: number; sort: BrowseSort; mine: boolean }> {
    const p = new URLSearchParams({ q, page: String(page) });
    if (opts.sort === "hot") p.set("sort", "hot");
    if (opts.mine) p.set("mine", "1");
    return this.req(`/market/listings?${p.toString()}`);
  }

  listing(id: string): Promise<ListingDetail> {
    return this.req(`/market/listings/${encodeURIComponent(id)}`);
  }

  /**
   * 发布。命中私货时抛 SensitiveContentError —— 调用方把命中项摆出来，
   * 作者决定要发就带 confirmSensitive 再调一次。
   */
  publish(appId: string, summary: string, opts: { confirmSensitive?: boolean; note?: string } = {}):
    Promise<{ id: string; version: number }> {
    return this.req("/market/listings", {
      method: "POST",
      body: JSON.stringify({
        app_id: appId,
        summary,
        note: opts.note,
        confirm_sensitive: opts.confirmSensitive === true,
      }),
    });
  }

  publishVersion(listingId: string, opts: { confirmSensitive?: boolean; note?: string } = {}):
    Promise<{ id: string; version: number }> {
    return this.req(`/market/listings/${encodeURIComponent(listingId)}/versions`, {
      method: "POST",
      body: JSON.stringify({ note: opts.note, confirm_sensitive: opts.confirmSensitive === true }),
    });
  }

  delist(listingId: string): Promise<{ ok: true }> {
    return this.req(`/market/listings/${encodeURIComponent(listingId)}`, { method: "DELETE" });
  }

  /** 安装 = 复制一份到我名下，返回的是**我的**新 app_id */
  install(listingId: string): Promise<{ app_id: string; version: number; already?: boolean }> {
    return this.req(`/market/listings/${encodeURIComponent(listingId)}/install`, { method: "POST" });
  }

  /** 更新到来源最新版（旧的会自动备份，可 revert 回去） */
  sync(appId: string): Promise<{ ok: true; updated: boolean; version: number }> {
    return this.req(`/apps/${encodeURIComponent(appId)}/sync`, { method: "POST" });
  }

  revert(appId: string): Promise<{ ok: true }> {
    return this.req(`/apps/${encodeURIComponent(appId)}/revert`, { method: "POST" });
  }

  // ── 侧栏钉位 ────────────────────────────────────────────────
  pins(): Promise<PinList> {
    return this.req("/pins");
  }

  setPins(appIds: string[]): Promise<PinList> {
    return this.req("/pins", { method: "PUT", body: JSON.stringify({ app_ids: appIds }) });
  }
}
