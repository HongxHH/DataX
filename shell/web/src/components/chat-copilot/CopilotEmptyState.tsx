import { copilotEmptyCopy } from "./emptyStateModel";

interface CopilotEmptyStateProps {
  profileId?: string | null;
  disabled?: boolean;
  onPickPrompt?: (text: string) => void;
}

export function CopilotEmptyState({
  profileId,
  disabled = false,
  onPickPrompt,
}: CopilotEmptyStateProps) {
  const copy = copilotEmptyCopy(profileId);
  const canPick = Boolean(onPickPrompt) && !disabled;

  return (
    <div className="copilot-empty">
      <div className="copilot-empty-hero">
        <span className="brand-mark" aria-hidden="true" />
        <p className="copilot-empty-kicker">{copy.kicker}</p>
      </div>
      <h3 className="copilot-empty-title">{copy.title}</h3>
      <p className="copilot-empty-lead">{copy.lead}</p>
      <div className="copilot-empty-caps">
        {copy.capabilities.map((cap) => (
          <span key={cap} className="copilot-empty-cap">
            {cap}
          </span>
        ))}
      </div>
      <p className="copilot-empty-prompt-label">试着问</p>
      <div className="copilot-empty-prompts">
        {copy.prompts.map((prompt) => (
          <button
            key={prompt.text}
            type="button"
            className="copilot-empty-prompt"
            disabled={!canPick}
            onClick={() => onPickPrompt?.(prompt.text)}
          >
            <span className="copilot-empty-prompt-tag">{prompt.tag}</span>
            <span className="copilot-empty-prompt-text">{prompt.text}</span>
          </button>
        ))}
      </div>
      <p className="copilot-empty-hint">点选示例填入下方输入框，Enter 发送</p>
    </div>
  );
}
