import type { ChatMessage } from "../../types";
import type { ContextUsageSnapshot, PromptInventorySnapshot } from "../../protocol/events";
import {
  assistantTurnForRoundBranch,
  buildTrajectorySpanAssembly,
  collectMainRoundUsages,
  contextUsageForLlmSpan,
  partBucketLabel,
  promptMessagePartBucket,
  usageForRoundBranch,
} from "./trajectoryParts";
import type { TrajectoryBranch, TrajectorySpan } from "./trajectoryModel";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const usageA: ContextUsageSnapshot = {
  used_input_tokens: 100,
  history: "restore",
  parts: { system: 40, history: 30, user: 10, other: 20 },
};
const usageB: ContextUsageSnapshot = {
  used_input_tokens: 200,
  history: "compressed",
  compress_kind: "ir",
  parts: { system: 50, history: 50, user: 50, other: 50 },
};
const packedA: PromptInventorySnapshot = {
  ir_summary_count: 2,
  workers: [{ sub_id: 11, artifact_count: 1, has_error: false }],
  ir_summaries: [{ tool: "execute_sql", nodes: ["Sql"] }],
  has_plan: true,
};

const messages: ChatMessage[] = [
  { role: "user", content: "q1" },
  {
    role: "assistant",
    content: "a1",
    context_usage: usageA,
    prompt_inventory: packedA,
    plan_prep: ["跨会话记忆：未命中"],
    turn_started_at: 100,
    turn_ended_at: 110,
  },
  { role: "user", content: "q2" },
  {
    role: "assistant",
    content: "a2",
    context_usage: usageB,
    turn_started_at: 200,
    turn_ended_at: 220,
  },
  { role: "assistant", content: "no usage" },
];

const rounds = collectMainRoundUsages(messages);
assert(rounds.length === 3, "one slot per assistant");
assert(rounds[0] === usageA, "first round usage");
assert(rounds[1] === usageB, "second round usage");
assert(rounds[2] === null, "missing usage stays null");

const sealed: TrajectoryBranch = {
  id: "round:main:trajectory.json:0",
  title: "第 1 轮",
  source: "主 Agent",
  spans: [],
  children: [],
};
assert(usageForRoundBranch(sealed, 0, rounds) === usageA, "sealed ordinal 0");
assert(usageForRoundBranch(sealed, 1, rounds) === usageB, "sealed ordinal 1");
assert(
  assistantTurnForRoundBranch(sealed, 0, messages.filter((m) => m.role === "assistant"))?.content === "a1",
  "round turn",
);

const live: TrajectoryBranch = {
  id: "round:_live",
  title: "本轮进行中",
  source: "主 Agent",
  spans: [],
  children: [],
};
assert(usageForRoundBranch(live, 99, rounds, usageB) === usageB, "live uses liveUsage");

const spanInTurn: TrajectorySpan = {
  id: "s1",
  kind: "llm",
  label: "planner",
  source: "主 Agent",
  startTs: 105,
  endTs: 108,
  failed: false,
  roundKey: "main:trajectory.json:0",
};
assert(contextUsageForLlmSpan(spanInTurn, messages, null) === usageA, "timestamp match wins");

const assembly = buildTrajectorySpanAssembly(spanInTurn, messages, messages[1]);
assert(assembly != null, "assembly built");
assert(assembly?.source === "packed", "packed source");
assert(assembly?.parts?.length === 4, "parts from usage");
assert(assembly?.ir?.count === 2, "ir from packed");
assert(assembly?.workers.length === 1, "workers from packed");
assert(assembly?.flags?.hasPlan === true, "flags from packed");
assert(assembly?.recall?.status === "empty", "recall from prep");

const liveSpan: TrajectorySpan = {
  id: "live-0",
  kind: "llm",
  label: "planner",
  source: "主 Agent",
  startTs: 999,
  endTs: null,
  failed: false,
};
assert(contextUsageForLlmSpan(liveSpan, messages, null, usageB) === usageB, "live span fallback");
const liveAssembly = buildTrajectorySpanAssembly(liveSpan, messages, null, {
  usage: usageB,
  packed: packedA,
  live: true,
});
assert(liveAssembly?.source === "packed", "live packed assembly");

const promptMsgs = [
  { role: "system", content: "sys" },
  { role: "user", content: "old" },
  { role: "assistant", content: "hist" },
  { role: "tool", content: "tool body" },
  { role: "user", content: "latest" },
];
assert(promptMessagePartBucket("system", 0, promptMsgs) === "system", "system bucket");
assert(promptMessagePartBucket("user", 1, promptMsgs) === "history", "earlier user is history");
assert(promptMessagePartBucket("assistant", 2, promptMsgs) === "history", "assistant is history");
assert(promptMessagePartBucket("tool", 3, promptMsgs) === "other", "tool is other");
assert(promptMessagePartBucket("user", 4, promptMsgs) === "user", "last user is 本轮");
assert(partBucketLabel("other") === "其他", "other label");

console.log("trajectoryParts.test.ts ok");
