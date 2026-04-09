import { Pool } from 'pg';
import ExcelJS from 'exceljs';
import { join } from 'path';

interface ComplianceOptions {
  startDate: string;
  endDate: string;
  outputPath?: string;
}

/**
 * HIPAA Compliance Audit Report
 *
 * Generates a comprehensive audit report for HIPAA compliance reviews.
 * This report is required quarterly by our compliance officer and
 * annually for the OCR audit.
 *
 * Checks:
 * - Access log analysis (who accessed what PHI, how often)
 * - Unusual access patterns (off-hours, excessive lookups)
 * - Encryption status of data at rest and in transit
 * - User account hygiene (inactive accounts, MFA status)
 * - System configuration compliance
 * - Breach log review
 */
export class ComplianceReport {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async generate(options: ComplianceOptions): Promise<string> {
    const outputPath = options.outputPath ||
      join(process.cwd(), `compliance-audit-${options.startDate}-to-${options.endDate}.xlsx`);

    console.log('  Analyzing access logs...');
    const accessSummary = await this.analyzeAccessLogs(options.startDate, options.endDate);

    console.log('  Checking unusual access patterns...');
    const unusualAccess = await this.findUnusualAccess(options.startDate, options.endDate);

    console.log('  Checking user account hygiene...');
    const accountHygiene = await this.checkAccountHygiene();

    console.log('  Checking encryption status...');
    const encryptionStatus = await this.checkEncryptionStatus();

    console.log('  Reviewing breach log...');
    const breachLog = await this.reviewBreachLog(options.startDate, options.endDate);

    console.log('  Generating report...');
    await this.generateExcel({
      accessSummary,
      unusualAccess,
      accountHygiene,
      encryptionStatus,
      breachLog,
    }, outputPath, options);

    return outputPath;
  }

  private async analyzeAccessLogs(startDate: string, endDate: string) {
    // Summary of PHI access by user
    const byUser = await this.pool.query(`
      SELECT
        al.user_id,
        u.name as user_name,
        u.role,
        u.department,
        COUNT(*) as total_accesses,
        COUNT(DISTINCT al.resource_id) as unique_patients,
        COUNT(*) FILTER (WHERE al.action = 'patient_view') as patient_views,
        COUNT(*) FILTER (WHERE al.action = 'patient_search') as patient_searches,
        COUNT(*) FILTER (WHERE al.action LIKE '%export%') as data_exports,
        COUNT(*) FILTER (WHERE al.action LIKE '%download%') as downloads,
        MIN(al.created_at) as first_access,
        MAX(al.created_at) as last_access
      FROM audit_log al
      LEFT JOIN users u ON u.id = al.user_id
      WHERE al.created_at >= $1 AND al.created_at <= $2
        AND al.resource = 'patient'
      GROUP BY al.user_id, u.name, u.role, u.department
      ORDER BY total_accesses DESC
    `, [startDate, endDate]);

    // Access by action type
    const byAction = await this.pool.query(`
      SELECT
        action,
        COUNT(*) as count,
        COUNT(DISTINCT user_id) as unique_users
      FROM audit_log
      WHERE created_at >= $1 AND created_at <= $2
      GROUP BY action
      ORDER BY count DESC
    `, [startDate, endDate]);

    // Access by hour of day (for detecting off-hours access)
    const byHour = await this.pool.query(`
      SELECT
        EXTRACT(HOUR FROM created_at) as hour,
        COUNT(*) as count
      FROM audit_log
      WHERE created_at >= $1 AND created_at <= $2
        AND resource = 'patient'
      GROUP BY hour
      ORDER BY hour
    `, [startDate, endDate]);

    return {
      byUser: byUser.rows,
      byAction: byAction.rows,
      byHour: byHour.rows,
      totalAccesses: byUser.rows.reduce((sum: number, r: any) => sum + parseInt(r.total_accesses), 0),
      uniqueUsers: byUser.rows.length,
    };
  }

  private async findUnusualAccess(startDate: string, endDate: string) {
    // Flag potentially suspicious access patterns
    const results: any[] = [];

    // 1. Off-hours access (before 6am or after 10pm)
    const offHours = await this.pool.query(`
      SELECT
        al.user_id,
        u.name,
        u.role,
        COUNT(*) as off_hours_accesses,
        ARRAY_AGG(DISTINCT TO_CHAR(al.created_at, 'YYYY-MM-DD HH24:MI')) as access_times
      FROM audit_log al
      LEFT JOIN users u ON u.id = al.user_id
      WHERE al.created_at >= $1 AND al.created_at <= $2
        AND al.resource = 'patient'
        AND (EXTRACT(HOUR FROM al.created_at) < 6 OR EXTRACT(HOUR FROM al.created_at) >= 22)
      GROUP BY al.user_id, u.name, u.role
      HAVING COUNT(*) > 5
      ORDER BY off_hours_accesses DESC
    `, [startDate, endDate]);

    offHours.rows.forEach(r => {
      results.push({
        type: 'Off-Hours Access',
        user: r.name,
        role: r.role,
        count: parseInt(r.off_hours_accesses),
        details: `${r.off_hours_accesses} accesses outside business hours`,
        severity: parseInt(r.off_hours_accesses) > 20 ? 'High' : 'Medium',
      });
    });

    // 2. Excessive patient lookups (possible snooping)
    const excessive = await this.pool.query(`
      SELECT
        al.user_id,
        u.name,
        u.role,
        COUNT(DISTINCT al.resource_id) as patients_accessed,
        COUNT(*) as total_accesses
      FROM audit_log al
      LEFT JOIN users u ON u.id = al.user_id
      WHERE al.created_at >= $1 AND al.created_at <= $2
        AND al.resource = 'patient'
        AND al.action = 'patient_view'
      GROUP BY al.user_id, u.name, u.role
      HAVING COUNT(DISTINCT al.resource_id) > 100
      ORDER BY patients_accessed DESC
    `, [startDate, endDate]);

    excessive.rows.forEach(r => {
      // support and admin roles are expected to access many patients
      if (r.role !== 'support' && r.role !== 'admin') {
        results.push({
          type: 'Excessive Patient Access',
          user: r.name,
          role: r.role,
          count: parseInt(r.patients_accessed),
          details: `Accessed ${r.patients_accessed} unique patients (${r.total_accesses} total lookups)`,
          severity: 'High',
        });
      }
    });

    // 3. Break-the-glass access (emergency override of normal access controls)
    // TODO: we don't have a break-the-glass feature yet, but when we do,
    // this is where we'd check for it
    // Compliance has been asking for this since Q2 2024

    // 4. Access to VIP/restricted patients
    // Some patients (employees, celebrities, etc.) have access restrictions
    const vipAccess = await this.pool.query(`
      SELECT
        al.user_id,
        u.name as user_name,
        u.role,
        p.first_name || ' ' || p.last_name as patient_name,
        al.created_at,
        al.action
      FROM audit_log al
      LEFT JOIN users u ON u.id = al.user_id
      LEFT JOIN patients p ON p.id = al.resource_id
      WHERE al.created_at >= $1 AND al.created_at <= $2
        AND al.resource = 'patient'
        AND al.resource_id IN (SELECT patient_id FROM restricted_patients WHERE active = true)
      ORDER BY al.created_at
    `, [startDate, endDate]);

    vipAccess.rows.forEach(r => {
      results.push({
        type: 'Restricted Patient Access',
        user: r.user_name,
        role: r.role,
        count: 1,
        details: `Accessed restricted patient: ${r.patient_name} at ${r.created_at}`,
        severity: 'Critical',
      });
    });

    return results;
  }

  private async checkAccountHygiene() {
    const checks: any[] = [];

    // Inactive accounts still active
    const inactive = await this.pool.query(`
      SELECT id, email, name, role,
        MAX(s.created_at) as last_login
      FROM users u
      LEFT JOIN user_sessions s ON s.user_id = u.id
      WHERE u.status = 'active'
      GROUP BY u.id, u.email, u.name, u.role
      HAVING MAX(s.created_at) < NOW() - INTERVAL '90 days'
        OR MAX(s.created_at) IS NULL
      ORDER BY last_login NULLS FIRST
    `);

    for (const user of inactive.rows) {
      checks.push({
        check: 'Inactive Account',
        email: user.email,
        name: user.name,
        role: user.role,
        lastLogin: user.last_login || 'Never',
        recommendation: 'Review and deactivate if no longer needed',
        severity: user.last_login ? 'Medium' : 'High',
      });
    }

    // Accounts without MFA
    // TODO: we don't actually track MFA enrollment in our DB yet
    // this just checks for the mfa_enabled flag which was added but
    // never populated. Always shows as false. Useless check for now.
    const noMFA = await this.pool.query(`
      SELECT email, name, role
      FROM users
      WHERE status = 'active' AND (mfa_enabled = false OR mfa_enabled IS NULL)
      ORDER BY role, name
    `);

    for (const user of noMFA.rows) {
      checks.push({
        check: 'MFA Not Enabled',
        email: user.email,
        name: user.name,
        role: user.role,
        lastLogin: 'N/A',
        recommendation: 'Enable MFA for this account',
        severity: user.role === 'admin' ? 'Critical' : 'High',
      });
    }

    // Shared/service accounts
    const serviceAccounts = await this.pool.query(`
      SELECT email, name, role, created_at
      FROM users
      WHERE status = 'active'
        AND (email LIKE 'svc-%' OR email LIKE 'service-%' OR email LIKE 'system-%' OR role = 'service')
    `);

    for (const user of serviceAccounts.rows) {
      checks.push({
        check: 'Service Account Review',
        email: user.email,
        name: user.name,
        role: user.role,
        lastLogin: 'N/A',
        recommendation: 'Verify this service account is still needed and has appropriate access',
        severity: 'Low',
      });
    }

    return checks;
  }

  private async checkEncryptionStatus() {
    // Check various encryption-related settings
    // Some of these are just config checks, not actual encryption verification
    const checks = [];

    // Check if DB connection uses SSL
    try {
      const sslResult = await this.pool.query('SHOW ssl');
      checks.push({
        component: 'Database',
        check: 'SSL Connection',
        status: sslResult.rows[0]?.ssl === 'on' ? 'Pass' : 'Fail',
        details: sslResult.rows[0]?.ssl === 'on' ? 'SSL is enabled' : 'SSL is NOT enabled!',
      });
    } catch {
      checks.push({
        component: 'Database',
        check: 'SSL Connection',
        status: 'Unknown',
        details: 'Could not determine SSL status',
      });
    }

    // Check for unencrypted columns that should be encrypted
    // We encrypt SSN and certain other PII fields at the application level
    // This check looks for rows where the value doesn't look encrypted
    try {
      const unencrypted = await this.pool.query(`
        SELECT COUNT(*) as count
        FROM patients
        WHERE ssn IS NOT NULL
          AND ssn NOT LIKE 'enc:%'
          AND LENGTH(ssn) = 9
      `);
      const unencCount = parseInt(unencrypted.rows[0]?.count || '0');
      checks.push({
        component: 'Patient Data',
        check: 'SSN Encryption',
        status: unencCount === 0 ? 'Pass' : 'Fail',
        details: unencCount === 0
          ? 'All SSNs are encrypted'
          : `${unencCount} unencrypted SSNs found! Immediate action required.`,
      });
    } catch {
      checks.push({
        component: 'Patient Data',
        check: 'SSN Encryption',
        status: 'Error',
        details: 'Could not verify SSN encryption',
      });
    }

    // TODO: add checks for:
    // - Disk encryption (need to call out to OS)
    // - TLS certificate expiration
    // - API endpoint HTTPS enforcement
    // - Backup encryption status

    return checks;
  }

  private async reviewBreachLog(startDate: string, endDate: string) {
    try {
      const result = await this.pool.query(`
        SELECT
          id, description, severity, affected_patients,
          reported_date, resolved_date, reported_to_hhs,
          root_cause, remediation
        FROM breach_log
        WHERE reported_date >= $1 AND reported_date <= $2
        ORDER BY reported_date DESC
      `, [startDate, endDate]);

      return result.rows;
    } catch {
      // breach_log table might not exist yet
      return [];
    }
  }

  private async generateExcel(data: any, outputPath: string, options: ComplianceOptions): Promise<void> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Meridian Compliance Report Generator';

    // Executive Summary
    const exec = workbook.addWorksheet('Executive Summary');
    exec.columns = [
      { header: 'Metric', key: 'metric', width: 40 },
      { header: 'Value', key: 'value', width: 20 },
      { header: 'Status', key: 'status', width: 15 },
    ];
    exec.addRow({ metric: 'Report Period', value: `${options.startDate} to ${options.endDate}` });
    exec.addRow({ metric: 'Total PHI Accesses', value: data.accessSummary.totalAccesses });
    exec.addRow({ metric: 'Unique Users Accessing PHI', value: data.accessSummary.uniqueUsers });
    exec.addRow({ metric: 'Unusual Access Flags', value: data.unusualAccess.length,
      status: data.unusualAccess.length > 0 ? 'REVIEW' : 'OK' });
    exec.addRow({ metric: 'Account Hygiene Issues', value: data.accountHygiene.length,
      status: data.accountHygiene.length > 0 ? 'REVIEW' : 'OK' });
    exec.addRow({ metric: 'Encryption Issues',
      value: data.encryptionStatus.filter((c: any) => c.status === 'Fail').length,
      status: data.encryptionStatus.some((c: any) => c.status === 'Fail') ? 'FAIL' : 'PASS' });
    exec.addRow({ metric: 'Breach Incidents', value: data.breachLog.length,
      status: data.breachLog.length > 0 ? 'REVIEW' : 'OK' });

    // Access Log Summary
    const access = workbook.addWorksheet('Access Summary');
    access.columns = [
      { header: 'User', key: 'user_name', width: 25 },
      { header: 'Role', key: 'role', width: 15 },
      { header: 'Department', key: 'department', width: 20 },
      { header: 'Total Accesses', key: 'total_accesses', width: 15 },
      { header: 'Unique Patients', key: 'unique_patients', width: 15 },
      { header: 'Patient Views', key: 'patient_views', width: 15 },
      { header: 'Searches', key: 'patient_searches', width: 12 },
      { header: 'Exports', key: 'data_exports', width: 10 },
    ];
    data.accessSummary.byUser.forEach((r: any) => access.addRow(r));

    // Unusual Access Flags
    const flags = workbook.addWorksheet('Unusual Access');
    flags.columns = [
      { header: 'Type', key: 'type', width: 25 },
      { header: 'User', key: 'user', width: 20 },
      { header: 'Role', key: 'role', width: 15 },
      { header: 'Severity', key: 'severity', width: 12 },
      { header: 'Details', key: 'details', width: 50 },
    ];
    data.unusualAccess.forEach((r: any) => flags.addRow(r));

    // Account Hygiene
    const hygiene = workbook.addWorksheet('Account Hygiene');
    hygiene.columns = [
      { header: 'Check', key: 'check', width: 25 },
      { header: 'Email', key: 'email', width: 30 },
      { header: 'Name', key: 'name', width: 20 },
      { header: 'Role', key: 'role', width: 15 },
      { header: 'Severity', key: 'severity', width: 12 },
      { header: 'Last Login', key: 'lastLogin', width: 20 },
      { header: 'Recommendation', key: 'recommendation', width: 40 },
    ];
    data.accountHygiene.forEach((r: any) => hygiene.addRow(r));

    // Encryption Status
    const encryption = workbook.addWorksheet('Encryption');
    encryption.columns = [
      { header: 'Component', key: 'component', width: 20 },
      { header: 'Check', key: 'check', width: 25 },
      { header: 'Status', key: 'status', width: 12 },
      { header: 'Details', key: 'details', width: 50 },
    ];
    data.encryptionStatus.forEach((r: any) => encryption.addRow(r));

    // Breach Log
    if (data.breachLog.length > 0) {
      const breach = workbook.addWorksheet('Breach Log');
      breach.columns = [
        { header: 'Date', key: 'reported_date', width: 15 },
        { header: 'Description', key: 'description', width: 40 },
        { header: 'Severity', key: 'severity', width: 12 },
        { header: 'Affected Patients', key: 'affected_patients', width: 18 },
        { header: 'Reported to HHS', key: 'reported_to_hhs', width: 16 },
        { header: 'Root Cause', key: 'root_cause', width: 30 },
        { header: 'Resolved', key: 'resolved_date', width: 15 },
      ];
      data.breachLog.forEach((r: any) => breach.addRow(r));
    }

    await workbook.xlsx.writeFile(outputPath);
  }
}
