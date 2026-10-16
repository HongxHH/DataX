import { precedingUserQuestion } from "./copilotRetry";
import type { ChatMessage } from "../../types";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const messages: ChatMessage[] = [
  { role: "user", content: "第一问" },
  { role: "assistant", content: "答一", status: "done" },
  { role: "user", content: "  第二问  " },
  { role: "assistant", content: "已取消当前请求", status: "error" },
];

assert(precedingUserQuestion(messages, 3) === "第二问", "retry uses nearest user turn");
assert(precedingUserQuestion(messages, 1) === "第一问", "earlier assistant maps to first user");
assert(precedingUserQuestion(messages, 0) === null, "no prior user");
assert(precedingUserQuestion([{ role: "assistant", content: "x", status: "error" }], 0) === null, "lonely assistant");

console.log("copilotRetry.test.ts ok");
