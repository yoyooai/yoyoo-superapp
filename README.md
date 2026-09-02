# @yoyoo/superapp-module

Yoyoo 超级应用 —— **AI 造出来的东西住在这里，而且下次还能打开。**

挂在宿主 IM 的插槽上，但**不属于任何宿主**：除了一层薄适配，整个包可以原样搬到别的壳里。

## 这个包解决什么

主流 IM（包括我们参照的 OCTO）都停在同一条线前：AI 能在对话里画卡片，
但**画出来的东西没有独立入口、没有状态、关掉就没了**。
这个包补的就是那一段 —— 一句话生成一个应用，它有名字、有入口、有归属，
下次打开还在。

## 目录

```
src/
├─ host/          ← 唯一知道"我被挂在谁身上"的地方
│   ├─ types.ts     HostAdapter 契约（中立，不含任何宿主依赖）
│   └─ octo.tsx     OCTO 实现 ← 换壳时只需再写一个同级文件
├─ shell/         应用列表 / 详情
├─ runtime/       Blueprint 渲染器（JSON → 界面）
├─ api/           连我们自己的后端
└─ index.tsx      宿主插槽入口（registerEnterpriseModules 等三个导出）
server/
├─ index.mjs      后端（零第三方依赖：node:http + node:sqlite）
├─ generate.mjs   一句话 → blueprint（可降级：没模型密钥就本地生成）
└─ smoke.mjs      冒烟测试（真起进程、真落盘、真重启）
```

## 🔴 一条铁线

> **除了 `src/host/`，全包不许 import `@octo/*`。**

由 `tests/no-host-leak.test.ts` 机器守护，不是口头约定。
这条线在，换壳就是"写一个新的 host/xxx.tsx"；这条线破了，就得考古。

需要新的宿主能力时：加进 `host/types.ts` 的 `HostAdapter`，
由各宿主实现 —— **不要**直接在业务代码里伸手去够宿主。

## 开发

```bash
pnpm install
pnpm test          # 单测（宿主隔离 + 渲染器健壮性 + 布局守卫）
pnpm typecheck
node server/smoke.mjs   # 后端冒烟，含"重启后应用还在"
```

### 发布前用眼睛看一遍（`.preview/`）

界面改动**不许只靠测试放行** —— 测试能证明"结构对"，证明不了"看着对"。
`.preview/` 是一个离线预览：真组件 + 真样式，数据用假 fetch 喂，不连任何服务器、
不碰线上库、不需要登录别人的账号。

```bash
npx vite build .preview --outDir ../.preview-dist --emptyOutDir --base=./
cd .preview-dist && python3 -m http.server 8899   # 用浏览器/无头截图看
```

（`.preview-dist/` 是产物，看完删掉即可。）

## 后端

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 8790 | 监听端口 |
| `DB_PATH` | `./data/yoyoo-superapp.db` | SQLite 文件 |
| `HOST_VERIFY_URL` | `http://octo-server:8090/v1/user/current` | 拿宿主 token 换身份 |
| `LLM_API_KEY` | 空 | **留空则本地生成**，功能不瘫，只是不聪明 |
| `LLM_BASE_URL` | `https://key.cosark.com.cn/v1` | 模型网关 |
| `LLM_MODEL` | `gpt-5.6-sol` | 模型 |

接口：`GET /yoyoo/v1/health`、`GET|POST /yoyoo/v1/apps`、
`POST /yoyoo/v1/apps/generate`、`GET|PUT|DELETE /yoyoo/v1/apps/:id`

### 三个设计取舍

1. **不签发自己的凭据** —— 拿宿主 token 去问宿主"这是谁"，我方不存任何密码。
   宿主不可达时 fail closed（当未登录），不放行。
2. **零第三方依赖** —— 部署时装依赖是最容易出岔子的一步，索性不装。
3. **`created_by: human | ai` 第一天就做** —— 一旦允许 AI 自主产出可持久化的东西，
   "这是谁造的"就是唯一能让人保持信任的元数据。

### 渲染器为什么必须打不死

blueprint 是 AI 产的，它一定会给出我们没实现的组件、错类型的字段、超深的树。
**整页白屏是最坏结果**，所以：未知类型降级成占位块并报出类型名（我们才知道该补什么），
畸形字段一律安全取值，超过 24 层停止递归。`tests/renderer.test.tsx` 用十几种脏输入压过。

## 换壳要做什么

1. 新写 `src/host/<宿主>.tsx`，实现 `HostAdapter`
2. 换掉 `src/index.tsx` 里的 `createOctoModule` 调用，按新宿主的插件契约导出
3. 后端把 `HOST_VERIFY_URL` 指到新宿主的身份接口

`shell/` `runtime/` `api/` 一行不用改 —— 这是这条铁线换来的东西。
