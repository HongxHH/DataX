import { formatTokenCount, type UsagePartShare } from "./contextUsageModel";

interface PromptPartsBarProps {
  parts: UsagePartShare[];
  className?: string;
}

export function PromptPartsBar({ parts, className }: PromptPartsBarProps) {
  return (
    <div className={className ? `prompt-parts-bar ${className}` : "prompt-parts-bar"}>
      <div className="prompt-inventory-part-bar" aria-hidden="true">
        {parts
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
        {parts.map((part) => (
          <li key={part.key}>
            <span className={`prompt-inventory-swatch is-${part.key}`} />
            {part.label} {formatTokenCount(part.tokens)}
          </li>
        ))}
      </ul>
    </div>
  );
}
