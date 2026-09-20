import type { ContextUsageSnapshot, PlanToolItem, ThinkPhase, ToolEventData } from "../../protocol/events";
import type { ChatMessage, DelegationBlock } from "../../types";
import { isMainAgentUsage } from "./contextUsageModel";
import { stampRunning } from "./delegationState";

export interface CopilotLiveBundle {
  messages: ChatMessage[];
  activeTurn: ChatMessage | null;
  streamingContent: string;
  streamingThinking: string;
  thinkingPhase: ThinkPhase | null;
  planHint: string | null;
  planStageHint: string | null;
  planPrepLog: string[];
  planTools: PlanToolItem[];
  toolEvents: ToolEventData[];
  focusedNodeId: string | null;
  contextUsage: ContextUsageSnapshot | null;
}

export const RUNNING_ASSISTANT_PLACEHOLDER = "处理中…";
export const INTERRUPTED_ASSISTANT_CONTENT = "上次回答已中断，没有生成结论。请重新提问。";

export function sealInterruptedAssistant(msg: ChatMessage): ChatMessage {
  if (msg.role !== "assistant" || msg.status !== "running") return msg;
  const placeholder = !msg.content?.trim() || msg.content === RUNNING_ASSISTANT_PLACEHOLDER;
  return {
    ...msg,
    status: "error",
    content: placeholder ? INTERRUPTED_ASSISTANT_CONTENT : msg.content,
  };
}

export function emptyCopilotLive(messages: ChatMessage[] = []): CopilotLiveBundle {
  return {
    messages,
    activeTurn: null,
    streamingContent: "",
    streamingThinking: "",
    thinkingPhase: null,
    planHint: null,
    planStageHint: null,
    planPrepLog: [],
    planTools: [],
    toolEvents: [],
    focusedNodeId: null,
    contextUsage: null,
  };
}

/** Latest main-agent occupancy: session root first, then last assistant turn. */
export function contextUsageOfSession(
  messages: ChatMessage[],
  sessionUsage?: ContextUsageSnapshot | null,
): ContextUsageSnapshot | null {
  if (sessionUsage && sessionUsage.used_input_tokens != null) return sessionUsage;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const usage = messages[i]?.context_usage;
    if (usage && usage.used_input_tokens != null && isMainAgentUsage(usage)) {
      return usage;
    }
  }
  return null;
}

export function liveBundleFromMessages(
  messages: ChatMessage[],
  options?: { resumeLive?: boolean; contextUsage?: ContextUsageSnapshot | null },
): CopilotLiveBundle {
  const last = messages.at(-1);
  if (
    options?.resumeLive &&
    last?.role === "assistant" &&
    last.status === "running"
  ) {
    const prior = messages.slice(0, -1);
    const thinking = last.main_thinking || last.thinking || "";
    return {
      ...emptyCopilotLive(prior),
      activeTurn: last,
      streamingContent: last.content && last.content !== RUNNING_ASSISTANT_PLACEHOLDER ? last.content : "",
      streamingThinking: thinking,
      thinkingPhase: thinking ? "delta" : null,
      planHint: last.plan_hint ?? null,
      planTools: last.plan_tools ?? [],
      planPrepLog: last.plan_prep ?? [],
      contextUsage: contextUsageOfSession(messages, options?.contextUsage),
    };
  }
  const sealed = messages.map(sealInterruptedAssistant);
  return {
    ...emptyCopilotLive(sealed),
    contextUsage: contextUsageOfSession(sealed, options?.contextUsage),
  };
}

export function nextDelegationTurn(
  prev: ChatMessage | null,
  toolCallId: string,
  updater: (block: DelegationBlock) => DelegationBlock,
  pendingId?: string,
): ChatMessage {
  const base: ChatMessage = prev ?? {
    role: "assistant",
    content: "",
    status: "running",
    delegations: [],
  };
  const delegations = base.delegations ?? [];
  let idx = delegations.findIndex((d) => d.tool_call_id === toolCallId);
  if (idx < 0 && pendingId && toolCallId !== pendingId) {
    idx = delegations.findIndex(
      (d) => d.tool_call_id === pendingId && d.status !== "done" && d.status !== "error",
    );
  }
  const current =
    idx >= 0
      ? { ...delegations[idx], tool_call_id: toolCallId || delegations[idx].tool_call_id }
      : stampRunning({
        tool_call_id: toolCallId,
        status: "running",
      });
  const updated = updater(current);
  const nextDelegations =
    idx >= 0 ? delegations.map((d, i) => (i === idx ? updated : d)) : [...delegations, updated];
  return { ...base, delegations: nextDelegations };
}
