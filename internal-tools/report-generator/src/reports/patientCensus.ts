import { Pool } from 'pg';
import ExcelJS from 'exceljs';
import { join } from 'path';

interface CensusOptions {
  date: string;
  format: string;
  outputPath?: string;
  groupBy: 'provider' | 'insurance' | 'location' | 'all';
}

interface CensusData {
  totalActive: number;
  totalInactive: number;
  totalDeceased: number;
  newThisMonth: number;
  byProvider: { provider: string; npi: string; patients: number }[];
  byInsurance: { insurer: string; patients: number; percentage: number }[];
  byState: { state: string; patients: number }[];
  byAgeGroup: { ageGroup: string; count: number; percentage: number }[];
  byGender: { gender: string; count: number; percentage: number }[];
}

export class PatientCensus {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async generate(options: CensusOptions): Promise<string> {
    const data = await this.fetchCensusData(options.date);

    const outputPath = options.outputPath ||
      join(process.cwd(), `patient-census-${options.date}.xlsx`);

    await this.generateExcel(data, outputPath, options.date);
    return outputPath;
  }

  private async fetchCensusData(asOfDate: string): Promise<CensusData> {
    // Total counts by status
    const statusResult = await this.pool.query(`
      SELECT status, COUNT(*) as count
      FROM patients
      WHERE created_at <= $1
      GROUP BY status
    `, [asOfDate]);

    const statusCounts: Record<string, number> = {};
    for (const row of statusResult.rows) {
      statusCounts[row.status] = parseInt(row.count);
    }

    // New patients this month
    const newPatientsResult = await this.pool.query(`
      SELECT COUNT(*) as count
      FROM patients
      WHERE created_at >= DATE_TRUNC('month', $1::date)
        AND created_at <= $1
    `, [asOfDate]);

    // By provider
    const providerResult = await this.pool.query(`
      SELECT
        COALESCE(pr.last_name || ', ' || pr.first_name, 'Unassigned') as provider,
        COALESCE(p.primary_provider_npi, 'N/A') as npi,
        COUNT(*) as patients
      FROM patients p
      LEFT JOIN providers pr ON pr.npi = p.primary_provider_npi
      WHERE p.status = 'active' AND p.created_at <= $1
      GROUP BY pr.last_name, pr.first_name, p.primary_provider_npi
      ORDER BY patients DESC
    `, [asOfDate]);

    // By insurance
    const insuranceResult = await this.pool.query(`
      SELECT
        COALESCE(insurer_name, 'Self-Pay / Unknown') as insurer,
        COUNT(*) as patients
      FROM patients
      WHERE status = 'active' AND created_at <= $1
      GROUP BY insurer_name
      ORDER BY patients DESC
    `, [asOfDate]);

    const totalActive = statusCounts['active'] || 0;
    const insuranceData = insuranceResult.rows.map(r => ({
      insurer: r.insurer,
      patients: parseInt(r.patients),
      percentage: totalActive > 0 ? (parseInt(r.patients) / totalActive) * 100 : 0,
    }));

    // By state
    const stateResult = await this.pool.query(`
      SELECT
        COALESCE(state, 'Unknown') as state,
        COUNT(*) as patients
      FROM patients
      WHERE status = 'active' AND created_at <= $1
      GROUP BY state
      ORDER BY patients DESC
    `, [asOfDate]);

    // By age group
    const ageResult = await this.pool.query(`
      SELECT
        CASE
          WHEN date_of_birth IS NULL THEN 'Unknown'
          WHEN AGE($1::date, date_of_birth) < INTERVAL '18 years' THEN '0-17 (Pediatric)'
          WHEN AGE($1::date, date_of_birth) < INTERVAL '30 years' THEN '18-29'
          WHEN AGE($1::date, date_of_birth) < INTERVAL '40 years' THEN '30-39'
          WHEN AGE($1::date, date_of_birth) < INTERVAL '50 years' THEN '40-49'
          WHEN AGE($1::date, date_of_birth) < INTERVAL '65 years' THEN '50-64'
          ELSE '65+ (Medicare eligible)'
        END as age_group,
        COUNT(*) as count
      FROM patients
      WHERE status = 'active' AND created_at <= $1
      GROUP BY age_group
      ORDER BY
        CASE age_group
          WHEN '0-17 (Pediatric)' THEN 1
          WHEN '18-29' THEN 2
          WHEN '30-39' THEN 3
          WHEN '40-49' THEN 4
          WHEN '50-64' THEN 5
          WHEN '65+ (Medicare eligible)' THEN 6
          ELSE 7
        END
    `, [asOfDate]);

    // By gender
    const genderResult = await this.pool.query(`
      SELECT
        COALESCE(gender, 'unknown') as gender,
        COUNT(*) as count
      FROM patients
      WHERE status = 'active' AND created_at <= $1
      GROUP BY gender
      ORDER BY count DESC
    `, [asOfDate]);

    return {
      totalActive,
      totalInactive: statusCounts['inactive'] || 0,
      totalDeceased: statusCounts['deceased'] || 0,
      newThisMonth: parseInt(newPatientsResult.rows[0]?.count || '0'),
      byProvider: providerResult.rows.map(r => ({
        provider: r.provider,
        npi: r.npi,
        patients: parseInt(r.patients),
      })),
      byInsurance: insuranceData,
      byState: stateResult.rows.map(r => ({
        state: r.state,
        patients: parseInt(r.patients),
      })),
      byAgeGroup: ageResult.rows.map(r => ({
        ageGroup: r.age_group,
        count: parseInt(r.count),
        percentage: totalActive > 0 ? (parseInt(r.count) / totalActive) * 100 : 0,
      })),
      byGender: genderResult.rows.map(r => ({
        gender: r.gender,
        count: parseInt(r.count),
        percentage: totalActive > 0 ? (parseInt(r.count) / totalActive) * 100 : 0,
      })),
    };
  }

  private async generateExcel(data: CensusData, outputPath: string, asOfDate: string): Promise<void> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Meridian Report Generator';

    // Summary sheet
    const summary = workbook.addWorksheet('Census Summary');
    summary.columns = [
      { header: 'Metric', key: 'metric', width: 30 },
      { header: 'Value', key: 'value', width: 15 },
    ];
    summary.addRow({ metric: 'Census Date', value: asOfDate });
    summary.addRow({ metric: 'Total Active Patients', value: data.totalActive });
    summary.addRow({ metric: 'Total Inactive', value: data.totalInactive });
    summary.addRow({ metric: 'Total Deceased', value: data.totalDeceased });
    summary.addRow({ metric: 'New This Month', value: data.newThisMonth });

    // Provider panel
    const providers = workbook.addWorksheet('By Provider');
    providers.columns = [
      { header: 'Provider', key: 'provider', width: 30 },
      { header: 'NPI', key: 'npi', width: 15 },
      { header: 'Active Patients', key: 'patients', width: 15 },
    ];
    data.byProvider.forEach(r => providers.addRow(r));

    // Insurance panel
    const insurance = workbook.addWorksheet('By Insurance');
    insurance.columns = [
      { header: 'Insurance', key: 'insurer', width: 35 },
      { header: 'Patients', key: 'patients', width: 15 },
      { header: '% of Total', key: 'percentage', width: 12 },
    ];
    data.byInsurance.forEach(r => insurance.addRow({
      ...r,
      percentage: Math.round(r.percentage * 10) / 10,
    }));

    // Demographics
    const demographics = workbook.addWorksheet('Demographics');
    demographics.addRow(['Age Distribution']);
    demographics.addRow(['Age Group', 'Count', '% of Total']);
    data.byAgeGroup.forEach(r => demographics.addRow([
      r.ageGroup, r.count, `${Math.round(r.percentage * 10) / 10}%`,
    ]));
    demographics.addRow([]); // spacer
    demographics.addRow(['Gender Distribution']);
    demographics.addRow(['Gender', 'Count', '% of Total']);
    data.byGender.forEach(r => demographics.addRow([
      r.gender, r.count, `${Math.round(r.percentage * 10) / 10}%`,
    ]));

    // Geographic
    const geo = workbook.addWorksheet('By State');
    geo.columns = [
      { header: 'State', key: 'state', width: 20 },
      { header: 'Patients', key: 'patients', width: 15 },
    ];
    data.byState.forEach(r => geo.addRow(r));

    await workbook.xlsx.writeFile(outputPath);
  }
}
