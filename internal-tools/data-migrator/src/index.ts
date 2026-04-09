#!/usr/bin/env ts-node

import { Command } from 'commander';
import chalk from 'chalk';
import { Pool } from 'pg';
import { PatientMigrator } from './migrators/patientMigrator';
import { ClaimsMigrator } from './migrators/claimsMigrator';
import { ProviderMigrator } from './migrators/providerMigrator';

const program = new Command();

// DB connection - TODO: move to config file, not env vars
// we have a config service but this tool predates it
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'meridian_health',
  user: process.env.DB_USER || 'migrator',
  password: process.env.DB_PASSWORD,
  // WARNING: don't increase max connections without checking with DBA
  // we got yelled at last time for exhausting the connection pool during
  // a large migration
  max: 5,
  idleTimeoutMillis: 30000,
});

program
  .name('meridian-migrator')
  .description('Data migration tool for Meridian Health Technologies')
  .version('1.8.0');

program
  .command('patients')
  .description('Migrate patient records from legacy CSV export')
  .requiredOption('-f, --file <path>', 'Path to patient CSV file')
  .option('-b, --batch-size <size>', 'Batch size for inserts', '100')
  .option('-d, --dry-run', 'Validate data without inserting', false)
  .option('--skip-validation', 'Skip data validation (dangerous!)', false)
  .option('--source <system>', 'Source system identifier', 'legacy-ehr')
  .option('--resume-from <line>', 'Resume migration from line number')
  .action(async (options) => {
    console.log(chalk.blue('=== Patient Migration ==='));
    console.log(`File: ${options.file}`);
    console.log(`Batch size: ${options.batchSize}`);
    console.log(`Dry run: ${options.dryRun}`);

    if (options.skipValidation) {
      console.log(chalk.red('WARNING: Skipping validation. Data quality not guaranteed.'));
    }

    const migrator = new PatientMigrator(pool, {
      batchSize: parseInt(options.batchSize),
      dryRun: options.dryRun,
      skipValidation: options.skipValidation,
      source: options.source,
      resumeFrom: options.resumeFrom ? parseInt(options.resumeFrom) : undefined,
    });

    try {
      const result = await migrator.migrate(options.file);
      console.log(chalk.green(`\nMigration complete:`));
      console.log(`  Total rows: ${result.totalRows}`);
      console.log(`  Inserted:   ${result.inserted}`);
      console.log(`  Skipped:    ${result.skipped}`);
      console.log(`  Errors:     ${result.errors}`);

      if (result.errorDetails.length > 0) {
        console.log(chalk.yellow('\nError details:'));
        result.errorDetails.slice(0, 20).forEach(err => {
          console.log(`  Line ${err.line}: ${err.message}`);
        });
        if (result.errorDetails.length > 20) {
          console.log(`  ... and ${result.errorDetails.length - 20} more errors`);
          console.log(`  Full error log: ${result.errorLogPath}`);
        }
      }
    } catch (err) {
      console.error(chalk.red('Migration failed:'), err);
      process.exit(1);
    } finally {
      await pool.end();
    }
  });

program
  .command('claims')
  .description('Migrate historical claims data')
  .requiredOption('-f, --file <path>', 'Path to claims CSV/TSV file')
  .option('-b, --batch-size <size>', 'Batch size for inserts', '50')
  .option('-d, --dry-run', 'Validate data without inserting', false)
  .option('--format <fmt>', 'File format: csv, tsv, pipe', 'csv')
  .option('--source <system>', 'Source system identifier', 'legacy-billing')
  .action(async (options) => {
    console.log(chalk.blue('=== Claims Migration ==='));

    const migrator = new ClaimsMigrator(pool, {
      batchSize: parseInt(options.batchSize),
      dryRun: options.dryRun,
      format: options.format,
      source: options.source,
    });

    try {
      const result = await migrator.migrate(options.file);
      console.log(chalk.green(`\nMigration complete:`));
      console.log(`  Total rows: ${result.totalRows}`);
      console.log(`  Inserted:   ${result.inserted}`);
      console.log(`  Skipped:    ${result.skipped}`);
      console.log(`  Errors:     ${result.errors}`);
    } catch (err) {
      console.error(chalk.red('Migration failed:'), err);
      process.exit(1);
    } finally {
      await pool.end();
    }
  });

program
  .command('providers')
  .description('Migrate provider directory')
  .requiredOption('-f, --file <path>', 'Path to provider CSV file')
  .option('-d, --dry-run', 'Validate data without inserting', false)
  .action(async (options) => {
    console.log(chalk.blue('=== Provider Migration ==='));

    const migrator = new ProviderMigrator(pool, {
      dryRun: options.dryRun,
    });

    try {
      const result = await migrator.migrate(options.file);
      console.log(chalk.green(`\nMigration complete:`));
      console.log(`  Total: ${result.totalRows}`);
      console.log(`  Inserted: ${result.inserted}`);
      console.log(`  Updated: ${result.updated}`);
      console.log(`  Errors: ${result.errors}`);
    } catch (err) {
      console.error(chalk.red('Migration failed:'), err);
      process.exit(1);
    } finally {
      await pool.end();
    }
  });

program.parse();
