import type { SessionSummary } from "../../types";
import { ContextUsageMeter } from "../chat-copilot/ContextUsageMeter";
import { CopyTextButton } from "./CopyTextButton";
import { ChevronIcon, IconButton, PlusIcon } from "./IconButton";
import { usePersistedToggle } from "./usePersistedToggle";

export const SESSIONS_COLLAPSED_KEY = "dataagent.shell.sessionsCollapsed";

interface SessionListProps {
  sessions: SessionSummary[];
  activeId: string | null;
  runningId?: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete?: (id: string) => void;
  showUsage?: boolean;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}

export function SessionIdChip({ sessionId }: { sessionId: string }) {
  return (
    <CopyTextButton
      text={sessionId}
      idleLabel={`复制会话 ID ${sessionId}`}
      copiedLabel="已复制会话 ID"
    />
  );
}

export function SessionList({
  sessions,
  activeId,
  runningId,
  onSelect,
  onNew,
  onDelete,
  showUsage = false,
  collapsed: collapsedProp,
  onToggleCollapsed,
}: SessionListProps) {
  const [uncontrolled, toggleUncontrolled] = usePersistedToggle(SESSIONS_COLLAPSED_KEY);
  const collapsed = collapsedProp ?? uncontrolled;
  const toggleCollapsed = onToggleCollapsed ?? toggleUncontrolled;

  return (
    <aside className={`panel sessions-panel${collapsed ? " is-collapsed" : ""}`}>
      <div className="panel-header">
        <h2>会话</h2>
        <div className="panel-header-actions">
          {collapsed ? (
            <>
              <button
                type="button"
                className="sessions-collapse-btn"
                aria-expanded={false}
                aria-controls="session-list"
                title="展开会话列表"
                onClick={toggleCollapsed}
              >
                展开
              </button>
              <button type="button" className="btn-primary" onClick={onNew} title="新对话">
                +
              </button>
            </>
          ) : (
            <IconButton label="收起会话列表" onClick={toggleCollapsed} aria-expanded aria-controls="session-list">
              <ChevronIcon dir="left" />
            </IconButton>
          )}
        </div>
      </div>
      {collapsed ? null : (
        <button type="button" className="session-new-btn" onClick={onNew}>
          <PlusIcon />
          新对话
        </button>
      )}
      <ul id="session-list" className="session-list" hidden={collapsed}>
        {sessions.length === 0 && (
          <li className="session-empty">暂无会话，点击「新对话」开始</li>
        )}
        {sessions.map((s) => (
          <li
            key={s.id}
            className={`session-item ${s.id === activeId ? "active" : ""}`}
            onClick={() => onSelect(s.id)}
          >
            <div className="session-item-row">
              <div className="session-title">{s.title || "新对话"}</div>
              {s.id === runningId && <span className="session-running">进行中</span>}
              {onDelete && (
                <button
                  type="button"
                  className="session-delete"
                  title="删除会话"
                  onClick={(event) => {
                    event.stopPropagation();
                    if (window.confirm("删除该会话？对话记录与工作区文件会一并去掉。")) {
                      onDelete(s.id);
                    }
                  }}
                >
                  删除
                </button>
              )}
            </div>
            {s.preview ? <div className="session-preview">{s.preview}</div> : null}
            {showUsage ? <ContextUsageMeter usage={s.context_usage} variant="mini" /> : null}
          </li>
        ))}
      </ul>
    </aside>
  );
}
