import { buildCopilotFlowGraph, defaultSelectedNodeId, decodeFlowFocus, encodeFlowFocus, flowViewportAction, flowViewportReady, inspectorStatusDetail, LIVE_TURN_KEY, nodeIdInTurn, resolveFlowNodeId, ROW_GAP } from "./flowModel";
import type { DelegationBlock } from "../../types";

function tableBlock(id: string, label: string): DelegationBlock {
  return {
    tool_call_id: id,
    tool_name: "sub_agent_tool",
    label,
    status: "done",
    sql: "SELECT 1",
    columns: ["n"],
    rows_preview: [[1]],
  };
}

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const twoNl2sql = buildCopilotFlowGraph({
  delegations: [tableBlock("a", "Landcheck NL2SQL"), tableBlock("b", "Landcheck NL2SQL")],
  hasAnswer: true,
  turnRunning: false,
});

const ids = twoNl2sql.nodes.map((node) => node.id);
assert(
  JSON.stringify(ids) === JSON.stringify(["plan", "agent-a", "artifact-a", "agent-b", "artifact-b", "answer"]),
  `unexpected node order: ${ids.join(" → ")}`,
);

const plan = twoNl2sql.nodes.find((node) => node.id === "plan");
const agentA = twoNl2sql.nodes.find((node) => node.id === "agent-a");
const agentB = twoNl2sql.nodes.find((node) => node.id === "agent-b");
if (!plan || !agentA || !agentB) {
  throw new Error("hub nodes exist");
}
assert(plan.position.x < agentA.position.x, "main agent stays on the left");
assert(agentA.position.y < agentB.position.y, "later delegations stack below");
const answerNode = twoNl2sql.nodes.find((node) => node.id === "answer");
if (!answerNode) {
  throw new Error("answer node exists");
}
assert(
  answerNode.position.y - agentB.position.y >= ROW_GAP,
  "answer sits a full row below the last agent",
);

const pairs = twoNl2sql.edges.map((edge) => `${edge.source}→${edge.target}:${edge.label}`);
assert(
  JSON.stringify(pairs) ===
  JSON.stringify([
    "plan→agent-a:委派",
    "agent-a→artifact-a:产出",
    "plan→agent-b:委派",
    "agent-b→artifact-b:产出",
    "plan→answer:总结",
  ]),
  `unexpected edges: ${pairs.join(" | ")}`,
);

assert(
  !twoNl2sql.edges.some((edge) => edge.source.startsWith("artifact") && edge.target.startsWith("agent")),
  "sub-agents must not call each other",
);
assert(
  twoNl2sql.edges.filter((edge) => edge.source === "plan" && edge.target.startsWith("agent")).length === 2,
  "main agent dispatches every sub-agent",
);
assert(
  twoNl2sql.edges.find((edge) => edge.source === "plan" && edge.target.startsWith("agent"))?.sourceHandle === "east",
  "delegation leaves the main agent on the right",
);
assert(
  twoNl2sql.edges.find((edge) => edge.id === "e-plan-answer")?.sourceHandle === "south",
  "summary leaves the main agent downward",
);
assert(
  twoNl2sql.edges.find((edge) => edge.id === "e-plan-answer")?.targetHandle === "north",
  "summary arrives at the answer from above",
);

assert(resolveFlowNodeId(twoNl2sql.nodes, "artifact-a") === "artifact-a", "resolve artifact");
assert(resolveFlowNodeId(twoNl2sql.nodes, "artifact-missing") === null, "missing artifact");

const mixed = buildCopilotFlowGraph({
  delegations: [
    tableBlock("sql1", "Landcheck NL2SQL"),
    {
      tool_call_id: "plot1",
      tool_name: "sub_agent_tool",
      label: "Landcheck Plot",
      status: "running",
      current_stage_label: "正在启动子 Agent…",
    },
  ],
  hasAnswer: false,
  turnRunning: true,
});
const mixedIds = mixed.nodes.map((node) => node.id);
assert(!mixedIds.includes("answer"), "answer must wait until every agent finishes");

const prematureAnswer = buildCopilotFlowGraph({
  delegations: [
    {
      tool_call_id: "sql1",
      tool_name: "sub_agent_tool",
      label: "Landcheck NL2SQL",
      status: "running",
    },
  ],
  hasAnswer: true,
  turnRunning: true,
});
assert(
  prematureAnswer.nodes.every((node) => node.id !== "answer"),
  "streaming tokens must not spawn the answer while a sub-agent is still running",
);
const plotNode = mixed.nodes.find((node) => node.id === "agent-plot1");
assert(plotNode?.data.status === "active", "plot stays active");
assert(
  String(plotNode?.data.detail).includes("画图"),
  `plot should not stay on startup copy: ${plotNode?.data.detail}`,
);
assert(
  defaultSelectedNodeId(mixed.nodes, true) === "agent-plot1",
  "auto-select the running agent, not a later answer",
);

const afterPlot = buildCopilotFlowGraph({
  delegations: [
    tableBlock("sql1", "Landcheck NL2SQL"),
    {
      tool_call_id: "plot1",
      tool_name: "sub_agent_tool",
      label: "Landcheck Plot",
      status: "done",
      image_path: "/tmp/a.png",
      ended_at: 9,
    },
  ],
  hasAnswer: false,
  turnRunning: true,
});
assert(afterPlot.nodes.some((node) => node.id === "answer"), "answer appears after all agents settle");
assert(
  afterPlot.nodes.find((node) => node.id === "artifact-plot1")?.data.imagePath === "/tmp/a.png",
  "plot artifact keeps image path",
);
assert(
  afterPlot.nodes.find((node) => node.id === "answer")?.data.detail === "正在生成结论",
  "answer is synthesizing after agents finish",
);

const reused = buildCopilotFlowGraph({
  delegations: [
    { ...tableBlock("a", "Landcheck NL2SQL"), sub_id: 2, resumed: false },
    { ...tableBlock("b", "Landcheck NL2SQL"), sub_id: 2, resumed: true },
  ],
  hasAnswer: true,
  turnRunning: false,
});
assert(
  reused.edges.some((edge) => edge.source === "agent-a" && edge.target === "agent-b" && edge.label === "复用"),
  "same worker is linked",
);
assert(
  reused.nodes.find((node) => node.id === "agent-b")?.data.chips?.some((chip) => chip.label.includes("复用")),
  "reuse chip visible",
);

const plannedTwo = buildCopilotFlowGraph({
  planHint: "先查数再画图",
  planTools: [
    { name: "sub_agent_tool", label: "Landcheck NL2SQL" },
    { name: "sub_agent_tool", label: "Landcheck Plot" },
  ],
  delegations: [tableBlock("a", "Landcheck NL2SQL")],
  hasAnswer: true,
  turnRunning: true,
});
const plannedIds = plannedTwo.nodes.map((node) => node.id);
assert(plannedIds.includes("plan"), "main agent remains while a sub-agent runs");
assert(plannedIds.includes("agent-a"), "started sub-agent stays on the graph");
assert(
  plannedIds.some((id) => id.startsWith("pending-") && id.includes("sub_agent_tool")),
  "not-yet-started planned agent stays visible",
);
assert(!plannedIds.includes("answer"), "answer waits while planned agents remain");
assert(
  plannedTwo.nodes.find((node) => node.id === "plan")?.data.chips?.some((chip) => chip.label.includes("Plot"))
  === true,
  "plan node keeps the full tool list",
);

const llmNode = buildCopilotFlowGraph({
  delegations: [
    {
      ...tableBlock("llm", "Landcheck NL2SQL"),
      status: "running",
      last_llm_name: "qwen-plus",
      last_llm_ms: 2400,
      input_tokens: 1200,
      output_tokens: 80,
    },
  ],
  turnRunning: true,
}).nodes.find((node) => node.id === "agent-llm");
assert(
  llmNode?.data.chips?.some((chip) => chip.label.includes("qwen-plus") && chip.label.includes("tok")) === true,
  "agent chip shows llm duration and tokens",
);

assert(encodeFlowFocus("m0", "answer") === "m0::answer", "encode turn and node");
assert(decodeFlowFocus("m0::answer")?.turnKey === "m0" && decodeFlowFocus("m0::answer")?.nodeId === "answer", "decode");
assert(decodeFlowFocus("answer") === null, "bare node ids match no turn");
assert(nodeIdInTurn("m0::answer", "m0") === "answer", "same turn unwraps");
assert(nodeIdInTurn("m0::answer", "m1") === null, "other turn ignores");
assert(nodeIdInTurn(`${LIVE_TURN_KEY}::plan`, LIVE_TURN_KEY) === "plan", "live turn unwraps");

const decided = buildCopilotFlowGraph({
  planHint: "将委派 Landcheck NL2SQL 处理：按年统计项目数",
  planTools: [
    {
      name: "sub_agent_tool",
      label: "Landcheck NL2SQL",
      args_summary: "按年份分组统计项目数量",
    },
  ],
  delegations: [
    {
      ...tableBlock("sql1", "Landcheck NL2SQL"),
      logs: [
        { message: "↳ Generator: SELECT YEAR(`project_time`) AS `年份` FROM `project`" },
        { message: "↳ Validator: Score: 1.00, Issues: []" },
      ],
      stages: [{ stage: "generating", label: "正在生成 SQL", status: "done" }],
    },
  ],
  hasAnswer: true,
  turnRunning: false,
});
const decidedPlan = decided.nodes.find((node) => node.id === "plan");
assert(decidedPlan?.data.decision?.includes("按年统计项目数") === true, "plan inspector keeps the decision");
assert(
  decidedPlan?.data.decisionTools?.[0]?.summary === "按年份分组统计项目数量",
  "plan inspector keeps tool args",
);
assert(decidedPlan?.data.detail?.includes("按年统计项目数") === true, "plan node detail uses planHint");
assert(
  inspectorStatusDetail(decidedPlan?.data ?? { detail: "", decision: "" }) === undefined,
  "inspector does not repeat the plan hint under the title",
);
assert(
  inspectorStatusDetail({ detail: "正在思考如何拆解问题", decision: "将委派 Landcheck Plot" })
  === "正在思考如何拆解问题",
  "inspector keeps a distinct status line while thinking",
);
const decidedAgent = decided.nodes.find((node) => node.id === "agent-sql1");
assert(
  decidedAgent?.data.pipelineSteps?.some((step) => step.label === "Generator" && step.detail.includes("YEAR")) === true,
  "nl2sql inspector shows generator SQL",
);
assert(
  !decidedAgent?.data.chips?.some((chip) => chip.label === "正在生成 SQL"),
  "product steps replace empty stage chips",
);

assert(flowViewportReady({ nodesInitialized: true, nodeCount: 1, flowWidth: 1084, flowHeight: 280 }) === true, "ready when pane and nodes exist");
assert(flowViewportReady({ nodesInitialized: true, nodeCount: 1, flowWidth: 0, flowHeight: 280 }) === false, "not ready with zero pane width");
assert(flowViewportReady({ nodesInitialized: true, nodeCount: 1, flowWidth: 1084, flowHeight: 0 }) === false, "not ready with zero pane height");
assert(flowViewportReady({ nodesInitialized: false, nodeCount: 1, flowWidth: 1084, flowHeight: 280 }) === false, "not ready before node measure");
assert(flowViewportReady({ nodesInitialized: true, nodeCount: 0, flowWidth: 1084, flowHeight: 280 }) === false, "not ready with no nodes");
assert(
  flowViewportReady({ nodesInitialized: true, nodeCount: 3, flowWidth: 1084, flowHeight: 280, canvasHeight: 628 }) === false,
  "not ready while store height lags a taller canvas",
);
assert(
  flowViewportReady({ nodesInitialized: true, nodeCount: 3, flowWidth: 1084, flowHeight: 626, canvasHeight: 628 }) === true,
  "ready after store height matches the canvas",
);
assert(
  flowViewportAction({ nodesInitialized: false, nodeCount: 3, flowWidth: 1084, flowHeight: 280 }) === "origin",
  "measuring nodes resets to origin instead of keeping a stale zoom",
);
assert(
  flowViewportAction({ nodesInitialized: true, nodeCount: 3, flowWidth: 1084, flowHeight: 280, canvasHeight: 628 }) === "origin",
  "taller canvas lag resets to origin so nodes stay on screen",
);
assert(
  flowViewportAction({ nodesInitialized: true, nodeCount: 1, flowWidth: 0, flowHeight: 280 }) === "wait",
  "zero pane still waits",
);
assert(
  flowViewportAction({ nodesInitialized: true, nodeCount: 3, flowWidth: 1084, flowHeight: 626, canvasHeight: 628 }) === "fit",
  "fit when pane matches canvas",
);

console.log("flowModel chain assertions passed");
