import { formatTokenCount } from "./contextUsageModel";
import {
  assemblySlots,
  IR_EMPTY_DETAIL,
  type AssemblyScope,
  type AssemblySlot,
  type PromptInventory,
} from "./promptInventoryModel";

interface AssemblyPanelProps {
  inventory: PromptInventory;
  scope?: AssemblyScope;
  heading?: string;
  note?: string;
  compact?: boolean;
}

export function AssemblyPanel({
  inventory,
  scope = "main",
  heading,
  note,
  compact = false,
}: AssemblyPanelProps) {
  const slots = assemblySlots(inventory, scope);
  if (slots.length === 0) return null;
  return (
    <div className={`assembly-panel${compact ? " is-compact" : ""}`}>
      {heading ? (
        <header className="prompt-inventory-head">
          <h3>{heading}</h3>
          {note ? <p>{note}</p> : null}
        </header>
      ) : null}
      {slots.map((slot) => (
        <AssemblySlotView key={slot.kind} slot={slot} inventory={inventory} />
      ))}
    </div>
  );
}

function AssemblySlotView({ slot, inventory }: { slot: AssemblySlot; inventory: PromptInventory }) {
  return (
    <section className="prompt-inventory-section">
      <div className="prompt-inventory-label">
        {slot.title}
        {slot.badge ? <span className="assembly-slot-badge">{slot.badge}</span> : null}
      </div>
      <AssemblySlotBody slot={slot} inventory={inventory} />
    </section>
  );
}

function AssemblySlotBody({ slot, inventory }: { slot: AssemblySlot; inventory: PromptInventory }) {
  if (slot.kind === "parts" && inventory.parts) {
    return (
      <>
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
      </>
    );
  }
  if (slot.kind === "history" && inventory.history) {
    return (
      <div className="prompt-inventory-row">
        <span className={`context-usage-chip is-${inventory.history.chip.tone}`}>
          {inventory.history.chip.label}
        </span>
        <span className="prompt-inventory-copy">{inventory.history.detail}</span>
      </div>
    );
  }
  if (slot.kind === "ir" && inventory.ir) {
    return (
      <>
        {inventory.ir.count === 0 ? (
          <p className="prompt-inventory-empty">{IR_EMPTY_DETAIL}</p>
        ) : inventory.ir.items.length === 0 ? (
          <p className="prompt-inventory-empty">共 {inventory.ir.count} 条，未上报工具名。</p>
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
        {inventory.ir.count > 0 ? (
          <p className="prompt-inventory-copy">
            {inventory.ir.unpacked ? "本轮附带了 IR 解包全文。" : "未解包 IR 全文。"}
          </p>
        ) : null}
      </>
    );
  }
  if (slot.kind === "worker") {
    if (inventory.workers.length === 0) {
      return (
        <p className="prompt-inventory-empty">
          {inventory.source === "packed" ? "系统提示未注入 worker 卡片。" : "本会话还没有子 Agent 委派。"}
        </p>
      );
    }
    return (
      <ul className="prompt-inventory-workers">
        {inventory.workers.map((worker) => (
          <li key={worker.key}>
            <div className="prompt-inventory-worker-head">
              <span className="prompt-inventory-worker-id">
                {worker.sub_id != null ? `#${worker.sub_id}` : "未编号"}
              </span>
              {worker.sub_id != null ? (
                <span className="prompt-inventory-worker-reuse">{worker.resumed ? "复用" : "新建"}</span>
              ) : null}
              {worker.hasError ? <span className="prompt-inventory-worker-error">异常</span> : null}
              <span className="prompt-inventory-worker-label">{worker.label}</span>
              {worker.artifacts.length > 0 ? (
                <span className="prompt-inventory-worker-arts">{worker.artifacts.join(" · ")}</span>
              ) : null}
            </div>
            {worker.summary ? <p className="prompt-inventory-worker-summary">{worker.summary}</p> : null}
          </li>
        ))}
      </ul>
    );
  }
  if (slot.kind === "flags" && inventory.flags) {
    return (
      <p className="prompt-inventory-copy">
        技能 {inventory.flags.skillCount}
        {inventory.flags.hasPlan ? " · 有计划" : " · 无计划"}
        {inventory.flags.hasMemory ? " · 已装入记忆" : " · 未装入记忆"}
      </p>
    );
  }
  if (slot.kind === "recall" && inventory.recall) {
    return <p className="prompt-inventory-copy">{inventory.recall.label}</p>;
  }
  if (slot.kind === "rewrite" && inventory.rewrittenQuery) {
    return <p className="prompt-inventory-copy">{inventory.rewrittenQuery}</p>;
  }
  return null;
}
