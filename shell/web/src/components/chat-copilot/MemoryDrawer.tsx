import { useEffect, useMemo, useState } from "react";
import {
  fetchMemoryCatalog,
  fetchMemoryIndex,
  fetchMemoryProfile,
  fetchMemorySnapshot,
  fetchTrajectoryPrompt,
  trialMemoryRecall,
  type MemoryCatalog,
  type MemoryMarkdownDetail,
  type MemoryProfileDetail,
  type MemoryRecallTrial,
  type MemorySessionCard,
  type MemorySnapshotDetail,
} from "../../api/rest";
import type { PromptInventorySnapshot } from "../../protocol/events";
import {
  abbreviateSessionId,
  clipPackedPreview,
  extractCrossSessionMemories,
  extractPackedFromGroups,
  filterMemorySessions,
  findRecallPromptLocator,
  firstPackedSessionId,
  hitMetaLine,
  liveRecallCaption,
  packedSessionIds,
  partitionCurrentSessions,
  resolveLiveRecall,
  splitMemoryMarkdown,
  type MemoryListFilter,
} from "./memoryDeskModel";
import type { TrajectoryGroup } from "./trajectoryModel";

type Selection =
  | { kind: "snapshot"; sessionId: string }
  | { kind: "memory_md" }
  | { kind: "profile" };

interface MemoryDrawerProps {
  open: boolean;
  currentSessionId?: string | null;
  promptInventory?: PromptInventorySnapshot | null;
  prepLog?: string[];
  trajectoryGroups?: TrajectoryGroup[];
  focusSessionId?: string | null;
  onClose: () => void;
  onRevealInTrajectory?: () => void;
}

export function MemoryDrawer({
  open,
  currentSessionId,
  promptInventory = null,
  prepLog = [],
  trajectoryGroups = [],
  focusSessionId = null,
  onClose,
  onRevealInTrajectory,
}: MemoryDrawerProps) {
  const [catalog, setCatalog] = useState<MemoryCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [snapshot, setSnapshot] = useState<MemorySnapshotDetail | null>(null);
  const [memoryMd, setMemoryMd] = useState<MemoryMarkdownDetail | null>(null);
  const [profile, setProfile] = useState<MemoryProfileDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [trialOpen, setTrialOpen] = useState(false);
  const [trialQuery, setTrialQuery] = useState("");
  const [trial, setTrial] = useState<MemoryRecallTrial | null>(null);
  const [trialLoading, setTrialLoading] = useState(false);
  const [trialError, setTrialError] = useState<string | null>(null);
  const [livePacked, setLivePacked] = useState("");
  const [livePackedError, setLivePackedError] = useState<string | null>(null);
  const [filter, setFilter] = useState<MemoryListFilter>("all");

  const liveRecall = useMemo(
    () => resolveLiveRecall(promptInventory, prepLog),
    [promptInventory, prepLog],
  );
  const liveCaption = liveRecallCaption(liveRecall);
  const livePackedIds = useMemo(() => new Set(packedSessionIds(livePacked)), [livePacked]);
  const livePackedBlocks = useMemo(
    () => splitMemoryMarkdown(livePacked).filter((block) => block.sessionId),
    [livePacked],
  );

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void fetchMemoryCatalog(currentSessionId)
      .then((data) => {
        if (cancelled) return;
        setCatalog(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "加载失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, currentSessionId]);

  useEffect(() => {
    if (!open) return;
    if (focusSessionId) {
      setSelection((prev) =>
        prev?.kind === "snapshot" && prev.sessionId === focusSessionId
          ? prev
          : { kind: "snapshot", sessionId: focusSessionId },
      );
      return;
    }
    setSelection((prev) => {
      if (prev) return prev;
      const packedFirst = firstPackedSessionId(livePacked);
      if (packedFirst) return { kind: "snapshot", sessionId: packedFirst };
      const first = catalog?.sessions.find((item) => !item.is_current) ?? catalog?.sessions[0];
      if (first) return { kind: "snapshot", sessionId: first.session_id };
      if (catalog?.has_memory_md) return { kind: "memory_md" };
      if (catalog?.has_profile) return { kind: "profile" };
      return prev;
    });
  }, [open, focusSessionId, catalog, livePacked]);

  useEffect(() => {
    if (!open || !selection) return;
    let cancelled = false;
    setDetailLoading(true);
    setSnapshot(null);
    setMemoryMd(null);
    setProfile(null);
    const task =
      selection.kind === "snapshot"
        ? fetchMemorySnapshot(selection.sessionId).then((data) => {
          if (!cancelled) setSnapshot(data);
        })
        : selection.kind === "memory_md"
          ? fetchMemoryIndex().then((data) => {
            if (!cancelled) setMemoryMd(data);
          })
          : fetchMemoryProfile().then((data) => {
            if (!cancelled) setProfile(data);
          });
    void task
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "详情加载失败");
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, selection]);

  useEffect(() => {
    if (!open) return;
    const inline = extractPackedFromGroups(trajectoryGroups);
    if (inline) {
      setLivePacked(inline);
      setLivePackedError(null);
      return;
    }
    if (liveRecall?.status !== "hit" || !currentSessionId) {
      setLivePacked("");
      setLivePackedError(null);
      return;
    }
    const locator = findRecallPromptLocator(trajectoryGroups);
    if (!locator) {
      setLivePacked("");
      setLivePackedError("轨迹里还没有可展开的提示词。");
      return;
    }
    let cancelled = false;
    setLivePackedError(null);
    void fetchTrajectoryPrompt(currentSessionId, locator.file, locator.eventIndex, locator.chunkIndex)
      .then((detail) => {
        if (cancelled) return;
        const blob = [
          detail.prompt ?? "",
          ...(detail.prompt_messages ?? []).map((item) => item.content),
        ].join("\n");
        const packed = extractCrossSessionMemories(blob);
        setLivePacked(packed);
        if (!packed) setLivePackedError("未在提示词中找到 Cross-Session Memories 全文。");
      })
      .catch(() => {
        if (!cancelled) setLivePackedError("加载本轮召回全文失败。");
      });
    return () => {
      cancelled = true;
    };
  }, [open, currentSessionId, trajectoryGroups, liveRecall?.status]);

  if (!open) return null;

  const runTrial = () => {
    const query = trialQuery.trim();
    if (!query || trialLoading) return;
    setTrialLoading(true);
    setTrialError(null);
    void trialMemoryRecall(query, currentSessionId)
      .then((data) => {
        setTrial(data);
        const packedHit = data.hits.find((hit) => hit.would_pack);
        if (packedHit?.session_id) {
          setSelection({ kind: "snapshot", sessionId: packedHit.session_id });
        }
      })
      .catch((err: unknown) => setTrialError(err instanceof Error ? err.message : "试算失败"))
      .finally(() => setTrialLoading(false));
  };

  const scoreById = new Map((trial?.hits ?? []).map((hit) => [hit.session_id, hit]));
  const filtered = filterMemorySessions(catalog?.sessions ?? [], filter, livePackedIds);
  const { rest, current } = partitionCurrentSessions(filtered);
  const knownIds = new Set((catalog?.sessions ?? []).map((item) => item.session_id));
  const emptyCatalog = !loading && catalog && catalog.sessions.length === 0 && !catalog.has_memory_md && !catalog.has_profile;

  return (
    <aside className="memory-drawer" aria-label="召回台">
      <div className="memory-drawer-header">
        <h3>召回台</h3>
        <button type="button" className="sessions-collapse-btn" onClick={onClose}>
          关闭
        </button>
      </div>
      <section className="memory-live" aria-label="本轮实际召回">
        <div className="memory-live-head">
          <span className="memory-live-kicker">本轮实际召回</span>
          <span className="memory-live-status">{liveCaption.title}</span>
        </div>
        {liveCaption.detail ? <p className="memory-drawer-hint">{liveCaption.detail}</p> : null}
        {livePackedBlocks.length > 0 ? (
          <ul className="memory-live-cards">
            {livePackedBlocks.map((block) => {
              const sessionId = block.sessionId as string;
              const summary = clipPackedPreview(
                catalog?.sessions.find((item) => item.session_id === sessionId)?.session_summary ||
                block.body,
              );
              return (
                <li key={sessionId}>
                  <button
                    type="button"
                    className={`memory-live-card${selection?.kind === "snapshot" && selection.sessionId === sessionId ? " is-active" : ""}`}
                    onClick={() => setSelection({ kind: "snapshot", sessionId })}
                  >
                    <span className="memory-live-card-id">{abbreviateSessionId(sessionId)}</span>
                    <span className="memory-live-card-preview">{summary || sessionId}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : livePackedError && liveRecall?.status === "hit" ? (
          <p className="memory-drawer-hint">{livePackedError}</p>
        ) : null}
        {onRevealInTrajectory && liveRecall?.status === "hit" ? (
          <button type="button" className="btn-ghost btn-compact" onClick={onRevealInTrajectory}>
            在轨迹中查看
          </button>
        ) : null}
      </section>
      <details
        className="memory-trial-fold"
        open={trialOpen}
        onToggle={(event) => setTrialOpen(event.currentTarget.open)}
      >
        <summary>试算召回</summary>
        <div className="memory-trial">
          <input
            type="text"
            value={trialQuery}
            placeholder="输入问句，试算跨会话召回…"
            onChange={(event) => setTrialQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                runTrial();
              }
            }}
          />
          <button type="button" className="btn-ghost btn-compact" disabled={trialLoading || !trialQuery.trim()} onClick={runTrial}>
            {trialLoading ? "试算中…" : "试算"}
          </button>
        </div>
        {trialError ? <p className="memory-drawer-hint">{trialError}</p> : null}
        {trial ? <TrialDiagnosis trial={trial} /> : null}
      </details>
      <div className="memory-filter-row" role="tablist" aria-label="筛选">
        <FilterChip label="全部" active={filter === "all"} onClick={() => setFilter("all")} />
        <FilterChip
          label="已装入"
          title="本轮已装入 Planner 的 snapshot"
          active={filter === "packed"}
          onClick={() => setFilter("packed")}
        />
        <FilterChip
          label="有发现"
          title="含 important_findings 的会话"
          active={filter === "findings"}
          onClick={() => setFilter("findings")}
        />
      </div>
      <div className="memory-drawer-body">
        <div className="memory-drawer-list" aria-label="记忆列表">
          {emptyCatalog ? (
            <p className="memory-drawer-hint">回答这次为什么想起 / 没想起。还没有 snapshot / MEMORY.md。</p>
          ) : null}
          {loading ? <p className="memory-drawer-hint">加载中…</p> : null}
          {error ? <p className="memory-drawer-hint">{error}</p> : null}
          {!loading && filter === "packed" && livePackedIds.size === 0 ? (
            <p className="memory-drawer-hint">本轮没有装入历史 snapshot。</p>
          ) : null}
          <ul>
            {rest.map((item) => (
              <SessionListItem
                key={item.session_id}
                item={item}
                active={selection?.kind === "snapshot" && selection.sessionId === item.session_id}
                packed={livePackedIds.has(item.session_id)}
                hitLine={hitMetaLine(scoreById.get(item.session_id))}
                onClick={() => setSelection({ kind: "snapshot", sessionId: item.session_id })}
              />
            ))}
          </ul>
          {current.length > 0 ? (
            <details className="memory-current-fold">
              <summary>当前会话 · 不参与召回</summary>
              <ul>
                {current.map((item) => (
                  <SessionListItem
                    key={item.session_id}
                    item={item}
                    active={selection?.kind === "snapshot" && selection.sessionId === item.session_id}
                    packed={false}
                    hitLine=""
                    onClick={() => setSelection({ kind: "snapshot", sessionId: item.session_id })}
                  />
                ))}
              </ul>
            </details>
          ) : null}
          {catalog?.has_memory_md || catalog?.has_profile ? (
            <>
              <div className="memory-list-group">索引</div>
              <ul>
                {catalog?.has_memory_md ? (
                  <li>
                    <button
                      type="button"
                      className={`memory-list-item${selection?.kind === "memory_md" ? " is-active" : ""}`}
                      onClick={() => setSelection({ kind: "memory_md" })}
                    >
                      <span className="memory-list-title">MEMORY.md</span>
                      <span className="memory-list-meta">跨会话索引（由 snapshot 汇总）</span>
                    </button>
                  </li>
                ) : null}
                {catalog?.has_profile ? (
                  <li>
                    <button
                      type="button"
                      className={`memory-list-item${selection?.kind === "profile" ? " is-active" : ""}`}
                      onClick={() => setSelection({ kind: "profile" })}
                    >
                      <span className="memory-list-title">profile.json</span>
                      <span className="memory-list-meta">用户画像</span>
                    </button>
                  </li>
                ) : null}
              </ul>
            </>
          ) : null}
        </div>
        <div className="memory-drawer-detail" aria-label="记忆详情">
          {detailLoading ? <p className="memory-drawer-hint">详情加载中…</p> : null}
          {!detailLoading && snapshot ? <SnapshotDetail data={snapshot} /> : null}
          {!detailLoading && memoryMd ? (
            <MemoryMarkdownView
              content={memoryMd.content}
              knownIds={knownIds}
              onJump={(sessionId) => setSelection({ kind: "snapshot", sessionId })}
            />
          ) : null}
          {!detailLoading && profile ? (
            <pre className="memory-md-pre">{JSON.stringify(profile.profile, null, 2)}</pre>
          ) : null}
        </div>
      </div>
    </aside>
  );
}

function TrialDiagnosis({ trial }: { trial: MemoryRecallTrial }) {
  const tokens = (trial.query_tokens ?? []).slice(0, 12).join(" ");
  const packCount = trial.hits.filter((hit) => hit.would_pack).length;
  return (
    <div className="memory-trial-result">
      <p className="memory-drawer-hint">
        {trial.hit_count > 0
          ? `命中将装入 ${trial.hit_count} 段（top_k=${trial.top_k}，阈值 ${trial.threshold ?? 0.01}）。将装入的项已标在左侧列表。`
          : trial.miss_summary || "未命中"}
      </p>
      {tokens ? <p className="memory-drawer-hint">分词：{tokens}</p> : null}
      {packCount > 0 ? (
        <details className="memory-packed">
          <summary>试算将装入的 Cross-Session Memories</summary>
          <pre>{trial.packed}</pre>
        </details>
      ) : null}
    </div>
  );
}

function FilterChip({
  label,
  title,
  active,
  onClick,
}: {
  label: string;
  title?: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`memory-filter-chip${active ? " is-on" : ""}`}
      title={title ?? label}
      aria-pressed={active}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function SessionListItem({
  item,
  active,
  packed,
  hitLine,
  onClick,
}: {
  item: MemorySessionCard;
  active: boolean;
  packed: boolean;
  hitLine: string;
  onClick: () => void;
}) {
  const cls = [
    "memory-list-item",
    active ? "is-active" : "",
    item.is_current ? "is-current" : "",
    packed ? "is-packed" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <li>
      <button type="button" className={cls} onClick={onClick}>
        <span className="memory-list-title">{item.session_summary || abbreviateSessionId(item.session_id)}</span>
        <span className="memory-list-meta">
          {item.is_current ? "不参与召回 · " : packed ? "本轮已装入 · " : ""}
          {abbreviateSessionId(item.session_id)}
          {hitLine ? ` · ${hitLine}` : ""}
        </span>
      </button>
    </li>
  );
}

function MemoryMarkdownView({
  content,
  knownIds,
  onJump,
}: {
  content: string;
  knownIds: Set<string>;
  onJump: (sessionId: string) => void;
}) {
  const blocks = splitMemoryMarkdown(content);
  if (blocks.length === 0) return <pre className="memory-md-pre">（空）</pre>;
  return (
    <div className="memory-md">
      <p className="memory-drawer-hint">跨会话索引（由 snapshot 汇总，不是另一套记忆源）</p>
      {blocks.map((block, index) =>
        block.sessionId ? (
          <section key={block.sessionId} className="memory-md-section">
            {knownIds.has(block.sessionId) ? (
              <button type="button" className="memory-md-jump" onClick={() => onJump(block.sessionId!)}>
                ### {block.sessionId}
              </button>
            ) : (
              <h4>### {block.sessionId}</h4>
            )}
            <pre className="memory-md-pre">{block.body || "（空）"}</pre>
          </section>
        ) : (
          <pre key={`lead-${index}`} className="memory-md-pre">
            {block.body}
          </pre>
        ),
      )}
    </div>
  );
}

function SnapshotDetail({ data }: { data: MemorySnapshotDetail }) {
  const snap = data.snapshot;
  return (
    <div className="memory-snapshot">
      <h4>{data.session_id}</h4>
      <Field label="session_summary" value={snap.session_summary || "（空）"} />
      <FieldList label="goals" items={snap.goals} />
      <FieldList label="constraints" items={snap.constraints} />
      <FieldList label="decisions" items={snap.decisions} />
      <FieldList label="important_findings" items={snap.important_findings} />
      <FieldList label="artifacts" items={snap.artifacts} />
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <section className="memory-field">
      <div className="memory-field-label">{label}</div>
      <p>{value}</p>
    </section>
  );
}

function FieldList({ label, items }: { label: string; items: string[] }) {
  return (
    <section className="memory-field">
      <div className="memory-field-label">
        {label}
        {items.length > 0 ? ` · ${items.length}` : ""}
      </div>
      {items.length === 0 ? (
        <p className="memory-drawer-hint">（空）</p>
      ) : (
        <ul>
          {items.map((item) => (
            <li key={`${label}-${item}`}>{item}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
