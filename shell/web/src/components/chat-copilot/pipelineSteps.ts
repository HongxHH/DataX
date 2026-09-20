import type { DelegationBlock, RunLogEntry } from "../../types";

export interface PipelineStep {
  label: string;
  detail: string;
  live?: boolean;
}

const SKIP_PREFIX = /^(DA_THINK|DA_DRAFT)\b/;
const DETAIL_MAX = 800;

function clipDetail(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= DETAIL_MAX) return trimmed;
  return `${trimmed.slice(0, DETAIL_MAX)}…`;
}

function parseLogLine(message: string): { label: string; detail: string } | null {
  let raw = message.trim();
  if (raw.startsWith("↳")) raw = raw.slice(1).trim();
  if (!raw || SKIP_PREFIX.test(raw)) return null;
  const colon = raw.indexOf(":");
  if (colon <= 0) return { label: raw, detail: "" };
  const label = raw.slice(0, colon).trim();
  if (!label) return null;
  return { label, detail: raw.slice(colon + 1).trim() };
}

export function pipelineStepsFromLogs(logs: RunLogEntry[] | undefined): PipelineStep[] {
  const steps: PipelineStep[] = [];
  for (const entry of logs ?? []) {
    const parsed = parseLogLine(entry.message ?? "");
    if (!parsed) continue;
    const last = steps.at(-1);
    if (last && last.label === parsed.label) {
      if (parsed.detail && !last.detail.includes(parsed.detail)) {
        last.detail = last.detail ? `${last.detail}\n${parsed.detail}` : parsed.detail;
      }
      continue;
    }
    steps.push({ label: parsed.label, detail: parsed.detail });
  }
  for (const step of steps) {
    if (step.detail) step.detail = clipDetail(step.detail);
  }
  return steps;
}

export function pipelineStepsFromDelegation(block: DelegationBlock): PipelineStep[] {
  const fromLogs = pipelineStepsFromLogs(block.logs);
  const withProduct = fromLogs.filter((step) => step.detail);
  if (withProduct.length > 0) {
    const last = fromLogs.at(-1);
    if (block.status === "running" && last && !last.detail) {
      return [...withProduct, { ...last, live: true }];
    }
    return withProduct;
  }
  const liveLabel = block.current_stage_label?.trim();
  if (block.status === "running" && liveLabel) {
    return [{ label: liveLabel, detail: "", live: true }];
  }
  return [];
}
