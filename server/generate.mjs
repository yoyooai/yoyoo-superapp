/**
 * 从一句话生成一个应用（blueprint）。
 *
 * 设计成**可降级**的：
 *   · 配了 `LLM_API_KEY` → 走真模型
 *   · 没配 → 用本地规则生成一个结构合理的应用，并在响应里标 `mode:"local"`
 *
 * 为什么要能降级：一是不擅自动用生产的模型额度（那是苏白的资源决策，不是我的）；
 * 二是没密钥时整条链路仍然能被完整验证 —— **能跑，只是不聪明**，
 * 比"缺个 key 就整块功能瘫掉"强得多。
 *
 * 🔴 无论走哪条路，出口都必须是**我们渲染器认识的 blueprint**。
 *    模型返回的东西一律当不可信输入处理：解析失败、结构不对、组件不认识，
 *    都要能兜住，不能把一坨脏数据塞进库里。
 *
 * 🔴 词汇表与收敛器**不在本文件**，在 `blueprint.mjs`（两条入口共用一份，
 *    理由写在那个文件顶部）。本文件只负责"跟模型说话"这一件事。
 */
import { VOCAB, sanitizeBlueprint } from "./blueprint.mjs";

const SYSTEM_PROMPT = `你是一个界面生成器。用户描述一个需求，你输出一段 JSON 来描述界面。

只能使用这些组件类型：${VOCAB.join(", ")}

结构约定：
- 根节点必须是 {"type":"page","children":[...]}
- heading: {"type":"heading","value":"标题","level":2}
- text:    {"type":"text","value":"一段话"}
- badge:   {"type":"badge","value":"标签"}
- list:    {"type":"list","items":["甲","乙"]}
- table:   {"type":"table","columns":["列1","列2"],"rows":[["a","b"]]}
- card:    {"type":"card","title":"卡片标题","children":[...]}
- button:  {"type":"button","label":"按钮文字"}
- divider: {"type":"divider"}
- script:  {"type":"script","code":"一段 JavaScript"} —— 只有当用户明确要求"接自己的外部系统/
  数据"时才用这个，且必须已经知道一个真实存在的连接器 id（不知道就不要瞎编一个）。
  代码跑在隔离沙盒里，用 Eryuan.connectorCall(connectorId, {method,path,query,body})
  （返回 Promise，resolve 出 {status,body}）去读写外部数据，用 document.getElementById("app")
  拿到根节点自己画东西，不要假设有任何其它全局变量或框架。

要求：
1. 只输出 JSON，不要任何解释、不要 markdown 代码围栏。
2. 内容要具体、像真的能用，不要写"示例1/示例2"这种占位。
3. 语言跟随用户的提问语言。
4. 普通展示类需求（列表/表格/看板这些）不要用 script——用受控组件更安全、更省事，
   script 只留给"必须跑逻辑/接外部数据"这种受控组件做不到的场景。`;

/** 把模型可能的花样（代码围栏、前后废话）剥掉，抠出第一个完整 JSON 对象 */
export function extractJson(raw) {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("{");
  if (start < 0) return null;
  // 从第一个 { 起做括号配对，容忍尾部有多余文字
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** 没有模型时的本地生成：不聪明，但结构永远是对的 */
export function localGenerate(prompt) {
  const p = String(prompt || "").trim().slice(0, 200) || "我的应用";
  const wantsTable = /表|清单|列表|统计|数据|订单|台账|table|list/i.test(p);
  const children = [
    { type: "heading", value: p, level: 2 },
    { type: "text", value: "这是根据你的描述生成的界面。目前未接入模型，所以内容是按结构套出来的 —— 接上模型后，这里会是真正贴合你需求的内容。" },
  ];
  if (wantsTable) {
    children.push({
      type: "table",
      columns: ["项目", "状态", "备注"],
      rows: [["第一项", "进行中", "—"], ["第二项", "待开始", "—"]],
    });
  } else {
    children.push({ type: "list", items: ["第一点", "第二点", "第三点"] });
  }
  children.push({ type: "divider" }, { type: "badge", value: "本地生成" });
  return { type: "page", children };
}

/** 调真模型 */
async function llmGenerate(prompt, { apiKey, baseUrl, model }) {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: String(prompt).slice(0, 2000) },
      ],
      temperature: 0.4,
    }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) {
    throw new Error(`模型网关返回 ${res.status}`);
  }
  const body = await res.json();
  const text = body?.choices?.[0]?.message?.content;
  const parsed = extractJson(text);
  if (!parsed) throw new Error("模型没有返回可解析的 JSON");
  return parsed;
}

/**
 * 对外入口。永远返回 { blueprint, mode, note? }，不抛错到调用方。
 * mode: "llm" | "local"
 */
export async function generateBlueprint(prompt, cfg) {
  if (cfg?.apiKey) {
    try {
      const raw = await llmGenerate(prompt, cfg);
      const clean = sanitizeBlueprint(raw);
      if (clean && Array.isArray(clean.children) && clean.children.length) {
        return { blueprint: clean, mode: "llm" };
      }
      return {
        blueprint: localGenerate(prompt),
        mode: "local",
        note: "模型返回的结构不可用，已回退到本地生成",
      };
    } catch (e) {
      return {
        blueprint: localGenerate(prompt),
        mode: "local",
        note: `模型调用失败（${e.message}），已回退到本地生成`,
      };
    }
  }
  return { blueprint: localGenerate(prompt), mode: "local", note: "未配置模型密钥" };
}
