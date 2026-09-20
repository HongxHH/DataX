import { collectSessionArtifacts, collectTurnArtifacts, groupArtifactsByWorker } from "./CopilotArtifactsPanel";
import type { ChatMessage, DelegationBlock } from "../../types";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const items = collectTurnArtifacts([
  {
    tool_call_id: "a",
    label: "NL2SQL",
    sub_id: 2,
    sql: "SELECT 1",
  },
  {
    tool_call_id: "b",
    label: "NL2SQL",
    sub_id: 2,
    columns: ["n"],
    rows_preview: [[1]],
  },
] as DelegationBlock[]);

const groups = groupArtifactsByWorker(items);
assert(groups.length === 1 && groups[0].title === "Worker #2", "same worker grouped");
assert(groups[0].items.length === 2, "sql and table stay in the worker group");
assert(groupArtifactsByWorker([]).length === 1, "empty stays one group");

const sessionItems = collectSessionArtifacts([
  { role: "user", content: "q1" },
  {
    role: "assistant",
    content: "a1",
    delegations: [{ tool_call_id: "first", tool_name: "sub_agent_tool", label: "NL2SQL", sql: "SELECT 1" }],
  },
  { role: "user", content: "q2" },
  {
    role: "assistant",
    content: "a2",
    delegations: [{ tool_call_id: "second", tool_name: "sub_agent_tool", label: "NL2SQL", sql: "SELECT 2" }],
  },
] as ChatMessage[]);
assert(sessionItems.find((item) => item.toolCallId === "first")?.turnKey === "m1", "first assistant uses message index");
assert(sessionItems.find((item) => item.toolCallId === "second")?.turnKey === "m3", "later assistant keeps its index");

console.log("CopilotArtifactsPanel grouping ok");
