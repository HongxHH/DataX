import { Handle, Position, type NodeProps } from "@xyflow/react";
import { useEffect, useState } from "react";
import { FLOW_STATUS_LABEL, formatNodeDuration, type CopilotFlowNode, type FlowKind } from "./flowModel";

const KIND_TAG: Record<FlowKind, string> = {
  plan: "编排",
  agent: "子 Agent",
  artifact: "产物",
  answer: "结论",
};

function useNodeDuration(startedAt?: number, endedAt?: number): string | undefined {
  const running = startedAt != null && endedAt == null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return undefined;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [running, startedAt]);
  return formatNodeDuration(startedAt, endedAt, now);
}

function handleClass(used: boolean): string {
  return used ? "copilot-dag-handle" : "copilot-dag-handle is-unused";
}

export function CopilotDagNode({ data, selected }: NodeProps<CopilotFlowNode>) {
  const liveDuration = useNodeDuration(data.startedAt, data.endedAt);
  const duration = data.durationLabel ?? liveDuration;
  const isPlan = data.kind === "plan";
  const isAgent = data.kind === "agent";
  const isAnswer = data.kind === "answer";
  return (
    <div className={`copilot-dag-node kind-${data.kind} ${data.status}${selected ? " selected" : ""}`}>
      <Handle type="target" position={Position.Left} id="west" className={handleClass(!isPlan && !isAnswer)} />
      <Handle type="target" position={Position.Top} id="north" className={handleClass(isAnswer)} />
      <div className="copilot-dag-kicker">{KIND_TAG[data.kind]}</div>
      <div className="copilot-flow-head">
        <span className="copilot-flow-title">{data.title}</span>
        <span className={`copilot-flow-badge ${data.status}`}>
          {FLOW_STATUS_LABEL[data.status]}
          {duration ? ` · ${duration}` : ""}
        </span>
      </div>
      <div className="copilot-flow-detail copilot-dag-detail">{data.detail}</div>
      {data.chips && data.chips.length > 0 ? (
        <div className="copilot-dag-chips" aria-label="节点状态">
          {data.chips.slice(0, isAgent ? 3 : 2).map((chip) => (
            <span key={chip.key} className={`copilot-flow-chip ${chip.className ?? ""}`.trim()}>
              {chip.label}
            </span>
          ))}
        </div>
      ) : null}
      <Handle type="source" position={Position.Right} id="east" className={handleClass(isPlan || isAgent)} />
      <Handle type="source" position={Position.Bottom} id="south" className={handleClass(isPlan)} />
    </div>
  );
}
