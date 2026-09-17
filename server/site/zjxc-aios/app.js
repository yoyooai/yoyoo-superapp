const answerLibrary = demoAnswers;
let activeProcessCase = "workorder";
let activeProcessStep = processCases.workorder.steps[1];
let activeExecutionQueueId = taskQueue[0]?.id || "";
let processView = "library";
let processDetailMode = "overview";
let currentEditingFlowId = null;
let dashboardView = "management";
let boardFilters = boardFilterDefaults();
let dashboardReturnScroll = 0;
let activeDashboardDevice = null;
let graphView = "query";
let graphMode = "device";
let graphFocusId = graphRoots.device;
let graphZoom = 1;
let graphCollapsed = false;
let graphExpandedIds = new Set();
let selectedGraphNode = graphFocusId;
let graphActivePath = [];
/* ── 知识图谱的位置记忆（用户反馈）────────────────────────────────
   她的原话：「我点了某一条产线出来的一层，我再点张工，张工那个卡片需要
   固定的……但是现在张工又胡乱跳了。」
   病根不在她说的"展示形式"，在布局：原来每次渲染都拿**当前可见的那批节点**
   重算一遍环形布局 —— 多展开一个节点，那一层的个数变了，角度全跟着变，
   于是整张图一起挪位，看的人会以为自己点错了。
   改法：一个节点的位置只算一次，存在这里；后面展开/收起/切筛选，
   只给**新冒出来的**节点找空位，老节点一步不挪。
   只有三处清空：换图谱类型、换聚焦对象、点「重置视图」。 */
const graphPositions = new Map();
let graphLayoutKey = "";
let graphCanvas = { width: 0, height: 0 };
let currentKnowledgeEntryId = null;
let knowledgeEntries = [
  {
    id: "KB-001",
    title: "AR-203 点检 SOP",
    type: "SOP",
    object: "AR-203",
    version: "V1.3",
    source: "文档上传",
    scope: "厂区 A / 800G 产线 A / A 线 03 机位",
    owner: "张工",
    summary: "AR-203 日常点检项目、检查顺序和人工确认要求。",
    issues: "无新增待确认项。",
    status: "已发布",
    updated: "2026-08-20"
  },
  {
    id: "KB-002",
    title: "张力控制模块操作标准",
    type: "设备资料",
    object: "张力控制模块",
    version: "V2.1",
    source: "设备手册",
    scope: "厂区 A / AR-203 / AR-204",
    owner: "待确认",
    summary: "记录模块参数确认、操作顺序与复检标准。",
    issues: "知识责任人待确认。",
    status: "已发布",
    updated: "2026-08-22"
  },
  {
    id: "KB-003",
    title: "张力控制模块 V2 操作手册",
    type: "设备资料",
    object: "LR-205",
    version: "V1.0",
    source: "设备手册",
    scope: "厂区 A / 800G 产线 B / B 线 05 机位",
    owner: "待确认",
    summary: "记录厂商乙 V2 模块的安装、参数和保养说明。",
    issues: "知识责任人待确认。",
    status: "待审核",
    updated: "2026-09-13"
  }
];
const graphTypeVisibility = {
  device: true,
  function: true,
  document: true,
  line: true,
  location: true,
  person: true,
  agent: true,
  spare: true,
  supplier: true,
  process: true
};

function $(selector, root = document) {
  return root.querySelector(selector);
}

function $$(selector, root = document) {
  return [...root.querySelectorAll(selector)];
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("is-visible"), 2200);
}

// —— 单栏模式（?only=…）——————————————————————————————
// 平台上每一栏各建一个独立应用时使用：只显示这一栏、隐藏顶部导航，
// 不带 only 参数时行为与原来完全一致。
const ONLY_VIEWS = {
  home: { view: "home", label: "应用中心" },
  workspace: { view: "home", label: "我的工作台" },
  expert: { view: "expert", label: "设备专家" },
  process: { view: "process", label: "设备流程" },
  dashboard: { view: "dashboard", label: "数据看板" },
  graph: { view: "graph", label: "知识图谱" }
};

const ONLY_KEY = (() => {
  let key = "";
  try {
    key = new URLSearchParams(location.search).get("only") || "";
  } catch (error) {
    key = "";
  }
  return Object.prototype.hasOwnProperty.call(ONLY_VIEWS, key) ? key : "";
})();

/**
 * 单栏模式下的「临时串栏」。
 *
 * 起因（用户反馈）：工作台里点某一条待办，本来能跳到具体的设备流程里去，
 * 这个跳转在第一版被剪断了 —— 背后其实是同一套逻辑，前端只是展现成 5 个不同的窗口。
 * 第一版把 `openApp()` 整个短路掉，等于把这五个窗口之间的关联剪断了。
 *
 * 做法：跳过去照跳，但记住"我本来是哪一栏"，并把顶部那个返回按钮改成
 * 「← 返回<本栏>」。所以它仍然是一个独立应用（永远回得到自己那一屏），
 * 只是不再是一口死井。
 */
let onlyDetour = "";

function applyOnlyMode() {
  if (!ONLY_KEY) return;
  const spec = ONLY_VIEWS[ONLY_KEY];
  document.documentElement.dataset.only = ONLY_KEY;
  document.title = `中际旭创 AIOS · ${spec.label}`;
  const brandSub = document.querySelector(".brand small");
  if (brandSub) brandSub.textContent = spec.label;
  // 返回按钮平时藏着（本栏就是首屏，没地方可回）；串到别栏时露出来，写清回哪儿。
  // 只认「← 应用中心」那几个（带 data-open-app）：#backToDashboardButton 也是
  // .back-link，但它是设备详情回数据看板用的，名字不能被改成「← 返回我的工作台」。
  document.querySelectorAll(".back-link[data-open-app]").forEach((b) => { b.textContent = `← 返回${spec.label}`; });
}

function getRoute() {
  if (ONLY_KEY) return onlyDetour || ONLY_VIEWS[ONLY_KEY].view;
  const route = location.hash.replace("#", "");
  return ["home", "expert", "process", "dashboard", "graph"].includes(route) ? route : "home";
}

function openApp(app) {
  if (ONLY_KEY) {
    const base = ONLY_VIEWS[ONLY_KEY].view;
    // 点「← 返回」或跳回本栏 ⇒ 回到自己那一屏
    onlyDetour = (!app || app === base || app === ONLY_KEY) ? "" : app;
    // 工作台那一栏的底座是 home，串到别栏再回来时要能回到 home
    if (onlyDetour && !["home", "expert", "process", "dashboard", "graph"].includes(onlyDetour)) onlyDetour = "";
    document.documentElement.dataset.onlyDetour = onlyDetour ? "1" : "";
    renderRoute();
    return;
  }
  const target = app === "home" ? "home" : app;
  if (location.hash === `#${target}`) {
    renderRoute();
  } else {
    location.hash = target;
  }
}

function resetViewportScroll() {
  const root = document.documentElement;
  root.style.scrollBehavior = "auto";
  const snapToTop = () => {
    window.scrollTo(0, 0);
    root.scrollTop = 0;
    document.body.scrollTop = 0;
  };
  snapToTop();
  requestAnimationFrame(() => {
    snapToTop();
    requestAnimationFrame(snapToTop);
  });
  window.setTimeout(snapToTop, 120);
}

function renderRoute() {
  const route = getRoute();
  $$(".view").forEach((view) => {
    view.hidden = view.id !== `view-${route}`;
  });
  $$(".main-nav a").forEach((link) => {
    link.classList.toggle("is-active", link.dataset.nav === route);
  });
  closeDrawer("stepDrawer");
  resetViewportScroll();
}

function renderQuickQuestions() {
  const questions = [
    "AR-203 最近运行情况怎么样？",
    "AR-203 的日常点检重点是什么？",
    "AR-203 出现张力波动，建议怎么处理？",
    "800G 产线要新增张力控制设备，选型要注意什么？",
    "下月 800G 产线增加 10 万只/月，怎么排产并评估设备缺口？"
  ];
  $("#quickQuestions").innerHTML = questions
    .map((question) => `<button class="quick-question" type="button" data-question="${escapeHtml(question)}">${escapeHtml(question)}</button>`)
    .join("");
}

function answerMarkup(question) {
  const answer = answerLibrary[question] || {
    understanding: "已收到问题，我会先核对设备对象和现场范围。",
    voice: "我先不硬给结论。这个问题还缺设备、产线或机位信息，我需要你补一句现场范围。",
    conclusion: "补充问题对象与现场范围后，我才能把回答收窄到可执行建议。",
    steps: [["01", "补充设备、产线或机位", "信息不完整时，任何结论都只能算通用建议", "人工确认"]],
    gap: "当前信息不足，暂时无法形成有依据的结论。",
    actions: ["knowledge"],
    evidence: []
  };
  const steps = answer.steps || [];
  const facts = answer.facts || [];
  const actions = answer.actions || ["knowledge"];
  const evidence = answer.evidence || [];

  return `
    <article class="message user">
      <p>${escapeHtml(question)}</p>
    </article>
    <article class="message agent">
      <span class="agent-label"><b>旭</b> 设备工程师 · 阿旭</span>
      <div class="answer-card">
        <div class="expert-read">
          <span>我理解的是</span>
          <p>${escapeHtml(answer.understanding)}</p>
        </div>
        <div class="expert-voice">
          <p>“${escapeHtml(answer.voice)}”</p>
        </div>
        <div class="expert-judgement">
          <span>先给判断</span>
          <h3>${escapeHtml(answer.conclusion)}</h3>
        </div>
        ${facts.length ? `
          <div class="answer-facts">
            ${facts.map(([label, value]) => `
              <div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>
            `).join("")}
          </div>
        ` : ""}
        ${steps.length ? `
          <div class="field-checklist">
            <div class="checklist-head">
              <strong>如果我在现场，会带你这样做</strong>
              <span>按顺序来，别跳项</span>
            </div>
            <ol class="agent-steps">
            ${steps.map(([number, text, note, confirm]) => `
              <li>
                <span class="step-number">${escapeHtml(number)}</span>
                <span><strong>${escapeHtml(text)}</strong><small>${escapeHtml(note)}</small></span>
                <span class="human-confirm">${escapeHtml(confirm)}</span>
              </li>
            `).join("")}
            </ol>
          </div>
        ` : ""}
        <div class="expert-callout">
          <strong>现场提醒</strong>
          <p>${escapeHtml(answer.gap)}</p>
        </div>
        <div class="answer-evidence">
          <button class="evidence-toggle" type="button" data-evidence-toggle aria-expanded="false">
            <span>回答依据｜引用 ${escapeHtml(String(evidence.length))} 条资料</span>
            <b aria-hidden="true">展开</b>
          </button>
          <div class="evidence-detail" hidden>
            <div class="evidence-list">
              ${evidence.map((item) => `
                <button class="evidence-item" type="button" data-toast="已打开 ${escapeHtml(item.name)} · ${escapeHtml(item.section)}">
                  <span class="evidence-tag">${escapeHtml(item.tag)}</span>
                  <span class="evidence-body">
                    <strong>${escapeHtml(item.name)}</strong>
                    <small>${escapeHtml(item.section)}${item.application ? ` · 适用：${escapeHtml(item.application)}` : ""}</small>
                    ${item.excerpt ? `<em>“${escapeHtml(item.excerpt)}”</em>` : ""}
                  </span>
                  <span class="evidence-note">${escapeHtml(item.note)}</span>
                </button>
              `).join("")}
            </div>
          </div>
        </div>
        <div class="answer-feedback">
          <div>
            <strong>这个回答对你有帮助吗？</strong>
          </div>
          <button type="button" data-answer-feedback="up">有用 12</button>
          <button type="button" data-answer-feedback="down">没解决</button>
        </div>
        <div class="answer-actions">
          ${actions.includes("knowledge") ? `<button class="action-button is-primary" type="button" data-view-knowledge>查看关联知识</button>` : ""}
          ${actions.includes("ticket") ? `<button class="action-button is-primary" type="button" data-create-ticket>${escapeHtml(answer.ticket?.actionLabel || "提交运维工单")}</button>` : ""}
        </div>
      </div>
    </article>
  `;
}

let currentQuestion = "";
let currentAnswer = null;
let workOrderCreated = false;
let activeTicketContext = null;

function askQuestion(question) {
  const clean = String(question || "").trim();
  if (!clean) return;
  currentQuestion = clean;
  currentAnswer = answerLibrary[clean] || null;
  $("#conversation").innerHTML = answerMarkup(clean);
  $("#conversation").scrollTop = 0;
  $("#askInput").value = "";
}

function renderFlowLibrary() {
  $("#flowLibrary").innerHTML = processFlows.map((flow, index) => {
    const humanCount = flow.steps.filter((step) => step.actorType === "human").length;
    const agentCount = flow.steps.length - humanCount;
    return `
    <article class="flow-card">
      <div class="flow-card-top">
        <span class="flow-index">0${index + 1}</span>
        <span class="flow-state">${escapeHtml(flow.status)}</span>
      </div>
      <strong>${escapeHtml(flow.name)}</strong>
      <small>${escapeHtml(flow.subtitle)}</small>
      <p>${escapeHtml(flow.trigger)}</p>
      <dl class="flow-meta">
        <div><dt>执行方</dt><dd>${escapeHtml(flow.owner)}</dd></div>
        <div><dt>步骤</dt><dd>${escapeHtml(String(flow.steps.length))} 步 · 人 ${humanCount} / Agent ${agentCount}</dd></div>
        <div><dt>最近更新</dt><dd>${escapeHtml(flow.updated)}</dd></div>
      </dl>
      <button class="secondary-button flow-edit-button" type="button" data-edit-flow="${escapeHtml(flow.id)}">查看与编辑</button>
    </article>
  `;
  }).join("");
}

function renderWorkOrderBanner() {
  const stage = currentStage();
  if (stage.type === "task" || stage.type === "case") {
    const task = stage.banner;
    $("#workorderBanner").innerHTML = `
      <div class="workorder-main">
        <span class="workorder-id">${escapeHtml(task.id)}</span>
        <strong>${escapeHtml(task.title)}</strong>
        <span class="workorder-state">${escapeHtml(task.status)}</span>
        ${stage.type === "task" ? `<button class="secondary-button compact workorder-task-detail" type="button" data-open-task-detail="${escapeHtml(task.id)}">任务详情</button>` : `<span class="workorder-stage-tag">${escapeHtml(stage.caseData.stage)}</span>`}
      </div>
      <p class="workorder-task-summary">${escapeHtml(task.node)} · ${escapeHtml(task.owner)} · ${escapeHtml(task.agent)}</p>
      <div class="workorder-task-strip">
        <span><b>来源</b>${escapeHtml(task.source)}</span>
        <span><b>流程</b>${escapeHtml(task.flow || task.stage)}</span>
        <span><b>输出</b>${escapeHtml(task.output)}</span>
        <span><b>下一步</b>${escapeHtml(task.next)}</span>
      </div>
    `;
    return;
  }

  $("#workorderBanner").innerHTML = `
    <div class="workorder-main">
      <span class="workorder-id">${escapeHtml(workOrder.id)}</span>
      <strong>${escapeHtml(workOrder.title)}</strong>
      <span class="workorder-state">${escapeHtml(workOrder.status)}</span>
    </div>
    <dl class="workorder-meta">
      <div><dt>设备</dt><dd>${escapeHtml(workOrder.device)}</dd></div>
      <div><dt>位置</dt><dd>${escapeHtml(workOrder.line)}</dd></div>
      <div><dt>匹配流程</dt><dd>${escapeHtml(workOrder.flow)}</dd></div>
      <div><dt>紧急程度</dt><dd>${escapeHtml(workOrder.urgency)}</dd></div>
      <div><dt>提交时间</dt><dd>${escapeHtml(workOrder.submitted)}</dd></div>
      <div><dt>当前责任方</dt><dd>${escapeHtml(workOrder.owner)}</dd></div>
    </dl>
    <p class="workorder-source">来源：${escapeHtml(workOrder.source)} · 当前节点：${escapeHtml(workOrder.currentStep)}</p>
  `;
}

function dailyTaskProgress(task) {
  const stepMatch = task.node.match(/第\s*(\d+)\s*\/\s*(\d+)\s*步/);
  if (stepMatch) {
    return Math.round(Number(stepMatch[1]) / Number(stepMatch[2]) * 100);
  }
  if (task.status === "待补充") return 20;
  if (task.status === "待确认") return 65;
  return 45;
}

function renderDailyTasks() {
  $("#dailyTaskList").innerHTML = dailyTasks.map((task) => {
    const progress = dailyTaskProgress(task);
    return `
      <article class="daily-task-card ${task.demoFocus ? "is-focus" : ""}" data-task-card="${escapeHtml(task.id)}">
        <button class="daily-task-open" type="button" data-daily-task="${escapeHtml(task.id)}">
          <span class="daily-task-head">
            <span class="daily-task-id">${escapeHtml(task.id)}</span>
            <span class="daily-task-state">${escapeHtml(task.status)}</span>
          </span>
          <strong>${escapeHtml(task.title)}</strong>
          <span class="daily-task-owner">${escapeHtml(task.owner)} · ${escapeHtml(task.agent)}</span>
        </button>
        <div class="daily-task-current">
          <span>当前环节 / 待补内容</span>
          <strong>${escapeHtml(task.node)}</strong>
          <small>${escapeHtml(task.next)}</small>
          <div class="daily-task-progress">
            <i><b style="width:${progress}%"></b></i>
            <small>${progress}%</small>
          </div>
          <button class="text-button daily-task-detail-button" type="button" data-open-task-detail="${escapeHtml(task.id)}">任务详情</button>
        </div>
      </article>
    `;
  }).join("");
}

function caseProcessActive(caseId) {
  const item = caseCatalog.find((candidate) => candidate.id === caseId);
  return Boolean(item && item.processKey === activeProcessCase);
}

function ongoingFlowActive(flow) {
  if (flow.routeType === "workorder") return activeProcessCase === "workorder";
  return flow.targetId === activeProcessCase;
}

function renderCaseCatalog(selector) {
  const container = $(selector);
  if (!container) return;
  container.innerHTML = caseCatalog.map((item, index) => `
    <button class="case-card ${caseProcessActive(item.id) ? "is-active" : ""}" type="button" data-open-case="${escapeHtml(item.id)}">
      <span class="case-card-top">
        <span class="case-card-index">0${index + 1}</span>
        <span class="case-stage">${escapeHtml(item.stage)}</span>
      </span>
      <strong>${escapeHtml(item.title)}</strong>
      <span class="case-card-owner">${escapeHtml(item.owner)}</span>
      <span class="case-card-foot">
        <small>${escapeHtml(item.agent)}</small>
        <b>打开案例</b>
      </span>
    </button>
  `).join("");
}

function renderOngoingFlows(selector) {
  const container = $(selector);
  if (!container) return;
  container.innerHTML = ongoingFlows.map((flow) => `
    <button class="ongoing-flow-card ${ongoingFlowActive(flow) ? "is-active" : ""}" type="button" data-open-flow="${escapeHtml(flow.id)}">
      <span class="ongoing-flow-head">
        <span class="ongoing-stage">${escapeHtml(flow.stage)}</span>
        <span class="ongoing-status">${escapeHtml(flow.status)}</span>
      </span>
      <strong>${escapeHtml(flow.title)}</strong>
      <span class="ongoing-flow-meta">
        <span><b>发起 / Owner</b><em>${escapeHtml(flow.owner)}</em></span>
        <span><b>负责 Agent</b><em>${escapeHtml(flow.agent)}</em></span>
        <span><b>当前节点</b><em>${escapeHtml(flow.node)}</em></span>
        <span><b>下一步</b><em>${escapeHtml(flow.next)}</em></span>
        <span><b>人工确认点</b><em>${escapeHtml(flow.confirm)}</em></span>
        <span><b>最近更新</b><em>${escapeHtml(flow.updated)}</em></span>
      </span>
    </button>
  `).join("");
}

function workspaceFlowMarkup(flow) {
  return `
    <button class="workspace-item" type="button" data-open-flow="${escapeHtml(flow.id)}">
      <span class="workspace-item-top">
        <span>${escapeHtml(flow.stage)}</span>
        <i>${escapeHtml(flow.status)}</i>
      </span>
      <strong>${escapeHtml(flow.title)}</strong>
      <small>${escapeHtml(flow.node)}</small>
      <span class="workspace-item-foot">
        <span>${escapeHtml(flow.owner)}</span>
        <b>${escapeHtml(flow.agent)}</b>
      </span>
    </button>
  `;
}

function renderWorkspace() {
  const confirmFlows = ongoingFlows.filter((flow) => flow.status.includes("待"));
  const relatedRunning = ongoingFlows.filter((flow) =>
    flow.status.includes("进行") && /张工/.test(`${flow.owner}${flow.confirm}`)
  );
  const devices = masterData.devices.slice(0, 3);
  $("#homeConfirmCount").textContent = String(confirmFlows.length);
  $("#homeRunningCount").textContent = String(relatedRunning.length);
  $("#homeDeviceCount").textContent = String(devices.length);
  $("#homeRelatedCount").textContent = String(confirmFlows.length + relatedRunning.length);
  $("#homeConfirmList").innerHTML = confirmFlows.map(workspaceFlowMarkup).join("");
  $("#homeRunningList").innerHTML = relatedRunning.map(workspaceFlowMarkup).join("");
  $("#homeDeviceList").innerHTML = devices.map((device) => `
    <button class="workspace-device" type="button" data-dashboard-entity="device" data-entity-id="${escapeHtml(device.id)}">
      <span>
        <b>${escapeHtml(device.id)}</b>
        <small>${escapeHtml(device.line)} · ${escapeHtml(device.station)}</small>
      </span>
      <span>
        <strong>${escapeHtml(device.owner)}</strong>
        <small>${escapeHtml(device.utilization)} 利用率</small>
      </span>
    </button>
  `).join("");
  $("#homeAllFlows").innerHTML = ongoingFlows.map((flow) => `
    <button class="workspace-all-item" type="button" data-open-flow="${escapeHtml(flow.id)}">
      <span>${escapeHtml(flow.stage)}</span>
      <strong>${escapeHtml(flow.title)}</strong>
      <small>${escapeHtml(flow.node)}</small>
      <b>${escapeHtml(flow.status)}</b>
    </button>
  `).join("");
}

function buildCaseSteps(caseItem) {
  return caseItem.steps.map(([name, actorType, actor, status], index) => {
    const isHuman = actorType === "human";
    return {
      id: `${caseItem.id}-${String(index + 1).padStart(2, "0")}`,
      name,
      actorType,
      actor,
      status,
      input: caseItem.input,
      human: isHuman ? caseItem.confirm : "暂不参与。",
      agent: isHuman ? "准备判断依据与待确认项，不代替人工确认。" : `${caseItem.agent} 完成分析、整理和结果草稿。`,
      output: caseItem.output,
      confirm: caseItem.confirm,
      next: caseItem.steps[index + 1]?.[0] || "案例归档",
      evidence: [`${caseItem.stage}流程配置`, caseItem.source],
      permission: isHuman ? "人工确认不可跳过" : "Agent 只生成草稿与建议，不代替采购、选型或现场判断"
    };
  });
}

function ensureCaseProcess(caseItem) {
  if (processCases[caseItem.processKey]) return caseItem.processKey;
  processCases[caseItem.processKey] = {
    key: caseItem.processKey,
    type: "case",
    caseData: caseItem,
    kicker: "CROSS-STAGE CASE",
    label: `${caseItem.stage} · ${caseItem.title}`,
    description: `${caseItem.title}。${caseItem.node}，由${caseItem.owner}与${caseItem.agent}协同推进。`,
    steps: buildCaseSteps(caseItem),
    banner: caseItem
  };
  return caseItem.processKey;
}

function openCaseProcess(caseId) {
  const caseItem = caseCatalog.find((item) => item.id === caseId);
  if (!caseItem) return;
  if (caseItem.processKey === "workorder") {
    setProcessCase("workorder");
  } else {
    setProcessCase(ensureCaseProcess(caseItem));
  }
  processDetailMode = "focus";
  setProcessView("workorder");
  closeDrawer("stepDrawer");
}

function openOngoingFlow(flowId) {
  const flow = ongoingFlows.find((item) => item.id === flowId);
  if (!flow) return;
  openApp("process");
  if (flow.routeType === "case") {
    openCaseProcess(flow.targetId);
  } else if (flow.routeType === "task") {
    openTaskExecution(flow.targetId);
  } else {
    setProcessCase("workorder");
    setProcessView("workorder");
    processDetailMode = "focus";
    setProcessView("workorder");
    closeDrawer("stepDrawer");
  }
}

function buildDailyTaskSteps(task) {
  const common = {
    input: task.input,
    human: task.confirm,
    agent: `${task.agent} 生成草稿并维护过程记录。`,
    output: task.output,
    confirm: task.confirm,
    evidence: [`${task.flow}流程配置`, task.source],
    permission: "人工确认不可跳过；Agent 只生成草稿并更新状态"
  };
  return [
    {
      id: `${task.id}-01`,
      name: "接收任务并生成执行草稿",
      actorType: "agent",
      actor: task.agent,
      status: "已完成",
      ...common,
      output: "任务执行草稿",
      next: "02 负责人确认任务输入"
    },
    {
      id: `${task.id}-02`,
      name: "负责人确认任务输入",
      actorType: "human",
      actor: task.owner,
      status: task.status === "待补充" ? "待补充" : "进行中",
      ...common,
      next: "03 Agent 执行并生成结果"
    },
    {
      id: `${task.id}-03`,
      name: "Agent 执行并生成结果",
      actorType: "agent",
      actor: task.agent,
      status: "未开始",
      ...common,
      next: "04 负责人确认输出"
    },
    {
      id: `${task.id}-04`,
      name: "负责人确认输出",
      actorType: "human",
      actor: task.owner,
      status: "未开始",
      ...common,
      next: "05 任务归档"
    },
    {
      id: `${task.id}-05`,
      name: "归档并关闭任务",
      actorType: "agent",
      actor: task.agent,
      status: "未开始",
      ...common,
      output: task.next,
      next: "任务关闭"
    }
  ];
}

function ensureDailyTaskCase(taskId) {
  if (taskId === dailyTasks[0].id) {
    processCases.task.key = "task";
    return "task";
  }
  const task = dailyTasks.find((item) => item.id === taskId);
  if (!task) return "task";
  if (!processCases[taskId]) {
    processCases[taskId] = {
      key: taskId,
      type: "task",
      kicker: "CURRENT DAILY TASK",
      label: `${task.flow} · ${task.title}`,
      description: `${task.id} · ${task.title}。${task.node}，由${task.owner}与${task.agent}协同推进。`,
      steps: buildDailyTaskSteps(task),
      banner: task
    };
  }
  return taskId;
}

function ensureQueueCase(item) {
  if (processCases[item.id]) return item.id;
  const task = {
    id: item.sourceId,
    title: item.title,
    owner: item.humanOwner || "现场负责人",
    agent: item.owner,
    source: "设备流程任务队列",
    flow: item.flow || "设备运维",
    node: item.currentStep,
    input: item.input || "任务输入",
    output: item.output || "任务结果",
    confirm: item.confirm || "现场负责人确认结果",
    next: item.next || "归档并关闭任务",
    status: item.status
  };
  processCases[item.id] = {
    key: item.id,
    type: "task",
    kicker: "QUEUED TASK",
    label: `${task.flow} · ${task.title}`,
    description: `${item.id} · ${task.title}。${item.queuePosition}，${item.currentStep}。`,
    steps: buildDailyTaskSteps(task),
    banner: task
  };
  return item.id;
}

function openTaskExecution(taskId) {
  const caseKey = ensureDailyTaskCase(taskId);
  const queueItem = taskQueue.find((item) => item.sourceId === taskId);
  if (queueItem) activeExecutionQueueId = queueItem.id;
  setProcessCase(caseKey);
  processDetailMode = "focus";
  setProcessView("workorder");
  closeDrawer("stepDrawer");
}

function openQueueExecution(queueId) {
  const item = taskQueue.find((queue) => queue.id === queueId);
  if (!item) return;
  activeExecutionQueueId = item.id;
  if (item.sourceType === "workorder") {
    setProcessCase("workorder");
  } else if (item.sourceType === "task") {
    setProcessCase(ensureDailyTaskCase(item.sourceId));
  } else {
    setProcessCase(ensureQueueCase(item));
  }
  processDetailMode = "focus";
  setProcessView("workorder");
  closeDrawer("stepDrawer");
  showToast(`已打开队列任务 ${item.title}`);
}

function renderCaseDetailPanel() {
  const panel = $("#caseDetailPanel");
  if (!panel) return;
  const stage = currentStage();
  const caseItem = stage.type === "case" ? stage.caseData : null;
  if (!caseItem || caseItem.details.type === "maintenance") {
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }

  const head = `
    <div class="case-detail-head">
      <div>
        <span class="section-kicker">${escapeHtml(caseItem.stage)} · CASE DATA</span>
        <h2>${escapeHtml(caseItem.title)}</h2>
        <p>${escapeHtml(caseItem.timeline.join(" → "))}</p>
      </div>
      <span class="case-human-rule">Agent 整理建议，人工做最终确认</span>
    </div>
  `;

  if (caseItem.details.type === "requirement") {
    panel.innerHTML = `
      ${head}
      <div class="case-fact-grid">
        ${caseItem.details.facts.map(([label, value]) => `
          <article><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>
        `).join("")}
      </div>
      <div class="case-pending-row">
        <strong>待确认项</strong>
        ${caseItem.details.pending.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}
      </div>
    `;
  } else if (caseItem.details.type === "selection") {
    panel.innerHTML = `
      ${head}
      <div class="table-wrap">
        <table class="case-data-table">
          <thead><tr><th>设备型号</th><th>预计产能</th><th>交期</th><th>价格区间</th><th>兼容性</th><th>风险</th><th>推荐理由</th></tr></thead>
          <tbody>
            ${caseItem.details.candidates.map((row) => `
              <tr>${row.map((cell, index) => `<td>${index === row.length - 1 ? `<span class="case-recommendation">${escapeHtml(cell)}</span>` : escapeHtml(cell)}</td>`).join("")}</tr>
            `).join("")}
          </tbody>
        </table>
      </div>
      <p class="case-detail-note">选型 Agent 负责形成候选与排序，最终型号由设备 Owner 确认。</p>
    `;
  } else {
    panel.innerHTML = `
      ${head}
      <div class="table-wrap">
        <table class="case-data-table">
          <thead><tr><th>供应商</th><th>报价</th><th>交期</th><th>质保</th><th>历史履约</th><th>采购建议</th></tr></thead>
          <tbody>
            ${caseItem.details.suppliers.map((row) => `
              <tr>${row.map((cell, index) => `<td>${index === row.length - 1 ? `<span class="case-recommendation">${escapeHtml(cell)}</span>` : escapeHtml(cell)}</td>`).join("")}</tr>
            `).join("")}
          </tbody>
        </table>
      </div>
      <p class="case-detail-note">采购比价 Agent 只整理价格、交期、质保和历史履约，最终供应商由采购 Owner 确认。</p>
    `;
  }
  panel.hidden = false;
}

function processTaskCard(flow) {
  const running = flow.status.includes("进行中");
  return `
    <button class="process-task-card" type="button" data-open-flow="${escapeHtml(flow.id)}">
      <span class="process-task-card-top">
        <span>${escapeHtml(flow.stage)}</span>
        <i class="${running ? "is-running" : "is-waiting"}">${escapeHtml(flow.status)}</i>
      </span>
      <strong>${escapeHtml(flow.title)}</strong>
      <p>${escapeHtml(flow.node)}</p>
      <span class="process-task-card-meta">
        <span><b>Owner</b>${escapeHtml(flow.owner)}</span>
        <span><b>Agent</b>${escapeHtml(flow.agent)}</span>
        <span><b>更新</b>${escapeHtml(flow.updated)}</span>
      </span>
      <span class="process-task-card-action">${running ? "打开执行泳道" : "查看任务详情"} <b>→</b></span>
    </button>
  `;
}

function renderProcessTaskLists() {
  const running = ongoingFlows.filter((flow) => flow.status.includes("进行中"));
  const waiting = ongoingFlows.filter((flow) => !flow.status.includes("进行中"));
  $("#workorderCount").textContent = String(ongoingFlows.length);
  $("#workorderSummaryPill").textContent = `${running.length} 个执行中 · ${waiting.length} 个等待中`;
  $("#runningProcessList").innerHTML = running.map(processTaskCard).join("");
  $("#waitingProcessList").innerHTML = waiting.map(processTaskCard).join("");
}

function renderWorkOrderView() {
  const overview = $("#workorderOverview");
  const detail = $("#workorderDetailBlock");
  if (!overview || !detail) return;
  const showDetail = processDetailMode === "focus";
  overview.hidden = showDetail;
  detail.hidden = !showDetail;
  if (showDetail) {
    renderCaseDetailPanel();
    renderWorkOrderBanner();
    renderProcessBoard();
  } else {
    renderProcessTaskLists();
  }
}

function renderTaskQueue() {
  const running = taskQueue.filter((item) => item.status === "执行中");
  const waiting = taskQueue.filter((item) => item.status !== "执行中");
  $("#queueCount").textContent = String(taskQueue.length);
  $("#queueCurrent").innerHTML = `
    <div class="queue-summary">
      <div><span>运行中</span><strong>${running.length}</strong><small>最多可并行运行 3 个任务</small></div>
      <div><span>等待中</span><strong>${waiting.length}</strong><small>加急后会进入队首</small></div>
      <div><span>队列总数</span><strong>${taskQueue.length}</strong><small>支持随时查看任务状态</small></div>
    </div>
    <div class="queue-running-list">
      ${running.map((item) => `
        <article class="queue-running-card">
          <div class="queue-current-head">
            <div>
              <span class="queue-state is-running"><i></i>执行中</span>
              <h3>${escapeHtml(item.title)}</h3>
              <p>${escapeHtml(item.currentStep)}</p>
            </div>
            <span class="queue-agent">${escapeHtml(item.owner)}</span>
          </div>
          <div class="queue-progress"><div style="width:${Number(item.progress)}%"></div></div>
          <div class="queue-meta">
            <span>${escapeHtml(item.device)}</span>
            <span>${escapeHtml(item.eta)}</span>
            <button class="secondary-button compact" type="button" data-queue-execute="${escapeHtml(item.id)}">打开执行</button>
          </div>
        </article>
      `).join("")}
    </div>
  `;
  $("#queueList").innerHTML = `
    <div class="queue-list-head">
      <h3>等待队列</h3>
      <small>按优先级排序，用户可以手动加急</small>
    </div>
    ${waiting.map((item, index) => `
      <article class="queue-item ${item.priority === "加急" ? "is-boosted" : ""}">
        <span class="queue-position">${escapeHtml(item.queuePosition || `第 ${index + 1} 位`)}</span>
        <div>
          <strong>${escapeHtml(item.title)}</strong>
          <small>${escapeHtml(item.device)} · ${escapeHtml(item.currentStep)}</small>
        </div>
        <span class="queue-owner">${escapeHtml(item.owner)}</span>
        <span class="queue-priority">${escapeHtml(item.priority)}</span>
        <div class="queue-actions">
          <button class="text-button" type="button" data-queue-detail="${escapeHtml(item.id)}">查看详情</button>
          <button class="secondary-button compact" type="button" data-queue-boost="${escapeHtml(item.id)}">${item.priority === "加急" ? "已加急" : "加急"}</button>
        </div>
      </article>
    `).join("")}
  `;
}

function setProcessCase(caseKey) {
  activeProcessCase = processCases[caseKey] ? caseKey : "workorder";
  const stage = currentStage();
  activeProcessStep = stage.steps.find((step) => step.status === "进行中") || stage.steps[0];
  renderWorkOrderBanner();
  renderProcessBoard();
  renderCaseDetailPanel();
  renderCaseCatalog("#processCaseCatalog");
}

function setProcessView(view) {
  processView = ["workorder", "queue", "tasks"].includes(view) ? view : "library";
  $$("[data-process-view]").forEach((button) => {
    const active = button.dataset.processView === processView;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  });
  $("#flowLibraryPanel").hidden = processView !== "library";
  $("#taskQueuePanel").hidden = processView !== "queue";
  $("#dailyTaskPanel").hidden = processView !== "tasks";
  $("#workorderPanel").hidden = processView !== "workorder";
  if (processView === "workorder") {
    renderWorkOrderView();
  }
  if (processView === "queue") {
    renderTaskQueue();
  }
}

function currentStage() {
  return processCases[activeProcessCase] || processCases.workorder;
}

const humanPersonaRules = [
  { match: ["张工"], name: "张工", role: "设备 Owner", avatar: "张" },
  { match: ["李工"], name: "李工", role: "运维负责人", avatar: "李" },
  { match: ["王工"], name: "王工", role: "采购 Owner", avatar: "王" },
  { match: ["陈工"], name: "陈工", role: "工厂需求 Owner", avatar: "陈" },
  { match: ["需求提出人"], name: "陈工", role: "需求提出人", avatar: "陈" },
  { match: ["业务负责人"], name: "周工", role: "业务负责人", avatar: "周" },
  { match: ["采购需求人"], name: "吴工", role: "采购需求人", avatar: "吴" },
  { match: ["采购", "法务"], name: "李工", role: "采购 / 法务责任人", avatar: "李" },
  { match: ["验收责任人"], name: "郑工", role: "验收责任人", avatar: "郑" },
  { match: ["现场负责人"], name: "王工", role: "现场负责人", avatar: "王" },
  { match: ["现场人员"], name: "王工", role: "现场人员", avatar: "王" },
  { match: ["现场安全责任人"], name: "赵工", role: "现场安全责任人", avatar: "赵" },
  { match: ["设备负责人"], name: "孙工", role: "设备负责人", avatar: "孙" }
];

function humanParticipants(step) {
  const matches = humanPersonaRules.filter((persona) => persona.match.every((part) => step.actor.includes(part)));
  if (matches.length > 0) {
    return matches.map((persona) => ({
      type: "human",
      name: persona.name,
      role: persona.role,
      avatar: persona.avatar,
      note: "示例姓名 · 待确认"
    }));
  }
  return [{
    type: "human",
    name: "真人负责人",
    role: step.actor,
    avatar: "人",
    note: "姓名与岗位待确认"
  }];
}

function participantList(step) {
  const participants = step.actorType === "human"
    ? humanParticipants(step)
    : [{
        type: "agent",
        name: step.actor,
        role: step.actorType === "agent" ? "数字同事" : "协作成员",
        avatar: step.actor.includes("2") ? "AI2" : "AI1",
        note: "Agent · 可追溯"
      }];

  const needsDevice = step.actorType === "agent"
    || /设备|参数|保养|验收|选型|排线|到货|采购|汰换/.test(`${step.name}${step.input}${step.output}`);
  if (needsDevice) {
    participants.push({
      type: "device",
      name: "AR-203",
      role: "关联设备",
      avatar: "机",
      note: "设备身份"
    });
  }
  return participants;
}

function participantMarkup(participant) {
  return `
    <span class="participant ${participant.type}">
      <b>${escapeHtml(participant.avatar)}</b>
      <span><strong>${escapeHtml(participant.name)}</strong><small>${escapeHtml(participant.role)}</small></span>
    </span>
  `;
}

function renderProcessTeam(stage) {
  const participants = stage.steps.flatMap(participantList);
  const unique = participants.filter((participant, index, list) =>
    list.findIndex((candidate) => candidate.type === participant.type && candidate.name === participant.name) === index
  );
  $("#processTeam").innerHTML = `
    <div class="process-team-label">
      <span>本阶段协作成员</span>
      <small>真人、Agent 与设备都保持独立身份</small>
    </div>
    <div class="process-team-list">
      ${unique.map(participantMarkup).join("")}
    </div>
  `;
}

function renderProcessBoard() {
  const stage = currentStage();
  if (!stage.steps.some((step) => step.id === activeProcessStep.id)) {
    activeProcessStep = stage.steps[0];
  }

  $("#stageTitle").textContent = stage.label;
  $("#stageDescription").textContent = stage.description;
  renderProcessTeam(stage);
  $("#stepAxis").innerHTML = stage.steps.map((step, index) => `
    <button class="step-axis-item ${step.id === activeProcessStep.id ? "is-active" : ""}" type="button" data-step-id="${step.id}">
      <span class="axis-number">${String(index + 1).padStart(2, "0")}</span>
      <span><strong>${escapeHtml(step.name)}</strong><small>${escapeHtml(step.status)} · ${escapeHtml(step.actor)}</small></span>
    </button>
  `).join("");

  const humanSteps = stage.steps.filter((step) => step.actorType === "human");
  const agentSteps = stage.steps.filter((step) => step.actorType === "agent");
  $("#humanLane").innerHTML = laneMarkup(stage.steps, "human");
  $("#agentLane").innerHTML = laneMarkup(stage.steps, "agent");
  $("#humanLane").setAttribute("aria-label", `${humanSteps.length} 个人工步骤`);
  $("#agentLane").setAttribute("aria-label", `${agentSteps.length} 个 Agent 步骤`);
}

function laneMarkup(steps, actorType) {
  return steps.map((step, index) => {
    const applies = step.actorType === actorType;
    if (!applies) {
      return `<div class="lane-step has-step-placeholder" aria-hidden="true"></div>`;
    }
    const participants = participantList(step);
    return `
      <button class="lane-step ${actorType} ${step.id === activeProcessStep.id ? "is-current" : ""} ${step.status === "已完成" ? "is-done" : ""}" type="button" data-step-id="${step.id}">
        <span class="lane-step-top">
          <strong>${String(index + 1).padStart(2, "0")} ${escapeHtml(step.name)}</strong>
          <span class="participant-stack">${participants.map((item) => `<i class="${item.type}" title="${escapeHtml(item.name)} · ${escapeHtml(item.role)}">${escapeHtml(item.avatar)}</i>`).join("")}</span>
        </span>
        <span class="participant-names">${participants.map((item) => `${escapeHtml(item.name)} · ${escapeHtml(item.role)}`).join(" + ")}</span>
        <p>${escapeHtml(step.agent === "暂不参与。" ? step.human : step.agent)}</p>
        <span class="lane-meta">
          <span class="actor-chip ${actorType}">${actorType === "human" ? "人工" : "Agent"}</span>
          <span class="status-chip ${step.status === "进行中" || step.status === "待确认" ? "waiting" : ""}">${escapeHtml(step.status)}</span>
        </span>
      </button>
    `;
  }).join("");
}

function configureDrawerFooter(mode, payload = {}) {
  const footer = $("#stepDrawer .drawer-footer");
  const stepButtons = ["#stepEvidenceButton", "#advanceStepButton"];
  const flowButtons = ["#addFlowStepButton", "#saveFlowButton"];
  footer.hidden = mode === "none";
  stepButtons.forEach((selector) => {
    const button = $(selector);
    button.hidden = mode !== "step";
  });
  flowButtons.forEach((selector) => {
    const button = $(selector);
    button.hidden = mode !== "flow";
  });
  const taskButton = $("#openTaskLaneButton");
  taskButton.hidden = mode !== "task";
  if (mode === "task" && payload.taskId) taskButton.dataset.taskId = payload.taskId;
  if (mode !== "task") delete taskButton.dataset.taskId;
}

function openStepDrawer(stepId) {
  const stage = currentStage();
  const step = stage.steps.find((item) => item.id === stepId);
  if (!step) return;
  activeProcessStep = step;
  renderProcessBoard();
  configureDrawerFooter("step");

  $("#stepDrawerKicker").textContent = `STEP ${String(stage.steps.indexOf(step) + 1).padStart(2, "0")} · ${stage.label}`;
  $("#stepDrawerTitle").textContent = step.name;
  $("#stepDrawerBody").innerHTML = `
    <section class="drawer-section">
      <div class="drawer-grid">
        <div class="drawer-fact"><span>步骤 ID</span><strong>${escapeHtml(step.id)}</strong></div>
        <div class="drawer-fact"><span>当前状态</span><strong>${escapeHtml(step.status)}</strong></div>
        <div class="drawer-fact"><span>责任方</span><strong>${escapeHtml(step.actor)}</strong></div>
        <div class="drawer-fact"><span>下一步</span><strong>${escapeHtml(step.next)}</strong></div>
      </div>
    </section>
    <section class="drawer-section"><h3>输入</h3><p>${escapeHtml(step.input)}</p></section>
    <section class="drawer-section"><h3>人做什么</h3><p>${escapeHtml(step.human)}</p></section>
    <section class="drawer-section"><h3>Agent 做什么</h3><p>${escapeHtml(step.agent)}</p></section>
    <section class="drawer-section"><h3>输出物</h3><p>${escapeHtml(step.output)}</p></section>
    <section class="drawer-section">
      <h3>人工确认点</h3>
      <div class="confirm-box">${escapeHtml(step.confirm)}</div>
    </section>
    <section class="drawer-section">
      <h3>依据与来源</h3>
      <ul class="plain-list">${step.evidence.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
    </section>
    <section class="drawer-section">
      <h3>权限范围</h3>
      <p>${escapeHtml(step.permission)}</p>
    </section>
    <section class="drawer-section">
      <h3>操作记录</h3>
      <ul class="plain-list">
        <li>2026-09-15 08:12 · Agent 草稿已生成</li>
        <li>2026-09-15 08:20 · 人工确认点等待处理</li>
      </ul>
    </section>
  `;

  const advanceButton = $("#advanceStepButton");
  advanceButton.disabled = step.status === "已完成";
  advanceButton.textContent = step.status === "已完成" ? "本步骤已完成" : "确认本步并推进";
  openDrawer("stepDrawer");
  $("#stepDrawer").setAttribute("aria-hidden", "false");
}

function openDailyTaskDrawer(taskId) {
  const task = dailyTasks.find((item) => item.id === taskId);
  if (!task) return;
  $("#stepDrawerKicker").textContent = `TASK · ${task.id}`;
  $("#stepDrawerTitle").textContent = task.title;
  $("#stepDrawerBody").innerHTML = `
    <section class="drawer-section">
      <div class="drawer-grid">
        <div class="drawer-fact"><span>当前状态</span><strong>${escapeHtml(task.status)}</strong></div>
        <div class="drawer-fact"><span>负责人</span><strong>${escapeHtml(task.owner)}</strong></div>
        <div class="drawer-fact"><span>协作 Agent</span><strong>${escapeHtml(task.agent)}</strong></div>
        <div class="drawer-fact"><span>所属流程</span><strong>${escapeHtml(task.flow)}</strong></div>
      </div>
    </section>
    <section class="drawer-section"><h3>任务来源</h3><p>${escapeHtml(task.source)}</p></section>
    <section class="drawer-section"><h3>当前节点</h3><p>${escapeHtml(task.node)}</p></section>
    <section class="drawer-section"><h3>输入</h3><p>${escapeHtml(task.input)}</p></section>
    <section class="drawer-section"><h3>输出</h3><p>${escapeHtml(task.output)}</p></section>
    <section class="drawer-section">
      <h3>人工确认点</h3>
      <div class="confirm-box">${escapeHtml(task.confirm)}</div>
    </section>
    <section class="drawer-section"><h3>下一步</h3><p>${escapeHtml(task.next)}</p></section>
  `;
  configureDrawerFooter("task", { taskId });
  openDrawer("stepDrawer");
  $("#stepDrawer").setAttribute("aria-hidden", "false");
}

function flowStepRowMarkup(step, index) {
  return `
    <div class="flow-step-editor-row" data-flow-step-row>
      <span class="flow-step-order">${String(index + 1).padStart(2, "0")}</span>
      <input class="flow-step-name" value="${escapeHtml(step.name || "")}" aria-label="环节名称">
      <select class="flow-step-actor" aria-label="执行方">
        <option value="human" ${step.actorType === "human" ? "selected" : ""}>人</option>
        <option value="agent" ${step.actorType === "agent" ? "selected" : ""}>Agent</option>
      </select>
      <button class="text-button" type="button" data-remove-flow-step>移除</button>
    </div>
  `;
}

function renumberFlowSteps() {
  $$("[data-flow-step-row]").forEach((row, index) => {
    row.querySelector(".flow-step-order").textContent = String(index + 1).padStart(2, "0");
  });
  const count = $$("[data-flow-step-row]", $("#stepDrawerBody")).length;
  const countPill = $("#stepDrawerBody .flow-editor-section-head .pending-pill");
  if (countPill) countPill.textContent = `${count} 个环节`;
}

function openFlowEditor(flowId = null) {
  const existing = processFlows.find((flow) => flow.id === flowId);
  const flow = existing
    ? JSON.parse(JSON.stringify(existing))
    : {
        id: `flow-custom-${Date.now()}`,
        name: "新建流程",
        subtitle: "设备运维｜自定义流程",
        trigger: "说明触发条件",
        owner: "设备运维 Agent",
        status: "草稿",
        updated: DEMO_TIME.slice(0, 10),
        steps: [{ name: "新环节", actorType: "agent" }]
      };
  currentEditingFlowId = flow.id;
  $("#stepDrawerKicker").textContent = existing ? `FLOW · ${flow.id}` : "NEW FLOW";
  $("#stepDrawerTitle").textContent = existing ? `编辑 ${flow.name}` : "新建执行流程";
  $("#stepDrawerBody").innerHTML = `
    <section class="drawer-section">
      <div class="flow-editor-fields">
        <label><span>流程名称</span><input id="flowNameInput" value="${escapeHtml(flow.name)}"></label>
        <label><span>分类</span><input id="flowSubtitleInput" value="${escapeHtml(flow.subtitle)}"></label>
        <label><span>执行 Agent</span><input id="flowOwnerInput" value="${escapeHtml(flow.owner)}"></label>
        <label class="span-2"><span>触发条件</span><textarea id="flowTriggerInput" rows="2">${escapeHtml(flow.trigger)}</textarea></label>
      </div>
    </section>
    <section class="drawer-section">
      <div class="flow-editor-section-head">
        <div>
          <h3>执行环节</h3>
          <small>每个环节可以指定人工或 Agent 执行</small>
        </div>
        <span class="pending-pill">${flow.steps.length} 个环节</span>
      </div>
      <div class="flow-step-editor">
        ${flow.steps.map(flowStepRowMarkup).join("")}
      </div>
    </section>
  `;
  configureDrawerFooter("flow");
  openDrawer("stepDrawer");
  $("#stepDrawer").setAttribute("aria-hidden", "false");
}

function addFlowStepRow() {
  const editor = $("#stepDrawerBody .flow-step-editor");
  if (!editor) return;
  editor.insertAdjacentHTML("beforeend", flowStepRowMarkup({ name: "新环节", actorType: "agent" }, editor.children.length));
  renumberFlowSteps();
  editor.lastElementChild.querySelector(".flow-step-name")?.focus();
}

function saveFlowEditor() {
  const flow = processFlows.find((item) => item.id === currentEditingFlowId);
  const name = $("#flowNameInput")?.value.trim();
  const rows = $$("[data-flow-step-row]", $("#stepDrawerBody"));
  if (!name) {
    showToast("请先填写流程名称");
    return;
  }
  if (rows.length === 0) {
    showToast("流程至少需要一个执行环节");
    return;
  }
  const nextFlow = {
    id: currentEditingFlowId,
    name,
    subtitle: $("#flowSubtitleInput").value.trim() || "设备运维｜自定义流程",
    trigger: $("#flowTriggerInput").value.trim() || "待补充触发条件",
    owner: $("#flowOwnerInput").value.trim() || "设备运维 Agent",
    status: flow?.status || "草稿",
    updated: DEMO_TIME.slice(0, 10),
    steps: rows.map((row) => ({
      name: row.querySelector(".flow-step-name").value.trim() || "未命名环节",
      actorType: row.querySelector(".flow-step-actor").value
    }))
  };
  nextFlow.stepCount = nextFlow.steps.length;
  if (flow) {
    processFlows[processFlows.indexOf(flow)] = nextFlow;
    showToast(`流程“${name}”已保存`);
  } else {
    processFlows.push(nextFlow);
    showToast(`流程“${name}”已创建`);
  }
  renderFlowLibrary();
  closeDrawer("stepDrawer");
}

function openQueueDetailDrawer(queueId) {
  const item = taskQueue.find((queue) => queue.id === queueId);
  if (!item) return;
  $("#stepDrawerKicker").textContent = `QUEUE · ${item.id}`;
  $("#stepDrawerTitle").textContent = item.title;
  $("#stepDrawerBody").innerHTML = `
    <section class="drawer-section">
      <div class="drawer-grid">
        <div class="drawer-fact"><span>队列状态</span><strong>${escapeHtml(item.status)}</strong></div>
        <div class="drawer-fact"><span>队列位置</span><strong>${escapeHtml(item.queuePosition)}</strong></div>
        <div class="drawer-fact"><span>执行 Agent</span><strong>${escapeHtml(item.owner)}</strong></div>
        <div class="drawer-fact"><span>关联设备 / 产线</span><strong>${escapeHtml(item.device)}</strong></div>
      </div>
    </section>
    <section class="drawer-section"><h3>当前节点</h3><p>${escapeHtml(item.currentStep)}</p></section>
    <section class="drawer-section"><h3>预计时间</h3><p>${escapeHtml(item.eta)}</p></section>
    <section class="drawer-section">
      <button class="primary-button" type="button" data-queue-execute="${escapeHtml(item.id)}">进入执行泳道</button>
    </section>
  `;
  configureDrawerFooter("none");
  openDrawer("stepDrawer");
  $("#stepDrawer").setAttribute("aria-hidden", "false");
}

function boostQueueTask(queueId) {
  const item = taskQueue.find((queue) => queue.id === queueId);
  if (!item || item.status === "执行中") return;
  item.priority = "加急";
  const running = taskQueue.filter((queue) => queue.status === "执行中");
  const waiting = taskQueue.filter((queue) => queue.status !== "执行中" && queue.id !== queueId);
  waiting.unshift(item);
  waiting.forEach((queue, index) => {
    queue.queuePosition = `第 ${index + 1} 位`;
  });
  taskQueue.splice(0, taskQueue.length, ...running, ...waiting);
  renderTaskQueue();
  showToast(`${item.title} 已加急到等待队列首位`);
}

/* 🔴 抽屉是 position:fixed 的右侧浮层，直接盖在内容上。
   打开时给 <body> 挂上 has-drawer，样式里主内容会整块让开抽屉那一列，
   五步泳道不会再被压掉第 04、05 步。关闭时把标记摘掉。 */
function openDrawer(id) {
  const drawer = document.getElementById(id);
  if (!drawer) return;
  drawer.classList.add("is-open");
  drawer.setAttribute("aria-hidden", "false");
  document.body.classList.add("has-drawer");
}

function closeDrawer(id) {
  const drawer = document.getElementById(id);
  if (!drawer) return;
  drawer.classList.remove("is-open");
  drawer.setAttribute("aria-hidden", "true");
  if (!document.querySelector(".drawer.is-open")) document.body.classList.remove("has-drawer");
}

function advanceStep() {
  const stage = currentStage();
  const index = stage.steps.findIndex((step) => step.id === activeProcessStep.id);
  if (index < 0) return;
  stage.steps[index].status = "已完成";
  if (stage.steps[index + 1]) {
    stage.steps[index + 1].status = "进行中";
    activeProcessStep = stage.steps[index + 1];
  } else {
    activeProcessStep = stage.steps[index];
  }
  renderProcessBoard();
  openStepDrawer(activeProcessStep.id);
  showToast(index + 1 < stage.steps.length ? `步骤已确认，已推进到第 ${index + 2} 步` : "该阶段所有步骤已完成");
}

function isDeviceId(id) {
  return masterData.devices.some((device) => device.id === String(id));
}

function dashboardData() {
  return buildDashboard(dashboardView, boardFilters);
}

/* 🔴 筛选器是**按数据现生成**的：某个维度在演示数据里只有一个取值，
   boardActiveDimensions() 就不会把它吐出来，这里也就不会画那个下拉。
   不留永远只有一个选项的死筛选器；被拿掉的维度在下面一行小字里交代清楚。 */
function renderDashboardFilters() {
  const dimensions = [
    { key: "period", label: "时间范围", options: boardPeriods.map((item) => ({ value: item.value, label: item.label })) },
    ...boardActiveDimensions()
  ];
  const fixed = boardFixedDimensions();
  const defaults = boardFilterDefaults();
  const dirty = Object.keys(defaults).some((key) => boardFilters[key] !== defaults[key]);
  $("#dashboardFilters").innerHTML = `
    ${dimensions.map((dimension) => `
      <label><span>${escapeHtml(dimension.label)}</span>
        <select data-board-filter="${escapeHtml(dimension.key)}" aria-label="${escapeHtml(dimension.label)}">
          ${dimension.options.map((option) => `<option value="${escapeHtml(option.value)}"${boardFilters[dimension.key] === option.value ? " selected" : ""}>${escapeHtml(option.label)}</option>`).join("")}
        </select>
      </label>
    `).join("")}
    <div class="filter-result"><span>当前筛选</span><strong id="dashboardScope"></strong></div>
    ${dirty ? '<button class="text-button filter-reset" type="button" data-board-filter-reset>清除筛选</button>' : ""}
    ${fixed.length ? `<p class="filter-note">${escapeHtml(fixed.map((item) => `${item.label}：${item.value}`).join(" · "))}　—　示例数据里只有一个取值，没有做成筛选项</p>` : ""}
  `;
}

function resetBoardFilters() {
  boardFilters = boardFilterDefaults();
  renderDashboard();
  showToast("已清除筛选，回到全部范围");
}

function renderDashboard() {
  const data = dashboardData();
  renderDashboardFilters();
  $("#dashboardScope").textContent = data.scope;
  $("#dashboardEmpty").hidden = !data.empty;
  $("#dashboardResult").hidden = Boolean(data.empty);
  if (data.empty) {
    $("#dashboardEmptyTitle").textContent = data.emptyTitle;
    $("#dashboardEmptyHint").textContent = data.emptyHint;
    $("#dashboardDrilldown").classList.add("is-collapsed");
    return;
  }
  $("#kpiGrid").innerHTML = data.kpis.map(({ label, value, change, source, metric }) => `
    <button class="kpi-card" type="button" data-metric="${escapeHtml(metric)}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(change)}</small>
      <span class="kpi-source"><span>${escapeHtml(source)}</span><span>查看依据 →</span></span>
    </button>
  `).join("");

  $("#trendTitle").textContent = data.trend.title;
  $("#trendValue").textContent = data.trend.value;
  $("#trendDelta").textContent = data.trend.delta;
  $("#trendSubtitle").textContent = data.trend.subtitle || "";
  renderLineChart(data.trend.values, data.trend.labels, data.trend);

  $("#statusTitle").textContent = data.status.title;
  $("#statusTotal").textContent = String(data.status.total);
  renderDonut(data.status.rows, data.status.totalLabel || "设备总数");
  $("#statusEmpty").hidden = data.status.rows.length > 0;
  $("#statusEmpty").textContent = data.status.emptyNote || "";

  $("#barsTitle").textContent = data.bars.title;
  $("#barsEmpty").hidden = data.bars.rows.length > 0;
  $("#barsEmpty").textContent = data.bars.emptyNote || "";
  $("#utilizationBars").innerHTML = data.bars.rows.map((row) => {
    const deviceId = isDeviceId(row.label) ? row.label : "";
    const tagName = deviceId ? "button" : "div";
    const actionAttrs = deviceId
      ? ` type="button" data-dashboard-entity="device" data-entity-id="${escapeHtml(deviceId)}" aria-label="查看 ${escapeHtml(deviceId)} 设备详情"`
      : "";
    return `
      <${tagName} class="bar-row ${deviceId ? "bar-row-action" : "bar-row-reference"}"${actionAttrs}>
        <span>${escapeHtml(row.label)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${Number(row.value)}%"></span></span>
        <strong>${escapeHtml(row.text)}</strong>
        ${row.note ? `<small>${escapeHtml(row.note)}</small>` : ""}
      </${tagName}>
    `;
  }).join("");

  $("#taskTitle").textContent = data.tasks.title;
  $("#taskMetrics").innerHTML = data.tasks.rows.map(([label, value, note]) => `
    <button class="task-metric" type="button" data-metric="${escapeHtml(label)}">
      <span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small>
    </button>
  `).join("");
  // 默认明细：跟着筛选走，别把上一次的标题留在那儿。
  $("#drilldownTitle").textContent = `${data.drilldownTitle} · ${data.scope}`;
  $("#drilldownBasis").innerHTML = metricBasisMarkup(data.kpis[0]?.metric || "设备总数", data);
  renderDeviceTable(data.table);
}

function renderLineChart(values, labels = values.map(() => ""), options = {}) {
  const width = 620;
  const height = 200;
  const pad = { top: 18, right: 18, bottom: 28, left: 34 };
  const numericValues = values.map(Number);
  const floor = options.min ?? Math.floor((Math.min(...numericValues) - 2) / 5) * 5;
  const ceiling = options.max ?? Math.ceil((Math.max(...numericValues) + 2) / 5) * 5;
  const range = Math.max(1, ceiling - floor);
  const step = values.length > 1 ? (width - pad.left - pad.right) / (values.length - 1) : 0;
  const xs = values.map((_, index) => pad.left + index * step);
  const ys = numericValues.map((value) => pad.top + (ceiling - value) * ((height - pad.top - pad.bottom) / range));
  const points = xs.map((x, index) => `${x},${ys[index]}`).join(" ");
  const area = `${pad.left},${height - pad.bottom} ${points} ${width - pad.right},${height - pad.bottom}`;
  const axisValues = [ceiling, floor + range / 2, floor];
  const unit = options.unit || "";

  $("#lineChart").innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" aria-hidden="true">
      ${axisValues.map((value) => {
        const y = pad.top + (ceiling - value) * ((height - pad.top - pad.bottom) / range);
        return `<line class="grid-line" x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}"></line><text class="axis-label" x="2" y="${y + 3}">${Number.isInteger(value) ? value : value.toFixed(1)}${unit}</text>`;
      }).join("")}
      <polygon class="trend-area" points="${area}"></polygon>
      <polyline class="trend-line" points="${points}"></polyline>
      ${xs.map((x, index) => `<circle class="trend-point" cx="${x}" cy="${ys[index]}" r="4"><title>${escapeHtml(labels[index])}：${numericValues[index]}${unit}</title></circle><text class="axis-label" x="${x}" y="${height - 7}" text-anchor="middle">${escapeHtml(labels[index])}</text>`).join("")}
    </svg>
  `;
}

function renderDonut(status, totalLabel = "设备总数") {
  let cursor = 0;
  const stops = status.map(([, , percent, color]) => {
    const start = cursor;
    cursor += Number.parseInt(percent, 10);
    return `${color} ${start}% ${cursor}%`;
  });
  $("#statusDonut").style.background = `conic-gradient(${stops.join(",")})`;
  $("#statusLegend").innerHTML = status.map(([label, value, percent, color]) => {
    const filterValue = label;
    return `
      <button class="legend-row" type="button" data-metric="设备状态" data-status-filter="${escapeHtml(filterValue)}">
        <i style="background:${color}"></i><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)} · ${escapeHtml(percent)}</strong>
      </button>
    `;
  }).join("");
  $("#statusDonut span small").textContent = totalLabel;
}

function dashboardEntityType(id) {
  if (isDeviceId(id)) return "device";
  if (/^WO-/i.test(id)) return "workorder";
  if (/^TASK-/i.test(id)) return "task";
  if (/^QUEUE-/i.test(id)) return "task";
  return "";
}

function renderDeviceTable(table, options = {}) {
  const source = table || { head: [], rows: [] };
  $("#deviceTableHead").innerHTML = `<tr>${source.head.map((heading) => `<th>${escapeHtml(heading)}</th>`).join("")}</tr>`;
  const visibleRows = source.rows.filter((row) => !options.statusFilter || row.includes(options.statusFilter));
  const emptySlot = $("#drilldownEmpty");
  if (emptySlot) {
    // 🔴 筛到空集合不许留一张只有表头的空表：说清楚是"这个范围里没有"，并给出口。
    emptySlot.hidden = visibleRows.length > 0;
    emptySlot.innerHTML = visibleRows.length
      ? ""
      : `${escapeHtml(source.emptyNote || "这个筛选范围里没有可显示的记录。")} <button class="text-button" type="button" data-board-filter-reset>清除筛选</button>`;
  }
  $("#deviceTable").innerHTML = source.rows
    .filter((row) => !options.statusFilter || row.includes(options.statusFilter))
    .map((row) => {
      const entityId = String(row[0] || "");
      const entityType = source.entityType || dashboardEntityType(entityId);
      const action = entityType ? ` data-dashboard-entity="${entityType}" data-entity-id="${escapeHtml(entityId)}" tabindex="0"` : "";
      return `
        <tr data-device="${escapeHtml(entityId)}" class="${entityType ? "is-clickable" : ""}"${action}>
          ${row.map((cell, index) => `<td class="${index === 0 ? "table-device" : ""}">${escapeHtml(cell)}</td>`).join("")}
        </tr>
      `;
    }).join("");
}

function metricBasisMarkup(metric, data) {
  const definitions = {
    设备总数: "当前筛选条件命中的设备去重计数",
    开机率: "所选范围内逐日开机率（运行时长 / 计划可用时长）的均值",
    利用率: "所选范围内逐日利用率（实际使用工时 / 可用工时）的均值",
    产能达成率: "所选范围内逐日产能达成率（实际产量 / 计划产量）的均值",
    待处理工单: "所选范围内 opened ≤ 截止日且尚未闭环的工单计数",
    已闭环任务: "闭环日期落在所选时间范围内的任务计数",
    平均闭环时长: "所选范围内已闭环任务的 (闭环日 − 开单日) 均值",
    人工确认节点: "未闭环工单里不可跳过的人工确认节点计数",
    设备状态: "所选时间范围内，逐日运行记录按当天状态分组"
  };
  const kpi = data.kpis.find((item) => item.metric === metric);
  return `
    <div><span>统计范围</span><strong>${escapeHtml(data.scope)}</strong></div>
    <div><span>计算公式</span><strong>${escapeHtml(definitions[metric] || `${metric}按当前看板统一口径计算`)}</strong></div>
    <div><span>数据来源</span><strong>${escapeHtml(kpi?.source || "设备台账 / 设备流程")}</strong></div>
    <div><span>更新时间</span><strong>${DEMO_TIME}</strong></div>
  `;
}

function openMetric(metric, options = {}) {
  const data = dashboardData();
  const table = data.drilldowns?.[metric] || data.table;
  const titleSuffix = options.statusFilter ? ` · ${options.statusFilter}` : "";
  $("#drilldownTitle").textContent = `${metric}${titleSuffix} · ${table.title || data.drilldownTitle || "设备明细"}`;
  $("#drilldownBasis").innerHTML = metricBasisMarkup(metric, data);
  renderDeviceTable(table, options);
  $("#dashboardDrilldown").classList.remove("is-collapsed");
  const toggle = $("[data-close-drilldown]");
  if (toggle) toggle.textContent = "收起明细";
  $("#dashboardDrilldown").scrollIntoView({ behavior: "smooth", block: "start" });
}

function deviceStatusClass(status) {
  if (status.includes("运行")) return "running";
  if (status.includes("保养")) return "maintenance";
  if (status.includes("维修")) return "repair";
  if (status.includes("停机")) return "stopped";
  return "idle";
}

function deviceDetailMarkup(device) {
  const timeline = device.timeline.map(([start, end, type, label]) => {
    const left = Math.max(0, Number(start) / 24 * 100);
    const width = Math.max(0, (Number(end) - Number(start)) / 24 * 100);
    return `<span class="runtime-segment ${type}" style="left:${left}%;width:${width}%" title="${escapeHtml(`${start}:00-${end}:00 ${label}`)}"><i>${escapeHtml(label)}</i></span>`;
  }).join("");
  const firstOrder = device.events.find((event) => event.order !== "-")?.order || "";
  return `
    <section class="device-detail-hero">
      <div class="device-detail-identity">
        <span class="device-detail-id">${escapeHtml(device.id)}</span>
        <div>
          <span class="section-kicker">EQUIPMENT DETAIL</span>
          <h1 id="deviceDetailTitle">${escapeHtml(device.id)}｜设备详情</h1>
          <p>${escapeHtml(device.name)} · ${escapeHtml(device.line)}</p>
        </div>
        <span class="device-detail-status ${deviceStatusClass(device.status)}"><i></i>${escapeHtml(device.status)}</span>
      </div>
      <dl class="device-detail-meta">
        <div><dt>设备 Owner</dt><dd>${escapeHtml(device.owner)}</dd></div>
        <div><dt>更新时间</dt><dd>${escapeHtml(device.updated)}</dd></div>
        <div><dt>数据范围</dt><dd>2026-09-15 00:00 - 10:30</dd></div>
      </dl>
      <p class="device-detail-summary">${escapeHtml(device.summary)}</p>
    </section>

    <section class="device-detail-metrics" aria-label="${escapeHtml(device.id)} 关键指标">
      ${device.metrics.map(([label, value, note]) => `
        <article>
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(value)}</strong>
          <small>${escapeHtml(note)}</small>
        </article>
      `).join("")}
    </section>

    <div class="device-detail-grid">
      <section class="panel device-timeline-panel">
        <div class="panel-head">
          <div>
            <span class="section-kicker">RUNTIME TIMELINE</span>
            <h2>今日运行时间轴</h2>
          </div>
          <span class="pending-pill">24 小时视图</span>
        </div>
        <div class="runtime-timeline">
          <div class="runtime-track">${timeline}</div>
          <div class="runtime-axis"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span></div>
        </div>
        <div class="runtime-legend">
          <span><i class="running"></i>运行</span>
          <span><i class="idle"></i>空闲</span>
          <span><i class="maintenance"></i>保养</span>
          <span><i class="repair"></i>维修</span>
          <span><i class="stopped"></i>停机</span>
        </div>
      </section>

      <section class="panel device-events-panel">
        <div class="panel-head">
          <div>
            <span class="section-kicker">EVENT LEDGER</span>
            <h2>事件流水</h2>
          </div>
          <span class="pending-pill">${device.events.length} 条记录</span>
        </div>
        <div class="table-wrap">
          <table class="device-event-table">
            <thead><tr><th>时间</th><th>事件</th><th>持续</th><th>执行方</th><th>关联单据</th><th>状态 / 备注</th></tr></thead>
            <tbody>
              ${device.events.map((event) => `
                <tr>
                  <td>${escapeHtml(event.time)}</td>
                  <td><strong>${escapeHtml(event.type)}</strong></td>
                  <td>${escapeHtml(event.duration)}</td>
                  <td>${escapeHtml(event.actor)}</td>
                  <td>${event.order === "-" ? "-" : `<button class="table-link" type="button" data-device-order="${escapeHtml(event.order)}">${escapeHtml(event.order)}</button>`}</td>
                  <td><span class="event-status">${escapeHtml(event.status)}</span><small>${escapeHtml(event.note)}</small></td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </section>
    </div>

    <div class="device-detail-lower">
      <section class="panel device-basis-panel">
        <div class="panel-head">
          <div>
            <span class="section-kicker">METRIC BASIS</span>
            <h2>指标依据</h2>
          </div>
          <span class="pending-pill">可追溯</span>
        </div>
        <dl class="device-basis-grid">
          <div><dt>统计范围</dt><dd>${escapeHtml(device.basis.scope)}</dd></div>
          <div><dt>计算公式</dt><dd>${escapeHtml(device.basis.formula)}</dd></div>
          <div><dt>原始记录</dt><dd>${escapeHtml(device.basis.source)}</dd></div>
          <div><dt>记录数量</dt><dd>${escapeHtml(device.basis.records)}</dd></div>
          <div><dt>数据更新时间</dt><dd>${escapeHtml(device.basis.updated)}</dd></div>
        </dl>
      </section>

      <section class="panel device-related-panel">
        <div class="panel-head">
          <div>
            <span class="section-kicker">RELATED ENTRY</span>
            <h2>相关入口</h2>
          </div>
        </div>
        <div class="device-related-actions">
          ${firstOrder ? `<button class="secondary-button" type="button" data-device-order="${escapeHtml(firstOrder)}">查看关联单据</button>` : ""}
          <button class="secondary-button" type="button" data-device-action="process">查看设备流程</button>
          <button class="secondary-button" type="button" data-device-action="ask">在设备专家中提问</button>
        </div>
      </section>
    </div>
  `;
}

function openDeviceDetail(deviceId) {
  const device = deviceDetailData[deviceId];
  if (!device) {
    showToast(`${deviceId} 的设备详情数据待补充`);
    return;
  }
  dashboardReturnScroll = window.scrollY;
  activeDashboardDevice = deviceId;
  $("#dashboardOverview").hidden = true;
  $("#deviceDetailPage").hidden = false;
  $("#deviceDetailBreadcrumb").textContent = `数据看板 · ${deviceId}｜设备详情`;
  $("#deviceDetailUpdated").textContent = `更新于 ${device.updated.split(" ")[1] || "10:30"}`;
  $("#deviceDetailContent").innerHTML = deviceDetailMarkup(device);
  window.scrollTo({ top: 0, behavior: "auto" });
}

function closeDeviceDetail(options = {}) {
  if ($("#deviceDetailPage").hidden) return;
  $("#deviceDetailPage").hidden = true;
  $("#dashboardOverview").hidden = false;
  activeDashboardDevice = null;
  if (options.restoreScroll !== false) {
    requestAnimationFrame(() => window.scrollTo({ top: dashboardReturnScroll, behavior: "auto" }));
  }
}

function openDashboardEntity(entityType, entityId) {
  if (entityType === "device") {
    // 🔴 先切到数据看板那一栏，再开详情（第二轮反馈）。
    // 设备详情页 #deviceDetailPage 长在 #view-dashboard 里头，从工作台点
    // 「最近查看的设备」时只把它 unhide，外面那一层还是藏着的 —— 点下去
    // 界面一动不动，看着就像跳转没做。她的原话：「设备的话，它是要跳转到
    // 数据看板里头指定设备的那一个二级页面的详细信息」。
    openApp("dashboard");
    openDeviceDetail(entityId);
    return;
  }
  if (entityType === "workorder" || /^WO-/i.test(entityId)) {
    openApp("process");
    setProcessCase("workorder");
    processDetailMode = "focus";
    setProcessView("workorder");
    showToast(`已打开关联工单 ${entityId}`);
    return;
  }
  if (entityType === "task" || /^TASK-/i.test(entityId)) {
    const task = dailyTasks.find((item) => item.id === entityId);
    openApp("process");
    if (task) {
      setProcessCase(ensureDailyTaskCase(entityId));
      processDetailMode = "focus";
      setProcessView("workorder");
      showToast(`已打开关联任务 ${entityId}`);
    } else {
      setProcessView("tasks");
      window.setTimeout(() => openDailyTaskDrawer(entityId), 60);
    }
    return;
  }
  openApp("process");
  setProcessView("queue");
}

function renderGraphChips() {
  $("#entryChips").innerHTML = graphEntryTypes.map(({ mode, label }) => `
    <button class="entry-chip ${graphMode === mode ? "is-active" : ""}" type="button" data-graph-mode="${mode}">${escapeHtml(label)}</button>
  `).join("");
}

function renderGraphFocusStrip() {
  const strip = $("#graphFocusStrip");
  if (!strip) return;
  const deviceIds = ["AR-203", "AR-204", "LR-205"];
  strip.hidden = graphMode !== "device";
  strip.innerHTML = `
    <span>设备中心节点</span>
    ${deviceIds.map((id) => `
      <button class="entry-chip ${graphFocusId === id ? "is-active" : ""}" type="button" data-graph-focus="${id}">
        ${escapeHtml(graphNodes[id]?.label || id)}
      </button>
    `).join("")}
  `;
}

function graphNodeByLabel(label) {
  return Object.values(graphNodes).find((candidate) => candidate.label === label);
}

function graphNeighborIds(nodeId) {
  const node = graphNodes[nodeId];
  if (!node) return [];
  return [...new Set(node.relations
    .map(([, targetLabel]) => graphNodeByLabel(targetLabel)?.id)
    .filter(Boolean))];
}

function graphNodeIds() {
  const allIds = graphModeNodes[graphMode] || Object.keys(graphNodes);
  const root = graphNodes[graphFocusId] ? graphFocusId : graphRoots[graphMode];
  if (graphCollapsed) {
    return [root].filter((id) => graphTypeVisibility[graphNodes[id]?.type] !== false);
  }

  const visible = new Set([root]);
  const deviceOverview = graphMode === "device" && graphExpandedIds.size === 0;
  if (graphMode === "device") {
    ["AR-203", "AR-204", "LR-205"].forEach((id) => {
      if (graphNodes[id]) visible.add(id);
    });
  }
  if (!deviceOverview) {
    graphExpandedIds.forEach((id) => graphNeighborIds(id).forEach((neighborId) => visible.add(neighborId)));
  }
  return allIds.filter((id) => visible.has(id) && graphTypeVisibility[graphNodes[id]?.type] !== false);
}

function nearestGraphPathIndex(nodeId) {
  for (let index = graphActivePath.length - 1; index >= 0; index -= 1) {
    if (graphNeighborIds(graphActivePath[index]).includes(nodeId)) return index;
  }
  return -1;
}

function toggleGraphExpansion(nodeId) {
  if (!graphNodes[nodeId]) return;
  graphCollapsed = false;
  selectedGraphNode = nodeId;

  if (graphExpandedIds.has(nodeId)) {
    graphExpandedIds.delete(nodeId);
    const pathIndex = graphActivePath.indexOf(nodeId);
    if (pathIndex >= 0) {
      graphActivePath.slice(pathIndex + 1).forEach((id) => graphExpandedIds.delete(id));
      graphActivePath = graphActivePath.slice(0, pathIndex);
    }
  } else {
    const nearestIndex = nearestGraphPathIndex(nodeId);
    graphActivePath = nearestIndex >= 0
      ? [...graphActivePath.slice(0, nearestIndex + 1), nodeId]
      : graphMode === "device" ? [nodeId] : [graphFocusId, nodeId];
    graphExpandedIds.add(nodeId);
  }
  renderGraph();
}

function graphHighlightIds(ids) {
  const idSet = new Set(ids);
  const visiblePath = graphActivePath.filter((id) => idSet.has(id));
  if (visiblePath.length === 0) return idSet;
  const highlighted = new Set(visiblePath);
  graphNeighborIds(visiblePath[visiblePath.length - 1]).forEach((id) => {
    if (idSet.has(id)) highlighted.add(id);
  });
  return highlighted;
}

/* 卡片尺寸 —— 与 renderGraph 里画矩形用的 nodeWidth/nodeHeight 一致。
   分两处写死过一次就会悄悄错开，卡片开始互相压。 */
const GRAPH_NODE_W = 190;
const GRAPH_NODE_H = 64;
/** 两张卡片中心靠得比这更近就算压在一起。 */
const GRAPH_GAP_X = 46;
const GRAPH_GAP_Y = 34;
/** 父节点 → 新子节点的基准距离。 */
const GRAPH_RING = 290;
/** 卡片到画布边缘的余量（卡片坐标是中心点，先扣掉一半宽高）。 */
const GRAPH_PAD_X = GRAPH_NODE_W / 2 + 40;
const GRAPH_PAD_Y = GRAPH_NODE_H / 2 + 40;
/** 根节点上方预留多少地方 —— 新节点不许摆到这条线以上，否则画布得往上长，全图就得挪。 */
const GRAPH_UP_RESERVE = 230;

function graphSpotTaken(x, y) {
  for (const spot of graphPositions.values()) {
    if (Math.abs(spot.x - x) < GRAPH_NODE_W + GRAPH_GAP_X
      && Math.abs(spot.y - y) < GRAPH_NODE_H + GRAPH_GAP_Y) return true;
  }
  return false;
}

/* 给一个新露面的节点找空位：挂在把它带出来的那个节点旁边，方向朝外（向右）。
   先顺着"外"的方向放，占了就上下交替扇开，还占就往外挪一圈。
   🔴 只往右半边长，且不许越过根节点上方那条预留线 —— 这样画布永远只从右边和
      下边变大，已经摆好的卡片坐标一个都不用改。图能往左上角长，就等于每次
      展开都要把整张图平移一次，那正是反馈里说的"乱跳"。 */
function graphFindSpot(anchor, base) {
  const fan = [0, 1, -1, 2, -2, 3, -3, 4];
  for (const ringScale of [1, 1.4, 1.8, 2.3]) {
    for (const step of fan) {
      const angle = base + (step * Math.PI) / 9;
      if (Math.cos(angle) < 0.15) continue; // 只朝右
      const x = anchor.x + Math.cos(angle) * GRAPH_RING * ringScale;
      const y = anchor.y + Math.sin(angle) * GRAPH_RING * ringScale;
      if (y < -GRAPH_UP_RESERVE) continue;
      if (!graphSpotTaken(x, y)) return { x, y };
    }
  }
  return { x: anchor.x + GRAPH_RING * 2.8, y: Math.max(anchor.y, -GRAPH_UP_RESERVE) };
}

/* 知识图谱的位置这样定：
   ① 一个节点的位置**只算一次**，之后记在 graphPositions 里再也不动；
   ② 新露面的节点才现找空位，而且只往右/下长；
   ③ 画布（viewBox）只涨不缩，也只从右边和下边涨。
   三条合起来的效果：展开、收起、切筛选，任何一张已经在图上的卡片都不挪一个像素。
   原来的做法是每次渲染都拿"当前看得见的那批节点"重算一遍环形布局 —— 多展开一个
   节点，那一层的个数变了，角度全变，整张图一起挪位，看的人以为自己点错了。
   只有换图谱类型、换聚焦对象、点「重置视图」才会整个重摆。 */
function layoutGraphNodes(nodes, rootId) {
  const layoutKey = `${graphMode}|${rootId}`;
  if (layoutKey !== graphLayoutKey) {
    graphLayoutKey = layoutKey;
    graphPositions.clear();
    graphCanvas = { width: 0, height: 0 };
  }

  const visible = new Set(nodes.map((node) => node.id));
  const root = visible.has(rootId) ? rootId : nodes[0]?.id;
  if (!root) return { width: 1000, height: 620 };
  if (!graphPositions.has(root)) graphPositions.set(root, { x: 0, y: 0 });

  /* 从根按广度优先铺开，只走**看得见**的节点：新节点挂在把它带出来的那个旁边。
     跟根连不上的（被类型筛选切断了路径）最后统一挂在根的右边。 */
  const parentOf = new Map();
  const seen = new Set([root]);
  const queue = [root];
  while (queue.length) {
    const current = queue.shift();
    const anchor = graphPositions.get(current);
    /* "往外"＝一律朝正右方，不继承父节点的斜度。
       继承斜度会一代比一代更斜，整张图顺着对角线滑下去，右上角空一大片。
       固定朝右，每深一层就自然多一列，看起来就是"一层一层展开"。 */
    const base = 0;
    for (const neighbor of graphNeighborIds(current)) {
      if (!visible.has(neighbor) || seen.has(neighbor)) continue;
      seen.add(neighbor);
      parentOf.set(neighbor, current);
      if (!graphPositions.has(neighbor)) graphPositions.set(neighbor, graphFindSpot(anchor, base));
      queue.push(neighbor);
    }
  }
  const rootSpot = graphPositions.get(root);
  nodes.forEach((node) => {
    if (!graphPositions.has(node.id)) graphPositions.set(node.id, graphFindSpot(rootSpot, Math.PI / 3));
  });

  // 世界坐标 → 画布坐标。原点钉死在"根的左上角 + 预留"，所以坐标是常数。
  const originX = -GRAPH_PAD_X;
  const originY = -GRAPH_UP_RESERVE - GRAPH_PAD_Y;
  let right = 0;
  let bottom = 0;
  nodes.forEach((node) => {
    const spot = graphPositions.get(node.id);
    node.x = spot.x - originX;
    node.y = spot.y - originY;
    right = Math.max(right, node.x + GRAPH_PAD_X);
    bottom = Math.max(bottom, node.y + GRAPH_PAD_Y);
  });
  graphCanvas = {
    width: Math.max(graphCanvas.width, 1000, Math.ceil(right / 120) * 120),
    height: Math.max(graphCanvas.height, 620, Math.ceil(bottom / 120) * 120),
  };
  return graphCanvas;
}

function renderGraph() {
  renderGraphChips();
  renderGraphFocusStrip();
  const ids = graphNodeIds();
  const focus = graphNodes[graphFocusId] ? graphFocusId : graphRoots[graphMode];
  graphFocusId = focus;
  const active = graphNodes[selectedGraphNode] ? selectedGraphNode : focus;
  selectedGraphNode = ids.includes(active) ? active : ids.includes(focus) ? focus : ids[0];
  const nodes = ids.map((id) => graphNodes[id]).filter(Boolean);
  if (nodes.length === 0) {
    $("#graphSvg").innerHTML = "";
    $("#graphMapTitle").textContent = "当前筛选下暂无节点";
    return;
  }
  const highlightedIds = graphHighlightIds(ids);
  const pathIds = new Set(graphActivePath.filter((id) => ids.includes(id)));
  const svg = $("#graphSvg");
  const edgeSet = new Set();
  const edges = [];

  nodes.forEach((node) => {
    node.relations.forEach(([relation, targetLabel]) => {
      const target = nodes.find((candidate) => candidate.label === targetLabel);
      if (!target) return;
      const key = [node.id, target.id].sort().join("|");
      if (edgeSet.has(key)) return;
      edgeSet.add(key);
      const pending = node.status === "待确认" || target.status === "待确认";
      edges.push({ source: node, target, relation, pending });
    });
  });

  const { width, height } = layoutGraphNodes(nodes, focus);
  const scale = graphZoom;
  const transform = `translate(${width / 2 - (width / 2) * scale} ${height / 2 - (height / 2) * scale}) scale(${scale})`;
  // 跟布局用的是同一组尺寸 —— 分成两份写死过一次就会悄悄错开，卡片开始互相压。
  const nodeWidth = GRAPH_NODE_W;
  const nodeHeight = GRAPH_NODE_H;
  const edgeMarkup = edges.map(({ source, target, relation, pending }) => {
    const x1 = source.x;
    const y1 = source.y;
    const x2 = target.x;
    const y2 = target.y;
    const muted = !highlightedIds.has(source.id) || !highlightedIds.has(target.id);
    return `
      <line class="graph-edge ${pending ? "pending" : ""} ${muted ? "is-muted" : ""}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"></line>
      <text class="edge-label ${muted ? "is-muted" : ""}" x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 6}" text-anchor="middle">${escapeHtml(relation)}</text>
    `;
  }).join("");

  const nodeMarkup = nodes.map((node) => `
    <g class="graph-node ${node.type} ${node.status === "待确认" ? "pending" : ""} ${node.id === selectedGraphNode ? "is-selected" : ""} ${graphExpandedIds.has(node.id) ? "is-expanded" : ""} ${pathIds.has(node.id) ? "is-path" : ""} ${highlightedIds.has(node.id) ? "is-hot" : "is-muted"}" data-node-id="${escapeHtml(node.id)}" transform="translate(${node.x - nodeWidth / 2} ${node.y - nodeHeight / 2})">
      <rect width="${nodeWidth}" height="${nodeHeight}" rx="7"></rect>
      <text class="node-title" x="${nodeWidth / 2}" y="28" text-anchor="middle">${escapeHtml(node.label)}</text>
      <text class="node-type" x="${nodeWidth / 2}" y="47" text-anchor="middle">${escapeHtml(node.subtitle)}</text>
    </g>
  `).join("");

  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("aria-label", `${graphNodes[focus].label} 稳定关系图`);
  svg.innerHTML = `<g class="graph-world" transform="${transform}">${edgeMarkup}${nodeMarkup}</g>`;
  const overview = graphMode === "device" && graphExpandedIds.size === 0;
  $("#graphMapTitle").textContent = overview ? "AR-203 / AR-204 / LR-205 · 设备关系总览" : `${graphNodes[focus].label} · 稳定关系图`;
  renderGraphDetail(graphNodes[active]);
}

function renderGraphDetail(node) {
  $("#graphDetail").innerHTML = `
    <section class="detail-hero">
      <span>${escapeHtml(node.id)} · ${escapeHtml(node.objectType || node.type)}</span>
      <h2>${escapeHtml(node.label)}</h2>
      <p>${escapeHtml(node.subtitle)}</p>
      <span class="detail-state ${node.status === "待确认" ? "pending" : ""}">${escapeHtml(node.status)}</span>
    </section>
    <section class="detail-section">
      <h3>对象类型</h3>
      <p>${escapeHtml(node.objectType || node.type)}</p>
    </section>
    <section class="detail-section">
      <h3>所属范围</h3>
      <p>${escapeHtml(node.scope || "厂区 A")}</p>
    </section>
    <section class="detail-section">
      <h3>对象说明</h3>
      <p>${escapeHtml(node.summary)}</p>
    </section>
    <section class="detail-section">
      <h3>核心属性</h3>
      <div class="drawer-grid">
        ${node.meta.slice(0, 5).map(([label, value]) => `<div class="drawer-fact"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join("")}
      </div>
    </section>
    <section class="detail-section">
      <h3>关联对象</h3>
      <div class="relation-list">
        ${node.relations.slice(0, 10).map(([relation, target]) => `<button class="relation-item" type="button" data-relation-target="${escapeHtml(target)}"><span>${escapeHtml(relation)}</span><strong>${escapeHtml(target)}</strong><small>点击查看对象</small></button>`).join("")}
      </div>
    </section>
    <section class="detail-section">
      <h3>依据 / 来源</h3>
      <p>${escapeHtml(node.source || "来源待补充")}</p>
    </section>
    <section class="detail-section">
      <h3>图谱边界</h3>
      <p>仅收录稳定主数据、标准、稳定关系和原始资料；实时指标跳转数据看板，价格与报价信息留在采购流程。</p>
    </section>
    <section class="detail-actions graph-detail-actions">
      <button class="secondary-button" type="button" data-graph-action="detail">查看详情</button>
      <button class="secondary-button" type="button" data-graph-action="ask">在设备专家中提问</button>
      <button class="secondary-button" type="button" data-graph-action="process">查看所属流程</button>
    </section>
  `;
}

function knowledgeStatusClass(status) {
  if (status === "已发布") return "published";
  if (status === "待审核") return "review";
  return "draft";
}

function renderKnowledgeEntries() {
  $("#knowledgeCount").textContent = String(knowledgeEntries.length);
  $("#knowledgeEntryList").innerHTML = knowledgeEntries.map((entry) => `
    <button class="knowledge-entry ${entry.id === currentKnowledgeEntryId ? "is-active" : ""}" type="button" data-knowledge-entry="${escapeHtml(entry.id)}">
      <span class="knowledge-entry-top">
        <b>${escapeHtml(entry.type)}</b>
        <i class="${knowledgeStatusClass(entry.status)}">${escapeHtml(entry.status)}</i>
      </span>
      <strong>${escapeHtml(entry.title)}</strong>
      <small>${escapeHtml(entry.object)} · ${escapeHtml(entry.version)} · ${escapeHtml(entry.updated)}</small>
    </button>
  `).join("");
}

function resetKnowledgeForm() {
  currentKnowledgeEntryId = null;
  $("#knowledgeFormTitle").textContent = "录入一条设备知识";
  $("#knowledgeType").value = "SOP";
  $("#knowledgeVersion").value = "V0.1";
  $("#knowledgeTitle").value = "";
  $("#knowledgeObject").value = "AR-203";
  $("#knowledgeSource").value = "文档上传";
  $("#knowledgeScope").value = "厂区 A / 800G 产线 A";
  $("#knowledgeOwner").value = "待确认";
  $("#knowledgeSummary").value = "";
  $("#knowledgeIssues").value = "";
  $("#knowledgeFile").value = "";
  $("#knowledgeFileName").textContent = "尚未选择文件";
  renderKnowledgeEntries();
}

function populateKnowledgeForm(entryId) {
  const entry = knowledgeEntries.find((item) => item.id === entryId);
  if (!entry) return;
  currentKnowledgeEntryId = entry.id;
  $("#knowledgeFormTitle").textContent = `更新 · ${entry.title}`;
  $("#knowledgeType").value = entry.type;
  $("#knowledgeVersion").value = entry.version;
  $("#knowledgeTitle").value = entry.title;
  $("#knowledgeObject").value = entry.object;
  $("#knowledgeSource").value = entry.source;
  $("#knowledgeScope").value = entry.scope;
  $("#knowledgeOwner").value = entry.owner;
  $("#knowledgeSummary").value = entry.summary;
  $("#knowledgeIssues").value = entry.issues;
  $("#knowledgeFileName").textContent = "沿用已有版本，未重新上传";
  renderKnowledgeEntries();
  $("#knowledgeFormTitle").scrollIntoView({ behavior: "smooth", block: "center" });
}

function setGraphView(view) {
  graphView = view === "entry" ? "entry" : "query";
  $$(".graph-mode-switch button").forEach((button) => {
    const active = button.dataset.graphView === graphView;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  });
  $("#graphQueryMode").hidden = graphView !== "query";
  $("#entryChips").hidden = graphView !== "query";
  $("#graphFocusStrip").hidden = graphView !== "query" || graphMode !== "device";
  $("#graphQueryLayout").hidden = graphView !== "query";
  $("#knowledgeEntryLayout").hidden = graphView !== "entry";
  $("#copyPathButton").hidden = graphView !== "query";
  if (graphView === "query") {
    renderGraph();
  } else {
    renderKnowledgeEntries();
  }
}

function saveKnowledgeEntry(action) {
  const title = $("#knowledgeTitle").value.trim();
  const summary = $("#knowledgeSummary").value.trim();
  if (!title || !summary) {
    showToast("请先填写知识标题和知识摘要");
    return;
  }

  const status = action === "review" ? "待审核" : "草稿";
  const values = {
    title,
    type: $("#knowledgeType").value,
    object: $("#knowledgeObject").value.trim() || "待确认",
    version: $("#knowledgeVersion").value.trim() || "V0.1",
    source: $("#knowledgeSource").value,
    scope: $("#knowledgeScope").value.trim() || "待确认",
    owner: $("#knowledgeOwner").value.trim() || "待确认",
    summary,
    issues: $("#knowledgeIssues").value.trim() || "无新增待确认项",
    status,
    updated: DEMO_TIME.slice(0, 10)
  };

  if (currentKnowledgeEntryId) {
    const index = knowledgeEntries.findIndex((entry) => entry.id === currentKnowledgeEntryId);
    knowledgeEntries[index] = { ...knowledgeEntries[index], ...values };
    showToast(`已更新 ${values.title}，当前状态：${status}`);
  } else {
    const nextNumber = String(knowledgeEntries.length + 1).padStart(3, "0");
    knowledgeEntries.unshift({ id: `KB-${nextNumber}`, ...values });
    showToast(action === "review" ? "知识条目已提交待审核" : "知识草稿已保存");
  }

  resetKnowledgeForm();
}

function setGraphMode(mode) {
  if (!graphRoots[mode]) return;
  graphMode = mode;
  graphFocusId = graphRoots[mode];
  graphCollapsed = false;
  graphExpandedIds = mode === "device" ? new Set() : new Set([graphFocusId]);
  graphZoom = 1;
  selectedGraphNode = graphFocusId;
  graphActivePath = mode === "device" ? [] : [graphFocusId];
  renderGraph();
}

function setGraphFocus(nodeId) {
  const node = graphNodes[nodeId];
  if (!node) return;
  graphFocusId = nodeId;
  if (graphRoots[node.type]) graphMode = node.type;
  graphCollapsed = false;
  graphExpandedIds = new Set([nodeId]);
  graphZoom = 1;
  selectedGraphNode = nodeId;
  graphActivePath = [nodeId];
  renderGraph();
}

function searchGraph() {
  const raw = $("#graphSearch").value.trim();
  if (!raw) {
    showToast("请输入设备、机位、功能、人员、流程或 SOP 关键词");
    return;
  }
  setGraphView("query");
  const normalized = raw.toLowerCase();
  const exact = Object.values(graphNodes).find((node) => (
    node.id.toLowerCase() === normalized ||
    node.label.toLowerCase() === normalized ||
    node.label.toLowerCase().includes(normalized)
  ));
  if (exact) {
    setGraphFocus(exact.id);
    showToast(`已定位到「${exact.label}」`);
    return;
  }
  const alias = [
    [/设备|AR-203|AR-204|LR-205/i, "device"],
    [/张力|功能|模块|传感器/i, "function"],
    [/SOP|标准|规范|说明书|手册|文档|资料/i, "document"],
    [/产线|800G 产线 A|800G 产线 B/i, "line"],
    [/机位|A 线 03|A 线 04|B 线 05/i, "location"],
    [/人员|张工|李工|王工|陈工|Owner/i, "person"],
    [/Agent|运维|选型|产能分析|采购比价/i, "agent"],
    [/备件|T-17|T-21/i, "spare"],
    [/供应商|厂商甲|厂商乙/i, "supplier"],
    [/流程|点检|异常排查|维修更换|远程支持/i, "process"]
  ];
  const found = alias.find(([pattern]) => pattern.test(raw));
  if (!found) {
    showToast("未找到匹配节点，可尝试“张力控制模块”“AR-203”或“厂商乙设备资料”");
    return;
  }
  setGraphMode(found[1]);
  showToast(`已展示与“${raw}”最接近的关系路径`);
}

function openTicketModal() {
  const ticket = currentAnswer?.ticket || {
    problem: currentQuestion || "AR-203 张力波动需要排查",
    impact: "现场现象已描述，影响范围待现场补充",
    agent: "设备运维 Agent",
    flow: "设备运维｜异常排查流程（预设）",
    actionLabel: "提交运维工单",
    routeType: "workorder"
  };
  const deviceMatch = ticket.device || masterData.devices.map((device) => device.id).find((id) => currentQuestion.includes(id)) || "AR-203";
  activeTicketContext = {
    ...ticket,
    device: deviceMatch,
    agent: ticket.agent || "设备运维 Agent",
    flow: ticket.flow || "设备运维｜异常排查流程（预设）",
    actionLabel: ticket.actionLabel || "提交运维工单",
    routeType: ticket.routeType || "workorder"
  };
  $("#ticketModalTitle").textContent = activeTicketContext.actionLabel;
  $("#ticketModalIntro").textContent = `确认下面四项信息后提交。提交后将自动进入「${activeTicketContext.flow}」，由${activeTicketContext.agent}接单。`;
  $("#ticketDevice").value = deviceMatch;
  $("#ticketProblem").value = activeTicketContext.problem;
  $("#ticketImpact").value = activeTicketContext.impact;
  $("#ticketMatchFlow").textContent = activeTicketContext.flow;
  $("#ticketMatchDescription").textContent = `按设备 + 问题类型自动匹配；由${activeTicketContext.agent}负责接单与推进`;
  $("#ticketSubmitButton").textContent = activeTicketContext.actionLabel;
  $("#ticketModal").hidden = false;
  document.body.classList.add("modal-open");
}

function closeTicketModal() {
  $("#ticketModal").hidden = true;
  document.body.classList.remove("modal-open");
}

function submitTicket() {
  workOrderCreated = true;
  const urgency = $("#ticketUrgency").value;
  const context = activeTicketContext || {
    routeType: "workorder",
    flow: workOrder.flow,
    agent: workOrder.owner,
    actionLabel: "提交运维工单"
  };
  closeTicketModal();

  if (context.routeType === "case") {
    openApp("process");
    openCaseProcess(context.targetId);
    showToast(`${context.actionLabel}已提交，已进入「${context.flow}」`);
    return;
  }

  if (context.routeType === "task") {
    openApp("process");
    openTaskExecution(context.targetId);
    showToast(`${context.actionLabel}已提交，已进入「${context.flow}」`);
    return;
  }

  workOrder.urgency = urgency;
  workOrder.device = $("#ticketDevice").value;
  workOrder.flow = context.flow;
  workOrder.owner = context.agent;
  renderWorkOrderBanner();
  setProcessCase("workorder");
  processDetailMode = "focus";
  openApp("process");
  setProcessView("workorder");
  showToast(`工单 ${workOrder.id} 已提交，匹配「${context.flow}」`);
}

function bindEvents() {
  document.addEventListener("click", (event) => {
    if (event.target.closest("#backToDashboardButton")) {
      closeDeviceDetail();
      return;
    }

    if (event.target.closest("#createFlowButton")) {
      openFlowEditor();
      return;
    }

    if (event.target.closest("#backToProcessOverview")) {
      processDetailMode = "overview";
      renderWorkOrderView();
      return;
    }

    const editFlowButton = event.target.closest("[data-edit-flow]");
    if (editFlowButton) {
      openFlowEditor(editFlowButton.dataset.editFlow);
      return;
    }

    if (event.target.closest("[data-remove-flow-step]")) {
      event.target.closest("[data-flow-step-row]")?.remove();
      renumberFlowSteps();
      return;
    }

    const executionSwitch = event.target.closest("[data-execution-switch]");
    if (executionSwitch) {
      openQueueExecution(executionSwitch.dataset.executionSwitch);
      return;
    }

    const queueExecute = event.target.closest("[data-queue-execute]");
    if (queueExecute) {
      openQueueExecution(queueExecute.dataset.queueExecute);
      return;
    }

    const queueDetail = event.target.closest("[data-queue-detail]");
    if (queueDetail) {
      openQueueExecution(queueDetail.dataset.queueDetail);
      return;
    }

    const queueBoost = event.target.closest("[data-queue-boost]");
    if (queueBoost) {
      boostQueueTask(queueBoost.dataset.queueBoost);
      return;
    }

    const dashboardEntity = event.target.closest("[data-dashboard-entity]");
    if (dashboardEntity) {
      openDashboardEntity(dashboardEntity.dataset.dashboardEntity, dashboardEntity.dataset.entityId);
      return;
    }

    const deviceOrder = event.target.closest("[data-device-order]");
    if (deviceOrder) {
      const orderId = deviceOrder.dataset.deviceOrder;
      openDashboardEntity(dashboardEntityType(orderId), orderId);
      return;
    }

    const deviceAction = event.target.closest("[data-device-action]");
    if (deviceAction) {
      if (deviceAction.dataset.deviceAction === "ask") {
        openApp("expert");
        askQuestion(`${activeDashboardDevice || "AR-203"} 最近运行情况怎么样？`);
      } else {
        openApp("process");
        setProcessView("library");
      }
      return;
    }

    const workflowTarget = event.target.closest("[data-open-workflow]");
    if (workflowTarget) {
      openApp("process");
      if (workflowTarget.dataset.openWorkflow === "tasks") {
        const taskId = workflowTarget.dataset.taskId;
        if (taskId && dailyTasks.some((task) => task.id === taskId)) {
          openTaskExecution(taskId);
        } else {
          setProcessView("tasks");
        }
      } else {
        setProcessCase("workorder");
        setProcessView("workorder");
        if (workflowTarget.dataset.stepId) {
          window.setTimeout(() => openStepDrawer(workflowTarget.dataset.stepId), 60);
        }
        showToast("已打开对应工单执行视图");
      }
      return;
    }

    const openCaseButton = event.target.closest("[data-open-case]");
    if (openCaseButton) {
      openApp("process");
      openCaseProcess(openCaseButton.dataset.openCase);
      return;
    }

    const openFlowButton = event.target.closest("[data-open-flow]");
    if (openFlowButton) {
      openOngoingFlow(openFlowButton.dataset.openFlow);
      return;
    }

    const dashboardTarget = event.target.closest("[data-open-dashboard]");
    if (dashboardTarget) {
      dashboardView = dashboardTarget.dataset.openDashboard || "management";
      $$("[data-dashboard-view]").forEach((button) => {
        const active = button.dataset.dashboardView === dashboardView;
        button.classList.toggle("is-active", active);
        button.setAttribute("aria-selected", String(active));
      });
      openApp("dashboard");
      renderDashboard();
      if (dashboardTarget.dataset.dashboardMetric) {
        openMetric(dashboardTarget.dataset.dashboardMetric);
      }
      return;
    }

    const openAppButton = event.target.closest("[data-open-app]");
    if (openAppButton) {
      openApp(openAppButton.dataset.openApp);
      return;
    }

    const questionButton = event.target.closest("[data-question]");
    if (questionButton) {
      $$(".recent-item").forEach((item) => item.classList.toggle("is-active", item === questionButton));
      askQuestion(questionButton.dataset.question);
      return;
    }

    const copyAnswer = event.target.closest("[data-copy-answer]");
    if (copyAnswer) {
      navigator.clipboard?.writeText($("#conversation").innerText);
      showToast("回答已复制");
      return;
    }

    const source = event.target.closest("[data-source]");
    if (source) {
      showToast(`已打开 ${source.dataset.source} 文档版本`);
      return;
    }

    if (event.target.closest("[data-continue-question]")) {
      $("#askInput").focus();
      $("#askInput").scrollIntoView({ behavior: "smooth", block: "center" });
      showToast("可以继续补充设备、产线或机位信息");
      return;
    }

    const processViewButton = event.target.closest("[data-process-view]");
    if (processViewButton) {
      if (processViewButton.dataset.processView === "workorder") {
        processDetailMode = "overview";
      }
      setProcessView(processViewButton.dataset.processView);
      return;
    }

    const taskDetailButton = event.target.closest("[data-open-task-detail]");
    if (taskDetailButton) {
      openDailyTaskDrawer(taskDetailButton.dataset.openTaskDetail);
      return;
    }

    const dailyTaskButton = event.target.closest("[data-daily-task]");
    if (dailyTaskButton) {
      openTaskExecution(dailyTaskButton.dataset.dailyTask);
      return;
    }

    const stepButton = event.target.closest("[data-step-id]");
    if (stepButton) {
      openStepDrawer(stepButton.dataset.stepId);
      return;
    }

    if (event.target.closest("[data-board-filter-reset]")) {
      resetBoardFilters();
      return;
    }

    const closeButton = event.target.closest("[data-close-drawer]");
    if (closeButton) {
      closeDrawer(closeButton.dataset.closeDrawer);
      return;
    }

    const metricButton = event.target.closest("[data-metric]");
    if (metricButton) {
      openMetric(metricButton.dataset.metric, { statusFilter: metricButton.dataset.statusFilter });
      return;
    }

    const drillButton = event.target.closest("[data-drill]");
    if (drillButton) {
      openMetric(drillButton.dataset.drill);
      return;
    }

    if (event.target.closest("[data-close-drilldown]")) {
      const panel = $("#dashboardDrilldown");
      const collapsed = panel.classList.toggle("is-collapsed");
      event.target.closest("[data-close-drilldown]").textContent = collapsed ? "展开明细" : "收起明细";
      showToast(collapsed ? "设备明细已收起" : "设备明细已展开");
      return;
    }

    const graphFocus = event.target.closest("[data-graph-focus]");
    if (graphFocus) {
      setGraphFocus(graphFocus.dataset.graphFocus);
      return;
    }

    const graphChip = event.target.closest("[data-graph-mode]");
    if (graphChip) {
      setGraphMode(graphChip.dataset.graphMode);
      return;
    }

    const graphViewButton = event.target.closest("[data-graph-view]");
    if (graphViewButton) {
      setGraphView(graphViewButton.dataset.graphView);
      return;
    }

    const knowledgeEntry = event.target.closest("[data-knowledge-entry]");
    if (knowledgeEntry) {
      populateKnowledgeForm(knowledgeEntry.dataset.knowledgeEntry);
      return;
    }

    const feedbackButton = event.target.closest("[data-answer-feedback]");
    if (feedbackButton) {
      const feedbackGroup = feedbackButton.closest(".answer-feedback");
      $$("[data-answer-feedback]", feedbackGroup).forEach((button) => {
        button.classList.toggle("is-selected", button === feedbackButton);
      });
      const upButton = feedbackGroup.querySelector('[data-answer-feedback="up"]');
      if (feedbackButton.dataset.answerFeedback === "up") {
        upButton.textContent = "已记录 · 13";
        showToast("已记录：这个回答有帮助");
      } else {
        showToast("已记录：这个回答没解决，会转给知识责任人复盘");
      }
      return;
    }

    const evidenceToggle = event.target.closest("[data-evidence-toggle]");
    if (evidenceToggle) {
      const detail = evidenceToggle.parentElement.querySelector(".evidence-detail");
      const expanded = evidenceToggle.getAttribute("aria-expanded") === "true";
      evidenceToggle.setAttribute("aria-expanded", String(!expanded));
      evidenceToggle.querySelector("b").textContent = expanded ? "展开" : "收起";
      detail.hidden = expanded;
      return;
    }

    if (event.target.closest("[data-view-knowledge]")) {
      openApp("graph");
      setGraphMode("device");
      showToast("已打开 AR-203 的关联知识，返回时会保留原问题和回答");
      return;
    }

    if (event.target.closest("[data-create-ticket]")) {
      openTicketModal();
      return;
    }

    const dashboardViewButton = event.target.closest("[data-dashboard-view]");
    if (dashboardViewButton) {
      dashboardView = dashboardViewButton.dataset.dashboardView;
      $$("[data-dashboard-view]").forEach((button) => {
        const active = button.dataset.dashboardView === dashboardView;
        button.classList.toggle("is-active", active);
        button.setAttribute("aria-selected", String(active));
      });
      renderDashboard();
      showToast(`已切换为${dashboardViewButton.textContent.trim()}`);
      return;
    }

    const graphNode = event.target.closest("[data-node-id]");
    if (graphNode) {
      toggleGraphExpansion(graphNode.dataset.nodeId);
      return;
    }

    const relationTarget = event.target.closest("[data-relation-target]");
    if (relationTarget) {
      const node = Object.values(graphNodes).find((candidate) => candidate.label === relationTarget.dataset.relationTarget);
      if (node) {
        toggleGraphExpansion(node.id);
      }
      return;
    }

    const graphAction = event.target.closest("[data-graph-action]");
    if (graphAction) {
      const node = graphNodes[selectedGraphNode];
      if (graphAction.dataset.graphAction === "ask") {
        openApp("expert");
        askQuestion(node.ask || "AR-203 最近运行情况怎么样？");
        showToast(`已带着「${node.label}」回到设备专家`);
      } else if (graphAction.dataset.graphAction === "process") {
        openApp("process");
        setProcessView(node.processId === "task" ? "tasks" : "workorder");
        showToast(`已打开「${node.label}」关联的流程视图`);
      } else {
        showToast(`已打开 ${node.label} 的详情`);
      }
      return;
    }

    const toast = event.target.closest("[data-toast]");
    if (toast) {
      showToast(toast.dataset.toast);
    }
  });

  $("#askForm").addEventListener("submit", (event) => {
    event.preventDefault();
    askQuestion($("#askInput").value);
  });

  $("#addFlowStepButton").addEventListener("click", addFlowStepRow);
  $("#saveFlowButton").addEventListener("click", saveFlowEditor);
  $("#openTaskLaneButton").addEventListener("click", (event) => {
    const taskId = event.currentTarget.dataset.taskId;
    if (taskId) openTaskExecution(taskId);
  });
  $("#advanceStepButton").addEventListener("click", advanceStep);
  $("#stepEvidenceButton").addEventListener("click", () => showToast("已打开当前步骤的原始资料清单"));

  $("#dashboardFilters").addEventListener("change", (event) => {
    const select = event.target.closest("[data-board-filter]");
    if (!select) return;
    boardFilters = { ...boardFilters, [select.dataset.boardFilter]: select.value };
    const picked = select.selectedOptions[0].textContent.trim();
    renderDashboard();
    showToast(`看板已按「${picked}」重新计算`);
  });

  $$("[data-node-filter]").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      graphTypeVisibility[checkbox.dataset.nodeFilter] = checkbox.checked;
      renderGraph();
      showToast(`${checkbox.parentElement.textContent.trim()}已${checkbox.checked ? "显示" : "隐藏"}`);
    });
  });

  $("#graphSearchButton").addEventListener("click", searchGraph);
  $("#graphSearch").addEventListener("keydown", (event) => {
    if (event.key === "Enter") searchGraph();
  });
  $("#zoomInButton").addEventListener("click", () => {
    graphZoom = Math.min(1.35, graphZoom + .1);
    renderGraph();
  });
  $("#zoomOutButton").addEventListener("click", () => {
    graphZoom = Math.max(.72, graphZoom - .1);
    renderGraph();
  });
  $("#resetGraphButton").addEventListener("click", () => {
    graphZoom = 1;
    graphCollapsed = false;
    graphLayoutKey = ""; // 「重置视图」＝整张图重摆一遍（位置记忆和画布一起作废）
    graphFocusId = graphRoots[graphMode];
    selectedGraphNode = graphFocusId;
    graphExpandedIds = graphMode === "device" ? new Set() : new Set([selectedGraphNode]);
    graphActivePath = graphMode === "device" ? [] : [selectedGraphNode];
    renderGraph();
  });
  $("#collapseGraphButton").addEventListener("click", () => {
    graphCollapsed = true;
    graphExpandedIds = new Set([graphFocusId]);
    selectedGraphNode = graphFocusId;
    graphActivePath = [graphFocusId];
    renderGraph();
    showToast("已收起为一层关系，点击节点可重新展开");
  });
  $("#copyPathButton").addEventListener("click", () => {
    const node = graphNodes[selectedGraphNode];
    const path = node.relations.map(([relation, target]) => `${relation} → ${target}`).join("；");
    navigator.clipboard?.writeText(`${node.label}：${path}`);
    showToast("关系路径已复制");
  });

  $("#knowledgeForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const action = event.submitter?.dataset.entryAction || "draft";
    saveKnowledgeEntry(action);
  });

  $("#resetKnowledgeButton").addEventListener("click", () => {
    resetKnowledgeForm();
    showToast("表单已清空");
  });

  $("#knowledgeFileButton").addEventListener("click", () => {
    $("#knowledgeFile").click();
  });

  $("#knowledgeFile").addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    $("#knowledgeFileName").textContent = file ? `${file.name} · 待上传` : "尚未选择文件";
  });

  $("#ticketSubmitButton").addEventListener("click", submitTicket);
  $("#ticketCancelButton").addEventListener("click", closeTicketModal);
  $("#ticketCancelButtonBottom").addEventListener("click", closeTicketModal);
  $("#ticketModal").addEventListener("click", (event) => {
    if (event.target === $("#ticketModal")) closeTicketModal();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("#ticketModal").hidden) closeTicketModal();
  });

  $("#backToExpertButton").addEventListener("click", () => {
    openApp("expert");
    showToast("已返回设备专家，原问题和回答已保留");
  });
}

function init() {
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  renderQuickQuestions();
  askQuestion("AR-203 最近运行情况怎么样？");
  renderFlowLibrary();
  renderDailyTasks();
  renderWorkspace();
  renderCaseCatalog("#processCaseCatalog");
  renderWorkOrderBanner();
  renderProcessBoard();
  renderDashboard();
  graphFocusId = graphRoots[graphMode];
  graphExpandedIds = new Set();
  graphActivePath = [];
  renderGraph();
  resetKnowledgeForm();
  setGraphView("query");
  setProcessView("library");
  bindEvents();
  applyOnlyMode();
  renderRoute();
}

window.addEventListener("hashchange", renderRoute);
init();
