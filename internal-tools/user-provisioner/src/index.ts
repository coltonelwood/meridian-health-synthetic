#!/usr/bin/env ts-node

import { Command } from 'commander';
import chalk from 'chalk';
import { provisionCommand } from './commands/provision';
import { deprovisionCommand } from './commands/deprovision';

const program = new Command();

program
  .name('meridian-provisioner')
  .description('User account provisioning/deprovisioning for Meridian Health')
  .version('1.3.1');

program
  .command('provision')
  .description('Provision a new user account')
  .requiredOption('-e, --email <email>', 'User email address')
  .requiredOption('-n, --name <name>', 'Full name')
  .requiredOption('-r, --role <role>', 'Role: admin, provider, staff, support, engineering')
  .option('-d, --department <dept>', 'Department')
  .option('-t, --title <title>', 'Job title')
  .option('-m, --manager <email>', 'Manager email')
  .option('--skip-ldap', 'Skip LDAP account creation', false)
  .option('--skip-email', 'Skip welcome email', false)
  .option('--dry-run', 'Show what would be done without doing it', false)
  .action(provisionCommand);

program
  .command('deprovision')
  .description('Deprovision (deactivate) a user account')
  .requiredOption('-e, --email <email>', 'User email address')
  .option('--reason <reason>', 'Reason for deprovisioning')
  .option('--immediate', 'Skip the grace period and deactivate immediately', false)
  .option('--dry-run', 'Show what would be done without doing it', false)
  .action(deprovisionCommand);

// Convenience commands
program
  .command('lookup <email>')
  .description('Look up a user account status')
  .action(async (email: string) => {
    // quick and dirty lookup - just checks the DB
    const { Pool } = await import('pg');
    const pool = new Pool({
      host: process.env.DB_HOST || 'localhost',
      database: process.env.DB_NAME || 'meridian_health',
      user: process.env.DB_USER || 'provisioner',
      password: process.env.DB_PASSWORD,
    });

    try {
      const result = await pool.query(
        'SELECT id, email, name, role, department, status, created_at, deactivated_at FROM users WHERE email = $1',
        [email]
      );

      if (result.rows.length === 0) {
        console.log(chalk.yellow(`No user found with email: ${email}`));
        return;
      }

      const user = result.rows[0];
      console.log(chalk.bold('\nUser Account:'));
      console.log(`  ID:          ${user.id}`);
      console.log(`  Email:       ${user.email}`);
      console.log(`  Name:        ${user.name}`);
      console.log(`  Role:        ${user.role}`);
      console.log(`  Department:  ${user.department || 'N/A'}`);
      console.log(`  Status:      ${user.status === 'active' ? chalk.green(user.status) : chalk.red(user.status)}`);
      console.log(`  Created:     ${user.created_at}`);
      if (user.deactivated_at) {
        console.log(`  Deactivated: ${user.deactivated_at}`);
      }
    } catch (err: any) {
      console.error(chalk.red(`Lookup failed: ${err.message}`));
    } finally {
      await pool.end();
    }
  });

program.parse();
