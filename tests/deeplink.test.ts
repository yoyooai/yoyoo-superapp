/**
 * 深链解析测试。
 *
 * 这条链路最容易出的错不是"解析写错了"，而是**参数根本不在我以为的地方** ——
 * history 路由在 search 里，hash 路由在 hash 里。所以这里两种都钉住。
 * 断了这条，卡片上的「打开」按钮就只能把人扔到列表页，
 * "说一句 → 造应用 → 点开"最后一步无声失效（界面不报任何错）。
 */
import { describe, it, expect } from "vitest";
import { parseDeepLinkAppId, DEEPLINK_PARAM, DEEPLINK_BUILD_MARK } from "../src/shell/deeplink";

describe("深链解析", () => {
  it("history 路由：从 search 里取", () => {
    expect(parseDeepLinkAppId("?app=abc-123", "")).toBe("abc-123");
  });

  it("hash 路由：从 hash 的问号后面取", () => {
    expect(parseDeepLinkAppId("", "#/superapp?app=abc-123")).toBe("abc-123");
  });

  it("两边都有时以 search 为准", () => {
    expect(parseDeepLinkAppId("?app=win", "#/superapp?app=lose")).toBe("win");
  });

  it("没有参数就返回 null（不能瞎猜一个 id 去请求）", () => {
    expect(parseDeepLinkAppId("", "")).toBeNull();
    expect(parseDeepLinkAppId("?other=1", "#/superapp")).toBeNull();
    expect(parseDeepLinkAppId("?app=", "")).toBeNull();
  });

  it("和别的参数混在一起也能取到", () => {
    expect(parseDeepLinkAppId("?sid=xyz&app=abc&t=1", "")).toBe("abc");
  });

  it("URL 编码的 id 能还原", () => {
    expect(parseDeepLinkAppId("?app=a%20b", "")).toBe("a b");
  });

  it("参数名和构建标记是常量（ship-web.sh 依赖它们，改名要两边一起改）", () => {
    expect(DEEPLINK_PARAM).toBe("app");
    expect(DEEPLINK_BUILD_MARK).toBe("yoyoo-deeplink/v1");
  });
});
