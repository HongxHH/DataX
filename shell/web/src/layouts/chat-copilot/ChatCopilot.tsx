import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createSession,
  deleteSession,
  fetchTrajectory,
  getSession,
  listSessions,
} from "../../api/rest";
import { sameFsPath } from "../../components/shared/pathUtils";
import { parsePlanTools, type PlanToolItem, type SpanEventData, type ThinkPhase, type ToolEventData } from "../../protocol/events";
import { streamChat } from "../../protocol/streamClient";
import { SessionIdChip, SessionList, SESSIONS_COLLAPSED_KEY } from "../../components/shared/SessionList";
import { IconButton, PanelRightIcon, SidebarIcon, TraceIcon } from "../../components/shared/IconButton";
import { usePersistedToggle } from "../../components/shared/usePersistedToggle";
import { ToolTimeline } from "../../components/shared/ToolTimeline";
import { PromptInventoryControl } from "../../components/chat-copilot/PromptInventoryControl";
import { isMainAgentUsage, parseContextUsage } from "../../components/chat-copilot/contextUsageModel";
import { isMainAgentInventory, parsePromptInventory, upsertSubInventory } from "../../components/chat-copilot/promptInventoryModel";
import { TrajectoryDrawer } from "../../components/chat-copilot/TrajectoryDrawer";
import type { TrajectoryGroup } from "../../components/chat-copilot/trajectoryModel";
import { CopilotMessageList } from "../../components/chat-copilot/CopilotMessageList";
import {
  ARTIFACTS_COLLAPSED_KEY,
  CopilotArtifactsPanel,
  collectSessionArtifacts,
  collectTurnArtifacts,
} from "../../components/chat-copilot/CopilotArtifactsPanel";
import {
  appendDelegationLog,
  appendDelegationThinking,
  applyDelegationArtifact,
  applyDelegationSpan,
  applyDelegationStage,
  applyDelegationToolEvent,
  clipThinkingTail,
  collectVisibleDelegations,
  failOpenDelegations,
  finalizeDelegations,
  isSubAgentTool,
  mapDelegationsFromResult,
  mergeDelegationThinking,
  visibleDelegations,
} from "../../components/chat-copilot/delegationState";
import { humanizeChatError } from "../../components/shared/chatErrors";
import { artifactNodeId, encodeFlowFocus, LIVE_TURN_KEY } from "../../components/chat-copilot/flowModel";
import { PLAN_PREP_LOG_LIMIT, trimPrepLog } from "../../components/chat-copilot/prepLogModel";
import { emptyCopilotLive, liveBundleFromMessages, nextDelegationTurn, type CopilotLiveBundle } from "../../components/chat-copilot/copilotLive";
import type { LayoutProps } from "../../profiles/registry";
import type {
  ChatMessage,
  DelegationBlock,
  SessionSummary,
} from "../../types";
import type { ContextUsageSnapshot, PromptInventorySnapshot } from "../../protocol/events";

const LIVE_SPANS_MAX = 80; // align with shell/backend/session/live_span.py SPANS_MAX

function appendLiveSpan(prev: SpanEventData[], span: SpanEventData): SpanEventData[] {
  const next = [...prev, span];
  return next.length > LIVE_SPANS_MAX ? next.slice(-LIVE_SPANS_MAX) : next;
}

function appendPlanPrepLog(prev: string[], hint: string): string[] {
  const trimmed = hint.trim();
  if (!trimmed) return prev;
  if (prev[prev.length - 1] === trimmed) return prev;
  return trimPrepLog([...prev, trimmed], PLAN_PREP_LOG_LIMIT);
}

export default function ChatCopilot({
  profile,
  healthWarning,
}: LayoutProps) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [streamingThinking, setStreamingThinking] = useState("");
  const [thinkingPhase, setThinkingPhase] = useState<ThinkPhase | null>(null);
  const [planHint, setPlanHint] = useState<string | null>(null);
  const [planStageHint, setPlanStageHint] = useState<string | null>(null);
  const [planPrepLog, setPlanPrepLog] = useState<string[]>([]);
  const [planTools, setPlanTools] = useState<PlanToolItem[]>([]);
  const [toolEvents, setToolEvents] = useState<ToolEventData[]>([]);
  const [activeTurn, setActiveTurn] = useState<ChatMessage | null>(null);
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const [contextUsage, setContextUsage] = useState<ContextUsageSnapshot | null>(null);
  const [promptInventory, setPromptInventory] = useState<PromptInventorySnapshot | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [trajectoryOpen, setTrajectoryOpen] = useState(false);
  const [sessionsCollapsed, toggleSessions] = usePersistedToggle(SESSIONS_COLLAPSED_KEY);
  const [artifactsCollapsed, toggleArtifacts] = usePersistedToggle(ARTIFACTS_COLLAPSED_KEY);
  const [trajectoryGroups, setTrajectoryGroups] = useState<TrajectoryGroup[]>([]);
  const activeTurnRef = useRef<ChatMessage | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const runningIdRef = useRef<string | null>(null);
  const liveMapRef = useRef<Map<string, CopilotLiveBundle>>(new Map());
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  useEffect(() => {
    runningIdRef.current = runningId;
  }, [runningId]);

  useEffect(() => {
    if (!activeId) return;
    liveMapRef.current.set(activeId, {
      messages,
      activeTurn,
      streamingContent,
      streamingThinking,
      thinkingPhase,
      planHint,
      planStageHint,
      planPrepLog,
      planTools,
      toolEvents,
      focusedNodeId,
      contextUsage,
      promptInventory,
    });
  }, [
    activeId,
    messages,
    activeTurn,
    streamingContent,
    streamingThinking,
    thinkingPhase,
    planHint,
    planStageHint,
    planPrepLog,
    planTools,
    toolEvents,
    focusedNodeId,
    contextUsage,
    promptInventory,
  ]);

  const refreshSessions = useCallback(async () => {
    setSessions(await listSessions());
  }, []);

  const hydrateLive = useCallback((bundle: CopilotLiveBundle) => {
    setMessages(bundle.messages);
    setActiveTurn(bundle.activeTurn);
    setStreamingContent(bundle.streamingContent);
    setStreamingThinking(bundle.streamingThinking);
    setThinkingPhase(bundle.thinkingPhase);
    setPlanHint(bundle.planHint);
    setPlanStageHint(bundle.planStageHint);
    setPlanPrepLog(bundle.planPrepLog);
    setPlanTools(bundle.planTools);
    setToolEvents(bundle.toolEvents);
    setFocusedNodeId(bundle.focusedNodeId);
    setContextUsage(bundle.contextUsage);
    setPromptInventory(bundle.promptInventory);
  }, []);

  const applyLive = useCallback(
    (
      sessionId: string,
      patch: Partial<CopilotLiveBundle> | ((prev: CopilotLiveBundle) => CopilotLiveBundle),
    ) => {
      const prev = liveMapRef.current.get(sessionId) ?? emptyCopilotLive();
      const next = typeof patch === "function" ? patch(prev) : { ...prev, ...patch };
      liveMapRef.current.set(sessionId, next);
      if (sessionId === runningIdRef.current) {
        activeTurnRef.current = next.activeTurn;
      }
      if (activeIdRef.current === sessionId) {
        hydrateLive(next);
      }
    },
    [hydrateLive],
  );

  const loadSession = useCallback(async (id: string) => {
    const showCachedRunning = () => {
      const cached = liveMapRef.current.get(id);
      if (cached && runningIdRef.current === id) {
        setActiveId(id);
        hydrateLive(cached);
        return true;
      }
      return false;
    };
    if (showCachedRunning()) return;
    const detail = await getSession(id);
    if (showCachedRunning()) return;
    const fromDisk = liveBundleFromMessages(detail.messages ?? [], {
      resumeLive: runningIdRef.current === id,
      contextUsage: detail.context_usage,
    });
    liveMapRef.current.set(id, fromDisk);
    setActiveId(id);
    hydrateLive(fromDisk);
  }, [hydrateLive]);

  useEffect(() => {
    const bootstrap = async () => {
      const list = await listSessions();
      setSessions(list);
      if (list.length > 0) {
        await loadSession(list[0].id);
      } else {
        const session = await createSession();
        setSessions([
          {
            id: session.id,
            title: session.title,
            preview: session.preview,
            created_at: session.created_at,
            updated_at: session.updated_at,
          },
        ]);
        setActiveId(session.id);
      }
    };
    bootstrap();
  }, [loadSession]);

  const refreshTrajectory = useCallback(async (sessionId: string) => {
    try {
      const groups = await fetchTrajectory(sessionId);
      if (activeIdRef.current === sessionId) {
        setTrajectoryGroups(groups);
      }
    } catch {
      if (activeIdRef.current === sessionId) {
        setTrajectoryGroups([]);
      }
    }
  }, []);

  useEffect(() => {
    if (!activeId) {
      setTrajectoryGroups([]);
      return;
    }
    void refreshTrajectory(activeId);
    if (loading) return;
    if (!trajectoryOpen) return;
    const timer = window.setInterval(() => {
      void refreshTrajectory(activeId);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [activeId, loading, trajectoryOpen, refreshTrajectory]);

  const updateDelegation = useCallback(
    (toolCallId: string, updater: (block: DelegationBlock) => DelegationBlock) => {
      const sid = runningIdRef.current;
      if (!sid) return;
      applyLive(sid, (prev) => {
        const nextTurn = nextDelegationTurn(
          prev.activeTurn,
          toolCallId,
          updater,
        );
        return { ...prev, activeTurn: nextTurn };
      });
    },
    [applyLive],
  );

  const handleNewSession = async () => {
    const session = await createSession();
    await refreshSessions();
    const bundle = emptyCopilotLive();
    liveMapRef.current.set(session.id, bundle);
    setActiveId(session.id);
    setInput("");
    hydrateLive(bundle);
  };

  const handleDeleteSession = async (id: string) => {
    if (runningIdRef.current === id) {
      abortRef.current?.abort();
    }
    await deleteSession(id);
    liveMapRef.current.delete(id);
    const remaining = (await listSessions()).filter((item) => item.id !== id);
    setSessions(remaining);
    if (activeIdRef.current !== id) {
      return;
    }
    if (remaining.length > 0) {
      await loadSession(remaining[0].id);
      return;
    }
    const session = await createSession();
    await refreshSessions();
    const bundle = emptyCopilotLive();
    liveMapRef.current.set(session.id, bundle);
    setActiveId(session.id);
    hydrateLive(bundle);
  };

  const handleCancel = () => {
    abortRef.current?.abort();
  };

  const startCopilotStream = async (sessionId: string, query: string) => {
    setLoading(true);
    setRunningId(sessionId);
    runningIdRef.current = sessionId;
    const turnStarted = Date.now();
    applyLive(sessionId, (prev) => ({
      ...emptyCopilotLive([...prev.messages, { role: "user", content: query }]),
      planStageHint: "正在规划…",
      planPrepLog: ["正在规划…"],
      activeTurn: {
        role: "assistant",
        content: "",
        status: "running",
        delegations: [],
        turn_started_at: turnStarted,
      },
    }));

    let accumulated = "";
    let thinkingAccum = "";
    let lastPlanHint = "";
    let lastPlanTools: PlanToolItem[] = [];
    let lastPrep = ["正在规划…"];
    let lastRewritten = "";
    let lastContextUsage: ContextUsageSnapshot | null = null;
    let lastPromptInventory: PromptInventorySnapshot | null = null;
    let lastSubInventories: Record<string, PromptInventorySnapshot> = {};
    let lastOtelSpans: SpanEventData[] = [];
    abortRef.current?.abort();
    const abortController = new AbortController();
    abortRef.current = abortController;

    let settled = false;
    const finishTurn = (message: ChatMessage) => {
      if (settled) return;
      settled = true;
      const ended = {
        ...message,
        turn_started_at: message.turn_started_at ?? turnStarted,
        turn_ended_at: Date.now(),
        ...(lastContextUsage ? { context_usage: lastContextUsage } : {}),
        ...(lastPromptInventory ? { prompt_inventory: lastPromptInventory } : {}),
        ...(Object.keys(lastSubInventories).length > 0
          ? { sub_prompt_inventories: { ...lastSubInventories } }
          : {}),
      };
      applyLive(sessionId, (prev) => ({
        ...emptyCopilotLive([...prev.messages, ended]),
        contextUsage: lastContextUsage ?? prev.contextUsage,
        promptInventory: lastPromptInventory ?? prev.promptInventory,
      }));
      setLoading(false);
      setRunningId(null);
      runningIdRef.current = null;
    };

    const finishWithError = (content: string) => {
      const delegations = failOpenDelegations(
        visibleDelegations(activeTurnRef.current?.delegations),
      );
      finishTurn({
        role: "assistant",
        content,
        status: "error",
        ...(delegations.length > 0 ? { delegations } : {}),
        ...(lastPrep.length > 0 ? { plan_prep: lastPrep } : {}),
        ...(lastRewritten ? { rewritten_query: lastRewritten } : {}),
        ...(lastOtelSpans.length > 0 ? { otel_spans: lastOtelSpans } : {}),
      });
    };

    try {
      await streamChat(
        sessionId,
        query,
        {
          onStage: (data) => {
            const toolCallId = String(data.tool_call_id ?? "");
            if (toolCallId) {
              updateDelegation(toolCallId, (block) => applyDelegationStage(block, data));
              return;
            }
            const hint = String(data.hint ?? data.label ?? "").trim();
            if (!hint) return;
            lastPrep = appendPlanPrepLog(lastPrep, hint);
            applyLive(sessionId, (prev) => ({
              ...prev,
              planStageHint: hint,
              planPrepLog: lastPrep,
            }));
          },
          onToken: (content) => {
            accumulated += content;
            applyLive(sessionId, (prev) => ({
              ...prev,
              streamingContent: accumulated,
              thinkingPhase: prev.thinkingPhase && prev.thinkingPhase !== "end" ? "end" : prev.thinkingPhase,
            }));
          },
          onThink: (data) => {
            const scope = String(data.scope ?? "main");
            const toolCallId = String(data.tool_call_id ?? "");
            if (scope === "subagent" || (toolCallId && scope !== "main")) {
              if (!toolCallId) return;
              const phase = String(data.phase ?? "delta") as ThinkPhase;
              updateDelegation(toolCallId, (block) => {
                if (phase === "start") {
                  const prev = block.sub_thinking ?? "";
                  return prev ? { ...block, sub_thinking: `${prev}\n\n` } : block;
                }
                if (phase === "delta") {
                  return appendDelegationThinking(block, String(data.content ?? ""));
                }
                return block;
              });
              return;
            }
            const phase = String(data.phase ?? "delta") as ThinkPhase;
            if (phase === "start") {
              if (thinkingAccum) thinkingAccum += "\n\n";
              applyLive(sessionId, (prev) => ({
                ...prev,
                streamingThinking: thinkingAccum,
                thinkingPhase: "start",
              }));
              return;
            }
            if (phase === "delta") {
              const delta = String(data.content ?? "");
              if (delta) {
                thinkingAccum += delta;
              }
              applyLive(sessionId, (prev) => ({
                ...prev,
                streamingThinking: thinkingAccum,
                thinkingPhase: "delta",
              }));
              return;
            }
            if (phase === "end") {
              applyLive(sessionId, (prev) => ({ ...prev, thinkingPhase: "end" }));
            }
          },
          onPlan: (data) => {
            const scope = String(data.scope ?? "main");
            if (scope && scope !== "main") return;
            const hint = String(data.hint ?? "");
            if (hint) {
              lastPlanHint = hint;
            }
            const tools = parsePlanTools(data.tools);
            if (tools.length > 0) {
              lastPlanTools = tools;
            }
            applyLive(sessionId, (prev) => ({
              ...prev,
              ...(hint ? { planHint: hint } : {}),
              planTools: tools.length > 0 ? tools : prev.planTools,
            }));
          },
          onTool: (data) => {
            const toolName = String(data.tool_name ?? "");
            if (!isSubAgentTool(toolName)) {
              applyLive(sessionId, (prev) => ({
                ...prev,
                toolEvents: [...prev.toolEvents, data as ToolEventData],
              }));
              return;
            }
            const toolCallId = String(data.tool_call_id ?? "");
            if (!toolCallId) return;
            updateDelegation(toolCallId, (block) => applyDelegationToolEvent(block, data));
          },
          onArtifact: (data) => {
            const toolCallId = String(data.tool_call_id ?? "");
            if (!toolCallId) return;
            updateDelegation(toolCallId, (block) => applyDelegationArtifact(block, data));
          },
          onLog: (message, data) => {
            const toolCallId = String(data.tool_call_id ?? "");
            if (!toolCallId) return;
            const level = (data.level as "info" | "stage" | "error") ?? "info";
            updateDelegation(toolCallId, (block) =>
              appendDelegationLog(block, message, level),
            );
          },
          onContext: (data) => {
            const rewritten = String(data.rewritten ?? "").trim();
            const raw = String(data.raw ?? "").trim();
            if (!rewritten || rewritten === raw) return;
            lastRewritten = rewritten;
            lastPrep = appendPlanPrepLog(lastPrep, `问句已改写为 ${rewritten}`);
            applyLive(sessionId, (prev) => ({
              ...prev,
              planPrepLog: lastPrep,
            }));
          },
          onContextUsage: (data) => {
            const parsed = parseContextUsage(data);
            if (!parsed || !isMainAgentUsage(parsed)) return;
            lastContextUsage = parsed;
            applyLive(sessionId, (prev) => ({ ...prev, contextUsage: parsed }));
            setSessions((prev) =>
              prev.map((item) => (item.id === sessionId ? { ...item, context_usage: parsed } : item)),
            );
          },
          onPromptInventory: (data) => {
            const parsed = parsePromptInventory(data);
            if (!parsed) return;
            if (isMainAgentInventory(parsed)) {
              lastPromptInventory = parsed;
              applyLive(sessionId, (prev) => ({
                ...prev,
                promptInventory: parsed,
                activeTurn: prev.activeTurn
                  ? { ...prev.activeTurn, prompt_inventory: parsed }
                  : prev.activeTurn,
              }));
              return;
            }
            lastSubInventories = upsertSubInventory(lastSubInventories, parsed);
            applyLive(sessionId, (prev) => ({
              ...prev,
              activeTurn: prev.activeTurn
                ? {
                  ...prev.activeTurn,
                  sub_prompt_inventories: upsertSubInventory(
                    prev.activeTurn.sub_prompt_inventories ?? {},
                    parsed,
                  ),
                }
                : prev.activeTurn,
            }));
          },
          onSpan: (data) => {
            const span = data as SpanEventData;
            lastOtelSpans = appendLiveSpan(lastOtelSpans, span);
            const toolCallId = String(span.tool_call_id || span.parent_tool_call_id || "");
            applyLive(sessionId, (prev) => {
              const nextTurn = toolCallId
                ? nextDelegationTurn(prev.activeTurn, toolCallId, (block) => applyDelegationSpan(block, span))
                : prev.activeTurn;
              if (!nextTurn) return prev;
              return {
                ...prev,
                activeTurn: {
                  ...nextTurn,
                  otel_spans: appendLiveSpan(nextTurn.otel_spans ?? [], span),
                },
              };
            });
          },
          onResult: (data) => {
            const finalText = accumulated || String(data.message ?? "完成");
            const fromResult = mapDelegationsFromResult(data.delegations);
            const liveDelegations = visibleDelegations(activeTurnRef.current?.delegations);
            const delegationsForMessage = mergeDelegationThinking(
              finalizeDelegations(visibleDelegations(fromResult ?? liveDelegations)),
              liveDelegations,
            );
            finishTurn({
              role: "assistant",
              content: finalText,
              delegations: delegationsForMessage,
              status: "done",
              ...(thinkingAccum ? { main_thinking: clipThinkingTail(thinkingAccum) } : {}),
              ...(lastPlanHint ? { plan_hint: lastPlanHint } : {}),
              ...(lastPlanTools.length > 0 ? { plan_tools: lastPlanTools } : {}),
              ...(lastPrep.length > 0 ? { plan_prep: lastPrep } : {}),
              ...(lastRewritten ? { rewritten_query: lastRewritten } : {}),
              ...(lastOtelSpans.length > 0 ? { otel_spans: lastOtelSpans } : {}),
            });
          },
          onError: (msg) => {
            finishWithError(humanizeChatError(msg));
          },
        },
        abortController.signal,
      );
      if (!settled) {
        finishWithError(humanizeChatError("未收到最终结果"));
      }
      await refreshSessions();
    } catch (err) {
      const isAbort = err instanceof DOMException && err.name === "AbortError";
      const raw = err instanceof Error ? err.message : String(err);
      finishWithError(humanizeChatError(raw, isAbort));
    } finally {
      if (abortRef.current === abortController) {
        abortRef.current = null;
        setLoading(false);
        setRunningId(null);
        runningIdRef.current = null;
      }
    }
  };

  const handleSubmit = async () => {
    if (!input.trim() || loading) return;

    let sessionId = activeId;
    if (!sessionId) {
      const session = await createSession();
      sessionId = session.id;
      setActiveId(sessionId);
      await refreshSessions();
    }

    const query = input.trim();
    setInput("");
    await startCopilotStream(sessionId, query);
  };

  const handlePickPrompt = useCallback(
    (text: string) => {
      if (loading) return;
      setInput(text);
      window.requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        const end = text.length;
        el.setSelectionRange(end, end);
      });
    },
    [loading],
  );

  const artifactItems = useMemo(
    () => [
      ...collectSessionArtifacts(messages),
      ...collectTurnArtifacts(visibleDelegations(activeTurn?.delegations), LIVE_TURN_KEY),
    ],
    [messages, activeTurn],
  );

  const handleOpenPath = useCallback(
    (path: string) => {
      const match = artifactItems.find((item) => item.path && sameFsPath(item.path, path));
      if (match) setFocusedNodeId(encodeFlowFocus(match.turnKey ?? LIVE_TURN_KEY, artifactNodeId(match.toolCallId)));
    },
    [artifactItems],
  );

  const activeTitle = sessions.find((session) => session.id === activeId)?.title || "新对话";

  return (
    <>
      <header className="topbar">
        <IconButton
          label={sessionsCollapsed ? "展开会话" : "收起会话"}
          active={!sessionsCollapsed}
          aria-pressed={!sessionsCollapsed}
          onClick={toggleSessions}
        >
          <SidebarIcon />
        </IconButton>
        <div className="brand"><span className="brand-mark" />DataX</div>
        <div className="topbar-actions">
          {healthWarning && <div className="health-warning">{healthWarning}</div>}
          <IconButton
            label="运行轨迹"
            active={trajectoryOpen}
            aria-pressed={trajectoryOpen}
            onClick={() => setTrajectoryOpen((open) => !open)}
          >
            <TraceIcon />
          </IconButton>
          <IconButton
            label={artifactsCollapsed ? "展开产物" : "收起产物"}
            active={!artifactsCollapsed}
            aria-pressed={!artifactsCollapsed}
            onClick={toggleArtifacts}
          >
            <PanelRightIcon />
          </IconButton>
        </div>
      </header>
      <main className="workspace chat-copilot-workspace">
        <SessionList
          sessions={sessions}
          activeId={activeId}
          runningId={runningId}
          onSelect={loadSession}
          onNew={handleNewSession}
          onDelete={handleDeleteSession}
          collapsed={sessionsCollapsed}
          onToggleCollapsed={toggleSessions}
        />
        <section className="panel chat-panel chat-copilot-main">
          <div className="panel-header">
            <h2>{activeTitle}</h2>
            <div className="panel-header-meta">
              {activeId ? <SessionIdChip sessionId={activeId} /> : null}
              <PromptInventoryControl
                usage={contextUsage}
                packed={promptInventory}
                messages={messages}
                activeTurn={activeTurn}
                liveDelegations={collectVisibleDelegations(messages, activeTurn)}
                livePrepLog={planPrepLog}
                livePlanTools={planTools}
                live={loading && runningId === activeId}
              />
              {loading && runningId === activeId ? (
                <>
                  <span className="badge">正在生成…</span>
                  <button type="button" className="btn-stop" onClick={handleCancel}>
                    停止
                  </button>
                </>
              ) : null}
            </div>
          </div>
          <TrajectoryDrawer
            open={trajectoryOpen}
            groups={trajectoryGroups}
            liveSpans={activeTurn?.otel_spans ?? messages.at(-1)?.otel_spans ?? []}
            delegations={collectVisibleDelegations(messages, activeTurn)}
            loading={loading && runningId === activeId}
            onClose={() => setTrajectoryOpen(false)}
          />
          <CopilotMessageList
            messages={messages}
            activeTurn={activeTurn}
            streamingContent={streamingContent}
            streamingThinking={streamingThinking}
            thinkingPhase={thinkingPhase}
            stageHint={planStageHint}
            prepLog={planPrepLog}
            planHint={planHint}
            planTools={planTools}
            profileId={profile.id}
            sessionId={activeId}
            selectedNodeId={focusedNodeId}
            onSelectNode={setFocusedNodeId}
            onOpenPath={handleOpenPath}
            onPickPrompt={handlePickPrompt}
            turnRunning={loading && runningId === activeId}
            trajectoryGroups={trajectoryGroups}
          />
          {toolEvents.length > 0 && (
            <details className="tool-timeline-panel tool-timeline-collapsible">
              <summary>
                其他工具调用 ({toolEvents.length})
                {toolEvents.some((e) => String(e.status ?? "").includes("error")) && (
                  <span className="tool-timeline-fail-hint">含失败项</span>
                )}
              </summary>
              <ToolTimeline events={toolEvents} />
            </details>
          )}
          <div className="chat-input-area">
            <div className="chat-composer">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="输入问题，Enter 发送"
                rows={3}
                disabled={loading}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    if (!loading && input.trim()) handleSubmit();
                  }
                }}
              />
              <div className="chat-composer-actions">
                {loading ? (
                  <button
                    type="button"
                    className="btn-stop"
                    onClick={handleCancel}
                  >
                    停止
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn-primary"
                  disabled={loading || !input.trim()}
                  onClick={handleSubmit}
                >
                  发送
                </button>
              </div>
            </div>
          </div>
        </section>
        <CopilotArtifactsPanel
          sessionId={activeId}
          selectedNodeId={focusedNodeId}
          onSelectNode={setFocusedNodeId}
          items={artifactItems}
          collapsed={artifactsCollapsed}
          onToggleCollapsed={toggleArtifacts}
        />
      </main>
    </>
  );
}
