import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useReactFlow,
  useStore,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { PlanToolItem, SpanEventData, ThinkPhase } from "../../protocol/events";
import type { DelegationBlock } from "../../types";
import {
  buildTrajectoryForest,
  findTrajectoryBranch,
  formatSpanDuration,
  spanIsRunning,
  spanKindLabel,
  type TrajectoryBranch,
  type TrajectoryGroup,
} from "./trajectoryModel";
import { CopilotDagNode } from "./CopilotDagNode";
import { visiblePrepLines } from "./prepLogModel";
import { workspaceFileUrl } from "../../api/rest";
import { InlineResultTable } from "../shared/InlineResultTable";
import { InlineSqlBlock } from "../shared/InlineSqlBlock";
import {
  buildCopilotFlowGraph,
  defaultSelectedNodeId,
  FLOW_STATUS_LABEL,
  flowCanvasHeight,
  flowViewportAction,
  formatNodeDuration,
  inspectorStatusDetail,
  resolveFlowNodeId,
  type CopilotFlowNode,
  type FlowNodeData,
} from "./flowModel";

interface CopilotFlowGraphProps {
  thinking?: string;
  thinkingPhase?: ThinkPhase | null;
  stageHint?: string | null;
  prepLog?: string[];
  planHint?: string | null;
  planTools?: PlanToolItem[];
  delegations?: DelegationBlock[];
  hasAnswer?: boolean;
  turnRunning?: boolean;
  turnStartedAt?: number;
  sessionId?: string | null;
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
  liveSpans?: SpanEventData[];
  trajectoryGroups?: TrajectoryGroup[];
}

const NODE_TYPES = { copilot: CopilotDagNode };

function isPointerPanEvent(event: unknown): boolean {
  return event instanceof MouseEvent || event instanceof TouchEvent;
}

function useClock(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [running]);
  return now;
}

function useAutoScroll<T extends HTMLElement>(live: boolean, dep: unknown) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (live) {
      ref.current?.scrollTo({ top: ref.current.scrollHeight });
    }
  }, [dep, live]);
  return ref;
}

function FlowCanvas({
  nodes,
  edges,
  selectedId,
  onSelect,
  turnRunning,
  canvasHeight,
}: {
  nodes: CopilotFlowNode[];
  edges: ReturnType<typeof buildCopilotFlowGraph>["edges"];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  turnRunning: boolean;
  canvasHeight: number;
}) {
  const { fitView, setViewport } = useReactFlow();
  const fitViewRef = useRef(fitView);
  const setViewportRef = useRef(setViewport);
  fitViewRef.current = fitView;
  setViewportRef.current = setViewport;
  const nodesInitialized = useNodesInitialized();
  const flowWidth = useStore((state) => state.width);
  const flowHeight = useStore((state) => state.height);
  const userPanned = useRef(false);
  const selectedNodes = useMemo(
    () => nodes.map((n) => ({ ...n, selected: n.id === selectedId })),
    [nodes, selectedId],
  );
  const graphKey = `${nodes.map((n) => n.id).join("|")}|${edges.map((edge) => edge.id).join("|")}`;

  useEffect(() => {
    userPanned.current = false;
  }, [turnRunning]);

  useEffect(() => {
    if (userPanned.current) return;
    const action = flowViewportAction({
      nodesInitialized,
      nodeCount: nodes.length,
      flowWidth,
      flowHeight,
      canvasHeight,
    });
    if (action === "wait") return;
    if (action === "origin") {
      void setViewportRef.current({ x: 0, y: 0, zoom: 1 }, { duration: 0 });
      return;
    }
    void fitViewRef.current({ padding: 0.2, minZoom: 0.35, maxZoom: 1, duration: 0 });
  }, [graphKey, nodesInitialized, nodes.length, flowWidth, flowHeight, canvasHeight]);

  return (
    <ReactFlow
      nodes={selectedNodes}
      edges={edges}
      nodeTypes={NODE_TYPES}
      onNodeClick={(_event: MouseEvent, node: Node<FlowNodeData>) => onSelect(node.id)}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable
      panOnDrag
      zoomOnScroll={false}
      preventScrolling={false}
      minZoom={0.35}
      maxZoom={1.35}
      defaultViewport={{ x: 0, y: 0, zoom: 1 }}
      defaultEdgeOptions={{ style: { stroke: "var(--border)", strokeWidth: 1.5 } }}
      onPaneClick={() => onSelect(null)}
      onMoveStart={(event) => {
        if (isPointerPanEvent(event)) userPanned.current = true;
      }}
    >
      <Background gap={18} color="rgba(208, 215, 222, 0.8)" />
      <Controls showInteractive={false} />
      {nodes.length > 4 && (
        <MiniMap
          pannable
          zoomable
          style={{ width: 96, height: 64 }}
          nodeColor={(node) => {
            const status = (node.data as FlowNodeData).status;
            if (status === "active") return "#0969da";
            if (status === "done") return "#1a7f37";
            if (status === "error") return "#cf222e";
            return "#d0d7de";
          }}
        />
      )}
    </ReactFlow>
  );
}

export function CopilotFlowGraph({
  thinking = "",
  thinkingPhase,
  stageHint,
  prepLog = [],
  planHint,
  planTools = [],
  delegations = [],
  hasAnswer = false,
  turnRunning = true,
  turnStartedAt,
  sessionId,
  selectedId: selectedIdProp,
  onSelect,
  liveSpans = [],
  trajectoryGroups = [],
}: CopilotFlowGraphProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const thinkingLive = turnRunning && (thinkingPhase === "start" || thinkingPhase === "delta");
  const hasThinking = Boolean(thinking);
  const { nodes, edges } = useMemo(
    () =>
      buildCopilotFlowGraph({
        thinking: hasThinking ? "…" : "",
        thinkingLive,
        stageHint,
        planHint,
        planTools,
        delegations,
        hasAnswer,
        turnRunning,
        turnStartedAt,
      }),
    [
      hasThinking,
      thinkingLive,
      stageHint,
      planHint,
      planTools,
      delegations,
      hasAnswer,
      turnRunning,
      turnStartedAt,
    ],
  );
  const paintedNodes = useMemo(
    () =>
      nodes.map((node) => {
        if (node.id !== "plan") return node;
        return {
          ...node,
          data: {
            ...node.data,
            thinking: thinking || undefined,
            thinkingLive,
            prepLog: prepLog.length > 0 ? prepLog : undefined,
          },
        };
      }),
    [nodes, thinking, thinkingLive, prepLog],
  );

  const autoId = defaultSelectedNodeId(paintedNodes, turnRunning);
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const requestedId = selectedIdProp !== undefined ? selectedIdProp : pinnedId;
  const resolved = resolveFlowNodeId(paintedNodes, requestedId);
  const selectedId = resolved ?? autoId;
  const selected = paintedNodes.find((n) => n.id === selectedId) ?? null;
  const inspectorLive = Boolean(selected?.data.startedAt && !selected.data.endedAt);
  const now = useClock(turnRunning && inspectorLive);
  const elapsedLabel = selected
    ? formatNodeDuration(selected.data.startedAt, selected.data.endedAt, now)
    : undefined;
  const forest = useMemo(
    () => buildTrajectoryForest(trajectoryGroups, liveSpans, delegations),
    [trajectoryGroups, liveSpans, delegations],
  );
  const innerBranch =
    selected?.data.kind === "agent" && selected.id.startsWith("agent-")
      ? findTrajectoryBranch(forest, selected.id.slice("agent-".length))
      : undefined;
  const height = flowCanvasHeight(paintedNodes);
  const belongsHere = Boolean(resolveFlowNodeId(paintedNodes, selectedIdProp ?? null));

  useEffect(() => {
    if (belongsHere) {
      wrapRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [belongsHere, selectedIdProp]);

  const handleSelect = (id: string | null) => {
    setPinnedId(id);
    onSelect?.(id);
  };

  return (
    <div ref={wrapRef} className="copilot-flow-canvas-wrap" aria-label="本轮执行流程">
      <div className="copilot-flow-canvas" style={{ height }}>
        <ReactFlowProvider>
          <FlowCanvas
            nodes={paintedNodes}
            edges={edges}
            selectedId={selectedId}
            onSelect={handleSelect}
            turnRunning={turnRunning}
            canvasHeight={height}
          />
        </ReactFlowProvider>
      </div>
      {selected && (
        <FlowInspector
          node={selected}
          elapsedLabel={elapsedLabel}
          sessionId={sessionId}
          innerBranch={innerBranch}
        />
      )}
    </div>
  );
}

function FlowInspector({
  node,
  elapsedLabel,
  sessionId,
  innerBranch,
}: {
  node: CopilotFlowNode;
  elapsedLabel?: string;
  sessionId?: string | null;
  innerBranch?: TrajectoryBranch;
}) {
  const { data } = node;
  const imageSrc = workspaceFileUrl(sessionId, data.imagePath);
  const reportHref = workspaceFileUrl(sessionId, data.reportPath);
  const innerSpans = (innerBranch?.spans ?? []).filter((span) => span.kind !== "stage");
  const pipelineSteps = data.pipelineSteps ?? [];
  const statusDetail = inspectorStatusDetail(data);
  return (
    <div className="copilot-flow-inspector">
      <div className="copilot-flow-head">
        <span className="copilot-flow-title">{data.title}</span>
        <span className={`copilot-flow-badge ${data.status}`}>
          {FLOW_STATUS_LABEL[data.status]}
          {elapsedLabel ? ` · ${elapsedLabel}` : ""}
        </span>
      </div>
      {statusDetail ? <div className="copilot-flow-detail">{statusDetail}</div> : null}
      {data.error && <div className="delegation-card-error">{data.error}</div>}
      {data.decision && <div className="copilot-flow-io">{data.decision}</div>}
      {data.decisionTools && data.decisionTools.length > 0 && (
        <ol className="copilot-flow-io-list" aria-label="委派参数">
          {data.decisionTools.map((tool) => (
            <li key={tool.label}>
              <span className="copilot-flow-io-label">{tool.label}</span>
              <pre className="copilot-flow-io-body">{tool.summary}</pre>
            </li>
          ))}
        </ol>
      )}
      {data.prepLog && data.prepLog.length > 0 && (
        <PrepLog items={data.prepLog} live={data.status === "active"} />
      )}
      {data.chips && data.chips.length > 0 && (
        <div className="copilot-flow-sub" aria-label="节点详情标签">
          {data.chips.map((chip) => (
            <span key={chip.key} className={`copilot-flow-chip ${chip.className ?? ""}`.trim()}>
              {chip.label}
            </span>
          ))}
        </div>
      )}
      {pipelineSteps.length > 0 && (
        <ol className="copilot-flow-inner-steps" aria-label="流水线产物">
          {pipelineSteps.map((step, index) => (
            <li key={`${step.label}-${index}`} className={step.live ? "active" : "done"}>
              <span className="trajectory-kind">产物</span>
              <span>{step.label}</span>
              {step.live ? <span className="copilot-flow-inner-meta">进行中</span> : null}
              {step.detail ? <pre className="copilot-flow-inner-detail">{step.detail}</pre> : null}
            </li>
          ))}
        </ol>
      )}
      {innerSpans.length > 0 && (
        <ol className="copilot-flow-inner-steps" aria-label="内部步骤">
          {innerSpans.map((span) => {
            const duration = formatSpanDuration(span.startTs, span.endTs);
            const running = spanIsRunning(span);
            const output = span.content || span.result;
            return (
              <li key={span.id} className={span.failed ? "is-failed" : running ? "active" : "done"}>
                <span className="trajectory-kind">{spanKindLabel(span.kind)}</span>
                <span>{span.label}</span>
                {duration ? <span className="copilot-flow-inner-meta">{duration}</span> : null}
                {running ? <span className="copilot-flow-inner-meta">进行中</span> : null}
                {span.failed ? <span className="copilot-flow-inner-meta">失败</span> : null}
                {output ? <pre className="copilot-flow-inner-detail">{output}</pre> : null}
              </li>
            );
          })}
        </ol>
      )}
      {data.thinking && (
        <details className="copilot-flow-thinking-wrap" open={Boolean(data.thinkingLive)}>
          <summary>模型思考</summary>
          <ThinkingBody text={data.thinking} live={Boolean(data.thinkingLive)} />
        </details>
      )}
      {data.sql && data.artifactKind !== "excerpts" && <InlineSqlBlock sql={data.sql} />}
      {data.columns && data.columns.length > 0 && (
        <InlineResultTable
          columns={data.columns}
          rows={data.rowsPreview ?? []}
          rowCount={data.rowCount}
          previewRowCount={data.previewRowCount}
        />
      )}
      {data.excerpts && data.excerpts.length > 0 && (
        <ul className="delegation-excerpts">
          {data.excerpts.map((item, idx) => (
            <li key={`${item.source_path ?? "src"}-${idx}`}>
              <div className="delegation-excerpt-source">{item.source_path}</div>
              {item.excerpt && <pre className="delegation-excerpt-body">{item.excerpt}</pre>}
            </li>
          ))}
        </ul>
      )}
      {imageSrc && (
        <a href={imageSrc} target="_blank" rel="noreferrer">
          <img className="delegation-artifact-image" src={imageSrc} alt={data.title} />
        </a>
      )}
      {data.reportPath && (
        reportHref ? (
          <a className="delegation-file-path" href={reportHref} target="_blank" rel="noreferrer">
            {data.reportPath}
          </a>
        ) : (
          <div className="delegation-file-path">{data.reportPath}</div>
        )
      )}
    </div>
  );
}

function PrepLog({ items, live }: { items: string[]; live: boolean }) {
  const shown = visiblePrepLines(items, { live, expanded: false });
  if (shown.length === 0) return null;
  return (
    <div className="copilot-flow-prep-wrap">
      <ol className="copilot-flow-prep" aria-label={live ? "规划准备步骤" : "规划短结果"}>
        {shown.map((line) => {
          const isLiveHeartbeat = live && line.kind === "heartbeat";
          return (
            <li
              key={`${line.index}-${line.text}`}
              className={`${line.kind}${isLiveHeartbeat ? " active" : ""}`}
            >
              {line.text}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function ThinkingBody({ text, live }: { text: string; live: boolean }) {
  const ref = useAutoScroll<HTMLPreElement>(live, text);
  return (
    <pre ref={ref} className="copilot-flow-thinking">
      {text}
    </pre>
  );
}
