import {
  abbreviateSessionId,
  extractCrossSessionMemories,
  extractPackedFromGroups,
  filterMemorySessions,
  findRecallPromptLocator,
  hitMetaLine,
  liveRecallCaption,
  packedSessionIds,
  partitionCurrentSessions,
  rejectReasonLabel,
  resolveLiveRecall,
  splitMemoryMarkdown,
  firstPackedSessionId,
  clipPackedPreview,
} from "./memoryDeskModel";
import type { TrajectoryGroup } from "./trajectoryModel";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

assert(extractCrossSessionMemories("role only") === "", "miss stays empty");
assert(
  extractCrossSessionMemories("**Cross-Session Memories:**\n### abc\n西湖") === "### abc\n西湖",
  "extracts packed body",
);
assert(packedSessionIds("### abc\n西湖\n### def\n房间").join() === "abc,def", "ids from headings");
assert(packedSessionIds("### abc\n### abc\n").join() === "abc", "dedupes ids");
assert(packedSessionIds("### 0b5e6702-d63c-4ced-99a4-fa1dd69d4203 用户需折线图").join() === "0b5e6702-d63c-4ced-99a4-fa1dd69d4203", "id from preview line");
assert(firstPackedSessionId("### sess-a\n摘要\n### sess-b\n") === "sess-a", "first packed id");
assert(clipPackedPreview("a".repeat(80)).endsWith("…"), "clips preview");
assert(splitMemoryMarkdown("### sess-a 同一行摘要\n其余")[0]?.sessionId === "sess-a", "md heading keeps id");
assert(splitMemoryMarkdown("### sess-a 同一行摘要\n其余")[0]?.body.includes("同一行摘要"), "md leftover goes to body");

const groups: TrajectoryGroup[] = [
  {
    file: "sub.jsonl",
    sub_id: 2,
    role: "sub-agent",
    events: [
      {
        type: "llm_start",
        event_index: 9,
        prompt: "**Cross-Session Memories:**\n### skip\n",
      },
    ],
  },
  {
    file: "main.jsonl",
    chunk_index: 1,
    role: "llm",
    events: [
      {
        type: "llm_start",
        event_index: 4,
        prompt_messages: [
          { role: "system", content: "**Cross-Session Memories:**\n### sess-a\n摘要" },
        ],
      },
    ],
  },
];
assert(extractPackedFromGroups(groups).includes("sess-a"), "skips sub-agent packed");
const locator = findRecallPromptLocator(groups);
assert(locator?.file === "main.jsonl", "locator uses main file");
assert(locator?.chunkIndex === 1 && locator?.eventIndex === 4, "locator keeps indexes");

assert(resolveLiveRecall(null, []) === null, "no live recall");
assert(resolveLiveRecall({ ir_summary_count: 0, workers: [], recall: "empty" }, [])?.status === "empty", "packed empty");
assert(resolveLiveRecall(null, ["跨会话记忆：命中 2 段 · 西湖"])?.status === "hit", "prep hit");
assert(liveRecallCaption(null).title === "尚无本轮数据", "empty caption");
assert(liveRecallCaption({ status: "empty", label: "跨会话记忆：未命中" }).title === "未命中", "miss caption");
assert(liveRecallCaption({ status: "disabled", label: "跨会话记忆：已跳过" }).title === "已跳过", "skip caption");
assert(liveRecallCaption({ status: "hit", label: "跨会话记忆：命中 2 段" }).title === "命中 2 段", "hit caption");
assert(
  liveRecallCaption({
    status: "hit",
    label: "跨会话记忆：命中 3 段 · ### abc 很长的摘要不应进标题",
  }).title === "命中 3 段",
  "hit caption drops preview",
);

assert(abbreviateSessionId("0a3149ad-9576-42df-8923-c9dbe04fba12") === "0a3149ad", "uuid short");
assert(rejectReasonLabel("below_threshold") === "低于阈值", "threshold label");
assert(hitMetaLine({ session_id: "a", score: 0.8, would_pack: true, preview: "" }).includes("将装入"), "pack meta");
assert(
  hitMetaLine({
    session_id: "b",
    score: 0,
    would_pack: false,
    preview: "",
    reject_reason: "below_threshold",
  }).includes("低于阈值"),
  "reject meta",
);

const cards = [
  { kind: "snapshot" as const, session_id: "a", session_summary: "x", goals_count: 0, decisions_count: 0, findings_count: 1 },
  { kind: "snapshot" as const, session_id: "b", is_current: true, session_summary: "y", goals_count: 0, decisions_count: 0, findings_count: 0 },
];
assert(filterMemorySessions(cards, "findings", new Set()).map((item) => item.session_id).join() === "a", "findings filter");
assert(filterMemorySessions(cards, "packed", new Set(["b"])).map((item) => item.session_id).join() === "b", "packed filter");
assert(partitionCurrentSessions(cards).current[0]?.session_id === "b", "current at end");

const md = splitMemoryMarkdown("# Memory\n\n### sess-a\n摘要 A\n### sess-b\n摘要 B");
assert(md[0]?.sessionId == null && md[0]?.body.includes("Memory"), "lead block");
assert(md[1]?.sessionId === "sess-a" && md[2]?.sessionId === "sess-b", "heading blocks");

console.log("memoryDeskModel.test.ts ok");
