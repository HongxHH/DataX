import type { ContextUsageSnapshot } from "../../protocol/events";
import {
  historyChip,
  isHighOccupancy,
  occupancyRatio,
  usageCaption,
  usageHoverTitle,
  waterlinePercent,
} from "./contextUsageModel";

interface ContextUsageMeterProps {
  usage: ContextUsageSnapshot | null | undefined;
  variant?: "header" | "mini";
}

export function ContextUsageMeter({ usage, variant = "header" }: ContextUsageMeterProps) {
  if (!usage || usage.used_input_tokens == null) return null;
  const used = usage.used_input_tokens;
  const window = usage.context_window;
  const ratio = occupancyRatio(used, window);
  const fillPct = ratio == null ? null : ratio * 100;
  const waterline = waterlinePercent(usage.compress_token_limit, window);
  const high = isHighOccupancy(used, window);
  const chip = historyChip(usage.history, usage.compress_kind);
  const caption = usageCaption(usage);
  const title = usageHoverTitle(usage);
  const barClass = [
    "context-usage-bar",
    high ? "is-high" : "",
    chip.tone === "warn" ? "is-compressed" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const bar = (
    <div className={barClass}>
      {fillPct != null ? <span className="context-usage-fill" style={{ width: `${fillPct}%` }} /> : null}
      {waterline != null ? <span className="context-usage-waterline" style={{ left: `${waterline}%` }} /> : null}
    </div>
  );

  if (variant === "mini") {
    return (
      <div className="context-usage-meter is-mini" title={title}>
        {bar}
      </div>
    );
  }

  return (
    <div className="context-usage-meter" title={title} aria-label={`上下文占用 ${caption}`}>
      {bar}
      <span className="context-usage-caption">{caption}</span>
      <span className={`context-usage-chip is-${chip.tone}`}>{chip.label}</span>
    </div>
  );
}
