import { liveBundleFromMessages, RUNNING_ASSISTANT_PLACEHOLDER, INTERRUPTED_ASSISTANT_CONTENT } from "./copilotLive";
import type { ChatMessage } from "../../types";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const running: ChatMessage[] = [
  { role: "user", content: "画折线图" },
  {
    role: "assistant",
    content: RUNNING_ASSISTANT_PLACEHOLDER,
    status: "running",
    plan_hint: "先查数再绘图",
    delegations: [{ tool_call_id: "p1", label: "Landcheck Plot", status: "running" }],
    turn_started_at: 1,
  },
];

const live = liveBundleFromMessages(running, { resumeLive: true });
assert(live.messages.length === 1 && live.messages[0].role === "user", "running turn is peeled off");
assert(live.activeTurn?.status === "running", "activeTurn restored");
assert(live.activeTurn?.delegations?.[0].label === "Landcheck Plot", "delegations restored");
assert(live.planHint === "先查数再绘图", "plan restored");
assert(live.streamingContent === "", "placeholder content is not streamed");

const done: ChatMessage[] = [
  { role: "user", content: "画折线图" },
  {
    role: "assistant",
    content: "完成",
    status: "done",
    delegations: [{ tool_call_id: "p1", status: "done" }],
  },
];
const hist = liveBundleFromMessages(done);
assert(hist.activeTurn === null, "done turn stays in history");
assert(hist.messages.length === 2, "history keeps assistant");

const sealed = liveBundleFromMessages(running);
assert(sealed.activeTurn === null, "idle hydrate does not keep a live overlay");
assert(sealed.messages.at(-1)?.status === "error", "stale running becomes error");
assert(sealed.messages.at(-1)?.content === INTERRUPTED_ASSISTANT_CONTENT, "placeholder replaced");

const withUsage: ChatMessage[] = [
  { role: "user", content: "查房间" },
  {
    role: "assistant",
    content: "12 间",
    context_usage: { used_input_tokens: 80, history: "restore", context_window: 131072 },
  },
];
const usageFromMsg = liveBundleFromMessages(withUsage);
assert(usageFromMsg.contextUsage?.used_input_tokens === 80, "usage from last assistant");
const usageFromSession = liveBundleFromMessages(done, {
  contextUsage: { used_input_tokens: 9000, history: "compressed", compress_kind: "fold" },
});
assert(usageFromSession.contextUsage?.used_input_tokens === 9000, "session root usage wins");

const withPacked: ChatMessage[] = [
  { role: "user", content: "查房间" },
  {
    role: "assistant",
    content: "12 间",
    prompt_inventory: { ir_summary_count: 1, workers: [{ sub_id: 11, artifact_count: 2, has_error: false }] },
  },
];
const packedFromMsg = liveBundleFromMessages(withPacked);
assert(packedFromMsg.promptInventory?.ir_summary_count === 1, "packed from last assistant");
assert(packedFromMsg.promptInventory?.workers[0].sub_id === 11, "packed worker id");

const withSubPacked: ChatMessage[] = [
  { role: "user", content: "查房间" },
  {
    role: "assistant",
    content: "12 间",
    sub_prompt_inventories: {
      "7": { ir_summary_count: 2, workers: [], sub_id: 7 },
    },
  },
];
const subPackedFromMsg = liveBundleFromMessages(withSubPacked);
assert(subPackedFromMsg.promptInventory === null, "sub map is not the main packed bar");
assert(subPackedFromMsg.messages.at(-1)?.sub_prompt_inventories?.["7"]?.ir_summary_count === 2, "sub map stays on message");

console.log("copilotLive.test.ts ok");
