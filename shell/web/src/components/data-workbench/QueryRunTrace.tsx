import { useEffect, useRef, useState } from "react";
import type { RunLogEntry, StageEntry, TurnStatus } from "../../types";

interface QueryRunTraceProps {
  status?: TurnStatus;
  currentStageLabel?: string;
  stages?: StageEntry[];
  logs?: RunLogEntry[];
  thinking?: string;
  defaultLogsOpen?: boolean;
}

export function QueryRunTrace({
  status,
  currentStageLabel,
  stages = [],
  logs = [],
  thinking = "",
  defaultLogsOpen,
}: QueryRunTraceProps) {
  const [logsOpen, setLogsOpen] = useState(
    defaultLogsOpen ?? status === "running",
  );
  const [thinkingOpen, setThinkingOpen] = useState(status === "running");
  const logEndRef = useRef<HTMLDivElement>(null);
  const thinkEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (defaultLogsOpen === undefined && status === "running") {
      setLogsOpen(true);
    }
  }, [status, defaultLogsOpen]);

  useEffect(() => {
    if (status === "running" && thinking) {
      setThinkingOpen(true);
    }
  }, [status, thinking]);

  useEffect(() => {
    if (logsOpen && status === "running") {
      logEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [logs, logsOpen, status]);

  useEffect(() => {
    if (thinkingOpen && status === "running") {
      thinkEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [thinking, thinkingOpen, status]);

  const hasStages = stages.length > 0;
  const hasLogs = logs.length > 0;
  const hasThinking = Boolean(thinking);
  if (!hasStages && !hasLogs && !currentStageLabel && !hasThinking) return null;

  return (
    <div className="query-run-trace">
      {status === "running" && currentStageLabel && (
        <div className="run-status-line">
          <span className="run-status-pulse" />
          <span>{currentStageLabel}</span>
        </div>
      )}

      {hasStages && (
        <div className="run-stage-list">
          {stages.map((s, i) => (
            <div
              key={`${s.stage}-${i}`}
              className={`run-stage-chip ${s.status === "active" ? "active" : "done"}`}
            >
              {s.label}
            </div>
          ))}
        </div>
      )}

      {hasThinking && (
        <div className="run-log-panel">
          <button
            type="button"
            className="run-log-toggle"
            onClick={() => setThinkingOpen((o) => !o)}
          >
            模型思考
            <span className="run-log-chevron">{thinkingOpen ? "▾" : "▸"}</span>
          </button>
          {thinkingOpen && (
            <pre className="run-thinking-body">
              {thinking}
              <span ref={thinkEndRef} />
            </pre>
          )}
        </div>
      )}

      {(hasLogs || status === "running") && (
        <div className="run-log-panel">
          <button
            type="button"
            className="run-log-toggle"
            onClick={() => setLogsOpen((o) => !o)}
          >
            运行日志 ({logs.length})
            <span className="run-log-chevron">{logsOpen ? "▾" : "▸"}</span>
          </button>
          {logsOpen && (
            <div className="run-log-body">
              {logs.length === 0 ? (
                <div className="run-log-empty">等待日志输出…</div>
              ) : (
                logs.map((entry, i) => (
                  <div
                    key={i}
                    className={`run-log-line level-${entry.level ?? "info"}`}
                  >
                    {entry.time && <span className="run-log-time">{entry.time}</span>}
                    <span>{entry.message}</span>
                  </div>
                ))
              )}
              <div ref={logEndRef} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
