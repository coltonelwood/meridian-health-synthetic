import React, { useState, useCallback } from 'react';
import { useApi } from '../hooks/useApi';
import DataTable from '../components/DataTable';
import AuditBanner from '../components/AuditBanner';
import { formatPhone, formatDate, formatSSNMasked } from '../utils/formatters';

interface PatientResult {
  id: string;
  mrn: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  ssn: string;
  phone: string;
  email: string;
  insuranceId: string;
  insurerName: string;
  primaryProvider: string;
  status: 'active' | 'inactive' | 'deceased';
  lastVisit: string | null;
}

// TODO: add audit trail UI - right now we log access server-side but there's
// no way for compliance team to see who looked up what from this page.
// Jira: MHT-4521

export default function PatientLookup() {
  const { fetchWithAuth } = useApi();
  const [searchTerm, setSearchTerm] = useState('');
  const [searchType, setSearchType] = useState<'name' | 'mrn' | 'dob' | 'ssn' | 'phone'>('name');
  const [results, setResults] = useState<PatientResult[]>([]);
  const [selectedPatient, setSelectedPatient] = useState<PatientResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);

  // HIPAA: log every search to audit trail
  const logAccess = useCallback(async (action: string, patientId?: string) => {
    try {
      await fetchWithAuth('/api/audit/log', {
        method: 'POST',
        body: JSON.stringify({
          action,
          resource: 'patient',
          resourceId: patientId || null,
          // TODO: get actual user from auth context
          userId: 'current-user',
          timestamp: new Date().toISOString(),
          ipAddress: null, // server fills this in
          reason: null, // TODO: prompt user for access reason? compliance wants this
        }),
      });
    } catch (err) {
      // don't block the search if audit logging fails, but DO log it
      // this is a compliance risk though... we should probably block the search
      // if we can't log it. Talked to compliance team, they said "just ship it
      // and we'll circle back" - famous last words
      console.error('AUDIT LOG FAILED:', err);
    }
  }, [fetchWithAuth]);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!searchTerm.trim()) return;

    setLoading(true);
    setError(null);
    setHasSearched(true);
    setSelectedPatient(null);

    // log the search attempt
    await logAccess('patient_search');

    try {
      const params = new URLSearchParams({
        type: searchType,
        q: searchTerm.trim(),
      });
      const data = await fetchWithAuth(`/api/admin/patients/search?${params}`);
      setResults(data.patients || []);

      if (data.patients?.length === 0) {
        // still log even if no results - compliance wants to know about searches
        // that don't match, could be probing
      }
    } catch (err: any) {
      setError(err.message || 'Search failed');
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  const handleSelectPatient = async (patient: PatientResult) => {
    // HIPAA: log that they viewed PHI
    await logAccess('patient_view', patient.id);
    setSelectedPatient(patient);
  };

  const columns = [
    { key: 'mrn', header: 'MRN', width: '100px' },
    {
      key: 'name',
      header: 'Name',
      render: (row: PatientResult) => `${row.lastName}, ${row.firstName}`,
    },
    {
      key: 'dateOfBirth',
      header: 'DOB',
      render: (row: PatientResult) => formatDate(row.dateOfBirth),
    },
    {
      key: 'status',
      header: 'Status',
      render: (row: PatientResult) => (
        <span className={`px-2 py-0.5 rounded text-xs font-medium ${
          row.status === 'active' ? 'bg-green-100 text-green-800' :
          row.status === 'inactive' ? 'bg-gray-100 text-gray-800' :
          'bg-red-100 text-red-800'
        }`}>
          {row.status}
        </span>
      ),
    },
    { key: 'primaryProvider', header: 'Provider' },
    {
      key: 'lastVisit',
      header: 'Last Visit',
      render: (row: PatientResult) => row.lastVisit ? formatDate(row.lastVisit) : 'N/A',
    },
  ];

  return (
    <div>
      <AuditBanner message="Patient lookup access is logged for HIPAA compliance" />

      <h1 className="text-2xl font-bold text-gray-900 mb-6">Patient Lookup</h1>

      {/* Search form */}
      <form onSubmit={handleSearch} className="bg-white rounded-lg shadow p-4 mb-6">
        <div className="flex gap-4 items-end">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Search By
            </label>
            <select
              value={searchType}
              onChange={e => setSearchType(e.target.value as any)}
              className="border rounded px-3 py-2 text-sm"
            >
              <option value="name">Name</option>
              <option value="mrn">MRN</option>
              <option value="dob">Date of Birth</option>
              <option value="ssn">SSN (Last 4)</option>
              <option value="phone">Phone</option>
            </select>
          </div>
          <div className="flex-1">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {searchType === 'name' ? 'Patient Name' :
               searchType === 'mrn' ? 'Medical Record Number' :
               searchType === 'dob' ? 'Date of Birth (MM/DD/YYYY)' :
               searchType === 'ssn' ? 'Last 4 of SSN' :
               'Phone Number'}
            </label>
            <input
              type="text"
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              placeholder={
                searchType === 'name' ? 'Last name, First name' :
                searchType === 'mrn' ? 'MRN-XXXXXXXX' :
                searchType === 'dob' ? '01/15/1985' :
                searchType === 'ssn' ? '1234' :
                '(555) 123-4567'
              }
              className="border rounded px-3 py-2 text-sm w-full"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="bg-blue-600 text-white px-6 py-2 rounded text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? 'Searching...' : 'Search'}
          </button>
        </div>
      </form>

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded p-3 mb-4 text-red-700 text-sm">
          {error}
        </div>
      )}

      {/* Results */}
      {hasSearched && !loading && (
        <div className="bg-white rounded-lg shadow">
          <div className="p-4 border-b">
            <h2 className="font-semibold">
              Results ({results.length})
              {results.length >= 50 && (
                <span className="text-sm font-normal text-gray-500 ml-2">
                  (showing first 50 - refine your search)
                </span>
              )}
            </h2>
          </div>
          {results.length > 0 ? (
            <DataTable
              data={results}
              columns={columns}
              onRowClick={handleSelectPatient}
              pageSize={20}
            />
          ) : (
            <div className="p-8 text-center text-gray-500">
              No patients found matching your search.
            </div>
          )}
        </div>
      )}

      {/* Patient detail panel */}
      {selectedPatient && (
        <div className="fixed inset-0 bg-black bg-opacity-30 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-[600px] max-h-[80vh] overflow-y-auto">
            <div className="p-4 border-b flex justify-between items-center">
              <h2 className="font-semibold text-lg">Patient Details</h2>
              <button
                onClick={() => setSelectedPatient(null)}
                className="text-gray-400 hover:text-gray-600"
              >
                &times;
              </button>
            </div>
            <AuditBanner message="You are viewing Protected Health Information (PHI)" />
            <div className="p-4 space-y-3">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs text-gray-500 uppercase">Name</label>
                  <p className="font-medium">{selectedPatient.lastName}, {selectedPatient.firstName}</p>
                </div>
                <div>
                  <label className="text-xs text-gray-500 uppercase">MRN</label>
                  <p className="font-mono">{selectedPatient.mrn}</p>
                </div>
                <div>
                  <label className="text-xs text-gray-500 uppercase">Date of Birth</label>
                  <p>{formatDate(selectedPatient.dateOfBirth)}</p>
                </div>
                <div>
                  <label className="text-xs text-gray-500 uppercase">SSN</label>
                  <p className="font-mono">{formatSSNMasked(selectedPatient.ssn)}</p>
                </div>
                <div>
                  <label className="text-xs text-gray-500 uppercase">Phone</label>
                  <p>{formatPhone(selectedPatient.phone)}</p>
                </div>
                <div>
                  <label className="text-xs text-gray-500 uppercase">Email</label>
                  <p>{selectedPatient.email}</p>
                </div>
                <div>
                  <label className="text-xs text-gray-500 uppercase">Insurance</label>
                  <p>{selectedPatient.insurerName}</p>
                  <p className="text-xs text-gray-500 font-mono">{selectedPatient.insuranceId}</p>
                </div>
                <div>
                  <label className="text-xs text-gray-500 uppercase">Primary Provider</label>
                  <p>{selectedPatient.primaryProvider}</p>
                </div>
              </div>

              {/* TODO: add buttons for:
                - View full chart
                - View claims history
                - View audit trail for this patient
                - Edit demographics (with reason for change)
              */}
              <div className="pt-4 border-t flex gap-2">
                <button className="text-sm bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700">
                  View Full Chart
                </button>
                <button className="text-sm bg-gray-100 text-gray-700 px-4 py-2 rounded hover:bg-gray-200">
                  Claims History
                </button>
                {/* TODO: audit trail button - waiting on API endpoint MHT-4521 */}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
