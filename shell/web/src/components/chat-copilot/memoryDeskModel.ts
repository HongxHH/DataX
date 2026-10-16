import type { PromptInventorySnapshot } from "../../protocol/events";
import type { MemoryRecallHit, MemorySessionCard } from "../../api/rest";
import { parseRecallCheckpoint, type PackedRecall } from "./promptInventoryModel";
import { splitRecallCheckpoint } from "./prepLogModel";
import type { TrajectoryGroup } from "./trajectoryModel";

export const CROSS_SESSION_MARK = "**Cross-Session Memories:**";

export type MemoryListFilter = "all" | "packed" | "findings";

export interface RecallPromptLocator {
  file: string;
  chunkIndex: number;
  eventIndex: number;
}

export interface MemoryMdBlock {
  sessionId: string | null;
  body: string;
}

export function extractCrossSessionMemories(content: string): string {
  const idx = content.indexOf(CROSS_SESSION_MARK);
  if (idx < 0) return "";
  return content.slice(idx + CROSS_SESSION_MARK.length).trim();
}

export function packedSessionIds(packed: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const matches = String(packed || "").matchAll(/^###\s+([A-Za-z0-9_.:-]+)/gm);
  for (const match of matches) {
    const id = match[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function firstPackedSessionId(packed: string): string | undefined {
  return packedSessionIds(packed)[0];
}

export function clipPackedPreview(text: string, max = 72): string {
  const one = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!one) return "";
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

export function extractPackedFromGroups(groups: TrajectoryGroup[]): string {
  for (let g = groups.length - 1; g >= 0; g -= 1) {
    const group = groups[g];
    if (group.sub_id != null && group.sub_id > 0) continue;
    const events = group.events ?? [];
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (event.type !== "llm_start") continue;
      const blob = [
        event.prompt ?? "",
        ...(event.prompt_messages ?? []).map((item) => item.content),
      ].join("\n");
      const packed = extractCrossSessionMemories(blob);
      if (packed) return packed;
    }
  }
  return "";
}

export function findRecallPromptLocator(groups: TrajectoryGroup[]): RecallPromptLocator | null {
  let fallback: RecallPromptLocator | null = null;
  for (let g = groups.length - 1; g >= 0; g -= 1) {
    const group = groups[g];
    if (group.sub_id != null && group.sub_id > 0) continue;
    const events = group.events ?? [];
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (event.type !== "llm_start") continue;
      const locator: RecallPromptLocator = {
        file: group.file,
        chunkIndex: group.chunk_index ?? 0,
        eventIndex: event.event_index ?? i,
      };
      const blob = [
        event.prompt ?? "",
        ...(event.prompt_messages ?? []).map((item) => item.content),
      ].join("\n");
      if (blob.includes(CROSS_SESSION_MARK)) return locator;
      if (!fallback) fallback = locator;
    }
  }
  return fallback;
}

export function resolveLiveRecall(
  packed: PromptInventorySnapshot | null | undefined,
  prepLog: string[],
): PackedRecall | null {
  const inferred = parseRecallCheckpoint(prepLog);
  if (!packed?.recall) return inferred;
  if (inferred && inferred.status === packed.recall) return inferred;
  if (packed.recall === "hit") return { status: "hit", label: "跨会话记忆：命中" };
  if (packed.recall === "empty") return { status: "empty", label: "跨会话记忆：未命中" };
  return { status: "disabled", label: "跨会话记忆：已跳过" };
}

export function liveRecallCaption(recall: PackedRecall | null): { title: string; detail: string } {
  if (!recall) {
    return {
      title: "尚无本轮数据",
      detail: "跑一轮对话后，这里会对照实际装入 Planner 的跨会话记忆。",
    };
  }
  const split = splitRecallCheckpoint(recall.label);
  const headline = (split?.headline || recall.label).replace(/^跨会话记忆：/, "").trim();
  if (recall.status === "hit") return { title: headline || "命中", detail: "" };
  if (recall.status === "empty") return { title: "未命中", detail: "" };
  return { title: "已跳过", detail: "" };
}

export function abbreviateSessionId(id: string): string {
  const text = String(id || "").trim();
  if (!text) return "";
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(text)) return text.slice(0, 8);
  if (text.length > 14) return `${text.slice(0, 8)}…`;
  return text;
}

export function rejectReasonLabel(reason?: string | null): string {
  if (reason === "below_threshold") return "低于阈值";
  if (reason === "outside_top_k") return "未进 top_k";
  return "";
}

export function hitMetaLine(hit: MemoryRecallHit | undefined): string {
  if (!hit) return "";
  const bits = [`分 ${hit.score.toFixed(2)}`];
  if (hit.would_pack) bits.push("将装入");
  const reject = rejectReasonLabel(hit.reject_reason);
  if (reject) bits.push(reject);
  if (hit.overlap_tokens && hit.overlap_tokens.length > 0) {
    bits.push(`重叠 ${hit.overlap_tokens.slice(0, 6).join(" ")}`);
  }
  return bits.join(" · ");
}

export function filterMemorySessions(
  sessions: MemorySessionCard[],
  filter: MemoryListFilter,
  packedIds: Set<string>,
): MemorySessionCard[] {
  if (filter === "packed") return sessions.filter((item) => packedIds.has(item.session_id));
  if (filter === "findings") return sessions.filter((item) => item.findings_count > 0);
  return sessions;
}

export function partitionCurrentSessions(sessions: MemorySessionCard[]): {
  rest: MemorySessionCard[];
  current: MemorySessionCard[];
} {
  const rest: MemorySessionCard[] = [];
  const current: MemorySessionCard[] = [];
  for (const item of sessions) {
    if (item.is_current) current.push(item);
    else rest.push(item);
  }
  return { rest, current };
}

export function splitMemoryMarkdown(content: string): MemoryMdBlock[] {
  const text = String(content || "");
  const parts = text.split(/^###\s+/m);
  const blocks: MemoryMdBlock[] = [];
  const lead = (parts[0] ?? "").trim();
  if (lead) blocks.push({ sessionId: null, body: lead });
  for (const part of parts.slice(1)) {
    const newline = part.indexOf("\n");
    const heading = (newline < 0 ? part : part.slice(0, newline)).trim();
    const sessionId = heading.match(/^[A-Za-z0-9_.:-]+/)?.[0] ?? "";
    const leftover = sessionId ? heading.slice(sessionId.length).trim() : heading;
    const rest = newline < 0 ? "" : part.slice(newline + 1).trim();
    const body = [leftover, rest].filter(Boolean).join("\n");
    if (!sessionId) continue;
    blocks.push({ sessionId, body });
  }
  return blocks;
}
