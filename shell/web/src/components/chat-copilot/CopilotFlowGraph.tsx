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
  useStoreApi,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { PlanToolItem, PromptInventorySnapshot, SpanEventData, ThinkPhase } from "../../protocol/events";
import type { DelegationBlock } from "../../types";
import { AssemblyPanel } from "./AssemblyPanel";
import {
  buildPromptInventory,
  inventoryChipForAgent,
  shouldShowAssembly,
  subInventoryOf,
} from "./promptInventoryModel";
import {
  buildTrajectoryForest,
  findTrajectoryBranch,
  formatSpanDuration,
  mainAgentLiveBranch,
  mainLlmRole,
  mainLlmRoleLabel,
  spanIsRunning,
  spanKindLabel,
  thinkingByLlmSpan,
  type TrajectoryBranch,
  type TrajectoryGroup,
} from "./trajectoryModel";
import { CopilotDagNode } from "./CopilotDagNode";
import { splitRecallCheckpoint, visiblePrepLines } from "./prepLogModel";
import { workspaceFileUrl } from "../../api/rest";
import { InlineResultTable } from "../shared/InlineResultTable";
import { InlineSqlBlock } from "../shared/InlineSqlBlock";
import {
  bindCopilotFlowNodes,
  buildCopilotFlowGraph,
  defaultSelectedNodeId,
  FLOW_STATUS_LABEL,
  flowCanvasHeight,
  flowViewportAction,
  formatNodeDuration,
  inspectorLead,
  latestLlmChip,
  rememberFlowNodeMeasurements,
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
  promptInventory?: PromptInventorySnapshot | null;
  subInventories?: Record<string, PromptInventorySnapshot>;
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
  const storeApi = useStoreApi();
  const measuredRef = useRef(new Map<string, { width: number; height: number }>());
  const nodesInitialized = useNodesInitialized();
  const flowWidth = useStore((state) => state.width);
  const flowHeight = useStore((state) => state.height);
  const userPanned = useRef(false);
  const selectedNodes = useMemo(() => {
    storeApi.getState().nodeLookup.forEach((internal, id) => {
      const width = internal.measured?.width;
      const height = internal.measured?.height;
      if (width != null && height != null) measuredRef.current.set(id, { width, height });
    });
    const bound = bindCopilotFlowNodes(nodes, selectedId, measuredRef.current);
    rememberFlowNodeMeasurements(bound, measuredRef.current);
    return bound;
  }, [nodes, selectedId, storeApi]);
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
  subInventories = {},
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
  const forest = useMemo(
    () => buildTrajectoryForest(trajectoryGroups, liveSpans, delegations),
    [trajectoryGroups, liveSpans, delegations],
  );
  const planBranch = useMemo(() => mainAgentLiveBranch(liveSpans), [liveSpans]);
  const paintedNodes = useMemo(
    () =>
      nodes.map((node) => {
        let next = node;
        if (node.id === "plan") {
          const llmChip = planBranch ? latestLlmChip(planBranch.spans) : undefined;
          const liveChip = llmChip?.className === "active" ? llmChip : undefined;
          const chips = [...(liveChip ? [liveChip] : []), ...(node.data.chips ?? [])];
          next = {
            ...node,
            data: {
              ...node.data,
              detail: liveChip ? liveChip.label : node.data.detail,
              thinking: thinking || undefined,
              thinkingLive,
              prepLog: prepLog.length > 0 ? prepLog : undefined,
              chips: chips.length > 0 ? chips : undefined,
            },
          };
        }
        if (next.data.kind === "agent") {
          const irChip = inventoryChipForAgent(next.data.subId, subInventories);
          if (irChip) {
            const chips = [irChip, ...(next.data.chips ?? []).filter((chip) => chip.key !== "ir")];
            next = { ...next, data: { ...next.data, chips } };
          }
        }
        return next;
      }),
    [nodes, thinking, thinkingLive, prepLog, planBranch, subInventories],
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
  const innerBranch =
    selected?.id === "plan"
      ? planBranch
      : selected?.data.kind === "agent" && selected.id.startsWith("agent-")
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
          delegations={delegations}
          subInventories={subInventories}
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
  delegations,
  subInventories,
}: {
  node: CopilotFlowNode;
  elapsedLabel?: string;
  sessionId?: string | null;
  innerBranch?: TrajectoryBranch;
  delegations: DelegationBlock[];
  subInventories?: Record<string, PromptInventorySnapshot>;
}) {
  const { data } = node;
  const imageSrc = workspaceFileUrl(sessionId, data.imagePath);
  const reportHref = workspaceFileUrl(sessionId, data.reportPath);
  const innerSpans = (innerBranch?.spans ?? []).filter((span) => span.kind !== "stage");
  const pipelineSteps = data.pipelineSteps ?? [];
  const lead = inspectorLead(data, delegations);
  const thinkingBySpan = data.kind === "plan" ? thinkingByLlmSpan(innerSpans, data.thinking) : new Map();
  const llmSpans = innerSpans.filter((span) => span.kind === "llm");
  const showThinkingFallback = Boolean(data.thinking) && (data.kind !== "plan" || llmSpans.length === 0);
  const assembly = inspectorSubAssembly(data, subInventories);
  const showAssembly = assembly != null && shouldShowAssembly(assembly, "sub");
  const isPlan = data.kind === "plan";
  const decisionTools = data.decisionTools ?? [];
  // Prefer structured tool rows; raw planHint only when there is nothing better.
  const showDecisionText = Boolean(data.decision) && decisionTools.length === 0;
  const showPrimaryTools = decisionTools.length > 0;
  // Plan chips duplicate tool labels; agent/artifact chips stay in the deep fold.
  const showChips = Boolean(data.chips?.length) && !isPlan;
  const hasProcess = Boolean(
    (data.prepLog && data.prepLog.length > 0)
    || innerSpans.length > 0
    || showThinkingFallback,
  );
  const hasDeep = Boolean(
    hasProcess
    || showAssembly
    || showChips
    || pipelineSteps.length > 0,
  );
  const hasDetails = showDecisionText || showPrimaryTools || hasDeep;
  // Keep the inspector skim-first: never auto-expand a wall of text.
  const [detailsFor, setDetailsFor] = useState(node.id);
  const [detailsOpen, setDetailsOpen] = useState(false);
  if (detailsFor !== node.id) {
    setDetailsFor(node.id);
    setDetailsOpen(false);
  }
  return (
    <div className="copilot-flow-inspector">
      <div className="copilot-flow-head">
        <span className="copilot-flow-title">{data.title}</span>
        <span className={`copilot-flow-badge ${data.status}`}>
          {FLOW_STATUS_LABEL[data.status]}
          {elapsedLabel ? ` · ${elapsedLabel}` : ""}
        </span>
      </div>
      {lead ? <div className="copilot-flow-detail">{lead}</div> : null}
      {data.error && <div className="delegation-card-error">{data.error}</div>}
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
      {hasDetails ? (
        <details
          className="copilot-flow-details"
          open={detailsOpen}
          onToggle={(event) => setDetailsOpen(event.currentTarget.open)}
        >
          <summary>查看详情</summary>
          {showPrimaryTools && (
            <ol className="copilot-flow-io-list" aria-label="委派摘要">
              {decisionTools.map((tool, index) => (
                <li key={`${index}-${tool.label}`}>
                  <span className="copilot-flow-io-label">{tool.label}</span>
                  {tool.summary ? <span className="copilot-flow-io-summary">{tool.summary}</span> : null}
                </li>
              ))}
            </ol>
          )}
          {showDecisionText && (
            <div className="copilot-flow-io">
              <span className="copilot-flow-io-kicker">委派决策</span>
              <div className="copilot-flow-io-summary">{data.decision}</div>
            </div>
          )}
          {hasDeep ? (
            <details className="copilot-flow-nested">
              <summary>过程与装入</summary>
              {data.prepLog && data.prepLog.length > 0 && (
                <PrepLog items={data.prepLog} live={data.status === "active"} />
              )}
              {showChips && data.chips && data.chips.length > 0 && (
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
                      {step.detail ? (
                        <details className="copilot-flow-nested-inline">
                          <summary>展开</summary>
                          <pre className="copilot-flow-inner-detail">{step.detail}</pre>
                        </details>
                      ) : null}
                    </li>
                  ))}
                </ol>
              )}
              {innerSpans.length > 0 && (
                <ol className="copilot-flow-inner-steps" aria-label="内部步骤">
                  {innerSpans.map((span) => {
                    const duration = formatSpanDuration(span.startTs, span.endTs);
                    const running = spanIsRunning(span);
                    const role = isPlan && span.kind === "llm" ? mainLlmRole(span, delegations) : undefined;
                    const label = role ? mainLlmRoleLabel(role) : span.label;
                    const thinking = thinkingBySpan.get(span.id);
                    const output = span.kind === "llm" ? undefined : span.result;
                    const emptyRewrite = span.kind === "llm" && role === "rewrite" && !thinking && !running;
                    const hasBody = Boolean(thinking || output);
                    return (
                      <li key={span.id} className={span.failed ? "is-failed" : running ? "active" : "done"}>
                        <span className="trajectory-kind">{spanKindLabel(span.kind)}</span>
                        <span>{label}</span>
                        {span.kind === "llm" && span.label !== label ? (
                          <span className="copilot-flow-inner-meta">{span.label}</span>
                        ) : null}
                        {duration ? <span className="copilot-flow-inner-meta">{duration}</span> : null}
                        {running ? <span className="copilot-flow-inner-meta">进行中</span> : null}
                        {span.failed ? <span className="copilot-flow-inner-meta">失败</span> : null}
                        {emptyRewrite ? <span className="copilot-flow-inner-meta">无流式思考</span> : null}
                        {hasBody ? (
                          <details className="copilot-flow-nested-inline">
                            <summary>{thinking ? "思考" : "输出"}</summary>
                            {thinking ? <pre className="copilot-flow-inner-detail">{thinking}</pre> : null}
                            {output ? <pre className="copilot-flow-inner-detail">{output}</pre> : null}
                          </details>
                        ) : null}
                      </li>
                    );
                  })}
                </ol>
              )}
              {showThinkingFallback && (
                <details className="copilot-flow-thinking-wrap">
                  <summary>模型思考</summary>
                  <ThinkingBody text={data.thinking ?? ""} live={Boolean(data.thinkingLive)} />
                </details>
              )}
              {showAssembly && assembly ? (
                <AssemblyPanel
                  inventory={assembly}
                  scope="sub"
                  heading="本轮装入提示词"
                  note="不含提示词正文。"
                  compact
                />
              ) : null}
            </details>
          ) : null}
        </details>
      ) : null}
    </div>
  );
}

function inspectorSubAssembly(
  data: FlowNodeData,
  subInventories: Record<string, PromptInventorySnapshot> | undefined,
) {
  if (data.kind !== "agent") return null;
  const packed = subInventoryOf(subInventories, data.subId);
  if (!packed) return null;
  return buildPromptInventory({ packed, delegations: [], prepLog: [] });
}

function PrepLog({ items, live }: { items: string[]; live: boolean }) {
  const shown = visiblePrepLines(items, { live, expanded: false });
  if (shown.length === 0) return null;
  return (
    <div className="copilot-flow-prep-wrap">
      <ol className="copilot-flow-prep" aria-label={live ? "规划准备步骤" : "规划短结果"}>
        {shown.map((line) => {
          const isLiveHeartbeat = live && line.kind === "heartbeat";
          const recall = splitRecallCheckpoint(line.text);
          return (
            <li
              key={`${line.index}-${line.text}`}
              className={`${line.kind}${isLiveHeartbeat ? " active" : ""}`}
            >
              {recall ? (
                <>
                  <div>{recall.headline}</div>
                  {recall.preview ? (
                    <details className="copilot-flow-prep-preview">
                      <summary>召回预览</summary>
                      <pre>{recall.preview}</pre>
                    </details>
                  ) : null}
                </>
              ) : (
                line.text
              )}
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
