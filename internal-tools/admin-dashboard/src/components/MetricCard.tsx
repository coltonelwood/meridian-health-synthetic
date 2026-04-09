import React from 'react';

interface MetricCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  icon?: string; // TODO: actually use icons, right now this is ignored
  trend?: {
    value: number;
    direction: 'up' | 'down';
    isGood: boolean;
  };
  variant?: 'default' | 'success' | 'warning' | 'danger';
}

const variantStyles = {
  default: 'bg-white border-gray-200',
  success: 'bg-green-50 border-green-200',
  warning: 'bg-yellow-50 border-yellow-200',
  danger: 'bg-red-50 border-red-200',
};

export default function MetricCard({
  title,
  value,
  subtitle,
  icon,
  trend,
  variant = 'default',
}: MetricCardProps) {
  return (
    <div className={`rounded-lg border p-4 shadow-sm ${variantStyles[variant]}`}>
      <div className="flex justify-between items-start">
        <div>
          <p className="text-sm text-gray-500 font-medium">{title}</p>
          <p className="text-2xl font-bold mt-1">{value}</p>
          {subtitle && (
            <p className="text-xs text-gray-400 mt-0.5">{subtitle}</p>
          )}
        </div>
        {/* TODO: render actual icon based on icon prop
            maybe use lucide-react? heroicons? we don't have either installed yet */}
        {icon && (
          <div className="w-8 h-8 bg-gray-100 rounded flex items-center justify-center text-gray-400 text-xs">
            {/* placeholder */}
            {icon.charAt(0).toUpperCase()}
          </div>
        )}
      </div>
      {trend && (
        <div className={`mt-2 text-xs font-medium ${
          trend.isGood ? 'text-green-600' : 'text-red-600'
        }`}>
          {trend.direction === 'up' ? '+' : '-'}{Math.abs(trend.value)}%
          <span className="text-gray-400 ml-1">vs last period</span>
        </div>
      )}
    </div>
  );
}
