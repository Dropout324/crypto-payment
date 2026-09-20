interface Column<T> {
  header: string;
  cell: (row: T) => React.ReactNode;
}

export function DataTable<T extends { id: string }>({
  columns,
  rows,
  empty,
}: {
  columns: Column<T>[];
  rows: T[];
  empty: string;
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-zinc-500">{empty}</p>;
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-800">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-zinc-800 bg-zinc-950 text-zinc-400">
          <tr>
            {columns.map((c) => (
              <th key={c.header} className="whitespace-nowrap px-3 py-2 font-medium">
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-b border-zinc-900 last:border-0">
              {columns.map((c) => (
                <td key={c.header} className="whitespace-nowrap px-3 py-2">
                  {c.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
