import type { ContextUsageSnapshot } from "../../protocol/events";
import type { ChatMessage, DelegationBlock } from "../../types";
import { historyChip, usagePartShares, type HistoryChip, type UsagePartShare } from "./contextUsageModel";

export type PackedRecallStatus = "hit" | "empty" | "disabled";

export interface PackedWorker {
  key: string;
  sub_id: number | null;
  resumed?: boolean;
  label: string;
  status?: string;
  artifacts: string[];
}

export interface PackedRecall {
  status: PackedRecallStatus;
  label: string;
}

export interface PackedHistory {
  chip: HistoryChip;
  detail: string;
}

export interface PromptInventory {
  history: PackedHistory | null;
  parts: UsagePartShare[] | null;
  workers: PackedWorker[];
  recall: PackedRecall | null;
  rewrittenQuery: string | null;
}

const RECALL_PREFIX = "跨会话记忆：";
const REWRITE_PREFIX = "问句已改写为 ";

export function collectPackedWorkers(delegations: DelegationBlock[]): PackedWorker[] {
  const byKey = new Map<string, PackedWorker>();
  const order: string[] = [];
  for (const block of delegations) {
    const subId = block.sub_id != null && block.sub_id > 0 ? block.sub_id : null;
    const key = subId != null ? `id-${subId}` : `call-${block.tool_call_id || order.length}`;
    const incoming = artifactLabels(block);
    const existing = byKey.get(key);
    if (!existing) {
      order.push(key);
      byKey.set(key, {
        key,
        sub_id: subId,
        resumed: block.resumed,
        label: block.label?.trim() || "子 Agent",
        status: block.status,
        artifacts: incoming,
      });
      continue;
    }
    const idx = order.indexOf(key);
    if (idx >= 0) order.splice(idx, 1);
    order.push(key);
    if (block.resumed != null) existing.resumed = block.resumed;
    if (block.label?.trim()) existing.label = block.label.trim();
    if (block.status) existing.status = block.status;
    for (const item of incoming) {
      if (!existing.artifacts.includes(item)) existing.artifacts.push(item);
    }
  }
  return order.map((id) => byKey.get(id)!).reverse();
}

export function parseRecallCheckpoint(prepLog: string[]): PackedRecall | null {
  for (let i = prepLog.length - 1; i >= 0; i -= 1) {
    const text = String(prepLog[i] ?? "").trim();
    if (!text.startsWith(RECALL_PREFIX)) continue;
    const rest = text.slice(RECALL_PREFIX.length);
    if (rest.startsWith("已跳过")) return { status: "disabled", label: clipInventoryText(text) };
    if (rest.startsWith("未命中")) return { status: "empty", label: clipInventoryText(text) };
    return { status: "hit", label: clipInventoryText(text) };
  }
  return null;
}

export function parseRewrittenQuery(prepLog: string[], rewrittenQuery?: string | null): string | null {
  const explicit = rewrittenQuery?.trim();
  if (explicit) return explicit;
  for (let i = prepLog.length - 1; i >= 0; i -= 1) {
    const text = String(prepLog[i] ?? "").trim();
    if (text.startsWith(REWRITE_PREFIX)) {
      const query = text.slice(REWRITE_PREFIX.length).trim();
      if (query) return query;
    }
  }
  return null;
}

export function historyExplain(usage: ContextUsageSnapshot | null | undefined): PackedHistory | null {
  if (!usage?.history) return null;
  const chip = historyChip(usage.history, usage.compress_kind);
  if (usage.history === "compressed" && usage.compress_kind === "ir") {
    return {
      chip,
      detail: "较早轮次的工具结果已换成路径摘要；最近若干轮仍保留原文。壳侧看不到具体摘要条数。",
    };
  }
  if (usage.history === "compressed" && usage.compress_kind === "fold") {
    return {
      chip,
      detail: "历史被折叠成更短摘要。IR 替换仍超限时才会走到这一步。",
    };
  }
  if (usage.history === "compressed") {
    return { chip, detail: "历史已压缩，未标明是 IR 摘要还是折叠。" };
  }
  return { chip, detail: "历史工具结果仍按原文装入（超长会截断）。" };
}

export function resolveInventoryPrepLog(
  messages: ChatMessage[],
  activeTurn: ChatMessage | null | undefined,
  livePrep: string[],
  live: boolean,
): string[] {
  if (live && livePrep.length > 0) return livePrep;
  if (activeTurn?.plan_prep?.length) return activeTurn.plan_prep;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const prep = messages[i]?.plan_prep;
    if (messages[i]?.role === "assistant" && prep?.length) return prep;
  }
  return livePrep;
}

export function resolveRewrittenQuery(
  messages: ChatMessage[],
  activeTurn: ChatMessage | null | undefined,
): string | null {
  const live = activeTurn?.rewritten_query?.trim();
  if (live) return live;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const query = messages[i]?.rewritten_query?.trim();
    if (messages[i]?.role === "assistant" && query) return query;
  }
  return null;
}

export function buildPromptInventory(input: {
  usage: ContextUsageSnapshot | null | undefined;
  delegations: DelegationBlock[];
  prepLog: string[];
  rewrittenQuery?: string | null;
}): PromptInventory {
  return {
    history: historyExplain(input.usage),
    parts: input.usage ? usagePartShares(input.usage) : null,
    workers: collectPackedWorkers(input.delegations),
    recall: parseRecallCheckpoint(input.prepLog),
    rewrittenQuery: parseRewrittenQuery(input.prepLog, input.rewrittenQuery),
  };
}

function clipInventoryText(text: string, max = 140): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max - 1)}…`;
}

function artifactLabels(block: DelegationBlock): string[] {
  const labels: string[] = [];
  if (block.sql) labels.push("SQL");
  if (block.columns && block.columns.length > 0) labels.push("表");
  if (block.excerpts && block.excerpts.length > 0) labels.push("摘录");
  if (block.image_path || (block.images && block.images.length > 0)) labels.push("图");
  if (block.report_path) labels.push("报告");
  return labels;
}
