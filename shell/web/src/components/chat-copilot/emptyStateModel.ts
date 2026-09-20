export interface CopilotStarterPrompt {
  tag: string;
  text: string;
}

export interface CopilotEmptyCopy {
  kicker: string;
  title: string;
  lead: string;
  capabilities: string[];
  prompts: CopilotStarterPrompt[];
}

const LANDCHECK_COPILOT: CopilotEmptyCopy = {
  kicker: "DataX",
  title: "你好，我是DataX 助手",
  lead: "用自然语言查询 Landcheck 房产测绘核对库。问数、查口径、探表关系都可以!",
  capabilities: ["问数统计", "口径说明", "表关系", "图表", "报告"],
  prompts: [
    { tag: "问数", text: "当前一共有多少个项目？" },
    { tag: "口径", text: "「竣工面积」在业务文档里是怎么定义的？" },
    { tag: "表关系", text: "项目表和楼栋表应该怎么关联？" },
    { tag: "图表", text: "用柱状图对比各项目的建筑面积" },
  ],
};

const FALLBACK: CopilotEmptyCopy = {
  kicker: "DataX",
  title: "你好，开始新对话",
  lead: "用自然语言提问。助手会规划步骤，并在需要时调用工具。",
  capabilities: ["对话", "规划", "调用工具"],
  prompts: [
    { tag: "能力", text: "你能帮我做什么？" },
    { tag: "开始", text: "先介绍一下当前可以完成的任务" },
  ],
};

const BY_PROFILE: Record<string, CopilotEmptyCopy> = {
  "landcheck-copilot": LANDCHECK_COPILOT,
};

export function copilotEmptyCopy(profileId?: string | null): CopilotEmptyCopy {
  if (profileId && BY_PROFILE[profileId]) return BY_PROFILE[profileId];
  return FALLBACK;
}
