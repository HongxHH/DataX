import type { ToolEventData } from "../../protocol/events";

interface ToolTimelineProps {
  events: ToolEventData[];
}

export function ToolTimeline({ events }: ToolTimelineProps) {
  if (events.length === 0) {
    return <div className="tool-timeline-empty">暂无工具调用</div>;
  }

  return (
    <ul className="tool-timeline">
      {events.map((ev, idx) => (
        <li key={`${ev.tool_call_id ?? ev.tool_name ?? idx}-${idx}`} className="tool-timeline-item">
          <div className="tool-timeline-name">{ev.tool_name ?? "tool"}</div>
          <div className="tool-timeline-status">{ev.status ?? "—"}</div>
          {ev.summary && <div className="tool-timeline-summary">{ev.summary}</div>}
          {ev.error && <div className="tool-timeline-error">{ev.error}</div>}
        </li>
      ))}
    </ul>
  );
}
