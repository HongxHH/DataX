import type { ChatMessage } from "../../types";
import { InlineResultTable } from "../shared/InlineResultTable";
import { InlineSqlBlock } from "../shared/InlineSqlBlock";
import { QueryRunTrace } from "./QueryRunTrace";

interface DataMessageListProps {
  messages: ChatMessage[];
  emptyHint?: string;
}

export function DataMessageList({
  messages,
  emptyHint = "输入自然语言问题，例如：当前一共有多少个项目？",
}: DataMessageListProps) {
  return (
    <div className="messages data-messages">
      {messages.length === 0 && (
        <div className="empty-hint">{emptyHint}</div>
      )}

      {messages.map((msg, idx) => {
        const prevUser =
          msg.role === "assistant"
            ? messages
                .slice(0, idx)
                .reverse()
                .find((m) => m.role === "user")
            : null;

        if (msg.role === "user") {
          return (
            <div key={idx} className="message user">
              <div className="message-role">你</div>
              <div className="message-content">{msg.content}</div>
            </div>
          );
        }

        const columns = msg.columns ?? [];
        const rows = msg.rows_preview ?? [];
        const showTrace =
          msg.status === "running" ||
          (msg.logs && msg.logs.length > 0) ||
          (msg.stages && msg.stages.length > 0) ||
          Boolean(msg.thinking);

        return (
          <div key={idx} className="message assistant query-turn">
            <div className="message-role-row">
              <span className="message-role">助手</span>
              {prevUser && (
                <span className="message-context">回复：{prevUser.content}</span>
              )}
              {msg.status === "running" && (
                <span className="turn-badge running">处理中</span>
              )}
              {msg.status === "error" && (
                <span className="turn-badge error">失败</span>
              )}
              {msg.status === "done" && msg.content && (
                <span className="turn-badge done">已完成</span>
              )}
            </div>

            {showTrace && (
              <QueryRunTrace
                status={msg.status}
                currentStageLabel={msg.currentStageLabel}
                stages={msg.stages}
                logs={msg.logs}
                thinking={msg.thinking}
              />
            )}

            {msg.sql && <InlineSqlBlock sql={msg.sql} />}

            {columns.length > 0 && (
              <InlineResultTable columns={columns} rows={rows} />
            )}

            {msg.content && (
              <div className="message-content turn-summary">{msg.content}</div>
            )}

            {msg.status === "running" && !msg.content && !msg.sql && !showTrace && (
              <div className="message-content turn-waiting">正在准备…</div>
            )}
          </div>
        );
      })}
    </div>
  );
}
