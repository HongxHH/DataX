import type { Edge, Node } from "@xyflow/react";
import type { PlanToolItem } from "../../protocol/events";
import type { DelegationBlock } from "../../types";
import {
  displayAgentLabel,
  displayPlanText,
  isSubAgentTool,
  runningAgentHint,
  SUBAGENT_STARTING_LABEL,
  SUBAGENT_WAITING_LABEL,
  toolLabel,
  visibleDelegations,
  workerReuseLabel,
} from "./delegationState";
import { pipelineStepsFromDelegation, type PipelineStep } from "./pipelineSteps";

export type FlowStatus = "pending" | "active" | "done" | "error";
export type FlowKind = "plan" | "agent" | "artifact" | "answer";

export interface FlowChip {
  key: string;
  label: string;
  className?: string;
}

export interface FlowNodeData extends Record<string, unknown> {
  kind: FlowKind;
  title: string;
  detail: string;
  status: FlowStatus;
  thinking?: string;
  thinkingLive?: boolean;
  prepLog?: string[];
  decision?: string;
  decisionTools?: Array<{ label: string; summary?: string }>;
  pipelineSteps?: PipelineStep[];
  chips?: FlowChip[];
  sql?: string;
  error?: string;
  rowCount?: number;
  previewRowCount?: number;
  excerpts?: DelegationBlock["excerpts"];
  columns?: string[];
  rowsPreview?: unknown[];
  imagePath?: string;
  reportPath?: string;
  artifactKind?: "sql" | "table" | "excerpts" | "image" | "report" | "error";
  subId?: number;
  startedAt?: number;
  endedAt?: number;
  durationLabel?: string;
}

/** DAG card shows a phase line; inspector skips it when it duplicates `decision`. */
export function inspectorStatusDetail(data: Pick<FlowNodeData, "detail" | "decision">): string | undefined {
  const detail = data.detail?.trim();
  if (!detail) return undefined;
  if (detail === data.decision?.trim()) return undefined;
  return data.detail;
}

export function inspectorLead(
  data: Pick<FlowNodeData, "kind" | "status" | "detail" | "decision" | "decisionTools">,
  delegations: Array<Pick<DelegationBlock, "label" | "started_at">> = [],
): string | undefined {
  if (data.kind === "plan" && data.status !== "active" && !/总结/.test(data.detail ?? "")) {
    const delegated = planDelegationLead(data.decisionTools, delegations);
    if (delegated) return delegated;
  }
  return inspectorStatusDetail(data);
}

/** One-line query/args summary for inspector rows (head kept, whitespace collapsed). */
export function clipInspectorSummary(text?: string | null, max = 72): string {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  if (!flat) return "";
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(1, max - 1))}…`;
}

function planDelegationLead(
  tools: FlowNodeData["decisionTools"],
  delegations: Array<Pick<DelegationBlock, "label" | "started_at">>,
): string | undefined {
  const fromTools = (tools ?? [])
    .map((tool) => displayAgentLabel(tool.label))
    .filter(Boolean);
  const names = fromTools.length > 0
    ? fromTools
    : delegations.map((block) => displayAgentLabel(block.label) || "").filter(Boolean);
  if (names.length === 0) return undefined;
  const starts = delegations.map((block) => block.started_at).filter((value) => value != null);
  const parallel = names.length >= 2 && starts.length >= 2 && starts.every((value) => value === starts[0]);
  const prefix = parallel ? "并行委派了" : "委派了";
  const unique = [...new Set(names)];
  if (unique.length === 1 && names.length > 1) {
    const count = names.length === 2 ? "两个" : `${names.length} 个`;
    return `${prefix}${count} ${unique[0]}`;
  }
  return `${prefix} ${unique.join("、")}`;
}

export type CopilotFlowNode = Node<FlowNodeData, "copilot">;

export type FlowNodeSize = { width: number; height: number };

/**
 * React Flow hides a node until `measured` exists. It only keeps that size when
 * the user-node object is reference-equal; live SSE rebuilds new objects, so we
 * copy the last measured box onto the new object instead of letting it go hidden.
 */
export function bindCopilotFlowNodes(
  nodes: CopilotFlowNode[],
  selectedId: string | null,
  previousMeasured: ReadonlyMap<string, FlowNodeSize>,
): CopilotFlowNode[] {
  return nodes.map((node) => {
    const selected = node.id === selectedId;
    const prev = previousMeasured.get(node.id);
    const width = node.measured?.width ?? prev?.width;
    const height = node.measured?.height ?? prev?.height;
    const measured = width != null && height != null ? { width, height } : node.measured;
    if (node.selected === selected && sameMeasured(node.measured, measured)) return node;
    return measured ? { ...node, selected, measured } : { ...node, selected };
  });
}

export function rememberFlowNodeMeasurements(
  nodes: CopilotFlowNode[],
  store: Map<string, FlowNodeSize>,
): void {
  const seen = new Set<string>();
  for (const node of nodes) {
    seen.add(node.id);
    const width = node.measured?.width;
    const height = node.measured?.height;
    if (width != null && height != null) store.set(node.id, { width, height });
  }
  for (const id of [...store.keys()]) {
    if (!seen.has(id)) store.delete(id);
  }
}

function sameMeasured(
  left: CopilotFlowNode["measured"] | undefined,
  right: CopilotFlowNode["measured"] | undefined,
): boolean {
  return left?.width === right?.width && left?.height === right?.height;
}

export const FLOW_STATUS_LABEL: Record<FlowStatus, string> = {
  pending: "等待",
  active: "进行中",
  done: "完成",
  error: "失败",
};

export function formatTokenChip(input?: number, output?: number): string | undefined {
  if (!input && !output) return undefined;
  return `${formatTok(input ?? 0)}+${formatTok(output ?? 0)} tok`;
}

function formatTok(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

function formatLlmMs(ms?: number): string | undefined {
  if (ms == null || ms < 0) return undefined;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function latestLlmChip(
  spans: Array<{
    kind?: string;
    label?: string;
    startTs?: number | null;
    endTs?: number | null;
    usage?: { input_tokens?: number; output_tokens?: number };
  }>,
): FlowChip | undefined {
  const span = spans.filter((item) => item.kind === "llm").at(-1);
  if (!span) return undefined;
  const running = span.endTs == null && span.startTs != null;
  if (running) {
    return { key: "llm", label: `${span.label || "LLM"} 进行中`, className: "active" };
  }
  const ms =
    span.startTs != null && span.endTs != null ? Math.max(0, Math.round((span.endTs - span.startTs) * 1000)) : undefined;
  const bits = [span.label, formatLlmMs(ms), formatTokenChip(span.usage?.input_tokens, span.usage?.output_tokens)].filter(
    (part): part is string => Boolean(part),
  );
  if (bits.length === 0) return undefined;
  return { key: "llm", label: bits.join(" · ") };
}

function llmChips(block: DelegationBlock): FlowChip[] {
  if (block.llm_running) {
    return [{ key: "llm", label: `${block.last_llm_name || "LLM"} 进行中`, className: "active" }];
  }
  const bits = [block.last_llm_name, formatLlmMs(block.last_llm_ms), formatTokenChip(block.input_tokens, block.output_tokens)].filter(
    (part): part is string => Boolean(part),
  );
  if (bits.length === 0) return [];
  return [{ key: "llm", label: bits.join(" · ") }];
}

export function formatNodeDuration(
  startedAt?: number,
  endedAt?: number,
  now = Date.now(),
): string | undefined {
  if (!startedAt) return undefined;
  const end = endedAt ?? now;
  const seconds = Math.max(0, Math.floor((end - startedAt) / 1000));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export const NODE_WIDTH = 200;
const COL_GAP = 240;
export const ROW_GAP = 200;
const ORIGIN_X = 24;
const ORIGIN_Y = 28;

export function flowCanvasHeight(nodes: CopilotFlowNode[]): number {
  if (nodes.length === 0) return 240;
  const maxY = Math.max(...nodes.map((node) => node.position.y));
  return Math.min(720, Math.max(280, maxY + ROW_GAP));
}

export type FlowViewportAction = "wait" | "origin" | "fit";

/** Decide how to aim the live DAG camera.
 *  fitView against width/height 0 writes an off-screen transform: blank pane, clipped nodes, missing edges.
 *  After topology changes, a previous fitView zoom still aims at the old 1-node box; waiting for store
 *  height without resetting that camera leaves an empty pane until the lag catches up. */
export function flowViewportAction(input: {
  nodesInitialized: boolean;
  nodeCount: number;
  flowWidth: number;
  flowHeight: number;
  canvasHeight?: number;
}): FlowViewportAction {
  if (input.nodeCount <= 0 || input.flowWidth <= 0 || input.flowHeight <= 0) {
    return "wait";
  }
  if (!input.nodesInitialized) {
    return "origin";
  }
  if (input.canvasHeight != null && input.flowHeight + 4 < input.canvasHeight) {
    return "origin";
  }
  return "fit";
}

/** True when React Flow can compute a viewport from real pane size and measured nodes. */
export function flowViewportReady(input: {
  nodesInitialized: boolean;
  nodeCount: number;
  flowWidth: number;
  flowHeight: number;
  canvasHeight?: number;
}): boolean {
  return flowViewportAction(input) === "fit";
}

export function agentNodeId(toolCallId: string): string {
  return `agent-${toolCallId}`;
}

export function artifactNodeId(toolCallId: string): string {
  return `artifact-${toolCallId}`;
}

export const LIVE_TURN_KEY = "live";
const FLOW_FOCUS_SEP = "::";

export function messageTurnKey(index: number): string {
  return `m${index}`;
}

export function encodeFlowFocus(turnKey: string, nodeId: string): string {
  return `${turnKey}${FLOW_FOCUS_SEP}${nodeId}`;
}

export function decodeFlowFocus(
  raw: string | null | undefined,
): { turnKey: string; nodeId: string } | null {
  if (!raw) return null;
  const idx = raw.indexOf(FLOW_FOCUS_SEP);
  if (idx <= 0) return null;
  const turnKey = raw.slice(0, idx);
  const nodeId = raw.slice(idx + FLOW_FOCUS_SEP.length);
  if (!turnKey || !nodeId) return null;
  return { turnKey, nodeId };
}

export function nodeIdInTurn(raw: string | null | undefined, turnKey: string): string | null {
  const parsed = decodeFlowFocus(raw);
  if (!parsed || parsed.turnKey !== turnKey) return null;
  return parsed.nodeId;
}

export function flowFocusForTurn(
  encoded: string | null | undefined,
  turnKey: string,
  onSelect?: (encoded: string | null) => void,
): { selectedId: string | null; onSelect: (id: string | null) => void } {
  return {
    selectedId: nodeIdInTurn(encoded, turnKey),
    onSelect: (id) => onSelect?.(id ? encodeFlowFocus(turnKey, id) : null),
  };
}

export function resolveFlowNodeId(
  nodes: CopilotFlowNode[],
  requestedId: string | null | undefined,
): string | null {
  if (!requestedId) return null;
  if (nodes.some((node) => node.id === requestedId)) return requestedId;
  if (requestedId.startsWith("artifact-")) {
    const fallback = agentNodeId(requestedId.slice("artifact-".length));
    if (nodes.some((node) => node.id === fallback)) return fallback;
  }
  return null;
}

export interface CopilotFlowModelInput {
  thinking?: string;
  thinkingLive?: boolean;
  stageHint?: string | null;
  prepLog?: string[];
  planHint?: string | null;
  planTools?: PlanToolItem[];
  delegations?: DelegationBlock[];
  hasAnswer?: boolean;
  turnRunning?: boolean;
  turnStartedAt?: number;
}

function agentStatus(block?: DelegationBlock): FlowStatus {
  if (!block) return "pending";
  if (block.status === "error") return "error";
  if (block.status === "done") return "done";
  return "active";
}

function isTerminal(block: DelegationBlock): boolean {
  return block.status === "done" || block.status === "error";
}

function allAgentsSettled(delegations: DelegationBlock[]): boolean {
  return delegations.length > 0 && delegations.every(isTerminal);
}

function lastEndedAt(delegations: DelegationBlock[]): number | undefined {
  return [...delegations].reverse().find((d) => d.ended_at)?.ended_at;
}

function answerView(
  hasAnswer: boolean,
  turnRunning: boolean,
  agentsSettled: boolean,
): { status: FlowStatus; detail: string } {
  if (hasAnswer) {
    return turnRunning
      ? { status: "active", detail: "正在生成结论" }
      : { status: "done", detail: "已生成结论" };
  }
  if (agentsSettled && turnRunning) {
    return { status: "active", detail: "正在生成结论" };
  }
  return { status: "pending", detail: "等待查询结果" };
}

function agentDetail(block: DelegationBlock, status: FlowStatus): string {
  if (status === "error") {
    return block.error || "失败";
  }
  if (status === "done") {
    return "已完成";
  }
  const stage = block.current_stage_label?.trim();
  if (stage && stage !== SUBAGENT_STARTING_LABEL) {
    return stage;
  }
  return runningAgentHint(block);
}

function toolChipLabel(name: string, label?: string): string {
  const shown = displayAgentLabel(label);
  if (shown) return shown;
  return isSubAgentTool(name) ? "子 Agent" : name;
}

export function delegationImagePath(block: DelegationBlock): string | undefined {
  const top = block.image_path?.trim();
  if (top) return top;
  return block.images?.map((item) => item.image_path?.trim()).find(Boolean);
}

function hasArtifact(block: DelegationBlock): boolean {
  return Boolean(
    block.sql ||
    block.error ||
    (block.columns && block.columns.length > 0) ||
    (block.excerpts && block.excerpts.length > 0) ||
    delegationImagePath(block) ||
    block.report_path,
  );
}

function artifactTitle(block: DelegationBlock): string {
  if (block.error) return "产物";
  if (block.excerpts && block.excerpts.length > 0) return "文档摘录";
  if (delegationImagePath(block)) return "图表";
  if (block.report_path) return "报告";
  if (block.sql || (block.columns && block.columns.length > 0)) return "查询结果";
  return "产物";
}

function artifactDetail(block: DelegationBlock): string {
  if (block.error) return "执行出错";
  if (block.excerpts && block.excerpts.length > 0) {
    return `${block.excerpts.length} 条摘录`;
  }
  if (delegationImagePath(block)) {
    return "PNG 已生成";
  }
  if (block.report_path) return "Markdown 报告";
  const rowCount = block.row_count ?? block.rows_preview?.length;
  if (rowCount) {
    return `预览 ${block.preview_row_count ?? rowCount} 行`;
  }
  if (block.sql) return "SQL 已生成";
  return "已产出";
}

function artifactKind(block: DelegationBlock): FlowNodeData["artifactKind"] {
  if (block.error) return "error";
  if (block.excerpts && block.excerpts.length > 0) return "excerpts";
  if (delegationImagePath(block)) return "image";
  if (block.report_path) return "report";
  if (block.columns && block.columns.length > 0) return "table";
  if (block.sql) return "sql";
  return undefined;
}

function colX(col: number): number {
  return ORIGIN_X + col * COL_GAP;
}

function rowY(row: number): number {
  return ORIGIN_Y + row * ROW_GAP;
}

function delegatedAgentNames(planTools: PlanToolItem[], delegations: DelegationBlock[]): string {
  const names: string[] = [];
  const seen = new Set<string>();
  const push = (name: string | undefined) => {
    const label = displayAgentLabel(name);
    if (!label || seen.has(label)) return;
    seen.add(label);
    names.push(label);
  };
  for (const block of delegations) push(block.label);
  for (const tool of planTools) push(toolChipLabel(tool.name, tool.label));
  return names.join("、");
}

function planPhaseDetail(input: {
  thinkingLive: boolean;
  thinking: string;
  planStatus: FlowStatus;
  stageHint: string | null;
  hasPlan: boolean;
  anyAgent: boolean;
  agentsSettled: boolean;
  hasPending: boolean;
  turnRunning: boolean;
  names: string;
}): string {
  if (input.thinkingLive && input.thinking) return "正在思考如何拆解问题";
  if (input.planStatus === "active") return input.stageHint || "正在规划，等待模型返回…";
  if (input.hasPlan || input.anyAgent) {
    if (input.turnRunning && input.agentsSettled && !input.hasPending) {
      return "正在根据子 Agent 结果总结";
    }
    if (!input.turnRunning) return "已完成规划";
    return input.names ? `已委派 ${input.names}` : "已确定下一步";
  }
  return "已完成规划";
}

function makeNode(id: string, col: number, y: number, data: FlowNodeData): CopilotFlowNode {
  return {
    id,
    type: "copilot",
    position: { x: colX(col), y },
    data,
    draggable: false,
    connectable: false,
    style: { width: NODE_WIDTH },
  };
}

function makeEdge(
  id: string,
  source: string,
  target: string,
  label: string,
  animated: boolean,
  handles?: { sourceHandle?: string; targetHandle?: string },
): Edge {
  return {
    id,
    source,
    target,
    label,
    animated,
    type: "smoothstep",
    sourceHandle: handles?.sourceHandle,
    targetHandle: handles?.targetHandle,
  };
}

export function buildCopilotFlowGraph(input: CopilotFlowModelInput): {
  nodes: CopilotFlowNode[];
  edges: Edge[];
} {
  const thinking = input.thinking ?? "";
  const thinkingLive = Boolean(input.thinkingLive);
  const stageHint = input.stageHint ?? null;
  const prepLog = input.prepLog ?? [];
  const planHint = input.planHint ?? null;
  const planTools = input.planTools ?? [];
  const delegations = visibleDelegations(input.delegations);
  const hasAnswer = Boolean(input.hasAnswer);
  const turnRunning = Boolean(input.turnRunning);
  const turnStartedAt = input.turnStartedAt;
  const firstAgentStarted = delegations.find((d) => d.started_at)?.started_at;

  const hasPlan = Boolean(planHint) || planTools.length > 0;
  const anyAgent = delegations.length > 0;
  const agentsSettled = allAgentsSettled(delegations);
  const hasPending = planTools.length > delegations.length;

  const planStatus: FlowStatus = !turnRunning
    ? "done"
    : thinkingLive || (!hasPlan && !anyAgent)
      ? "active"
      : "done";

  const planDetail = planPhaseDetail({
    thinkingLive,
    thinking,
    planStatus,
    stageHint,
    hasPlan,
    anyAgent,
    agentsSettled,
    hasPending,
    turnRunning,
    names: delegatedAgentNames(planTools, delegations),
  });

  const decisionTools = planTools
    .map((tool) => ({
      label: toolChipLabel(tool.name, tool.label),
      summary: clipInspectorSummary(tool.args_summary) || undefined,
    }))
    .filter((tool) => tool.summary);

  const nodes: CopilotFlowNode[] = [
    makeNode("plan", 0, ORIGIN_Y, {
      kind: "plan",
      title: "主 Agent",
      detail: planDetail,
      status: planStatus,
      thinking: thinking || undefined,
      thinkingLive,
      prepLog: prepLog.length > 0 ? prepLog : undefined,
      decision: displayPlanText(planHint?.trim()) || undefined,
      decisionTools: decisionTools.length > 0 ? decisionTools : undefined,
      chips:
        planTools.length > 0
          ? planTools.map((tool, idx) => ({
            key: `${idx}-${tool.name}`,
            label: toolChipLabel(tool.name, tool.label),
          }))
          : undefined,
      startedAt: turnStartedAt,
      endedAt: planStatus === "done" ? firstAgentStarted ?? turnStartedAt : undefined,
    }),
  ];
  const edges: Edge[] = [];
  let row = 0;

  const appendDelegatedAgent = (
    id: string,
    data: FlowNodeData,
    edgeAnimated: boolean,
    reuseFrom?: string,
  ) => {
    nodes.push(makeNode(id, 1, rowY(row), data));
    if (reuseFrom) {
      edges.push(
        makeEdge(`e-reuse-${reuseFrom}-${id}`, reuseFrom, id, "复用", edgeAnimated, {
          sourceHandle: "east",
          targetHandle: "west",
        }),
      );
    } else {
      edges.push(
        makeEdge(`e-plan-${id}`, "plan", id, "委派", edgeAnimated, {
          sourceHandle: "east",
          targetHandle: "west",
        }),
      );
    }
  };

  const uncoveredPlanTools = planTools.slice(delegations.length);
  if ((hasPlan || turnRunning) && uncoveredPlanTools.length > 0) {
    uncoveredPlanTools.forEach((tool, idx) => {
      const pendingIdx = delegations.length + idx;
      const waitingToStart = !turnRunning || delegations.length > 0 || idx > 0;
      appendDelegatedAgent(
        `pending-${pendingIdx}-${tool.name}`,
        {
          kind: "agent",
          title: displayAgentLabel(tool.label) || toolLabel(tool.name, tool.config_path),
          detail: displayPlanText(planHint) || SUBAGENT_WAITING_LABEL,
          status: waitingToStart ? "pending" : "active",
          chips: [{ key: tool.name, label: toolChipLabel(tool.name, tool.label) }],
          startedAt: turnRunning && !waitingToStart ? turnStartedAt : undefined,
        },
        turnRunning && !waitingToStart && idx === 0,
      );
      row += 1;
    });
  }

  const lastAgentByWorker = new Map<number, string>();
  delegations.forEach((block) => {
    const status = agentStatus(block);
    const running = status === "active";
    const agentId = agentNodeId(block.tool_call_id);
    const reuseFrom = block.sub_id != null ? lastAgentByWorker.get(block.sub_id) : undefined;
    const workerLabel = workerReuseLabel(block);
    const pipelineSteps = pipelineStepsFromDelegation(block);
    const chips = [
      ...llmChips(block),
      ...(workerLabel ? [{ key: `worker-${block.sub_id}`, label: workerLabel }] : []),
      ...(pipelineSteps.length > 0
        ? []
        : (block.stages ?? []).map((stage, stageIdx) => ({
          key: `${stageIdx}-${stage.stage}`,
          label: stage.label,
          className: stage.status === "active" ? "active" : "done",
        }))),
    ];
    appendDelegatedAgent(
      agentId,
      {
        kind: "agent",
        title: displayAgentLabel(block.label) || "子 Agent",
        detail: agentDetail(block, status),
        status,
        thinking: block.sub_thinking,
        thinkingLive: turnRunning && running && Boolean(block.sub_thinking),
        chips: chips.length > 0 ? chips : undefined,
        pipelineSteps: pipelineSteps.length > 0 ? pipelineSteps : undefined,
        error: block.error,
        subId: block.sub_id != null && block.sub_id > 0 ? block.sub_id : undefined,
        startedAt: block.started_at,
        endedAt: block.ended_at,
      },
      turnRunning && running,
      reuseFrom,
    );
    if (block.sub_id != null) {
      lastAgentByWorker.set(block.sub_id, agentId);
    }

    if (hasArtifact(block)) {
      const artId = artifactNodeId(block.tool_call_id);
      nodes.push(
        makeNode(artId, 2, rowY(row), {
          kind: "artifact",
          title: artifactTitle(block),
          detail: artifactDetail(block),
          status,
          sql: block.sql,
          error: block.error,
          rowCount: block.row_count,
          previewRowCount: block.preview_row_count,
          excerpts: block.excerpts,
          columns: block.columns,
          rowsPreview: block.rows_preview,
          imagePath: delegationImagePath(block),
          reportPath: block.report_path,
          artifactKind: artifactKind(block),
          startedAt: block.started_at,
          endedAt: block.ended_at,
        }),
      );
      edges.push(
        makeEdge(
          `e-${agentId}-${artId}`,
          agentId,
          artId,
          "产出",
          turnRunning && block.status === "running",
          { sourceHandle: "east", targetHandle: "west" },
        ),
      );
    }
    row += 1;
  });

  const agentsBusy =
    (delegations.length > 0 && !agentsSettled) || uncoveredPlanTools.length > 0;
  const showAnswer = !agentsBusy && (hasAnswer || (agentsSettled && turnRunning));
  if (showAnswer) {
    const lastEnded = lastEndedAt(delegations);
    const answer = answerView(hasAnswer, turnRunning, agentsSettled);
    nodes.push(
      makeNode("answer", 1, rowY(row), {
        kind: "answer",
        title: "回答",
        detail: answer.detail,
        status: answer.status,
        startedAt: agentsSettled ? lastEnded ?? turnStartedAt : turnStartedAt,
        endedAt: turnRunning ? undefined : lastEnded,
      }),
    );
    edges.push(
      makeEdge(
        "e-plan-answer",
        "plan",
        "answer",
        "总结",
        turnRunning && !hasAnswer,
        { sourceHandle: "south", targetHandle: "north" },
      ),
    );
    row += 1;
  }

  const rowsUsed = Math.max(row, 1);
  nodes[0].position.y = ORIGIN_Y + ((rowsUsed - 1) * ROW_GAP) / 2;

  return { nodes, edges };
}

function lastActiveId(nodes: CopilotFlowNode[], kind?: FlowKind): string | undefined {
  return [...nodes].reverse().find((n) => n.data.status === "active" && (kind == null || n.data.kind === kind))?.id;
}

export function defaultSelectedNodeId(
  nodes: CopilotFlowNode[],
  turnRunning: boolean,
): string | null {
  if (turnRunning) {
    return lastActiveId(nodes, "agent") ?? lastActiveId(nodes) ?? nodes[0]?.id ?? null;
  }
  return nodes.find((n) => n.id === "answer")?.id ?? nodes[0]?.id ?? null;
}
