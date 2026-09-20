interface InlineSqlBlockProps {
  sql: string;
}

export function InlineSqlBlock({ sql }: InlineSqlBlockProps) {
  const copySql = () => {
    navigator.clipboard.writeText(sql);
  };

  return (
    <div className="inline-sql-block">
      <div className="inline-block-header">
        <span className="inline-block-title">SQL</span>
        <button type="button" className="btn-ghost btn-compact" onClick={copySql}>
          复制
        </button>
      </div>
      <pre className="inline-sql-pre">{sql}</pre>
    </div>
  );
}
