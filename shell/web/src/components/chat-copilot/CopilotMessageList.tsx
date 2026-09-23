import type { PlanToolItem, ThinkPhase } from "../../protocol/events";
import type { ChatMessage } from "../../types";
import { CopyTextButton } from "../shared/CopyTextButton";
import { CopilotEmptyState } from "./CopilotEmptyState";
import { CopilotFlowGraph } from "./CopilotFlowGraph";
import { CopilotTurnSummary } from "./CopilotTurnSummary";
import { visibleDelegations } from "./delegationState";
import { flowFocusForTurn, LIVE_TURN_KEY, messageTurnKey } from "./flowModel";
import { isCancelMessage } from "../shared/chatErrors";
import type { TrajectoryGroup } from "./trajectoryModel";

interface CopilotMessageListProps {
  messages: ChatMessage[];
  activeTurn?: ChatMessage | null;
  streamingContent?: string;
  streamingThinking?: string;
  thinkingPhase?: ThinkPhase | null;
  stageHint?: string | null;
  prepLog?: string[];
  planHint?: string | null;
  planTools?: PlanToolItem[];
  profileId?: string | null;
  sessionId?: string | null;
  selectedNodeId?: string | null;
  onSelectNode?: (id: string | null) => void;
  onOpenPath?: (path: string) => void;
  onPickPrompt?: (text: string) => void;
  turnRunning?: boolean;
  trajectoryGroups?: TrajectoryGroup[];
}

function hasFlowMeta(msg: ChatMessage): boolean {
  return Boolean(
    msg.plan_hint || msg.main_thinking || visibleDelegations(msg.delegations).length || msg.plan_prep?.length,
  );
}

export function CopilotMessageList({
  messages,
  activeTurn,
  streamingContent,
  streamingThinking,
  thinkingPhase,
  stageHint,
  prepLog,
  planHint,
  planTools,
  profileId,
  sessionId,
  selectedNodeId,
  onSelectNode,
  onOpenPath,
  onPickPrompt,
  turnRunning = false,
  trajectoryGroups = [],
}: CopilotMessageListProps) {
  const showActive =
    turnRunning &&
    (Boolean(activeTurn) ||
      Boolean(streamingContent) ||
      Boolean(thinkingPhase) ||
      Boolean(planHint) ||
      Boolean(stageHint) ||
      (prepLog?.length ?? 0) > 0 ||
      (planTools?.length ?? 0) > 0);

  return (
    <div className="messages copilot-messages">
      {messages.length === 0 && !showActive && (
        <CopilotEmptyState
          profileId={profileId}
          disabled={turnRunning}
          onPickPrompt={onPickPrompt}
        />
      )}

      {messages.map((msg, idx) => {
        if (msg.role === "user") {
          const question = msg.content.trim();
          return (
            <div key={idx} className="message user">
              <div className="message-role">你</div>
              <div className="message-content">{msg.content}</div>
              {question ? (
                <CopyTextButton
                  className="message-copy"
                  text={question}
                  idleLabel="复制问题"
                  copiedLabel="已复制问题"
                />
              ) : null}
            </div>
          );
        }

        return (
          <div key={idx} className="message assistant copilot-turn">
            <div className="message-role-row">
              <span className="message-role">助手</span>
              {msg.status === "error" && (
                <span className="turn-badge error">{isCancelMessage(msg.content) ? "已取消" : "失败"}</span>
              )}
            </div>

            {hasFlowMeta(msg) && (
              <CopilotFlowGraph
                thinking={msg.main_thinking}
                planHint={msg.plan_hint}
                planTools={msg.plan_tools}
                prepLog={msg.plan_prep}
                delegations={visibleDelegations(msg.delegations)}
                hasAnswer={Boolean(msg.content)}
                turnRunning={false}
                turnStartedAt={msg.turn_started_at}
                sessionId={sessionId}
                {...flowFocusForTurn(selectedNodeId, messageTurnKey(idx), onSelectNode)}
                liveSpans={msg.otel_spans}
                trajectoryGroups={trajectoryGroups}
                promptInventory={msg.prompt_inventory}
                subInventories={msg.sub_prompt_inventories}
              />
            )}

            {msg.content && (
              <CopilotTurnSummary
                content={msg.content}
                className={msg.status === "error" ? "message-content turn-error" : undefined}
                sessionId={sessionId}
                onOpenPath={onOpenPath}
              />
            )}
          </div>
        );
      })}

      {showActive && (
        <div className="message assistant copilot-turn active">
          <div className="message-role-row">
            <span className="message-role">助手</span>
            <span className="turn-badge running">处理中</span>
          </div>

          <CopilotFlowGraph
            thinking={streamingThinking}
            thinkingPhase={thinkingPhase}
            stageHint={stageHint}
            prepLog={prepLog}
            planHint={planHint}
            planTools={planTools}
            delegations={visibleDelegations(activeTurn?.delegations)}
            hasAnswer={Boolean(streamingContent)}
            turnRunning={turnRunning}
            turnStartedAt={activeTurn?.turn_started_at}
            sessionId={sessionId}
            {...flowFocusForTurn(selectedNodeId, LIVE_TURN_KEY, onSelectNode)}
            liveSpans={activeTurn?.otel_spans}
            trajectoryGroups={trajectoryGroups}
            promptInventory={activeTurn?.prompt_inventory}
            subInventories={activeTurn?.sub_prompt_inventories}
          />

          {streamingContent && (
            <CopilotTurnSummary
              content={streamingContent}
              className={`message-content streaming${activeTurn?.status === "error" ? " turn-error" : ""}`}
              sessionId={sessionId}
              onOpenPath={onOpenPath}
            />
          )}
        </div>
      )}
    </div>
  );
}
