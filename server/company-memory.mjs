/**
 * Company Memory + Agent Control 的最小版 —— 09-03 美妆种子用户验收的第四/五块。
 *
 * 文档 §4.3 把 Company Memory 称为"这是最不能外包掉的东西"，§4.4 说 Agent Control
 * "不要做成 Agent 广场"（重点是可控性/质量/成本/业务价值，不是数量）。
 *
 * 这里刻意不新造一张"统一事实表"——sell_tasks/grow_experiments/innovate_opportunities
 * 已经在同一个 SQLite 文件里（同一个 `db` 实例，三个 mock 模块共用），造第二份事实表
 * 意味着每次业务表改动都要同步改事实表，两处判据早晚对不上。所以这一层是**只读聚合**：
 * 直接查三张业务表，映射成统一的"事实"视图，而不是另建一份需要手工同步的副本。
 *
 * 🔴 诚实边界：AI Revenue / AI参与GMV 这类经营指标，文档要求"必须可追溯"——
 * 本轮种子数据是模拟的，算出来的任何"GMV"都是假的，展示假钱比不展示更糟。
 * 所以这里只展示**能诚实计算的东西**：任务数、AI产出数、人工接管数、决策数——
 * 全部是真实计数，不是估算或伪造的经营指标。成本（token/模型调用花费）现在
 * 没有接埋点，如实标注"未接入"，不编一个数字出来。
 */
import { send } from "./http-util.mjs";

/** Appendix B 建议的第一批 Agent 清单——静态映射，数字全部现查三张业务表算出来 */
const AGENT_DEFS = [
  { name: "需求解析Agent", loop: "Sell", role: "把自然语言需求转成结构化任务", high_risk: "无" },
  { name: "商品匹配Agent", loop: "Sell", role: "基于库存/价格/客户规则推荐SKU", high_risk: "只能建议" },
  { name: "报价Agent", loop: "Sell", role: "生成报价草稿", high_risk: "发送前人工批准" },
  { name: "内容Agent", loop: "Grow", role: "生成短视频脚本/图文/私域卡片", high_risk: "发布前可审批" },
  { name: "增长分析Agent", loop: "Grow", role: "读结果、给下一轮实验建议", high_risk: "预算变更需批准" },
  { name: "机会Agent", loop: "Innovate", role: "聚合证据生成Opportunity", high_risk: "不可直接开品" },
  { name: "Concept Agent", loop: "Innovate", role: "生成A/B/C商品假设和测试物料", high_risk: "必须标明Concept Test" },
  { name: "实验分析Agent", loop: "Innovate", role: "汇总Intent并给GO/KILL建议", high_risk: "最终Decision人工确认" },
];

export function createCompanyMemory({ db, prefix, secret }) {
  function tableExists(name) {
    return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name);
  }

  function buildFeed() {
    const feed = [];
    if (tableExists("sell_tasks")) {
      for (const r of db.prepare(`SELECT * FROM sell_tasks ORDER BY updated_at DESC LIMIT 50`).all()) {
        feed.push({
          loop: "Sell", entity: "客户任务", source_id: r.id,
          summary: `${r.customer_name} · ${r.status}${r.ai_quote_amount ? ` · AI报价¥${r.ai_quote_amount}` : ""}`,
          actor: r.status === "pending" ? "ai" : "human", at: r.updated_at,
        });
      }
    }
    if (tableExists("grow_experiments")) {
      for (const r of db.prepare(`SELECT * FROM grow_experiments ORDER BY updated_at DESC LIMIT 50`).all()) {
        feed.push({
          loop: "Grow", entity: "内容实验", source_id: r.id,
          summary: `${r.brand}·${r.channel} · ${r.status}`,
          actor: (r.status === "approved" || r.status === "rejected" || r.status === "measured") ? "human" : "ai",
          at: r.updated_at,
        });
      }
    }
    if (tableExists("innovate_opportunities")) {
      for (const r of db.prepare(`SELECT * FROM innovate_opportunities ORDER BY updated_at DESC LIMIT 50`).all()) {
        feed.push({
          loop: "Innovate", entity: "机会", source_id: r.id,
          summary: `${r.title} · ${r.status}${r.decision ? ` · ${r.decision}` : ""}`,
          actor: r.status === "decided" ? "human" : "ai", at: r.updated_at,
        });
      }
    }
    feed.sort((a, b) => b.at - a.at);
    return feed.slice(0, 50);
  }

  function buildAgents() {
    const sellCount = tableExists("sell_tasks") ? db.prepare(`SELECT COUNT(*) AS n FROM sell_tasks`).get().n : 0;
    const sellQuoted = tableExists("sell_tasks") ? db.prepare(`SELECT COUNT(*) AS n FROM sell_tasks WHERE ai_quote_amount IS NOT NULL`).get().n : 0;
    const sellDecided = tableExists("sell_tasks") ? db.prepare(`SELECT COUNT(*) AS n FROM sell_tasks WHERE status IN ('approved','rejected')`).get().n : 0;

    const growCount = tableExists("grow_experiments") ? db.prepare(`SELECT COUNT(*) AS n FROM grow_experiments`).get().n : 0;
    const growGenerated = tableExists("grow_experiments") ? db.prepare(`SELECT COUNT(*) AS n FROM grow_experiments WHERE ai_variants IS NOT NULL`).get().n : 0;
    const growMeasured = tableExists("grow_experiments") ? db.prepare(`SELECT COUNT(*) AS n FROM grow_experiments WHERE status='measured'`).get().n : 0;

    const innoCount = tableExists("innovate_opportunities") ? db.prepare(`SELECT COUNT(*) AS n FROM innovate_opportunities`).get().n : 0;
    const innoConcept = tableExists("innovate_opportunities") ? db.prepare(`SELECT COUNT(*) AS n FROM innovate_opportunities WHERE concept_note IS NOT NULL`).get().n : 0;
    const innoDecided = tableExists("innovate_opportunities") ? db.prepare(`SELECT COUNT(*) AS n FROM innovate_opportunities WHERE status='decided'`).get().n : 0;

    const counts = {
      "需求解析Agent": sellCount, "商品匹配Agent": sellCount, "报价Agent": sellQuoted,
      "内容Agent": growGenerated, "增长分析Agent": growMeasured,
      "机会Agent": innoCount, "Concept Agent": innoConcept, "实验分析Agent": innoDecided,
    };
    const overrides = {
      "报价Agent": sellDecided, "增长分析Agent": growMeasured, "实验分析Agent": innoDecided,
    };
    return AGENT_DEFS.map((a) => ({
      ...a, task_count: counts[a.name] || 0,
      human_override_count: overrides[a.name] ?? null,
      cost: null, cost_note: "未接入token/调用成本埋点，如实标注未做，不编数字",
    }));
  }

  async function handle(req, res, { path }) {
    if (!path.startsWith(prefix)) return false;
    const bearer = String(req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
    if (!secret || bearer !== secret) return send(res, 401, { error: "unauthorized" }), true;

    const rel = path.slice(prefix.length);
    if (rel === "/feed" && req.method === "GET") return send(res, 200, { items: buildFeed() }), true;
    if (rel === "/agents" && req.method === "GET") return send(res, 200, { items: buildAgents() }), true;
    return false;
  }

  return { handle, _internals: { buildFeed, buildAgents } };
}
