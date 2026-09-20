export const PROTOCOL_VERSION = 1;

export const ShellEventType = {
  STAGE: "stage",
  TOKEN: "token",
  THINK: "think",
  PLAN: "plan",
  TOOL: "tool",
  ARTIFACT: "artifact",
  LOG: "log",
  RESULT: "result",
  ERROR: "error",
  CONTEXT: "context",
  CONTEXT_USAGE: "context_usage",
  PROMPT_INVENTORY: "prompt_inventory",
  SPAN: "span",
} as const;

export type ShellEventName = typeof ShellEventType[keyof typeof ShellEventType];

export interface ProfileInfo {
  id: string;
  title: string;
  layout: string;
  agent_config: string;
  agent_type: string;
  features?: Record<string, boolean>;
}

export interface HealthResponse {
  status: string;
  profile?: ProfileInfo;
  layout?: string;
  agent?: Record<string, unknown>;
  semantic_layer?: Record<string, unknown>;
  semantic_required?: boolean;
}

export interface SwitchProfileResponse {
  profile: ProfileInfo;
  agent?: Record<string, unknown>;
  layout?: string;
}

export interface SpanEventData {
  kind?: "llm" | "tool" | string;
  phase?: "start" | "end" | string;
  name?: string;
  tool_call_id?: string;
  parent_tool_call_id?: string;
  inner_tool_call_id?: string;
  sub_id?: number;
  timestamp?: number;
  duration_ms?: number;
  failed?: boolean;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export type ContextHistory = "restore" | "compressed";
export type ContextCompressKind = "ir" | "fold";

export interface ContextUsageParts {
  system?: number;
  history?: number;
  user?: number;
  other?: number;
}

export interface ContextUsageSnapshot {
  used_input_tokens?: number;
  context_window?: number;
  compress_token_limit?: number;
  history?: ContextHistory;
  compress_kind?: ContextCompressKind;
  sub_id?: number;
  parts?: ContextUsageParts;
}

export type PackedRecallStatus = "hit" | "empty" | "disabled";

export interface PackedIrSummary {
  tool?: string;
  nodes?: string[];
}

export interface PackedWorkerCard {
  sub_id: number;
  artifact_count: number;
  has_error: boolean;
}

export interface PromptInventorySnapshot {
  ir_summary_count: number;
  workers: PackedWorkerCard[];
  ir_summaries?: PackedIrSummary[];
  skill_count?: number;
  has_plan?: boolean;
  has_memory?: boolean;
  ir_unpacked?: boolean;
  recall?: PackedRecallStatus;
  sub_id?: number;
}

export interface QueryResult {
  success?: boolean;
  message?: string;
  sql?: string;
  columns?: string[];
  rows_preview?: unknown[];
  confidence?: number;
  session_id?: string;
  delegations?: Array<Record<string, unknown>>;
}

export interface ToolEventData {
  tool_name?: string;
  tool_call_id?: string;
  status?: string;
  summary?: string;
  error?: string;
  node?: string;
  scope?: string;
  agent_type?: string;
  sub_id?: number;
  resumed?: boolean;
  worker_busy?: boolean;
}

export interface StageEventData {
  stage?: string;
  label?: string;
  hint?: string;
  node?: string;
  order?: number;
  tool_call_id?: string;
  scope?: string;
  agent_type?: string;
}

export type ThinkPhase = "start" | "delta" | "end";

export type ThinkKind = "reasoning" | "draft";

export interface ThinkEventData {
  content?: string;
  node?: string;
  scope?: string;
  phase?: ThinkPhase;
  tool_call_id?: string;
  kind?: ThinkKind;
}

export interface PlanToolItem {
  name: string;
  args_summary?: string;
  label?: string;
  config_path?: string;
}

export interface PlanEventData {
  node?: string;
  scope?: string;
  tools?: PlanToolItem[];
  hint?: string;
}

export function parsePlanTools(value: unknown): PlanToolItem[] {
  if (!Array.isArray(value)) return [];
  const tools: PlanToolItem[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const name = String(rec.name ?? "").trim();
    if (!name) continue;
    const next: PlanToolItem = { name };
    if (typeof rec.args_summary === "string" && rec.args_summary) next.args_summary = rec.args_summary;
    if (typeof rec.label === "string" && rec.label) next.label = rec.label;
    if (typeof rec.config_path === "string" && rec.config_path) next.config_path = rec.config_path;
    tools.push(next);
  }
  return tools;
}
