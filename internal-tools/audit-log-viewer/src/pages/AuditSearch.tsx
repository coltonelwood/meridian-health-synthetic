import React, { useState, useCallback, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { format, subDays, parseISO } from 'date-fns';
import { searchAuditLogs, AuditEntry } from '../services/auditApi';

interface SearchFilters {
  userId: string;
  patientId: string;
  action: string;
  startDate: string;
  endDate: string;
  // "advanced" filters that are half-built
  ipAddress: string;
  resourceType: string;
  severity: string;
}

export default function AuditSearch() {
  const [filters, setFilters] = useState<SearchFilters>({
    userId: '',
    patientId: '',
    action: '',
    startDate: format(subDays(new Date(), 7), 'yyyy-MM-dd'),
    endDate: format(new Date(), 'yyyy-MM-dd'),
    ipAddress: '',
    resourceType: '',
    severity: '',
  });

  const [results, setResults] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(1);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // load on mount with default filters
  useEffect(() => {
    handleSearch();
  }, []);

  const handleSearch = useCallback(async (pageNum = 1) => {
    setLoading(true);
    setError(null);
    setPage(pageNum);

    try {
      const response = await searchAuditLogs({
        userId: filters.userId || undefined,
        patientId: filters.patientId || undefined,
        action: filters.action || undefined,
        startDate: filters.startDate,
        endDate: filters.endDate,
        ipAddress: filters.ipAddress || undefined,
        resourceType: filters.resourceType || undefined,
        page: pageNum,
        limit: 50,
      });

      setResults(response.entries);
      setTotalCount(response.total);
    } catch (err: any) {
      setError(err.message || 'Search failed');
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  const handleFilterChange = (key: keyof SearchFilters, value: string) => {
    setFilters(prev => ({ ...prev, [key]: value }));
  };

  const handleExport = async () => {
    // TODO: implement CSV export
    // compliance team keeps asking for this
    alert('Export not implemented yet - ask engineering');
  };

  const actionColors: Record<string, string> = {
    patient_view: 'bg-blue-100 text-blue-800',
    patient_search: 'bg-gray-100 text-gray-800',
    patient_update: 'bg-yellow-100 text-yellow-800',
    patient_create: 'bg-green-100 text-green-800',
    patient_delete: 'bg-red-100 text-red-800',
    login: 'bg-purple-100 text-purple-800',
    login_failed: 'bg-red-100 text-red-800',
    data_export: 'bg-orange-100 text-orange-800',
    report_generated: 'bg-teal-100 text-teal-800',
    permission_change: 'bg-pink-100 text-pink-800',
  };

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Audit Log Search</h1>
        <button
          onClick={handleExport}
          className="text-sm bg-white border border-gray-300 px-4 py-2 rounded hover:bg-gray-50"
        >
          Export CSV
        </button>
      </div>

      {/* Search filters */}
      <div className="bg-white rounded-lg shadow p-4 mb-6">
        <div className="grid grid-cols-3 gap-4 mb-4">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">User ID / Email</label>
            <input
              type="text"
              value={filters.userId}
              onChange={e => handleFilterChange('userId', e.target.value)}
              placeholder="user@meridianhealth.io"
              className="border rounded px-3 py-1.5 text-sm w-full"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Patient ID / MRN</label>
            <input
              type="text"
              value={filters.patientId}
              onChange={e => handleFilterChange('patientId', e.target.value)}
              placeholder="Patient ID or MRN"
              className="border rounded px-3 py-1.5 text-sm w-full"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Action</label>
            <select
              value={filters.action}
              onChange={e => handleFilterChange('action', e.target.value)}
              className="border rounded px-3 py-1.5 text-sm w-full"
            >
              <option value="">All Actions</option>
              <option value="patient_view">Patient View</option>
              <option value="patient_search">Patient Search</option>
              <option value="patient_update">Patient Update</option>
              <option value="patient_create">Patient Create</option>
              <option value="patient_delete">Patient Delete</option>
              <option value="login">Login</option>
              <option value="login_failed">Login Failed</option>
              <option value="data_export">Data Export</option>
              <option value="report_generated">Report Generated</option>
              <option value="permission_change">Permission Change</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-4 mb-4">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Start Date</label>
            <input
              type="date"
              value={filters.startDate}
              onChange={e => handleFilterChange('startDate', e.target.value)}
              className="border rounded px-3 py-1.5 text-sm w-full"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">End Date</label>
            <input
              type="date"
              value={filters.endDate}
              onChange={e => handleFilterChange('endDate', e.target.value)}
              className="border rounded px-3 py-1.5 text-sm w-full"
            />
          </div>
          <div className="flex items-end">
            <button
              onClick={() => handleSearch(1)}
              disabled={loading}
              className="bg-indigo-600 text-white px-6 py-1.5 rounded text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 w-full"
            >
              {loading ? 'Searching...' : 'Search'}
            </button>
          </div>
        </div>

        {/* Advanced filters - half-built */}
        <div>
          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="text-xs text-indigo-600 hover:text-indigo-800"
          >
            {showAdvanced ? 'Hide' : 'Show'} Advanced Filters
          </button>

          {showAdvanced && (
            <div className="mt-3 pt-3 border-t grid grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">IP Address</label>
                <input
                  type="text"
                  value={filters.ipAddress}
                  onChange={e => handleFilterChange('ipAddress', e.target.value)}
                  placeholder="e.g., 10.0.1.xxx"
                  className="border rounded px-3 py-1.5 text-sm w-full"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">
                  Resource Type
                  <span className="text-gray-400 ml-1">(not working yet)</span>
                </label>
                <select
                  value={filters.resourceType}
                  onChange={e => handleFilterChange('resourceType', e.target.value)}
                  className="border rounded px-3 py-1.5 text-sm w-full"
                  disabled // TODO: backend doesn't support this filter yet
                >
                  <option value="">All</option>
                  <option value="patient">Patient</option>
                  <option value="claim">Claim</option>
                  <option value="user">User</option>
                  <option value="report">Report</option>
                </select>
              </div>
              <div>
                {/* TODO: severity filter - need to define severity levels first */}
                <label className="block text-xs font-medium text-gray-500 mb-1">
                  Severity
                  <span className="text-gray-400 ml-1">(coming soon)</span>
                </label>
                <select
                  value={filters.severity}
                  onChange={e => handleFilterChange('severity', e.target.value)}
                  className="border rounded px-3 py-1.5 text-sm w-full opacity-50"
                  disabled
                >
                  <option value="">All</option>
                  <option value="info">Info</option>
                  <option value="warning">Warning</option>
                  <option value="critical">Critical</option>
                </select>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded p-3 mb-4 text-red-700 text-sm">
          {error}
        </div>
      )}

      {/* Results */}
      <div className="bg-white rounded-lg shadow">
        <div className="p-4 border-b flex justify-between items-center">
          <span className="text-sm text-gray-500">
            {totalCount > 0 ? `${totalCount} entries found` : 'No results'}
          </span>
        </div>

        {results.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b bg-gray-50">
                  <th className="px-4 py-2">Timestamp</th>
                  <th className="px-4 py-2">User</th>
                  <th className="px-4 py-2">Action</th>
                  <th className="px-4 py-2">Resource</th>
                  <th className="px-4 py-2">IP Address</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {results.map(entry => (
                  <tr key={entry.id} className="border-b last:border-b-0 hover:bg-gray-50">
                    <td className="px-4 py-2 text-xs text-gray-600 font-mono whitespace-nowrap">
                      {format(parseISO(entry.timestamp), 'yyyy-MM-dd HH:mm:ss')}
                    </td>
                    <td className="px-4 py-2">
                      <div className="text-sm">{entry.userName || entry.userId}</div>
                      <div className="text-xs text-gray-400">{entry.userRole}</div>
                    </td>
                    <td className="px-4 py-2">
                      <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                        actionColors[entry.action] || 'bg-gray-100 text-gray-800'
                      }`}>
                        {entry.action}
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      <div className="text-sm">{entry.resourceType}</div>
                      <div className="text-xs text-gray-400 font-mono">{entry.resourceId}</div>
                    </td>
                    <td className="px-4 py-2 text-xs text-gray-500 font-mono">
                      {entry.ipAddress}
                    </td>
                    <td className="px-4 py-2">
                      <Link
                        to={`/entry/${entry.id}`}
                        className="text-xs text-indigo-600 hover:text-indigo-800"
                      >
                        Details
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : !loading ? (
          <div className="p-8 text-center text-gray-500">
            No audit entries found matching your criteria.
          </div>
        ) : (
          <div className="p-8 text-center text-gray-500">Loading...</div>
        )}

        {/* Pagination */}
        {totalCount > 50 && (
          <div className="p-4 border-t flex justify-between items-center">
            <span className="text-xs text-gray-500">
              Page {page} of {Math.ceil(totalCount / 50)}
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => handleSearch(page - 1)}
                disabled={page <= 1 || loading}
                className="text-xs border px-3 py-1 rounded disabled:opacity-30"
              >
                Previous
              </button>
              <button
                onClick={() => handleSearch(page + 1)}
                disabled={page >= Math.ceil(totalCount / 50) || loading}
                className="text-xs border px-3 py-1 rounded disabled:opacity-30"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
