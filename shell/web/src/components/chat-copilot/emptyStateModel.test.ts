import { copilotEmptyCopy } from "./emptyStateModel";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

const landcheck = copilotEmptyCopy("landcheck-copilot");
assert(landcheck.title.includes("测绘核对"), "landcheck title");
assert(landcheck.lead.includes("Landcheck"), "landcheck lead");
assert(landcheck.prompts.length >= 4, "landcheck has starter prompts");
assert(
  new Set(landcheck.prompts.map((item) => item.text)).size === landcheck.prompts.length,
  "landcheck prompts unique",
);
assert(
  landcheck.prompts.every((item) => item.tag.trim() && item.text.trim()),
  "landcheck prompts filled",
);
assert(
  landcheck.prompts.some((item) => item.text.includes("项目")),
  "landcheck includes a count question",
);
assert(
  !landcheck.prompts.some((item) => /刚才|上一|报告/.test(item.text)),
  "starters do not assume prior results",
);

const fallback = copilotEmptyCopy("local-dev-react");
assert(fallback !== landcheck, "unknown profile uses fallback");
assert(fallback.prompts.length >= 1, "fallback has a starter");
assert(copilotEmptyCopy(null).title === fallback.title, "null profile uses fallback");
assert(copilotEmptyCopy(undefined).lead === fallback.lead, "undefined profile uses fallback");

console.log("emptyStateModel.test.ts ok");
