import {
  assemblySlots,
  IR_EMPTY_DETAIL,
  type AssemblyScope,
  type AssemblySlot,
  type PromptInventory,
} from "./promptInventoryModel";
import { PromptPartsBar } from "./PromptPartsBar";
import { splitRecallCheckpoint } from "./prepLogModel";
import { firstPackedSessionId } from "./memoryDeskModel";

interface AssemblyPanelProps {
  inventory: PromptInventory;
  scope?: AssemblyScope;
  heading?: string;
  note?: string;
  compact?: boolean;
  /** Jump to packed Cross-Session Memories in the prompt list (trajectory). */
  onRevealRecallFull?: () => void;
  /** Open the memory desk, optionally focused on a snapshot. */
  onOpenMemoryDesk?: (sessionId?: string) => void;
}

export function AssemblyPanel({
  inventory,
  scope = "main",
  heading,
  note,
  compact = false,
  onRevealRecallFull,
  onOpenMemoryDesk,
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
        <AssemblySlotView
          key={slot.kind}
          slot={slot}
          inventory={inventory}
          onRevealRecallFull={onRevealRecallFull}
          onOpenMemoryDesk={onOpenMemoryDesk}
        />
      ))}
    </div>
  );
}

function AssemblySlotView({
  slot,
  inventory,
  onRevealRecallFull,
  onOpenMemoryDesk,
}: {
  slot: AssemblySlot;
  inventory: PromptInventory;
  onRevealRecallFull?: () => void;
  onOpenMemoryDesk?: (sessionId?: string) => void;
}) {
  const showLabel = slot.kind !== "parts";
  return (
    <section className="prompt-inventory-section">
      {showLabel ? (
        <div className="prompt-inventory-label">
          {slot.title}
          {slot.badge ? <span className="assembly-slot-badge">{slot.badge}</span> : null}
        </div>
      ) : null}
      <AssemblySlotBody
        slot={slot}
        inventory={inventory}
        onRevealRecallFull={onRevealRecallFull}
        onOpenMemoryDesk={onOpenMemoryDesk}
      />
    </section>
  );
}

function AssemblySlotBody({
  slot,
  inventory,
  onRevealRecallFull,
  onOpenMemoryDesk,
}: {
  slot: AssemblySlot;
  inventory: PromptInventory;
  onRevealRecallFull?: () => void;
  onOpenMemoryDesk?: (sessionId?: string) => void;
}) {
  if (slot.kind === "parts" && inventory.parts) {
    return <PromptPartsBar parts={inventory.parts} />;
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
    const split = splitRecallCheckpoint(inventory.recall.label);
    const reveal = onRevealRecallFull ? (
      <button
        type="button"
        className="prompt-inventory-recall-more"
        title="在下方提示词中查看装入的完整 Cross-Session Memories"
        aria-label="查看召回全文"
        onClick={onRevealRecallFull}
      >
        ···
      </button>
    ) : null;
    const jumpId = firstPackedSessionId(split?.preview ?? "");
    const desk = onOpenMemoryDesk ? (
      <button
        type="button"
        className="prompt-inventory-recall-link"
        title="在召回台对照本轮装入的 snapshot"
        onClick={() => onOpenMemoryDesk(jumpId)}
      >
        召回台
      </button>
    ) : null;
    const headline = split?.headline || inventory.recall.label;
    if (onRevealRecallFull || onOpenMemoryDesk || !split?.preview) {
      return (
        <div className="prompt-inventory-recall">
          <p className="prompt-inventory-copy">
            {onRevealRecallFull || onOpenMemoryDesk ? headline : inventory.recall.label}
            {reveal}
            {desk}
          </p>
        </div>
      );
    }
    return (
      <div className="prompt-inventory-recall">
        <p className="prompt-inventory-copy">{split.headline}</p>
        <details className="prompt-inventory-recall-preview">
          <summary>召回预览</summary>
          <pre>{split.preview}</pre>
        </details>
      </div>
    );
  }
  if (slot.kind === "rewrite" && inventory.rewrittenQuery) {
    return <p className="prompt-inventory-copy">{inventory.rewrittenQuery}</p>;
  }
  return null;
}
