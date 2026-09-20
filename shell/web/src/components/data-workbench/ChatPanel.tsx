import type { KeyboardEvent } from "react";
import type { ChatMessage } from "../../types";
import { DataMessageList } from "./DataMessageList";

interface ChatPanelProps {
  messages: ChatMessage[];
  input: string;
  loading: boolean;
  onInputChange: (value: string) => void;
  onSubmit: () => void;
  onCancel?: () => void;
}

export function ChatPanel({
  messages,
  input,
  loading,
  onInputChange,
  onSubmit,
  onCancel,
}: ChatPanelProps) {
  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!loading && input.trim()) onSubmit();
    }
  };

  return (
    <section className="panel chat-panel data-workbench-panel">
      <div className="panel-header">
        <h2>对话</h2>
        {loading && <span className="badge">本轮处理中…</span>}
      </div>
      <DataMessageList messages={messages} />
      <div className="chat-input-area">
        <textarea
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="输入问题，Enter 发送，Shift+Enter 换行"
          rows={3}
          disabled={loading}
        />
        <button
          type="button"
          className="btn-ghost"
          disabled={!loading}
          onClick={onCancel}
        >
          取消
        </button>
        <button
          type="button"
          className="btn-primary"
          disabled={loading || !input.trim()}
          onClick={onSubmit}
        >
          发送
        </button>
      </div>
    </section>
  );
}
