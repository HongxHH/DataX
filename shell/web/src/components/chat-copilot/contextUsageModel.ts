import type { ContextCompressKind, ContextHistory, ContextUsageSnapshot } from "../../protocol/events";

const HIGH_OCCUPANCY = 0.8;

export type HistoryChipTone = "ok" | "warn";

export interface HistoryChip {
  label: string;
  tone: HistoryChipTone;
}

export function parseContextUsage(raw: unknown): ContextUsageSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const used = nonNegativeInt(rec.used_input_tokens);
  if (used == null) return null;
  const history = parseHistory(rec.history);
  if (!history) return null;
  const snapshot: ContextUsageSnapshot = { used_input_tokens: used, history };
  const window = positiveInt(rec.context_window);
  if (window != null) snapshot.context_window = window;
  const limit = positiveInt(rec.compress_token_limit);
  if (limit != null) snapshot.compress_token_limit = limit;
  const subId = positiveInt(rec.sub_id);
  if (subId != null) snapshot.sub_id = subId;
  if (history === "compressed") {
    const kind = parseKind(rec.compress_kind);
    if (kind) snapshot.compress_kind = kind;
  }
  const parts = parseParts(rec.parts);
  if (parts) snapshot.parts = parts;
  return snapshot;
}

export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n >= 1000) {
    const kilo = n / 1000;
    if (kilo >= 100 || Number.isInteger(kilo)) return `${Math.round(kilo)}k`;
    return `${kilo.toFixed(1).replace(/\.0$/, "")}k`;
  }
  return String(Math.round(n));
}

export function occupancyRatio(used: number, window: number | undefined): number | null {
  if (window == null || window <= 0 || !Number.isFinite(used) || used < 0) return null;
  return Math.min(1, used / window);
}

export function remainingLabel(used: number, window: number | undefined): string | null {
  const ratio = occupancyRatio(used, window);
  if (ratio == null) return null;
  const remainPct = Math.max(0, Math.round((1 - ratio) * 100));
  return `剩 ${remainPct}%`;
}

export function waterlinePercent(limit: number | undefined, window: number | undefined): number | null {
  if (limit == null || window == null || window <= 0 || limit <= 0) return null;
  return Math.min(100, (limit / window) * 100);
}

export function isHighOccupancy(used: number, window: number | undefined): boolean {
  const ratio = occupancyRatio(used, window);
  return ratio != null && ratio >= HIGH_OCCUPANCY;
}

export function isMainAgentUsage(snapshot: ContextUsageSnapshot): boolean {
  return snapshot.sub_id == null || snapshot.sub_id <= 0;
}

export function historyChip(history: ContextHistory | undefined, kind: ContextCompressKind | undefined): HistoryChip {
  if (history === "compressed" && kind === "ir") {
    return { label: "已压缩（IR）", tone: "warn" };
  }
  if (history === "compressed" && kind === "fold") {
    return { label: "已压缩（折叠）", tone: "warn" };
  }
  if (history === "compressed") {
    return { label: "已压缩", tone: "warn" };
  }
  return { label: "完整", tone: "ok" };
}

export function usageCaption(snapshot: ContextUsageSnapshot): string {
  const used = snapshot.used_input_tokens ?? 0;
  const window = snapshot.context_window;
  if (window == null) return `${formatTokenCount(used)} tokens`;
  const remain = remainingLabel(used, window);
  const base = `${formatTokenCount(used)} / ${formatTokenCount(window)}`;
  return remain ? `${base} · ${remain}` : base;
}

export type UsagePartKey = keyof NonNullable<ContextUsageSnapshot["parts"]>;

export const USAGE_PART_LABELS: Array<[UsagePartKey, string]> = [
  ["system", "系统"],
  ["history", "历史"],
  ["user", "本轮"],
  ["other", "其他"],
];
const PART_KEYS = USAGE_PART_LABELS.map(([key]) => key);

export interface UsagePartShare {
  key: UsagePartKey;
  label: string;
  tokens: number;
  percent: number;
}

export function usagePartShares(snapshot: ContextUsageSnapshot): UsagePartShare[] | null {
  const parts = snapshot.parts;
  if (!parts) return null;
  const total = PART_KEYS.reduce((sum, key) => sum + (parts[key] ?? 0), 0);
  if (total <= 0) return null;
  return USAGE_PART_LABELS.map(([key, label]) => {
    const tokens = parts[key] ?? 0;
    return {
      key,
      label,
      tokens,
      percent: (tokens / total) * 100,
    };
  });
}

export function usagePartsCaption(snapshot: ContextUsageSnapshot): string | null {
  const parts = snapshot.parts;
  if (!parts) return null;
  return USAGE_PART_LABELS.map(([key, label]) => `${label} ${formatTokenCount(parts[key] ?? 0)}`).join(" · ");
}

export function usageHoverTitle(snapshot: ContextUsageSnapshot): string {
  const caption = usageCaption(snapshot);
  const parts = usagePartsCaption(snapshot);
  return parts ? `${caption}\n估算占比：${parts}` : caption;
}

function parseHistory(value: unknown): ContextHistory | null {
  return value === "restore" || value === "compressed" ? value : null;
}

function parseParts(value: unknown): ContextUsageSnapshot["parts"] | null {
  if (!value || typeof value !== "object") return null;
  const rec = value as Record<string, unknown>;
  const out: NonNullable<ContextUsageSnapshot["parts"]> = {};
  let found = false;
  for (const key of PART_KEYS) {
    const n = nonNegativeInt(rec[key]);
    if (n == null) continue;
    out[key] = n;
    found = true;
  }
  if (!found) return null;
  for (const key of PART_KEYS) {
    if (out[key] == null) out[key] = 0;
  }
  return out;
}

function parseKind(value: unknown): ContextCompressKind | null {
  return value === "ir" || value === "fold" ? value : null;
}

function nonNegativeInt(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

function positiveInt(value: unknown): number | null {
  const n = nonNegativeInt(value);
  return n != null && n > 0 ? n : null;
}
