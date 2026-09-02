/**
 * 发布前的私货扫描 —— SPEC-market §5.2。
 *
 * 为什么这道门跟发布接口**同时**上，而不是按施工顺序排到第 6 步：
 * 发布是这套东西里唯一**不可逆**的动作 —— 从"只有我能看"变成"全 Space 能看"。
 * 先上一个没有扫描的发布接口，等于给自己开一个窗口期，在那个窗口里任何人
 * （包括我替他造的应用）都可能把 token、手机号、内网地址一次性公开出去。
 * 不可逆动作的防护不排期，跟着动作本身走。
 *
 * 三条刻意的设计取舍：
 *  1. **只拦不改**。命中就返回 409 + 命中清单，让作者自己决定（改掉重发，
 *     或者显式 `confirm_sensitive: true` 说"我知道，就是要发"）。
 *     静默删改比漏报更糟 —— 用户会以为自己发出去的是原样。
 *  2. **报"命中了什么类型 + 遮盖后的片段"，不回显完整值**。扫描结果本身会进日志和
 *     响应体，把密钥原文抄进去就是自己又泄一遍。
 *  3. **宁可误报**。误报的代价是作者多点一次确认；漏报的代价是不可逆的公开。
 */

/** 遮盖：留头留尾，中间打码。短串直接全打码。 */
function mask(s) {
  const t = String(s);
  if (t.length <= 8) return "*".repeat(t.length);
  return `${t.slice(0, 4)}${"*".repeat(Math.min(t.length - 8, 12))}${t.slice(-4)}`;
}

/**
 * 规则表。每条：{ id, label, re }
 * 🔴 加规则只能往这里加 —— 别在调用点写第二处判断。
 */
const RULES = [
  { id: "openai_key", label: "疑似 API 密钥（sk- 开头）", re: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { id: "github_token", label: "疑似 GitHub 令牌", re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  { id: "aws_key", label: "疑似 AWS Access Key", re: /\bAKIA[0-9A-Z]{12,}/g },
  { id: "bearer", label: "请求头里的 Bearer 令牌", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi },
  // `eyJ` 是 `{"` 的 base64 —— 这个前缀本身就极少误撞，所以各段长度门槛可以放低，
  // 让短头部的 JWT 也命中（宁可误报，不许漏报）。
  { id: "jwt", label: "疑似 JWT", re: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g },
  { id: "private_key", label: "私钥文件内容", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  {
    id: "assigned_secret",
    label: "写成 key=value 的口令/密钥",
    re: /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|token)\s*[:=]\s*["']?[^\s"',;}]{8,}/gi,
  },
  { id: "cn_mobile", label: "疑似中国大陆手机号", re: /(?<!\d)1[3-9]\d{9}(?!\d)/g },
  {
    id: "private_ip",
    label: "内网地址",
    re: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|127\.0\.0\.1|localhost)\b/gi,
  },
  { id: "internal_host", label: "内部域名（.local / .internal / .lan）", re: /\b[a-z0-9-]+\.(?:local|internal|lan)\b/gi },
];

/**
 * 扫一份蓝图（或任意结构）。
 * 返回 { clean: boolean, hits: [{ id, label, count, samples: [遮盖后的片段] }] }
 */
export function scanForSecrets(value) {
  // 蓝图是纯数据（字符串/数组/对象），序列化后扫是最不容易漏的做法：
  // 逐字段递归的写法每加一个新字段就多一个漏点。
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const hits = [];
  for (const rule of RULES) {
    const found = text.match(rule.re);
    if (!found || found.length === 0) continue;
    hits.push({
      id: rule.id,
      label: rule.label,
      count: found.length,
      samples: [...new Set(found)].slice(0, 3).map(mask),
    });
  }
  return { clean: hits.length === 0, hits };
}

/** 规则条数，给结构测试用（防止有人把规则表清空却让测试照样绿） */
export const SECRET_RULE_COUNT = RULES.length;
