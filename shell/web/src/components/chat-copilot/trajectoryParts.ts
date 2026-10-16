import type { ContextUsageSnapshot, PlanToolItem, PromptInventorySnapshot } from "../../protocol/events";
import type { ChatMessage, DelegationBlock } from "../../types";
import {
  isMainAgentUsage,
  USAGE_PART_LABELS,
  type UsagePartKey,
  type UsagePartShare,
  usagePartShares,
} from "./contextUsageModel";
import {
  buildPromptInventory,
  isMainAgentInventory,
  shouldShowAssembly,
  type PromptInventory,
} from "./promptInventoryModel";
import type { PromptMessage, TrajectoryBranch, TrajectorySpan } from "./trajectoryModel";
import { isRoundBranch } from "./trajectoryModel";

/** Matches trajectoryModel LIVE_ROUND_KEY / round:_live. */
export const LIVE_ROUND_BRANCH_ID = "round:_live";

/** Ordered main-agent context_usage snapshots, one slot per assistant turn. */
export function collectMainRoundUsages(messages: ChatMessage[]): Array<ContextUsageSnapshot | null> {
  return collectMainAssistantTurns(messages).map((message) => {
    const usage = message.context_usage;
    return usage && isMainAgentUsage(usage) ? usage : null;
  });
}

/** Assistant turns in session order (one trajectory round slot each). */
export function collectMainAssistantTurns(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((message) => message.role === "assistant");
}

/**
 * Resolve usage for a forest branch: live → liveUsage; sealed rounds → ordinal into roundUsages.
 */
export function usageForRoundBranch(
  branch: TrajectoryBranch,
  sealedOrdinal: number,
  roundUsages: Array<ContextUsageSnapshot | null | undefined>,
  liveUsage?: ContextUsageSnapshot | null,
): ContextUsageSnapshot | null {
  if (!isRoundBranch(branch)) return null;
  if (branch.id === LIVE_ROUND_BRANCH_ID) {
    return liveUsage && isMainAgentUsage(liveUsage) ? liveUsage : null;
  }
  const usage = roundUsages[sealedOrdinal];
  return usage && isMainAgentUsage(usage) ? usage : null;
}

export function assistantTurnForRoundBranch(
  branch: TrajectoryBranch,
  sealedOrdinal: number,
  turns: ChatMessage[],
): ChatMessage | null {
  if (!isRoundBranch(branch) || branch.id === LIVE_ROUND_BRANCH_ID) return null;
  return turns[sealedOrdinal] ?? null;
}

/** Prefer timestamp window on the assistant turn; fall back to round-branch usage. */
export function contextUsageForLlmSpan(
  span: TrajectorySpan,
  messages: ChatMessage[],
  roundUsage: ContextUsageSnapshot | null | undefined,
  liveUsage?: ContextUsageSnapshot | null,
): ContextUsageSnapshot | null {
  if (span.kind !== "llm") return null;
  if (span.subId != null && span.subId > 0) return null;

  const byTime = messageByTurnTimestamp(span.startTs, messages);
  if (byTime?.context_usage && isMainAgentUsage(byTime.context_usage)) {
    return byTime.context_usage;
  }

  if (span.roundKey == null || span.roundKey === "_live" || span.id.startsWith("live-")) {
    return liveUsage && isMainAgentUsage(liveUsage) ? liveUsage : roundUsage ?? null;
  }
  return roundUsage ?? null;
}

export function assistantMessageForLlmSpan(
  span: TrajectorySpan,
  messages: ChatMessage[],
  roundMessage: ChatMessage | null | undefined,
): ChatMessage | null {
  if (span.kind !== "llm") return null;
  if (span.subId != null && span.subId > 0) return null;
  const byTime = messageByTurnTimestamp(span.startTs, messages);
  if (byTime) return byTime;
  if (span.roundKey == null || span.roundKey === "_live" || span.id.startsWith("live-")) {
    return null;
  }
  return roundMessage ?? null;
}

export interface TrajectoryLiveAssemblyInput {
  usage?: ContextUsageSnapshot | null;
  packed?: PromptInventorySnapshot | null;
  delegations?: DelegationBlock[];
  planTools?: PlanToolItem[];
  prepLog?: string[];
  rewrittenQuery?: string | null;
  live?: boolean;
}

/** Build the assembly inventory for a main-agent LLM span (null when nothing to show). */
export function buildTrajectorySpanAssembly(
  span: TrajectorySpan,
  messages: ChatMessage[],
  roundMessage: ChatMessage | null | undefined,
  live: TrajectoryLiveAssemblyInput = {},
): PromptInventory | null {
  if (span.kind !== "llm") return null;
  if (span.subId != null && span.subId > 0) return null;

  const turn = assistantMessageForLlmSpan(span, messages, roundMessage);
  const isLiveSpan = span.roundKey == null || span.roundKey === "_live" || span.id.startsWith("live-");
  const usage =
    (turn?.context_usage && isMainAgentUsage(turn.context_usage) ? turn.context_usage : null) ??
    contextUsageForLlmSpan(span, messages, turn?.context_usage, live.usage);

  const packedFromTurn =
    turn?.prompt_inventory && isMainAgentInventory(turn.prompt_inventory) ? turn.prompt_inventory : null;
  const packed =
    packedFromTurn ??
    (isLiveSpan && live.packed && isMainAgentInventory(live.packed) ? live.packed : null);

  const delegations = turn?.delegations?.length
    ? turn.delegations
    : isLiveSpan
      ? (live.delegations ?? [])
      : [];
  const planTools = turn?.plan_tools?.length
    ? turn.plan_tools
    : isLiveSpan
      ? (live.planTools ?? [])
      : [];
  const prepLog = turn?.plan_prep?.length
    ? turn.plan_prep
    : isLiveSpan
      ? (live.prepLog ?? [])
      : [];
  const rewrittenQuery = turn?.rewritten_query ?? (isLiveSpan ? live.rewrittenQuery : null) ?? null;

  if (!usage && !packed && delegations.length === 0 && prepLog.length === 0 && !rewrittenQuery) {
    return null;
  }

  const inventory = buildPromptInventory({
    usage,
    packed,
    delegations,
    planTools,
    messages,
    activeTurn: turn,
    live: Boolean(live.live && isLiveSpan),
    prepLog,
    rewrittenQuery,
  });
  // Trajectory also surfaces occupancy parts/history even when packed inventory is absent.
  if (shouldShowAssembly(inventory, "main")) return inventory;
  if (inventory.parts && inventory.parts.length > 0) return inventory;
  if (inventory.history) return inventory;
  return null;
}

function messageByTurnTimestamp(ts: number | null, messages: ChatMessage[]): ChatMessage | null {
  if (ts == null || !Number.isFinite(ts)) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    const start = message.turn_started_at;
    if (start == null || !Number.isFinite(start)) continue;
    if (ts < start) continue;
    const end = message.turn_ended_at;
    if (end != null && Number.isFinite(end) && ts > end + 2) continue;
    return message;
  }
  return null;
}

export function partsSharesForUsage(usage: ContextUsageSnapshot | null | undefined): UsagePartShare[] | null {
  if (!usage) return null;
  return usagePartShares(usage);
}

/**
 * Map a prompt message to the same bucket the kernel uses for context_usage.parts.
 * tool → other (skipped in approx, absorbed in residual); last user/human → user.
 */
export function promptMessagePartBucket(
  role: string,
  index: number,
  messages: PromptMessage[],
): UsagePartKey {
  const key = role.toLowerCase();
  if (key === "system") return "system";
  if (key === "tool") return "other";
  if (key === "assistant") return "history";
  if (key === "user" || key === "human") {
    return index === lastUserMessageIndex(messages) ? "user" : "history";
  }
  return "other";
}

export function partBucketLabel(key: UsagePartKey): string {
  const hit = USAGE_PART_LABELS.find(([part]) => part === key);
  return hit ? hit[1] : key;
}

function lastUserMessageIndex(messages: PromptMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const role = messages[i].role.toLowerCase();
    if (role === "user" || role === "human") return i;
  }
  return -1;
}
