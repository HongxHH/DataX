import { useEffect, useMemo, useRef, useState } from "react";
import type { ContextUsageSnapshot, PromptInventorySnapshot } from "../../protocol/events";
import type { ChatMessage, DelegationBlock } from "../../types";
import { ContextUsageMeter } from "./ContextUsageMeter";
import { formatTokenCount, historyChip, usageCaption } from "./contextUsageModel";
import {
  buildPromptInventory,
  resolveInventoryPrepLog,
  resolvePackedInventory,
  resolveRewrittenQuery,
} from "./promptInventoryModel";

interface PromptInventoryControlProps {
  usage: ContextUsageSnapshot | null | undefined;
  packed?: PromptInventorySnapshot | null;
  messages: ChatMessage[];
  activeTurn?: ChatMessage | null;
  liveDelegations: DelegationBlock[];
  livePrepLog: string[];
  live?: boolean;
}

export function PromptInventoryControl({
  usage,
  packed,
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
        prepLog: resolveInventoryPrepLog(messages, activeTurn, livePrepLog, live),
        rewrittenQuery: resolveRewrittenQuery(messages, activeTurn),
      }),
    [usage, resolvedPacked, liveDelegations, messages, activeTurn, livePrepLog, live],
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
          <header className="prompt-inventory-head">
            <h3>本轮装入 Planner</h3>
            <p>{packedNote}</p>
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

          {inventory.ir ? (
            <section className="prompt-inventory-section">
              <div className="prompt-inventory-label">IR</div>
              {inventory.ir.count === 0 ? (
                <p className="prompt-inventory-empty">本轮未把工具结果换成 IR 摘要。</p>
              ) : (
                <ul className="prompt-inventory-ir">
                  {inventory.ir.items.map((item, index) => (
                    <li key={`${item.tool || "ir"}-${index}`}>
                      <span className="prompt-inventory-ir-tool">{item.tool || "工具"}</span>
                      {item.nodes && item.nodes.length > 0 ? (
                        <span className="prompt-inventory-ir-nodes">{item.nodes.join(" · ")}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              <p className="prompt-inventory-copy">
                {inventory.ir.unpacked ? "本轮附带了 IR 解包全文。" : "未解包 IR 全文。"}
              </p>
            </section>
          ) : null}

          <section className="prompt-inventory-section">
            <div className="prompt-inventory-label">Worker</div>
            {inventory.workers.length === 0 ? (
              <p className="prompt-inventory-empty">
                {inventory.source === "packed"
                  ? "系统提示未注入 worker 卡片。"
                  : "本会话还没有子 Agent 委派。"}
              </p>
            ) : (
              <ul className="prompt-inventory-workers">
                {inventory.workers.map((worker) => (
                  <li key={worker.key}>
                    <span className="prompt-inventory-worker-id">
                      {worker.sub_id != null ? `#${worker.sub_id}` : "未编号"}
                    </span>
                    {inventory.source === "inferred" ? (
                      <span className="prompt-inventory-worker-reuse">
                        {worker.resumed ? "复用" : "新建"}
                      </span>
                    ) : null}
                    {worker.hasError ? (
                      <span className="prompt-inventory-worker-error">异常</span>
                    ) : null}
                    <span className="prompt-inventory-worker-label">{worker.label}</span>
                    {worker.artifacts.length > 0 ? (
                      <span className="prompt-inventory-worker-arts">{worker.artifacts.join(" · ")}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {inventory.flags ? (
            <section className="prompt-inventory-section">
              <div className="prompt-inventory-label">其它槽位</div>
              <p className="prompt-inventory-copy">
                技能 {inventory.flags.skillCount}
                {inventory.flags.hasPlan ? " · 有计划" : " · 无计划"}
                {inventory.flags.hasMemory ? " · 已装入记忆" : " · 未装入记忆"}
              </p>
            </section>
          ) : null}

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
