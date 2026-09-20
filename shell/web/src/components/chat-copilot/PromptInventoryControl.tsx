import { useEffect, useMemo, useRef, useState } from "react";
import type { ContextUsageSnapshot } from "../../protocol/events";
import type { ChatMessage, DelegationBlock } from "../../types";
import { ContextUsageMeter } from "./ContextUsageMeter";
import { formatTokenCount, historyChip, usageCaption } from "./contextUsageModel";
import {
  buildPromptInventory,
  resolveInventoryPrepLog,
  resolveRewrittenQuery,
} from "./promptInventoryModel";

interface PromptInventoryControlProps {
  usage: ContextUsageSnapshot | null | undefined;
  messages: ChatMessage[];
  activeTurn?: ChatMessage | null;
  liveDelegations: DelegationBlock[];
  livePrepLog: string[];
  live?: boolean;
}

export function PromptInventoryControl({
  usage,
  messages,
  activeTurn,
  liveDelegations,
  livePrepLog,
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

  const inventory = useMemo(
    () =>
      buildPromptInventory({
        usage,
        delegations: liveDelegations,
        prepLog: resolveInventoryPrepLog(messages, activeTurn, livePrepLog, live),
        rewrittenQuery: resolveRewrittenQuery(messages, activeTurn),
      }),
    [usage, liveDelegations, messages, activeTurn, livePrepLog, live],
  );

  if (!usage || usage.used_input_tokens == null) return null;
  const chip = historyChip(usage.history, usage.compress_kind);

  return (
    <div className="prompt-inventory" ref={rootRef}>
      <button
        type="button"
        className={`prompt-inventory-trigger${open ? " is-open" : ""}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls="prompt-inventory-popover"
        aria-label={`本轮装入 Planner，${usageCaption(usage)}，${chip.label}`}
        title="查看本轮装入 Planner 的内容"
        onClick={() => setOpen((value) => !value)}
      >
        <ContextUsageMeter usage={usage} />
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
          <header className="prompt-inventory-head">
            <h3>本轮装入 Planner</h3>
            <p>由占用事件、委派卡片和准备日志推断，不是整份提示词。</p>
          </header>

          {inventory.parts ? (
            <section className="prompt-inventory-section">
              <div className="prompt-inventory-label">分块</div>
              <div className="prompt-inventory-part-bar" aria-hidden="true">
                {inventory.parts
                  .filter((part) => part.percent > 0)
                  .map((part) => (
                    <span
                      key={part.key}
                      className={`prompt-inventory-part is-${part.key}`}
                      style={{ width: `${part.percent}%` }}
                    />
                  ))}
              </div>
              <ul className="prompt-inventory-legend">
                {inventory.parts.map((part) => (
                  <li key={part.key}>
                    <span className={`prompt-inventory-swatch is-${part.key}`} />
                    {part.label} {formatTokenCount(part.tokens)}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {inventory.history ? (
            <section className="prompt-inventory-section">
              <div className="prompt-inventory-label">历史</div>
              <div className="prompt-inventory-row">
                <span className={`context-usage-chip is-${inventory.history.chip.tone}`}>
                  {inventory.history.chip.label}
                </span>
                <span className="prompt-inventory-copy">{inventory.history.detail}</span>
              </div>
            </section>
          ) : null}

          <section className="prompt-inventory-section">
            <div className="prompt-inventory-label">Worker</div>
            {inventory.workers.length === 0 ? (
              <p className="prompt-inventory-empty">本会话还没有子 Agent 委派。</p>
            ) : (
              <ul className="prompt-inventory-workers">
                {inventory.workers.map((worker) => (
                  <li key={worker.key}>
                    <span className="prompt-inventory-worker-id">
                      {worker.sub_id != null ? `#${worker.sub_id}` : "未编号"}
                    </span>
                    <span className="prompt-inventory-worker-reuse">
                      {worker.resumed ? "复用" : "新建"}
                    </span>
                    <span className="prompt-inventory-worker-label">{worker.label}</span>
                    {worker.artifacts.length > 0 ? (
                      <span className="prompt-inventory-worker-arts">{worker.artifacts.join(" · ")}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {inventory.recall ? (
            <section className="prompt-inventory-section">
              <div className="prompt-inventory-label">召回</div>
              <p className="prompt-inventory-copy">{inventory.recall.label}</p>
            </section>
          ) : null}

          {inventory.rewrittenQuery ? (
            <section className="prompt-inventory-section">
              <div className="prompt-inventory-label">问句改写</div>
              <p className="prompt-inventory-copy">{inventory.rewrittenQuery}</p>
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
