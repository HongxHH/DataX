import type { SpanEventData } from "../../protocol/events";
import type { DelegationBlock } from "../../types";
import { isSubAgentTool } from "./delegationState";
import { pipelineStepsFromDelegation } from "./pipelineSteps";

export interface TrajectoryEvent {
  type: string;
  timestamp?: number;
  model?: string;
  prompt?: string;
  content?: string;
  tool_name?: string;
  tool_call_id?: string;
  is_error?: boolean;
  arguments?: string;
  result?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface TrajectoryGroup {
  file: string;
  role: string;
  sub_id?: number | null;
  run_id?: number | null;
  round_index?: number;
  parent_tool_call_id?: string;
  events: TrajectoryEvent[];
}

export type TrajectorySpanKind = "llm" | "tool" | "stage";

export interface TrajectorySpan {
  id: string;
  kind: TrajectorySpanKind;
  label: string;
  source: string;
  startTs: number | null;
  endTs: number | null;
  failed: boolean;
  prompt?: string;
  arguments?: string;
  result?: string;
  content?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  parentToolCallId?: string;
  subId?: number;
  toolCallId?: string;
  roundKey?: string;
}

export interface TrajectoryBranch {
  id: string;
  title: string;
  source: string;
  spans: TrajectorySpan[];
  children: TrajectoryBranch[];
  failed?: boolean;
}

export function sourceLabel(group: TrajectoryGroup): string {
  if (group.sub_id != null && group.sub_id > 0) {
    const run = group.run_id != null ? ` run ${group.run_id}` : "";
    return `子 Agent #${group.sub_id}${run}`;
  }
  return "主 Agent";
}

function groupSubId(group: TrajectoryGroup): number | undefined {
  return group.sub_id != null && group.sub_id > 0 ? group.sub_id : undefined;
}

function groupParentId(group: TrajectoryGroup): string | undefined {
  const parent = group.parent_tool_call_id?.trim();
  return parent || undefined;
}

const LIVE_ROUND_KEY = "_live";

function groupRoundKey(group: TrajectoryGroup, groupIndex: number): string | undefined {
  if (groupSubId(group) != null) return undefined;
  if (group.role === "sub-agent") return undefined;
  return `main:${group.file}:${group.round_index ?? groupIndex}`;
}

function stampSpan(
  span: TrajectorySpan,
  group: TrajectoryGroup,
  groupIndex: number,
  toolCallId?: string,
): TrajectorySpan {
  const parentToolCallId = groupParentId(group);
  const subId = groupSubId(group);
  const roundKey = groupRoundKey(group, groupIndex);
  if (parentToolCallId) span.parentToolCallId = parentToolCallId;
  if (subId != null) span.subId = subId;
  if (toolCallId) span.toolCallId = toolCallId;
  if (roundKey) span.roundKey = roundKey;
  return span;
}

export function spansFromGroups(groups: TrajectoryGroup[]): TrajectorySpan[] {
  const spans: TrajectorySpan[] = [];
  groups.forEach((group, groupIndex) => {
    const source = sourceLabel(group);
    const openTools = new Map<string, TrajectorySpan>();
    let openLlm: TrajectorySpan | null = null;
    (group.events ?? []).forEach((event, eventIndex) => {
      const id = `${group.file}-${groupIndex}-${eventIndex}`;
      if (event.type === "llm_start") {
        openLlm = stampSpan(
          {
            id,
            kind: "llm",
            label: event.model || "llm",
            source,
            startTs: event.timestamp ?? null,
            endTs: null,
            failed: false,
            prompt: event.prompt,
          },
          group,
          groupIndex,
        );
        spans.push(openLlm);
        return;
      }
      if (event.type === "llm_end" && openLlm) {
        openLlm.endTs = event.timestamp ?? openLlm.endTs;
        openLlm.content = event.content;
        if (event.usage) openLlm.usage = event.usage;
        openLlm = null;
        return;
      }
      if (event.type === "tool_start") {
        const span = stampSpan(
          {
            id,
            kind: "tool",
            label: event.tool_name || "tool",
            source,
            startTs: event.timestamp ?? null,
            endTs: null,
            failed: false,
            arguments: event.arguments,
          },
          group,
          groupIndex,
          event.tool_call_id,
        );
        const key = event.tool_call_id || id;
        openTools.set(key, span);
        spans.push(span);
        return;
      }
      if (event.type === "tool_end") {
        const key = event.tool_call_id || "";
        const span = (key && openTools.get(key)) || spans.filter((item) => item.kind === "tool").at(-1);
        if (!span) return;
        span.endTs = event.timestamp ?? span.endTs;
        span.result = event.result;
        if (event.is_error) span.failed = true;
        if (key) openTools.delete(key);
      }
    });
  });
  return spans.sort((a, b) => (a.startTs ?? 0) - (b.startTs ?? 0));
}

export type LiveSpanEvent = SpanEventData;

export function liveSourceLabel(event: LiveSpanEvent): string {
  if (event.sub_id != null && event.sub_id > 0) {
    return `子 Agent #${event.sub_id}`;
  }
  return "主 Agent";
}

function liveSubId(event: LiveSpanEvent): number | undefined {
  return event.sub_id != null && event.sub_id > 0 ? event.sub_id : undefined;
}

export function spansFromLive(events: LiveSpanEvent[]): TrajectorySpan[] {
  const spans: TrajectorySpan[] = [];
  let openLlm: TrajectorySpan | null = null;
  const openTools = new Map<string, TrajectorySpan>();
  events.forEach((event, index) => {
    const kind = event.kind === "tool" ? "tool" : "llm";
    const source = liveSourceLabel(event);
    const id = `live-${index}`;
    const parentToolCallId = event.parent_tool_call_id?.trim() || undefined;
    const subId = liveSubId(event);
    const toolCallId = event.tool_call_id?.trim() || undefined;
    if (event.phase === "start") {
      const span: TrajectorySpan = {
        id,
        kind,
        label: event.name || kind,
        source,
        startTs: typeof event.timestamp === "number" ? event.timestamp : null,
        endTs: null,
        failed: false,
        parentToolCallId,
        subId,
        toolCallId,
      };
      spans.push(span);
      if (kind === "llm") {
        openLlm = span;
      } else {
        openTools.set(toolCallId || id, span);
      }
      return;
    }
    if (event.phase !== "end") return;
    const target =
      kind === "llm"
        ? openLlm
        : (toolCallId && openTools.get(toolCallId)) || spans.filter((item) => item.kind === kind).at(-1);
    if (!target) return;
    if (typeof event.timestamp === "number") target.endTs = event.timestamp;
    if (event.failed) target.failed = true;
    if (event.usage) target.usage = event.usage;
    if (kind === "llm") openLlm = null;
    else if (toolCallId) openTools.delete(toolCallId);
  });
  return spans.sort((a, b) => (a.startTs ?? 0) - (b.startTs ?? 0));
}

export function visibleTrajectorySpans(
  groups: TrajectoryGroup[],
  live: LiveSpanEvent[] = [],
): TrajectorySpan[] {
  const fromFile = spansFromGroups(groups);
  const fromLive = spansFromLive(live);
  if (fromFile.length === 0) return fromLive;
  const openLive = fromLive.filter((span) => span.endTs == null);
  return [...fromFile, ...openLive].sort((a, b) => (a.startTs ?? 0) - (b.startTs ?? 0));
}

export function spanKindLabel(kind: TrajectorySpanKind): string {
  if (kind === "llm") return "LLM";
  if (kind === "tool") return "Tool";
  return "阶段";
}

export function formatSpanDuration(start: number | null, end: number | null): string {
  if (start == null || end == null || end < start) return "";
  const ms = Math.round((end - start) * 1000);
  if (ms <= 0) return "";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function spanIsRunning(span: TrajectorySpan): boolean {
  return span.endTs == null && span.startTs != null;
}

function isSubAgentToolSpan(span: TrajectorySpan): boolean {
  return span.kind === "tool" && isSubAgentTool(span.label);
}

function isMainRootSpan(span: TrajectorySpan): boolean {
  return !span.parentToolCallId && span.subId == null && !isSubAgentToolSpan(span);
}

function inToolWindow(span: TrajectorySpan, tool: TrajectorySpan): boolean {
  const ts = span.startTs;
  if (ts == null) return false;
  const start = tool.startTs ?? Number.NEGATIVE_INFINITY;
  const end = tool.endTs ?? Number.POSITIVE_INFINITY;
  return ts >= start && ts <= end;
}

function productSpans(block: DelegationBlock): TrajectorySpan[] {
  return pipelineStepsFromDelegation(block)
    .filter((step) => step.detail)
    .map((step, index) => ({
      id: `step-${block.tool_call_id}-${index}`,
      kind: "stage" as const,
      label: step.label,
      source: "产物",
      startTs: null,
      endTs: null,
      failed: false,
      content: step.detail,
    }));
}

function toolIdOf(span: TrajectorySpan): string {
  return span.toolCallId || span.id;
}

function childSource(spans: TrajectorySpan[], fallback: string): string {
  return spans.find((span) => span.subId != null)?.source || fallback;
}

function delegationForTool(
  toolId: string,
  delegations: DelegationBlock[],
): DelegationBlock | undefined {
  return delegations.find((block) => block.tool_call_id === toolId);
}

function branchTitle(
  toolId: string,
  toolSpan: TrajectorySpan | undefined,
  children: TrajectorySpan[],
  delegations: DelegationBlock[],
): string {
  const block = delegationForTool(toolId, delegations);
  const subId = block?.sub_id ?? children.find((span) => span.subId != null)?.subId;
  const name = block?.label || (subId != null ? "子 Agent" : toolSpan?.label || "子 Agent");
  return subId != null ? `${name} · #${subId}` : name;
}

function pickToolForSubId(
  subId: number,
  tools: TrajectorySpan[],
  span: TrajectorySpan,
  delegations: DelegationBlock[],
): TrajectorySpan | undefined {
  const byDelegation = tools.filter((tool) => delegationForTool(toolIdOf(tool), delegations)?.sub_id === subId);
  if (byDelegation.length === 1) return byDelegation[0];
  if (byDelegation.length > 1) {
    const covering = byDelegation.filter((tool) => inToolWindow(span, tool));
    return covering.length === 1 ? covering[0] : undefined;
  }
  if (delegations.length > 0) return undefined;
  return tools.length === 1 ? tools[0] : undefined;
}

function makeToolBranch(
  toolSpan: TrajectorySpan,
  children: TrajectorySpan[],
  delegations: DelegationBlock[],
): TrajectoryBranch {
  const toolId = toolIdOf(toolSpan);
  const block = delegationForTool(toolId, delegations);
  const products = block ? productSpans(block) : [];
  const inner = [...products, ...children].sort((a, b) => {
    if (a.kind === "stage" && b.kind !== "stage") return -1;
    if (a.kind !== "stage" && b.kind === "stage") return 1;
    return (a.startTs ?? 0) - (b.startTs ?? 0);
  });
  return {
    id: toolId,
    title: branchTitle(toolId, toolSpan, children, delegations),
    source: childSource(children, toolSpan.source),
    spans: inner,
    children: [],
    failed: toolSpan.failed || inner.some((span) => span.failed),
  };
}

function makeOrphanBranch(spans: TrajectorySpan[], index: number): TrajectoryBranch {
  const first = spans[0];
  const subId = first?.subId;
  return {
    id: `orphan-${subId ?? first?.source ?? index}`,
    title: first?.source || "子 Agent",
    source: first?.source || "子 Agent",
    spans,
    children: [],
    failed: spans.some((span) => span.failed),
  };
}

export function isRoundBranch(branch: Pick<TrajectoryBranch, "id">): boolean {
  return branch.id.startsWith("round:");
}

function roundBucketKey(span: TrajectorySpan): string {
  return span.roundKey ?? LIVE_ROUND_KEY;
}

function parseRoundIndex(key: string): number {
  if (key === LIVE_ROUND_KEY) return Number.POSITIVE_INFINITY;
  const match = /:(\d+)$/.exec(key);
  return match ? Number(match[1]) : 0;
}

function compareRoundKeys(a: string, b: string): number {
  const ai = parseRoundIndex(a);
  const bi = parseRoundIndex(b);
  if (ai !== bi) return ai - bi;
  return a.localeCompare(b);
}

function formatRoundTitle(index: number, spans: TrajectorySpan[], live: boolean): string {
  if (live) return "本轮进行中";
  const ts = spans.map((span) => span.startTs).find((value) => value != null && Number.isFinite(value));
  let suffix = "";
  if (ts != null) {
    const date = new Date(ts * 1000);
    if (!Number.isNaN(date.getTime())) suffix = ` · ${date.toLocaleTimeString()}`;
  }
  return `第 ${index} 轮${suffix}`;
}

function assembleRoundForest(
  mainSpans: TrajectorySpan[],
  tools: TrajectorySpan[],
  toolBranches: TrajectoryBranch[],
  leftover: TrajectorySpan[],
): TrajectoryBranch[] {
  const buckets = new Map<string, { mains: TrajectorySpan[]; tools: TrajectoryBranch[] }>();
  const touch = (key: string) => {
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { mains: [], tools: [] };
      buckets.set(key, bucket);
    }
    return bucket;
  };
  for (const span of mainSpans) {
    touch(roundBucketKey(span)).mains.push(span);
  }
  tools.forEach((tool, index) => {
    touch(roundBucketKey(tool)).tools.push(toolBranches[index]);
  });

  const forest: TrajectoryBranch[] = [];
  let displayIndex = 0;
  for (const key of [...buckets.keys()].sort(compareRoundKeys)) {
    const bucket = buckets.get(key);
    if (!bucket) continue;
    const live = key === LIVE_ROUND_KEY;
    if (!live) displayIndex += 1;
    forest.push({
      id: `round:${key}`,
      title: formatRoundTitle(displayIndex, bucket.mains, live),
      source: "主 Agent",
      spans: bucket.mains,
      children: bucket.tools,
      failed: bucket.mains.some((span) => span.failed) || bucket.tools.some((branch) => Boolean(branch.failed)),
    });
  }

  const orphanGroups = new Map<string, TrajectorySpan[]>();
  leftover.forEach((span) => {
    const key = span.subId != null ? `sub-${span.subId}` : span.source;
    const group = orphanGroups.get(key) ?? [];
    group.push(span);
    orphanGroups.set(key, group);
  });
  [...orphanGroups.values()].forEach((groupSpans, index) => {
    forest.push(makeOrphanBranch(groupSpans, index));
  });
  return forest;
}

export function findTrajectoryBranch(forest: TrajectoryBranch[], id: string): TrajectoryBranch | undefined {
  for (const branch of forest) {
    if (branch.id === id) return branch;
    const nested = findTrajectoryBranch(branch.children, id);
    if (nested) return nested;
  }
  return undefined;
}

export function buildTrajectoryForest(
  groups: TrajectoryGroup[],
  live: LiveSpanEvent[] = [],
  delegations: DelegationBlock[] = [],
): TrajectoryBranch[] {
  const spans = visibleTrajectorySpans(groups, live);
  const tools = spans.filter(isSubAgentToolSpan);
  const toolIds = new Set(tools.map(toolIdOf));
  for (const block of delegations) {
    const toolId = block.tool_call_id?.trim();
    if (!toolId || toolIds.has(toolId)) continue;
    if (!block.stages?.length && block.sub_id == null) continue;
    tools.push({
      id: `delegation-${toolId}`,
      kind: "tool",
      label: block.tool_name || "sub_agent_tool",
      source: block.sub_id != null ? `子 Agent #${block.sub_id}` : "子 Agent",
      startTs: block.started_at != null ? block.started_at / 1000 : null,
      endTs: block.ended_at != null ? block.ended_at / 1000 : null,
      failed: block.status === "error",
      toolCallId: toolId,
      subId: block.sub_id != null && block.sub_id > 0 ? block.sub_id : undefined,
    });
    toolIds.add(toolId);
  }

  const assigned = new Set<string>();
  const childrenByTool = new Map<string, TrajectorySpan[]>();

  const take = (tool: TrajectorySpan, span: TrajectorySpan) => {
    const toolId = toolIdOf(tool);
    const bucket = childrenByTool.get(toolId) ?? [];
    bucket.push(span);
    childrenByTool.set(toolId, bucket);
    assigned.add(span.id);
  };

  for (const span of spans) {
    if (isSubAgentToolSpan(span) || isMainRootSpan(span)) continue;
    if (!span.parentToolCallId) continue;
    const tool = tools.find((item) => toolIdOf(item) === span.parentToolCallId);
    if (tool) take(tool, span);
  }

  for (const span of spans) {
    if (assigned.has(span.id) || isSubAgentToolSpan(span) || isMainRootSpan(span)) continue;
    if (span.subId == null) continue;
    const tool = pickToolForSubId(span.subId, tools, span, delegations);
    if (tool) take(tool, span);
  }

  const toolBranches = tools.map((tool) => makeToolBranch(tool, childrenByTool.get(toolIdOf(tool)) ?? [], delegations));

  const mainSpans = spans.filter((span) => isMainRootSpan(span) && !assigned.has(span.id));
  const leftover = spans.filter(
    (span) => !assigned.has(span.id) && !isSubAgentToolSpan(span) && !isMainRootSpan(span),
  );

  return assembleRoundForest(mainSpans, tools, toolBranches, leftover);
}
