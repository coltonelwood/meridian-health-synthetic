import React from 'react';
import { Link } from 'react-router-dom';
import { format, parseISO } from 'date-fns';
import { AuditEntry } from '../services/auditApi';

interface AuditTimelineProps {
  entries: AuditEntry[];
  currentEntryId?: string;
}

/**
 * Timeline visualization of audit events for a patient or resource.
 *
 * Shows a vertical timeline with events plotted chronologically.
 * The current entry (if viewing from detail page) is highlighted.
 *
 * TODO: This is pretty basic right now - just a list with connecting lines.
 * Would be nice to add:
 * - Grouping by day
 * - Collapsing repeated actions (e.g., "viewed 15 times" instead of 15 entries)
 * - Color coding by action severity
 * - Zoom controls for long timelines
 */
export default function AuditTimeline({
  entries,
  currentEntryId,
}: AuditTimelineProps) {
  if (entries.length === 0) {
    return (
      <p className="text-sm text-gray-500">No timeline events to display.</p>
    );
  }

  // Sort by timestamp, newest first
  const sorted = [...entries].sort((a, b) =>
    new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );

  const actionIcons: Record<string, string> = {
    patient_view: 'V',
    patient_search: 'S',
    patient_update: 'U',
    patient_create: 'C',
    patient_delete: 'D',
    login: 'L',
    login_failed: '!',
    data_export: 'E',
    report_generated: 'R',
    permission_change: 'P',
  };

  const actionColors: Record<string, string> = {
    patient_view: 'bg-blue-500',
    patient_search: 'bg-gray-400',
    patient_update: 'bg-yellow-500',
    patient_create: 'bg-green-500',
    patient_delete: 'bg-red-500',
    login: 'bg-purple-500',
    login_failed: 'bg-red-600',
    data_export: 'bg-orange-500',
    report_generated: 'bg-teal-500',
    permission_change: 'bg-pink-500',
  };

  return (
    <div className="relative">
      {/* vertical line */}
      <div className="absolute left-4 top-0 bottom-0 w-0.5 bg-gray-200" />

      <div className="space-y-4">
        {sorted.map((entry, idx) => {
          const isCurrent = entry.id === currentEntryId;

          return (
            <div
              key={entry.id}
              className={`relative flex items-start gap-4 pl-10 ${
                isCurrent ? 'bg-indigo-50 -ml-2 pl-12 pr-4 py-2 rounded-lg border border-indigo-200' : ''
              }`}
            >
              {/* dot on the timeline */}
              <div className={`absolute left-2.5 w-3.5 h-3.5 rounded-full border-2 border-white ${
                actionColors[entry.action] || 'bg-gray-400'
              } flex items-center justify-center`}>
                <span className="text-white text-[6px] font-bold">
                  {actionIcons[entry.action] || '?'}
                </span>
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="text-xs font-mono text-gray-500">
                    {format(parseISO(entry.timestamp), 'MMM dd, HH:mm:ss')}
                  </span>
                  <span className="text-xs font-medium text-gray-700">
                    {entry.action}
                  </span>
                  {isCurrent && (
                    <span className="text-xs bg-indigo-100 text-indigo-700 px-1.5 py-0.5 rounded font-medium">
                      Current
                    </span>
                  )}
                </div>
                <div className="text-xs text-gray-500 mt-0.5">
                  by {entry.userName || entry.userId}
                  {entry.ipAddress && ` from ${entry.ipAddress}`}
                </div>
                {/* brief details if available */}
                {entry.details && typeof entry.details === 'string' && (
                  <p className="text-xs text-gray-400 mt-0.5 truncate">
                    {entry.details}
                  </p>
                )}
                {!isCurrent && (
                  <Link
                    to={`/entry/${entry.id}`}
                    className="text-xs text-indigo-600 hover:text-indigo-800 mt-0.5 inline-block"
                  >
                    View details
                  </Link>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {sorted.length >= 50 && (
        <p className="text-xs text-gray-400 mt-4 ml-10">
          Showing first 50 entries. Refine your search to see more.
        </p>
      )}
    </div>
  );
}
