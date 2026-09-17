// 演示数据 for the 中际旭创 AIOS device-domain prototype.
// Every object below is fabricated demo content. Names and metrics are kept
// consistent across the four apps; anything not yet agreed with the customer
// is marked 待确认.

const DEMO_TIME = "2026-09-15 10:30";
const DEMO_LABEL = "演示数据";

// ---- 一、统一演示主数据 ----------------------------------------------------

const masterData = {
  plant: "厂区 A",
  lines: ["800G 产线 A", "800G 产线 B"],
  devices: [
    {
      id: "AR-203",
      type: "800G 光模块产线设备",
      plant: "厂区 A",
      line: "800G 产线 A",
      station: "张力控制工位",
      owner: "张工",
      uptime: "208 h",
      powerOn: "92%",
      utilization: "86%",
      outputRate: "94%",
      maintenanceDue: "2026-10-12",
      lastMaintenance: "2026-08-28",
      openIssues: 1
    },
    {
      id: "AR-204",
      type: "800G 光模块产线设备",
      plant: "厂区 A",
      line: "800G 产线 A",
      station: "老化测试工位",
      owner: "张工",
      collaborator: "李工（运维协作）",
      uptime: "196 h",
      powerOn: "88%",
      utilization: "78%",
      outputRate: "91%",
      maintenanceDue: "2026-09-18",
      lastMaintenance: "2026-06-20",
      openIssues: 0
    },
    {
      id: "LR-205",
      type: "800G 光模块产线设备",
      plant: "厂区 A",
      line: "800G 产线 B",
      station: "耦合工位",
      owner: "张工",
      collaborator: "王工（采购协作）",
      uptime: "241 h",
      powerOn: "94%",
      utilization: "91%",
      outputRate: "96%",
      maintenanceDue: "2026-11-02",
      lastMaintenance: "2026-09-01",
      openIssues: 1
    }
  ],
  people: [
    { name: "张工", role: "设备 Owner", scope: "AR-203 · AR-204 · LR-205", note: "已认证" },
    { name: "李工", role: "运维负责人", scope: "AR-204 运维协作 · 800G 产线 A", note: "已认证" },
    { name: "王工", role: "采购 Owner", scope: "LR-205 采购协作 · 备件与供应商", note: "已认证" },
    { name: "陈工", role: "工厂需求 Owner", scope: "产线扩产需求", note: "已认证" }
  ],
  agents: [
    { name: "设备专家 Agent", duty: "回答设备问题，不派工" },
    { name: "设备运维 Agent", duty: "接单、生成排查与保养清单" },
    { name: "设备选型 Agent", duty: "选型资料整理" },
    { name: "采购比价 Agent", duty: "备件比价与供应商建议" },
    { name: "产能分析 Agent", duty: "产能预测与改造方案" }
  ],
  docs: [
    "设备说明书",
    "操作标准",
    "点检 SOP",
    "保养规范",
    "维修记录",
    "供应商报价",
    "产能预测表"
  ]
};

const deviceById = (id) => masterData.devices.find((device) => device.id === id);

// ---- 二、设备专家：三个只问答、不派工的案例 --------------------------------

const demoAnswers = {
  "AR-203 最近运行情况怎么样？": {
    understanding: "识别为 AR-203 的运行情况查询，对象是 800G 产线 A 张力控制工位的这台设备。",
    voice: "我把 AR-203 最近的运行记录拉了一遍，整体是稳的：近 7 天没有异常停机，利用率在同类设备里属于正常偏上。",
    conclusion: "近 30 天运行正常。累计运行 208 小时，开机率 92%，利用率 86%，产能达成率 94%；上次保养 2026-08-28，下次保养窗口 2026-10-12，当前负责人张工。另有 1 条未关闭的张力波动工单。",
    facts: [
      ["累计运行时长", "208 h"],
      ["开机率", "92%"],
      ["利用率", "86%"],
      ["产能达成率", "94%"],
      ["最近保养", "2026-08-28"],
      ["当前负责人", "张工（设备 Owner）"]
    ],
    steps: [],
    gap: "正式接入后以客户台账的统计周期和停机口径为准。",
    actions: ["knowledge"],
    evidence: [
      { tag: "记录", name: "AR-203 设备运行记录", section: "近 30 天运行明细", note: "2026-09-15 10:30" },
      { tag: "SOP", name: "AR-203 点检 SOP", section: "第 3 节 点检项", note: "V1.3 · 2026-08-20" },
      { tag: "记录", name: "AR-203 保养记录", section: "最近一次保养", note: "2026-08-28 · 李工" }
    ]
  },
  "AR-203 的日常点检重点是什么？": {
    understanding: "识别为 AR-203 的日常点检重点查询。",
    voice: "点检的重点不是把 5 项都过一遍，而是知道哪几项一旦不对就必须停下来。我按 SOP 给你排了顺序。",
    conclusion: "重点看三处：安全防护与连接状态必须在开机前确认；温升、声音和振动要等设备稳定运行后再看；第 4 项确认人当前仍是待确认状态。",
    facts: [],
    steps: [
      ["01", "检查外观、防护罩和安全标识", "防护装置不完整就不要继续开机检查", "现场确认"],
      ["02", "确认电源、气源和连接线", "接口松动、线缆受挤压时先停下来处理", "现场确认"],
      ["03", "观察温度、声音和振动", "设备稳定运行后再看，避免把启动波动当成结果", "现场确认"],
      ["04", "核对关键参数与工艺要求", "确认参数版本和当班工艺一致", "人工确认"],
      ["05", "完成点检记录并提交复核", "记录结论，不只记录“正常”两个字", "人工确认"]
    ],
    gap: "第 4 项的人工确认人还没定，现场点检记录模板也待确认。",
    actions: ["knowledge"],
    evidence: [
      { tag: "SOP", name: "AR-203 点检 SOP", section: "第 3 节 点检项", note: "V1.3 · 2026-08-20", application: "AR-203 / 张力控制工位", excerpt: "开机前先检查外观、防护罩和安全标识；设备稳定运行后再复核温度、声音和振动。" },
      { tag: "手册", name: "AR-203 设备说明书", section: "2.4 开机前检查", note: "V2.1 · 2026-07-12", application: "AR-203", excerpt: "电源、气源和连接线确认完成后方可继续开机检查。" },
      { tag: "记录", name: "AR-203 历史点检记录", section: "最近 10 次点检", note: "2026-09-15", application: "AR-203", excerpt: "最近 10 次点检均完成，其中 2 次记录过张力波动需复核。" }
    ]
  },
  "AR-203 出现张力波动，建议怎么处理？": {
    understanding: "识别为 AR-203 的张力波动问题，对象是张力控制模块，位置在 800G 产线 A。",
    voice: "先说结论：这不像要立刻停机的问题，但需要现场确认三件事——波动出现的时间、当时的产品批次和张力设定值。有了这三项我才能把原因范围收窄。",
    conclusion: "先按“确认现象 → 比对标准 → 现场处置”三步走；本次判断不能替代现场负责人的决定，涉及停机或改参数必须由现场确认。如果现场信息不足或反复出现，建议提交运维工单。",
    facts: [],
    steps: [
      ["01", "确认波动出现的时间与批次", "同一批次内连续出现，和偶发一次，处理方向完全不同", "现场确认"],
      ["02", "记录当时的张力设定值与实际值", "设定值没动但实际值漂，优先怀疑张力单元本身", "现场确认"],
      ["03", "核对张力单元是否在保养窗口内", "保养逾期会直接影响张力稳定性，先排除这一项", "现场确认"],
      ["04", "按操作标准 4.2 做复检", "复检顺序不能跳，先静置再加载", "现场确认"],
      ["05", "判断是否需要提交运维工单", "现场确认信息不足或反复出现时，直接提交工单", "人工确认"]
    ],
    gap: "现场记录模板和张力单元的保养判定阈值还没确认；当前依据操作标准，不替代现场负责人的判断。",
    actions: ["knowledge", "ticket"],
    ticket: {
      problem: "AR-203 出现张力波动，需要排查原因",
      impact: "张力波动导致测试数据不稳定，当前未停机，无人员受伤"
    },
    evidence: [
      { tag: "标准", name: "操作标准 · 张力控制", section: "4.2 张力波动处置", note: "V1.3 · 2026-08-20 生效" },
      { tag: "手册", name: "AR-203 设备说明书", section: "3.1 张力单元", note: "V2.1 · 2026-07-12" },
      { tag: "记录", name: "AR-203 维修记录", section: "最近 3 次张力类问题", note: "2026-09-15" }
    ]
  },
  "AR-203 的关键运行参数有哪些？": {
    understanding: "识别为 AR-203 的关键参数查询。",
    voice: "现场最容易看混的是“当前值”和“参数版本”，我先帮你把这两层拆开。",
    conclusion: "先看参数版本，再看温度、运行节拍、累计运行时长和连接状态；上下限以设备说明书为准。",
    facts: [],
    steps: [
      ["01", "核对设备铭牌和参数版本", "先确认你看的不是旧版本参数", "人工确认"],
      ["02", "看温度和运行节拍", "两项要放在同一工艺条件下比较", "人工确认"],
      ["03", "看累计运行时长和保养窗口", "目的是判断是否接近计划保养", "人工确认"],
      ["04", "确认连接状态和采集点", "确认数据来源完整，再决定是否作为判断依据", "人工确认"]
    ],
    gap: "参数名称和上下限来自设备资料，真实接入前需要映射客户台账和手册版本。",
    actions: ["knowledge"],
    evidence: [
      { tag: "资料", name: "AR-203 设备说明书", section: "3.1 张力单元参数", note: "V2.1 · 2026-07-12" },
      { tag: "标准", name: "操作标准 · 张力控制", section: "2. 设定值确认", note: "V1.3 · 2026-08-20" },
      { tag: "记录", name: "AR-203 运行参数快照", section: "当前班次", note: "2026-09-15 10:30" }
    ]
  },
  "800G 产线 A 排线和换线前需要确认什么？": {
    understanding: "识别为 800G 产线 A 的排线与换线准备问题，当前信息不足以确定机位和产品切换范围。",
    voice: "这类问题我不会直接说“可以换”。现在缺目标机位、产品范围和停机窗口，我只能先把现场确认顺序给你。",
    conclusion: "先补齐目标机位、产品范围、停机窗口和安全责任人，再进入排线确认。",
    facts: [],
    steps: [
      ["01", "确认目标机位和产品范围", "这两个信息不明确，后面的排线图没有意义", "待补充"],
      ["02", "核对物料清单、接口和空间约束", "重点看现场是否有冲突，不只对表格", "现场确认"],
      ["03", "确认停机窗口和安全责任人", "需要现场负责人明确确认", "待确认"],
      ["04", "形成换线检查清单并签认", "签认后才进入现场执行准备", "人工确认"]
    ],
    gap: "目标机位、产品范围和现场安全责任人未提供，这版只能作为准备框架。",
    actions: ["knowledge"],
    evidence: [
      { tag: "规范", name: "800G 产线 A 换线前检查清单", section: "机位与物料核对", note: "V0.2 · 2026-09-13" },
      { tag: "资料", name: "800G 产线 A 设备清单", section: "机位与接口", note: "2026-09-13 更新" },
      { tag: "记录", name: "800G 产线 A 历史换线记录", section: "最近 5 次换线", note: "2026-09-13" }
    ]
  },
  "800G 产线要新增张力控制设备，选型要注意什么？": {
    understanding: "识别为 800G 产线的设备选型问题，需要把产能、交期、预算和现有接口一起纳入候选评估。",
    voice: "选型不能只看型号和价格。先把产能缺口、交期、接口兼容和保养资料这四件事拉齐，再让 Agent 生成候选，最后仍由设备 Owner 确认。",
    conclusion: "建议按“缺口约束 → 候选设备 → 兼容性核验 → Owner 确认”四步推进；Agent 负责整理候选和风险，不代替设备 Owner 做最终选型。",
    facts: [
      ["目标产线", "800G 产线 A"],
      ["现有同类设备", "AR-203 / AR-204"],
      ["建议候选数", "3 个"],
      ["必须人工确认", "设备型号与接口改造"]
    ],
    steps: [
      ["01", "确认产能缺口与投产时间", "先明确新增设备要补多少产能，什么时候必须到位", "需求 Owner 确认"],
      ["02", "收集候选设备参数与交期", "型号、产能、交期、预算区间要放在同一张表里比较", "选型 Agent 整理"],
      ["03", "核对接口、空间和保养体系兼容性", "不能只看单机参数，要确认与现有产线和资料体系匹配", "设备 Owner 确认"],
      ["04", "形成推荐排序并提交选型结论", "Agent 给建议，最终型号由设备 Owner 确认", "人工确认"]
    ],
    gap: "当前缺少正式预算区间和改造窗口，页面先作为示例选型任务展示。",
    actions: ["knowledge", "ticket"],
    ticket: {
      device: "800G 产线 A",
      problem: "800G 产线新增张力控制设备，需要形成候选型号、兼容性和风险对比",
      impact: "预计下月新增产能需求，当前设备数量和接口兼容性仍需评估",
      agent: "设备选型 Agent",
      flow: "设备选型｜候选评估流程（预设）",
      actionLabel: "提交选型任务",
      routeType: "case",
      targetId: "case-selection"
    },
    evidence: [
      { tag: "资料", name: "800G 产线 A 设备清单", section: "现有设备与接口", note: "2026-09-13 更新" },
      { tag: "资料", name: "张力控制设备候选库", section: "型号、产能与交期", note: "演示数据" },
      { tag: "记录", name: "历史选型评估", section: "兼容性与风险项", note: "2026-08-30" }
    ]
  },
  "下月 800G 产线增加 10 万只/月，怎么排产并评估设备缺口？": {
    understanding: "识别为 800G 产线下月扩产目标的排产与设备缺口评估问题。",
    voice: "先不要直接排满。把目标产量拆到周，再比现有设备可用工时和计划保养，缺口和瓶颈会自己浮出来。",
    conclusion: "建议先做产能拆解、设备可用率校核、保养窗口排布三步，再由排产 Agent 生成排产草案和设备缺口清单，工厂需求 Owner 确认。",
    facts: [
      ["新增目标", "10 万只/月"],
      ["预计投产", "45 天后"],
      ["涉及产线", "800G 产线 A"],
      ["当前约束", "预算与改造窗口待确认"]
    ],
    steps: [
      ["01", "把月度目标拆成周计划", "按周看峰值，避免月平均掩盖瓶颈", "排产 Agent 生成"],
      ["02", "核算现有设备可用工时", "扣除计划保养、换线和已知停机窗口", "设备运维 Agent 校核"],
      ["03", "识别设备与人员缺口", "区分临时加班可解决和必须新增设备的部分", "人工确认"],
      ["04", "生成排产草案与采购触发点", "明确什么时候必须启动选型和采购", "排产 Agent 汇总"]
    ],
    gap: "预算口径、产品组合和停机窗口还未确认，排产结果仅用于演示。",
    actions: ["knowledge", "ticket"],
    ticket: {
      device: "800G 产线 A",
      problem: "下月产能目标增加 10 万只/月，需要生成排产草案并评估设备缺口",
      impact: "目标预计 45 天后投产，需同步评估保养、换线和设备采购触发点",
      agent: "生产排产 Agent",
      flow: "生产计划｜排产与设备缺口评估",
      actionLabel: "提交排产任务",
      routeType: "task",
      targetId: "TASK-20260915-05"
    },
    evidence: [
      { tag: "计划", name: "800G 产线下月产能目标", section: "目标产量与投产节点", note: "演示数据" },
      { tag: "记录", name: "设备可用工时台账", section: "停机、保养与换线窗口", note: "2026-09-15 10:30" },
      { tag: "资料", name: "800G 产线 A 设备清单", section: "现有产能与工位", note: "2026-09-13 更新" }
    ]
  }
};

// ---- 三、预设流程库 --------------------------------------------------------

const processFlows = [
  {
    id: "troubleshoot",
    name: "设备异常排查",
    subtitle: "设备运维｜异常排查",
    trigger: "设备出现波动、偏差或异常现象时触发",
    owner: "设备运维 Agent",
    stepCount: 5,
    status: "启用中",
    updated: "2026-08-28",
    steps: [
      { name: "接单并补齐信息", actorType: "agent" },
      { name: "现场现象确认", actorType: "human" },
      { name: "依据比对与初步判断", actorType: "agent" },
      { name: "现场处置确认", actorType: "human" },
      { name: "记录归档与结论", actorType: "agent" }
    ]
  },
  {
    id: "maintenance",
    name: "日常保养执行",
    subtitle: "设备运维｜日常保养",
    trigger: "到达保养周期或计划点检时间时自动生成待办",
    owner: "设备运维 Agent",
    stepCount: 5,
    status: "启用中",
    updated: "2026-08-28",
    steps: [
      { name: "生成保养清单", actorType: "agent" },
      { name: "确认保养窗口", actorType: "human" },
      { name: "执行现场保养", actorType: "human" },
      { name: "验收保养结果", actorType: "human" },
      { name: "归档并生成下次计划", actorType: "agent" }
    ]
  },
  {
    id: "repair",
    name: "维修更换",
    subtitle: "设备运维｜维修更换",
    trigger: "确认需要更换部件时触发",
    owner: "设备运维 Agent",
    stepCount: 5,
    status: "启用中",
    updated: "2026-09-02",
    steps: [
      { name: "确认维修更换需求", actorType: "agent" },
      { name: "运维负责人审批", actorType: "human" },
      { name: "备件比价与采购确认", actorType: "agent" },
      { name: "现场更换与验收", actorType: "human" },
      { name: "归档维修记录", actorType: "agent" }
    ]
  },
  {
    id: "startstop",
    name: "启停机确认",
    subtitle: "设备运维｜启停机确认",
    trigger: "计划停机或恢复生产前触发",
    owner: "设备运维 Agent",
    stepCount: 5,
    status: "启用中",
    updated: "2026-09-05",
    steps: [
      { name: "提交启停机计划", actorType: "human" },
      { name: "核对启停机条件", actorType: "agent" },
      { name: "现场安全检查", actorType: "human" },
      { name: "执行启停机操作", actorType: "human" },
      { name: "记录结果并回归计划", actorType: "agent" }
    ]
  }
];

// ---- 四、日常任务（不经过设备专家，直接由流程产生） ------------------------

const dailyTasks = [
  {
    id: "TASK-20260915-01",
    title: "今日 AR-203 开机前点检",
    owner: "张工（设备 Owner）",
    agent: "设备运维 Agent",
    source: "日常点检计划 · 每日 08:30 自动生成",
    flow: "日常保养执行",
    node: "待本人确认 · 第 2/5 步",
    input: "AR-203 点检 SOP、昨日点检记录",
    output: "AR-203 今日点检清单（Agent 已生成）",
    confirm: "张工逐项确认点检结果",
    next: "确认后归档并生成今日点检记录",
    status: "待确认",
    demoFocus: true
  },
  {
    id: "TASK-20260915-02",
    title: "AR-204 周期保养",
    owner: "李工（运维负责人）",
    agent: "设备运维 Agent",
    source: "保养计划 · 周期到期 2026-09-18",
    flow: "日常保养执行",
    node: "Agent 已生成保养清单 · 待安排窗口",
    input: "AR-204 保养规范、保养周期表、生产计划",
    output: "AR-204 保养清单与备件需求",
    confirm: "李工确认保养窗口与责任人",
    next: "进入现场保养执行",
    status: "进行中"
  },
  {
    id: "TASK-20260915-03",
    title: "LR-205 备件采购比价",
    owner: "王工（采购 Owner）",
    agent: "采购比价 Agent",
    source: "维修更换流程产生的备件需求",
    flow: "维修更换",
    node: "待确认供应商 · 第 3/5 步",
    input: "备件 T-17 需求、供应商甲 / 乙报价",
    output: "比价表与供应商建议",
    confirm: "王工确认供应商与交期",
    next: "生成采购需求并跟进到货",
    status: "待确认"
  },
  {
    id: "TASK-20260915-04",
    title: "800G 产线 A 下月扩产需求",
    owner: "陈工（工厂需求 Owner）",
    agent: "设备选型 Agent · 产能分析 Agent",
    source: "工厂需求提报",
    flow: "需求评估",
    node: "待补充预算与交期",
    input: "下月产能目标、现有设备清单、产能预测表",
    output: "扩产需求草案",
    confirm: "陈工补充预算与交期后提交",
    next: "进入选型与产能评估",
    status: "待补充"
  },
  {
    id: "TASK-20260915-05",
    title: "800G 产线下月排产与设备缺口评估",
    owner: "陈工（工厂需求 Owner）",
    agent: "生产排产 Agent",
    source: "设备专家提交的排产任务",
    flow: "生产计划｜排产与设备缺口评估",
    node: "待补充预算口径与产品组合 · 第 1/5 步",
    input: "下月产能目标、设备可用工时、保养与换线计划",
    output: "周排产草案与设备缺口清单",
    confirm: "陈工确认排产口径与采购触发点",
    next: "进入产能校核与排产草案生成",
    status: "待补充"
  }
];

const caseCatalog = [
  {
    id: "case-requirement",
    processKey: "case-requirement",
    stage: "需求提出",
    title: "800G 产线扩产需求",
    owner: "陈工（工厂需求 Owner）",
    agent: "产能分析 Agent",
    status: "待人工确认",
    node: "待需求 Owner 确认约束",
    next: "确认预算口径、改造窗口与投产节点",
    confirm: "陈工确认需求约束",
    updated: "09-15 10:32",
    source: "工厂需求提报 · 下月产能目标",
    input: "下月新增 10 万只/月，预计 45 天后投产，预算 300 万",
    output: "扩产需求约束与产能缺口分析",
    timeline: ["需求已提交", "产能分析 Agent 已拆解目标", "待需求 Owner 确认约束"],
    details: {
      type: "requirement",
      facts: [
        ["需求目标", "新增 10 万只/月"],
        ["当前产能", "7.2 万只/月"],
        ["产能缺口", "2.8 万只/月 · 示例计算"],
        ["投产时间", "45 天后"],
        ["预算", "300 万"],
        ["涉及产线", "800G 产线 A"]
      ],
      pending: ["预算口径", "改造窗口", "设备兼容性边界"]
    },
    steps: [
      ["提交扩产需求", "human", "陈工（工厂需求 Owner）", "已完成"],
      ["拆解产能目标与缺口", "agent", "产能分析 Agent", "已完成"],
      ["确认需求约束", "human", "陈工（工厂需求 Owner）", "进行中"],
      ["生成扩产改造建议", "agent", "产能分析 Agent", "未开始"],
      ["归档需求评估", "agent", "产能分析 Agent", "未开始"]
    ]
  },
  {
    id: "case-selection",
    processKey: "case-selection",
    stage: "设备选型",
    title: "800G 产线设备选型",
    owner: "张工（设备 Owner）",
    agent: "设备选型 Agent",
    status: "进行中",
    node: "待设备 Owner 确认候选方案",
    next: "确认候选设备并进入采购询价",
    confirm: "张工确认选型结果",
    updated: "09-15 10:28",
    source: "需求约束确认后触发",
    input: "产能目标、交期、预算与现有设备兼容性要求",
    output: "3 个设备候选方案与推荐排序",
    timeline: ["需求约束已确认", "选型 Agent 生成 3 个候选", "待设备 Owner 确认"],
    details: {
      type: "selection",
      candidates: [
        ["A800-T3", "3.2 万只/月", "30 天", "110-125 万", "高", "供应链稳定", "推荐"],
        ["B800-X2", "2.8 万只/月", "24 天", "95-108 万", "中", "关键备件交期偏长", "备选"],
        ["C800-P1", "3.5 万只/月", "50 天", "130-145 万", "低", "需改造现有接口", "不推荐"]
      ]
    },
    steps: [
      ["确认需求约束", "human", "张工（设备 Owner）", "已完成"],
      ["生成候选设备", "agent", "设备选型 Agent", "已完成"],
      ["对比兼容性与风险", "agent", "设备选型 Agent", "已完成"],
      ["确认候选方案", "human", "张工（设备 Owner）", "进行中"],
      ["归档选型结论", "agent", "设备选型 Agent", "未开始"]
    ]
  },
  {
    id: "case-procurement",
    processKey: "case-procurement",
    stage: "采购购买",
    title: "AR-203 张力控制模块备件采购",
    owner: "王工（采购 Owner）",
    agent: "采购比价 Agent",
    status: "待人工确认",
    node: "待采购 Owner 选择供应商",
    next: "确认供应商并生成采购需求",
    confirm: "王工选择供应商",
    updated: "09-15 10:26",
    source: "已确认型号的备件采购需求",
    input: "供应商甲 / 乙 / 丙价格、交期、质保与历史履约",
    output: "3 家供应商对比表与采购建议",
    timeline: ["询价已收集", "采购比价 Agent 已完成对比", "待采购 Owner 选择供应商"],
    details: {
      type: "procurement",
      suppliers: [
        ["供应商甲", "18.6 万", "7 天", "12 个月", "98%", "推荐"],
        ["供应商乙", "17.8 万", "14 天", "12 个月", "94%", "价格备选"],
        ["供应商丙", "19.2 万", "5 天", "18 个月", "89%", "紧急备选"]
      ]
    },
    steps: [
      ["收集供应商报价", "agent", "采购比价 Agent", "已完成"],
      ["对比价格、交期与质保", "agent", "采购比价 Agent", "已完成"],
      ["形成采购建议", "agent", "采购比价 Agent", "已完成"],
      ["选择供应商", "human", "王工（采购 Owner）", "进行中"],
      ["生成采购需求", "agent", "采购比价 Agent", "未开始"]
    ]
  },
  {
    id: "case-maintenance",
    processKey: "workorder",
    stage: "使用与维修",
    title: "AR-203 张力波动异常排查",
    owner: "李工（运维负责人）",
    agent: "设备运维 Agent",
    status: "进行中",
    node: "异常排查第 2 步 · 现场现象确认",
    next: "现场确认波动信息并进入依据比对",
    confirm: "张工确认现场现象",
    updated: "09-15 10:24",
    source: "设备专家回答后，由用户明确点击“提交运维工单”",
    input: "设备专家回答、工单信息、AR-203 运行记录",
    output: "异常排查结论与处置记录",
    timeline: ["工单已创建", "匹配异常排查流程", "运维 Agent 已完成初步判断", "待现场确认"],
    details: { type: "maintenance" },
    steps: []
  }
];

const ongoingFlows = [
  {
    id: "FLOW-REQ-001",
    stage: "需求提出",
    title: "800G 产线扩产需求",
    owner: "陈工（工厂需求 Owner）",
    agent: "产能分析 Agent",
    status: "进行中",
    node: "待补充预算",
    next: "确认预算口径与投产节点",
    confirm: "陈工确认需求约束",
    updated: "09-15 10:32",
    routeType: "case",
    targetId: "case-requirement"
  },
  {
    id: "FLOW-SEL-001",
    stage: "设备选型",
    title: "800G 产线设备选型",
    owner: "张工（设备 Owner）",
    agent: "设备选型 Agent",
    status: "进行中",
    node: "待确认候选方案",
    next: "确认设备型号与兼容性",
    confirm: "张工确认选型结果",
    updated: "09-15 10:28",
    routeType: "case",
    targetId: "case-selection"
  },
  {
    id: "FLOW-PROC-001",
    stage: "采购购买",
    title: "LR-205 备件采购比价",
    owner: "王工（采购 Owner）",
    agent: "采购比价 Agent",
    status: "待人工确认",
    node: "待选择供应商",
    next: "确认供应商并生成采购需求",
    confirm: "王工确认供应商",
    updated: "09-15 10:26",
    routeType: "task",
    targetId: "TASK-20260915-03"
  },
  {
    id: "FLOW-OPS-001",
    stage: "使用与维修",
    title: "AR-203 张力波动",
    owner: "李工（运维负责人）",
    agent: "设备运维 Agent",
    status: "进行中",
    node: "异常排查第 2 步",
    next: "现场确认波动现象",
    confirm: "张工确认现场现象",
    updated: "09-15 10:24",
    routeType: "workorder",
    targetId: "workorder"
  },
  {
    id: "FLOW-MNT-001",
    stage: "使用与保养",
    title: "AR-204 月度保养",
    owner: "张工（设备 Owner）",
    agent: "设备运维 Agent",
    status: "待人工确认",
    node: "待确认保养窗口",
    next: "确认停机窗口与责任人",
    confirm: "张工确认保养窗口",
    updated: "09-15 10:22",
    routeType: "task",
    targetId: "TASK-20260915-02"
  }
];

const taskQueue = [
  {
    id: "QUEUE-20260915-01",
    sourceType: "workorder",
    sourceId: "WO-20260915-001",
    title: "AR-203 张力波动",
    device: "AR-203",
    owner: "设备运维 Agent",
    status: "执行中",
    priority: "高",
    queuePosition: "正在执行",
    currentStep: "第 3/5 步 · 依据比对与初步判断",
    eta: "预计 10:42 完成当前分析",
    progress: 45
  },
  {
    id: "QUEUE-20260915-02",
    sourceType: "task",
    sourceId: "TASK-20260915-04",
    title: "800G 产线 A 下月扩产需求",
    device: "800G 产线 A",
    owner: "产能分析 Agent",
    status: "执行中",
    priority: "中",
    queuePosition: "正在执行",
    currentStep: "生成下月产能预测草稿",
    eta: "预计 10:55 完成预测",
    progress: 32
  },
  {
    id: "QUEUE-20260915-03",
    sourceType: "task",
    sourceId: "TASK-20260915-03",
    title: "LR-205 备件采购比价",
    device: "LR-205",
    owner: "采购比价 Agent",
    status: "执行中",
    priority: "中",
    queuePosition: "正在执行",
    currentStep: "汇总供应商甲 / 乙报价",
    eta: "预计 10:38 完成比价",
    progress: 68
  },
  {
    id: "QUEUE-20260915-04",
    sourceType: "task",
    sourceId: "TASK-20260915-02",
    title: "AR-204 周期保养",
    device: "AR-204",
    owner: "设备运维 Agent",
    status: "排队中",
    priority: "普通",
    queuePosition: "第 1 位",
    currentStep: "等待设备 Owner 确认保养窗口",
    eta: "窗口确认后入队执行",
    progress: 0
  },
  {
    id: "QUEUE-20260915-05",
    sourceType: "task",
    sourceId: "TASK-20260915-01",
    title: "今日 AR-203 开机前点检",
    device: "AR-203",
    owner: "设备运维 Agent",
    status: "排队中",
    priority: "普通",
    queuePosition: "第 2 位",
    currentStep: "等待张工确认点检结果",
    eta: "人工确认后继续",
    progress: 0
  },
  {
    id: "QUEUE-20260915-06",
    sourceType: "queue",
    sourceId: "QUEUE-TASK-06",
    title: "LR-205 耦合参数复核",
    device: "LR-205",
    owner: "设备运维 Agent",
    humanOwner: "李工（运维负责人）",
    status: "排队中",
    priority: "普通",
    queuePosition: "第 3 位",
    currentStep: "等待李工补充上次参数偏差值",
    eta: "预计 11:10 执行",
    progress: 0,
    flow: "设备异常排查",
    agent: "设备运维 Agent",
    input: "LR-205 参数快照、耦合工位运行记录",
    output: "参数复核结论",
    confirm: "李工确认复核结果",
    next: "生成参数调整建议"
  },
  {
    id: "QUEUE-20260915-07",
    sourceType: "queue",
    sourceId: "QUEUE-TASK-07",
    title: "AR-203 周保养",
    device: "AR-203",
    owner: "设备运维 Agent",
    humanOwner: "张工（设备 Owner）",
    status: "排队中",
    priority: "普通",
    queuePosition: "第 4 位",
    currentStep: "等待计划停机窗口",
    eta: "预计周五执行",
    progress: 0,
    flow: "日常保养执行",
    agent: "设备运维 Agent",
    input: "AR-203 保养规范、本周生产计划",
    output: "周保养清单",
    confirm: "张工确认保养窗口",
    next: "进入现场保养执行"
  },
  {
    id: "QUEUE-20260915-08",
    sourceType: "queue",
    sourceId: "QUEUE-TASK-08",
    title: "备件 T-17 到货登记",
    device: "AR-203",
    owner: "采购比价 Agent",
    humanOwner: "王工（采购 Owner）",
    status: "排队中",
    priority: "普通",
    queuePosition: "第 5 位",
    currentStep: "等待采购单确认",
    eta: "采购单确认后启动",
    progress: 0,
    flow: "维修更换",
    agent: "采购比价 Agent",
    input: "采购单、供应商甲发货信息",
    output: "到货与入库记录",
    confirm: "王工确认到货信息",
    next: "更新备件库存"
  },
  {
    id: "QUEUE-20260915-09",
    sourceType: "queue",
    sourceId: "QUEUE-TASK-09",
    title: "产线 B 换型准备",
    device: "800G 产线 B",
    owner: "产能分析 Agent",
    humanOwner: "李工（运维负责人）",
    status: "排队中",
    priority: "普通",
    queuePosition: "第 6 位",
    currentStep: "等待目标产品与换型窗口",
    eta: "预计 09-17 执行",
    progress: 0,
    flow: "启停机确认",
    agent: "产能分析 Agent",
    input: "换型计划、产线设备清单、停机窗口",
    output: "换型准备清单",
    confirm: "李工确认停机窗口",
    next: "进入换型执行"
  },
  {
    id: "QUEUE-20260915-10",
    sourceType: "queue",
    sourceId: "QUEUE-TASK-10",
    title: "800G 产线产能预测",
    device: "800G 产线 A",
    owner: "产能分析 Agent",
    humanOwner: "陈工（工厂需求 Owner）",
    status: "排队中",
    priority: "普通",
    queuePosition: "第 7 位",
    currentStep: "等待最新生产计划",
    eta: "预计 11:30 执行",
    progress: 0,
    flow: "需求评估",
    agent: "产能分析 Agent",
    input: "近 7 天产出、设备可用率、下月计划",
    output: "产能预测与风险提示",
    confirm: "陈工确认预测口径",
    next: "提交产能评估"
  }
];

// ---- 五、两条可演示的执行流程 ---------------------------------------------

const workOrder = {
  id: "WO-20260915-001",
  title: "AR-203 张力波动",
  device: "AR-203",
  line: "厂区 A / 800G 产线 A",
  flow: "设备运维｜异常排查（预设）",
  flowId: "troubleshoot",
  status: "已进入异常排查流程",
  urgency: "较高",
  submitted: "2026-09-15 10:12",
  source: "设备专家 · 提交运维工单",
  owner: "设备运维 Agent",
  currentStep: "第 2/5 步 · 现场现象确认"
};

const troubleshootSteps = [
  {
    id: "TRO-01",
    name: "接单并补齐信息",
    actorType: "agent",
    actor: "设备运维 Agent",
    status: "已完成",
    input: "工单 WO-20260915-001、AR-203 设备台账、现场描述",
    human: "核对提交的设备与现象描述是否准确。",
    agent: "接单后补齐设备台账、所属产线和紧急程度，生成排查任务骨架。",
    output: "排查任务骨架",
    confirm: "张工确认工单信息",
    next: "02 现场现象确认",
    evidence: ["工单 WO-20260915-001", "AR-203 设备台账"],
    permission: "Agent 可建任务；张工可修改现象描述"
  },
  {
    id: "TRO-02",
    name: "现场现象确认",
    actorType: "human",
    actor: "张工（设备 Owner）",
    status: "进行中",
    input: "排查任务骨架、现场观察记录",
    human: "确认波动出现的时间、产品批次、当时的张力设定值，并回填现场照片。",
    agent: "给出需要确认的最小信息清单，不代替现场判断。",
    output: "现场现象确认记录",
    confirm: "张工确认（必须人工，不可跳过）",
    next: "03 依据比对与初步判断",
    evidence: ["现场记录模板（待确认）", "800G 产线 A 生产计划"],
    permission: "张工填写；Agent 只读"
  },
  {
    id: "TRO-03",
    name: "依据比对与初步判断",
    actorType: "agent",
    actor: "设备运维 Agent",
    status: "进行中",
    input: "现场现象确认记录、操作标准、AR-203 维修记录",
    human: "确认 Agent 引用的标准版本是否为当前生效版本。",
    agent: "比对操作标准与历史处理记录，给出可能原因排序和下一步处置建议草稿。",
    output: "初步判断与处置建议草稿",
    confirm: "张工确认处置方向",
    next: "04 现场处置确认",
    evidence: ["操作标准 · 张力控制 V1.3", "AR-203 维修记录"],
    permission: "Agent 只生成草稿，不可直接下发处置指令"
  },
  {
    id: "TRO-04",
    name: "现场处置确认",
    actorType: "human",
    actor: "张工（设备 Owner）",
    status: "待确认",
    input: "初步判断与处置建议草稿",
    human: "按建议在现场确认处置方式，涉及停机或改参数的必须由现场负责人确认。",
    agent: "提供步骤清单和复检项，不执行任何设备操作。",
    output: "处置与复检记录",
    confirm: "张工确认（高风险操作不可由 Agent 代替）",
    next: "05 记录归档与结论",
    evidence: ["现场处置清单（待确认）", "安全规范 V0.2"],
    permission: "人工确认；Agent 不可控制设备"
  },
  {
    id: "TRO-05",
    name: "记录归档与结论",
    actorType: "agent",
    actor: "设备运维 Agent",
    status: "未开始",
    input: "处置与复检记录、工单全过程数据",
    human: "做最终结论确认。",
    agent: "整理工单结论、引用依据和后续待办，归档到设备流水账。",
    output: "工单结论与设备流水账更新",
    confirm: "张工确认结论",
    next: "工单关闭",
    evidence: ["工单模板", "AR-203 设备流水账"],
    permission: "Agent 归档；结论由张工确认"
  }
];

const pointInspectionSteps = [
  {
    id: "PI-01",
    name: "生成点检清单",
    actorType: "agent",
    actor: "设备运维 Agent",
    status: "已完成",
    input: "AR-203 点检 SOP、昨日点检记录、设备台账",
    human: "暂不参与。",
    agent: "按 SOP 生成今日 5 项点检清单，并标出昨日异常项。",
    output: "AR-203 今日点检清单",
    confirm: "无需人工确认（清单生成）",
    next: "02 逐项确认点检结果",
    evidence: ["AR-203 点检 SOP V1.3", "昨日点检记录"],
    permission: "Agent 生成清单；张工可编辑"
  },
  {
    id: "PI-02",
    name: "逐项确认点检结果",
    actorType: "human",
    actor: "张工（设备 Owner）",
    status: "进行中",
    input: "AR-203 今日点检清单",
    human: "按清单逐项检查并回填结果，第 1、2 项必须在开机前完成。",
    agent: "提供清单和上一班次对照值，不代替现场判断。",
    output: "已填写的点检结果",
    confirm: "张工逐项确认（必须人工）",
    next: "03 汇总点检结果",
    evidence: ["AR-203 点检 SOP V1.3 · 第 3 节"],
    permission: "张工填写；Agent 只读"
  },
  {
    id: "PI-03",
    name: "汇总点检结果",
    actorType: "agent",
    actor: "设备运维 Agent",
    status: "未开始",
    input: "已填写的点检结果",
    human: "暂不参与。",
    agent: "汇总结果，标记偏离项并生成点检记录草稿。",
    output: "点检记录草稿与偏离项清单",
    confirm: "张工确认记录草稿",
    next: "04 确认并归档",
    evidence: ["点检记录模板（待确认）"],
    permission: "Agent 生成草稿；张工确认"
  },
  {
    id: "PI-04",
    name: "确认并归档",
    actorType: "human",
    actor: "张工（设备 Owner）",
    status: "未开始",
    input: "点检记录草稿、偏离项清单",
    human: "确认记录内容并归档；有偏离项时决定是否转入异常排查。",
    agent: "归档记录并更新设备流水账。",
    output: "AR-203 今日点检记录",
    confirm: "张工确认归档（必须人工）",
    next: "05 任务完成",
    evidence: ["AR-203 设备流水账"],
    permission: "张工确认；Agent 归档"
  },
  {
    id: "PI-05",
    name: "任务完成与提醒",
    actorType: "agent",
    actor: "设备运维 Agent",
    status: "未开始",
    input: "已归档的点检记录",
    human: "暂不参与。",
    agent: "关闭今日点检任务，生成明日提醒；有偏离项时同步给李工。",
    output: "任务完成状态与明日提醒",
    confirm: "无需人工确认（任务收尾）",
    next: "任务关闭",
    evidence: ["日常点检计划"],
    permission: "Agent 收尾；不涉及设备控制"
  }
];

const processCases = {
  workorder: {
    key: "workorder",
    type: "workorder",
    kicker: "CURRENT WORK ORDER",
    label: "设备异常排查",
    description: `工单 ${workOrder.id} · ${workOrder.title}。${workOrder.currentStep}，第 3 步由设备运维 Agent 执行，第 4 步处置需张工确认。`,
    steps: troubleshootSteps,
    banner: workOrder
  },
  task: {
    key: "task",
    type: "task",
    kicker: "CURRENT DAILY TASK",
    label: "日常保养执行 · 开机前点检",
    description: `${dailyTasks[0].id} · ${dailyTasks[0].title}。${dailyTasks[0].node}，Agent 已生成点检清单，张工逐项确认后归档。`,
    steps: pointInspectionSteps,
    banner: dailyTasks[0]
  }
};

// ---- 六、三视角数据看板（记录级演示数据 + 现场计算）------------------------
//
// 🔴 看板上的每一个数字都是**现算的**：下面只放两类"记录"——
//    ① runRecords：每台设备每一天的开机率 / 利用率 / 产能达成率 / 当天状态；
//    ② boardOrders：每一张工单与任务，带设备、负责人、开单日、闭环日、人工确认节点。
//    KPI 卡、趋势图、环形分布、条形图、任务指标、下钻明细表全部由这两类记录聚合而来，
//    所以顶部筛选器一切，整屏跟着重算。全部为演示数据（页面保留「示例数据」角标）。

const BOARD_TODAY = "2026-09-15";
const BOARD_PLANNED_HOURS_PER_DAY = 12; // 单台设备每天的计划可用工时（演示口径）

const boardPeriods = [
  { value: "week", label: "近 7 天", from: "2026-09-09", to: BOARD_TODAY },
  { value: "month", label: "本月", from: "2026-09-01", to: BOARD_TODAY },
  { value: "quarter", label: "本季度", from: "2026-07-01", to: BOARD_TODAY }
];

const boardDeviceBaseline = {
  "AR-203": { powerOn: 92, utilization: 86, output: 94 },
  "AR-204": { powerOn: 88, utilization: 78, output: 91 },
  "LR-205": { powerOn: 94, utilization: 91, output: 96 }
};

// 每台设备 15 天一个周期的波动（整数，一个周期内和为 0）。
// 因此「本月」（09-01 ~ 09-15，正好 15 天）的均值 = 上面的基线值，
// 与设备档案、设备专家回答里公布的数字完全对得上；
// 「近 7 天」只取后 7 项（都为正），「本季度」还叠加 7/8 月的月度基准差。
const boardWave = {
  "AR-203": [-3, -2, -2, -1, -1, 0, -1, 0, 1, 1, 2, 2, 1, 2, 1],
  "AR-204": [-2, -3, -1, -2, 0, -1, -1, 1, 0, 1, 1, 2, 2, 2, 1],
  "LR-205": [-1, -2, -2, 0, -1, -1, -2, 0, 1, 2, 1, 2, 1, 1, 1]
};

const boardMonthOffset = { "2026-07": -3, "2026-08": -1, "2026-09": 0 };

// 设备-日状态：默认正常运行，下面是演示期内有记录的例外区间。
const boardStatusEvents = [
  { device: "AR-203", from: "2026-07-08", to: "2026-07-08", status: "计划保养" },
  { device: "AR-203", from: "2026-08-27", to: "2026-08-28", status: "计划保养" },
  { device: "AR-203", from: "2026-09-11", to: "2026-09-12", status: "异常待处理" },
  { device: "AR-204", from: "2026-07-22", to: "2026-07-23", status: "停机" },
  { device: "AR-204", from: "2026-08-14", to: "2026-08-14", status: "计划保养" },
  { device: "AR-204", from: "2026-09-13", to: "2026-09-15", status: "计划保养" },
  { device: "LR-205", from: "2026-07-18", to: "2026-07-19", status: "停机" },
  { device: "LR-205", from: "2026-08-30", to: "2026-08-30", status: "计划保养" },
  { device: "LR-205", from: "2026-09-01", to: "2026-09-01", status: "计划保养" },
  { device: "LR-205", from: "2026-09-13", to: "2026-09-13", status: "异常待处理" }
];

const boardStatusPalette = {
  正常运行: "#176b61",
  计划保养: "#8fa8a3",
  异常待处理: "#e6b461",
  停机: "#b9c1be"
};

const boardDateAdd = (iso, days) => {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

const boardDateRange = (from, to) => {
  const list = [];
  for (let cursor = from; cursor <= to; cursor = boardDateAdd(cursor, 1)) list.push(cursor);
  return list;
};

const boardDayStatus = (deviceId, date) => {
  const hit = boardStatusEvents.find(
    (event) => event.device === deviceId && date >= event.from && date <= event.to
  );
  return hit ? hit.status : "正常运行";
};

const boardClamp = (value) => Math.max(0, Math.min(100, value));

// 逐日运行记录（演示数据，生成规则见上面的注释，刷新页面结果完全一致）。
const runRecords = (() => {
  const records = [];
  const dates = boardDateRange("2026-07-01", BOARD_TODAY);
  masterData.devices.forEach((device) => {
    const base = boardDeviceBaseline[device.id];
    const wave = boardWave[device.id];
    if (!base || !wave) return;
    dates.forEach((date, index) => {
      const slot = index % wave.length;
      const monthly = boardMonthOffset[date.slice(0, 7)] ?? 0;
      const status = boardDayStatus(device.id, date);
      const stopped = status === "停机";
      records.push({
        date,
        device: device.id,
        line: device.line,
        plant: device.plant,
        type: device.type,
        owner: device.owner,
        status,
        powerOn: stopped ? 0 : boardClamp(base.powerOn + wave[slot] + monthly),
        utilization: stopped ? 0 : boardClamp(base.utilization + wave[(slot + 5) % wave.length] + monthly),
        output: stopped ? 0 : boardClamp(base.output + wave[(slot + 10) % wave.length] + monthly),
        plannedHours: BOARD_PLANNED_HOURS_PER_DAY
      });
    });
  });
  return records;
})();

// 工单与任务记录：closed 为空表示还没闭环；manual 是不可跳过的人工确认节点。
const boardOrders = [
  { id: "WO-20260915-001", type: "异常排查", device: "AR-203", owner: "张工", opened: "2026-09-15", closed: "", manual: "现场现象确认", node: "现场现象确认", next: "资料比对", source: "设备专家", result: "" },
  { id: "TASK-20260915-01", type: "点检", device: "AR-203", owner: "张工", opened: "2026-09-15", closed: "", manual: "点检归档确认", node: "待归档确认", next: "归档点检记录", source: "日常任务", result: "" },
  { id: "TASK-20260915-02", type: "保养", device: "AR-204", owner: "李工", opened: "2026-09-15", closed: "", manual: "保养窗口确认", node: "待安排窗口", next: "现场保养执行", source: "保养计划", result: "" },
  { id: "TASK-20260915-03", type: "维修更换", device: "LR-205", owner: "王工", opened: "2026-09-15", closed: "", manual: "供应商选择", node: "待确认供应商", next: "生成采购需求", source: "维修更换流程", result: "" },
  { id: "QUEUE-TASK-06", type: "异常排查", device: "LR-205", owner: "李工", opened: "2026-09-15", closed: "", manual: "参数复核确认", node: "等待参数补充", next: "复核耦合参数", source: "任务队列", result: "" },
  { id: "QUEUE-TASK-07", type: "保养", device: "AR-203", owner: "张工", opened: "2026-09-14", closed: "", manual: "保养窗口确认", node: "等待窗口确认", next: "排入计划停机", source: "任务队列", result: "" },
  { id: "QUEUE-TASK-08", type: "采购比价", device: "LR-205", owner: "王工", opened: "2026-09-14", closed: "", manual: "到货登记确认", node: "等待到货登记", next: "登记到货并验收", source: "任务队列", result: "" },
  { id: "WO-20260914-035", type: "异常排查", device: "AR-203", owner: "张工", opened: "2026-09-13", closed: "", manual: "维护结论确认", node: "待现场复核", next: "复核后关闭", source: "设备流程", result: "" },

  { id: "TASK-20260913-01", type: "保养", device: "LR-205", owner: "李工", opened: "2026-09-12", closed: "2026-09-13", manual: "保养窗口确认", node: "已闭环", next: "", source: "保养计划", result: "验收通过" },
  { id: "TASK-20260912-02", type: "点检", device: "AR-203", owner: "张工", opened: "2026-09-12", closed: "2026-09-12", manual: "点检归档确认", node: "已闭环", next: "", source: "日常任务", result: "记录已归档" },
  { id: "TASK-20260911-04", type: "点检", device: "AR-204", owner: "张工", opened: "2026-09-11", closed: "2026-09-11", manual: "点检归档确认", node: "已闭环", next: "", source: "日常任务", result: "无偏离项" },
  { id: "WO-20260911-002", type: "异常排查", device: "AR-203", owner: "张工", opened: "2026-09-10", closed: "2026-09-11", manual: "维护结论确认", node: "已闭环", next: "", source: "设备流程", result: "参数已复核" },
  { id: "TASK-20260910-03", type: "保养", device: "LR-205", owner: "李工", opened: "2026-09-09", closed: "2026-09-10", manual: "保养窗口确认", node: "已闭环", next: "", source: "保养计划", result: "按计划完成" },
  { id: "TASK-20260908-01", type: "点检", device: "AR-203", owner: "张工", opened: "2026-09-08", closed: "2026-09-08", manual: "点检归档确认", node: "已闭环", next: "", source: "日常任务", result: "无偏离项" },
  { id: "TASK-20260905-02", type: "点检", device: "AR-204", owner: "张工", opened: "2026-09-05", closed: "2026-09-05", manual: "点检归档确认", node: "已闭环", next: "", source: "日常任务", result: "无偏离项" },
  { id: "WO-20260904-018", type: "异常排查", device: "AR-204", owner: "张工", opened: "2026-09-02", closed: "2026-09-04", manual: "维护结论确认", node: "已闭环", next: "", source: "设备流程", result: "老化工位复位" },
  { id: "TASK-20260902-01", type: "保养", device: "LR-205", owner: "李工", opened: "2026-09-01", closed: "2026-09-02", manual: "保养窗口确认", node: "已闭环", next: "", source: "保养计划", result: "按计划完成" },

  { id: "TASK-20260828-01", type: "保养", device: "AR-203", owner: "张工", opened: "2026-08-27", closed: "2026-08-28", manual: "保养窗口确认", node: "已闭环", next: "", source: "保养计划", result: "按计划完成" },
  { id: "WO-20260822-011", type: "维修更换", device: "AR-204", owner: "王工", opened: "2026-08-18", closed: "2026-08-22", manual: "供应商选择", node: "已闭环", next: "", source: "维修更换流程", result: "备件已更换" },
  { id: "TASK-20260814-02", type: "保养", device: "AR-204", owner: "李工", opened: "2026-08-13", closed: "2026-08-14", manual: "保养窗口确认", node: "已闭环", next: "", source: "保养计划", result: "按计划完成" },
  { id: "TASK-20260812-03", type: "点检", device: "LR-205", owner: "李工", opened: "2026-08-12", closed: "2026-08-12", manual: "点检归档确认", node: "已闭环", next: "", source: "日常任务", result: "无偏离项" },
  { id: "WO-20260806-004", type: "异常排查", device: "AR-203", owner: "张工", opened: "2026-08-04", closed: "2026-08-06", manual: "维护结论确认", node: "已闭环", next: "", source: "设备流程", result: "张力基线回归" },
  { id: "TASK-20260802-01", type: "点检", device: "AR-203", owner: "张工", opened: "2026-08-02", closed: "2026-08-02", manual: "点检归档确认", node: "已闭环", next: "", source: "日常任务", result: "无偏离项" },
  { id: "QUEUE-20260726-09", type: "采购比价", device: "LR-205", owner: "王工", opened: "2026-07-22", closed: "2026-07-26", manual: "供应商选择", node: "已闭环", next: "", source: "采购比价流程", result: "供应商已确认" },
  { id: "WO-20260723-006", type: "维修更换", device: "AR-204", owner: "王工", opened: "2026-07-20", closed: "2026-07-23", manual: "供应商选择", node: "已闭环", next: "", source: "维修更换流程", result: "停机后已复产" },
  { id: "TASK-20260719-02", type: "保养", device: "LR-205", owner: "李工", opened: "2026-07-18", closed: "2026-07-19", manual: "保养窗口确认", node: "已闭环", next: "", source: "保养计划", result: "耦合工位复位" },
  { id: "TASK-20260708-01", type: "保养", device: "AR-203", owner: "张工", opened: "2026-07-07", closed: "2026-07-08", manual: "保养窗口确认", node: "已闭环", next: "", source: "保养计划", result: "按计划完成" },
  { id: "TASK-20260703-02", type: "点检", device: "AR-204", owner: "张工", opened: "2026-07-03", closed: "2026-07-03", manual: "点检归档确认", node: "已闭环", next: "", source: "日常任务", result: "无偏离项" }
];

// ---- 看板筛选器：只保留在演示数据里真的分得开的维度 ------------------------
// 🔴 某个维度在 masterData.devices 里只有一个取值时，这里直接**不生成**这个筛选器。
//    宁可少一个筛选器，也不要挂一个永远只有一个选项、切了什么都不变的死下拉。

const boardDimensionSpecs = [
  { key: "plant", label: "厂区", allLabel: "全部厂区", pick: (device) => device.plant },
  { key: "line", label: "产线", allLabel: "全部产线", pick: (device) => device.line },
  { key: "type", label: "设备类型", allLabel: "全部类型", pick: (device) => device.type },
  { key: "owner", label: "设备 Owner", allLabel: "全部 Owner", pick: (device) => device.owner }
];

const boardDimensionValues = (spec) => [
  ...new Set(masterData.devices.map(spec.pick).filter(Boolean))
];

const boardActiveDimensions = () =>
  boardDimensionSpecs
    .filter((spec) => boardDimensionValues(spec).length > 1)
    .map((spec) => ({
      key: spec.key,
      label: spec.label,
      options: [
        { value: "all", label: spec.allLabel },
        ...boardDimensionValues(spec).map((value) => ({ value, label: value }))
      ]
    }));

// 被去掉的维度也要交代清楚，而不是让人以为忘了做。
const boardFixedDimensions = () =>
  boardDimensionSpecs
    .filter((spec) => boardDimensionValues(spec).length === 1)
    .map((spec) => ({ label: spec.label, value: boardDimensionValues(spec)[0] }));

const boardFilterDefaults = () => {
  const filters = { period: "month" };
  boardActiveDimensions().forEach((dimension) => { filters[dimension.key] = "all"; });
  return filters;
};

const boardPeriodOf = (value) =>
  boardPeriods.find((period) => period.value === value) || boardPeriods[1];

const boardMatchDevice = (device, filters) =>
  boardDimensionSpecs.every((spec) => {
    const wanted = filters[spec.key];
    return !wanted || wanted === "all" || spec.pick(device) === wanted;
  });

const boardRound1 = (value) => Math.round(value * 10) / 10;
const boardAvg = (list, pick) =>
  list.length ? boardRound1(list.reduce((sum, item) => sum + pick(item), 0) / list.length) : 0;
const boardPct = (value) => `${boardRound1(value)}%`;

function boardSlice(filters) {
  const period = boardPeriodOf(filters.period);
  const devices = masterData.devices.filter((device) => boardMatchDevice(device, filters));
  const deviceIds = devices.map((device) => device.id);
  const records = runRecords.filter(
    (record) => deviceIds.includes(record.device) && record.date >= period.from && record.date <= period.to
  );
  const orders = boardOrders.filter((order) => deviceIds.includes(order.device));
  const openOrders = orders.filter((order) => !order.closed && order.opened <= period.to);
  const closedOrders = orders.filter(
    (order) => order.closed && order.closed >= period.from && order.closed <= period.to
  );
  const days = boardDateRange(period.from, period.to);
  const scopeBits = [masterData.plant];
  boardActiveDimensions().forEach((dimension) => {
    const value = filters[dimension.key];
    if (value && value !== "all") scopeBits.push(value);
    else scopeBits.push(dimension.options[0].label);
  });
  scopeBits.push(period.label);
  return { period, devices, deviceIds, records, orders, openOrders, closedOrders, days, scope: scopeBits.join(" / ") };
}

function boardTrendPoints(records, days, key) {
  const bucketSize = days.length > 20 ? 7 : 1;
  const buckets = [];
  for (let index = 0; index < days.length; index += bucketSize) {
    const slice = days.slice(index, index + bucketSize);
    const inBucket = records.filter((record) => slice.includes(record.date));
    if (!inBucket.length) continue;
    buckets.push({
      label: slice[0].slice(5),
      value: boardAvg(inBucket, (record) => record[key])
    });
  }
  return buckets;
}

function boardStatusRows(records) {
  const order = ["正常运行", "计划保养", "异常待处理", "停机"];
  const total = records.length;
  return order
    .map((label) => {
      const count = records.filter((record) => record.status === label).length;
      const percent = total ? boardRound1((count / total) * 100) : 0;
      return [label, String(count), `${percent}%`, boardStatusPalette[label]];
    })
    .filter((row) => Number(row[1]) > 0);
}

function boardBars(slice) {
  const lines = [...new Set(slice.devices.map((device) => device.line))];
  const lineRows = lines.map((line) => {
    const inLine = slice.records.filter((record) => record.line === line);
    const value = boardAvg(inLine, (record) => record.utilization);
    return { label: line.replace("产线 ", "").replace("800G ", "800G "), value, text: boardPct(value), note: `${line} 平均` };
  });
  const deviceRows = slice.devices.map((device) => {
    const inDevice = slice.records.filter((record) => record.device === device.id);
    const value = boardAvg(inDevice, (record) => record.utilization);
    return { label: device.id, value, text: boardPct(value) };
  });
  return [...lineRows, ...deviceRows];
}

function boardCloseDays(order) {
  const opened = new Date(`${order.opened}T00:00:00Z`).getTime();
  const closed = new Date(`${order.closed}T00:00:00Z`).getTime();
  return Math.max(0.4, (closed - opened) / 86400000);
}

function boardDeviceRow(device, slice) {
  const inDevice = slice.records.filter((record) => record.device === device.id);
  const latest = inDevice[inDevice.length - 1];
  const open = slice.openOrders.filter((order) => order.device === device.id).length;
  return {
    device,
    records: inDevice,
    status: latest ? latest.status : "无记录",
    powerOn: boardAvg(inDevice, (record) => record.powerOn),
    utilization: boardAvg(inDevice, (record) => record.utilization),
    output: boardAvg(inDevice, (record) => record.output),
    open
  };
}

const boardEmptyTable = (head, note) => ({
  head,
  rows: [],
  emptyNote: note
});

function boardDrilldowns(slice, rows) {
  const period = slice.period;
  const manualRows = slice.openOrders
    .filter((order) => order.manual)
    .map((order) => [order.manual, order.id, order.owner, "等待确认", order.device]);
  return {
    设备总数: {
      title: `设备台账明细 · ${period.label}`,
      head: ["设备", "产线", "设备类型", "当前状态", "负责人"],
      rows: rows.map((row) => [row.device.id, row.device.line, row.device.type, row.status, row.device.owner]),
      emptyNote: "这个筛选范围里没有设备。"
    },
    开机率: {
      title: `设备开机率明细 · ${period.label}`,
      head: ["设备", "产线", "平均开机率", "统计天数", "当前状态"],
      rows: rows.map((row) => [row.device.id, row.device.line, boardPct(row.powerOn), `${row.records.length} 天`, row.status]),
      emptyNote: "这个筛选范围里没有运行记录。"
    },
    利用率: {
      title: `设备利用率明细 · ${period.label}`,
      head: ["设备", "平均利用率", "平均开机率", "当前状态", "负责人"],
      rows: rows.map((row) => [row.device.id, boardPct(row.utilization), boardPct(row.powerOn), row.status, row.device.owner]),
      emptyNote: "这个筛选范围里没有运行记录。"
    },
    产能达成率: {
      title: `产能达成明细 · ${period.label}`,
      head: ["设备", "产线", "平均达成率", "统计天数", "负责人"],
      rows: rows.map((row) => [row.device.id, row.device.line, boardPct(row.output), `${row.records.length} 天`, row.device.owner]),
      emptyNote: "这个筛选范围里没有产能记录。"
    },
    设备状态: {
      title: `设备-日状态明细 · ${period.label}`,
      head: ["状态", "设备-日", "占比", "口径"],
      rows: boardStatusRows(slice.records).map((row) => [row[0], row[1], row[2], "逐日运行记录"]),
      emptyNote: "这个筛选范围里没有运行记录。"
    },
    待处理工单: {
      title: `未闭环工单明细 · 截至 ${period.to.slice(5)}`,
      head: ["工单 / 任务", "设备", "类型", "负责人", "当前节点"],
      rows: slice.openOrders.map((order) => [order.id, order.device, order.type, order.owner, order.node]),
      emptyNote: "这个筛选范围里没有未闭环的工单。"
    },
    已闭环任务: {
      title: `闭环任务明细 · ${period.label}`,
      head: ["任务", "设备", "类型", "责任人", "闭环日期"],
      rows: slice.closedOrders.map((order) => [order.id, order.device, order.type, order.owner, order.closed.slice(5)]),
      emptyNote: `这个筛选范围里，${period.label}内没有闭环任务。`
    },
    平均闭环时长: {
      title: `闭环效率明细 · ${period.label}`,
      head: ["任务类型", "闭环数量", "平均时长", "最长", "最短"],
      rows: [...new Set(slice.closedOrders.map((order) => order.type))].map((type) => {
        const list = slice.closedOrders.filter((order) => order.type === type).map(boardCloseDays);
        return [
          type,
          `${list.length} 单`,
          `${boardRound1(list.reduce((sum, value) => sum + value, 0) / list.length)} 天`,
          `${boardRound1(Math.max(...list))} 天`,
          `${boardRound1(Math.min(...list))} 天`
        ];
      }),
      emptyNote: `这个筛选范围里，${period.label}内没有闭环任务，算不出平均时长。`
    },
    人工确认节点: {
      title: "不可跳过的人工确认节点",
      head: ["确认节点", "关联任务", "责任人", "状态", "设备"],
      rows: manualRows,
      emptyNote: "这个筛选范围里没有等待人工确认的节点。"
    }
  };
}

function buildDashboard(view, filters) {
  const slice = boardSlice(filters);
  const period = slice.period;
  if (!slice.devices.length) {
    return {
      empty: true,
      scope: slice.scope,
      emptyTitle: "这个筛选范围里没有设备",
      emptyHint: "示例数据里没有同时满足这些条件的设备，所以没有任何可以统计的运行记录和工单。换一个条件，或者清除筛选。",
      kpis: [],
      drilldowns: {}
    };
  }
  const rows = slice.devices.map((device) => boardDeviceRow(device, slice));
  const powerOn = boardAvg(slice.records, (record) => record.powerOn);
  const utilization = boardAvg(slice.records, (record) => record.utilization);
  const output = boardAvg(slice.records, (record) => record.output);
  const closeDays = slice.closedOrders.map(boardCloseDays);
  const avgClose = closeDays.length
    ? boardRound1(closeDays.reduce((sum, value) => sum + value, 0) / closeDays.length)
    : 0;
  const manualCount = slice.openOrders.filter((order) => order.manual).length;
  const trendKey = view === "owner" ? "utilization" : "output";
  const trendName = view === "owner" ? "利用率" : "产能达成率";
  const points = boardTrendPoints(slice.records, slice.days, trendKey);
  const trendValues = points.map((point) => point.value);
  const lastTwo = trendValues.slice(-2);
  const trendDelta = lastTwo.length === 2 ? boardRound1(lastTwo[1] - lastTwo[0]) : 0;
  const lineNames = [...new Set(slice.devices.map((device) => device.line))];

  const kpiByView = {
    management: [
      { label: "设备总数", value: String(slice.devices.length), change: slice.deviceIds.join(" / "), source: "设备台账", metric: "设备总数" },
      { label: "开机率", value: boardPct(powerOn), change: `${slice.records.length} 条设备-日运行记录`, source: "设备运行记录", metric: "开机率" },
      { label: "利用率", value: boardPct(utilization), change: `${period.label} · ${slice.days.length} 天`, source: "生产记录", metric: "利用率" },
      { label: "产能达成率", value: boardPct(output), change: lineNames.join(" · "), source: "生产计划", metric: "产能达成率" },
      { label: "待处理工单", value: String(slice.openOrders.length), change: slice.openOrders.length ? `${manualCount} 个待人工确认` : "所选范围内没有未闭环工单", source: "设备流程", metric: "待处理工单" }
    ],
    factory: [
      { label: "在产产线", value: String(lineNames.length), change: lineNames.join(" · "), source: "设备台账", metric: "设备总数" },
      { label: "平均开机率", value: boardPct(powerOn), change: `${period.label}逐日均值`, source: "设备运行记录", metric: "开机率" },
      { label: "平均产能达成", value: boardPct(output), change: `${slice.devices.length} 台设备汇总`, source: "生产计划", metric: "产能达成率" },
      { label: "计划保养日", value: String(slice.records.filter((record) => record.status === "计划保养").length), change: "设备-日口径", source: "保养计划", metric: "设备状态" },
      { label: "停机日", value: String(slice.records.filter((record) => record.status === "停机").length), change: slice.records.some((record) => record.status === "停机") ? "设备-日口径" : "所选范围内没有停机记录", source: "设备运行记录", metric: "设备状态" }
    ],
    owner: [
      { label: "我负责设备", value: String(slice.devices.length), change: slice.deviceIds.join(" / "), source: "设备台账", metric: "设备总数" },
      { label: "待办任务", value: String(slice.openOrders.length), change: slice.openOrders.length ? `${manualCount} 个待我确认` : "所选范围内没有待办", source: "设备流程", metric: "待处理工单" },
      { label: "期内已闭环", value: String(slice.closedOrders.length), change: slice.closedOrders.length ? `平均 ${avgClose} 天` : `${period.label}内没有闭环任务`, source: "工单中心", metric: "已闭环任务" },
      { label: "平均利用率", value: boardPct(utilization), change: rows.map((row) => `${row.device.id} ${boardPct(row.utilization)}`).join(" / "), source: "生产记录", metric: "利用率" },
      { label: "未关闭异常", value: String(slice.openOrders.filter((order) => order.type === "异常排查").length), change: slice.openOrders.some((order) => order.type === "异常排查") ? "异常排查类工单" : "所选范围内没有未关闭异常", source: "工单中心", metric: "待处理工单" }
    ]
  };

  const tableByView = {
    management: {
      head: ["设备", "当前状态", "开机率", "利用率", "产能达成率", "负责人", "未闭环工单"],
      rows: rows.map((row) => [row.device.id, row.status, boardPct(row.powerOn), boardPct(row.utilization), boardPct(row.output), row.device.owner, String(row.open)])
    },
    factory: {
      head: ["产线", "设备数", "开机率", "利用率", "产能达成", "未闭环工单", "负责人"],
      rows: lineNames.map((line) => {
        const inLine = slice.records.filter((record) => record.line === line);
        const lineDevices = slice.devices.filter((device) => device.line === line);
        const open = slice.openOrders.filter((order) => lineDevices.some((device) => device.id === order.device)).length;
        return [
          line,
          String(lineDevices.length),
          boardPct(boardAvg(inLine, (record) => record.powerOn)),
          boardPct(boardAvg(inLine, (record) => record.utilization)),
          boardPct(boardAvg(inLine, (record) => record.output)),
          String(open),
          [...new Set(lineDevices.map((device) => device.owner))].join(" / ")
        ];
      })
    },
    owner: {
      head: ["设备", "当前状态", "未闭环工单", "期内闭环", "利用率", "产线", "负责人"],
      rows: rows.map((row) => [
        row.device.id,
        row.status,
        String(row.open),
        String(slice.closedOrders.filter((order) => order.device === row.device.id).length),
        boardPct(row.utilization),
        row.device.line,
        row.device.owner
      ])
    }
  };

  const titleByView = {
    management: "设备明细",
    factory: "产线明细",
    owner: "我的设备与任务"
  };

  return {
    empty: false,
    scope: slice.scope,
    drilldownTitle: titleByView[view] || "设备明细",
    kpis: kpiByView[view] || kpiByView.management,
    trend: {
      title: `${period.label}${trendName}趋势`,
      value: trendValues.length ? boardPct(trendValues[trendValues.length - 1]) : "—",
      delta: trendValues.length > 1
        ? `最新一${slice.days.length > 20 ? "周" : "日"}（${points[points.length - 1].label}）· 较上一${slice.days.length > 20 ? "周" : "日"} ${trendDelta >= 0 ? "+" : ""}${trendDelta} 个百分点`
        : "所选范围内只有一个数据点",
      subtitle: `${slice.deviceIds.join(" · ")} · ${period.label}`,
      labels: points.map((point) => point.label),
      values: trendValues,
      unit: "%"
    },
    status: {
      title: `设备状态分布 · ${period.label}`,
      total: slice.records.length,
      totalLabel: "设备运行日",
      rows: boardStatusRows(slice.records),
      emptyNote: "这个筛选范围里没有运行记录。"
    },
    bars: {
      title: `产线 / 设备利用率 · ${period.label}`,
      rows: boardBars(slice),
      emptyNote: "这个筛选范围里没有可比较的设备。"
    },
    tasks: {
      title: `工单与任务 · ${period.label}`,
      rows: [
        ["待处理工单", String(slice.openOrders.length), slice.openOrders.length ? [...new Set(slice.openOrders.map((order) => order.type))].join(" / ") : "所选范围内没有未闭环工单"],
        ["已闭环任务", String(slice.closedOrders.length), slice.closedOrders.length ? `${period.label}内闭环` : `${period.label}内没有闭环任务`],
        ["平均闭环时长", closeDays.length ? `${avgClose} 天` : "—", closeDays.length ? `按 ${closeDays.length} 单计算` : "没有闭环任务，算不出均值"],
        ["人工确认节点", String(manualCount), manualCount ? "不可跳过的关键确认" : "所选范围内没有待确认节点"]
      ]
    },
    table: tableByView[view] || tableByView.management,
    drilldowns: boardDrilldowns(slice, rows)
  };
}


const deviceDetailData = {
  "AR-203": {
    id: "AR-203",
    name: "张力控制工位",
    status: "运行中",
    line: "厂区 A / 800G 产线 A",
    owner: "张工（设备 Owner）",
    updated: "2026-09-15 10:30",
    summary: "当前处于换线后稳定运行阶段，张力波动问题仍在跟踪，现场确认后归档。",
    metrics: [
      ["今日运行", "9 小时", "计划可用 12 小时"],
      ["今日利用率", "75%", "9 小时 / 12 小时"],
      ["本周利用率", "86%", "较上周 +1 个百分点"],
      ["待处理事项", "1", "WO-20260915-001"]
    ],
    timeline: [
      [0, 2.5, "running", "运行"],
      [2.5, 3, "idle", "空闲"],
      [3, 7, "running", "运行"],
      [7, 8, "maintenance", "保养"],
      [8, 10.5, "running", "运行"]
    ],
    events: [
      { time: "10:30", type: "运行", duration: "进行中", actor: "设备运维 Agent", order: "WO-20260915-001", status: "排查中", note: "持续跟踪张力波动，等待现场确认。" },
      { time: "08:00", type: "运行", duration: "2.5 小时", actor: "张工", order: "-", status: "正常", note: "换线后参数复核完成，进入稳定运行。" },
      { time: "07:00", type: "保养", duration: "1 小时", actor: "李工", order: "TASK-20260915-02", status: "已完成", note: "完成导轨清洁和传感器零点校验。" },
      { time: "03:00", type: "运行", duration: "4 小时", actor: "设备运行记录", order: "-", status: "正常", note: "连续生产，无异常停机。" },
      { time: "00:00", type: "运行", duration: "2.5 小时", actor: "设备运行记录", order: "-", status: "正常", note: "夜班稳定运行。" }
    ],
    basis: {
      scope: "2026-09-15 00:00 - 10:30 / 厂区 A / 800G 产线 A",
      formula: "利用率 = 实际运行时长 9 小时 / 计划可用时长 12 小时 × 100%",
      source: "设备运行记录、生产计划、工单中心",
      updated: "2026-09-15 10:30",
      records: "时间轴 5 段 · 事件流水 5 条 · 关联工单 1 条"
    }
  },
  "AR-204": {
    id: "AR-204",
    name: "老化测试工位",
    status: "计划保养",
    line: "厂区 A / 800G 产线 A",
    owner: "张工（设备 Owner）· 李工（运维协作）",
    updated: "2026-09-15 10:30",
    summary: "下一保养窗口待确认，Agent 已生成保养清单和备件需求，现场确认后进入执行。",
    metrics: [
      ["今日运行", "4 小时", "计划可用 12 小时"],
      ["今日利用率", "33.3%", "4 小时 / 12 小时"],
      ["本周利用率", "78%", "较上周 -0.5 个百分点"],
      ["待处理事项", "1", "TASK-20260915-02"]
    ],
    timeline: [
      [0, 2, "running", "运行"],
      [2, 4, "idle", "空闲"],
      [4, 6, "running", "运行"],
      [6, 8, "maintenance", "计划保养"],
      [8, 10.5, "idle", "空闲"]
    ],
    events: [
      { time: "10:20", type: "计划保养", duration: "待安排", actor: "设备运维 Agent", order: "TASK-20260915-02", status: "待确认", note: "等待张工确认停机窗口与责任人。" },
      { time: "08:00", type: "保养准备", duration: "30 分钟", actor: "设备运维 Agent", order: "-", status: "已完成", note: "生成保养清单和备件需求。" },
      { time: "04:00", type: "运行", duration: "2 小时", actor: "设备运行记录", order: "-", status: "正常", note: "完成老化工位测试批次。" },
      { time: "00:00", type: "运行", duration: "2 小时", actor: "设备运行记录", order: "-", status: "正常", note: "夜班测试任务按计划执行。" }
    ],
    basis: {
      scope: "2026-09-15 00:00 - 10:30 / 厂区 A / 800G 产线 A",
      formula: "利用率 = 实际运行时长 4 小时 / 计划可用时长 12 小时 × 100%",
      source: "设备运行记录、保养计划、设备流程",
      updated: "2026-09-15 10:30",
      records: "时间轴 5 段 · 事件流水 4 条 · 关联任务 1 条"
    }
  },
  "LR-205": {
    id: "LR-205",
    name: "耦合工位",
    status: "运行中",
    line: "厂区 A / 800G 产线 B",
    owner: "张工（设备 Owner）· 王工（采购协作）",
    updated: "2026-09-15 10:30",
    summary: "当前运行稳定，上一轮耦合参数偏差已闭环，本周重点关注利用率波动。",
    metrics: [
      ["今日运行", "8.5 小时", "计划可用 12 小时"],
      ["今日利用率", "70.8%", "8.5 小时 / 12 小时"],
      ["本周利用率", "91%", "较上周 +2 个百分点"],
      ["待处理事项", "1", "QUEUE-20260915-06"]
    ],
    timeline: [
      [0, 3, "running", "运行"],
      [3, 4, "idle", "空闲"],
      [4, 8, "running", "运行"],
      [8, 9, "repair", "维修"],
      [9, 10.5, "running", "运行"]
    ],
    events: [
      { time: "10:15", type: "运行", duration: "进行中", actor: "设备运维 Agent", order: "QUEUE-20260915-06", status: "排队中", note: "等待李工补充上次参数偏差值。" },
      { time: "09:00", type: "维修", duration: "1 小时", actor: "李工", order: "WO-20260913-018", status: "已闭环", note: "完成耦合参数复核与设备复位。" },
      { time: "04:00", type: "运行", duration: "4 小时", actor: "设备运行记录", order: "-", status: "正常", note: "800G 批次稳定运行。" },
      { time: "00:00", type: "运行", duration: "3 小时", actor: "设备运行记录", order: "-", status: "正常", note: "夜班首轮运行正常。" }
    ],
    basis: {
      scope: "2026-09-15 00:00 - 10:30 / 厂区 A / 800G 产线 B",
      formula: "利用率 = 实际运行时长 8.5 小时 / 计划可用时长 12 小时 × 100%",
      source: "设备运行记录、维修记录、工单中心",
      updated: "2026-09-15 10:30",
      records: "时间轴 5 段 · 事件流水 4 条 · 关联工单 1 条"
    }
  }
};

// ---- 七、知识图谱复杂关系 --------------------------------------------------

const stableGraphNode = (
  id,
  type,
  objectType,
  label,
  subtitle,
  scope,
  summary,
  meta,
  relations,
  source,
  ask = ""
) => ({
  id,
  type,
  objectType,
  label,
  subtitle,
  scope,
  summary,
  meta,
  relations,
  source,
  status: "已确认",
  ask
});

const graphNodes = {
  "AR-203": stableGraphNode(
    "AR-203", "device", "设备", "AR-203", "张力控制设备", "厂区 A / 800G 产线 A / A 线 03 机位",
    "厂商甲的张力控制设备，与 AR-204 共享产线、功能模块、SOP 和部分备件；设备 Owner 张工。",
    [["设备类型", "800G 光模块产线张力控制设备"], ["厂家", "厂商甲"], ["稳定属性", "额定张力范围 / 接口类型 / 适配模块 / 保养周期"]],
    [["属于产线", "800G 产线 A"], ["同系列设备", "AR-204"], ["跨产线设备", "LR-205"], ["配置模块", "张力控制模块"], ["设备 Owner", "张工"]],
    "AR-203 设备主数据"
  ),
  "AR-204": stableGraphNode(
    "AR-204", "device", "设备", "AR-204", "张力控制设备", "厂区 A / 800G 产线 A / A 线 04 机位",
    "与 AR-203 同产线、同设备类型，共享张力控制模块、部分 SOP 和备件。",
    [["设备类型", "800G 光模块产线张力控制设备"], ["厂家", "厂商甲"], ["设备关系", "与 AR-203 同产线且共享模块与备件"]],
    [["属于产线", "800G 产线 A"], ["同系列设备", "AR-203"], ["配置模块", "张力控制模块"], ["设备 Owner", "张工"], ["运维协作", "李工"]],
    "AR-204 设备主数据"
  ),
  "LR-205": stableGraphNode(
    "LR-205", "device", "设备", "LR-205", "张力控制设备", "厂区 A / 800G 产线 B / B 线 05 机位",
    "与 AR-203 分属不同产线、不同设备类型，模块版本、参数标准和保养资料部分不同。",
    [["设备类型", "LR 系列张力控制设备"], ["厂家", "厂商乙"], ["设备关系", "与 AR-203 跨产线且非同系列"]],
    [["属于产线", "800G 产线 B"], ["跨产线设备", "AR-203"], ["配置模块", "张力控制模块 V2"], ["设备 Owner", "张工"], ["采购协作", "王工"]],
    "LR-205 设备主数据"
  ),
  "line-a": stableGraphNode(
    "line-a", "line", "产线", "800G 产线 A", "800G 光模块产线", "厂区 A",
    "包含 AR-203、AR-204 两台张力控制设备，负责部门为制造部。",
    [["产线类型", "800G 光模块产线"], ["关联设备", "2 台"], ["负责部门", "制造部"]],
    [["包含机位", "A 线 03 机位"], ["包含机位", "A 线 04 机位"], ["设备清单", "800G 产线 A 设备清单"], ["所属部门", "制造部"]],
    "800G 产线 A 主数据"
  ),
  "line-b": stableGraphNode(
    "line-b", "line", "产线", "800G 产线 B", "800G 光模块产线", "厂区 A",
    "包含 LR-205 一台张力控制设备，负责部门为制造部。",
    [["产线类型", "800G 光模块产线"], ["关联设备", "1 台"], ["负责部门", "制造部"]],
    [["包含机位", "B 线 05 机位"], ["设备清单", "800G 产线 B 设备清单"], ["所属部门", "制造部"]],
    "800G 产线 B 主数据"
  ),
  "station-a03": stableGraphNode(
    "station-a03", "location", "机位", "A 线 03 机位", "AR-203 安装位置", "厂区 A / 800G 产线 A",
    "安装 AR-203 的标准机位，与 A 线 04 机位相邻。",
    [["安装设备", "AR-203"], ["相邻机位", "A 线 04 机位"], ["安装状态", "已归档"]],
    [["当前设备", "AR-203"], ["相邻设备", "A 线 04 机位"], ["安装规范", "设备安装规范 V1.2"], ["操作记录", "机位操作记录归档"]],
    "厂区 A 机位主数据"
  ),
  "station-a04": stableGraphNode(
    "station-a04", "location", "机位", "A 线 04 机位", "AR-204 安装位置", "厂区 A / 800G 产线 A",
    "安装 AR-204 的标准机位，与 A 线 03 机位相邻。",
    [["安装设备", "AR-204"], ["相邻机位", "A 线 03 机位"], ["安装状态", "已归档"]],
    [["当前设备", "AR-204"], ["相邻设备", "A 线 03 机位"], ["安装规范", "设备安装规范 V1.2"], ["操作记录", "机位操作记录归档"]],
    "厂区 A 机位主数据"
  ),
  "station-b05": stableGraphNode(
    "station-b05", "location", "机位", "B 线 05 机位", "LR-205 安装位置", "厂区 A / 800G 产线 B",
    "安装 LR-205 的厂家乙设备机位。",
    [["安装设备", "LR-205"], ["安装状态", "已归档"], ["厂家", "厂商乙"]],
    [["当前设备", "LR-205"], ["安装规范", "设备安装规范 V1.2"], ["操作记录", "机位操作记录归档"], ["厂家资料", "厂商乙设备资料"]],
    "厂区 A 机位主数据"
  ),
  "module-v1": stableGraphNode(
    "module-v1", "function", "功能模块", "张力控制模块", "V1 设备功能模块", "AR-203 / AR-204",
    "AR-203 与 AR-204 共用的张力控制功能模块，关联传感器、参数和适配备件。",
    [["功能模块", "张力控制"], ["适配设备", "AR-203 / AR-204"], ["关联 SOP", "2 份"]],
    [["配置设备", "AR-203"], ["配置设备", "AR-204"], ["核心传感器", "张力传感器 TS-17"], ["控制参数", "张力控制参数 V2.1"], ["适配备件", "备件 T-17"], ["操作标准", "张力控制模块操作标准 V2.1"], ["同类模块差异", "张力控制模块 V2"]],
    "厂商甲模块资料"
  ),
  "module-v2": stableGraphNode(
    "module-v2", "function", "功能模块", "张力控制模块 V2", "厂商乙专用功能模块", "LR-205",
    "LR-205 使用的 V2 张力控制模块，参数标准和保养资料与 V1 部分不同。",
    [["功能模块", "张力控制 V2"], ["适配设备", "LR-205"], ["厂家", "厂商乙"], ["专用资料", "3 份"]],
    [["配置设备", "LR-205"], ["核心传感器", "张力传感器 TS-21"], ["控制参数", "张力控制参数 V2"], ["适配备件", "备件 T-21"], ["操作手册", "模块 V2 操作手册 V1.0"]],
    "厂商乙模块资料"
  ),
  "param-v21": stableGraphNode(
    "param-v21", "document", "控制参数", "张力控制参数 V2.1", "模块参数基线", "AR-203 / AR-204",
    "记录 V1 模块的额定张力范围、接口类型和参数版本基线。",
    [["参数版本", "V2.1"], ["额定张力范围", "按厂商甲设备手册"], ["接口类型", "标准化接口"], ["适用模块", "张力控制模块"]],
    [["适用模块", "张力控制模块"], ["资料来源", "厂商甲设备资料"]],
    "张力控制参数 V2.1"
  ),
  "param-v2": stableGraphNode(
    "param-v2", "document", "控制参数", "张力控制参数 V2", "厂商乙参数基线", "LR-205",
    "记录 V2 模块的额定张力范围、接口类型和厂商乙参数版本基线。",
    [["参数版本", "V2"], ["额定张力范围", "按厂商乙设备手册"], ["接口类型", "厂商乙专用接口"], ["适用模块", "张力控制模块 V2"]],
    [["适用模块", "张力控制模块 V2"], ["资料来源", "厂商乙设备资料"]],
    "张力控制参数 V2"
  ),
  "sensor-ts17": stableGraphNode(
    "sensor-ts17", "function", "传感器", "张力传感器 TS-17", "厂商甲传感器", "AR-203 / AR-204",
    "张力控制模块使用的标准传感器，关联校准规范、校准归档与厂家原始资料。",
    [["传感器型号", "TS-17"], ["适配设备", "AR-203 / AR-204"], ["资料状态", "已归档"]],
    [["所属模块", "张力控制模块"], ["校准规范", "张力传感器校准规范"], ["校准记录", "张力传感器校准记录归档"], ["厂家资料", "厂商甲设备资料"]],
    "厂商甲传感器资料"
  ),
  "sensor-ts21": stableGraphNode(
    "sensor-ts21", "function", "传感器", "张力传感器 TS-21", "厂商乙传感器", "LR-205",
    "LR-205 V2 模块使用的传感器，采用厂商乙专用校准与资料。",
    [["传感器型号", "TS-21"], ["适配设备", "LR-205"], ["资料状态", "已归档"]],
    [["所属模块", "张力控制模块 V2"], ["校准规范", "张力传感器校准规范"], ["校准记录", "张力传感器校准记录归档"], ["厂家资料", "厂商乙设备资料"]],
    "厂商乙传感器资料"
  ),
  "spare-t17": stableGraphNode(
    "spare-t17", "spare", "备件", "备件 T-17", "标准备件", "AR-203 / AR-204",
    "AR-203 与 AR-204 共用的标准张力单元备件。",
    [["适配设备", "AR-203 / AR-204"], ["库存属性", "标准备件"], ["资料", "4 份"]],
    [["适配设备", "AR-203"], ["适配设备", "AR-204"], ["适配传感器", "张力传感器 TS-17"], ["产品说明书", "备件 T-17 产品说明书"], ["保修政策", "备件 T-17 保修政策"]],
    "备件 T-17 主数据"
  ),
  "spare-t21": stableGraphNode(
    "spare-t21", "spare", "备件", "备件 T-21", "厂家乙专用备件", "LR-205",
    "LR-205 V2 模块使用的厂家乙专用备件。",
    [["适配设备", "LR-205"], ["库存属性", "厂家乙专用备件"], ["资料", "3 份"]],
    [["适配设备", "LR-205"], ["适配传感器", "张力传感器 TS-21"], ["产品说明书", "备件 T-21 产品说明书"], ["保修政策", "备件 T-21 保修政策"]],
    "备件 T-21 主数据"
  ),
  "person-zhang": stableGraphNode(
    "person-zhang", "person", "人员", "张工", "设备 Owner · AR-203 / AR-204 / LR-205", "厂区 A / 800G 产线 A · 800G 产线 B",
    "三台设备的设备 Owner，负责异常排查和日常保养的人工确认。",
    [["角色", "设备 Owner"], ["负责设备", "AR-203 / AR-204 / LR-205"], ["关联流程", "2 条"]],
    [["负责设备", "AR-203"], ["负责设备", "AR-204"], ["负责设备", "LR-205"], ["关联 Agent", "设备运维 Agent"], ["待办任务", "AR-203 待办任务"], ["负责流程", "设备异常排查流程"], ["负责流程", "日常保养流程"], ["确认记录", "设备 Owner 确认记录归档"]],
    "设备 Owner 主数据"
  ),
  "person-li": stableGraphNode(
    "person-li", "person", "人员", "李工", "运维负责人 · AR-204 运维协作", "厂区 A / 800G 产线 A",
    "AR-204 的运维协作人（不是设备 Owner），负责启停机确认和维修更换的人工确认。",
    [["角色", "运维负责人"], ["协作设备", "AR-204（运维协作）"], ["关联流程", "2 条"]],
    [["运维协作", "AR-204"], ["关联 Agent", "设备运维 Agent"], ["待办任务", "AR-204 待办任务"], ["负责流程", "启停机确认流程"], ["负责流程", "维修更换流程"], ["确认记录", "运维协作确认记录归档"]],
    "设备 Owner 主数据"
  ),
  "person-wang": stableGraphNode(
    "person-wang", "person", "人员", "王工", "采购 Owner · LR-205 采购协作", "厂区 A / 800G 产线 B",
    "LR-205 的采购协作人（不是设备 Owner），负责备件采购与厂家远程支持的人工确认。",
    [["角色", "采购 Owner"], ["协作设备", "LR-205（采购协作）"], ["关联流程", "2 条"]],
    [["采购协作", "LR-205"], ["关联 Agent", "采购比价 Agent"], ["待办任务", "LR-205 待办任务"], ["负责流程", "维修更换流程"], ["负责流程", "厂家远程支持流程"], ["确认记录", "采购协作确认记录归档"]],
    "设备 Owner 主数据"
  ),
  "agent-ops": stableGraphNode(
    "agent-ops", "agent", "Agent", "设备运维 Agent", "数字同事 · 设备运维", "厂区 A / 设备运维",
    "负责按稳定流程整理信息、生成排查和保养草稿，不直接控制设备。",
    [["能力", "异常排查 / 保养 / 工单归档"], ["权限", "只生成草稿"], ["关联流程", "5 条"]],
    [["协作人员", "张工"], ["协作人员", "李工"], ["协作人员", "王工"], ["执行流程", "设备异常排查流程"], ["执行流程", "日常保养流程"], ["执行流程", "启停机确认流程"], ["执行流程", "维修更换流程"], ["执行流程", "厂家远程支持流程"]],
    "设备运维 Agent 配置"
  ),
  "process-troubleshoot": stableGraphNode(
    "process-troubleshoot", "process", "流程", "设备异常排查流程", "预设流程 · 5 步", "AR-203 / LR-205",
    "从信息补齐、现场确认、依据比对到处置和归档的异常排查流程。",
    [["流程类型", "异常排查"], ["步骤", "5"], ["人工确认", "现场现象 / 处置结论"]],
    [["适用设备", "AR-203"], ["适用设备", "LR-205"], ["执行 Agent", "设备运维 Agent"], ["输入材料", "设备点检记录模板"]],
    "设备运维流程库"
  ),
  "process-maintenance": stableGraphNode(
    "process-maintenance", "process", "流程", "日常保养流程", "预设流程 · 5 步", "AR-203",
    "AR-203 按保养周期生成清单、确认窗口、执行验收并归档的流程。",
    [["流程类型", "日常保养"], ["步骤", "5"], ["人工确认", "保养窗口 / 验收结果"]],
    [["适用设备", "AR-203"], ["执行 Agent", "设备运维 Agent"], ["输入材料", "AR-203 点检 SOP V1.3"]],
    "设备运维流程库"
  ),
  "process-startstop": stableGraphNode(
    "process-startstop", "process", "流程", "启停机确认流程", "预设流程 · 5 步", "AR-204",
    "AR-204 计划启停机前的条件核对、现场安全检查和结果归档流程。",
    [["流程类型", "启停机确认"], ["步骤", "5"], ["人工确认", "安全检查 / 执行结果"]],
    [["适用设备", "AR-204"], ["执行 Agent", "设备运维 Agent"], ["输入材料", "AR-204 点检 SOP V1.3"]],
    "设备运维流程库"
  ),
  "process-repair": stableGraphNode(
    "process-repair", "process", "流程", "维修更换流程", "预设流程 · 5 步", "AR-204",
    "AR-204 确认更换需求、审批、现场更换和记录归档的流程。",
    [["流程类型", "维修更换"], ["步骤", "5"], ["人工确认", "维修审批 / 现场验收"]],
    [["适用设备", "AR-204"], ["执行 Agent", "设备运维 Agent"], ["关联备件", "备件 T-17"]],
    "设备运维流程库"
  ),
  "process-remote": stableGraphNode(
    "process-remote", "process", "流程", "厂家远程支持流程", "预设流程 · 4 步", "LR-205",
    "LR-205 出现厂家专用问题时，整理资料并发起厂家远程确认的流程。",
    [["流程类型", "厂家远程支持"], ["步骤", "4"], ["人工确认", "远程支持结论"]],
    [["适用设备", "LR-205"], ["执行 Agent", "设备运维 Agent"], ["厂家资料", "厂商乙设备资料"]],
    "设备运维流程库"
  ),
  "doc-ar203-sop": stableGraphNode(
    "doc-ar203-sop", "document", "标准 / 文档", "AR-203 点检 SOP V1.3", "设备点检标准", "AR-203",
    "规定 AR-203 日常点检项目、检查顺序和人工确认要求。",
    [["文档类型", "点检 SOP"], ["版本", "V1.3"], ["适用设备", "AR-203"]],
    [["适用设备", "AR-203"], ["关联标准", "张力控制模块操作标准 V2.1"]],
    "AR-203 点检 SOP V1.3"
  ),
  "doc-ar204-sop": stableGraphNode(
    "doc-ar204-sop", "document", "标准 / 文档", "AR-204 点检 SOP V1.3", "设备点检标准", "AR-204",
    "规定 AR-204 日常点检项目、检查顺序和人工确认要求。",
    [["文档类型", "点检 SOP"], ["版本", "V1.3"], ["适用设备", "AR-204"]],
    [["适用设备", "AR-204"], ["关联标准", "张力控制模块操作标准 V2.1"]],
    "AR-204 点检 SOP V1.3"
  ),
  "doc-ar205-sop": stableGraphNode(
    "doc-ar205-sop", "document", "标准 / 文档", "LR-205 点检 SOP V1.1", "设备点检标准", "LR-205",
    "规定 LR-205 的厂家乙设备点检项目与确认要求。",
    [["文档类型", "点检 SOP"], ["版本", "V1.1"], ["适用设备", "LR-205"]],
    [["适用设备", "LR-205"], ["关联手册", "模块 V2 操作手册 V1.0"]],
    "LR-205 点检 SOP V1.1"
  ),
  "doc-operation-standard": stableGraphNode(
    "doc-operation-standard", "document", "标准 / 文档", "张力控制模块操作标准 V2.1", "模块操作标准", "AR-203 / AR-204",
    "AR-203、AR-204 共用模块的参数确认、操作顺序与复检标准。",
    [["文档类型", "操作标准"], ["版本", "V2.1"], ["适用模块", "张力控制模块"]],
    [["适用模块", "张力控制模块"], ["适用设备", "AR-203"], ["适用设备", "AR-204"]],
    "张力控制模块操作标准 V2.1"
  ),
  "doc-module-v2-manual": stableGraphNode(
    "doc-module-v2-manual", "document", "标准 / 文档", "模块 V2 操作手册 V1.0", "厂商乙模块手册", "LR-205",
    "厂商乙 V2 张力控制模块的安装、参数和保养说明。",
    [["文档类型", "操作手册"], ["版本", "V1.0"], ["适用模块", "张力控制模块 V2"]],
    [["适用模块", "张力控制模块 V2"], ["适用设备", "LR-205"], ["厂家资料", "厂商乙设备资料"]],
    "模块 V2 操作手册 V1.0"
  ),
  "doc-line-a-list": stableGraphNode(
    "doc-line-a-list", "document", "标准 / 文档", "800G 产线 A 设备清单", "产线主数据", "厂区 A / 800G 产线 A",
    "记录产线 A 的设备、机位和所属关系，当前包含 AR-203、AR-204。",
    [["文档类型", "设备清单"], ["关联设备", "2 台"], ["负责部门", "制造部"]],
    [["所属产线", "800G 产线 A"], ["负责部门", "制造部"]],
    "800G 产线 A 设备清单"
  ),
  "doc-line-b-list": stableGraphNode(
    "doc-line-b-list", "document", "标准 / 文档", "800G 产线 B 设备清单", "产线主数据", "厂区 A / 800G 产线 B",
    "记录产线 B 的设备、机位和所属关系，当前包含 LR-205。",
    [["文档类型", "设备清单"], ["关联设备", "1 台"], ["负责部门", "制造部"]],
    [["所属产线", "800G 产线 B"], ["负责部门", "制造部"]],
    "800G 产线 B 设备清单"
  ),
  "dept-manufacturing": stableGraphNode(
    "dept-manufacturing", "person", "组织", "制造部", "产线负责部门", "厂区 A",
    "负责 800G 产线 A、B 的设备与现场运行管理。",
    [["组织类型", "制造部门"], ["负责产线", "800G 产线 A / B"]],
    [["负责产线", "800G 产线 A"], ["负责产线", "800G 产线 B"]],
    "组织主数据"
  ),
  "doc-install-standard": stableGraphNode(
    "doc-install-standard", "document", "标准 / 文档", "设备安装规范 V1.2", "机位安装标准", "厂区 A",
    "规定张力控制设备的机位安装、接口和现场验收要求。",
    [["文档类型", "安装规范"], ["版本", "V1.2"], ["适用范围", "厂区 A 张力控制设备"]],
    [["适用设备", "AR-203"], ["适用设备", "AR-204"], ["适用设备", "LR-205"]],
    "设备安装规范 V1.2"
  ),
  "doc-operation-records": stableGraphNode(
    "doc-operation-records", "document", "标准 / 文档", "机位操作记录归档", "操作记录目录", "厂区 A",
    "机位操作记录的统一归档入口，不包含实时运行指标。",
    [["记录类型", "操作归档"], ["范围", "厂区 A 机位"], ["实时数据", "不收录"]],
    [["适用机位", "A 线 03 机位"], ["适用机位", "A 线 04 机位"], ["适用机位", "B 线 05 机位"]],
    "厂区 A 机位操作记录目录"
  ),
  "doc-calibration-standard": stableGraphNode(
    "doc-calibration-standard", "document", "标准 / 文档", "张力传感器校准规范", "传感器校准标准", "AR-203 / AR-204 / LR-205",
    "定义张力传感器校准条件、步骤、记录字段和复核要求。",
    [["文档类型", "校准规范"], ["适用传感器", "TS-17 / TS-21"], ["版本状态", "已发布"]],
    [["适用传感器", "张力传感器 TS-17"], ["适用传感器", "张力传感器 TS-21"]],
    "张力传感器校准规范"
  ),
  "doc-calibration-records": stableGraphNode(
    "doc-calibration-records", "document", "标准 / 文档", "张力传感器校准记录归档", "校准记录目录", "AR-203 / AR-204 / LR-205",
    "传感器校准结果的统一归档入口，按设备、传感器和记录版本管理。",
    [["记录类型", "校准归档"], ["适用传感器", "TS-17 / TS-21"], ["实时数据", "不收录"]],
    [["适用传感器", "张力传感器 TS-17"], ["适用传感器", "张力传感器 TS-21"]],
    "张力传感器校准记录目录"
  ),
  "doc-t17-manual": stableGraphNode(
    "doc-t17-manual", "document", "标准 / 文档", "备件 T-17 产品说明书", "备件原始资料", "AR-203 / AR-204",
    "备件 T-17 的规格、接口、安装和更换说明。",
    [["文档类型", "产品说明书"], ["适用备件", "T-17"], ["资料状态", "已归档"]],
    [["适用备件", "备件 T-17"], ["厂家资料", "厂商甲设备资料"]],
    "厂商甲备件 T-17 产品说明书"
  ),
  "doc-t21-manual": stableGraphNode(
    "doc-t21-manual", "document", "标准 / 文档", "备件 T-21 产品说明书", "备件原始资料", "LR-205",
    "备件 T-21 的规格、接口、安装和更换说明。",
    [["文档类型", "产品说明书"], ["适用备件", "T-21"], ["资料状态", "已归档"]],
    [["适用备件", "备件 T-21"], ["厂家资料", "厂商乙设备资料"]],
    "厂商乙备件 T-21 产品说明书"
  ),
  "doc-t17-warranty": stableGraphNode(
    "doc-t17-warranty", "document", "标准 / 文档", "备件 T-17 保修政策", "厂家保修条款", "AR-203 / AR-204",
    "备件 T-17 的厂家保修范围、期限和资料要求。",
    [["文档类型", "保修政策"], ["适用备件", "T-17"], ["资料状态", "已归档"]],
    [["适用备件", "备件 T-17"], ["厂家资料", "厂商甲设备资料"]],
    "厂商甲备件 T-17 保修政策"
  ),
  "doc-t21-warranty": stableGraphNode(
    "doc-t21-warranty", "document", "标准 / 文档", "备件 T-21 保修政策", "厂家保修条款", "LR-205",
    "备件 T-21 的厂家保修范围、期限和资料要求。",
    [["文档类型", "保修政策"], ["适用备件", "T-21"], ["资料状态", "已归档"]],
    [["适用备件", "备件 T-21"], ["厂家资料", "厂商乙设备资料"]],
    "厂商乙备件 T-21 保修政策"
  ),
  "doc-confirm-records": stableGraphNode(
    "doc-confirm-records", "document", "标准 / 文档", "设备 Owner 确认记录归档", "人工确认记录目录", "AR-203 / AR-204 / LR-205",
    "统一归档设备 Owner 在流程节点上的人工确认记录。",
    [["记录类型", "人工确认"], ["覆盖设备", "AR-203 / AR-204 / LR-205"], ["实时数据", "不收录"]],
    [["确认人员", "张工"], ["确认人员", "李工"], ["确认人员", "王工"]],
    "设备 Owner 确认记录目录"
  ),
  "doc-check-template": stableGraphNode(
    "doc-check-template", "document", "标准 / 文档", "设备点检记录模板", "流程输入材料", "厂区 A / 张力控制设备",
    "为异常排查和日常保养流程提供统一的点检记录字段。",
    [["模板类型", "点检记录"], ["适用范围", "张力控制设备"], ["状态", "已归档"]],
    [["适用设备", "AR-203"], ["适用设备", "AR-204"], ["适用设备", "LR-205"]],
    "设备点检记录模板"
  ),
  "task-ar203": stableGraphNode(
    "task-ar203", "process", "任务入口", "AR-203 待办任务", "保养 / 异常处置", "AR-203",
    "AR-203 稳定任务入口，按关联流程生成待办，不展示实时数量。",
    [["任务类型", "日常保养 / 异常排查"], ["负责人", "张工"]],
    [["关联流程", "设备异常排查流程"], ["关联流程", "日常保养流程"], ["输入材料", "设备点检记录模板"], ["人工确认点", "设备 Owner 确认记录归档"]],
    "AR-203 任务入口"
  ),
  "task-ar204": stableGraphNode(
    "task-ar204", "process", "任务入口", "AR-204 待办任务", "启停机 / 维修更换", "AR-204",
    "AR-204 稳定任务入口，按关联流程生成待办，不展示实时数量。",
    [["任务类型", "启停机 / 维修更换"], ["负责人", "李工"]],
    [["关联流程", "启停机确认流程"], ["关联流程", "维修更换流程"], ["输入材料", "设备点检记录模板"], ["人工确认点", "设备 Owner 确认记录归档"]],
    "AR-204 任务入口"
  ),
  "task-ar205": stableGraphNode(
    "task-ar205", "process", "任务入口", "LR-205 待办任务", "异常排查 / 厂家支持", "LR-205",
    "LR-205 稳定任务入口，按关联流程生成待办，不展示实时数量。",
    [["任务类型", "异常排查 / 厂家远程支持"], ["负责人", "王工"]],
    [["关联流程", "设备异常排查流程"], ["关联流程", "厂家远程支持流程"], ["输入材料", "设备点检记录模板"], ["人工确认点", "设备 Owner 确认记录归档"]],
    "LR-205 任务入口"
  ),
  "supplier-a-docs": stableGraphNode(
    "supplier-a-docs", "supplier", "供应商资料", "厂商甲设备资料", "设备与备件原始资料", "AR-203 / AR-204",
    "厂商甲提供的设备、模块、传感器和备件稳定资料。",
    [["资料类型", "厂家原始资料"], ["覆盖对象", "设备 / 模块 / 传感器 / 备件"], ["价格信息", "不收录"]],
    [["关联设备", "AR-203"], ["关联设备", "AR-204"], ["关联模块", "张力控制模块"], ["关联传感器", "张力传感器 TS-17"], ["关联备件", "备件 T-17"]],
    "厂商甲资料包"
  ),
  "supplier-b-docs": stableGraphNode(
    "supplier-b-docs", "supplier", "供应商资料", "厂商乙设备资料", "设备与备件原始资料", "LR-205",
    "厂商乙提供的 LR-205、V2 模块、传感器和备件稳定资料。",
    [["资料类型", "厂家原始资料"], ["覆盖对象", "设备 / 模块 / 传感器 / 备件"], ["价格信息", "不收录"]],
    [["关联设备", "LR-205"], ["关联模块", "张力控制模块 V2"], ["关联传感器", "张力传感器 TS-21"], ["关联备件", "备件 T-21"]],
    "厂商乙资料包"
  )
};

const graphRoots = {
  device: "AR-203",
  function: "module-v1",
  document: "doc-ar203-sop",
  line: "line-a",
  location: "station-a03",
  person: "person-zhang",
  agent: "agent-ops",
  spare: "spare-t17",
  supplier: "supplier-a-docs",
  process: "process-troubleshoot"
};

const graphEntryTypes = [
  { mode: "device", label: "设备" },
  { mode: "function", label: "功能模块" },
  { mode: "person", label: "人员" },
  { mode: "agent", label: "Agent" },
  { mode: "process", label: "流程" },
  { mode: "document", label: "标准 / 文档" },
  { mode: "spare", label: "备件" },
  { mode: "supplier", label: "供应商" },
  { mode: "line", label: "产线" },
  { mode: "location", label: "机位" }
];

const graphModeNodes = graphEntryTypes.reduce((modes, entry) => {
  modes[entry.mode] = Object.keys(graphNodes);
  return modes;
}, {});
