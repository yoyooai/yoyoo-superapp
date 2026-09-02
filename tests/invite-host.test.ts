/**
 * 「邀请 AI」建号那一段 —— 对着**宿主真实契约**的测试。
 *
 * 🔴 这个文件为什么存在（2026-09-02 事故复盘，别删）：
 *    这段代码上线时"43 项单测 + 39 项冒烟全绿"，但苏白第一次点「生成邀请」就失败。
 *    原因是覆盖有个洞：单测全在票据后端（`server/`），冒烟里的宿主是**假的**
 *    （`server/invite-smoke.mjs` 的 `startFakeHost` 只回答"这个 token 是谁"），
 *    于是 `mintBotInHost` 这一段——真正跟宿主打交道的那段——**一行都没被测过**。
 *    两个 bug 就这么一起溜到线上：
 *      ① 没带 `space_id` → 宿主 400 `runtime_onboarding_space_required`
 *      ② 错误信封解析写错 → 用户看到「取用户钥匙失败：[object Object]」，
 *         真正的原因被吃掉，只能去翻服务端日志
 *
 *    所以这里的假宿主是**照抄真宿主行为**写的，依据是 octo-server 源码
 *    `modules/botfather/api_runtime_onboarding.go:76-83`（query 优先、header 备选、
 *    两个都空就 400，故意无兜底）和 `modules/botfather/api_user.go:127`
 *    （`POST /v1/user/bots` 用 `Bearer uk_`，响应是裸对象无信封）。
 *    **谁把 space_id 或错误解析改回去，这里必须报红。**
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  mintBotInHost,
  renameBotInHost,
  startNameReconciler,
  InviteApi,
  type InviteRow,
} from "../src/api/invite";

// 🔴 一律用编造值。测试**永不许**出现真实的空间 id 或真实的 `uk_` 钥匙 ——
//    那把钥匙能替人建号，写进文件就等于存下来了（见 src/api/invite.ts 顶部那条：
//    不许存、不许打日志、不许发给我们自己的后端）。
//    2026-09-02 本文件初版真踩过：`UK` 当时直接抄了生产库里苏白那把真钥匙。
const SPACE = "sp_test_0000000000000000000000000000";
const UK = "uk_testtesttesttesttesttesttest00";

/** 宿主的错误信封 —— `error` 是**对象**，这正是当初 [object Object] 的来源。 */
function hostError(code: string, message: string, status = 400) {
  return new Response(
    JSON.stringify({
      error: { code, details: {}, http_status: status, message },
      msg: message,
      status,
    }),
    { status, headers: { "content-type": "application/json" } }
  );
}

function ok(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * 照抄真宿主的判定顺序。返回收到的请求，便于断言"到底带没带 space_id"。
 */
function fakeHost() {
  const seen: { url: string; headers: Record<string, string>; body?: unknown }[] = [];
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(
      Object.entries((init?.headers || {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ])
    );
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    seen.push({ url, headers, body });

    if (url.includes("/runtime-onboarding")) {
      if (!headers.token && !headers.authorization) {
        return hostError("err.shared.auth.token_missing", "token不能为空，请先登录！", 401);
      }
      // api_runtime_onboarding.go:76-83 —— query 优先, header 备选, 都空则 400.
      const q = new URL(url, "http://h").searchParams.get("space_id");
      const spaceID = (q || headers["x-space-id"] || "").trim();
      if (!spaceID) {
        return hostError(
          "err.server.botfather.runtime_onboarding_space_required",
          "Runtime onboarding requires a space."
        );
      }
      // 真宿主把请求里的 space_id 回显在响应里 —— 它不是"服务端告诉我们空间"的来源。
      return ok({ api_key: UK, space_id: spaceID, server_url: "https://h", commands: {} });
    }

    if (url.includes("/user/bots")) {
      if (headers.authorization !== `Bearer ${UK}`) {
        return hostError("err.shared.token_invalid", "凭据无效。", 401);
      }
      // api_user.go:278 —— c.Response 不包信封, 是裸对象.
      return ok({
        robot_id: "newbot_x",
        username: "newbot_x",
        name: (body as { name?: string })?.name,
        bot_token: "bf_newtoken",
      });
    }
    throw new Error(`假宿主没实现这个路由: ${url}`);
  });
  return { fetchMock, seen };
}

afterEach(() => void vi.unstubAllGlobals());

describe("mintBotInHost 对宿主的真实契约", () => {
  it("把 space_id 同时放进 query 和 X-Space-Id，然后建号成功", async () => {
    const { fetchMock, seen } = fakeHost();
    vi.stubGlobal("fetch", fetchMock);

    const got = await mintBotInHost("tok-subai", SPACE, "受邀 AI · 待接受", {
      description: "通过邀请函加入",
    });

    expect(got).toEqual({ botUid: "newbot_x", botToken: "bf_newtoken" });

    const onboarding = seen[0];
    expect(onboarding.url).toContain(`space_id=${SPACE}`);
    expect(onboarding.headers["x-space-id"]).toBe(SPACE);
    expect(onboarding.headers.token).toBe("tok-subai");

    // 建号那一步必须用刚拿到的 uk_ 钥匙，且把 space_id 带上。
    const create = seen[1];
    expect(create.headers.authorization).toBe(`Bearer ${UK}`);
    expect(create.body).toMatchObject({ space_id: SPACE, name: "受邀 AI · 待接受" });
  });

  it("🔴 不带 space_id 就会被宿主 400 挡回来（谁去掉 space_id，这条报红）", async () => {
    const { fetchMock } = fakeHost();
    vi.stubGlobal("fetch", fetchMock);

    // 直接打假宿主，模拟"代码里没带 space_id"那个回归。
    await expect(
      fetch("/v1/runtime-onboarding", { headers: { token: "tok-subai" } }).then((r) => r.status)
    ).resolves.toBe(400);

    // 而正常调用（带 space_id）不该被挡 —— 证明上面那个 400 是缺参数导致的，
    // 不是假宿主一律拒绝。
    await expect(mintBotInHost("tok-subai", SPACE, "x")).resolves.toMatchObject({
      botUid: "newbot_x",
    });
  });

  it("拿不到空间 id 时当场报错，不去打宿主", async () => {
    const { fetchMock } = fakeHost();
    vi.stubGlobal("fetch", fetchMock);

    await expect(mintBotInHost("tok-subai", "  ", "x")).rejects.toThrow("拿不到当前空间 id");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("错误信封解析（[object Object] 回归防线）", () => {
  it("宿主信封里 error 是对象时，报出 message 而不是 [object Object]", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        hostError(
          "err.server.botfather.runtime_onboarding_space_required",
          "Runtime onboarding requires a space."
        )
      )
    );

    const err = await mintBotInHost("tok", SPACE, "x").catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).not.toContain("[object Object]");
    expect(msg).toContain("取用户钥匙失败");
    expect(msg).toContain("Runtime onboarding requires a space.");
  });

  it("没有 message 时回落到错误码，仍然可查", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: "err.server.x.y" }, status: 400 }), {
            status: 400,
            headers: { "content-type": "application/json" },
          })
      )
    );

    const err = await mintBotInHost("tok", SPACE, "x").catch((e: Error) => e);
    expect((err as Error).message).toContain("err.server.x.y");
    expect((err as Error).message).not.toContain("[object Object]");
  });

  it("非 JSON 空体时回落到状态码，不炸在解析上", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 502 })));

    const err = await mintBotInHost("tok", SPACE, "x").catch((e: Error) => e);
    expect((err as Error).message).toContain("HTTP 502");
  });
});

describe("InviteApi 的建号前置", () => {
  const TICKET = { id: "i1", code: "c1", letter: "L", require_approval: false, expires_at: 0 };

  it("没有空间 id 时明确说缺什么，且不出票、不打宿主", async () => {
    const fetchMock = vi.fn(async () => ok(TICKET));
    vi.stubGlobal("fetch", fetchMock);

    const api = new InviteApi(() => "tok", () => undefined);
    // 「空间必填」的唯一权威在 mintBotInHost，所以这里断言的是它那句文案 ——
    // 断言用户真会看到的那一句，而不是某个中间层的措辞。
    await expect(api.issue({ requireApproval: false })).rejects.toThrow(
      "建号失败：拿不到当前空间 id"
    );
    // 建号没成之前一票都不该出（半张票比没票更难收拾）。
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("没有登录态时不去建号", async () => {
    const fetchMock = vi.fn(async () => ok(TICKET));
    vi.stubGlobal("fetch", fetchMock);

    const api = new InviteApi(() => undefined, () => SPACE);
    await expect(api.issue({ requireApproval: false })).rejects.toThrow("没有登录态");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("spaceId 是回调而非快照 —— 换空间后建号用的是新空间", async () => {
    const { fetchMock, seen } = fakeHost();
    // 出票那一步打的是我们自己的后端，补上它的返回。
    const combined = vi.fn(async (input: string | URL, init?: RequestInit) => {
      if (String(input).includes("/yoyoo/v1/invites")) return ok(TICKET);
      return fetchMock(input, init);
    });
    vi.stubGlobal("fetch", combined);

    let current = "space-old";
    const api = new InviteApi(() => "tok", () => current);
    current = "space-new";
    await api.issue({ requireApproval: false });

    expect(seen[0].url).toContain("space_id=space-new");
  });

  it("要审批那条路不建号，所以没有空间 id 也能出票", async () => {
    const fetchMock = vi.fn(async () => ok({ ...TICKET, require_approval: true }));
    vi.stubGlobal("fetch", fetchMock);

    const api = new InviteApi(() => "tok", () => undefined);
    await expect(api.issue({ requireApproval: true })).resolves.toMatchObject({
      require_approval: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * ── 名字回填（苏白 2026-09-02：「默认直接进来，但它总得给自己起个名字，
 *    不要顶个『受邀 AI · 待接受』」）─────────────────────────────────
 *
 * 🔴 这一组守的是**产品承诺**，不只是代码：弹层上现在明写着"名字会自动换成它报的那个"。
 *    文案跑到实现前面这件事这个功能上已经犯过一次（TD-299），别再犯第二次。
 */

/** 假宿主 + 改名路由。返回收到的请求，便于断言改的是哪个号、改成什么。 */
function fakeHostWithRename() {
  const base = fakeHost();
  const renames: { botUid: string; body: unknown; auth?: string }[] = [];
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    // 只拦"改名"这一形状：PUT /v1/user/bots/:id（建号是 POST /v1/user/bots）
    const m = /\/user\/bots\/([^/?]+)$/.exec(url);
    if (m && (init?.method || "GET").toUpperCase() === "PUT") {
      const headers = Object.fromEntries(
        Object.entries((init?.headers || {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(), v,
        ])
      );
      if (headers.authorization !== `Bearer ${UK}`) {
        return hostError("err.shared.token_invalid", "凭据无效。", 401);
      }
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      // 照抄宿主 api_user.go：name 空或 >64 一律 400
      const name = (body as { name?: string })?.name;
      if (!name || name.length > 64) return hostError("err.request.invalid", "name", 400);
      renames.push({ botUid: decodeURIComponent(m[1]), body, auth: headers.authorization });
      return ok({ id: m[1], name });
    }
    return base.fetchMock(input, init);
  });
  return { fetchMock, renames, seen: base.seen };
}

const ROW: InviteRow = {
  id: "i1",
  status: "accepted",
  require_approval: false,
  bot_uid: "guest_bot",
  claim_name: "小蓝",
  claim_owner: null,
  claim_desc: null,
  note: null,
  expires_at: 0,
  redeemed_at: 1,
  name_applied_at: null,
  created_at: 0,
};

/** 把我们自己的票据后端也接上：GET 列表 + POST 回执。 */
function withTicketBackend(
  hostFetch: (i: string | URL, n?: RequestInit) => Promise<Response>,
  invites: InviteRow[]
) {
  const receipts: string[] = [];
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/name-applied")) {
      receipts.push(url);
      return ok({ id: "i1", name_applied_at: 123 });
    }
    if (url.includes("/yoyoo/v1/invites")) return ok({ invites });
    return hostFetch(input, init);
  });
  return { fetchMock, receipts };
}

describe("renameBotInHost 对宿主的真实契约", () => {
  it("用现取的 uk_ 钥匙 PUT 到那个号上，只带 name", async () => {
    const { fetchMock, renames, seen } = fakeHostWithRename();
    vi.stubGlobal("fetch", fetchMock);

    await renameBotInHost("tok", SPACE, "guest_bot", "小蓝");

    expect(renames).toHaveLength(1);
    expect(renames[0].botUid).toBe("guest_bot");
    expect(renames[0].body).toEqual({ name: "小蓝" });
    // 钥匙是现取的 —— 改名前必须先打 runtime-onboarding（带 space_id）。
    expect(seen[0].url).toContain(`space_id=${SPACE}`);
  });

  it("🔴 只改显示名，绝不碰 username / short_no（那是 TD-301 那个雷）", async () => {
    const { fetchMock, renames } = fakeHostWithRename();
    vi.stubGlobal("fetch", fetchMock);

    await renameBotInHost("tok", SPACE, "guest_bot", "小蓝", { description: "干活的" });

    const body = renames[0].body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["description", "name"]);
    expect(body).not.toHaveProperty("username");
    expect(body).not.toHaveProperty("short_no");
  });

  it("没自报描述时不带 description（空串会被宿主当成「清空描述」）", async () => {
    const { fetchMock, renames } = fakeHostWithRename();
    vi.stubGlobal("fetch", fetchMock);

    await renameBotInHost("tok", SPACE, "guest_bot", "小蓝", { description: "" });
    expect(renames[0].body).toEqual({ name: "小蓝" });
  });

  it("名字裁到 64 字（宿主超过就 400，裁在这边比让人看报错强）", async () => {
    const { fetchMock, renames } = fakeHostWithRename();
    vi.stubGlobal("fetch", fetchMock);

    await renameBotInHost("tok", SPACE, "guest_bot", "名".repeat(200));
    expect((renames[0].body as { name: string }).name).toHaveLength(64);
  });

  it("空名字/没空间时当场报错，不去打宿主", async () => {
    const { fetchMock } = fakeHostWithRename();
    vi.stubGlobal("fetch", fetchMock);

    await expect(renameBotInHost("tok", SPACE, "b", "   ")).rejects.toThrow("名字是空的");
    await expect(renameBotInHost("tok", " ", "b", "小蓝")).rejects.toThrow("拿不到当前空间 id");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("reconcileNames —— 欠着的名字自动补上", () => {
  it("把自报的名字写回宿主，然后打回执", async () => {
    const host = fakeHostWithRename();
    const { fetchMock, receipts } = withTicketBackend(host.fetchMock, [ROW]);
    vi.stubGlobal("fetch", fetchMock);

    const api = new InviteApi(() => "tok", () => SPACE);
    const r = await api.reconcileNames();

    expect(r.renamed).toBe(1);
    expect(host.renames[0]).toMatchObject({ botUid: "guest_bot" });
    expect(host.renames[0].body).toEqual({ name: "小蓝" });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toContain("/invites/i1/name-applied");
  });

  it("🔴 已经回填过的不再改（否则每次打开界面都白打一次宿主）", async () => {
    const host = fakeHostWithRename();
    const { fetchMock, receipts } = withTicketBackend(host.fetchMock, [
      { ...ROW, name_applied_at: 999 },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const r = await new InviteApi(() => "tok", () => SPACE).reconcileNames();
    expect(r.renamed).toBe(0);
    expect(host.renames).toHaveLength(0);
    expect(receipts).toHaveLength(0);
  });

  it("还没兑换 / 没自报名字 / 没有号的，一律不动", async () => {
    const host = fakeHostWithRename();
    const { fetchMock } = withTicketBackend(host.fetchMock, [
      { ...ROW, id: "a", status: "open" },
      { ...ROW, id: "b", claim_name: null },
      { ...ROW, id: "c", bot_uid: null },
      { ...ROW, id: "d", status: "rejected" },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const r = await new InviteApi(() => "tok", () => SPACE).reconcileNames();
    expect(r.renamed).toBe(0);
    expect(host.renames).toHaveLength(0);
  });

  it("🔴 一条失败不许连累其它条（号被删了不能让整批停摆）", async () => {
    const host = fakeHostWithRename();
    const { fetchMock, receipts } = withTicketBackend(
      // 第一个号改名必炸，第二个正常
      async (input: string | URL, init?: RequestInit) => {
        if (String(input).includes("/user/bots/dead_bot")) {
          return hostError("err.server.botfather.bot_not_found", "bot not found", 404);
        }
        return host.fetchMock(input, init);
      },
      [{ ...ROW, id: "i1", bot_uid: "dead_bot" }, { ...ROW, id: "i2", bot_uid: "guest_bot" }]
    );
    vi.stubGlobal("fetch", fetchMock);

    const r = await new InviteApi(() => "tok", () => SPACE).reconcileNames();
    expect(r.renamed).toBe(1);              // 第二个成了
    expect(receipts).toHaveLength(1);       // 只给成了的那个打回执
    expect(r.watching).toBe(true);          // 还欠着一条 ⇒ 继续盯
  });

  it("🔴 从不向上抛 —— 它是后台自愈，抛一次循环就再也起不来了", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    await expect(
      new InviteApi(() => "tok", () => SPACE).reconcileNames()
    ).resolves.toEqual({ renamed: 0, watching: true });
  });

  it("没登录态就什么都不做，但仍然继续盯着", async () => {
    const fetchMock = vi.fn(async () => ok({ invites: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await new InviteApi(() => undefined, () => SPACE).reconcileNames();
    expect(r).toEqual({ renamed: 0, watching: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("没票在外面飘、也没欠账时收工（盯得勤是有代价的）", async () => {
    const host = fakeHostWithRename();
    const { fetchMock } = withTicketBackend(host.fetchMock, [
      { ...ROW, name_applied_at: 1 },
      { ...ROW, id: "x", status: "revoked" },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const r = await new InviteApi(() => "tok", () => SPACE).reconcileNames();
    expect(r.watching).toBe(false);
  });

  it("还有票没被兑换 ⇒ 继续盯（对方随时可能进来）", async () => {
    const host = fakeHostWithRename();
    const { fetchMock } = withTicketBackend(host.fetchMock, [{ ...ROW, status: "open" }]);
    vi.stubGlobal("fetch", fetchMock);
    const r = await new InviteApi(() => "tok", () => SPACE).reconcileNames();
    expect(r.watching).toBe(true);
  });
});

describe("临时名（占位名）", () => {
  const TICKET2 = { id: "i1", code: "c1", letter: "L", require_approval: false, expires_at: 0 };

  const issueWith = async (placeholderName?: string) => {
    const host = fakeHost();
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      if (String(input).includes("/yoyoo/v1/invites")) return ok(TICKET2);
      return host.fetchMock(input, init);
    });
    vi.stubGlobal("fetch", fetchMock);
    await new InviteApi(() => "tok", () => SPACE).issue({
      requireApproval: false,
      placeholderName,
    });
    // seen[1] 是 POST /user/bots（seen[0] 是取钥匙）
    return (host.seen[1].body as { name: string }).name;
  };

  it("人填了临时名就用它（苏白填「小A」时想的就是给它起名字）", async () => {
    expect(await issueWith("小A")).toBe("小A");
  });

  it("留空时用「新的 AI」", async () => {
    expect(await issueWith(undefined)).toBe("新的 AI");
    expect(await issueWith("   ")).toBe("新的 AI");
  });

  it("🔴 临时名里绝不许再出现「待接受」这种状态词（苏白照着它去找过按钮）", async () => {
    for (const n of [await issueWith(undefined), await issueWith("小A")]) {
      expect(n).not.toContain("待接受");
      expect(n).not.toContain("受邀");
    }
  });
});

describe("startNameReconciler —— 后台回填循环（这段是「接线」，TD-297 就死在没测接线上）", () => {
  /**
   * 可控时钟。两个动作分开，别合成一个 —— 合起来会"放行的同时又跑了一轮"，
   * 于是断言次数永远差一，看起来像实现错了（初版就掉进这个坑）。
   *   settle() = 等循环跑完一轮、停在 sleep 上
   *   advance() = 放行这一次 sleep，再等它跑完下一轮
   */
  function clock() {
    const waits: number[] = [];
    let release: (() => void) | null = null;
    const sleep = (ms: number) => {
      waits.push(ms);
      return new Promise<void>((r) => { release = r; });
    };
    const drain = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
    const settle = async () => {
      for (let i = 0; i < 50 && !release; i++) await Promise.resolve();
      await drain();
    };
    const advance = async () => {
      const r = release;
      release = null;
      r?.();
      await settle();
    };
    return { waits, sleep, settle, advance };
  }

  it("一起来就跑一轮，不等第一个间隔（人刚打开界面就该看到对的名字）", async () => {
    const reconcileNames = vi.fn(async () => ({ renamed: 1, watching: false }));
    const { sleep, settle } = clock();
    const stop = startNameReconciler({ reconcileNames }, { sleep, isVisible: () => true });
    await settle();
    expect(reconcileNames).toHaveBeenCalledTimes(1);
    stop();
  });

  it("有欠账/有票在飘时盯得勤，闲下来就放慢", async () => {
    const reconcileNames = vi
      .fn(async () => ({ renamed: 0, watching: false }))
      .mockResolvedValueOnce({ renamed: 1, watching: true });
    const { waits, sleep, settle, advance } = clock();
    const stop = startNameReconciler(
      { reconcileNames },
      { sleep, isVisible: () => true, hotMs: 30, coldMs: 300 }
    );
    await settle();    // 第一轮：watching → 30
    await advance();   // 第二轮：不 watching → 300
    expect(waits.slice(0, 2)).toEqual([30, 300]);
    stop();
  });

  it("页面在后台时这一轮不打接口（别白耗电）", async () => {
    const reconcileNames = vi.fn(async () => ({ renamed: 0, watching: true }));
    const { waits, sleep, settle, advance } = clock();
    let vis = false;
    const stop = startNameReconciler(
      { reconcileNames },
      { sleep, isVisible: () => vis, hotMs: 30, coldMs: 300 }
    );
    await settle();
    expect(reconcileNames).not.toHaveBeenCalled();
    expect(waits[0]).toBe(300);
    vis = true;                      // 切回前台
    await advance();
    expect(reconcileNames).toHaveBeenCalledTimes(1);
    stop();
  });

  it("🔴 reconcileNames 抛了也不许把循环带走（停了就再也不会自己起来）", async () => {
    const reconcileNames = vi
      .fn(async () => ({ renamed: 0, watching: false }))
      .mockRejectedValueOnce(new Error("boom"));
    const { sleep, settle, advance } = clock();
    const stop = startNameReconciler({ reconcileNames }, { sleep, isVisible: () => true });
    await settle();    // 第一轮抛
    await advance();   // 循环还得继续
    expect(reconcileNames).toHaveBeenCalledTimes(2);
    stop();
  });

  it("stop 之后不再跑", async () => {
    const reconcileNames = vi.fn(async () => ({ renamed: 0, watching: true }));
    const { sleep, settle, advance } = clock();
    const stop = startNameReconciler({ reconcileNames }, { sleep, isVisible: () => true });
    await settle();
    expect(reconcileNames).toHaveBeenCalledTimes(1);
    stop();
    await advance();
    expect(reconcileNames).toHaveBeenCalledTimes(1);
  });
});
