import { useEffect, useState } from "react";
import type { ChatMessage, DelegationBlock, RecallExcerpt } from "../../types";
import { InlineResultTable } from "../shared/InlineResultTable";
import { workspaceFileUrl } from "../../api/rest";
import { usePersistedToggle } from "../shared/usePersistedToggle";
import { ChevronIcon, ExternalLinkIcon, IconButton } from "../shared/IconButton";
import { visibleDelegations } from "./delegationState";
import { agentNodeId, artifactNodeId, decodeFlowFocus, encodeFlowFocus, delegationImagePath, messageTurnKey } from "./flowModel";

export const ARTIFACTS_COLLAPSED_KEY = "dataagent.shell.artifactsCollapsed";

export interface ArtifactListItem {
  key: string;
  kind: "sql" | "table" | "excerpts" | "image" | "report";
  title: string;
  detail: string;
  path?: string;
  sql?: string;
  columns?: string[];
  rowsPreview?: unknown[];
  rowCount?: number;
  previewRowCount?: number;
  excerpts?: RecallExcerpt[];
  toolCallId: string;
  sub_id?: number;
  turnKey?: string;
}

export function collectTurnArtifacts(
  delegations: DelegationBlock[] | undefined,
  turnKey?: string,
): ArtifactListItem[] {
  if (!delegations?.length) return [];
  const items: ArtifactListItem[] = [];
  const keyed = turnKey ? { turnKey } : {};
  for (const block of delegations) {
    const label = block.label ?? "子 Agent";
    const toolCallId = block.tool_call_id;
    const worker = block.sub_id != null ? { sub_id: block.sub_id } : {};
    if (block.sql) {
      items.push({
        key: `${toolCallId}-sql`,
        kind: "sql",
        title: `${label} · SQL`,
        detail: block.sql_path || "查询语句",
        path: block.sql_path,
        sql: block.sql,
        toolCallId,
        ...worker,
        ...keyed,
      });
    }
    if (block.columns && block.columns.length > 0) {
      items.push({
        key: `${toolCallId}-table`,
        kind: "table",
        title: `${label} · 表`,
        detail: block.csv_path || `${block.preview_row_count ?? block.rows_preview?.length ?? 0} 行预览`,
        path: block.csv_path,
        columns: block.columns,
        rowsPreview: block.rows_preview,
        rowCount: block.row_count,
        previewRowCount: block.preview_row_count,
        toolCallId,
        ...worker,
        ...keyed,
      });
    }
    if (block.excerpts && block.excerpts.length > 0) {
      items.push({
        key: `${toolCallId}-excerpts`,
        kind: "excerpts",
        title: `${label} · 摘录`,
        detail: block.recall_path || `${block.excerpts.length} 条`,
        path: block.recall_path,
        excerpts: block.excerpts,
        toolCallId,
        ...worker,
        ...keyed,
      });
    }
    const imagePaths = [
      ...new Set(
        [delegationImagePath(block), ...(block.images ?? []).map((item) => item.image_path)]
          .map((path) => path?.trim())
          .filter((path): path is string => Boolean(path)),
      ),
    ];
    imagePaths.forEach((imagePath, idx) => {
      items.push({
        key: `${toolCallId}-image-${idx}`,
        kind: "image",
        title: imagePaths.length > 1 ? `${label} · 图 ${idx + 1}` : `${label} · 图`,
        detail: imagePath,
        path: imagePath,
        toolCallId,
        ...worker,
        ...keyed,
      });
    });
    if (block.report_path) {
      items.push({
        key: `${toolCallId}-report`,
        kind: "report",
        title: `${label} · 报告`,
        detail: block.report_path,
        path: block.report_path,
        toolCallId,
        ...worker,
        ...keyed,
      });
    }
  }
  return items;
}

export function collectSessionArtifacts(messages: ChatMessage[]): ArtifactListItem[] {
  const items: ArtifactListItem[] = [];
  messages.forEach((msg, idx) => {
    if (msg.role !== "assistant") return;
    items.push(...collectTurnArtifacts(visibleDelegations(msg.delegations), messageTurnKey(idx)));
  });
  return items;
}

export function groupArtifactsByWorker(
  items: ArtifactListItem[],
): Array<{ key: string; title: string | null; items: ArtifactListItem[] }> {
  if (!items.some((item) => item.sub_id != null)) {
    return [{ key: "all", title: null, items }];
  }
  const groups: Array<{ key: string; title: string | null; items: ArtifactListItem[] }> = [];
  const index = new Map<string, number>();
  for (const item of items) {
    const key = item.sub_id != null ? `worker-${item.sub_id}` : `call-${item.toolCallId}`;
    const title = item.sub_id != null ? `Worker #${item.sub_id}` : "其他产物";
    let idx = index.get(key);
    if (idx == null) {
      idx = groups.length;
      index.set(key, idx);
      groups.push({ key, title, items: [] });
    }
    groups[idx].items.push(item);
  }
  return groups;
}

const KIND_LABEL: Record<ArtifactListItem["kind"], string> = {
  sql: "SQL",
  table: "表",
  excerpts: "摘录",
  image: "图",
  report: "报告",
};

interface CopilotArtifactsPanelProps {
  items: ArtifactListItem[];
  sessionId?: string | null;
  selectedNodeId?: string | null;
  onSelectNode?: (nodeId: string) => void;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}

export function CopilotArtifactsPanel({
  items,
  sessionId,
  selectedNodeId,
  onSelectNode,
  collapsed: collapsedProp,
  onToggleCollapsed,
}: CopilotArtifactsPanelProps) {
  const [uncontrolled, toggleUncontrolled] = usePersistedToggle(ARTIFACTS_COLLAPSED_KEY);
  const collapsed = collapsedProp ?? uncontrolled;
  const toggleCollapsed = onToggleCollapsed ?? toggleUncontrolled;

  return (
    <aside
      className={`copilot-artifacts-panel${collapsed ? " is-collapsed" : ""}`}
      aria-label="本会话产物"
    >
      <div className="panel-header">
        <h2>产物</h2>
        <IconButton
          label="收起产物面板"
          onClick={toggleCollapsed}
          aria-expanded={!collapsed}
          aria-controls="copilot-artifacts-list"
        >
          <ChevronIcon dir="right" />
        </IconButton>
      </div>
      <ul id="copilot-artifacts-list" className="copilot-artifacts-list" hidden={collapsed}>
        {items.length === 0
          ? null
          : groupArtifactsByWorker(items).map((group) => (
            <li key={group.key} className="copilot-artifact-group">
              {group.title && <div className="copilot-artifact-group-title">{group.title}</div>}
              <ul>
                {group.items.map((item) => (
                  <ArtifactItem
                    key={item.key}
                    item={item}
                    sessionId={sessionId}
                    selected={artifactMatchesNode(item, selectedNodeId)}
                    onSelectNode={onSelectNode}
                  />
                ))}
              </ul>
            </li>
          ))}
      </ul>
    </aside>
  );
}

function artifactMatchesNode(item: ArtifactListItem, nodeId?: string | null): boolean {
  if (!nodeId) return false;
  const parsed = decodeFlowFocus(nodeId);
  const localId = parsed?.nodeId ?? nodeId;
  if (parsed && item.turnKey && parsed.turnKey !== item.turnKey) return false;
  return localId === artifactNodeId(item.toolCallId) || localId === agentNodeId(item.toolCallId);
}

function ArtifactItem({
  item,
  sessionId,
  selected,
  onSelectNode,
}: {
  item: ArtifactListItem;
  sessionId?: string | null;
  selected: boolean;
  onSelectNode?: (nodeId: string) => void;
}) {
  const href = workspaceFileUrl(sessionId, item.path);
  const nodeId = artifactNodeId(item.toolCallId);
  const focusId = item.turnKey ? encodeFlowFocus(item.turnKey, nodeId) : nodeId;
  const canPreview = Boolean(
    item.sql ||
    item.columns?.length ||
    item.excerpts?.length ||
    item.kind === "image" ||
    href,
  );

  return (
    <li className={`copilot-artifact-item${selected ? " selected" : ""}`}>
      <div className="copilot-artifact-head">
        <span className="copilot-artifact-kind">{KIND_LABEL[item.kind]}</span>
        <button type="button" className="copilot-artifact-title-btn" onClick={() => onSelectNode?.(focusId)}>
          {item.title}
        </button>
        {href && (
          <a
            className="icon-btn copilot-artifact-open"
            href={href}
            target="_blank"
            rel="noreferrer"
            title="在新标签打开工作区文件"
            aria-label="在新标签打开工作区文件"
          >
            <ExternalLinkIcon />
          </a>
        )}
      </div>
      {canPreview ? <ArtifactPreview item={item} href={href} /> : null}
    </li>
  );
}

function ArtifactPreview({ item, href }: { item: ArtifactListItem; href: string | null }) {
  const [text, setText] = useState<string | null>(item.sql ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const needsFetch = Boolean(href) && !item.sql && item.kind !== "image" && !(item.columns && item.columns.length) && !item.excerpts?.length;

  useEffect(() => {
    if (!needsFetch || !href) return undefined;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(href)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`无法读取文件（${response.status}）`);
        }
        return response.text();
      })
      .then((body) => {
        if (!cancelled) setText(body);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "预览失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [href, needsFetch]);

  if (item.kind === "image" && href) {
    return <img className="copilot-artifact-thumb" src={href} alt={item.title} />;
  }
  if (item.columns && item.columns.length > 0) {
    return (
      <div className="copilot-artifact-preview">
        <InlineResultTable
          columns={item.columns}
          rows={item.rowsPreview ?? []}
          rowCount={item.rowCount}
          previewRowCount={item.previewRowCount}
        />
      </div>
    );
  }
  if (item.excerpts && item.excerpts.length > 0) {
    return (
      <ul className="delegation-excerpts">
        {item.excerpts.slice(0, 6).map((excerpt, idx) => (
          <li key={`${excerpt.source_path ?? "src"}-${idx}`}>
            <div className="delegation-excerpt-source">{excerpt.source_path}</div>
            {excerpt.excerpt && <pre className="delegation-excerpt-body">{excerpt.excerpt}</pre>}
          </li>
        ))}
      </ul>
    );
  }
  if (loading) {
    return <div className="copilot-artifact-preview-status">正在读取文件…</div>;
  }
  if (error) {
    return <div className="copilot-artifact-preview-status">{error}</div>;
  }
  if (text) {
    return (
      <div className="copilot-artifact-preview">
        <pre>{text}</pre>
        {item.sql && (
          <button
            type="button"
            className="btn-ghost btn-compact"
            onClick={() => {
              void navigator.clipboard.writeText(item.sql ?? "");
            }}
          >
            复制 SQL
          </button>
        )}
      </div>
    );
  }
  return <div className="copilot-artifact-preview-status">没有可预览的内容</div>;
}
