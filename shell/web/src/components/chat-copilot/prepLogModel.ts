export type PrepKind = "checkpoint" | "heartbeat";

export interface PrepLine {
  text: string;
  kind: PrepKind;
  index: number;
}

/** Align with shell/backend session persist (`PLAN_PREP_MAX`). */
export const PLAN_PREP_LOG_LIMIT = 20;

const CHECKPOINT_PREFIXES = ["问句已改写为 ", "跨会话记忆："];

export function prepKind(text: string): PrepKind {
  const trimmed = text.trim();
  if (CHECKPOINT_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) return "checkpoint";
  return "heartbeat";
}

export function classifyPrepLog(items: string[]): PrepLine[] {
  return items.map((text, index) => ({ text, kind: prepKind(text), index }));
}

export function heartbeatCount(items: string[]): number {
  return items.reduce((count, text) => count + (prepKind(text) === "heartbeat" ? 1 : 0), 0);
}

export function trimPrepLog(items: string[], limit = PLAN_PREP_LOG_LIMIT): string[] {
  if (items.length <= limit) return items;
  const lines = classifyPrepLog(items);
  const checkpoints = lines.filter((line) => line.kind === "checkpoint");
  const heartbeats = lines.filter((line) => line.kind === "heartbeat");
  const keep = new Set<number>();
  if (checkpoints.length >= limit) {
    for (const line of checkpoints.slice(-limit)) keep.add(line.index);
  } else {
    for (const line of checkpoints) keep.add(line.index);
    for (const line of heartbeats.slice(-(limit - checkpoints.length))) keep.add(line.index);
  }
  return lines.filter((line) => keep.has(line.index)).map((line) => line.text);
}

export function visiblePrepLines(
  items: string[],
  opts: { live: boolean; expanded: boolean },
): PrepLine[] {
  const lines = classifyPrepLog(items);
  if (opts.expanded) return lines;
  const checkpoints = lines.filter((line) => line.kind === "checkpoint");
  if (!opts.live) return checkpoints;
  const lastHeartbeat = [...lines].reverse().find((line) => line.kind === "heartbeat");
  if (!lastHeartbeat) return checkpoints;
  return [...checkpoints, lastHeartbeat].sort((a, b) => a.index - b.index);
}
