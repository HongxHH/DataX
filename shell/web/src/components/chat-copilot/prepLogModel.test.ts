import {
  heartbeatCount,
  PLAN_PREP_LOG_LIMIT,
  prepKind,
  trimPrepLog,
  visiblePrepLines,
} from "./prepLogModel";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

assert(prepKind("问句已改写为 西湖项目房间数") === "checkpoint", "rewrite is checkpoint");
assert(prepKind("跨会话记忆：未命中") === "checkpoint", "recall miss is checkpoint");
assert(prepKind("跨会话记忆：命中 2 段 · 某摘要") === "checkpoint", "recall hit is checkpoint");
assert(prepKind("跨会话记忆：已跳过") === "checkpoint", "recall skip is checkpoint");
assert(prepKind("正在规划…") === "heartbeat", "planning hint is heartbeat");
assert(prepKind("正在同步上下文任务…") === "heartbeat", "sync hint is heartbeat");
assert(prepKind("正在检索跨会话记忆…") === "heartbeat", "recall start is heartbeat not result");
assert(prepKind("正在解析问题中的指代（可能调用模型）…") === "heartbeat", "rewrite start is heartbeat");

const mixed = [
  "正在规划…",
  "正在检索跨会话记忆…",
  "跨会话记忆：未命中",
  "正在解析问题中的指代（可能调用模型）…",
  "问句已改写为 西湖项目房间数",
  "正在同步上下文任务…",
  "正在等待规划模型返回…",
];

assert(heartbeatCount(mixed) === 5, "five heartbeats");

const live = visiblePrepLines(mixed, { live: true, expanded: false }).map((line) => line.text);
assert(
  JSON.stringify(live) ===
  JSON.stringify(["跨会话记忆：未命中", "问句已改写为 西湖项目房间数", "正在等待规划模型返回…"]),
  `live shows checkpoints plus last heartbeat, got ${JSON.stringify(live)}`,
);

const done = visiblePrepLines(mixed, { live: false, expanded: false }).map((line) => line.text);
assert(
  JSON.stringify(done) === JSON.stringify(["跨会话记忆：未命中", "问句已改写为 西湖项目房间数"]),
  `done default is checkpoints only, got ${JSON.stringify(done)}`,
);

const expanded = visiblePrepLines(mixed, { live: false, expanded: true }).map((line) => line.text);
assert(JSON.stringify(expanded) === JSON.stringify(mixed), "expanded keeps full timeline");

const onlyBeats = ["正在规划…", "正在启动规划节点…", "正在同步上下文任务…"];
assert(visiblePrepLines(onlyBeats, { live: false, expanded: false }).length === 0, "done default empty without checkpoints");
assert(
  visiblePrepLines(onlyBeats, { live: true, expanded: false }).map((line) => line.text).join() ===
  "正在同步上下文任务…",
  "live without checkpoints keeps last heartbeat",
);

const overflow = [
  "正在规划…",
  "跨会话记忆：未命中",
  ...Array.from({ length: 22 }, (_, index) => `正在等待规划模型返回…${index}`),
  "问句已改写为 西湖项目房间数",
];
const trimmed = trimPrepLog(overflow);
assert(trimmed.length === PLAN_PREP_LOG_LIMIT, "trim stays within persist window");
assert(trimmed.includes("跨会话记忆：未命中"), "trim keeps recall checkpoint");
assert(trimmed.includes("问句已改写为 西湖项目房间数"), "trim keeps rewrite checkpoint");
assert(!trimmed.includes("正在规划…"), "trim drops the oldest heartbeat first");
assert(
  JSON.stringify(visiblePrepLines(trimmed, { live: false, expanded: true }).map((line) => line.text)) ===
    JSON.stringify(trimmed),
  "expanded trimmed log is the full remaining window",
);

const manyCheckpoints = [
  "正在规划…",
  ...Array.from({ length: PLAN_PREP_LOG_LIMIT + 3 }, (_, index) => `问句已改写为 版本${index}`),
];
const capped = trimPrepLog(manyCheckpoints);
assert(capped.length === PLAN_PREP_LOG_LIMIT, "checkpoint overflow stays within window");
assert(!capped.includes("正在规划…"), "checkpoint overflow still drops heartbeats");
assert(capped[0] === "问句已改写为 版本3", "checkpoint overflow keeps the newest rewrites");

console.log("prepLogModel.test.ts ok");
