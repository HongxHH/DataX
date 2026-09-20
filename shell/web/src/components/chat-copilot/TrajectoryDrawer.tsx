import { useState } from "react";
import type { DelegationBlock } from "../../types";
import type { TrajectoryBranch, TrajectoryGroup, TrajectorySpan, LiveSpanEvent } from "./trajectoryModel";
import {
  buildTrajectoryForest,
  formatSpanDuration,
  isRoundBranch,
  spanIsRunning,
  spanKindLabel,
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
  const openIndex = lastRoundIndex(forest);
  return (
    <aside className="trajectory-drawer" aria-label="本会话轨迹">
      <div className="trajectory-drawer-header">
        <h3>本会话轨迹</h3>
        <button type="button" className="sessions-collapse-btn" onClick={onClose}>
          关闭
        </button>
      </div>
      {empty ? (
        <p className="trajectory-empty">
          {loading ? "轨迹写入中…" : "本会话还没有 llm/tool 轨迹。跑一轮对话后会落在工作区 .otel/。"}
        </p>
      ) : (
        <ol className="trajectory-span-list">
          {forest.map((branch, index) => (
            <BranchView key={branch.id} branch={branch} defaultOpen={index === openIndex} />
          ))}
        </ol>
      )}
    </aside>
  );
}

function lastRoundIndex(forest: TrajectoryBranch[]): number {
  for (let i = forest.length - 1; i >= 0; i -= 1) {
    if (isRoundBranch(forest[i])) return i;
  }
  return forest.length - 1;
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
    <li className={branch.failed ? "trajectory-branch is-failed" : "trajectory-branch"}>
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
  return (
    <>
      {branch.spans.length > 0 && (
        <ol className="trajectory-span-list nested">
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
        <ol className="trajectory-span-list nested">
          {branch.children.map((child) => (
            <BranchView key={child.id} branch={child} />
          ))}
        </ol>
      )}
    </>
  );
}

function SpanRow({ span }: { span: TrajectorySpan }) {
  const duration = formatSpanDuration(span.startTs, span.endTs);
  const running = spanIsRunning(span);
  return (
    <li className={span.failed ? "trajectory-span is-failed" : "trajectory-span"}>
      <div className="trajectory-span-title">
        <span className="trajectory-kind">{spanKindLabel(span.kind)}</span>
        <span className="trajectory-label">{span.label}</span>
        {span.failed && <span className="tool-timeline-fail-hint">失败</span>}
        {running && <span className="trajectory-running">进行中</span>}
      </div>
      <div className="trajectory-span-meta">
        <span>{span.source}</span>
        {span.startTs != null ? (
          <span>
            {formatClock(span.startTs)}
            {span.endTs != null ? ` – ${formatClock(span.endTs)}` : running ? " 起" : ""}
          </span>
        ) : null}
        {duration ? <span>{duration}</span> : null}
        {span.usage ? <span>{formatSpanUsage(span.usage)}</span> : null}
      </div>
      <SpanDetails span={span} />
    </li>
  );
}

function SpanDetails({ span }: { span: TrajectorySpan }) {
  const blocks: Array<{ label: string; body: string }> = [];
  if (span.content) blocks.push({ label: "输出", body: span.content });
  if (span.result) blocks.push({ label: "结果", body: span.result });
  if (span.arguments) blocks.push({ label: "参数", body: span.arguments });
  if (span.prompt) blocks.push({ label: "prompt", body: span.prompt });
  if (blocks.length === 0) {
    if (span.kind !== "llm") return null;
    return (
      <p className="trajectory-span-hint">
        实时轨迹不含完整提示词，结束后主 Agent 可从落盘轨迹展开。
      </p>
    );
  }
  return (
    <details className="trajectory-span-detail">
      <summary>展开输入 / 输出</summary>
      {blocks.map((block) => (
        <pre key={block.label} className="trajectory-pre">
          <span className="trajectory-span-label">{block.label}</span>
          {block.body}
        </pre>
      ))}
    </details>
  );
}
