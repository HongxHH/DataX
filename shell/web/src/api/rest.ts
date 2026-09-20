import type { TrajectoryGroup } from "../components/chat-copilot/trajectoryModel";
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

export function workspaceFileUrl(
  sessionId: string | null | undefined,
  filePath?: string,
): string | null {
  if (!sessionId || !filePath) return null;
  const params = new URLSearchParams({ session_id: sessionId, path: filePath });
  return `/api/workspace-file?${params.toString()}`;
}
