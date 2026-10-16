import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { fetchTrajectoryPrompt } from "../../api/rest";
import type { ContextUsageSnapshot, PlanToolItem, PromptInventorySnapshot } from "../../protocol/events";
import type { ChatMessage, DelegationBlock } from "../../types";
import { AssemblyPanel } from "./AssemblyPanel";
import type {
  PromptMessage,
  TrajectoryBranch,
  TrajectoryGroup,
  TrajectorySessionSummary,
  TrajectorySpan,
  LiveSpanEvent,
} from "./trajectoryModel";
import {
  buildTrajectoryForest,
  crossSessionMemoriesPromptIndex,
  defaultOpenPromptIndex,
  formatSpanDuration,
  formatTokenTotal,
  isRoundBranch,
  promptMessagesFromSpan,
  spanIsRunning,
  spanKindLabel,
  spanModelDetail,
  spanShortLabel,
  summarizeTrajectoryForest,
} from "./trajectoryModel";
import {
  assistantTurnForRoundBranch,
  buildTrajectorySpanAssembly,
  collectMainAssistantTurns,
  collectMainRoundUsages,
  partBucketLabel,
  promptMessagePartBucket,
  usageForRoundBranch,
  type TrajectoryLiveAssemblyInput,
} from "./trajectoryParts";
import { extractCrossSessionMemories, firstPackedSessionId } from "./memoryDeskModel";

function formatClock(ts: number | null): string {
  if (ts == null || !Number.isFinite(ts)) return "—";
  const date = new Date(ts * 1000);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString();
}

function formatSpanUsage(usage: { input_tokens?: number; output_tokens?: number }): string {
  return `输入 ${usage.input_tokens ?? 0} · 输出 ${usage.output_tokens ?? 0}`;
}

function copyText(text: string, event?: { preventDefault(): void; stopPropagation(): void }): void {
  event?.preventDefault();
  event?.stopPropagation();
  if (!text) return;
  void navigator.clipboard.writeText(text);
}

function compactPreview(text: string, max = 96): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (!oneLine) return "";
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

interface TrajectoryDrawerProps {
  open: boolean;
  groups: TrajectoryGroup[];
  liveSpans?: LiveSpanEvent[];
  delegations?: DelegationBlock[];
  messages?: ChatMessage[];
  liveUsage?: ContextUsageSnapshot | null;
  livePacked?: PromptInventorySnapshot | null;
  livePlanTools?: PlanToolItem[];
  livePrepLog?: string[];
  liveRewrittenQuery?: string | null;
  live?: boolean;
  loading?: boolean;
  sessionId?: string | null;
  revealRecallNonce?: number;
  onOpenMemoryDesk?: (sessionId?: string) => void;
  onClose: () => void;
}

function lastRoundLlmTarget(forest: TrajectoryBranch[]): { roundId: string | null; spanId: string | null } {
  for (let i = forest.length - 1; i >= 0; i -= 1) {
    const branch = forest[i];
    if (!isRoundBranch(branch)) continue;
    for (let j = branch.spans.length - 1; j >= 0; j -= 1) {
      if (branch.spans[j].kind === "llm") {
        return { roundId: branch.id, spanId: branch.spans[j].id };
      }
    }
    return { roundId: branch.id, spanId: null };
  }
  return { roundId: null, spanId: null };
}

const TrajectoryRecallNav = createContext<{
  revealNonce: number;
  autoRevealSpanId: string | null;
  forceOpenRoundId: string | null;
  onOpenMemoryDesk?: (sessionId?: string) => void;
}>({ revealNonce: 0, autoRevealSpanId: null, forceOpenRoundId: null });

export function TrajectoryDrawer({
  open,
  groups,
  liveSpans = [],
  delegations = [],
  messages = [],
  liveUsage = null,
  livePacked = null,
  livePlanTools = [],
  livePrepLog = [],
  liveRewrittenQuery = null,
  live = false,
  loading,
  sessionId,
  revealRecallNonce = 0,
  onOpenMemoryDesk,
  onClose,
}: TrajectoryDrawerProps) {
  const forest = useMemo(
    () => buildTrajectoryForest(groups, liveSpans, delegations),
    [groups, liveSpans, delegations],
  );
  const roundUsages = useMemo(() => collectMainRoundUsages(messages), [messages]);
  const assistantTurns = useMemo(() => collectMainAssistantTurns(messages), [messages]);
  const liveAssembly = useMemo(
    () => ({
      usage: liveUsage,
      packed: livePacked,
      delegations,
      planTools: livePlanTools,
      prepLog: livePrepLog,
      rewrittenQuery: liveRewrittenQuery,
      live,
    }),
    [liveUsage, livePacked, delegations, livePlanTools, livePrepLog, liveRewrittenQuery, live],
  );
  const recallNav = useMemo(() => {
    if (revealRecallNonce <= 0) {
      return {
        revealNonce: 0,
        autoRevealSpanId: null as string | null,
        forceOpenRoundId: null as string | null,
        onOpenMemoryDesk,
      };
    }
    const target = lastRoundLlmTarget(forest);
    return {
      revealNonce: revealRecallNonce,
      autoRevealSpanId: target.spanId,
      forceOpenRoundId: target.roundId,
      onOpenMemoryDesk,
    };
  }, [revealRecallNonce, forest, onOpenMemoryDesk]);
  if (!open) return null;
  const empty = forest.length === 0;
  const summary = empty ? null : summarizeTrajectoryForest(forest);
  let sealedOrdinal = 0;
  return (
    <aside className="trajectory-drawer" aria-label="本会话轨迹">
      <div className="trajectory-drawer-header">
        <h3>本会话轨迹</h3>
        <button type="button" className="sessions-collapse-btn" onClick={onClose}>
          关闭
        </button>
      </div>
      {summary ? <SessionSummaryBar summary={summary} /> : null}
      {empty ? (
        <p className="trajectory-empty">
          {loading ? "轨迹写入中…" : "本会话还没有 llm/tool 轨迹。跑一轮对话后会落在工作区 .otel/。"}
        </p>
      ) : (
        <TrajectoryRecallNav.Provider value={recallNav}>
          <ol className="trajectory-span-list">
            {forest.map((branch, index) => {
              const roundUsage = isRoundBranch(branch)
                ? usageForRoundBranch(branch, sealedOrdinal, roundUsages, liveUsage)
                : null;
              const roundMessage = isRoundBranch(branch)
                ? assistantTurnForRoundBranch(branch, sealedOrdinal, assistantTurns)
                : null;
              if (isRoundBranch(branch) && branch.id !== "round:_live") sealedOrdinal += 1;
              return (
                <BranchView
                  key={branch.id}
                  branch={branch}
                  sessionId={sessionId}
                  messages={messages}
                  roundUsage={roundUsage}
                  roundMessage={roundMessage}
                  liveUsage={liveUsage}
                  liveAssembly={liveAssembly}
                  defaultOpen={shouldOpenRound(forest, index)}
                />
              );
            })}
          </ol>
        </TrajectoryRecallNav.Provider>
      )}
    </aside>
  );
}

function SessionSummaryBar({ summary }: { summary: TrajectorySessionSummary }) {
  const totalTokens = summary.inputTokens + summary.outputTokens;
  const rateTone =
    summary.toolSuccessRate == null
      ? ""
      : summary.toolSuccessRate < 80
        ? " is-danger"
        : summary.toolSuccessRate < 100
          ? " is-warn"
          : "";
  const toolMeta = [
    `${summary.llmCalls} 次 LLM`,
    `${summary.rounds} 轮`,
    summary.toolFailed > 0 ? `${summary.toolFailed} 失败` : null,
    summary.toolRunning > 0 ? `${summary.toolRunning} 进行中` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const rateMeta =
    summary.toolSuccessRate == null
      ? summary.toolRunning > 0
        ? "等待完成"
        : summary.toolCalls === 0
          ? "尚无调用"
          : "—"
      : `${summary.toolSucceeded} / ${summary.toolSucceeded + summary.toolFailed}`;

  return (
    <div className="trajectory-session-summary" aria-label="本会话汇总">
      <div className="trajectory-stat">
        <span className="trajectory-stat-label">Token</span>
        <span className="trajectory-stat-value">{formatTokenTotal(totalTokens)}</span>
        <span className="trajectory-stat-meta">
          入 {summary.inputTokens} · 出 {summary.outputTokens}
        </span>
      </div>
      <div className={`trajectory-stat${summary.toolFailed > 0 ? " is-warn" : ""}`}>
        <span className="trajectory-stat-label">Tool</span>
        <span className="trajectory-stat-value">{summary.toolCalls}</span>
        <span className="trajectory-stat-meta">{toolMeta}</span>
      </div>
      <div className={`trajectory-stat${rateTone}`}>
        <span className="trajectory-stat-label">成功率</span>
        <span className="trajectory-stat-value">
          {summary.toolSuccessRate == null ? "—" : `${summary.toolSuccessRate}%`}
        </span>
        <span className="trajectory-stat-meta">{rateMeta}</span>
      </div>
    </div>
  );
}

function lastRoundIndex(forest: TrajectoryBranch[]): number {
  for (let i = forest.length - 1; i >= 0; i -= 1) {
    if (isRoundBranch(forest[i])) return i;
  }
  return forest.length - 1;
}

/** Prefer a content-heavy round; open all rounds when the session is short. */
function shouldOpenRound(forest: TrajectoryBranch[], index: number): boolean {
  if (!isRoundBranch(forest[index])) return false;
  const roundCount = forest.filter(isRoundBranch).length;
  if (roundCount <= 2) return true;
  return index === preferredOpenIndex(forest);
}

function preferredOpenIndex(forest: TrajectoryBranch[]): number {
  for (let i = forest.length - 1; i >= 0; i -= 1) {
    if (!isRoundBranch(forest[i])) continue;
    const branch = forest[i];
    if (branch.children.length > 0 || branch.spans.length > 1) return i;
  }
  return lastRoundIndex(forest);
}

function branchLacksLlmOrTool(branch: TrajectoryBranch): boolean {
  if (isRoundBranch(branch)) return false;
  const spans = [
    ...branch.spans,
    ...branch.children.flatMap((child) => child.spans),
  ];
  return !spans.some(
    (span) => span.kind === "llm" || span.kind === "tool" || Boolean(span.content || span.result),
  );
}

function BranchView({
  branch,
  defaultOpen,
  sessionId,
  messages,
  roundUsage,
  roundMessage,
  liveUsage,
  liveAssembly,
}: {
  branch: TrajectoryBranch;
  defaultOpen?: boolean;
  sessionId?: string | null;
  messages: ChatMessage[];
  roundUsage: ContextUsageSnapshot | null;
  roundMessage: ChatMessage | null;
  liveUsage?: ContextUsageSnapshot | null;
  liveAssembly: TrajectoryLiveAssemblyInput;
}) {
  if (isRoundBranch(branch)) {
    return (
      <RoundBranchView
        branch={branch}
        defaultOpen={defaultOpen}
        sessionId={sessionId}
        messages={messages}
        roundUsage={roundUsage}
        roundMessage={roundMessage}
        liveUsage={liveUsage}
        liveAssembly={liveAssembly}
      />
    );
  }
  return (
    <li className={branch.failed ? "trajectory-branch is-worker is-failed" : "trajectory-branch is-worker"}>
      <div className="trajectory-branch-title">{branch.title}</div>
      <BranchBody branch={branch} sessionId={sessionId} messages={messages} liveAssembly={liveAssembly} />
    </li>
  );
}

function RoundBranchView({
  branch,
  defaultOpen,
  sessionId,
  messages,
  roundUsage,
  roundMessage,
  liveUsage,
  liveAssembly,
}: {
  branch: TrajectoryBranch;
  defaultOpen?: boolean;
  sessionId?: string | null;
  messages: ChatMessage[];
  roundUsage: ContextUsageSnapshot | null;
  roundMessage: ChatMessage | null;
  liveUsage?: ContextUsageSnapshot | null;
  liveAssembly: TrajectoryLiveAssemblyInput;
}) {
  const nav = useContext(TrajectoryRecallNav);
  const [open, setOpen] = useState(Boolean(defaultOpen));
  useEffect(() => {
    if (nav.forceOpenRoundId === branch.id && nav.revealNonce > 0) setOpen(true);
  }, [nav.forceOpenRoundId, nav.revealNonce, branch.id]);
  return (
    <li className={branch.failed ? "trajectory-branch is-failed" : "trajectory-branch"}>
      <details
        className="trajectory-round"
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary className="trajectory-branch-title">{branch.title}</summary>
        <BranchBody
          branch={branch}
          sessionId={sessionId}
          messages={messages}
          roundUsage={roundUsage}
          roundMessage={roundMessage}
          liveUsage={liveUsage}
          liveAssembly={liveAssembly}
        />
      </details>
    </li>
  );
}

function BranchBody({
  branch,
  sessionId,
  messages = [],
  roundUsage = null,
  roundMessage = null,
  liveUsage = null,
  liveAssembly = {},
}: {
  branch: TrajectoryBranch;
  sessionId?: string | null;
  messages?: ChatMessage[];
  roundUsage?: ContextUsageSnapshot | null;
  roundMessage?: ChatMessage | null;
  liveUsage?: ContextUsageSnapshot | null;
  liveAssembly?: TrajectoryLiveAssemblyInput;
}) {
  const pipelineOnly = branchLacksLlmOrTool(branch);
  const stagesOnly = branch.spans.length > 0 && branch.spans.every((span) => span.kind === "stage");
  return (
    <>
      {branch.spans.length > 0 ? (
        <ol className={stagesOnly ? "trajectory-span-list nested trajectory-pipeline" : "trajectory-span-list nested"}>
          {branch.spans.map((span) => (
            <SpanRow
              key={span.id}
              span={span}
              sessionId={sessionId}
              messages={messages}
              roundUsage={roundUsage}
              roundMessage={roundMessage}
              liveUsage={liveUsage}
              liveAssembly={liveAssembly}
            />
          ))}
        </ol>
      ) : null}
      {pipelineOnly ? (
        <p className="trajectory-span-hint">
          该子 Agent 是流水线，产物在上方流程节点里展开。
        </p>
      ) : null}
      {branch.children.length > 0 ? (
        <ol className="trajectory-span-list nested trajectory-children">
          {branch.children.map((child) => (
            <BranchView
              key={child.id}
              branch={child}
              sessionId={sessionId}
              messages={messages}
              roundUsage={null}
              roundMessage={null}
              liveUsage={liveUsage}
              liveAssembly={liveAssembly}
            />
          ))}
        </ol>
      ) : null}
    </>
  );
}

function SpanRow({
  span,
  sessionId,
  messages,
  roundUsage,
  roundMessage,
  liveUsage,
  liveAssembly,
}: {
  span: TrajectorySpan;
  sessionId?: string | null;
  messages: ChatMessage[];
  roundUsage: ContextUsageSnapshot | null | undefined;
  roundMessage?: ChatMessage | null;
  liveUsage?: ContextUsageSnapshot | null;
  liveAssembly?: TrajectoryLiveAssemblyInput;
}) {
  if (span.kind === "stage") {
    return <StageRow span={span} />;
  }
  const duration = formatSpanDuration(span.startTs, span.endTs);
  const running = spanIsRunning(span);
  return (
    <li className={span.failed ? "trajectory-span is-failed" : "trajectory-span"}>
      <div className="trajectory-span-title">
        <span className="trajectory-kind">{spanKindLabel(span.kind)}</span>
        <span className="trajectory-label">
          {span.kind === "llm" ? spanShortLabel(span.label) : span.label}
        </span>
        {span.failed && <span className="tool-timeline-fail-hint">失败</span>}
        {running && <span className="trajectory-running">进行中</span>}
      </div>
      <div className="trajectory-span-meta">
        <span>{span.source}</span>
        {duration ? <span>{duration}</span> : null}
      </div>
      <SpanDetails
        span={span}
        sessionId={sessionId}
        messages={messages}
        roundUsage={roundUsage}
        roundMessage={roundMessage}
        liveUsage={liveUsage}
        liveAssembly={liveAssembly}
      />
    </li>
  );
}

function StageRow({ span }: { span: TrajectorySpan }) {
  const body = span.content || span.result || "";
  const preview = compactPreview(body);
  return (
    <li className={span.failed ? "trajectory-span is-stage is-failed" : "trajectory-span is-stage"}>
      <details className="trajectory-stage-detail">
        <summary>
          <span className="trajectory-label">{span.label}</span>
          {preview ? <span className="trajectory-preview">{preview}</span> : <span className="trajectory-preview is-empty">无产物摘要</span>}
        </summary>
        <pre className="trajectory-pre">{body || "（空）"}</pre>
      </details>
    </li>
  );
}

function spanDetailMeta(span: TrajectorySpan): string[] {
  const running = spanIsRunning(span);
  const lines: string[] = [];
  if (span.kind === "llm") {
    const model = spanModelDetail(span.label);
    if (model) lines.push(model);
  }
  if (span.startTs != null) {
    const clock =
      span.endTs != null
        ? `${formatClock(span.startTs)} – ${formatClock(span.endTs)}`
        : running
          ? `${formatClock(span.startTs)} 起`
          : formatClock(span.startTs);
    lines.push(clock);
  }
  if (span.usage) lines.push(formatSpanUsage(span.usage));
  return lines;
}

function SpanDetails({
  span,
  sessionId,
  messages = [],
  roundUsage = null,
  roundMessage = null,
  liveUsage = null,
  liveAssembly = {},
}: {
  span: TrajectorySpan;
  sessionId?: string | null;
  messages?: ChatMessage[];
  roundUsage?: ContextUsageSnapshot | null;
  roundMessage?: ChatMessage | null;
  liveUsage?: ContextUsageSnapshot | null;
  liveAssembly?: TrajectoryLiveAssemblyInput;
}) {
  const blocks: Array<{ label: string; body: string }> = [];
  if (span.content) blocks.push({ label: "输出", body: span.content });
  if (span.result) blocks.push({ label: "结果", body: span.result });
  if (span.arguments) blocks.push({ label: "参数", body: span.arguments });
  const promptMessages = promptMessagesFromSpan(span);
  const meta = spanDetailMeta(span);
  const assembly = buildTrajectorySpanAssembly(span, messages, roundMessage, {
    ...liveAssembly,
    usage: liveAssembly.usage ?? liveUsage ?? roundUsage,
  });
  const alignParts = Boolean(assembly?.parts?.length);
  const [revealRecallNonce, setRevealRecallNonce] = useState(0);
  const detailsRef = useRef<HTMLDetailsElement | null>(null);
  const nav = useContext(TrajectoryRecallNav);
  const canRevealRecall =
    assembly?.recall?.status === "hit" && promptMessages.length > 0;
  const packedJumpId = firstPackedSessionId(
    promptMessages.map((item) => extractCrossSessionMemories(item.content)).find((text) => text) ?? "",
  );
  useEffect(() => {
    if (nav.revealNonce <= 0) return;
    if (nav.autoRevealSpanId && span.id !== nav.autoRevealSpanId) return;
    detailsRef.current?.setAttribute("open", "");
    setRevealRecallNonce(nav.revealNonce);
  }, [nav.revealNonce, nav.autoRevealSpanId, span.id]);
  const liveHint =
    blocks.length === 0 && promptMessages.length === 0 && span.kind === "llm"
      ? "实时轨迹不含完整提示词，结束后主 Agent 可从落盘轨迹展开。"
      : null;
  if (
    blocks.length === 0 &&
    promptMessages.length === 0 &&
    meta.length === 0 &&
    !liveHint &&
    !assembly
  ) {
    return null;
  }
  return (
    <details ref={detailsRef} className="trajectory-span-detail">
      <summary>展开</summary>
      {meta.length > 0 ? (
        <div className="trajectory-span-detail-meta">
          {meta.map((line) => (
            <span key={line}>{line}</span>
          ))}
        </div>
      ) : null}
      {liveHint ? <p className="trajectory-span-hint">{liveHint}</p> : null}
      {assembly && (promptMessages.length > 0 || Boolean(liveHint)) ? (
        <div className="trajectory-prompt-parts">
          <AssemblyPanel
            inventory={assembly}
            scope="main"
            heading="本轮装入 Planner"
            compact
            onRevealRecallFull={
              canRevealRecall ? () => setRevealRecallNonce((value) => value + 1) : undefined
            }
            onOpenMemoryDesk={
              nav.onOpenMemoryDesk
                ? (sessionId) => nav.onOpenMemoryDesk?.(sessionId ?? packedJumpId)
                : undefined
            }
          />
        </div>
      ) : null}
      {promptMessages.length > 0 ? (
        <PromptMessageList
          messages={promptMessages}
          truncated={Boolean(span.promptTruncated)}
          sessionId={sessionId}
          promptFile={span.promptFile}
          promptChunkIndex={span.promptChunkIndex}
          promptEventIndex={span.promptEventIndex}
          alignParts={alignParts}
          revealCrossSessionMemoriesNonce={revealRecallNonce}
        />
      ) : null}
      {blocks.map((block) => (
        <pre key={block.label} className="trajectory-pre">
          <span className="trajectory-span-label">{block.label}</span>
          {block.body}
        </pre>
      ))}
    </details>
  );
}

function PromptMessageList({
  messages,
  truncated,
  sessionId,
  promptFile,
  promptChunkIndex,
  promptEventIndex,
  alignParts = false,
  revealCrossSessionMemoriesNonce = 0,
}: {
  messages: PromptMessage[];
  truncated: boolean;
  sessionId?: string | null;
  promptFile?: string;
  promptChunkIndex?: number;
  promptEventIndex?: number;
  alignParts?: boolean;
  revealCrossSessionMemoriesNonce?: number;
}) {
  const [fullMessages, setFullMessages] = useState<PromptMessage[] | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [revealError, setRevealError] = useState<string | null>(null);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const [focusNonce, setFocusNonce] = useState(0);
  const [pendingReveal, setPendingReveal] = useState(false);
  const shown = fullMessages ?? messages;
  const openIndex = defaultOpenPromptIndex(shown);
  const canLoadFull =
    (truncated || messages.some((item) => item.truncated)) &&
    !fullMessages &&
    Boolean(sessionId && promptFile && promptEventIndex != null);

  const loadFull = async (): Promise<PromptMessage[] | null> => {
    if (!sessionId || !promptFile || promptEventIndex == null || loadingFull) {
      return fullMessages;
    }
    setLoadingFull(true);
    setLoadError(null);
    try {
      const detail = await fetchTrajectoryPrompt(
        sessionId,
        promptFile,
        promptEventIndex,
        promptChunkIndex ?? 0,
      );
      if (detail.prompt_messages && detail.prompt_messages.length > 0) {
        setFullMessages(detail.prompt_messages);
        return detail.prompt_messages;
      }
      if (detail.prompt?.trim()) {
        const fallback = [{ role: "prompt", content: detail.prompt }];
        setFullMessages(fallback);
        return fallback;
      }
      setLoadError("未找到完整提示词");
      return null;
    } catch {
      setLoadError("加载失败");
      return null;
    } finally {
      setLoadingFull(false);
    }
  };

  const applyReveal = (list: PromptMessage[]) => {
    const index = crossSessionMemoriesPromptIndex(list);
    if (index < 0) {
      setRevealError("未在提示词中找到 Cross-Session Memories 全文。");
      return;
    }
    setRevealError(null);
    setFocusIndex(index);
    setFocusNonce((value) => value + 1);
  };

  useEffect(() => {
    if (revealCrossSessionMemoriesNonce <= 0) return;
    let cancelled = false;
    setPendingReveal(true);
    setRevealError(null);
    void (async () => {
      let list = fullMessages ?? messages;
      if (canLoadFull) {
        const loaded = await loadFull();
        if (cancelled) return;
        if (loaded) list = loaded;
      }
      if (cancelled) return;
      applyReveal(list);
      setPendingReveal(false);
    })();
    return () => {
      cancelled = true;
    };
    // Only react to explicit reveal clicks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealCrossSessionMemoriesNonce]);

  return (
    <div className="trajectory-prompt">
      {canLoadFull ? (
        <div className="trajectory-prompt-toolbar">
          <button
            type="button"
            className="btn-ghost btn-compact"
            disabled={loadingFull}
            onClick={() => void loadFull()}
          >
            {loadingFull ? "加载中…" : "加载全文"}
          </button>
        </div>
      ) : null}
      {loadError ? <p className="trajectory-span-hint">{loadError}</p> : null}
      {revealError ? <p className="trajectory-span-hint">{revealError}</p> : null}
      {pendingReveal && loadingFull ? (
        <p className="trajectory-span-hint">正在加载完整提示词以定位召回全文…</p>
      ) : null}
      <ol className="trajectory-prompt-list">
        {shown.map((item, index) => (
          <PromptMessageItem
            key={`${item.role}-${index}`}
            item={item}
            index={index}
            messages={shown}
            alignParts={alignParts}
            defaultOpen={index === openIndex}
            forceOpen={focusIndex === index}
            forceOpenNonce={focusNonce}
          />
        ))}
      </ol>
    </div>
  );
}

function PromptMessageItem({
  item,
  index,
  messages,
  alignParts,
  defaultOpen,
  forceOpen = false,
  forceOpenNonce = 0,
}: {
  item: PromptMessage;
  index: number;
  messages: PromptMessage[];
  alignParts: boolean;
  defaultOpen: boolean;
  forceOpen?: boolean;
  forceOpenNonce?: number;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const rootRef = useRef<HTMLLIElement | null>(null);
  const bucket = promptMessagePartBucket(item.role, index, messages);

  useEffect(() => {
    if (!forceOpen || forceOpenNonce <= 0) return;
    setOpen(true);
    const node = rootRef.current;
    if (!node) return;
    node.scrollIntoView({ behavior: "smooth", block: "nearest" });
    node.classList.add("is-recall-focus");
    const timer = window.setTimeout(() => node.classList.remove("is-recall-focus"), 1600);
    return () => window.clearTimeout(timer);
  }, [forceOpen, forceOpenNonce]);

  return (
    <li ref={rootRef}>
      <details
        className={`trajectory-prompt-msg is-${bucket}`}
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary>
          {alignParts ? (
            <span className={`trajectory-prompt-bucket is-${bucket}`}>{partBucketLabel(bucket)}</span>
          ) : null}
          <span className="trajectory-prompt-role">{item.role}</span>
          <span className="trajectory-preview">{compactPreview(item.content)}</span>
          <button
            type="button"
            className="btn-ghost btn-compact"
            onClick={(event) => copyText(item.content, event)}
          >
            复制
          </button>
        </summary>
        <pre className="trajectory-pre">{item.content || "（空）"}</pre>
      </details>
    </li>
  );
}
