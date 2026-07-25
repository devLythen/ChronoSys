import { cn } from "../../lib/utils";
import { type ReactNode } from "react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface TableProps<T extends Record<string, any>> {
  columns: { key: string; label: string; className?: string; render?: (row: T) => ReactNode }[];
  data: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  emptyText?: string;
  className?: string;
}

export default function Table<T extends Record<string, any>>({
  columns,
  data,
  rowKey,
  onRowClick,
  emptyText = "No data",
  className,
}: TableProps<T>) {
  if (data.length === 0) {
    return (
      <div className="py-12 text-center text-sm text-muted-fg border border-border rounded-sm bg-card">
        {emptyText}
      </div>
    );
  }

  return (
    <div className={cn("overflow-auto border border-border rounded-sm", className)}>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/50">
            {columns.map((col) => (
              <th
                key={col.key}
                className={cn(
                  "px-3 py-2 text-left text-xs font-medium text-muted-fg uppercase tracking-wide",
                  col.className,
                )}
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row) => (
            <tr
              key={rowKey(row)}
              onClick={() => onRowClick?.(row)}
              className={cn(
                "border-b border-border last:border-b-0 bg-card transition-colors",
                onRowClick && "cursor-pointer hover:bg-muted",
              )}
            >
              {columns.map((col) => (
                <td key={col.key} className={cn("px-3 py-2", col.className)}>
                  {col.render ? col.render(row) : String(row[col.key] ?? "")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
