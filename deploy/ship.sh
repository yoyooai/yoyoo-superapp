#!/usr/bin/env bash
#
# 发布 yoyoo-superapp 后端到测试机。**只走这个脚本，不许手敲 docker run。**
#
# 为什么（和 yoyoo-im 同一条规矩）：手敲的那次 docker run 参数只存在于当时那个
# 终端里。半年后没人知道容器为什么带着某个 env 跑，也没人敢重建它。
# 脚本在仓里，参数就有正本。
#
# 铁线：
#   · 本地测试不全绿就不发（红着发出去等于把红搬到线上）
#   · 只动测试机（脚本里断言目标不是生产）
#   · 代码是 ro 绑定挂载，容器里改不动；改代码=重发
#
# 用法：
#   ./deploy/ship.sh                 # 发布（跑测试 → 同步 → 重建容器 → 冒烟）
#   ./deploy/ship.sh --skip-tests    # 只在刚跑过测试时用
#   ./deploy/ship.sh --check         # 什么都不改，只查线上现状
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${YOYOO_SUPERAPP_HOST:-ubuntu@106.55.27.219}"
REMOTE_DIR="/home/ubuntu/yoyoo-superapp"
CONTAINER="yoyoo-superapp"
NETWORK="octo_octo-net"
IMAGE="node:22-alpine"

# 🔴 生产禁飞：这台机器上没有生产，但脚本不能依赖"我记得"。
case "$HOST" in
  *43.128.54.215*|*106.52.235.115*|*app.yoyooai.com*|*dist.yoyooai.com*)
    echo "❌ 目标机是生产/客户机，拒绝发布：$HOST" >&2; exit 2;;
esac

SKIP_TESTS=0; CHECK_ONLY=0
for a in "$@"; do
  case "$a" in
    --skip-tests) SKIP_TESTS=1;;
    --check) CHECK_ONLY=1;;
    *) echo "未知参数：$a" >&2; exit 2;;
  esac
done

fail=0
step() { printf '\n\033[1m── %s\033[0m\n' "$1"; }
ok()   { printf '   ✅ %s\n' "$1"; }
bad()  { printf '   ❌ %s\n' "$1"; fail=1; }

# 公开地址：卡片按钮里的深链要用它。
# ⚠️ 现在是 Cloudflare 临时隧道域名，**重启隧道就会变**，变了以后老卡片里的
#    链接就点不开了。这是已知的、等固定服务器/域名到位才能真解决的问题
#    （SPEC-phase2 §B.4 备注）。不装作它不存在。
PUBLIC_URL="${OCTO_PUBLIC_URL:-}"
if [ -z "$PUBLIC_URL" ] && [ -f "$HOME/zylos/.env" ]; then
  PUBLIC_URL="$(grep -E '^OCTO_API_URL=' "$HOME/zylos/.env" | head -1 | cut -d= -f2-)"
fi
SPACE_ID="${OCTO_SPACE_ID:-}"
if [ -z "$SPACE_ID" ] && [ -f "$HOME/zylos/.env" ]; then
  SPACE_ID="$(grep -E '^OCTO_SPACE_ID=' "$HOME/zylos/.env" | head -1 | cut -d= -f2-)"
fi
# 🔴 09-03 真撞过一次：小A 的 bot 账号被删过、用邀请函重新兑换后 robot_id 变了
#    （旧号 xiaoa_bot → 新号），而这里以前是硬编码旧号当默认值，导致发布"成功"
#    但线上 /apps/for 全部 403 bot not allowed——发布脚本自己的冒烟只测未登录 401，
#    测不出"白名单里的号是错的"这种错。现在改成：没显式传 YOYOO_BOT_ALLOWLIST 时，
#    现查 `.env` 里那把 token 对应的**当前真实 robot_id**，而不是记一个写死的旧值。
BOT_ALLOWLIST="${YOYOO_BOT_ALLOWLIST:-}"
if [ -z "$BOT_ALLOWLIST" ] && [ -f "$HOME/zylos/.env" ]; then
  BOT_TOKEN_FOR_LOOKUP="$(grep -E '^OCTO_BOT_TOKEN=' "$HOME/zylos/.env" | head -1 | cut -d= -f2-)"
  if [ -n "$BOT_TOKEN_FOR_LOOKUP" ] && [ -n "$PUBLIC_URL" ]; then
    BOT_ALLOWLIST="$(curl -s -m 10 -X POST -H "authorization: Bearer $BOT_TOKEN_FOR_LOOKUP" \
      "$PUBLIC_URL/v1/bot/register" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("robot_id",""))' 2>/dev/null)"
  fi
fi
if [ -z "$BOT_ALLOWLIST" ]; then
  echo "❌ 现查不到当前 bot 的 robot_id（.env 里的 OCTO_BOT_TOKEN 失效，或宿主连不上），拒绝用一个可能过期的默认值发布。" >&2
  echo "   手动指定：YOYOO_BOT_ALLOWLIST=<robot_id> ./deploy/ship.sh" >&2
  exit 1
fi

# 自签证书阶段（域名/正式证书还没到位时）冒烟要加 -k，否则每一项都栽在 TLS 校验上，
# 看起来像"服务坏了"，其实是"证书还没换"。**只在显式打开时才放松校验。**
CURL_K=""
[ "${OCTO_CURL_INSECURE:-0}" = "1" ] && CURL_K="-k"

if [ "$CHECK_ONLY" -eq 1 ]; then
  step "线上现状"
  ssh -o StrictHostKeyChecking=no "$HOST" \
    "docker inspect $CONTAINER --format 'status={{.State.Status}} started={{.State.StartedAt}}' 2>/dev/null || echo '容器不存在'"
  ssh -o StrictHostKeyChecking=no "$HOST" \
    "docker exec $CONTAINER sh -c 'ls -l /app' 2>/dev/null || true"
  curl -s $CURL_K -m 10 "$PUBLIC_URL/yoyoo/v1/health" && echo
  exit 0
fi

if [ "$SKIP_TESTS" -eq 0 ]; then
  step "1/5 本地测试（不全绿就不发）"
  if (cd "$HERE" && npm test >/tmp/yoyoo-superapp-test.log 2>&1); then
    ok "全绿（前端 + 结构 + 后端冒烟）"
  else
    bad "测试未全绿，拒绝发布。详情：/tmp/yoyoo-superapp-test.log"
    tail -20 /tmp/yoyoo-superapp-test.log
    exit 1
  fi
else
  step "1/5 本地测试（--skip-tests，跳过）"
fi

step "2/6 同步后端代码"
# 🔴 **同步 server/ 下所有运行时模块，不许在这里写死文件名清单。**
#    写死过一次就够了：市场那一批新增了 market.mjs / secrets.mjs / http-util.mjs，
#    清单没跟着改的话，线上 index.mjs 会 import 一个不存在的文件 —— 容器起不来，
#    而且症状是"服务突然全挂"，跟这次改动看起来毫无关系。
#    `server/structure.test.mjs` 有一条测试钉着"不许出现写死的 .mjs 清单"。
# 排除测试/冒烟：**认 test 和 smoke 这两个词本身**，不要求它们前面是个点 ——
# 第一版写的是 `\.(test|smoke)\.mjs$`，`market-smoke.mjs` 用的是连字符，
# 于是一个测试文件被发到了线上（无害，但生产目录里不该有）。
RUNTIME_FILES=$(ls "$HERE"/server/*.mjs | grep -vE '(test|smoke)\.mjs$')
echo "   要发的模块：$(echo "$RUNTIME_FILES" | xargs -n1 basename | tr '\n' ' ')"
if scp -q -o StrictHostKeyChecking=no $RUNTIME_FILES "$HOST:$REMOTE_DIR/app/"; then
  ok "$(echo "$RUNTIME_FILES" | wc -l) 个运行时模块已上传"
else
  bad "上传失败"; exit 1
fi

# 说明书跟 .mjs 一样摊平发到 /app/ 下（不带 docs/ 那层目录），容器里用 MANUAL_PATH
# 指到这个摊平后的位置（见 index.mjs 里那条注释——本地和线上目录结构不一样，
# 09-03 因为没摊平这个文件撞出过一次 /manual 500）。
if scp -q -o StrictHostKeyChecking=no "$HERE/docs/AI-MANUAL.md" "$HOST:$REMOTE_DIR/app/AI-MANUAL.md"; then
  ok "说明书已上传"
else
  bad "说明书上传失败"; exit 1
fi

step "3/6 备份线上库（改表之前）"
# 市场那一批要给 apps 加两列、建四张表。ALTER/CREATE 都是幂等的，
# 但"幂等"不等于"出事能回去"—— 库里有他真造的应用，动表之前先留一份。
ssh -o StrictHostKeyChecking=no "$HOST" bash -s <<EOF
set -e
if [ -f $REMOTE_DIR/data/yoyoo-superapp.db ]; then
  mkdir -p $REMOTE_DIR/data/backups
  cp -a $REMOTE_DIR/data/yoyoo-superapp.db \
     $REMOTE_DIR/data/backups/yoyoo-superapp-\$(date +%Y%m%d-%H%M%S).db
  ls -1 $REMOTE_DIR/data/backups | tail -1
else
  echo "（还没有库文件，首次部署）"
fi
EOF
[ $? -eq 0 ] && ok "库已备份到 data/backups/" || bad "备份失败 —— 不继续动表"
[ "$fail" -eq 1 ] && exit 1

step "4/6 写 env 正本（不含任何密钥；LLM 密钥在 llm.env，本脚本不碰）"
ssh -o StrictHostKeyChecking=no "$HOST" "cat > $REMOTE_DIR/app.env" <<EOF
# 由 yoyoo-superapp/deploy/ship.sh 生成，勿手改（手改会在下次发布时被覆盖）
HOST_VERIFY_URL=http://octo-server:8090/v1/user/current
HOST_BOT_API_URL=http://octo-server:8090
OCTO_SPACE_ID=$SPACE_ID
YOYOO_BOT_ALLOWLIST=$BOT_ALLOWLIST
APP_DEEP_LINK=$PUBLIC_URL/superapp?app={id}
# 邀请 AI：这两个地址会被写进**发给外部 AI 的邀请函**，所以必须是公网可达的
# 正式地址，不能是容器内主机名（octo-server:8090 那种对方根本连不上）。
INVITE_API_BASE=$PUBLIC_URL/yoyoo/v1
INVITE_HOST_API_URL=$PUBLIC_URL
# 说明书文件跟 .mjs 一起摊平发在 /app/ 下，不是嵌套的 docs/ 子目录，见上面的说明。
MANUAL_PATH=/app/AI-MANUAL.md
EOF
ok "app.env 已写（space=$SPACE_ID allow=$BOT_ALLOWLIST）"

step "5/6 重建容器"
ssh -o StrictHostKeyChecking=no "$HOST" bash -s <<EOF
set -e
docker rm -f $CONTAINER >/dev/null 2>&1 || true
docker run -d --name $CONTAINER \
  --restart unless-stopped \
  --network $NETWORK \
  --env-file $REMOTE_DIR/llm.env \
  --env-file $REMOTE_DIR/app.env \
  -e PORT=8790 \
  -e DB_PATH=/data/yoyoo-superapp.db \
  -v $REMOTE_DIR/app:/app:ro \
  -v $REMOTE_DIR/data:/data \
  $IMAGE node /app/index.mjs >/dev/null
sleep 2
docker inspect $CONTAINER --format 'status={{.State.Status}}'
EOF
[ $? -eq 0 ] && ok "容器已重建" || bad "重建失败"

step "6/6 线上冒烟（只读 + 否定用例，不造任何东西）"
h=$(curl -s $CURL_K -m 10 "$PUBLIC_URL/yoyoo/v1/health")
echo "$h" | grep -q '"ok":true' && ok "健康检查通过" || bad "健康检查失败：$h"

# 🔴 09-03 真出过事：这个位置以前不存在——说明书 docs/ 没摊平发布，线上 500，
#    但没有任何一条冒烟查它，发布"全绿"照样通过。现在补上。
manual_code=$(curl -s $CURL_K -m 10 -o /dev/null -w '%{http_code}' "$PUBLIC_URL/yoyoo/v1/manual")
[ "$manual_code" = "200" ] && ok "/manual → 200" || bad "/manual 返回 $manual_code（应为 200，检查 AI-MANUAL.md 是否摊平发布、MANUAL_PATH 是否配对）"

code=$(curl -s $CURL_K -m 10 -o /dev/null -w '%{http_code}' -X POST \
  -H 'content-type: application/json' -d '{"owner_uid":"u_x","blueprint":{"type":"page","children":[{"type":"text","value":"x"}]}}' \
  "$PUBLIC_URL/yoyoo/v1/apps/for")
[ "$code" = "401" ] && ok "/apps/for 无 token → 401" || bad "/apps/for 无 token 返回 $code（应为 401）"

# 连接器（09-03 新增）：只验"门关着"，不在生产环境造真连接器（没有安全的公开外部
# 目标可供验证代理调用，造了也只是一条测试脏数据，不像 apps/for 那样删得干净）。
conn_code=$(curl -s $CURL_K -m 10 -o /dev/null -w '%{http_code}' -X POST \
  -H 'content-type: application/json' -d '{"owner_uid":"u_x","name":"x","base_url":"https://example.com","auth_type":"none"}' \
  "$PUBLIC_URL/yoyoo/v1/connectors/for")
[ "$conn_code" = "401" ] && ok "/connectors/for 无 token → 401" || bad "/connectors/for 无 token 返回 $conn_code（应为 401）"

# 🔴 09-03 真出过事：白名单里的 robot_id 是旧号，之前的冒烟只测"坏 token → 401"，
#    从没真正用一把**当前有效**的 bot token 走一遍，所以"bot not allowed"这种
#    配置错误从没被这一步拦下过。现在用现查到的 BOT_ALLOWLIST 对应的真 token
#    （就是刚才现查用的那把）造一个、马上删掉，验的是"白名单配置真的对得上"。
if [ -n "$BOT_TOKEN_FOR_LOOKUP" ]; then
  real_owner="$(grep -E '^OCTO_OWNER_UID=' "$HOME/zylos/.env" | head -1 | cut -d= -f2-)"
  if [ -n "$real_owner" ]; then
    live=$(curl -s $CURL_K -m 10 -X POST \
      -H "authorization: Bearer $BOT_TOKEN_FOR_LOOKUP" -H 'content-type: application/json' \
      -d "{\"owner_uid\":\"$real_owner\",\"name\":\"[部署冒烟-可删]\",\"blueprint\":{\"type\":\"page\",\"children\":[{\"type\":\"text\",\"value\":\"ship.sh smoke\"}]}}" \
      "$PUBLIC_URL/yoyoo/v1/apps/for")
    live_id=$(echo "$live" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("id",""))' 2>/dev/null)
    if [ -n "$live_id" ]; then
      ok "白名单真的对得上：用当前 bot token 真造了一个应用（id=$live_id）"
      curl -s $CURL_K -m 10 -X DELETE \
        -H "authorization: Bearer $BOT_TOKEN_FOR_LOOKUP" \
        "$PUBLIC_URL/yoyoo/v1/apps/for/$live_id?owner_uid=$real_owner" >/dev/null
      echo "      （已删除，不留痕迹）"
    else
      bad "当前 bot token 造应用失败：$live（白名单/owner_uid 配置可能没对上，检查 YOYOO_BOT_ALLOWLIST）"
    fi
  else
    echo "   ⚠️ .env 没有 OCTO_OWNER_UID，跳过这一条真实身份验证"
  fi
fi

# 邀请：两个否定用例。都不造任何东西 —— 一条没登录，一条拿的是假票号。
code=$(curl -s $CURL_K -m 10 -o /dev/null -w '%{http_code}' -X POST \
  -H 'content-type: application/json' -d '{"require_approval":true}' \
  "$PUBLIC_URL/yoyoo/v1/invites")
[ "$code" = "401" ] && ok "出票无 token → 401" || bad "出票无 token 返回 $code（应为 401）"

code=$(curl -s $CURL_K -m 10 -o /dev/null -w '%{http_code}' -X POST \
  -H 'content-type: application/json' -d '{"code":"yi_smoke_not_a_real_ticket","name":"smoke"}' \
  "$PUBLIC_URL/yoyoo/v1/invites/redeem")
# 404 = 兑换口通了、且假票号换不到东西（它刻意不区分"票不存在"和"票已作废"）
[ "$code" = "404" ] && ok "假票号兑换 → 404（兑换口不要求登录，符合设计）" \
  || bad "假票号兑换返回 $code（应为 404）"

code=$(curl -s $CURL_K -m 10 -o /dev/null -w '%{http_code}' -X POST \
  -H 'authorization: Bearer bf_definitely_wrong' -H 'content-type: application/json' \
  -d '{"owner_uid":"u_x","blueprint":{"type":"page","children":[{"type":"text","value":"x"}]}}' \
  "$PUBLIC_URL/yoyoo/v1/apps/for")
[ "$code" = "401" ] && ok "/apps/for 坏 token → 401" || bad "/apps/for 坏 token 返回 $code（应为 401）"

# 市场：路由真的挂上了，而且未登录一律拒。
# 🔴 只验 401 —— 这一步不许造任何东西（线上库里是他真造的应用）。
for p in "/market/listings" "/pins"; do
  code=$(curl -s $CURL_K -m 10 -o /dev/null -w '%{http_code}' "$PUBLIC_URL/yoyoo/v1$p")
  [ "$code" = "401" ] && ok "$p 未登录 → 401（路由已挂上）" \
    || bad "$p 返回 $code（应为 401；404 表示这一版没发上去）"
done

printf '\n'
if [ "$fail" -eq 0 ]; then
  printf '\033[32m发布完成。\033[0m\n'
else
  printf '\033[31m发布过程中有检查未通过 —— 上面标 ❌ 的都要处理。\033[0m\n'
fi
exit "$fail"
