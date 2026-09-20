import { useEffect, useRef, useState } from "react";
import { CopyIcon, IconButton } from "./IconButton";

interface CopyTextButtonProps {
  text: string;
  idleLabel: string;
  copiedLabel?: string;
  className?: string;
}

export function CopyTextButton({
  text,
  idleLabel,
  copiedLabel = "已复制",
  className,
}: CopyTextButtonProps) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef(0);
  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  const copy = async () => {
    const value = text.trim();
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };

  return (
    <IconButton
      className={className}
      label={copied ? copiedLabel : idleLabel}
      active={copied}
      onClick={copy}
    >
      <CopyIcon />
    </IconButton>
  );
}
