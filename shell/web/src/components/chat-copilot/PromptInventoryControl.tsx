import { useEffect, useMemo, useRef, useState } from "react";
import type { ContextUsageSnapshot, PromptInventorySnapshot } from "../../protocol/events";
import type { ChatMessage, DelegationBlock } from "../../types";
import { AssemblyPanel } from "./AssemblyPanel";
import { ContextUsageMeter } from "./ContextUsageMeter";
import { historyChip, usageCaption } from "./contextUsageModel";
import {
  buildPromptInventory,
  resolveInventoryPrepLog,
  resolvePackedInventory,
  resolvePlanTools,
  resolveRewrittenQuery,
} from "./promptInventoryModel";
import type { PlanToolItem } from "../../protocol/events";

interface PromptInventoryControlProps {
  usage: ContextUsageSnapshot | null | undefined;
  packed?: PromptInventorySnapshot | null;
  messages: ChatMessage[];
  activeTurn?: ChatMessage | null;
  liveDelegations: DelegationBlock[];
  livePrepLog: string[];
  livePlanTools?: PlanToolItem[];
  live?: boolean;
}

export function PromptInventoryControl({
  usage,
  packed,
  messages,
  activeTurn,
  liveDelegations,
  livePrepLog,
  livePlanTools = [],
  live = false,
}: PromptInventoryControlProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const resolvedPacked = useMemo(
    () => resolvePackedInventory(messages, activeTurn, packed),
    [messages, activeTurn, packed],
  );

  const inventory = useMemo(
    () =>
      buildPromptInventory({
        usage,
        packed: resolvedPacked,
        delegations: liveDelegations,
        planTools: resolvePlanTools(messages, activeTurn, live ? livePlanTools : []),
        messages,
        activeTurn,
        live,
        prepLog: resolveInventoryPrepLog(messages, activeTurn, livePrepLog, live),
        rewrittenQuery: resolveRewrittenQuery(messages, activeTurn),
      }),
    [usage, resolvedPacked, liveDelegations, livePlanTools, messages, activeTurn, livePrepLog, live],
  );

  if (!usage && !resolvedPacked) return null;
  const chip = historyChip(usage?.history, usage?.compress_kind);
  const caption = usage ? usageCaption(usage) : "已组装";
  const packedNote =
    inventory.source === "packed"
      ? "来自本次组装的 Planner 消息清单，不含提示词正文。"
      : "由占用事件、委派卡片和准备日志推断，不是整份提示词。";

  return (
    <div className="prompt-inventory" ref={rootRef}>
      <button
        type="button"
        className={`prompt-inventory-trigger${open ? " is-open" : ""}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls="prompt-inventory-popover"
        aria-label={`本轮装入 Planner，${caption}，${chip.label}`}
        title="查看本轮装入 Planner 的内容"
        onClick={() => setOpen((value) => !value)}
      >
        {usage ? (
          <ContextUsageMeter usage={usage} />
        ) : (
          <span className="prompt-inventory-waiting">已组装</span>
        )}
        <span className="prompt-inventory-caret" aria-hidden="true">
          {open ? "▴" : "▾"}
        </span>
      </button>
      {open ? (
        <div
          id="prompt-inventory-popover"
          className="prompt-inventory-popover"
          role="dialog"
          aria-label="本轮装入 Planner"
        >
          <AssemblyPanel
            inventory={inventory}
            scope="main"
            heading="本轮装入 Planner"
            note={packedNote}
          />
        </div>
      ) : null}
    </div>
  );
}
