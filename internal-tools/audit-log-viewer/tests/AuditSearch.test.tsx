import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AuditSearch from '../src/pages/AuditSearch';

// Mock the audit API
vi.mock('../src/services/auditApi', () => ({
  searchAuditLogs: vi.fn().mockResolvedValue({
    entries: [
      {
        id: 'entry-1',
        timestamp: '2024-12-15T10:30:00.000Z',
        userId: 'user-1',
        userName: 'Alice Chen',
        userRole: 'support',
        action: 'patient_view',
        resourceType: 'patient',
        resourceId: 'pat-123',
        ipAddress: '10.0.1.50',
      },
      {
        id: 'entry-2',
        timestamp: '2024-12-15T10:25:00.000Z',
        userId: 'user-2',
        userName: 'Bob Martinez',
        userRole: 'provider',
        action: 'patient_search',
        resourceType: 'patient',
        resourceId: null,
        ipAddress: '10.0.1.75',
      },
    ],
    total: 2,
    page: 1,
  }),
}));

function renderWithRouter(ui: React.ReactElement) {
  return render(
    <MemoryRouter>
      {ui}
    </MemoryRouter>
  );
}

describe('AuditSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the search page title', () => {
    renderWithRouter(<AuditSearch />);
    expect(screen.getByText('Audit Log Search')).toBeTruthy();
  });

  it('renders search filters', () => {
    renderWithRouter(<AuditSearch />);
    expect(screen.getByText('User ID / Email')).toBeTruthy();
    expect(screen.getByText('Patient ID / MRN')).toBeTruthy();
    expect(screen.getByText('Action')).toBeTruthy();
  });

  it('loads results on mount', async () => {
    renderWithRouter(<AuditSearch />);
    await waitFor(() => {
      expect(screen.getByText('Alice Chen')).toBeTruthy();
      expect(screen.getByText('Bob Martinez')).toBeTruthy();
    });
  });

  it('shows entry count', async () => {
    renderWithRouter(<AuditSearch />);
    await waitFor(() => {
      expect(screen.getByText('2 entries found')).toBeTruthy();
    });
  });

  it('has advanced filters toggle', () => {
    renderWithRouter(<AuditSearch />);
    const toggle = screen.getByText('Show Advanced Filters');
    expect(toggle).toBeTruthy();
  });

  it('shows advanced filters when toggled', async () => {
    renderWithRouter(<AuditSearch />);
    const toggle = screen.getByText('Show Advanced Filters');
    fireEvent.click(toggle);
    expect(screen.getByText('IP Address')).toBeTruthy();
    // these are disabled/coming soon
    expect(screen.getByText(/not working yet/)).toBeTruthy();
    expect(screen.getByText(/coming soon/)).toBeTruthy();
  });

  // TODO: add tests for:
  // - search with filters
  // - pagination
  // - error states
  // - export button (currently shows alert)
  // - date range validation

  it('has an export button', () => {
    renderWithRouter(<AuditSearch />);
    expect(screen.getByText('Export CSV')).toBeTruthy();
  });

  // skipping because the alert mock is weird with vitest
  it.skip('export button shows not-implemented message', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    renderWithRouter(<AuditSearch />);
    fireEvent.click(screen.getByText('Export CSV'));
    expect(alertSpy).toHaveBeenCalled();
  });
});
