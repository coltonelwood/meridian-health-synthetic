import React, { useState, useEffect } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, AreaChart, Area } from 'recharts';
import { useApi } from '../hooks/useApi';
import MetricCard from '../components/MetricCard';
import { formatPercent, formatNumber } from '../utils/formatters';

interface ServiceStatus {
  name: string;
  status: 'healthy' | 'degraded' | 'down';
  latencyMs: number;
  lastCheck: string;
  uptime: number; // percentage
  details?: string;
}

interface HealthMetrics {
  services: ServiceStatus[];
  database: {
    activeConnections: number;
    maxConnections: number;
    avgQueryMs: number;
    slowQueries: number;
    replicationLag: number;
  };
  queues: {
    name: string;
    depth: number;
    processingRate: number; // per minute
    errorRate: number;
    oldestMessage: string | null;
  }[];
  memory: {
    usedMb: number;
    totalMb: number;
  };
  cpu: number;
}

// hardcoded list of services we monitor
// TODO: pull this from service discovery instead
const KNOWN_SERVICES = [
  'api-gateway',
  'auth-service',
  'patient-service',
  'claims-processor',
  'notification-service',
  'document-service',
  'eligibility-checker',
  'hl7-ingest',
  'fhir-adapter',
  'billing-engine',
];

export default function SystemHealth() {
  const { fetchWithAuth } = useApi();
  const [health, setHealth] = useState<HealthMetrics | null>(null);
  const [responseTimeHistory, setResponseTimeHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);

  // 15 second refresh for system health - this is fine for the health page
  // specifically since it's only loaded when someone is looking at it
  const REFRESH_MS = 15_000;

  useEffect(() => {
    let mounted = true;
    let interval: NodeJS.Timeout;

    async function load() {
      try {
        const [healthData, historyData] = await Promise.all([
          fetchWithAuth('/api/admin/health'),
          fetchWithAuth('/api/admin/health/history?period=1h&interval=1m'),
        ]);
        if (mounted) {
          setHealth(healthData);
          setResponseTimeHistory(historyData.datapoints || []);
        }
      } catch (err) {
        console.error('Health check failed:', err);
        // if the health check itself fails, that's... not great
      } finally {
        if (mounted) setLoading(false);
      }
    }

    load();
    if (autoRefresh) {
      interval = setInterval(load, REFRESH_MS);
    }

    return () => {
      mounted = false;
      if (interval) clearInterval(interval);
    };
  }, [autoRefresh]);

  if (loading) {
    return <div className="text-gray-500 p-8 text-center">Loading system health...</div>;
  }

  if (!health) {
    return <div className="text-red-500 p-8 text-center">Failed to load health data</div>;
  }

  const overallStatus = health.services.every(s => s.status === 'healthy')
    ? 'healthy'
    : health.services.some(s => s.status === 'down')
      ? 'down'
      : 'degraded';

  const statusColors = {
    healthy: 'text-green-600',
    degraded: 'text-yellow-600',
    down: 'text-red-600',
  };

  const statusBg = {
    healthy: 'bg-green-50 border-green-200',
    degraded: 'bg-yellow-50 border-yellow-200',
    down: 'bg-red-50 border-red-200',
  };

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">System Health</h1>
          <span className={`text-sm font-medium ${statusColors[overallStatus]}`}>
            Overall: {overallStatus.toUpperCase()}
          </span>
        </div>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={e => setAutoRefresh(e.target.checked)}
            />
            Auto-refresh (15s)
          </label>
        </div>
      </div>

      {/* Overview metrics */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <MetricCard
          title="DB Connections"
          value={`${health.database.activeConnections}/${health.database.maxConnections}`}
          variant={
            health.database.activeConnections / health.database.maxConnections > 0.8
              ? 'danger'
              : health.database.activeConnections / health.database.maxConnections > 0.6
                ? 'warning'
                : 'default'
          }
          icon="database"
        />
        <MetricCard
          title="Avg Query Time"
          value={`${health.database.avgQueryMs}ms`}
          variant={health.database.avgQueryMs > 500 ? 'danger' : health.database.avgQueryMs > 200 ? 'warning' : 'default'}
          icon="clock"
        />
        <MetricCard
          title="CPU Usage"
          value={formatPercent(health.cpu)}
          variant={health.cpu > 80 ? 'danger' : health.cpu > 60 ? 'warning' : 'default'}
          icon="cpu"
        />
        <MetricCard
          title="Memory"
          value={`${Math.round(health.memory.usedMb)}MB / ${health.memory.totalMb}MB`}
          variant={
            health.memory.usedMb / health.memory.totalMb > 0.85 ? 'danger' :
            health.memory.usedMb / health.memory.totalMb > 0.7 ? 'warning' : 'default'
          }
          icon="memory"
        />
      </div>

      {/* Response time chart */}
      <div className="bg-white rounded-lg shadow p-4 mb-6">
        <h2 className="font-semibold mb-4">Response Time (1h)</h2>
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart data={responseTimeHistory}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis
              dataKey="timestamp"
              tickFormatter={(val: string) => {
                // TODO: this is gross, should use date-fns
                const d = new Date(val);
                return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
              }}
            />
            <YAxis unit="ms" />
            <Tooltip />
            <Area type="monotone" dataKey="p50" stroke="#3b82f6" fill="#dbeafe" name="p50" />
            <Area type="monotone" dataKey="p99" stroke="#ef4444" fill="#fee2e2" name="p99" />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Service status grid */}
      <div className="bg-white rounded-lg shadow p-4 mb-6">
        <h2 className="font-semibold mb-4">Services</h2>
        <div className="grid grid-cols-2 gap-3">
          {health.services.map(service => (
            <div
              key={service.name}
              className={`border rounded-lg p-3 ${statusBg[service.status]}`}
            >
              <div className="flex justify-between items-center">
                <div className="flex items-center gap-2">
                  <span className={`inline-block w-2.5 h-2.5 rounded-full ${
                    service.status === 'healthy' ? 'bg-green-500' :
                    service.status === 'degraded' ? 'bg-yellow-500' :
                    'bg-red-500'
                  }`} />
                  <span className="font-medium text-sm">{service.name}</span>
                </div>
                <span className="text-xs text-gray-500">
                  {service.latencyMs}ms | {formatPercent(service.uptime)} uptime
                </span>
              </div>
              {service.details && (
                <p className="text-xs text-gray-600 mt-1 ml-4">{service.details}</p>
              )}
            </div>
          ))}
          {/* show any services we expect but didn't get status for */}
          {KNOWN_SERVICES
            .filter(name => !health.services.find(s => s.name === name))
            .map(name => (
              <div key={name} className="border rounded-lg p-3 bg-gray-50 border-gray-200">
                <div className="flex items-center gap-2">
                  <span className="inline-block w-2.5 h-2.5 rounded-full bg-gray-400" />
                  <span className="font-medium text-sm text-gray-500">{name}</span>
                  <span className="text-xs text-gray-400">(no status reported)</span>
                </div>
              </div>
            ))}
        </div>
      </div>

      {/* Queue depths */}
      <div className="bg-white rounded-lg shadow p-4 mb-6">
        <h2 className="font-semibold mb-4">Message Queues</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500 border-b">
              <th className="pb-2">Queue</th>
              <th className="pb-2">Depth</th>
              <th className="pb-2">Processing Rate</th>
              <th className="pb-2">Error Rate</th>
              <th className="pb-2">Oldest Message</th>
            </tr>
          </thead>
          <tbody>
            {health.queues.map(queue => (
              <tr key={queue.name} className="border-b last:border-b-0">
                <td className="py-2 font-mono text-xs">{queue.name}</td>
                <td className={`py-2 ${queue.depth > 1000 ? 'text-red-600 font-semibold' : ''}`}>
                  {formatNumber(queue.depth)}
                </td>
                <td className="py-2">{queue.processingRate}/min</td>
                <td className={`py-2 ${queue.errorRate > 5 ? 'text-red-600' : ''}`}>
                  {formatPercent(queue.errorRate)}
                </td>
                <td className="py-2 text-gray-500 text-xs">
                  {queue.oldestMessage
                    ? new Date(queue.oldestMessage).toLocaleString()
                    : 'N/A'
                  }
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* DB details */}
      <div className="bg-white rounded-lg shadow p-4">
        <h2 className="font-semibold mb-4">Database</h2>
        <div className="grid grid-cols-3 gap-4 text-sm">
          <div>
            <span className="text-gray-500">Active Connections</span>
            <p className="text-lg font-semibold">
              {health.database.activeConnections} / {health.database.maxConnections}
            </p>
            {/* progress bar */}
            <div className="w-full bg-gray-200 rounded-full h-2 mt-1">
              <div
                className={`h-2 rounded-full ${
                  health.database.activeConnections / health.database.maxConnections > 0.8
                    ? 'bg-red-500'
                    : 'bg-blue-500'
                }`}
                style={{ width: `${(health.database.activeConnections / health.database.maxConnections) * 100}%` }}
              />
            </div>
          </div>
          <div>
            <span className="text-gray-500">Slow Queries (last hour)</span>
            <p className={`text-lg font-semibold ${health.database.slowQueries > 10 ? 'text-red-600' : ''}`}>
              {health.database.slowQueries}
            </p>
          </div>
          <div>
            <span className="text-gray-500">Replication Lag</span>
            <p className={`text-lg font-semibold ${health.database.replicationLag > 5000 ? 'text-red-600' : ''}`}>
              {health.database.replicationLag}ms
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
