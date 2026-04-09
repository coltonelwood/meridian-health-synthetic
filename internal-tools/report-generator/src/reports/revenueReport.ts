import { Pool } from 'pg';
import ExcelJS from 'exceljs';
import { join } from 'path';

interface RevenueOptions {
  startDate: string;
  endDate: string;
  format: string;
  outputPath?: string;
}

/**
 * Revenue analysis report.
 *
 * Uses raw SQL because the ORM (if we had one) can't handle the complexity
 * of these aggregation queries. Yes, this is a lot of raw SQL. Deal with it.
 *
 * KNOWN ISSUE: Rounding errors with certain payer adjustments.
 * When a payer applies a percentage-based adjustment (e.g., 15% network discount),
 * the stored adjustment_amount sometimes differs from billed_amount * 0.15 by $0.01
 * due to the old billing system rounding before storage vs. us rounding after retrieval.
 * This causes the revenue totals to be off by small amounts ($1-5 per month typically).
 *
 * We've accepted this discrepancy because:
 * 1. The amounts match the source system exactly
 * 2. The difference is within acceptable audit tolerance
 * 3. "Fixing" it would mean our numbers don't match the old system's reports
 *
 * Finance team is aware. They adjust manually in their GL entries.
 * Reference: MHT-2834
 */
export class RevenueReport {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async generate(options: RevenueOptions): Promise<string> {
    const outputPath = options.outputPath ||
      join(process.cwd(), `revenue-${options.startDate}-to-${options.endDate}.xlsx`);

    // Monthly breakdown
    const monthlyData = await this.fetchMonthlyRevenue(options.startDate, options.endDate);

    // Payer mix
    const payerData = await this.fetchPayerMix(options.startDate, options.endDate);

    // Collection rates
    const collectionData = await this.fetchCollectionRates(options.startDate, options.endDate);

    // AR aging
    const arAging = await this.fetchARaging(options.endDate);

    // Service line revenue
    const serviceLineData = await this.fetchServiceLineRevenue(options.startDate, options.endDate);

    await this.generateExcel({
      monthly: monthlyData,
      payers: payerData,
      collections: collectionData,
      arAging,
      serviceLines: serviceLineData,
    }, outputPath, options);

    return outputPath;
  }

  private async fetchMonthlyRevenue(startDate: string, endDate: string) {
    const result = await this.pool.query(`
      SELECT
        TO_CHAR(service_date, 'YYYY-MM') as month,
        COUNT(*) as total_claims,
        SUM(billed_amount) as gross_charges,
        SUM(CASE WHEN adjustment_amount > 0 THEN adjustment_amount ELSE 0 END) as contractual_adjustments,
        SUM(paid_amount) as net_revenue,
        -- "net collection rate" = paid / (billed - adjustments)
        -- this is what finance cares about most
        CASE
          WHEN SUM(billed_amount) - SUM(COALESCE(adjustment_amount, 0)) > 0
          THEN SUM(COALESCE(paid_amount, 0)) / (SUM(billed_amount) - SUM(COALESCE(adjustment_amount, 0))) * 100
          ELSE 0
        END as net_collection_rate,
        SUM(billed_amount) - SUM(COALESCE(paid_amount, 0)) - SUM(COALESCE(adjustment_amount, 0)) as outstanding_ar
      FROM claims
      WHERE service_date >= $1 AND service_date <= $2
        AND status != 'void'
      GROUP BY TO_CHAR(service_date, 'YYYY-MM')
      ORDER BY month
    `, [startDate, endDate]);

    return result.rows.map(r => ({
      month: r.month,
      totalClaims: parseInt(r.total_claims),
      grossCharges: parseFloat(r.gross_charges) || 0,
      contractualAdjustments: parseFloat(r.contractual_adjustments) || 0,
      netRevenue: parseFloat(r.net_revenue) || 0,
      netCollectionRate: parseFloat(r.net_collection_rate) || 0,
      outstandingAR: parseFloat(r.outstanding_ar) || 0,
    }));
  }

  private async fetchPayerMix(startDate: string, endDate: string) {
    const result = await this.pool.query(`
      SELECT
        COALESCE(payer_name, 'Self-Pay') as payer,
        COUNT(*) as claims,
        SUM(billed_amount) as billed,
        SUM(paid_amount) as paid,
        SUM(adjustment_amount) as adjustments,
        AVG(
          CASE WHEN billed_amount > 0
            THEN paid_amount / billed_amount * 100
            ELSE 0
          END
        ) as avg_reimbursement_rate,
        AVG(EXTRACT(EPOCH FROM (
          COALESCE(processed_at, NOW()) - submitted_date
        )) / 86400) as avg_days_to_pay
      FROM claims
      WHERE service_date >= $1 AND service_date <= $2
        AND status NOT IN ('void', 'rejected')
      GROUP BY payer_name
      ORDER BY billed DESC
    `, [startDate, endDate]);

    const totalBilled = result.rows.reduce((sum: number, r: any) => sum + parseFloat(r.billed || 0), 0);

    return result.rows.map(r => ({
      payer: r.payer,
      claims: parseInt(r.claims),
      billed: parseFloat(r.billed) || 0,
      paid: parseFloat(r.paid) || 0,
      adjustments: parseFloat(r.adjustments) || 0,
      reimbursementRate: parseFloat(r.avg_reimbursement_rate) || 0,
      avgDaysToPay: Math.round(parseFloat(r.avg_days_to_pay) || 0),
      percentOfTotal: totalBilled > 0 ? (parseFloat(r.billed) / totalBilled) * 100 : 0,
    }));
  }

  private async fetchCollectionRates(startDate: string, endDate: string) {
    // Collection rates by month - how much of what we billed did we actually collect?
    const result = await this.pool.query(`
      SELECT
        TO_CHAR(submitted_date, 'YYYY-MM') as month,
        SUM(billed_amount) as total_billed,
        SUM(CASE WHEN status = 'paid' THEN paid_amount ELSE 0 END) as collected,
        SUM(CASE WHEN status = 'denied' THEN billed_amount ELSE 0 END) as denied_amount,
        COUNT(*) FILTER (WHERE status = 'paid') as paid_count,
        COUNT(*) FILTER (WHERE status = 'denied') as denied_count,
        COUNT(*) as total_count
      FROM claims
      WHERE submitted_date >= $1 AND submitted_date <= $2
      GROUP BY TO_CHAR(submitted_date, 'YYYY-MM')
      ORDER BY month
    `, [startDate, endDate]);

    return result.rows.map(r => ({
      month: r.month,
      totalBilled: parseFloat(r.total_billed) || 0,
      collected: parseFloat(r.collected) || 0,
      deniedAmount: parseFloat(r.denied_amount) || 0,
      collectionRate: (parseFloat(r.total_billed) || 0) > 0
        ? ((parseFloat(r.collected) || 0) / parseFloat(r.total_billed)) * 100 : 0,
      // "clean claim rate" = claims paid on first submission / total
      // TODO: we don't track "first submission" vs resubmission so this is wrong
      // it just shows paid/total which isn't the same thing
      cleanClaimRate: parseInt(r.total_count) > 0
        ? (parseInt(r.paid_count) / parseInt(r.total_count)) * 100 : 0,
    }));
  }

  private async fetchARaging(asOfDate: string) {
    // Accounts Receivable aging buckets
    // Standard aging: current, 30, 60, 90, 120+ days
    const result = await this.pool.query(`
      SELECT
        CASE
          WHEN ($1::date - service_date) <= 30 THEN '0-30 days'
          WHEN ($1::date - service_date) <= 60 THEN '31-60 days'
          WHEN ($1::date - service_date) <= 90 THEN '61-90 days'
          WHEN ($1::date - service_date) <= 120 THEN '91-120 days'
          ELSE '120+ days'
        END as aging_bucket,
        COUNT(*) as claims,
        SUM(billed_amount - COALESCE(paid_amount, 0) - COALESCE(adjustment_amount, 0)) as outstanding
      FROM claims
      WHERE status IN ('submitted', 'on_hold', 'approved')
        AND service_date <= $1
      GROUP BY aging_bucket
      ORDER BY
        CASE aging_bucket
          WHEN '0-30 days' THEN 1
          WHEN '31-60 days' THEN 2
          WHEN '61-90 days' THEN 3
          WHEN '91-120 days' THEN 4
          WHEN '120+ days' THEN 5
        END
    `, [asOfDate]);

    return result.rows.map(r => ({
      bucket: r.aging_bucket,
      claims: parseInt(r.claims),
      outstanding: parseFloat(r.outstanding) || 0,
    }));
  }

  private async fetchServiceLineRevenue(startDate: string, endDate: string) {
    // Revenue by service line (based on place of service and claim type)
    const result = await this.pool.query(`
      SELECT
        CASE
          WHEN place_of_service = '11' THEN 'Office'
          WHEN place_of_service = '21' THEN 'Inpatient Hospital'
          WHEN place_of_service = '22' THEN 'Outpatient Hospital'
          WHEN place_of_service = '23' THEN 'Emergency Room'
          WHEN place_of_service = '31' THEN 'Skilled Nursing'
          WHEN place_of_service = '02' THEN 'Telehealth'
          WHEN claim_type = 'pharmacy' THEN 'Pharmacy'
          ELSE 'Other'
        END as service_line,
        COUNT(*) as claims,
        SUM(billed_amount) as billed,
        SUM(paid_amount) as paid
      FROM claims
      WHERE service_date >= $1 AND service_date <= $2
        AND status != 'void'
      GROUP BY service_line
      ORDER BY billed DESC
    `, [startDate, endDate]);

    return result.rows.map(r => ({
      serviceLine: r.service_line,
      claims: parseInt(r.claims),
      billed: parseFloat(r.billed) || 0,
      paid: parseFloat(r.paid) || 0,
    }));
  }

  private async generateExcel(
    data: any,
    outputPath: string,
    options: RevenueOptions
  ): Promise<void> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Meridian Report Generator';

    // Monthly Revenue
    const monthly = workbook.addWorksheet('Monthly Revenue');
    monthly.columns = [
      { header: 'Month', key: 'month', width: 12 },
      { header: 'Total Claims', key: 'totalClaims', width: 14 },
      { header: 'Gross Charges', key: 'grossCharges', width: 16 },
      { header: 'Adjustments', key: 'contractualAdjustments', width: 16 },
      { header: 'Net Revenue', key: 'netRevenue', width: 16 },
      { header: 'Collection Rate', key: 'netCollectionRate', width: 16 },
      { header: 'Outstanding AR', key: 'outstandingAR', width: 16 },
    ];
    data.monthly.forEach((r: any) => monthly.addRow(r));

    // Payer Mix
    const payers = workbook.addWorksheet('Payer Mix');
    payers.columns = [
      { header: 'Payer', key: 'payer', width: 30 },
      { header: 'Claims', key: 'claims', width: 12 },
      { header: 'Billed', key: 'billed', width: 16 },
      { header: 'Paid', key: 'paid', width: 16 },
      { header: 'Reimb Rate', key: 'reimbursementRate', width: 14 },
      { header: 'Avg Days to Pay', key: 'avgDaysToPay', width: 16 },
      { header: '% of Total', key: 'percentOfTotal', width: 12 },
    ];
    data.payers.forEach((r: any) => payers.addRow(r));

    // AR Aging
    const aging = workbook.addWorksheet('AR Aging');
    aging.columns = [
      { header: 'Aging Bucket', key: 'bucket', width: 15 },
      { header: 'Claims', key: 'claims', width: 12 },
      { header: 'Outstanding', key: 'outstanding', width: 16 },
    ];
    data.arAging.forEach((r: any) => aging.addRow(r));
    // add total row
    aging.addRow({
      bucket: 'TOTAL',
      claims: data.arAging.reduce((s: number, r: any) => s + r.claims, 0),
      outstanding: data.arAging.reduce((s: number, r: any) => s + r.outstanding, 0),
    });

    // Service Lines
    const services = workbook.addWorksheet('Service Lines');
    services.columns = [
      { header: 'Service Line', key: 'serviceLine', width: 25 },
      { header: 'Claims', key: 'claims', width: 12 },
      { header: 'Billed', key: 'billed', width: 16 },
      { header: 'Paid', key: 'paid', width: 16 },
    ];
    data.serviceLines.forEach((r: any) => services.addRow(r));

    // Collection Rates
    const collections = workbook.addWorksheet('Collection Rates');
    collections.columns = [
      { header: 'Month', key: 'month', width: 12 },
      { header: 'Total Billed', key: 'totalBilled', width: 16 },
      { header: 'Collected', key: 'collected', width: 16 },
      { header: 'Denied', key: 'deniedAmount', width: 16 },
      { header: 'Collection Rate', key: 'collectionRate', width: 16 },
      { header: 'Clean Claim Rate', key: 'cleanClaimRate', width: 16 },
    ];
    data.collections.forEach((r: any) => collections.addRow(r));

    await workbook.xlsx.writeFile(outputPath);
  }
}
