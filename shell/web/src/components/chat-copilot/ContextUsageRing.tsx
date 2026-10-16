import type { ContextUsageSnapshot } from "../../protocol/events";
import {
  historyChip,
  isHighOccupancy,
  occupancyRatio,
  usageCaption,
  usageHoverTitle,
} from "./contextUsageModel";

const SIZE = 28;
const STROKE = 3;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

interface ContextUsageRingProps {
  usage: ContextUsageSnapshot | null | undefined;
  onClick?: () => void;
  /** When true, ring is shown as the active trajectory entry. */
  active?: boolean;
}

/** Cursor-style circular context occupancy control for the composer. */
export function ContextUsageRing({ usage, onClick, active = false }: ContextUsageRingProps) {
  const hasUsage = Boolean(usage && usage.used_input_tokens != null);
  if (!hasUsage && !onClick) return null;

  const used = usage?.used_input_tokens ?? 0;
  const window = usage?.context_window;
  const ratio = hasUsage ? occupancyRatio(used, window) : null;
  const fill = ratio == null ? 0 : Math.min(1, Math.max(0, ratio));
  const high = hasUsage && isHighOccupancy(used, window);
  const chip = hasUsage ? historyChip(usage!.history, usage!.compress_kind) : null;
  const compressed = chip?.tone === "warn";
  const caption = hasUsage ? usageCaption(usage!) : "暂无占用数据";
  const title = hasUsage
    ? `${usageHoverTitle(usage!)}\n点击打开或关闭运行轨迹`
    : "点击打开或关闭运行轨迹";
  const dashOffset = CIRCUMFERENCE * (1 - fill);
  const toneClass = [
    "context-usage-ring",
    high ? "is-high" : "",
    compressed ? "is-compressed" : "",
    onClick ? "is-clickable" : "",
    active ? "is-active" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const body = (
    <>
      <svg
        className="context-usage-ring-svg"
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        aria-hidden="true"
      >
        <circle
          className="context-usage-ring-track"
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          fill="none"
          strokeWidth={STROKE}
        />
        <circle
          className="context-usage-ring-fill"
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          fill="none"
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={dashOffset}
          transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
        />
      </svg>
      <span className="context-usage-ring-pct" aria-hidden="true">
        {ratio == null ? "—" : `${Math.round(fill * 100)}`}
      </span>
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        className={toneClass}
        title={title}
        aria-label={`运行轨迹，上下文占用 ${caption}`}
        aria-pressed={active}
        onClick={onClick}
      >
        {body}
      </button>
    );
  }

  return (
    <div className={toneClass} title={title} aria-label={`上下文占用 ${caption}`}>
      {body}
    </div>
  );
}
