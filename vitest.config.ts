import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // `server/` 是纯 Node 后端，测试用 node:test 写的（零依赖是刻意的取舍，
    // 见 server/index.mjs 顶部）。让 vitest 去收它只会报 "No test suite found"。
    // 它们由 `npm run test:server` 跑，`npm test` 会把两边都跑一遍 ——
    // 排除在这里，不等于不跑。
    exclude: ["server/**", "node_modules/**", "dist/**"],
  },
});
