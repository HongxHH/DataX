import { usagePartShares } from "./contextUsageModel";
import {
  assemblySlots,
  buildPromptInventory,
  collectPackedWorkers,
  historyExplain,
  irCountBadge,
  inventoryChipForAgent,
  mergePackedWorkers,
  parsePromptInventory,
  parseRecallCheckpoint,
  parseRewrittenQuery,
  parseSubPromptInventories,
  resolveInventoryPrepLog,
  resolvePackedInventory,
  resolvePlanTools,
  resolveRewrittenQuery,
  shouldShowAssembly,
  upsertSubInventory,
  workerQuerySummary,
  workerSummariesBySubId,
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
const sameIdBothNew = collectPackedWorkers([
  { tool_call_id: "nl2sql", tool_name: "sub_agent_tool", label: "NL2SQL", sub_id: 844533, resumed: false, sql_path: "/tmp/q.sql", csv_path: "/tmp/r.csv" },
  { tool_call_id: "plot", tool_name: "sub_agent_tool", label: "Plot", sub_id: 844533, resumed: false, image_path: "/tmp/a.png" },
] as DelegationBlock[]);
assert(sameIdBothNew.length === 1 && sameIdBothNew[0].resumed === false, "latest kernel resumed wins; no same-id invent");
assert(sameIdBothNew[0].artifacts.join() === "SQL,表,图", "path artifacts overlay sql csv image");
const parallel = collectPackedWorkers(
  [
    {
      tool_call_id: "count",
      tool_name: "sub_agent_tool",
      label: "Landcheck NL2SQL",
      sub_id: 648799,
      sql: "SELECT COUNT(*) AS n FROM project",
      status: "done",
    },
    {
      tool_call_id: "top",
      tool_name: "sub_agent_tool",
      label: "Landcheck NL2SQL",
      sub_id: 610525,
      sql: "SELECT project_name FROM project",
      status: "done",
    },
  ] as DelegationBlock[],
  [
    { name: "sub_agent_tool", label: "Landcheck NL2SQL", args_summary: "当前一共有多少个项目？统计有效项目总数" },
    {
      name: "sub_agent_tool",
      label: "Landcheck NL2SQL",
      args_summary: "project_time为2025年的项目中，实测报告数最多的是哪个项目？请统计每个2025年项目的实测报告数量",
    },
  ],
);
assert(parallel.length === 2, "parallel workers stay distinct");
assert(parallel.some((worker) => worker.sub_id === 648799 && worker.summary?.includes("一共有多少个项目")), "count worker keeps plan summary");
assert(parallel.some((worker) => worker.sub_id === 610525 && worker.summary?.includes("实测报告")), "rank worker keeps plan summary");
assert(workerQuerySummary({ sql: "SELECT 1" }) === "SELECT 1", "sql fallback when plan summary missing");
assert(
  resolvePlanTools(
    [{ role: "assistant", content: "a", plan_tools: [{ name: "sub_agent_tool", args_summary: "历史问句" }] }],
    null,
    [],
  )[0]?.args_summary === "历史问句",
  "resolve plan tools from messages",
);
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
assert(full?.detail.includes("原文") === true, "restore explains uncompressed history");
const packedHistory = historyExplain(
  { used_input_tokens: 10, history: "compressed", compress_kind: "ir" },
  { ir_summary_count: 2, workers: [] },
);
assert(packedHistory?.detail.includes("2 条 IR 摘要") === true, "packed ir count");

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
assert(inventory.source === "inferred", "inferred when packed missing");
assert(inventory.ir === null, "inferred has no ir cards");

const parsedPacked = parsePromptInventory({
  ir_summary_count: 1,
  skill_count: 2,
  has_plan: true,
  has_memory: true,
  recall: "hit",
  workers: [{ sub_id: 11, artifact_count: 2, has_error: false, last_query: "secret query" }],
  ir_summaries: [{ tool: "sub_agent_tool", nodes: ["Table", "../etc"], path: "/tmp/x" }],
  content: "secret prompt",
});
assert(parsedPacked?.workers[0].sub_id === 11, "parse worker id");
assert(parsedPacked?.ir_summaries?.[0].nodes?.join() === "Table", "drop illegal node types");
assert(!JSON.stringify(parsedPacked).includes("secret"), "parse drops prompt text");

const packedInventory = buildPromptInventory({
  usage: {
    used_input_tokens: 100,
    history: "compressed",
    compress_kind: "ir",
  },
  packed: parsedPacked,
  delegations: messages[1].delegations ?? [],
  prepLog: ["跨会话记忆：未命中"],
});
assert(packedInventory.source === "packed", "prefer packed");
assert(packedInventory.workers[0].sub_id === 11, "packed workers ignore dag");
assert(packedInventory.workers[0].artifacts[0] === "2 个产物", "artifact count only");
const overlayPacked = buildPromptInventory({
  packed: parsePromptInventory({
    ir_summary_count: 0,
    workers: [{ sub_id: 844533, artifact_count: 0, has_error: false }],
  }),
  delegations: [
    {
      tool_call_id: "nl2sql",
      tool_name: "sub_agent_tool",
      label: "Landcheck NL2SQL",
      sub_id: 844533,
      resumed: false,
      sql: "SELECT 1",
      columns: ["n"],
    },
    {
      tool_call_id: "plot",
      tool_name: "sub_agent_tool",
      label: "Landcheck Plot",
      sub_id: 844533,
      resumed: false,
      image_path: "/tmp/a.png",
    },
  ] as DelegationBlock[],
  prepLog: [],
});
assert(overlayPacked.workers[0].artifacts.join() === "SQL,表,图", "packed empty count overlays delegation artifacts");
assert(overlayPacked.workers[0].resumed === false, "packed overlay keeps latest kernel resumed");
assert(overlayPacked.workers[0].label === "Plot", "packed overlay keeps latest agent label");
const overlayWithPlan = buildPromptInventory({
  packed: parsePromptInventory({
    ir_summary_count: 0,
    workers: [
      { sub_id: 648799, artifact_count: 0, has_error: false },
      { sub_id: 610525, artifact_count: 0, has_error: false },
    ],
  }),
  delegations: [
    {
      tool_call_id: "count",
      tool_name: "sub_agent_tool",
      label: "Landcheck NL2SQL",
      sub_id: 648799,
      sql: "SELECT COUNT(*)",
    },
    {
      tool_call_id: "top",
      tool_name: "sub_agent_tool",
      label: "Landcheck NL2SQL",
      sub_id: 610525,
      sql: "SELECT name",
    },
  ] as DelegationBlock[],
  messages: [
    {
      role: "assistant",
      content: "done",
      plan_tools: [
        { name: "sub_agent_tool", args_summary: "当前一共有多少个项目？" },
        { name: "sub_agent_tool", args_summary: "2025年实测报告最多的项目" },
      ],
      delegations: [
        {
          tool_call_id: "count",
          tool_name: "sub_agent_tool",
          label: "Landcheck NL2SQL",
          sub_id: 648799,
          sql: "SELECT COUNT(*)",
        },
        {
          tool_call_id: "top",
          tool_name: "sub_agent_tool",
          label: "Landcheck NL2SQL",
          sub_id: 610525,
          sql: "SELECT name",
        },
      ],
    },
  ],
  prepLog: [],
});
assert(
  overlayWithPlan.workers.find((worker) => worker.sub_id === 648799)?.summary?.includes("一共有多少个项目") === true,
  "packed overlay keeps plan query summary",
);
assert(
  overlayWithPlan.workers.find((worker) => worker.sub_id === 610525)?.summary?.includes("2025") === true,
  "packed overlay keeps second plan query summary",
);
const multiturn = workerSummariesBySubId(
  [
    {
      role: "assistant",
      content: "old",
      plan_tools: [{ name: "sub_agent_tool", args_summary: "旧问句总数" }],
      delegations: [{ tool_call_id: "old", tool_name: "sub_agent_tool", sub_id: 1, sql: "SELECT 1" }],
    },
    {
      role: "assistant",
      content: "new",
      plan_tools: [
        { name: "sub_agent_tool", args_summary: "当前一共有多少个项目？" },
        { name: "sub_agent_tool", args_summary: "2025年实测报告最多的项目" },
      ],
      delegations: [
        { tool_call_id: "a", tool_name: "sub_agent_tool", sub_id: 648799, sql: "SELECT COUNT(*)" },
        { tool_call_id: "b", tool_name: "sub_agent_tool", sub_id: 610525, sql: "SELECT name" },
      ],
    },
  ],
);
assert(multiturn.get(1) === "旧问句总数", "older turn keeps its own summary");
assert(multiturn.get(648799)?.includes("一共有多少个项目") === true, "later turn count summary");
assert(multiturn.get(610525)?.includes("2025") === true, "later turn rank summary");
assert(
  mergePackedWorkers([{ sub_id: 9, artifact_count: 3, has_error: false }], [])[0].artifacts[0] === "3 个产物",
  "packed count remains when no delegation overlay",
);
assert(packedInventory.recall?.label === "已装入跨会话记忆。", "packed recall without excerpt");
assert(packedInventory.ir?.count === 1, "packed ir count");
assert(packedInventory.flags?.skillCount === 2 && packedInventory.flags.hasPlan === true, "packed flags");
assert(
  assemblySlots(packedInventory, "main").map((slot) => slot.kind).join() ===
  "history,ir,worker,flags,recall",
  "main slots follow packed inventory",
);
assert(shouldShowAssembly(packedInventory, "main") === true, "packed main panel shows");

const subPacked = parsePromptInventory({
  ir_summary_count: 2,
  workers: [],
  sub_id: 7,
  ir_summaries: [{ tool: "execute_sql", nodes: ["Table"] }],
});
assert(subPacked?.sub_id === 7, "parse keeps sub_id");
const subInventory = buildPromptInventory({
  packed: subPacked,
  delegations: messages[1].delegations ?? [],
  prepLog: ["跨会话记忆：命中"],
});
assert(subInventory.source === "packed", "sub packed is not stripped");
assert(subInventory.ir?.count === 2, "sub ir count");
assert(
  assemblySlots(subInventory, "sub").map((slot) => slot.kind).join() === "ir,recall",
  "sub slots skip parts/history/worker",
);
assert(shouldShowAssembly(subInventory, "sub") === true, "sub packed panel shows");
assert(irCountBadge(subPacked) === "IR×2", "ir badge");
assert(inventoryChipForAgent(7, { "7": subPacked! })?.label === "IR×2", "agent ir chip");
assert(inventoryChipForAgent(8, { "7": subPacked! }) === undefined, "other sub has no chip");
assert(resolvePackedInventory(messages, null, subPacked) === null, "top bar ignores sub packed");

const parsedSubs = parseSubPromptInventories({
  "7": { ir_summary_count: 2, workers: [], sub_id: 7, content: "secret" },
  main: { ir_summary_count: 1, workers: [] },
});
assert(parsedSubs["7"]?.ir_summary_count === 2, "keep sub map");
assert(parsedSubs.main == null, "drop main snapshot from sub map");
assert(!JSON.stringify(parsedSubs).includes("secret"), "sub parse drops prompt text");
const capped = upsertSubInventory({ "1": parsedPacked! }, subPacked!);
assert(capped["7"]?.sub_id === 7 && capped["1"]?.ir_summary_count === 1, "upsert keeps both");

const livePacked = resolvePackedInventory(messages, null, parsedPacked);
assert(livePacked?.ir_summary_count === 1, "live packed wins");
assert(parsePromptInventory({ workers: [] }) === null, "require ir_summary_count");

console.log("promptInventoryModel.test.ts ok");
