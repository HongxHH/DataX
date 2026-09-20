interface InlineResultTableProps {
  columns: string[];
  rows: unknown[];
  rowCount?: number;
  previewRowCount?: number;
}

function formatRowMeta(rows: unknown[], rowCount?: number, previewRowCount?: number): string {
  const shown = previewRowCount ?? rows.length;
  const total = Math.max(rowCount ?? shown, shown);
  if (total > shown) {
    return `展示 ${shown} / 共 ${total} 行`;
  }
  return `${total} 行`;
}

export function InlineResultTable({
  columns,
  rows,
  rowCount,
  previewRowCount,
}: InlineResultTableProps) {
  return (
    <div className="inline-result-block">
      <div className="inline-block-header">
        <span className="inline-block-title">查询结果</span>
        <span className="inline-block-meta">
          {formatRowMeta(rows, rowCount, previewRowCount)}
        </span>
      </div>
      <div className="inline-table-wrap">
        <table>
          <thead>
            <tr>
              {columns.map((col) => (
                <th key={col}>{col}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri}>
                {(Array.isArray(row) ? row : [row]).map((cell, ci) => (
                  <td key={ci}>{String(cell ?? "")}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
