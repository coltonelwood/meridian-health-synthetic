import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { format, parseISO } from 'date-fns';
import { getAuditEntry, AuditEntry } from '../services/auditApi';
import AuditTimeline from '../components/AuditTimeline';

/**
 * Detail view for a single audit log entry.
 *
 * Shows the full context of the audit event including:
 * - Who did what, when, from where
 * - Before/after state for data changes (if available)
 * - Related entries (same user session, same resource)
 */
export default function AuditDetail() {
  const { id } = useParams<{ id: string }>();
  const [entry, setEntry] = useState<AuditEntry | null>(null);
  const [relatedEntries, setRelatedEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showRawJson, setShowRawJson] = useState(false);

  useEffect(() => {
    if (!id) return;

    async function load() {
      try {
        const data = await getAuditEntry(id!);
        setEntry(data.entry);
        setRelatedEntries(data.related || []);
      } catch (err: any) {
        setError(err.message || 'Failed to load audit entry');
      } finally {
        setLoading(false);
      }
    }

    load();
  }, [id]);

  if (loading) {
    return <div className="text-gray-500 text-center p-8">Loading entry...</div>;
  }

  if (error || !entry) {
    return (
      <div className="text-center p-8">
        <p className="text-red-500 mb-4">{error || 'Entry not found'}</p>
        <Link to="/" className="text-indigo-600 hover:text-indigo-800">
          Back to search
        </Link>
      </div>
    );
  }

  return (
    <div>
      <Link to="/" className="text-sm text-indigo-600 hover:text-indigo-800 mb-4 inline-block">
        &larr; Back to search
      </Link>

      <div className="bg-white rounded-lg shadow p-6 mb-6">
        <div className="flex justify-between items-start mb-6">
          <div>
            <h1 className="text-xl font-bold text-gray-900">Audit Entry Detail</h1>
            <p className="text-sm text-gray-500 font-mono mt-1">{entry.id}</p>
          </div>
          <button
            onClick={() => setShowRawJson(!showRawJson)}
            className="text-xs border px-3 py-1 rounded hover:bg-gray-50"
          >
            {showRawJson ? 'Hide' : 'Show'} Raw JSON
          </button>
        </div>

        {/* Main details */}
        <div className="grid grid-cols-2 gap-6 mb-6">
          <div className="space-y-3">
            <div>
              <label className="text-xs text-gray-500 uppercase font-medium">Timestamp</label>
              <p className="font-mono">{format(parseISO(entry.timestamp), 'yyyy-MM-dd HH:mm:ss.SSS')}</p>
            </div>
            <div>
              <label className="text-xs text-gray-500 uppercase font-medium">User</label>
              <p className="font-medium">{entry.userName || 'Unknown'}</p>
              <p className="text-sm text-gray-500">{entry.userId}</p>
              <p className="text-xs text-gray-400">{entry.userRole}</p>
            </div>
            <div>
              <label className="text-xs text-gray-500 uppercase font-medium">Action</label>
              <p>
                <span className="inline-block px-2 py-0.5 rounded text-sm font-medium bg-blue-100 text-blue-800">
                  {entry.action}
                </span>
              </p>
            </div>
          </div>
          <div className="space-y-3">
            <div>
              <label className="text-xs text-gray-500 uppercase font-medium">Resource</label>
              <p>{entry.resourceType} / <span className="font-mono">{entry.resourceId}</span></p>
            </div>
            <div>
              <label className="text-xs text-gray-500 uppercase font-medium">IP Address</label>
              <p className="font-mono">{entry.ipAddress || 'Not recorded'}</p>
            </div>
            <div>
              <label className="text-xs text-gray-500 uppercase font-medium">Session ID</label>
              <p className="font-mono text-sm">{entry.sessionId || 'N/A'}</p>
            </div>
            {entry.userAgent && (
              <div>
                <label className="text-xs text-gray-500 uppercase font-medium">User Agent</label>
                <p className="text-xs text-gray-600 break-all">{entry.userAgent}</p>
              </div>
            )}
          </div>
        </div>

        {/* Before/After state for data changes */}
        {(entry.beforeState || entry.afterState) && (
          <div className="mb-6">
            <h3 className="font-semibold text-gray-700 mb-3">Data Changes</h3>
            <div className="grid grid-cols-2 gap-4">
              {entry.beforeState && (
                <div>
                  <label className="text-xs text-gray-500 uppercase font-medium mb-1 block">Before</label>
                  <pre className="bg-red-50 border border-red-200 rounded p-3 text-xs overflow-auto max-h-64">
                    {JSON.stringify(entry.beforeState, null, 2)}
                  </pre>
                </div>
              )}
              {entry.afterState && (
                <div>
                  <label className="text-xs text-gray-500 uppercase font-medium mb-1 block">After</label>
                  <pre className="bg-green-50 border border-green-200 rounded p-3 text-xs overflow-auto max-h-64">
                    {JSON.stringify(entry.afterState, null, 2)}
                  </pre>
                </div>
              )}
            </div>

            {/* Diff view */}
            {entry.beforeState && entry.afterState && (
              <div className="mt-3">
                <label className="text-xs text-gray-500 uppercase font-medium mb-1 block">Changed Fields</label>
                <div className="bg-gray-50 border rounded p-3">
                  {(() => {
                    // janky diff - just show fields that changed
                    const changes: { field: string; from: any; to: any }[] = [];
                    const before = entry.beforeState as Record<string, any>;
                    const after = entry.afterState as Record<string, any>;

                    for (const key of Object.keys(after)) {
                      if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
                        changes.push({
                          field: key,
                          from: before[key],
                          to: after[key],
                        });
                      }
                    }

                    if (changes.length === 0) {
                      return <p className="text-sm text-gray-500">No field-level changes detected</p>;
                    }

                    return (
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-left text-gray-500">
                            <th className="pb-1">Field</th>
                            <th className="pb-1">Before</th>
                            <th className="pb-1">After</th>
                          </tr>
                        </thead>
                        <tbody>
                          {changes.map(c => (
                            <tr key={c.field} className="border-t">
                              <td className="py-1 font-mono font-medium">{c.field}</td>
                              <td className="py-1 text-red-600">{JSON.stringify(c.from)}</td>
                              <td className="py-1 text-green-600">{JSON.stringify(c.to)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    );
                  })()}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Additional context / notes */}
        {entry.details && (
          <div className="mb-6">
            <h3 className="font-semibold text-gray-700 mb-2">Additional Details</h3>
            <pre className="bg-gray-50 border rounded p-3 text-xs overflow-auto max-h-48">
              {typeof entry.details === 'string' ? entry.details : JSON.stringify(entry.details, null, 2)}
            </pre>
          </div>
        )}

        {/* Raw JSON */}
        {showRawJson && (
          <div className="mb-6">
            <h3 className="font-semibold text-gray-700 mb-2">Raw Entry</h3>
            <pre className="bg-gray-900 text-green-400 rounded p-4 text-xs overflow-auto max-h-96">
              {JSON.stringify(entry, null, 2)}
            </pre>
          </div>
        )}
      </div>

      {/* Related entries - same resource */}
      {relatedEntries.length > 0 && (
        <div className="bg-white rounded-lg shadow p-6 mb-6">
          <h2 className="font-semibold text-gray-700 mb-4">
            Related Entries ({relatedEntries.length})
          </h2>
          {/* TODO: add tabs for "same resource" vs "same user session" */}
          <AuditTimeline entries={relatedEntries} currentEntryId={entry.id} />
        </div>
      )}
    </div>
  );
}
