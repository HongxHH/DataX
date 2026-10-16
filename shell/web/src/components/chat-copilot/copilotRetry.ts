import type { ChatMessage } from "../../types";

/** Nearest prior user turn; used to retry a failed/cancelled assistant reply. */
export function precedingUserQuestion(messages: ChatMessage[], assistantIndex: number): string | null {
  for (let i = assistantIndex - 1; i >= 0; i -= 1) {
    if (messages[i]?.role !== "user") continue;
    const question = messages[i].content.trim();
    return question || null;
  }
  return null;
}
