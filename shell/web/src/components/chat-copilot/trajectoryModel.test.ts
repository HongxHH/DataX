import {
  buildTrajectoryForest,
  findTrajectoryBranch,
  spansFromGroups,
  spansFromLive,
  visibleTrajectorySpans,
  type LiveSpanEvent,
  type TrajectoryGroup,
} from "./trajectoryModel";
import type { DelegationBlock } from "../../types";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const groups: TrajectoryGroup[] = [
  {
    file: "trajectory.json",
    role: "main",
    events: [
      { type: "llm_start", model: "qwen-plus", timestamp: 1, prompt: "查房间" },
      {
        type: "tool_start",
        tool_name: "sub_agent_tool",
        tool_call_id: "c1",
        timestamp: 2,
        arguments: '{"query":"房间数"}',
      },
      { type: "tool_end", tool_call_id: "c1", timestamp: 3, result: "ok" },
      {
        type: "tool_start",
        tool_name: "sub_agent_tool",
        tool_call_id: "c2",
        timestamp: 4,
      },
      { type: "tool_end", tool_call_id: "c2", timestamp: 5, is_error: true, result: "busy" },
      { type: "llm_end", timestamp: 6, content: "已委派" },
    ],
  },
];

const spans = spansFromGroups(groups);
assert(spans.length === 3, `expected 3 spans, got ${spans.length}`);
assert(spans[0].kind === "llm" && spans[0].label === "qwen-plus", "llm span first");
assert(spans.filter((item) => item.label === "sub_agent_tool").length === 2, "two sub_agent_tool spans");
assert(spans[2].failed === true, "second tool marked failed");
assert(spans[1].arguments?.includes("房间数"), "arguments preserved");
assert(spans[1].toolCallId === "c1", "toolCallId from file event");
assert(spansFromGroups([]).length === 0, "empty groups");

const live: LiveSpanEvent[] = [
  { kind: "llm", phase: "start", name: "qwen-plus", timestamp: 10, sub_id: 1 },
  {
    kind: "llm",
    phase: "end",
    name: "qwen-plus",
    timestamp: 12,
    duration_ms: 2000,
    usage: { input_tokens: 8, output_tokens: 2 },
    sub_id: 1,
  },
];
const liveSpans = spansFromLive(live);
assert(liveSpans.length === 1, "live start/end pair");
assert(liveSpans[0].source === "子 Agent #1", "live source uses sub_id");
assert(liveSpans[0].subId === 1, "live subId stamped");
assert(liveSpans[0].usage?.input_tokens === 8, "live usage");
assert(visibleTrajectorySpans([], live).length === 1, "empty file uses live");
assert(visibleTrajectorySpans(groups, live).length >= 3, "file wins and keeps open live only if any");

const forestGroups: TrajectoryGroup[] = [
  ...groups,
  {
    file: "trajectory_1_0.json",
    role: "sub-agent",
    sub_id: 1,
    parent_tool_call_id: "c1",
    events: [
      { type: "llm_start", model: "qwen", timestamp: 2.2, prompt: "inner" },
      { type: "llm_end", timestamp: 2.8, content: "sql" },
    ],
  },
  {
    file: "trajectory_9_0.json",
    role: "sub-agent",
    sub_id: 9,
    events: [
      { type: "llm_start", model: "old-qwen", timestamp: 0.5 },
      { type: "llm_end", timestamp: 0.6 },
    ],
  },
];

const openLive: LiveSpanEvent[] = [
  {
    kind: "llm",
    phase: "start",
    name: "generator:qwen",
    timestamp: 2.4,
    parent_tool_call_id: "c1",
    sub_id: 1,
  },
];

const delegations: DelegationBlock[] = [
  {
    tool_call_id: "c1",
    tool_name: "sub_agent_tool",
    label: "Landcheck NL2SQL",
    sub_id: 1,
    logs: [{ message: "↳ Generator: SELECT 1" }],
    stages: [{ stage: "generator", label: "生成 SQL", status: "done" }],
  },
  {
    tool_call_id: "c2",
    tool_name: "sub_agent_tool",
    label: "Landcheck NL2SQL",
    sub_id: 1,
    stages: [{ stage: "validator", label: "校验 SQL", status: "done" }],
  },
];

const forest = buildTrajectoryForest(forestGroups, openLive, delegations);
assert(!forest.some((branch) => branch.id === "main"), "legacy main branch is gone");
const mainRound = forest.find((branch) => branch.id.startsWith("round:"));
const c1 = findTrajectoryBranch(forest, "c1");
const c2 = findTrajectoryBranch(forest, "c2");
assert(mainRound, "round branch exists");
assert(mainRound?.title.startsWith("第"), `round title, got ${mainRound?.title}`);
assert(mainRound?.spans.some((span) => span.label === "qwen-plus"), "planner llm stays on its round");
assert(c1, "c1 branch");
assert(c1?.title.includes("Landcheck NL2SQL") && c1.title.includes("#1"), `c1 title, got ${c1?.title}`);
assert(
  mainRound?.children.some((child) => child.id === "c1"),
  "c1 hangs under the round, not as a sibling of main",
);
assert(
  c1?.spans.some((span) => span.parentToolCallId === "c1" && span.label === "qwen"),
  "file group hangs under c1",
);
assert(
  c1?.spans.some((span) => span.label === "generator:qwen" && span.parentToolCallId === "c1"),
  "open live hangs under c1",
);
assert(
  c1?.spans.some((span) => span.kind === "stage" && span.label === "Generator" && span.content?.includes("SELECT 1")),
  "c1 log products merged",
);
assert(!(c1?.spans.some((span) => span.label === "生成 SQL")), "empty stage labels stay out of c1");
assert(c2, "c2 branch");
assert(!(c2?.spans.some((span) => span.label === "校验 SQL")), "c2 does not copy empty stages");
assert(!(c2?.spans.some((span) => span.label === "qwen" || span.label === "generator:qwen")), "c2 does not mix c1 children");
const orphan = forest.find((branch) => branch.title.includes("#9") || branch.spans.some((span) => span.label === "old-qwen"));
assert(orphan && orphan.id !== "c1" && orphan.id !== "c2", "old sub group without parent stays top-level");
assert(orphan?.spans.some((span) => span.label === "old-qwen"), "orphan keeps old llm");
assert(!orphan?.id.startsWith("round:"), "orphan is not a round branch");

const twoRounds: TrajectoryGroup[] = [
  {
    file: "trajectory.json",
    role: "main",
    round_index: 0,
    events: [
      { type: "llm_start", model: "qwen-r0", timestamp: 1 },
      { type: "llm_end", timestamp: 2, content: "a" },
    ],
  },
  {
    file: "trajectory.json",
    role: "main",
    round_index: 1,
    events: [
      { type: "llm_start", model: "qwen-r1", timestamp: 10 },
      {
        type: "tool_start",
        tool_name: "sub_agent_tool",
        tool_call_id: "later",
        timestamp: 11,
      },
      { type: "tool_end", tool_call_id: "later", timestamp: 12, result: "ok" },
      { type: "llm_end", timestamp: 13, content: "b" },
    ],
  },
];
const split = buildTrajectoryForest(twoRounds);
const roundBranches = split.filter((branch) => branch.id.startsWith("round:"));
assert(roundBranches.length === 2, `expected 2 rounds, got ${roundBranches.length}`);
assert(roundBranches[0].spans.some((span) => span.label === "qwen-r0"), "round 0 keeps first llm");
assert(roundBranches[1].spans.some((span) => span.label === "qwen-r1"), "round 1 keeps second llm");
assert(!roundBranches[0].spans.some((span) => span.label === "qwen-r1"), "rounds do not share planner llms");
assert(
  roundBranches[1].children.some((child) => child.id === "later"),
  "later tool hangs under round 1",
);

const liveForest = buildTrajectoryForest(twoRounds, [
  { kind: "llm", phase: "start", name: "qwen-live", timestamp: 99 },
]);
assert(
  liveForest.some((branch) => branch.title === "本轮进行中" && branch.spans.some((span) => span.label === "qwen-live")),
  "open live llm sits in the in-progress round",
);

const named = findTrajectoryBranch(
  buildTrajectoryForest(twoRounds, [], [
    { tool_call_id: "later", tool_name: "sub_agent_tool", label: "Landcheck NL2SQL", sub_id: 1 },
    { tool_call_id: "other", tool_name: "sub_agent_tool", label: "Landcheck Plot", sub_id: 2 },
  ]),
  "later",
);
assert(
  named?.title.includes("Landcheck NL2SQL") && named.title.includes("#1"),
  `full-session delegations still name older tools, got ${named?.title}`,
);

console.log("trajectoryModel.test.ts ok");
