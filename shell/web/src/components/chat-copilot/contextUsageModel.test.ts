import {
  formatTokenCount,
  historyChip,
  isHighOccupancy,
  isMainAgentUsage,
  occupancyRatio,
  parseContextUsage,
  remainingLabel,
  usageCaption,
  usageHoverTitle,
  usagePartShares,
  waterlinePercent,
} from "./contextUsageModel";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

assert(formatTokenCount(12) === "12", "small tokens");
assert(formatTokenCount(12400) === "12.4k", "12.4k");
assert(formatTokenCount(131072) === "131k", "large window");
assert(occupancyRatio(12400, 131072) != null, "ratio present");
assert(remainingLabel(12400, 131072) === "剩 91%", remainingLabel(12400, 131072) ?? "");
assert(remainingLabel(100, undefined) === null, "no percent without window");
assert(waterlinePercent(32768, 131072) != null, "waterline");
assert(isHighOccupancy(120000, 131072) === true, "high occupancy");
assert(isHighOccupancy(1000, 131072) === false, "low occupancy");
assert(historyChip("restore", undefined).label === "完整", "restore chip");
assert(historyChip("compressed", "ir").label === "已压缩（IR）", "ir chip");
assert(historyChip("compressed", "fold").tone === "warn", "fold warn");
assert(historyChip("compressed", undefined).label === "已压缩", "compressed without kind");

const parsed = parseContextUsage({
  used_input_tokens: 80,
  history: "compressed",
  compress_kind: "fold",
  context_window: 64000,
  content: "secret",
});
assert(parsed?.used_input_tokens === 80, "parse used");
assert(parsed?.history === "compressed", "parse history");
assert(parseContextUsage({ history: "restore" }) === null, "require used tokens");
assert(!JSON.stringify(parsed).includes("secret"), "no prompt leak");
assert(usageCaption({ used_input_tokens: 80, history: "restore" }) === "80 tokens", "no window caption");

const sub = parseContextUsage({
  used_input_tokens: 40,
  history: "restore",
  sub_id: 3,
});
assert(sub?.sub_id === 3, "keep sub_id for main-bar filter");
assert(isMainAgentUsage(sub!) === false, "sub is not main");
assert(isMainAgentUsage({ used_input_tokens: 1, history: "restore" }) === true, "omit sub_id is main");

const withParts = parseContextUsage({
  used_input_tokens: 100,
  history: "restore",
  context_window: 1000,
  parts: { system: 40, history: 30, user: 10, other: 20, prompt: "secret" },
});
assert(withParts?.parts?.system === 40, "parse system part");
assert(withParts?.parts?.history === 30, "parse history part");
assert(withParts?.parts?.user === 10, "parse user part");
assert(withParts?.parts?.other === 20, "parse other part");
assert(!JSON.stringify(withParts).includes("secret"), "parts drop unknown keys");
assert(
  usageCaption(withParts!) === "100 / 1k · 剩 90%",
  `visible caption unchanged: ${usageCaption(withParts!)}`,
);
assert(
  usageHoverTitle(withParts!).includes("估算占比：系统 40 · 历史 30 · 本轮 10 · 其他 20"),
  usageHoverTitle(withParts!),
);
assert(
  usageHoverTitle({ used_input_tokens: 80, history: "restore" }) === "80 tokens",
  "old snapshot hover equals caption",
);

const shares = usagePartShares(withParts!);
assert(shares?.length === 4, "four part shares");
assert(shares?.[0].percent === 40, "system percent");
assert(usagePartShares({ used_input_tokens: 10, history: "restore" }) === null, "no shares without parts");

console.log("contextUsageModel.test.ts ok");
