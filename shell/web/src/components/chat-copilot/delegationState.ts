import type {
  DelegationBlock,
  LogLevel,
  StageEntry,
  TurnStatus,
} from "../../types";
import type { SpanEventData } from "../../protocol/events";
import { humanizeChatError } from "../shared/chatErrors";
import { fileBaseName, logTime } from "../shared/pathUtils";

const SUB_AGENT_TOOLS = new Set(["sub_agent_tool", "nl2sql_sub_agent_tool"]);

export const SUBAGENT_STARTING_LABEL = "正在启动子 Agent…";
export const SUBAGENT_WAITING_LABEL = "等待启动子 Agent";
export const SUBAGENT_RUNNING_LABEL = "正在执行子 Agent…";

export const THINKING_CLIP_MAX = 2000;

export function clipThinkingTail(text: string, max = THINKING_CLIP_MAX): string {
  if (!text || text.length <= max) return text;
  return `…${text.slice(-(max - 1))}`;
}

const CONFIG_LABELS: Record<string, string> = {
  "landcheck_nl2sql.yaml": "Landcheck NL2SQL",
  "landcheck_document_recall.yaml": "Document Recall",
  "document_recall_agent.yaml": "Document Recall",
  "landcheck_plot.yaml": "Landcheck Plot",
  "landcheck_report.yaml": "Landcheck Report",
};

const TOOL_LABELS: Record<string, string> = {
  sub_agent_tool: "子 Agent",
  nl2sql_sub_agent_tool: "Landcheck NL2SQL",
};

function fileName(path?: string): string {
  return fileBaseName(path);
}

export function isSubAgentTool(toolName?: string): boolean {
  return SUB_AGENT_TOOLS.has(String(toolName || ""));
}

export function workerReuseLabel(block: Pick<DelegationBlock, "sub_id" | "resumed">): string | null {
  if (block.sub_id == null) return null;
  return `#${block.sub_id} ${block.resumed ? "复用" : "新建"}`;
}

export function visibleDelegations(delegations: DelegationBlock[] | undefined): DelegationBlock[] {
  if (!delegations?.length) return [];
  return delegations.filter((block) => !block.tool_name || isSubAgentTool(block.tool_name));
}

export function collectVisibleDelegations(
  messages: Array<{ role?: string; delegations?: DelegationBlock[] }>,
  live?: { delegations?: DelegationBlock[] } | null,
): DelegationBlock[] {
  const byId = new Map<string, DelegationBlock>();
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const block of visibleDelegations(msg.delegations)) {
      const id = block.tool_call_id?.trim();
      if (id) byId.set(id, block);
    }
  }
  for (const block of visibleDelegations(live?.delegations)) {
    const id = block.tool_call_id?.trim();
    if (id) byId.set(id, block);
  }
  return [...byId.values()];
}

export function agentLabelFromConfigPath(configPath?: string, toolName?: string): string {
  const name = fileName(configPath).toLowerCase();
  if (CONFIG_LABELS[name]) return CONFIG_LABELS[name];
  if (name.includes("document_recall")) return "Document Recall";
  if (name.includes("plot")) return "Landcheck Plot";
  if (name.includes("report")) return "Landcheck Report";
  if (name.includes("nl2sql")) return "Landcheck NL2SQL";
  return toolLabel(toolName);
}

export function toolLabel(toolName?: string, configPath?: string): string {
  if (configPath) return agentLabelFromConfigPath(configPath, toolName);
  const name = String(toolName || "tool");
  return TOOL_LABELS[name] ?? name;
}

function isStartupStageLabel(label?: string): boolean {
  const text = String(label || "").trim();
  return !text || text === SUBAGENT_STARTING_LABEL || text === SUBAGENT_WAITING_LABEL;
}

export function runningAgentHint(block: DelegationBlock): string {
  const name = `${block.label ?? ""} ${block.tool_name ?? ""}`.toLowerCase();
  if (name.includes("plot") || name.includes("画图")) {
    return "正在画图，等待模型生成图表…";
  }
  if (name.includes("report") || name.includes("报告")) {
    return "正在生成报告…";
  }
  if (name.includes("recall") || name.includes("文档")) {
    return "正在检索文档…";
  }
  if (name.includes("nl2sql") || name.includes("查询")) {
    return "正在查询数据…";
  }
  return SUBAGENT_RUNNING_LABEL;
}

export function stampRunning(block: DelegationBlock, now = Date.now()): DelegationBlock {
  if (block.started_at) return block;
  return { ...block, started_at: now };
}

export function stampEnded(block: DelegationBlock, now = Date.now()): DelegationBlock {
  if (block.ended_at) return { ...block, started_at: block.started_at ?? now };
  return { ...block, started_at: block.started_at ?? now, ended_at: now };
}

export { logTime };

export function appendDelegationLog(
  block: DelegationBlock,
  message: string,
  level: LogLevel = "info",
): DelegationBlock {
  const logs = block.logs ?? [];
  if (logs.length >= 50) {
    return block;
  }
  return { ...block, logs: [...logs, { message, level, time: logTime() }] };
}

export function appendDelegationThinking(
  block: DelegationBlock,
  delta: string,
): DelegationBlock {
  if (!delta) return block;
  return {
    ...block,
    sub_thinking: clipThinkingTail(`${block.sub_thinking ?? ""}${delta}`),
  };
}

export function mergeDelegationThinking(
  finalized: DelegationBlock[],
  live: DelegationBlock[] | undefined,
): DelegationBlock[] {
  if (!live?.length) return finalized;
  const byId = new Map(live.map((d) => [d.tool_call_id, d]));
  const fallbackThinking = live.find((d) => d.sub_thinking)?.sub_thinking;
  return finalized.map((d) => {
    const liveBlock = byId.get(d.tool_call_id);
    const thinking = liveBlock?.sub_thinking || fallbackThinking;
    const next = {
      ...d,
      started_at: d.started_at ?? liveBlock?.started_at,
      ended_at: d.ended_at ?? liveBlock?.ended_at,
      last_llm_name: d.last_llm_name ?? liveBlock?.last_llm_name,
      last_llm_ms: d.last_llm_ms ?? liveBlock?.last_llm_ms,
      llm_running: d.llm_running ?? liveBlock?.llm_running,
      input_tokens: d.input_tokens ?? liveBlock?.input_tokens,
      output_tokens: d.output_tokens ?? liveBlock?.output_tokens,
    };
    if (!thinking) return next;
    return {
      ...next,
      sub_thinking: clipThinkingTail(thinking),
    };
  });
}

export function applyDelegationStage(
  block: DelegationBlock,
  data: Record<string, unknown>,
): DelegationBlock {
  const stage = String(data.stage ?? "");
  const label = String(data.hint ?? data.label ?? stage);
  const stages: StageEntry[] = (block.stages ?? []).map((s) => {
    if (s.stage === stage) {
      return { ...s, status: "active" as const, label };
    }
    if (s.status === "active") {
      return { ...s, status: "done" as const };
    }
    return s;
  });
  if (!stages.some((s) => s.stage === stage)) {
    stages.push({ stage, label, status: "active" });
  }
  return stampRunning(appendDelegationLog(
    { ...block, stages, current_stage_label: label },
    label,
    "stage",
  ));
}

export function applyDelegationToolEvent(
  block: DelegationBlock,
  data: Record<string, unknown>,
): DelegationBlock {
  const toolName = String(data.tool_name ?? "");
  const configPath = String(data.config_path ?? "");
  const agentLabel = String(data.agent_label ?? "");
  let next: DelegationBlock = { ...block };
  if (toolName) {
    next.tool_name = toolName;
  }
  if (agentLabel || configPath) {
    next.label = agentLabel || toolLabel(toolName, configPath);
  } else if (toolName && !next.label) {
    next.label = toolLabel(toolName);
  }
  const subId = Number(data.sub_id);
  if (Number.isInteger(subId) && subId > 0) {
    next.sub_id = subId;
  }
  if (typeof data.resumed === "boolean") {
    next.resumed = data.resumed;
  }
  const busy = Boolean(data.worker_busy) || /already running|本次未启动/i.test(String(data.error ?? data.summary ?? ""));
  if (isSubAgentTool(toolName) && next.status !== "done" && next.status !== "error" && isStartupStageLabel(next.current_stage_label)) {
    next.current_stage_label = runningAgentHint(next);
  }
  const status = String(data.status ?? "").toLowerCase();
  if (status.includes("error") || status === "failed" || busy) {
    next.status = "error";
    if (busy) {
      next.error = next.sub_id
        ? `子 Agent #${next.sub_id} 正在运行。请停止当前生成，或换一个新的 worker 再问。`
        : "子 Agent 正在运行。请停止当前生成，或换一个新的 worker 再问。";
    } else if (data.error) {
      next.error = humanizeChatError(String(data.error));
    }
    next = stampEnded(next);
  } else if (
    status === "success" ||
    status === "completed" ||
    status === "done"
  ) {
    next.status = "done";
    next = stampEnded(next);
  } else {
    next.status = "running";
    next = stampRunning(next);
  }
  return next;
}

export function applyDelegationArtifact(
  block: DelegationBlock,
  data: Record<string, unknown>,
): DelegationBlock {
  let next = { ...block };
  if (typeof data.agent_label === "string" && data.agent_label) {
    next.label = data.agent_label;
  }
  if (data.kind === "sql" && data.sql) {
    next.sql = String(data.sql);
    next = appendDelegationLog(next, "SQL 已更新", "info");
  }
  if (data.kind === "table") {
    if (Array.isArray(data.columns)) {
      next.columns = data.columns as string[];
    }
    if (Array.isArray(data.rows_preview)) {
      next.rows_preview = data.rows_preview as unknown[];
    }
    if (typeof data.row_count === "number") {
      next.row_count = data.row_count;
    }
    if (typeof data.preview_row_count === "number") {
      next.preview_row_count = data.preview_row_count;
    }
    if (typeof data.csv_path === "string") next.csv_path = data.csv_path;
    if (typeof data.sql_path === "string") next.sql_path = data.sql_path;
  }
  if (data.kind === "excerpts" && Array.isArray(data.excerpts)) {
    next.excerpts = data.excerpts as DelegationBlock["excerpts"];
    if (typeof data.recall_summary === "string") next.recall_summary = data.recall_summary;
    if (typeof data.recall_path === "string") next.recall_path = data.recall_path;
  }
  if (data.kind === "image") {
    if (typeof data.image_path === "string") next.image_path = data.image_path;
    if (Array.isArray(data.images)) next.images = data.images as DelegationBlock["images"];
  }
  if (data.kind === "report" && typeof data.report_path === "string") {
    next.report_path = data.report_path;
  }
  return next;
}

export function applyDelegationSpan(block: DelegationBlock, data: SpanEventData): DelegationBlock {
  const next: DelegationBlock = { ...block };
  if (typeof data.sub_id === "number" && data.sub_id > 0) {
    next.sub_id = data.sub_id;
  }
  if (data.kind !== "llm") {
    return stampRunning(next);
  }
  const name = String(data.name || "").trim();
  if (data.phase === "start") {
    next.llm_running = true;
    if (name) next.last_llm_name = name;
    return stampRunning(next);
  }
  next.llm_running = false;
  if (typeof data.duration_ms === "number") next.last_llm_ms = data.duration_ms;
  if (name) next.last_llm_name = name;
  const usage = data.usage;
  if (usage) {
    next.input_tokens = (next.input_tokens ?? 0) + (usage.input_tokens ?? 0);
    next.output_tokens = (next.output_tokens ?? 0) + (usage.output_tokens ?? 0);
  }
  return stampRunning(next);
}

export function mapDelegationsFromResult(
  raw: unknown,
): DelegationBlock[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw as DelegationBlock[];
}

export function finalizeDelegations(delegations: DelegationBlock[]): DelegationBlock[] {
  return delegations.map((d) => {
    const stages = (d.stages ?? []).map((s) =>
      s.status === "active" ? { ...s, status: "done" as const } : s,
    );
    const status: TurnStatus =
      d.status === "error" ? "error" : "done";
    const { current_stage_label: _, ...rest } = stampEnded(d);
    return { ...rest, stages, status };
  });
}

export function interruptedDelegationReason(startedAt?: number, now = Date.now()): string {
  const minutes = startedAt ? Math.max(1, Math.floor((now - startedAt) / 60_000)) : 1;
  return `已运行 ${minutes} 分钟后连接中断`;
}

export function failOpenDelegations(
  delegations: DelegationBlock[],
  reason?: string,
  now = Date.now(),
): DelegationBlock[] {
  return delegations.map((d) => {
    if (d.status === "error" || d.status === "done") {
      return d;
    }
    const stages = (d.stages ?? []).map((s) =>
      s.status === "active" ? { ...s, status: "done" as const } : s,
    );
    const { current_stage_label: _, ...rest } = stampEnded(d, now);
    return {
      ...rest,
      stages,
      status: "error" as const,
      error: d.error || reason || interruptedDelegationReason(d.started_at, now),
    };
  });
}
