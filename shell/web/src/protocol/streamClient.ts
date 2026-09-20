import type { QueryResult, ShellEventName } from "./events";
import { ShellEventType } from "./events";

/** Same-origin so Vite port hopping (5174+) does not trip CORS on chat. */
const CHAT_URL = "/api/chat";

export interface StreamHandlers {
  onEvent?: (event: ShellEventName, data: Record<string, unknown>) => void;
  onStage?: (data: Record<string, unknown>) => void;
  onToken?: (content: string, data: Record<string, unknown>) => void;
  onThink?: (data: Record<string, unknown>) => void;
  onPlan?: (data: Record<string, unknown>) => void;
  onTool?: (data: Record<string, unknown>) => void;
  onArtifact?: (data: Record<string, unknown>) => void;
  onLog?: (message: string, data: Record<string, unknown>) => void;
  onContext?: (data: Record<string, unknown>) => void;
  onContextUsage?: (data: Record<string, unknown>) => void;
  onPromptInventory?: (data: Record<string, unknown>) => void;
  onSpan?: (data: Record<string, unknown>) => void;
  onResult?: (result: QueryResult) => void;
  onError?: (message: string) => void;
}

export async function streamChat(
  sessionId: string,
  query: string,
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const payload: Record<string, unknown> = { session_id: sessionId, query };
  const res = await fetch(CHAT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
    },
    body: JSON.stringify(payload),
    signal,
  });

  if (!res.ok) {
    throw new Error(`Chat failed: ${res.status}`);
  }
  if (!res.body) {
    throw new Error("Chat failed: 502");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      if (!part.trim()) continue;
      let event: ShellEventName = "log";
      let dataStr = "";
      for (const line of part.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim() as ShellEventName;
        if (line.startsWith("data:")) dataStr += line.slice(5).trim();
      }
      if (!dataStr) continue;
      try {
        const data = JSON.parse(dataStr) as Record<string, unknown>;
        handlers.onEvent?.(event, data);

        switch (event) {
          case ShellEventType.STAGE:
            handlers.onStage?.(data);
            break;
          case ShellEventType.TOKEN: {
            const content = String(data.content ?? "");
            if (content) handlers.onToken?.(content, data);
            break;
          }
          case ShellEventType.THINK:
            handlers.onThink?.(data);
            break;
          case ShellEventType.PLAN:
            handlers.onPlan?.(data);
            break;
          case ShellEventType.TOOL:
            handlers.onTool?.(data);
            break;
          case ShellEventType.ARTIFACT:
            handlers.onArtifact?.(data);
            break;
          case ShellEventType.LOG:
            if (data.message) {
              handlers.onLog?.(String(data.message), data);
            }
            break;
          case ShellEventType.CONTEXT:
            handlers.onContext?.(data);
            break;
          case ShellEventType.CONTEXT_USAGE:
            handlers.onContextUsage?.(data);
            break;
          case ShellEventType.PROMPT_INVENTORY:
            handlers.onPromptInventory?.(data);
            break;
          case ShellEventType.SPAN:
            handlers.onSpan?.(data);
            break;
          case ShellEventType.RESULT:
            handlers.onResult?.(data as QueryResult);
            break;
          case ShellEventType.ERROR:
            handlers.onError?.(String(data.message ?? "未知错误"));
            break;
        }
      } catch {
        // HAZARD: 畸形 SSE 块被静默丢弃。若后端偶发截断 JSON，前端不会报错，只会少事件。
      }
    }
  }
}
