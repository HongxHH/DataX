import type {
  PackedIrSummary,
  PackedRecallStatus,
  PackedWorkerCard,
  PlanToolItem,
  PromptInventorySnapshot,
} from "../../protocol/events";
import type { ContextUsageSnapshot } from "../../protocol/events";
import type { ChatMessage, DelegationBlock } from "../../types";
import { displayAgentLabel } from "./delegationState";
import { historyChip, usagePartShares, type HistoryChip, type UsagePartShare } from "./contextUsageModel";

export type InventorySource = "packed" | "inferred";

export const IR_EMPTY_DETAIL = "本轮历史仍是工具原文，未做 IR 压缩。";

export interface PackedWorker {
  key: string;
  sub_id: number | null;
  resumed?: boolean;
  hasError?: boolean;
  label: string;
  status?: string;
  summary?: string;
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

export interface PackedIrInventory {
  count: number;
  items: PackedIrSummary[];
  unpacked: boolean;
}

export interface PackedFlags {
  skillCount: number;
  hasPlan: boolean;
  hasMemory: boolean;
}

export type AssemblyScope = "main" | "sub";
export type AssemblySlotKind = "parts" | "history" | "ir" | "worker" | "flags" | "recall" | "rewrite";

export interface AssemblySlot {
  kind: AssemblySlotKind;
  title: string;
  badge?: string;
}

export interface PromptInventory {
  source: InventorySource;
  history: PackedHistory | null;
  parts: UsagePartShare[] | null;
  workers: PackedWorker[];
  recall: PackedRecall | null;
  rewrittenQuery: string | null;
  ir: PackedIrInventory | null;
  flags: PackedFlags | null;
}

const RECALL_PREFIX = "跨会话记忆：";
const REWRITE_PREFIX = "问句已改写为 ";
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const NODE_TYPE = /^[A-Za-z][A-Za-z0-9]{0,31}$/;
const RECALL_STATUSES = new Set<PackedRecallStatus>(["hit", "empty", "disabled"]);

export function parsePromptInventory(raw: unknown): PromptInventorySnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const count = nonNegativeInt(rec.ir_summary_count);
  if (count == null) return null;
  const snapshot: PromptInventorySnapshot = {
    ir_summary_count: count,
    workers: parsePackedWorkers(rec.workers),
  };
  const summaries = parsePackedSummaries(rec.ir_summaries);
  if (summaries.length > 0) snapshot.ir_summaries = summaries;
  const skills = nonNegativeInt(rec.skill_count);
  if (skills != null) snapshot.skill_count = skills;
  if (rec.has_plan === true) snapshot.has_plan = true;
  if (rec.has_memory === true) snapshot.has_memory = true;
  if (rec.ir_unpacked === true) snapshot.ir_unpacked = true;
  const recall = parseRecallStatus(rec.recall);
  if (recall) snapshot.recall = recall;
  const subId = positiveInt(rec.sub_id);
  if (subId != null) snapshot.sub_id = subId;
  return snapshot;
}

export function isMainAgentInventory(snapshot: PromptInventorySnapshot): boolean {
  return snapshot.sub_id == null || snapshot.sub_id <= 0;
}

const SUB_INVENTORIES_MAX = 20;

export function parseSubPromptInventories(raw: unknown): Record<string, PromptInventorySnapshot> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  let out: Record<string, PromptInventorySnapshot> = {};
  for (const value of Object.values(raw as Record<string, unknown>)) {
    const parsed = parsePromptInventory(value);
    if (!parsed || isMainAgentInventory(parsed)) continue;
    out = upsertSubInventory(out, parsed);
  }
  return out;
}

export function upsertSubInventory(
  store: Record<string, PromptInventorySnapshot>,
  snapshot: PromptInventorySnapshot,
): Record<string, PromptInventorySnapshot> {
  if (isMainAgentInventory(snapshot) || snapshot.sub_id == null) return store;
  const key = String(snapshot.sub_id);
  const next: Record<string, PromptInventorySnapshot> = { ...store };
  delete next[key];
  next[key] = snapshot;
  const keys = Object.keys(next);
  if (keys.length <= SUB_INVENTORIES_MAX) return next;
  for (const drop of keys.slice(0, keys.length - SUB_INVENTORIES_MAX)) {
    delete next[drop];
  }
  return next;
}

export function subInventoryOf(
  map: Record<string, PromptInventorySnapshot> | undefined,
  subId: number | undefined | null,
): PromptInventorySnapshot | undefined {
  if (subId == null || subId <= 0 || !map) return undefined;
  return map[String(subId)];
}

export function irCountBadge(snapshot?: PromptInventorySnapshot | null): string | undefined {
  const count = snapshot?.ir_summary_count ?? 0;
  if (count <= 0) return undefined;
  return `IR×${count}`;
}

export function inventoryChipForAgent(
  subId: number | undefined | null,
  inventories: Record<string, PromptInventorySnapshot> | undefined,
): { key: string; label: string } | undefined {
  const badge = irCountBadge(subInventoryOf(inventories, subId));
  if (!badge) return undefined;
  return { key: "ir", label: badge };
}

export function collectPackedWorkers(
  delegations: DelegationBlock[],
  planTools: PlanToolItem[] = [],
): PackedWorker[] {
  const byKey = new Map<string, PackedWorker>();
  const order: string[] = [];
  delegations.forEach((block, index) => {
    const subId = block.sub_id != null && block.sub_id > 0 ? block.sub_id : null;
    const key = subId != null ? `id-${subId}` : `call-${block.tool_call_id || order.length}`;
    const incoming = artifactLabels(block);
    const summary = workerQuerySummary(block, planTools[index]);
    const existing = byKey.get(key);
    if (!existing) {
      order.push(key);
      byKey.set(key, {
        key,
        sub_id: subId,
        resumed: block.resumed,
        label: displayAgentLabel(block.label) || "子 Agent",
        status: block.status,
        summary,
        artifacts: incoming,
      });
      return;
    }
    const idx = order.indexOf(key);
    if (idx >= 0) order.splice(idx, 1);
    order.push(key);
    existing.resumed = block.resumed;
    if (block.label?.trim()) existing.label = displayAgentLabel(block.label) || existing.label;
    if (block.status) existing.status = block.status;
    if (summary) existing.summary = summary;
    for (const item of incoming) {
      if (!existing.artifacts.includes(item)) existing.artifacts.push(item);
    }
  });
  return order.map((id) => byKey.get(id)!).reverse();
}

export function workerSummariesBySubId(
  messages: ChatMessage[],
  activeTurn?: ChatMessage | null,
  liveDelegations: DelegationBlock[] = [],
  livePlanTools: PlanToolItem[] = [],
  live = false,
): Map<number, string> {
  const map = new Map<number, string>();
  const absorb = (delegations: DelegationBlock[] | undefined, planTools: PlanToolItem[]) => {
    const blocks = Array.isArray(delegations) ? delegations : [];
    blocks.forEach((block, index) => {
      const subId = block.sub_id != null && block.sub_id > 0 ? block.sub_id : null;
      if (subId == null) return;
      const summary = workerQuerySummary(block, planTools[index]);
      if (summary) map.set(subId, summary);
    });
  };
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    absorb(message.delegations, message.plan_tools ?? []);
  }
  if (activeTurn) absorb(activeTurn.delegations, activeTurn.plan_tools ?? []);
  if (live) absorb(liveDelegations, livePlanTools);
  return map;
}

export function mergePackedWorkers(
  cards: PackedWorkerCard[] | undefined,
  delegations: DelegationBlock[],
  planTools: PlanToolItem[] = [],
  summariesBySubId: Map<number, string> = new Map(),
): PackedWorker[] {
  const live = applyWorkerSummaries(collectPackedWorkers(delegations, planTools), summariesBySubId);
  if (!cards || cards.length === 0) return live;
  const byId = new Map<number, PackedWorker>();
  for (const worker of live) {
    if (worker.sub_id != null) byId.set(worker.sub_id, worker);
  }
  return cards.map((card) => {
    const overlay = byId.get(card.sub_id);
    const countLabel = card.artifact_count > 0 ? [`${card.artifact_count} 个产物`] : [];
    return {
      key: `id-${card.sub_id}`,
      sub_id: card.sub_id,
      hasError: card.has_error === true || overlay?.hasError === true,
      label: overlay?.label || "Worker",
      status: overlay?.status,
      resumed: overlay?.resumed,
      summary: overlay?.summary ?? summariesBySubId.get(card.sub_id),
      artifacts: overlay && overlay.artifacts.length > 0 ? overlay.artifacts : countLabel,
    };
  });
}

function applyWorkerSummaries(
  workers: PackedWorker[],
  summariesBySubId: Map<number, string>,
): PackedWorker[] {
  if (summariesBySubId.size === 0) return workers;
  return workers.map((worker) => {
    if (worker.sub_id == null) return worker;
    const summary = summariesBySubId.get(worker.sub_id);
    return summary ? { ...worker, summary } : worker;
  });
}

export function workerQuerySummary(
  block: Pick<DelegationBlock, "sql">,
  planTool?: Pick<PlanToolItem, "args_summary"> | null,
): string | undefined {
  const fromPlan = planTool?.args_summary?.trim();
  if (fromPlan) return clipInventoryText(fromPlan, 96);
  const sql = block.sql?.replace(/\s+/g, " ").trim();
  if (!sql) return undefined;
  return clipInventoryText(sql, 96);
}

export function resolvePlanTools(
  messages: ChatMessage[],
  activeTurn: ChatMessage | null | undefined,
  liveTools: PlanToolItem[] = [],
): PlanToolItem[] {
  if (liveTools.length > 0) return liveTools;
  if (activeTurn?.plan_tools?.length) return activeTurn.plan_tools;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const tools = messages[i]?.plan_tools;
    if (messages[i]?.role === "assistant" && tools?.length) return tools;
  }
  return [];
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

export function historyExplain(
  usage: ContextUsageSnapshot | null | undefined,
  packed?: PromptInventorySnapshot | null,
): PackedHistory | null {
  if (packed && packed.ir_summary_count > 0) {
    const chip = historyChip(usage?.history ?? "compressed", usage?.compress_kind ?? "ir");
    return {
      chip,
      detail: `历史 ToolMessage 中有 ${packed.ir_summary_count} 条 IR 摘要（只统计工具名与节点类型）。`,
    };
  }
  if (!usage?.history) return null;
  const chip = historyChip(usage.history, usage.compress_kind);
  if (usage.history === "compressed" && usage.compress_kind === "ir") {
    return {
      chip,
      detail: "较早轮次的工具结果已换成路径摘要；最近若干轮仍保留原文。",
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

export function resolvePackedInventory(
  messages: ChatMessage[],
  activeTurn: ChatMessage | null | undefined,
  livePacked: PromptInventorySnapshot | null | undefined,
): PromptInventorySnapshot | null {
  if (livePacked && isMainAgentInventory(livePacked)) return livePacked;
  if (activeTurn?.prompt_inventory && isMainAgentInventory(activeTurn.prompt_inventory)) {
    return activeTurn.prompt_inventory;
  }
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const packed = messages[i]?.prompt_inventory;
    if (messages[i]?.role === "assistant" && packed && isMainAgentInventory(packed)) return packed;
  }
  return null;
}

export function buildPromptInventory(input: {
  usage?: ContextUsageSnapshot | null;
  packed?: PromptInventorySnapshot | null;
  delegations: DelegationBlock[];
  planTools?: PlanToolItem[];
  messages?: ChatMessage[];
  activeTurn?: ChatMessage | null;
  live?: boolean;
  prepLog: string[];
  rewrittenQuery?: string | null;
}): PromptInventory {
  const packed = input.packed ?? null;
  const planTools = input.planTools ?? [];
  const summaries = workerSummariesBySubId(
    input.messages ?? [],
    input.activeTurn,
    input.delegations,
    planTools,
    Boolean(input.live),
  );
  return {
    source: packed ? "packed" : "inferred",
    history: historyExplain(input.usage, packed),
    parts: input.usage ? usagePartShares(input.usage) : null,
    workers: packed
      ? mergePackedWorkers(packed.workers, input.delegations, planTools, summaries)
      : applyWorkerSummaries(collectPackedWorkers(input.delegations, planTools), summaries),
    recall: packedRecall(packed, parseRecallCheckpoint(input.prepLog)),
    rewrittenQuery: parseRewrittenQuery(input.prepLog, input.rewrittenQuery),
    ir: packed ? irFromPacked(packed) : null,
    flags: packed ? flagsFromPacked(packed) : null,
  };
}

export function assemblySlots(inventory: PromptInventory, scope: AssemblyScope = "main"): AssemblySlot[] {
  const slots: AssemblySlot[] = [];
  if (scope === "main" && inventory.parts && inventory.parts.length > 0) {
    slots.push({ kind: "parts", title: "分块" });
  }
  if (scope === "main" && inventory.history) {
    slots.push({ kind: "history", title: "历史", badge: inventory.history.chip.label });
  }
  if (inventory.ir) {
    slots.push({
      kind: "ir",
      title: "IR",
      badge: inventory.ir.count > 0 ? `×${inventory.ir.count}` : undefined,
    });
  }
  if (scope === "main") {
    slots.push({
      kind: "worker",
      title: "Worker",
      badge: inventory.workers.length > 0 ? String(inventory.workers.length) : undefined,
    });
  }
  if (
    inventory.flags &&
    (scope === "main" ||
      inventory.flags.skillCount > 0 ||
      inventory.flags.hasPlan ||
      inventory.flags.hasMemory)
  ) {
    slots.push({ kind: "flags", title: "其它槽位" });
  }
  if (inventory.recall) {
    slots.push({ kind: "recall", title: "召回" });
  }
  if (scope === "main" && inventory.rewrittenQuery) {
    slots.push({ kind: "rewrite", title: "问句改写" });
  }
  return slots;
}

export function shouldShowAssembly(inventory: PromptInventory, scope: AssemblyScope = "main"): boolean {
  const slots = assemblySlots(inventory, scope);
  if (slots.length === 0) return false;
  if (scope === "sub") return inventory.source === "packed";
  if (inventory.source === "packed") return true;
  return inventory.workers.length > 0 || Boolean(inventory.recall) || Boolean(inventory.rewrittenQuery);
}

function packedRecall(
  packed: PromptInventorySnapshot | null,
  inferred: PackedRecall | null,
): PackedRecall | null {
  if (!packed?.recall) return inferred;
  if (packed.recall === "hit") return { status: "hit", label: "已装入跨会话记忆。" };
  if (packed.recall === "empty") return { status: "empty", label: "未命中跨会话记忆。" };
  return { status: "disabled", label: "跨会话记忆已跳过。" };
}

function irFromPacked(packed: PromptInventorySnapshot): PackedIrInventory {
  return {
    count: packed.ir_summary_count,
    items: packed.ir_summaries ?? [],
    unpacked: packed.ir_unpacked === true,
  };
}

function flagsFromPacked(packed: PromptInventorySnapshot): PackedFlags {
  return {
    skillCount: packed.skill_count ?? 0,
    hasPlan: packed.has_plan === true,
    hasMemory: packed.has_memory === true,
  };
}

function parsePackedWorkers(raw: unknown): PackedWorkerCard[] {
  if (!Array.isArray(raw)) return [];
  const out: PackedWorkerCard[] = [];
  const seen = new Set<number>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const subId = positiveInt(rec.sub_id);
    if (subId == null || seen.has(subId)) continue;
    seen.add(subId);
    out.push({
      sub_id: subId,
      artifact_count: nonNegativeInt(rec.artifact_count) ?? 0,
      has_error: rec.has_error === true,
    });
    if (out.length >= 10) break;
  }
  return out;
}

function parsePackedSummaries(raw: unknown): PackedIrSummary[] {
  if (!Array.isArray(raw)) return [];
  const out: PackedIrSummary[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const entry: PackedIrSummary = {};
    const tool = String(rec.tool ?? "").trim();
    if (TOOL_NAME.test(tool)) entry.tool = tool;
    const nodes = parseNodeTypes(rec.nodes);
    if (nodes.length > 0) entry.nodes = nodes;
    if (entry.tool || entry.nodes) out.push(entry);
    if (out.length >= 20) break;
  }
  return out;
}

function parseNodeTypes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const name = String(item ?? "").trim();
    if (!NODE_TYPE.test(name) || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= 8) break;
  }
  return out;
}

function parseRecallStatus(raw: unknown): PackedRecallStatus | null {
  const text = String(raw ?? "").trim();
  return RECALL_STATUSES.has(text as PackedRecallStatus) ? (text as PackedRecallStatus) : null;
}

function clipInventoryText(text: string, max = 140): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max - 1)}…`;
}

function artifactLabels(block: DelegationBlock): string[] {
  const labels: string[] = [];
  if (block.sql || block.sql_path) labels.push("SQL");
  if ((block.columns && block.columns.length > 0) || block.csv_path) labels.push("表");
  if (block.excerpts && block.excerpts.length > 0) labels.push("摘录");
  if (block.image_path || (block.images && block.images.length > 0)) labels.push("图");
  if (block.report_path) labels.push("报告");
  return labels;
}

function nonNegativeInt(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

function positiveInt(value: unknown): number | null {
  const n = nonNegativeInt(value);
  return n != null && n > 0 ? n : null;
}
