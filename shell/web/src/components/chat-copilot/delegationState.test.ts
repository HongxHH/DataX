import {
  appendDelegationThinking,
  clipThinkingTail,
  collectVisibleDelegations,
  failOpenDelegations,
  finalizeDelegations,
  interruptedDelegationReason,
  mergeDelegationThinking,
  THINKING_CLIP_MAX,
} from "./delegationState";
import type { DelegationBlock } from "../../types";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const running: DelegationBlock = {
  tool_call_id: "call-1",
  tool_name: "sub_agent_tool",
  label: "Landcheck NL2SQL",
  status: "running",
  started_at: 1_000,
  stages: [{ stage: "validating", label: "正在校验 SQL", status: "active" }],
  current_stage_label: "正在校验 SQL",
};

const done = finalizeDelegations([running]);
assert(done[0].status === "done", "success finalize marks done");
assert(done[0].stages?.[0].status === "done", "success finalize closes stages");

const failed = failOpenDelegations([running], undefined, 1_000 + 9 * 60_000);
assert(failed[0].status === "error", "fail-open marks error not done");
assert(failed[0].error === "已运行 9 分钟后连接中断", "fail-open duration copy");
assert(failed[0].current_stage_label === undefined, "fail-open drops live stage label");

const alreadyDone: DelegationBlock = { ...running, status: "done" };
assert(failOpenDelegations([alreadyDone])[0].status === "done", "done stays done");

const alreadyError: DelegationBlock = { ...running, status: "error", error: "安全校验" };
assert(failOpenDelegations([alreadyError])[0].error === "安全校验", "existing error kept");

assert(interruptedDelegationReason(undefined) === "已运行 1 分钟后连接中断", "missing start");

assert(clipThinkingTail("") === "", "empty thinking stays empty");
assert(clipThinkingTail("短推理") === "短推理", "short thinking is unchanged");
const head = "H".repeat(80);
const tail = "最新结论：YEAR 被拒后正在改写";
const longThinking = `${head}${"x".repeat(THINKING_CLIP_MAX)}${tail}`;
const clipped = clipThinkingTail(longThinking);
assert(clipped.startsWith("…"), "oversize thinking gets an ellipsis prefix");
assert(clipped.endsWith(tail), "oversize thinking keeps the latest tail");
assert(clipped.length === THINKING_CLIP_MAX, "clipped thinking stays within the cap");
assert(!clipped.includes("H"), "oversize thinking drops the stale head");

const grown = appendDelegationThinking(
  { ...running, sub_thinking: "x".repeat(THINKING_CLIP_MAX) },
  "尾部token",
);
assert(grown.sub_thinking?.startsWith("…") === true, "append clips with ellipsis");
assert(grown.sub_thinking?.endsWith("尾部token") === true, "append keeps the newest tokens");

const merged = mergeDelegationThinking(
  [{ ...running, status: "done", sub_thinking: "旧开头" }],
  [{ ...running, sub_thinking: longThinking }],
);
assert(merged[0].sub_thinking?.endsWith(tail) === true, "merge keeps live tail");

const collected = collectVisibleDelegations(
  [
    {
      role: "user",
      delegations: [{ tool_call_id: "skip", tool_name: "sub_agent_tool", label: "ignore" }],
    },
    {
      role: "assistant",
      delegations: [{ tool_call_id: "old-call", tool_name: "sub_agent_tool", label: "Landcheck NL2SQL", sub_id: 1 }],
    },
  ],
  {
    delegations: [{ tool_call_id: "live-call", tool_name: "sub_agent_tool", label: "Landcheck Plot", sub_id: 2 }],
  },
);
assert(collected.length === 2, "assistant plus live delegations");
assert(collected.some((block) => block.tool_call_id === "old-call"), "keeps earlier turn");
assert(collected.some((block) => block.tool_call_id === "live-call"), "keeps live turn");
assert(!collected.some((block) => block.tool_call_id === "skip"), "user-role delegations stay out");

console.log("delegationState.test.ts ok");
