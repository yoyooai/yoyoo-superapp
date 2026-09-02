# AI 说明书机制 + AI 造/改/管应用与卡片 —— 设计（2026-09-03，苏白已拍板「开始开发」）

**由来**：苏白看通讯录截图发现小A 自报身份时说错了平台名字（说成"OCTO"，应为"Yoyoo"），
由此要求建立一套**说明书机制**——任何 AI 进来第一时间就知道平台叫什么、能做什么、怎么用，
且以后加新功能能持续更新，而不是每次都靠人临时口头转告。同时明确「AI 怎么处理卡片和应用」
是接下来重点开发的部分，要求把缺口列清楚、出 SPEC、列今晚清单、然后直接开工。

**读码得出的一个关键新事实**（之前的审计说漏了，这次写 SPEC 时才查出来）：
现在 `yoyoo-superapp` 的所有"改/发布/浏览/安装/回退/下架"接口**全部要求宿主用户 token**
（`whoami()` 那条鉴权路径），**bot token 完全走不通这些接口**——bot 面目前只有一条口子
`POST /apps/for`（造一个新应用）。也就是说，AI 在对话里现在不仅"改不了已有应用"，
**连"发布到市场""浏览市场""帮用户装一个别人的应用"这些都做不到**，因为这些接口对 bot
关着门。这比上一轮审计说的"编辑没打通"范围更大，一并写进这次的施工范围。

---

## 一、说明书机制

### 1.1 设计

**唯一真源**：`workspace/yoyoo-superapp/docs/AI-MANUAL.md`（人写、人改，纯 Markdown，带版本号）。
**对外只有一个入口**：`GET /yoyoo/v1/manual`（公开，无需任何 token，返回该文件原文 + 一个
`Content-Type: text/markdown`）。

理由：
- **单一真源，不许在两个地方各写一份**——邀请函、connectInfo、future 的其它入口，全部只放
  这一个 URL 的指针，不复制正文。改一处，所有拿到邀请函的 AI 看到的都是新版本。
- **不区分 AI 种类**：DSH／YOS／openclaw 以后接进来，走的是同一条 `GET /manual`，不需要
  为每种 AI 各写一份"专属说明书"（铁线4：不写死成小A 专用）。
- 版本号放文件头一行 `<!-- manual-version: N -->`，每次改动手动 +1；`GET /manual` 响应头
  带 `X-Manual-Version`，方便 AI 判断"我上次读的是不是最新版"而不必每次整篇比对。

### 1.2 内容大纲（写给"一个从没见过这个系统的 AI"，不是写给人看的）

1. 平台是什么：人和 AI 共用的 IM，AI 是成员不是插件；本名 **Yoyoo**（域名 `yoyoo.cosark.com.cn`，
   界面壳借自开源项目 OCTO，但**对外一律只说 Yoyoo，不要说 OCTO**——这句是本次事故的直接修复）。
2. 你能做什么：对话、收发文件/图片、发卡片、卡片被点后收到回调、改已发出的卡片、
   造一个超级应用、（今晚做完后）改一个已有应用、把应用发布到市场、浏览市场、装别人的应用。
3. 怎么对话：`POST /v1/bot/events` long-poll 收消息，`POST /v1/bot/sendMessage` 回；
   `POST /v1/bot/typing` 输入中提示；被 @ 才说话是默认礼貌，别刷屏。
4. 怎么发卡片/处理回调/改卡片：`sendMessage` 带 `card` 字段发，点击回调作为一条新事件收到，
   `POST /v1/bot/message/edit` 原地改。卡片能力可能未开（探测 `GET /v1/bot/card/profile`）。
5. 怎么造/改/管应用：`POST /yoyoo/v1/apps/for`（造）、`POST /yoyoo/v1/apps/for/:id`（改，
   今晚新增）、`POST /yoyoo/v1/apps/for/:id/publish`（发布到市场，今晚新增）、
   `GET /yoyoo/v1/apps/for/market`（浏览，今晚新增）、`POST /yoyoo/v1/apps/for/market/:listingId/install`
   （帮用户装一个别人的应用，今晚新增）。全部用 `Authorization: Bearer <bot_token>` +
   `owner_uid`，语义与 `/apps/for` 一致：**AI 代表某个人操作，操作记录如实标注 created_by=ai**。
6. 怎么跟着这份说明书更新：每次长期对话开始时，或者拿不准某个接口还在不在，打一次
   `GET /yoyoo/v1/manual` 看 `X-Manual-Version` 有没有变。

### 1.3 邀请函与 connectInfo 的改动

- `letter()` 开头加一句加粗：**"这个平台的名字是 Yoyoo，请始终称呼它 Yoyoo，不要说 OCTO"**
  （OCTO 只是界面壳的开源出处，对外不用这个名字）。
- `letter()` 里加一行：**"完整使用说明书：`GET {base}/manual`，进来后先读一遍"**。
- `connectInfo()`（redeem 成功后的返回体）加一个字段 `manual_url`，程序化可读，不用 AI 去解析
  文本才找得到。

---

## 二、AI 如何处理卡片——现状复核，本轮不新增（卡片本身已经做完三件套）

发/回调/改，三件套已经打通且真机验证过（见 `octo-connector/src/card.mjs`、
`decisions.md`／`projects.md` 09-02 各条），**这次不重做**。本轮唯一要动的是"卡片能不能像应用
一样被存成模板分享/安装"——见下一节 §4，本轮先设计不施工（工作量与应用市场相当，今晚
优先级排在应用之后）。

---

## 三、AI 如何处理应用——今晚要打通的三个 bot 面接口

### 3.1 编辑已有应用：`POST /yoyoo/v1/apps/for/:id`

- 复用 `botAuth.verify()` 同一套（token → robotId+ownerUid，同 `/apps/for`）。
- 校验：该应用必须属于 `auth.ownerUid`（不能改别人的号下的应用）。
- body：`{blueprint?, name?, icon?}`，走 `normalizeForStore` 同一判据（与人手工改用的
  `PUT /apps/:id` 共用 `blueprint.mjs`，不出第二份判据）。
- 与人的 `PUT` 路径行为对齐：局部更新，不给的字段不动。

### 3.2 发布到市场：`POST /yoyoo/v1/apps/for/:id/publish`

- body：`{summary}`，逻辑照抄 `market.mjs` 里人手工发布那条（快照、敏感内容扫描门、限流），
  差别只是身份来源换成 `auth.ownerUid`。
- 🔴 敏感内容扫描命中时**不能像人手工那样弹窗等确认**——AI 面直接返回 409 + 命中详情，
  由 AI 自己决定是否要去掉那部分内容再发一次，不做"AI 自动确认发布"这种事。

### 3.3 浏览市场 + 安装：`GET /yoyoo/v1/apps/for/market` ／ `POST /yoyoo/v1/apps/for/market/:listingId/install`

- 浏览：只读，直接复用 `market.mjs` 的 `browseSql`/`q.browse*`，`uid` 换成 `auth.ownerUid`。
- 安装：复用市场安装逻辑（幂等、复制到 `auth.ownerUid` 名下）。
- **不在 bot 面开放** `sync`/`revert`/`delist`/发新版本——这几个动作影响面更大（回退历史、
  下架影响别人），本轮先只做「改、发布、浏览、装」四件，其余留人从界面操作。

### 3.4 验收标准（150 分线：真机测试 + 反向验证）

- 每个新接口至少一条正例 + 一条越权反例（改别人的应用应 403、发布敏感内容应 409 等）。
- `verify-all.sh` 或专门的 `verify-ai-authoring.sh` 补新验收项，全绿；故意改坏一处（比如漏
  校验 ownerUid）确认能报红，再改回来。
- 用真的 bot token（小A 自己那把）跑一遍完整链路：造→改→发布→（换一个身份或直接用同一个
  账号模拟）浏览→装，全部走真请求，不是单元测试模拟。

---

## 四、卡片市场（设计，本轮不施工）

对齐应用市场同一套语义（listing/version/install/revert/delist），但卡片的"内容"是一份
Adaptive Card JSON 而不是应用蓝图。工作量与 §3 相当，**排在应用市场稳定之后**，作为下一轮
清单的第一项，不在今晚范围内，如实告知苏白。

---

## 五、品牌查漏补缺（并行推进，独立于上面两块）

**待查**（本 SPEC 写完后立刻去查，查完直接改，不等汇报）：
1. `BotFather`／`系统账号`／`文件传输助手`／`通知助手` 这几个默认联系人的显示名——
   有没有后台改名接口；没有就如实标注"宿主写死，改不了"。
2. 头像——查 bot 自己的 profile 有没有"设置头像"接口（`PUT /v1/bot/profile` 之类，
   需要读码而非猜测）；有就在 redeem 成功后自动传我方 logo。系统级账号（非 bot）的头像
   若无开放接口，同样如实标注为宿主限制。

---

## 六、今晚清单（按优先级，做完一项验一项，不留半成品）

1. ✅【设计】本 SPEC 完成。
2. 【说明书】写 `docs/AI-MANUAL.md` v1 + `GET /yoyoo/v1/manual` 路由 + 更新 `letter()`/`connectInfo()`。
3. 【应用-编辑】`POST /apps/for/:id`，真机验证（改自己的成功／改别人的 403）。
4. 【应用-发布】`POST /apps/for/:id/publish`，真机验证（正常发布／敏感内容 409）。
5. 【应用-市场】`GET /apps/for/market` + `POST /apps/for/market/:id/install`，真机验证。
6. 【品牌】BotFather/系统账号改名与头像接口的可行性核查，能改的当场改掉。
7. 【收尾】把 2~6 的真机验证记录写回 `projects.md`，`tech-debt.md` 记下未做的（卡片市场、
   sync/revert/delist 的 bot 面）留给下一轮。

**不做的**（明确排除，避免有人以为漏了）：代言(OBO)相关改动、群/子区管理两把刀、TD-301
真bug修复——这三项都在等苏白拍板，不属于本轮范围。
