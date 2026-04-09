import React, { useEffect, useState } from 'react';
import MetricCard from '../components/MetricCard';
import { useApi } from '../hooks/useApi';
import { formatNumber, formatPercent } from '../utils/formatters';

// Hardcoded refresh intervals - should probably be configurable
// Sarah asked for 30s but that hammers the API, using 60s for now
const METRICS_REFRESH_MS = 60_000;
const ALERTS_REFRESH_MS = 30_000; // alerts refresh faster though

interface DashboardMetrics {
  activePatients: number;
  pendingClaims: number;
  claimsValue: number;
  systemHealth: number; // percentage 0-100
  avgResponseTime: number;
  errorRate: number;
  queueDepth: number;
  activeProviders: number;
}

interface Alert {
  id: string;
  severity: 'critical' | 'warning' | 'info';
  message: string;
  timestamp: string;
  acknowledged: boolean;
}

export default function Dashboard() {
  const { fetchWithAuth } = useApi();
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());

  // TODO: replace this with react-query, we already have it installed
  // I started converting it but the refetchInterval config wasn't working right
  // with the auth token refresh and I gave up
  useEffect(() => {
    let mounted = true;

    async function loadMetrics() {
      try {
        const data = await fetchWithAuth('/api/admin/metrics');
        if (mounted) {
          setMetrics(data);
          setLastRefresh(new Date());
        }
      } catch (err) {
        console.error('Failed to load metrics:', err);
        // TODO: show error state in UI
      } finally {
        if (mounted) setLoading(false);
      }
    }

    loadMetrics();
    const interval = setInterval(loadMetrics, METRICS_REFRESH_MS);

    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  // separate effect for alerts because different refresh rate
  useEffect(() => {
    let mounted = true;

    async function loadAlerts() {
      try {
        const data = await fetchWithAuth('/api/admin/alerts?active=true');
        if (mounted) setAlerts(data || []);
      } catch (err) {
        // alerts failing isn't critical, just log it
        console.warn('Alert fetch failed:', err);
      }
    }

    loadAlerts();
    const interval = setInterval(loadAlerts, ALERTS_REFRESH_MS);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  const acknowledgeAlert = async (alertId: string) => {
    try {
      await fetchWithAuth(`/api/admin/alerts/${alertId}/ack`, { method: 'POST' });
      setAlerts(prev => prev.map(a =>
        a.id === alertId ? { ...a, acknowledged: true } : a
      ));
    } catch (err) {
      // TODO: toast notification instead of alert()
      alert('Failed to acknowledge alert');
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading dashboard...</div>
        {/* TODO: proper skeleton loader */}
      </div>
    );
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Operations Dashboard</h1>
        <span className="text-sm text-gray-500">
          Last refreshed: {lastRefresh.toLocaleTimeString()}
        </span>
      </div>

      {/* Alert banner */}
      {alerts.filter(a => !a.acknowledged && a.severity === 'critical').length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
          <h3 className="font-semibold text-red-800 mb-2">
            Active Critical Alerts ({alerts.filter(a => !a.acknowledged && a.severity === 'critical').length})
          </h3>
          {alerts
            .filter(a => !a.acknowledged && a.severity === 'critical')
            .map(alert => (
              <div key={alert.id} className="flex justify-between items-center py-1">
                <span className="text-red-700 text-sm">{alert.message}</span>
                <button
                  onClick={() => acknowledgeAlert(alert.id)}
                  className="text-xs bg-red-100 text-red-800 px-2 py-1 rounded hover:bg-red-200"
                >
                  Acknowledge
                </button>
              </div>
            ))}
        </div>
      )}

      {/* Metrics grid */}
      <div className="grid grid-cols-4 gap-4 mb-8">
        <MetricCard
          title="Active Patients"
          value={formatNumber(metrics?.activePatients ?? 0)}
          // TODO: trend data from API
          trend={undefined}
          icon="users"
        />
        <MetricCard
          title="Pending Claims"
          value={formatNumber(metrics?.pendingClaims ?? 0)}
          subtitle={`$${formatNumber(metrics?.claimsValue ?? 0)} total value`}
          trend={undefined}
          icon="file-text"
        />
        <MetricCard
          title="System Health"
          value={formatPercent(metrics?.systemHealth ?? 0)}
          trend={undefined}
          icon="activity"
          // color the card based on health
          variant={
            (metrics?.systemHealth ?? 100) >= 99 ? 'success' :
            (metrics?.systemHealth ?? 100) >= 95 ? 'warning' : 'danger'
          }
        />
        <MetricCard
          title="Error Rate"
          value={formatPercent(metrics?.errorRate ?? 0)}
          trend={undefined}
          icon="alert-triangle"
          variant={
            (metrics?.errorRate ?? 0) < 1 ? 'success' :
            (metrics?.errorRate ?? 0) < 5 ? 'warning' : 'danger'
          }
        />
      </div>

      {/* Secondary metrics */}
      <div className="grid grid-cols-3 gap-4 mb-8">
        <MetricCard
          title="Avg Response Time"
          value={`${metrics?.avgResponseTime ?? 0}ms`}
          trend={undefined}
          icon="clock"
        />
        <MetricCard
          title="Queue Depth"
          value={formatNumber(metrics?.queueDepth ?? 0)}
          trend={undefined}
          icon="layers"
        />
        <MetricCard
          title="Active Providers"
          value={formatNumber(metrics?.activeProviders ?? 0)}
          trend={undefined}
          icon="briefcase"
        />
      </div>

      {/* Recent alerts table */}
      <div className="bg-white rounded-lg shadow p-4">
        <h2 className="font-semibold text-lg mb-3">Recent Alerts</h2>
        {alerts.length === 0 ? (
          <p className="text-gray-500 text-sm">No recent alerts. Nice.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 border-b">
                <th className="pb-2">Severity</th>
                <th className="pb-2">Message</th>
                <th className="pb-2">Time</th>
                <th className="pb-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {alerts.slice(0, 10).map(alert => (
                <tr key={alert.id} className="border-b last:border-b-0">
                  <td className="py-2">
                    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                      alert.severity === 'critical' ? 'bg-red-100 text-red-800' :
                      alert.severity === 'warning' ? 'bg-yellow-100 text-yellow-800' :
                      'bg-blue-100 text-blue-800'
                    }`}>
                      {alert.severity}
                    </span>
                  </td>
                  <td className="py-2">{alert.message}</td>
                  <td className="py-2 text-gray-500">{new Date(alert.timestamp).toLocaleString()}</td>
                  <td className="py-2">
                    {alert.acknowledged ? (
                      <span className="text-green-600 text-xs">Acknowledged</span>
                    ) : (
                      <button
                        onClick={() => acknowledgeAlert(alert.id)}
                        className="text-xs bg-gray-100 px-2 py-1 rounded hover:bg-gray-200"
                      >
                        Ack
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
