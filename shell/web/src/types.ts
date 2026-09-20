import type { ContextUsageSnapshot, PlanToolItem, PromptInventorySnapshot, SpanEventData } from "./protocol/events";

export interface SessionSummary {
  id: string;
  title: string;
  preview: string;
  created_at?: string;
  updated_at?: string;
  context_usage?: ContextUsageSnapshot;
}

export type TurnStatus = "running" | "done" | "error";

export type LogLevel = "info" | "stage" | "error";

export interface RunLogEntry {
  message: string;
  level?: LogLevel;
  time?: string;
}

export interface StageEntry {
  stage: string;
  label: string;
  status: "active" | "done";
}

export interface RecallExcerpt {
  source_path?: string;
  start_line?: number;
  end_line?: number;
  relevance?: string;
  excerpt?: string;
}

export interface PlotImageRef {
  image_path?: string;
  description?: string;
}

export interface DelegationBlock {
  tool_call_id: string;
  tool_name?: string;
  label?: string;
  status?: TurnStatus;
  logs?: RunLogEntry[];
  stages?: StageEntry[];
  current_stage_label?: string;
  sql?: string;
  columns?: string[];
  rows_preview?: unknown[];
  row_count?: number;
  preview_row_count?: number;
  csv_path?: string;
  sql_path?: string;
  excerpts?: RecallExcerpt[];
  recall_summary?: string;
  recall_path?: string;
  image_path?: string;
  images?: PlotImageRef[];
  report_path?: string;
  error?: string;
  sub_thinking?: string;
  sub_id?: number;
  resumed?: boolean;
  started_at?: number;
  ended_at?: number;
  last_llm_name?: string;
  last_llm_ms?: number;
  llm_running?: boolean;
  input_tokens?: number;
  output_tokens?: number;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp?: string;
  sql?: string;
  columns?: string[];
  rows_preview?: unknown[];
  status?: TurnStatus;
  logs?: RunLogEntry[];
  stages?: StageEntry[];
  currentStageLabel?: string;
  delegations?: DelegationBlock[];
  thinking?: string;
  main_thinking?: string;
  plan_hint?: string;
  plan_tools?: PlanToolItem[];
  plan_prep?: string[];
  rewritten_query?: string;
  context_usage?: ContextUsageSnapshot;
  prompt_inventory?: PromptInventorySnapshot;
  turn_started_at?: number;
  turn_ended_at?: number;
  otel_spans?: SpanEventData[];
}

export interface SessionDetail {
  id: string;
  title: string;
  preview: string;
  messages: ChatMessage[];
  created_at?: string;
  updated_at?: string;
  context_usage?: ContextUsageSnapshot;
}
