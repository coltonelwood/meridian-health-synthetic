#!/usr/bin/env ts-node

import { Command } from 'commander';
import chalk from 'chalk';
import { Pool } from 'pg';
import { ClaimsReport } from './reports/claimsReport';
import { PatientCensus } from './reports/patientCensus';
import { RevenueReport } from './reports/revenueReport';
import { ComplianceReport } from './reports/complianceReport';

const program = new Command();

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'meridian_health',
  user: process.env.DB_USER || 'reporter',
  password: process.env.DB_PASSWORD,
  // read-only connection for safety
  // (except we can't enforce this at the pg level, it's just convention)
  max: 3, // reports can be resource-intensive, limit connections
  statement_timeout: 300000, // 5 minute timeout for long queries
});

program
  .name('meridian-reporter')
  .description('Report generation tool for Meridian Health Technologies')
  .version('2.1.0');

program
  .command('claims')
  .description('Generate monthly claims summary report')
  .requiredOption('-m, --month <YYYY-MM>', 'Report month (e.g., 2024-12)')
  .option('-f, --format <fmt>', 'Output format: excel, pdf, csv', 'excel')
  .option('-o, --output <path>', 'Output file path')
  .option('--payer <name>', 'Filter by payer')
  .option('--provider-npi <npi>', 'Filter by provider NPI')
  .action(async (options) => {
    console.log(chalk.blue(`\nGenerating Claims Report for ${options.month}...`));
    const report = new ClaimsReport(pool);
    try {
      const outputPath = await report.generate({
        month: options.month,
        format: options.format,
        outputPath: options.output,
        payerFilter: options.payer,
        providerFilter: options.providerNpi,
      });
      console.log(chalk.green(`Report saved to: ${outputPath}`));
    } catch (err: any) {
      console.error(chalk.red(`Report generation failed: ${err.message}`));
      process.exit(1);
    } finally {
      await pool.end();
    }
  });

program
  .command('census')
  .description('Generate patient census report')
  .option('-d, --date <YYYY-MM-DD>', 'Census date (default: today)')
  .option('-f, --format <fmt>', 'Output format: excel, pdf, csv', 'excel')
  .option('-o, --output <path>', 'Output file path')
  .option('--by <dimension>', 'Group by: provider, insurance, location, all', 'all')
  .action(async (options) => {
    const date = options.date || new Date().toISOString().split('T')[0];
    console.log(chalk.blue(`\nGenerating Patient Census for ${date}...`));
    const report = new PatientCensus(pool);
    try {
      const outputPath = await report.generate({
        date,
        format: options.format,
        outputPath: options.output,
        groupBy: options.by,
      });
      console.log(chalk.green(`Report saved to: ${outputPath}`));
    } catch (err: any) {
      console.error(chalk.red(`Report generation failed: ${err.message}`));
      process.exit(1);
    } finally {
      await pool.end();
    }
  });

program
  .command('revenue')
  .description('Generate revenue analysis report')
  .requiredOption('-s, --start <YYYY-MM-DD>', 'Start date')
  .requiredOption('-e, --end <YYYY-MM-DD>', 'End date')
  .option('-f, --format <fmt>', 'Output format: excel, pdf', 'excel')
  .option('-o, --output <path>', 'Output file path')
  .action(async (options) => {
    console.log(chalk.blue(`\nGenerating Revenue Report (${options.start} to ${options.end})...`));
    const report = new RevenueReport(pool);
    try {
      const outputPath = await report.generate({
        startDate: options.start,
        endDate: options.end,
        format: options.format,
        outputPath: options.output,
      });
      console.log(chalk.green(`Report saved to: ${outputPath}`));
    } catch (err: any) {
      console.error(chalk.red(`Report generation failed: ${err.message}`));
      process.exit(1);
    } finally {
      await pool.end();
    }
  });

program
  .command('compliance')
  .description('Generate HIPAA compliance audit report')
  .requiredOption('-s, --start <YYYY-MM-DD>', 'Start date')
  .requiredOption('-e, --end <YYYY-MM-DD>', 'End date')
  .option('-o, --output <path>', 'Output file path')
  .action(async (options) => {
    console.log(chalk.blue(`\nGenerating Compliance Report (${options.start} to ${options.end})...`));
    const report = new ComplianceReport(pool);
    try {
      const outputPath = await report.generate({
        startDate: options.start,
        endDate: options.end,
        outputPath: options.output,
      });
      console.log(chalk.green(`Report saved to: ${outputPath}`));
    } catch (err: any) {
      console.error(chalk.red(`Report generation failed: ${err.message}`));
      process.exit(1);
    } finally {
      await pool.end();
    }
  });

program.parse();
