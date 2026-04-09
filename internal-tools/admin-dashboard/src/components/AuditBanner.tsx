import React from 'react';

interface AuditBannerProps {
  message?: string;
  level?: 'info' | 'warning';
}

/**
 * HIPAA audit warning banner. Shows when users are accessing PHI.
 *
 * Compliance requirement: this banner must be visible whenever PHI is displayed.
 * See: HIPAA Security Rule 164.312(b) - Audit Controls
 *
 * TODO: compliance wants us to also log when this banner is rendered,
 * to prove the user saw it. That seems overkill but whatever.
 */
export default function AuditBanner({
  message = 'This action is subject to HIPAA audit logging',
  level = 'warning',
}: AuditBannerProps) {
  // NOTE: don't add a dismiss button. Compliance explicitly said
  // this should not be dismissable.

  const styles = {
    info: 'bg-blue-50 border-blue-200 text-blue-800',
    warning: 'bg-amber-50 border-amber-200 text-amber-800',
  };

  return (
    <div className={`border-l-4 px-4 py-2 text-sm ${styles[level]}`}>
      <div className="flex items-center gap-2">
        <span className="font-medium">
          {level === 'warning' ? 'HIPAA Notice' : 'Info'}:
        </span>
        <span>{message}</span>
      </div>
    </div>
  );
}
