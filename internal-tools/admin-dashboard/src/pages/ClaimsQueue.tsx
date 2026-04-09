import React, { useState, useEffect } from 'react';
import { useApi } from '../hooks/useApi';
import DataTable from '../components/DataTable';
import { formatCurrency, formatDate } from '../utils/formatters';

interface Claim {
  id: string;
  claimNumber: string;
  patientName: string;
  patientMRN: string;
  providerName: string;
  serviceDate: string;
  submittedDate: string;
  amount: number;
  status: 'pending_review' | 'approved' | 'denied' | 'needs_info' | 'appealed';
  claimType: 'professional' | 'institutional' | 'pharmacy';
  payerName: string;
  priority: 'normal' | 'high' | 'urgent';
  assignedTo: string | null;
  daysInQueue: number;
}

type FilterState = {
  status: string;
  claimType: string;
  priority: string;
  payer: string;
  assignedTo: string;
  dateRange: string;
  minAmount: string;
  maxAmount: string;
};

export default function ClaimsQueue() {
  const { fetchWithAuth } = useApi();
  const [claims, setClaims] = useState<Claim[]>([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);

  const [filters, setFilters] = useState<FilterState>({
    status: 'pending_review',
    claimType: '',
    priority: '',
    payer: '',
    assignedTo: '',
    dateRange: '30', // days
    minAmount: '',
    maxAmount: '',
  });

  // TODO: payer filter doesn't work - the API endpoint ignores the payer param
  // when combined with status filter. Backend bug, ticket MHT-3892.
  // Also the date range filter is broken for anything > 90 days because the
  // API returns a 504 timeout. Need to add pagination to the backend query.

  // TODO: amount range filter is client-side only right now which is WRONG
  // because we paginate server-side so you'd miss results. Fix this when
  // the backend adds amount params.

  useEffect(() => {
    loadClaims();
  }, [filters.status, filters.claimType, filters.priority, filters.dateRange, page]);
  // NOTE: intentionally NOT including payer/assignedTo/amount filters in deps
  // because they're either broken or client-side only ^

  async function loadClaims() {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        status: filters.status,
        page: String(page),
        limit: '25',
      });

      if (filters.claimType) params.set('type', filters.claimType);
      if (filters.priority) params.set('priority', filters.priority);
      if (filters.dateRange) params.set('days', filters.dateRange);
      // payer filter sent but ignored by backend...
      if (filters.payer) params.set('payer', filters.payer);

      const data = await fetchWithAuth(`/api/admin/claims?${params}`);
      setClaims(data.claims || []);
      setTotal(data.total || 0);
    } catch (err) {
      console.error('Failed to load claims:', err);
    } finally {
      setLoading(false);
    }
  }

  const handleFilterChange = (key: keyof FilterState, value: string) => {
    setFilters(prev => ({ ...prev, [key]: value }));
    setPage(1); // reset to first page on filter change
  };

  const handleAssign = async (claimId: string, userId: string) => {
    try {
      await fetchWithAuth(`/api/admin/claims/${claimId}/assign`, {
        method: 'POST',
        body: JSON.stringify({ assignedTo: userId }),
      });
      // refresh the list
      loadClaims();
    } catch (err) {
      alert('Failed to assign claim');
    }
  };

  const handleBulkAction = async (action: string) => {
    // TODO: implement bulk actions
    // - bulk approve
    // - bulk assign
    // - bulk export
    alert(`Bulk ${action} not implemented yet`);
  };

  const columns = [
    {
      key: 'claimNumber',
      header: 'Claim #',
      width: '130px',
      render: (row: Claim) => (
        <span className="font-mono text-sm">{row.claimNumber}</span>
      ),
    },
    {
      key: 'priority',
      header: 'Pri',
      width: '60px',
      render: (row: Claim) => (
        <span className={`inline-block w-2 h-2 rounded-full ${
          row.priority === 'urgent' ? 'bg-red-500' :
          row.priority === 'high' ? 'bg-orange-500' :
          'bg-gray-300'
        }`} title={row.priority} />
      ),
    },
    { key: 'patientName', header: 'Patient' },
    { key: 'providerName', header: 'Provider' },
    {
      key: 'serviceDate',
      header: 'Service Date',
      render: (row: Claim) => formatDate(row.serviceDate),
    },
    {
      key: 'amount',
      header: 'Amount',
      render: (row: Claim) => formatCurrency(row.amount),
    },
    { key: 'payerName', header: 'Payer' },
    {
      key: 'status',
      header: 'Status',
      render: (row: Claim) => {
        const statusLabels: Record<string, string> = {
          pending_review: 'Pending Review',
          approved: 'Approved',
          denied: 'Denied',
          needs_info: 'Needs Info',
          appealed: 'Appealed',
        };
        const statusColors: Record<string, string> = {
          pending_review: 'bg-yellow-100 text-yellow-800',
          approved: 'bg-green-100 text-green-800',
          denied: 'bg-red-100 text-red-800',
          needs_info: 'bg-blue-100 text-blue-800',
          appealed: 'bg-purple-100 text-purple-800',
        };
        return (
          <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusColors[row.status] || ''}`}>
            {statusLabels[row.status] || row.status}
          </span>
        );
      },
    },
    {
      key: 'daysInQueue',
      header: 'Days',
      width: '60px',
      render: (row: Claim) => (
        <span className={row.daysInQueue > 14 ? 'text-red-600 font-semibold' : ''}>
          {row.daysInQueue}
        </span>
      ),
    },
    {
      key: 'assignedTo',
      header: 'Assigned',
      render: (row: Claim) => row.assignedTo || (
        <span className="text-gray-400 italic">Unassigned</span>
      ),
    },
  ];

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Claims Review Queue</h1>
        <div className="flex gap-2">
          <button
            onClick={() => handleBulkAction('assign')}
            className="text-sm bg-gray-100 px-3 py-1.5 rounded hover:bg-gray-200"
          >
            Bulk Assign
          </button>
          <button
            onClick={() => handleBulkAction('export')}
            className="text-sm bg-gray-100 px-3 py-1.5 rounded hover:bg-gray-200"
          >
            Export
          </button>
          <button
            onClick={() => loadClaims()}
            className="text-sm bg-blue-600 text-white px-3 py-1.5 rounded hover:bg-blue-700"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-lg shadow p-4 mb-4">
        <div className="grid grid-cols-4 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Status</label>
            <select
              value={filters.status}
              onChange={e => handleFilterChange('status', e.target.value)}
              className="border rounded px-2 py-1.5 text-sm w-full"
            >
              <option value="">All</option>
              <option value="pending_review">Pending Review</option>
              <option value="approved">Approved</option>
              <option value="denied">Denied</option>
              <option value="needs_info">Needs Info</option>
              <option value="appealed">Appealed</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Claim Type</label>
            <select
              value={filters.claimType}
              onChange={e => handleFilterChange('claimType', e.target.value)}
              className="border rounded px-2 py-1.5 text-sm w-full"
            >
              <option value="">All Types</option>
              <option value="professional">Professional</option>
              <option value="institutional">Institutional</option>
              <option value="pharmacy">Pharmacy</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Priority</label>
            <select
              value={filters.priority}
              onChange={e => handleFilterChange('priority', e.target.value)}
              className="border rounded px-2 py-1.5 text-sm w-full"
            >
              <option value="">All</option>
              <option value="urgent">Urgent</option>
              <option value="high">High</option>
              <option value="normal">Normal</option>
            </select>
          </div>
          <div>
            {/* NOTE: this filter doesn't actually work, see TODO above */}
            <label className="block text-xs font-medium text-gray-500 mb-1">
              Payer
              <span className="text-red-400 ml-1" title="Filter is broken - MHT-3892">*</span>
            </label>
            <select
              value={filters.payer}
              onChange={e => handleFilterChange('payer', e.target.value)}
              className="border rounded px-2 py-1.5 text-sm w-full"
            >
              <option value="">All Payers</option>
              <option value="aetna">Aetna</option>
              <option value="bcbs">Blue Cross Blue Shield</option>
              <option value="cigna">Cigna</option>
              <option value="humana">Humana</option>
              <option value="united">UnitedHealthcare</option>
              <option value="medicare">Medicare</option>
              <option value="medicaid">Medicaid</option>
            </select>
          </div>
        </div>

        {/* Date range - kept separate because it's kinda important */}
        <div className="mt-3 flex gap-4 items-center">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Date Range</label>
            <select
              value={filters.dateRange}
              onChange={e => handleFilterChange('dateRange', e.target.value)}
              className="border rounded px-2 py-1.5 text-sm"
            >
              <option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option>
              <option value="60">Last 60 days</option>
              <option value="90">Last 90 days</option>
              {/* values > 90 will timeout, don't offer them */}
              {/* <option value="180">Last 6 months</option> */}
              {/* <option value="365">Last year</option> */}
            </select>
          </div>
          <div className="text-sm text-gray-500 mt-4">
            Showing {total} claims
            {filters.payer && (
              <span className="text-red-500 ml-2">(payer filter is currently broken)</span>
            )}
          </div>
        </div>
      </div>

      {/* Claims table */}
      <div className="bg-white rounded-lg shadow">
        {loading ? (
          <div className="p-8 text-center text-gray-500">Loading claims...</div>
        ) : (
          <DataTable
            data={claims}
            columns={columns}
            pageSize={25}
            currentPage={page}
            totalItems={total}
            onPageChange={setPage}
            serverPagination
          />
        )}
      </div>
    </div>
  );
}
