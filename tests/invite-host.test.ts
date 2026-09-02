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
import { mintBotInHost, InviteApi } from "../src/api/invite";

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
