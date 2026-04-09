import React from 'react';
import { BrowserRouter, Routes, Route, Link, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Dashboard from './pages/Dashboard';
import PatientLookup from './pages/PatientLookup';
import ClaimsQueue from './pages/ClaimsQueue';
import SystemHealth from './pages/SystemHealth';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // TODO: probably too aggressive for prod, but helps during dev
      refetchOnWindowFocus: true,
      retry: 2,
      staleTime: 30_000,
    },
  },
});

// TODO: dark mode toggle - started this but didn't finish
// const ThemeContext = React.createContext<{ isDark: boolean; toggle: () => void }>({
//   isDark: false,
//   toggle: () => {},
// });
//
// function useTheme() {
//   const [isDark, setIsDark] = React.useState(() => {
//     const saved = localStorage.getItem('meridian-theme');
//     return saved === 'dark';
//   });
//   const toggle = () => {
//     setIsDark(prev => {
//       localStorage.setItem('meridian-theme', !prev ? 'dark' : 'light');
//       return !prev;
//     });
//   };
//   return { isDark, toggle };
// }

function NavBar() {
  // HACK: the active link styling is janky, using window.location instead of useLocation
  // because of some weird re-render issue I couldn't figure out
  const path = window.location.pathname;

  return (
    <nav className="bg-slate-800 text-white px-6 py-3 flex items-center gap-6">
      <div className="font-bold text-lg mr-4">
        Meridian Admin
        <span className="text-xs text-slate-400 ml-2">v2.14.3</span>
      </div>
      <Link
        to="/"
        className={`hover:text-blue-300 ${path === '/' ? 'text-blue-400 font-semibold' : ''}`}
      >
        Dashboard
      </Link>
      <Link
        to="/patients"
        className={`hover:text-blue-300 ${path === '/patients' ? 'text-blue-400 font-semibold' : ''}`}
      >
        Patient Lookup
      </Link>
      <Link
        to="/claims"
        className={`hover:text-blue-300 ${path === '/claims' ? 'text-blue-400 font-semibold' : ''}`}
      >
        Claims Queue
      </Link>
      <Link
        to="/system"
        className={`hover:text-blue-300 ${path === '/system' ? 'text-blue-400 font-semibold' : ''}`}
      >
        System Health
      </Link>

      {/* TODO: dark mode toggle button goes here */}
      {/* <button onClick={theme.toggle}>{theme.isDark ? '☀' : '🌙'}</button> */}

      <div className="ml-auto flex items-center gap-3">
        {/* TODO: pull from actual auth context, not hardcoded */}
        <span className="text-sm text-slate-300">admin@meridianhealth.io</span>
        <button className="text-sm bg-slate-700 px-3 py-1 rounded hover:bg-slate-600">
          Logout
        </button>
      </div>
    </nav>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <div className="min-h-screen bg-gray-50">
          <NavBar />
          <main className="p-6">
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/patients" element={<PatientLookup />} />
              <Route path="/claims" element={<ClaimsQueue />} />
              <Route path="/system" element={<SystemHealth />} />
              {/* catch-all, just go home */}
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </main>
        </div>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
