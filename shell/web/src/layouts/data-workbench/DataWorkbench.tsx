import { useCallback, useEffect, useRef, useState } from "react";
import {
  createSession,
  deleteSession,
  getSession,
  listSessions,
} from "../../api/rest";
import { streamChat } from "../../protocol/streamClient";
import { ChatPanel } from "../../components/data-workbench/ChatPanel";
import { SessionList } from "../../components/shared/SessionList";
import { ProfileSwitcher } from "../../components/shared/ProfileSwitcher";
import type { LayoutProps } from "../../profiles/registry";
import { humanizeChatError } from "../../components/shared/chatErrors";
import { logTime } from "../../components/shared/pathUtils";
import { liveBundleFromMessages } from "../../components/chat-copilot/copilotLive";
import type {
  ChatMessage,
  LogLevel,
  RunLogEntry,
  SessionSummary,
  StageEntry,
} from "../../types";

function appendLog(msg: ChatMessage, message: string, level: LogLevel = "info"): ChatMessage {
  const entry: RunLogEntry = { message, level, time: logTime() };
  return { ...msg, logs: [...(msg.logs ?? []), entry] };
}

const THINKING_MAX = 8000;

function findRunningAssistantIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.role === "assistant" && m.status === "running") return i;
  }
  return -1;
}

export default function DataWorkbench({
  profile,
  healthWarning,
  onProfileSwitch,
  profiles,
}: LayoutProps) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const refreshSessions = useCallback(async () => {
    const list = await listSessions();
    setSessions(list);
  }, []);

  const loadSession = useCallback(async (id: string) => {
    const detail = await getSession(id);
    setActiveId(id);
    setMessages(liveBundleFromMessages(detail.messages ?? []).messages);
  }, []);

  useEffect(() => {
    const bootstrap = async () => {
      try {
        const list = await listSessions();
        setSessions(list);
        if (list.length > 0) {
          await loadSession(list[0].id);
        } else {
          const session = await createSession();
          setSessions([
            {
              id: session.id,
              title: session.title,
              preview: session.preview,
              created_at: session.created_at,
              updated_at: session.updated_at,
            },
          ]);
          setActiveId(session.id);
          setMessages([]);
        }
      } catch (err) {
        // HAZARD: bootstrap 失败只 console.error，工作台停在空会话列表且无界面提示。
        console.error(err);
      }
    };
    bootstrap();
  }, [loadSession]);

  const updateRunning = useCallback((updater: (msg: ChatMessage) => ChatMessage) => {
    setMessages((prev) => {
      const idx = findRunningAssistantIndex(prev);
      if (idx < 0) return prev;
      const next = [...prev];
      next[idx] = updater(next[idx]);
      return next;
    });
  }, []);

  const handleNewSession = async () => {
    abortRef.current?.abort();
    const session = await createSession();
    await refreshSessions();
    setActiveId(session.id);
    setMessages([]);
    setInput("");
  };

  const handleSelectSession = async (id: string) => {
    await loadSession(id);
  };

  const handleDeleteSession = async (id: string) => {
    if (id === activeId) {
      abortRef.current?.abort();
    }
    await deleteSession(id);
    const remaining = (await listSessions()).filter((item) => item.id !== id);
    setSessions(remaining);
    if (id !== activeId) return;
    if (remaining.length > 0) {
      await loadSession(remaining[0].id);
      return;
    }
    const session = await createSession();
    await refreshSessions();
    setActiveId(session.id);
    setMessages([]);
  };

  const handleCancel = () => {
    abortRef.current?.abort();
  };

  const handleSubmit = async () => {
    if (!input.trim() || loading) return;

    let sessionId = activeId;
    if (!sessionId) {
      const session = await createSession();
      sessionId = session.id;
      setActiveId(sessionId);
      setMessages([]);
      await refreshSessions();
    }

    const query = input.trim();
    setInput("");
    setLoading(true);
    abortRef.current?.abort();
    const abortController = new AbortController();
    abortRef.current = abortController;

    setMessages((prev) => [
      ...prev,
      { role: "user", content: query },
      {
        role: "assistant",
        content: "",
        status: "running",
        logs: [{ message: "已提交问题，等待 Agent 响应…", level: "info", time: logTime() }],
        stages: [],
        currentStageLabel: "等待响应…",
      },
    ]);

    try {
      await streamChat(sessionId, query, {
        onStage: (data) => {
          const stage = String(data.stage ?? "");
          const label = String(data.hint ?? data.label ?? stage);

          updateRunning((msg) => {
            const stages: StageEntry[] = (msg.stages ?? []).map((s) =>
              s.status === "active" ? { ...s, status: "done" as const } : s,
            );
            const existing = stages.find((s) => s.stage === stage);
            if (existing) {
              existing.status = "active";
              existing.label = label;
            } else {
              stages.push({ stage, label, status: "active" });
            }
            let next: ChatMessage = {
              ...msg,
              stages,
              currentStageLabel: label,
            };
            next = appendLog(next, label, "stage");
            return next;
          });
        },
        onArtifact: (data) => {
          if (data.kind === "sql" && data.sql) {
            const sql = String(data.sql);
            updateRunning((msg) => {
              if (msg.sql === sql) return msg;
              let next: ChatMessage = { ...msg, sql };
              if (!msg.sql) {
                next = appendLog(next, "SQL 草案已更新", "info");
              }
              return next;
            });
          }
        },
        onThink: (data) => {
          const phase = String(data.phase ?? "");
          const delta = String(data.content ?? "");
          updateRunning((msg) => {
            if (phase === "start") {
              const prev = msg.thinking ?? "";
              return prev ? { ...msg, thinking: `${prev}\n\n` } : msg;
            }
            if (phase === "delta" && delta) {
              const next = `${msg.thinking ?? ""}${delta}`;
              return {
                ...msg,
                thinking: next.length > THINKING_MAX ? next.slice(0, THINKING_MAX) : next,
              };
            }
            return msg;
          });
        },
        onLog: (message, _data) => {
          updateRunning((msg) => appendLog(msg, message, "info"));
        },
        onResult: (data) => {
          updateRunning((msg) => {
            const stages = (msg.stages ?? []).map((s) => ({ ...s, status: "done" as const }));
            let next: ChatMessage = {
              ...msg,
              status: "done",
              content: data.message ?? "查询完成",
              sql: data.sql ?? msg.sql,
              columns: data.columns,
              rows_preview: data.rows_preview as unknown[],
              stages,
              currentStageLabel: undefined,
            };
            next = appendLog(next, "查询完成", "info");
            return next;
          });
        },
        onError: (msg) => {
          const text = humanizeChatError(msg);
          updateRunning((m) => {
            let next: ChatMessage = {
              ...m,
              status: "error",
              content: m.content || `错误：${text}`,
              currentStageLabel: undefined,
            };
            next = appendLog(next, text, "error");
            return next;
          });
        },
      }, abortController.signal);
      await refreshSessions();
    } catch (err) {
      const isAbort = err instanceof DOMException && err.name === "AbortError";
      const raw = err instanceof Error ? err.message : String(err);
      const text = humanizeChatError(raw, isAbort);
      updateRunning((m) => {
        let next: ChatMessage = {
          ...m,
          status: "error",
          content: text,
          currentStageLabel: undefined,
        };
        next = appendLog(next, text, "error");
        return next;
      });
    } finally {
      if (abortRef.current === abortController) {
        abortRef.current = null;
      }
      setLoading(false);
    }
  };

  return (
    <>
      <header className="topbar">
        <div className="brand">DataAgent 数据工作台</div>
        <div className="subtitle">{profile.title}</div>
        <ProfileSwitcher
          profiles={profiles}
          currentId={profile.id}
          onSwitch={onProfileSwitch}
        />
        {healthWarning && <div className="health-warning">{healthWarning}</div>}
      </header>
      <main className="workspace data-workbench-workspace">
        <SessionList
          sessions={sessions}
          activeId={activeId}
          onSelect={handleSelectSession}
          onNew={handleNewSession}
          onDelete={handleDeleteSession}
        />
        <ChatPanel
          messages={messages}
          input={input}
          loading={loading}
          onInputChange={setInput}
          onSubmit={handleSubmit}
          onCancel={handleCancel}
        />
      </main>
    </>
  );
}
