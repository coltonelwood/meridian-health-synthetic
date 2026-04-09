import React from 'react';
import { BrowserRouter, Routes, Route, Link, Navigate } from 'react-router-dom';
import AuditSearch from './pages/AuditSearch';
import AuditDetail from './pages/AuditDetail';

/**
 * Audit Log Viewer
 *
 * Internal tool for viewing HIPAA audit logs.
 * Used by compliance team, security team, and occasionally engineering
 * when debugging access issues.
 *
 * This is a read-only app - no writes to the audit log from here.
 * (The irony of auditing the audit log viewer is not lost on us.)
 */
export default function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-gray-100">
        {/* header */}
        <header className="bg-indigo-900 text-white px-6 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Link to="/" className="font-bold text-lg">
                Audit Log Viewer
              </Link>
              <span className="text-xs text-indigo-300">v1.0.4</span>
              {/* TODO: add nav links when we have more pages */}
            </div>
            <div className="text-sm text-indigo-200">
              {/* TODO: show actual logged-in user */}
              Compliance Portal
            </div>
          </div>
        </header>

        {/* HIPAA notice */}
        <div className="bg-yellow-50 border-b border-yellow-200 px-6 py-2 text-xs text-yellow-800">
          This tool displays Protected Health Information access records.
          All access to this tool is logged. Authorized personnel only.
        </div>

        <main className="p-6 max-w-7xl mx-auto">
          <Routes>
            <Route path="/" element={<AuditSearch />} />
            <Route path="/entry/:id" element={<AuditDetail />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
