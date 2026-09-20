import { workspaceFileUrl } from "../../api/rest";
import { fileBaseName } from "../shared/pathUtils";

/** Strip planner boilerplate; keep readable plain text for Copilot assistant bubbles. */

export function normalizeCopilotSummary(raw: string): string {
  let text = raw.trim();
  text = text.replace(/^\s*\*\*planner:\*\*\s*/i, "");
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  return text.trim();
}

const PATH_PATTERN =
  String.raw`(?:[A-Za-z]:\\(?:[^\s\\/:*?"<>|]+\\)+|~?(?:\/[\w.\-]+)+\/)[^\s\\/:*?"<>|]+\.(?:sql|csv|png|jpe?g|gif|webp|svg|md|json|txt|html?)`;

export type SummaryPart = { type: "text" | "path"; value: string };

export function splitSummaryWithPaths(text: string): SummaryPart[] {
  const parts: SummaryPart[] = [];
  const re = new RegExp(PATH_PATTERN, "gi");
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) {
      parts.push({ type: "text", value: text.slice(last, match.index) });
    }
    parts.push({ type: "path", value: match[0] });
    last = match.index + match[0].length;
  }
  if (last < text.length) {
    parts.push({ type: "text", value: text.slice(last) });
  }
  return parts.length > 0 ? parts : [{ type: "text", value: text }];
}

interface CopilotTurnSummaryProps {
  content: string;
  className?: string;
  sessionId?: string | null;
  onOpenPath?: (path: string) => void;
}

export function CopilotTurnSummary({
  content,
  className,
  sessionId,
  onOpenPath,
}: CopilotTurnSummaryProps) {
  const text = normalizeCopilotSummary(content);
  if (!text) return null;
  const parts = splitSummaryWithPaths(text);
  return (
    <div className={className ?? "message-content turn-summary"}>
      {parts.map((part, idx) => {
        if (part.type !== "path") {
          return <span key={idx}>{part.value}</span>;
        }
        const href = workspaceFileUrl(sessionId, part.value);
        const label = fileBaseName(part.value);
        if (!href && !onOpenPath) {
          return <span key={idx}>{label}</span>;
        }
        return (
          <a
            key={idx}
            className="turn-summary-file"
            href={href ?? undefined}
            title={part.value}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => {
              if (!onOpenPath) return;
              if (event.metaKey || event.ctrlKey) return;
              event.preventDefault();
              onOpenPath(part.value);
            }}
          >
            {label}
          </a>
        );
      })}
    </div>
  );
}
