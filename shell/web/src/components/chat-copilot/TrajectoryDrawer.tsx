import { useState } from "react";
import type { DelegationBlock } from "../../types";
import type {
  TrajectoryBranch,
  TrajectoryGroup,
  TrajectorySessionSummary,
  TrajectorySpan,
  LiveSpanEvent,
} from "./trajectoryModel";
import {
  buildTrajectoryForest,
  formatSpanDuration,
  formatTokenTotal,
  isRoundBranch,
  spanIsRunning,
  spanKindLabel,
  spanModelDetail,
  spanShortLabel,
  summarizeTrajectoryForest,
} from "./trajectoryModel";

function formatClock(ts: number | null): string {
  if (ts == null || !Number.isFinite(ts)) return "—";
  const date = new Date(ts * 1000);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString();
}

function formatSpanUsage(usage: { input_tokens?: number; output_tokens?: number }): string {
  return `输入 ${usage.input_tokens ?? 0} · 输出 ${usage.output_tokens ?? 0}`;
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
  loading?: boolean;
  onClose: () => void;
}

export function TrajectoryDrawer({
  open,
  groups,
  liveSpans = [],
  delegations = [],
  loading,
  onClose,
}: TrajectoryDrawerProps) {
  if (!open) return null;
  const forest = buildTrajectoryForest(groups, liveSpans, delegations);
  const empty = forest.length === 0;
  const summary = empty ? null : summarizeTrajectoryForest(forest);
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
        <ol className="trajectory-span-list">
          {forest.map((branch, index) => (
            <BranchView
              key={branch.id}
              branch={branch}
              defaultOpen={shouldOpenRound(forest, index)}
            />
          ))}
        </ol>
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

function BranchView({ branch, defaultOpen }: { branch: TrajectoryBranch; defaultOpen?: boolean }) {
  if (isRoundBranch(branch)) {
    return <RoundBranchView branch={branch} defaultOpen={defaultOpen} />;
  }
  return (
    <li className={branch.failed ? "trajectory-branch is-worker is-failed" : "trajectory-branch is-worker"}>
      <div className="trajectory-branch-title">{branch.title}</div>
      <BranchBody branch={branch} />
    </li>
  );
}

function RoundBranchView({ branch, defaultOpen }: { branch: TrajectoryBranch; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(Boolean(defaultOpen));
  return (
    <li className={branch.failed ? "trajectory-branch is-failed" : "trajectory-branch"}>
      <details
        className="trajectory-round"
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary className="trajectory-branch-title">{branch.title}</summary>
        <BranchBody branch={branch} />
      </details>
    </li>
  );
}

function BranchBody({ branch }: { branch: TrajectoryBranch }) {
  const pipelineOnly = branchLacksLlmOrTool(branch);
  const stagesOnly = branch.spans.length > 0 && branch.spans.every((span) => span.kind === "stage");
  return (
    <>
      {branch.spans.length > 0 && (
        <ol className={stagesOnly ? "trajectory-span-list nested trajectory-pipeline" : "trajectory-span-list nested"}>
          {branch.spans.map((span) => (
            <SpanRow key={span.id} span={span} />
          ))}
        </ol>
      )}
      {pipelineOnly ? (
        <p className="trajectory-span-hint">
          该子 Agent 是流水线，产物在上方流程节点里展开。
        </p>
      ) : null}
      {branch.children.length > 0 && (
        <ol className="trajectory-span-list nested trajectory-children">
          {branch.children.map((child) => (
            <BranchView key={child.id} branch={child} />
          ))}
        </ol>
      )}
    </>
  );
}

function SpanRow({ span }: { span: TrajectorySpan }) {
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
      <SpanDetails span={span} />
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

function SpanDetails({ span }: { span: TrajectorySpan }) {
  const blocks: Array<{ label: string; body: string }> = [];
  if (span.content) blocks.push({ label: "输出", body: span.content });
  if (span.result) blocks.push({ label: "结果", body: span.result });
  if (span.arguments) blocks.push({ label: "参数", body: span.arguments });
  if (span.prompt) blocks.push({ label: "prompt", body: span.prompt });
  const meta = spanDetailMeta(span);
  const liveHint =
    blocks.length === 0 && span.kind === "llm"
      ? "实时轨迹不含完整提示词，结束后主 Agent 可从落盘轨迹展开。"
      : null;
  if (blocks.length === 0 && meta.length === 0 && !liveHint) return null;
  return (
    <details className="trajectory-span-detail">
      <summary>展开输入 / 输出</summary>
      {meta.length > 0 ? (
        <div className="trajectory-span-detail-meta">
          {meta.map((line) => (
            <span key={line}>{line}</span>
          ))}
        </div>
      ) : null}
      {liveHint ? <p className="trajectory-span-hint">{liveHint}</p> : null}
      {blocks.map((block) => (
        <pre key={block.label} className="trajectory-pre">
          <span className="trajectory-span-label">{block.label}</span>
          {block.body}
        </pre>
      ))}
    </details>
  );
}
