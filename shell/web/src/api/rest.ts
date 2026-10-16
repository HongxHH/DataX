import type {
  PromptMessage,
  TrajectoryGroup,
} from "../components/chat-copilot/trajectoryModel";
import type { HealthResponse, ProfileInfo, SwitchProfileResponse } from "../protocol/events";
import type { SessionDetail, SessionSummary } from "../types";

const API_BASE = "/api";

export async function fetchHealth(): Promise<HealthResponse> {
  const res = await fetch(`${API_BASE}/health`);
  if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
  return res.json();
}

export async function listProfiles(): Promise<{ profiles: ProfileInfo[]; current: ProfileInfo }> {
  const res = await fetch(`${API_BASE}/profiles`);
  if (!res.ok) throw new Error(`List profiles failed: ${res.status}`);
  return res.json();
}

export async function switchProfile(profileId: string): Promise<SwitchProfileResponse> {
  const res = await fetch(`${API_BASE}/profile/switch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profile_id: profileId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(String((err as { detail?: string }).detail ?? res.status));
  }
  return res.json();
}

export async function listSessions(): Promise<SessionSummary[]> {
  const res = await fetch(`${API_BASE}/sessions`);
  if (!res.ok) throw new Error(`List sessions failed: ${res.status}`);
  const data = await res.json();
  return data.sessions ?? [];
}

export async function createSession(): Promise<SessionDetail> {
  const res = await fetch(`${API_BASE}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(`Create session failed: ${res.status}`);
  const data = await res.json();
  return data.session;
}

export async function getSession(sessionId: string): Promise<SessionDetail> {
  const res = await fetch(`${API_BASE}/sessions/${sessionId}`);
  if (!res.ok) throw new Error(`Get session failed: ${res.status}`);
  const data = await res.json();
  return data.session;
}

export async function deleteSession(sessionId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/sessions/${sessionId}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Delete session failed: ${res.status}`);
  }
}

export async function fetchTrajectory(sessionId: string): Promise<TrajectoryGroup[]> {
  const res = await fetch(`${API_BASE}/sessions/${encodeURIComponent(sessionId)}/trajectory`);
  if (!res.ok) throw new Error(`Get trajectory failed: ${res.status}`);
  const data = await res.json();
  return Array.isArray(data.groups) ? data.groups : [];
}

export interface TrajectoryPromptDetail {
  file: string;
  chunk_index: number;
  event_index: number;
  truncated: boolean;
  prompt_messages?: PromptMessage[];
  prompt?: string;
}

export async function fetchTrajectoryPrompt(
  sessionId: string,
  file: string,
  eventIndex: number,
  chunkIndex = 0,
): Promise<TrajectoryPromptDetail> {
  const params = new URLSearchParams({
    file,
    event_index: String(eventIndex),
    chunk_index: String(chunkIndex),
  });
  const res = await fetch(
    `${API_BASE}/sessions/${encodeURIComponent(sessionId)}/trajectory/prompt?${params.toString()}`,
  );
  if (!res.ok) throw new Error(`Get trajectory prompt failed: ${res.status}`);
  return res.json();
}

export function workspaceFileUrl(
  sessionId: string | null | undefined,
  filePath?: string,
): string | null {
  if (!sessionId || !filePath) return null;
  const params = new URLSearchParams({ session_id: sessionId, path: filePath });
  return `/api/workspace-file?${params.toString()}`;
}

export interface MemorySessionCard {
  kind: "snapshot";
  session_id: string;
  is_current?: boolean;
  session_summary: string;
  goals_count: number;
  decisions_count: number;
  findings_count: number;
  mtime?: number | null;
}

export interface MemoryCatalog {
  user_id: string;
  sessions: MemorySessionCard[];
  has_memory_md: boolean;
  has_profile: boolean;
}

export interface MemorySnapshotDetail {
  kind: "snapshot";
  session_id: string;
  path: string;
  snapshot: {
    session_summary: string;
    goals: string[];
    constraints: string[];
    decisions: string[];
    important_findings: string[];
    artifacts: string[];
  };
}

export interface MemoryMarkdownDetail {
  kind: "memory_md";
  path: string;
  content: string;
}

export interface MemoryProfileDetail {
  kind: "profile";
  path: string;
  profile: Record<string, unknown>;
}

export interface MemoryRecallHit {
  session_id: string;
  score: number;
  would_pack: boolean;
  preview: string;
  overlap_tokens?: string[];
  reject_reason?: string | null;
}

export interface MemoryRecallTrial {
  query: string;
  top_k: number;
  max_chars: number;
  hit_count: number;
  hits: MemoryRecallHit[];
  packed: string;
  query_tokens?: string[];
  threshold?: number;
  miss_summary?: string;
}

export async function fetchMemoryCatalog(currentSessionId?: string | null): Promise<MemoryCatalog> {
  const params = new URLSearchParams();
  if (currentSessionId) params.set("current_session_id", currentSessionId);
  const qs = params.toString();
  const res = await fetch(`${API_BASE}/memory/catalog${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error(`Get memory catalog failed: ${res.status}`);
  return res.json();
}

export async function fetchMemorySnapshot(sessionId: string): Promise<MemorySnapshotDetail> {
  const res = await fetch(`${API_BASE}/memory/sessions/${encodeURIComponent(sessionId)}/snapshot`);
  if (!res.ok) throw new Error(`Get snapshot failed: ${res.status}`);
  return res.json();
}

export async function fetchMemoryIndex(): Promise<MemoryMarkdownDetail> {
  const res = await fetch(`${API_BASE}/memory/index`);
  if (!res.ok) throw new Error(`Get MEMORY.md failed: ${res.status}`);
  return res.json();
}

export async function fetchMemoryProfile(): Promise<MemoryProfileDetail> {
  const res = await fetch(`${API_BASE}/memory/profile`);
  if (!res.ok) throw new Error(`Get profile failed: ${res.status}`);
  return res.json();
}

export async function trialMemoryRecall(
  query: string,
  currentSessionId?: string | null,
): Promise<MemoryRecallTrial> {
  const res = await fetch(`${API_BASE}/memory/recall-trial`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      ...(currentSessionId ? { current_session_id: currentSessionId } : {}),
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(String((err as { detail?: string }).detail ?? res.status));
  }
  return res.json();
}
