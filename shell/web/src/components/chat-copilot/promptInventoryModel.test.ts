import { usagePartShares } from "./contextUsageModel";
import {
  buildPromptInventory,
  collectPackedWorkers,
  historyExplain,
  parseRecallCheckpoint,
  parseRewrittenQuery,
  resolveInventoryPrepLog,
  resolveRewrittenQuery,
} from "./promptInventoryModel";
import type { ChatMessage, DelegationBlock } from "../../types";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const workers = collectPackedWorkers([
  {
    tool_call_id: "a",
    tool_name: "sub_agent_tool",
    label: "Landcheck NL2SQL",
    sub_id: 11,
    resumed: false,
    sql: "SELECT 1",
    status: "done",
  },
  {
    tool_call_id: "b",
    tool_name: "sub_agent_tool",
    label: "Landcheck Plot",
    sub_id: 22,
    resumed: false,
    image_path: "/tmp/a.png",
    status: "done",
  },
  {
    tool_call_id: "c",
    tool_name: "sub_agent_tool",
    label: "Landcheck NL2SQL",
    sub_id: 11,
    resumed: true,
    columns: ["n"],
    rows_preview: [[1]],
    status: "done",
  },
] as DelegationBlock[]);

assert(workers.length === 2, "unique workers");
assert(workers[0].sub_id === 11 && workers[1].sub_id === 22, "most recently invoked first");
assert(workers[0].resumed === true, "later call updates reuse");
assert(workers[0].artifacts.join() === "SQL,表", "artifacts merge across calls");
const unlabeled = collectPackedWorkers([{ tool_call_id: "x", tool_name: "sub_agent_tool", label: "NL2SQL" }]);
assert(unlabeled.length === 1 && unlabeled[0].sub_id === null, "keep unlabeled worker");
assert(unlabeled[0].label === "NL2SQL", "unlabeled keeps agent label");

assert(parseRecallCheckpoint(["正在规划…"]) === null, "no recall yet");
assert(parseRecallCheckpoint(["跨会话记忆：未命中"])?.status === "empty", "empty");
assert(parseRecallCheckpoint(["跨会话记忆：已跳过"])?.status === "disabled", "disabled");
assert(parseRecallCheckpoint(["跨会话记忆：命中 2 段 · 西湖"])?.status === "hit", "hit");
assert(
  parseRecallCheckpoint(["跨会话记忆：未命中", "跨会话记忆：命中 1 段 · 摘要"])?.label.includes("命中 1 段") === true,
  "latest checkpoint wins",
);
assert(
  (parseRecallCheckpoint([`跨会话记忆：命中 1 段 · ${"很长预览".repeat(40)}`])?.label.length ?? 0) <= 140,
  "clip long recall preview",
);

assert(parseRewrittenQuery([], " 西湖项目房间数 ") === "西湖项目房间数", "explicit rewrite");
assert(parseRewrittenQuery(["问句已改写为 西湖项目按用途统计"], null) === "西湖项目按用途统计", "prep rewrite");
assert(parseRewrittenQuery(["正在规划…"], "") === null, "no rewrite");

const ir = historyExplain({ used_input_tokens: 10, history: "compressed", compress_kind: "ir" });
assert(ir?.chip.label === "已压缩（IR）", "ir chip");
assert(ir?.detail.includes("路径摘要") === true, "ir detail");
const full = historyExplain({ used_input_tokens: 10, history: "restore" });
assert(full?.chip.label === "完整", "restore chip");

const shares = usagePartShares({
  used_input_tokens: 100,
  history: "restore",
  parts: { system: 40, history: 30, user: 10, other: 20 },
});
assert(shares?.[0].key === "system" && shares[0].percent === 40, "system share");
assert(usagePartShares({ used_input_tokens: 1, history: "restore" }) === null, "no parts");

const messages: ChatMessage[] = [
  { role: "user", content: "q1" },
  {
    role: "assistant",
    content: "a1",
    plan_prep: ["跨会话记忆：未命中"],
    rewritten_query: "旧改写",
    delegations: [{ tool_call_id: "old", tool_name: "sub_agent_tool", label: "NL2SQL", sub_id: 3, sql: "SELECT 1" }],
  },
];
assert(
  resolveInventoryPrepLog(messages, null, ["正在规划…"], false)[0] === "跨会话记忆：未命中",
  "historical prep",
);
assert(
  resolveInventoryPrepLog(messages, null, ["正在规划…"], true)[0] === "正在规划…",
  "live prep wins",
);
assert(resolveRewrittenQuery(messages, null) === "旧改写", "historical rewrite");

const inventory = buildPromptInventory({
  usage: {
    used_input_tokens: 100,
    history: "compressed",
    compress_kind: "ir",
    parts: { system: 50, history: 20, user: 20, other: 10 },
  },
  delegations: messages[1].delegations ?? [],
  prepLog: ["跨会话记忆：命中 2 段 · 西湖", "问句已改写为 西湖项目房间数"],
});
assert(inventory.workers[0].sub_id === 3, "inventory workers");
assert(inventory.recall?.status === "hit", "inventory recall");
assert(inventory.rewrittenQuery === "西湖项目房间数", "inventory rewrite");
assert(inventory.parts?.length === 4, "inventory parts");
assert(inventory.history?.chip.label === "已压缩（IR）", "inventory history");

console.log("promptInventoryModel.test.ts ok");
