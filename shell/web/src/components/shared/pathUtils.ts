export function fileBaseName(path?: string): string {
  const raw = String(path || "").replace(/\\/g, "/");
  const parts = raw.split("/");
  return parts[parts.length - 1] || raw;
}

export function sameFsPath(a: string, b: string): boolean {
  return (
    a.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() ===
    b.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
  );
}

export function logTime(): string {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}
