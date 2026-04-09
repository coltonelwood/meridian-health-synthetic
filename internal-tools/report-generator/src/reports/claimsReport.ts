import { Pool } from 'pg';
import ExcelJS from 'exceljs';
import { format, startOfMonth, endOfMonth, parseISO } from 'date-fns';
import { join } from 'path';

interface ReportOptions {
  month: string;
  format: string;
  outputPath?: string;
  payerFilter?: string;
  providerFilter?: string;
}

interface ClaimsSummary {
  totalClaims: number;
  totalBilled: number;
  totalPaid: number;
  totalAdjustments: number;
  avgDaysToProcess: number;
  denialRate: number;
  byStatus: Record<string, { count: number; amount: number }>;
  byPayer: { payer: string; claims: number; billed: number; paid: number; denialRate: number }[];
  byClaimType: { type: string; claims: number; billed: number; paid: number }[];
  topDenialReasons: { code: string; description: string; count: number }[];
  topProcedures: { code: string; description: string; count: number; totalBilled: number }[];
}

/**
 * Monthly claims summary report.
 *
 * WARNING: Large date ranges (>3 months) will cause performance issues.
 * The underlying SQL queries do full table scans because we're joining
 * claims, patients, and providers without proper indexes on the date columns.
 * DBA has been asked to add indexes but it's been 3 months and counting.
 *
 * For now, stick to single-month reports. If you need multi-month data,
 * generate each month separately and combine them in Excel.
 */
export class ClaimsReport {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async generate(options: ReportOptions): Promise<string> {
    const monthDate = parseISO(`${options.month}-01`);
    const startDate = startOfMonth(monthDate);
    const endDate = endOfMonth(monthDate);

    console.log(`  Date range: ${format(startDate, 'yyyy-MM-dd')} to ${format(endDate, 'yyyy-MM-dd')}`);

    // Fetch all the data
    const summary = await this.fetchSummary(startDate, endDate, options);

    // Generate the output file
    const outputPath = options.outputPath ||
      join(process.cwd(), `claims-report-${options.month}.${options.format === 'csv' ? 'csv' : 'xlsx'}`);

    if (options.format === 'excel' || options.format === 'xlsx') {
      await this.generateExcel(summary, outputPath, options.month);
    } else if (options.format === 'csv') {
      await this.generateCSV(summary, outputPath);
    } else if (options.format === 'pdf') {
      // TODO: PDF generation is broken - pdfmake has issues with our table formatting
      // For now, fall back to Excel
      console.log('  PDF format not fully supported, generating Excel instead');
      await this.generateExcel(summary, outputPath.replace('.pdf', '.xlsx'), options.month);
    }

    return outputPath;
  }

  private async fetchSummary(
    startDate: Date,
    endDate: Date,
    options: ReportOptions
  ): Promise<ClaimsSummary> {
    const params: any[] = [startDate.toISOString(), endDate.toISOString()];
    let paramIdx = 3;

    let payerClause = '';
    if (options.payerFilter) {
      payerClause = `AND c.payer_name ILIKE $${paramIdx}`;
      params.push(`%${options.payerFilter}%`);
      paramIdx++;
    }

    let providerClause = '';
    if (options.providerFilter) {
      providerClause = `AND c.provider_npi = $${paramIdx}`;
      params.push(options.providerFilter);
      paramIdx++;
    }

    // Main summary query
    // NOTE: this is a big honkin' query. It could be broken into smaller queries
    // but then we'd need multiple round trips. Pick your poison.
    const summaryResult = await this.pool.query(`
      SELECT
        COUNT(*) as total_claims,
        COALESCE(SUM(billed_amount), 0) as total_billed,
        COALESCE(SUM(paid_amount), 0) as total_paid,
        COALESCE(SUM(adjustment_amount), 0) as total_adjustments,
        AVG(EXTRACT(EPOCH FROM (
          COALESCE(processed_at, NOW()) - submitted_date
        )) / 86400) as avg_days_to_process,
        COUNT(*) FILTER (WHERE status = 'denied')::float / NULLIF(COUNT(*), 0) * 100 as denial_rate
      FROM claims c
      WHERE c.service_date >= $1 AND c.service_date <= $2
      ${payerClause}
      ${providerClause}
    `, params);

    const summary = summaryResult.rows[0];

    // By status breakdown
    const statusResult = await this.pool.query(`
      SELECT
        status,
        COUNT(*) as count,
        COALESCE(SUM(billed_amount), 0) as amount
      FROM claims c
      WHERE c.service_date >= $1 AND c.service_date <= $2
      ${payerClause}
      ${providerClause}
      GROUP BY status
      ORDER BY count DESC
    `, params);

    const byStatus: Record<string, { count: number; amount: number }> = {};
    for (const row of statusResult.rows) {
      byStatus[row.status] = {
        count: parseInt(row.count),
        amount: parseFloat(row.amount),
      };
    }

    // By payer breakdown
    const payerResult = await this.pool.query(`
      SELECT
        payer_name as payer,
        COUNT(*) as claims,
        COALESCE(SUM(billed_amount), 0) as billed,
        COALESCE(SUM(paid_amount), 0) as paid,
        COUNT(*) FILTER (WHERE status = 'denied')::float / NULLIF(COUNT(*), 0) * 100 as denial_rate
      FROM claims c
      WHERE c.service_date >= $1 AND c.service_date <= $2
      ${payerClause}
      ${providerClause}
      GROUP BY payer_name
      ORDER BY billed DESC
    `, params);

    // By claim type
    const typeResult = await this.pool.query(`
      SELECT
        claim_type as type,
        COUNT(*) as claims,
        COALESCE(SUM(billed_amount), 0) as billed,
        COALESCE(SUM(paid_amount), 0) as paid
      FROM claims c
      WHERE c.service_date >= $1 AND c.service_date <= $2
      ${payerClause}
      ${providerClause}
      GROUP BY claim_type
      ORDER BY claims DESC
    `, params);

    // Top denial reasons
    const denialResult = await this.pool.query(`
      SELECT
        denial_reason_code as code,
        -- TODO: join with denial_codes table for descriptions
        -- for now just show the code
        denial_reason_code as description,
        COUNT(*) as count
      FROM claims c
      WHERE c.service_date >= $1 AND c.service_date <= $2
        AND c.status = 'denied'
        AND c.denial_reason_code IS NOT NULL
      ${payerClause}
      ${providerClause}
      GROUP BY denial_reason_code
      ORDER BY count DESC
      LIMIT 10
    `, params);

    // Top procedures
    const procResult = await this.pool.query(`
      SELECT
        procedure_code_1 as code,
        procedure_code_1 as description,
        COUNT(*) as count,
        COALESCE(SUM(billed_amount), 0) as total_billed
      FROM claims c
      WHERE c.service_date >= $1 AND c.service_date <= $2
        AND c.procedure_code_1 IS NOT NULL
      ${payerClause}
      ${providerClause}
      GROUP BY procedure_code_1
      ORDER BY count DESC
      LIMIT 20
    `, params);

    return {
      totalClaims: parseInt(summary.total_claims),
      totalBilled: parseFloat(summary.total_billed),
      totalPaid: parseFloat(summary.total_paid),
      totalAdjustments: parseFloat(summary.total_adjustments),
      avgDaysToProcess: parseFloat(summary.avg_days_to_process) || 0,
      denialRate: parseFloat(summary.denial_rate) || 0,
      byStatus,
      byPayer: payerResult.rows.map(r => ({
        payer: r.payer,
        claims: parseInt(r.claims),
        billed: parseFloat(r.billed),
        paid: parseFloat(r.paid),
        denialRate: parseFloat(r.denial_rate) || 0,
      })),
      byClaimType: typeResult.rows.map(r => ({
        type: r.type,
        claims: parseInt(r.claims),
        billed: parseFloat(r.billed),
        paid: parseFloat(r.paid),
      })),
      topDenialReasons: denialResult.rows.map(r => ({
        code: r.code,
        description: r.description,
        count: parseInt(r.count),
      })),
      topProcedures: procResult.rows.map(r => ({
        code: r.code,
        description: r.description,
        count: parseInt(r.count),
        totalBilled: parseFloat(r.total_billed),
      })),
    };
  }

  private async generateExcel(
    summary: ClaimsSummary,
    outputPath: string,
    month: string
  ): Promise<void> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Meridian Report Generator';

    // Summary sheet
    const summarySheet = workbook.addWorksheet('Summary');
    summarySheet.columns = [
      { header: 'Metric', key: 'metric', width: 30 },
      { header: 'Value', key: 'value', width: 20 },
    ];

    summarySheet.addRow({ metric: 'Report Month', value: month });
    summarySheet.addRow({ metric: 'Total Claims', value: summary.totalClaims });
    summarySheet.addRow({ metric: 'Total Billed', value: summary.totalBilled });
    summarySheet.addRow({ metric: 'Total Paid', value: summary.totalPaid });
    summarySheet.addRow({ metric: 'Total Adjustments', value: summary.totalAdjustments });
    summarySheet.addRow({ metric: 'Avg Days to Process', value: Math.round(summary.avgDaysToProcess * 10) / 10 });
    summarySheet.addRow({ metric: 'Denial Rate', value: `${Math.round(summary.denialRate * 10) / 10}%` });

    // format currency cells
    // TODO: this formatting is fragile - if we add more rows above, the row numbers are wrong
    [3, 4, 5].forEach(row => {
      const cell = summarySheet.getCell(`B${row}`);
      cell.numFmt = '$#,##0.00';
    });

    // Payer breakdown sheet
    const payerSheet = workbook.addWorksheet('By Payer');
    payerSheet.columns = [
      { header: 'Payer', key: 'payer', width: 30 },
      { header: 'Claims', key: 'claims', width: 12 },
      { header: 'Billed', key: 'billed', width: 15 },
      { header: 'Paid', key: 'paid', width: 15 },
      { header: 'Denial Rate', key: 'denialRate', width: 15 },
    ];
    summary.byPayer.forEach(row => payerSheet.addRow(row));

    // Claim type breakdown
    const typeSheet = workbook.addWorksheet('By Type');
    typeSheet.columns = [
      { header: 'Claim Type', key: 'type', width: 20 },
      { header: 'Claims', key: 'claims', width: 12 },
      { header: 'Billed', key: 'billed', width: 15 },
      { header: 'Paid', key: 'paid', width: 15 },
    ];
    summary.byClaimType.forEach(row => typeSheet.addRow(row));

    // Top denial reasons
    const denialSheet = workbook.addWorksheet('Denial Reasons');
    denialSheet.columns = [
      { header: 'Code', key: 'code', width: 15 },
      { header: 'Description', key: 'description', width: 40 },
      { header: 'Count', key: 'count', width: 12 },
    ];
    summary.topDenialReasons.forEach(row => denialSheet.addRow(row));

    // Top procedures
    const procSheet = workbook.addWorksheet('Top Procedures');
    procSheet.columns = [
      { header: 'Code', key: 'code', width: 15 },
      { header: 'Description', key: 'description', width: 40 },
      { header: 'Count', key: 'count', width: 12 },
      { header: 'Total Billed', key: 'totalBilled', width: 15 },
    ];
    summary.topProcedures.forEach(row => procSheet.addRow(row));

    await workbook.xlsx.writeFile(outputPath);
  }

  private async generateCSV(summary: ClaimsSummary, outputPath: string): Promise<void> {
    // quick and dirty CSV export - just the payer breakdown for now
    // TODO: export all sheets as separate CSV files
    const { writeFileSync } = await import('fs');
    let csv = 'Payer,Claims,Billed,Paid,Denial Rate\n';
    for (const row of summary.byPayer) {
      csv += `"${row.payer}",${row.claims},${row.billed},${row.paid},${row.denialRate}\n`;
    }
    writeFileSync(outputPath, csv);
  }
}
