import React, { useState, useMemo } from 'react';

interface Column<T = any> {
  key: string;
  header: string;
  width?: string;
  sortable?: boolean;
  render?: (row: T) => React.ReactNode;
}

interface DataTableProps<T = any> {
  data: T[];
  columns: Column<T>[];
  pageSize?: number;
  currentPage?: number;
  totalItems?: number;
  onPageChange?: (page: number) => void;
  onRowClick?: (row: T) => void;
  serverPagination?: boolean;
  // TODO: add these
  // selectable?: boolean;
  // onSelectionChange?: (selected: T[]) => void;
  // sortable?: boolean;
  // onSort?: (key: string, direction: 'asc' | 'desc') => void;
}

export default function DataTable<T extends Record<string, any>>({
  data,
  columns,
  pageSize = 10,
  currentPage: controlledPage,
  totalItems,
  onPageChange,
  onRowClick,
  serverPagination = false,
}: DataTableProps<T>) {
  const [internalPage, setInternalPage] = useState(1);

  const page = controlledPage ?? internalPage;
  const setPage = onPageChange ?? setInternalPage;

  // Client-side pagination
  // BUG: when you change pageSize after the component mounts, the page index
  // doesn't reset and you can end up on a page that doesn't exist.
  // Not fixing right now because nobody changes pageSize dynamically yet.
  const displayData = useMemo(() => {
    if (serverPagination) return data;
    const start = (page - 1) * pageSize;
    return data.slice(start, start + pageSize);
  }, [data, page, pageSize, serverPagination]);

  const totalPages = useMemo(() => {
    const total = serverPagination ? (totalItems ?? data.length) : data.length;
    return Math.ceil(total / pageSize);
  }, [data.length, totalItems, pageSize, serverPagination]);

  // BUG: pagination shows wrong total when using client-side filtering
  // with server-side pagination. We pass totalItems from the server but
  // if someone applies a client-side filter (like amount range in ClaimsQueue)
  // the totalItems is still the server count. Known issue, low priority.

  return (
    <div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-gray-500 border-b bg-gray-50">
            {columns.map(col => (
              <th
                key={col.key}
                className="px-4 py-2 font-medium"
                style={col.width ? { width: col.width } : undefined}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {displayData.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-4 py-8 text-center text-gray-500">
                No data to display
              </td>
            </tr>
          ) : (
            displayData.map((row, idx) => (
              <tr
                key={(row as any).id ?? idx}
                className={`border-b last:border-b-0 ${
                  onRowClick ? 'cursor-pointer hover:bg-blue-50' : ''
                }`}
                onClick={() => onRowClick?.(row)}
              >
                {columns.map(col => (
                  <td key={col.key} className="px-4 py-2">
                    {col.render ? col.render(row) : row[col.key]}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between px-4 py-3 border-t">
          <span className="text-sm text-gray-500">
            Page {page} of {totalPages}
            {totalItems != null && ` (${totalItems} total)`}
          </span>
          <div className="flex gap-1">
            <button
              onClick={() => setPage(1)}
              disabled={page <= 1}
              className="px-2 py-1 text-sm border rounded disabled:opacity-30 hover:bg-gray-50"
            >
              First
            </button>
            <button
              onClick={() => setPage(page - 1)}
              disabled={page <= 1}
              className="px-2 py-1 text-sm border rounded disabled:opacity-30 hover:bg-gray-50"
            >
              Prev
            </button>
            {/* TODO: show page numbers here, not just prev/next
                something like: 1 2 3 ... 8 9 10
                there's a good implementation on stack overflow somewhere */}
            <button
              onClick={() => setPage(page + 1)}
              disabled={page >= totalPages}
              className="px-2 py-1 text-sm border rounded disabled:opacity-30 hover:bg-gray-50"
            >
              Next
            </button>
            <button
              onClick={() => setPage(totalPages)}
              disabled={page >= totalPages}
              className="px-2 py-1 text-sm border rounded disabled:opacity-30 hover:bg-gray-50"
            >
              Last
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
