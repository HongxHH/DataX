import { pipelineStepsFromDelegation, pipelineStepsFromLogs } from "./pipelineSteps";
import type { DelegationBlock } from "../../types";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const logs = [
  { message: "↳ Perceptor", level: "stage" as const },
  { message: "↳ Perceptor: CREATE TABLE `project` (", level: "stage" as const },
  { message: "DA_DRAFT\tgenerator", level: "info" as const },
  { message: "↳ Generator", level: "stage" as const },
  {
    message: "↳ Generator: SELECT COUNT(`id`) AS `n` FROM `project`",
    level: "stage" as const,
  },
  { message: "↳ Validator: Score: 1.00, Issues: []", level: "stage" as const },
  { message: "↳ Final Result: row_count=1 confidence=1.00", level: "stage" as const },
];

const steps = pipelineStepsFromLogs(logs);
assert(steps.map((step) => step.label).join("|") === "Perceptor|Generator|Validator|Final Result", "labels");
assert(steps[0].detail.includes("CREATE TABLE `project`"), "perceptor payload");
assert(steps[1].detail.includes("SELECT COUNT"), "generator payload");
assert(steps[2].detail.includes("Score: 1.00"), "validator payload");
assert(!steps.some((step) => step.label.startsWith("DA_")), "skip DA_ lines");

const running: DelegationBlock = {
  tool_call_id: "c1",
  status: "running",
  current_stage_label: "正在生成 SQL",
  logs: [{ message: "↳ Perceptor: CREATE TABLE `project` (" }],
};
const liveSteps = pipelineStepsFromDelegation(running);
assert(liveSteps[0].detail.includes("project"), "keeps products while running");

const emptyStages: DelegationBlock = {
  tool_call_id: "c2",
  status: "done",
  stages: [{ stage: "generating", label: "正在生成 SQL", status: "done" }],
};
assert(pipelineStepsFromDelegation(emptyStages).length === 0, "done stages without logs are not products");

console.log("pipelineSteps.test.ts ok");
