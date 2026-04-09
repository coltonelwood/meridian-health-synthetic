import chalk from 'chalk';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { LDAPService } from '../services/ldapService';

interface DeprovisionOptions {
  email: string;
  reason?: string;
  immediate: boolean;
  dryRun: boolean;
}

/**
 * Deprovision (deactivate) a user account.
 *
 * This is a multi-step process that removes access from all systems.
 * Some steps are automated, others require manual intervention (noted below).
 *
 * IMPORTANT: This does NOT delete data. It deactivates the account and
 * revokes access. Data retention is handled by a separate process per
 * our data retention policy (7 years for HIPAA).
 *
 * Deprovisioning checklist:
 * [AUTO] Deactivate database account
 * [AUTO] Revoke API tokens
 * [AUTO] Disable LDAP account
 * [AUTO] Remove from LDAP groups
 * [AUTO] Invalidate active sessions
 * [MANUAL] Remove from Slack (API doesn't support deactivation on free plan)
 * [MANUAL] Remove from PagerDuty
 * [MANUAL] Revoke AWS IAM access
 * [MANUAL] Remove from 1Password vaults
 * [MANUAL] Remove from GitHub org (need org admin)
 * [MANUAL] Transfer ownership of shared resources
 * [MANUAL] Redirect email (if applicable)
 * [MANUAL] Collect hardware/badge
 */
export async function deprovisionCommand(options: DeprovisionOptions): Promise<void> {
  console.log(chalk.red('\n=== User Deprovisioning ==='));
  console.log(`Email:  ${options.email}`);
  console.log(`Reason: ${options.reason || 'Not specified'}`);
  if (options.dryRun) {
    console.log(chalk.yellow('DRY RUN - no changes will be made\n'));
  }

  const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'meridian_health',
    user: process.env.DB_USER || 'provisioner',
    password: process.env.DB_PASSWORD,
  });

  const ldap = new LDAPService();

  try {
    // Step 1: Verify user exists
    console.log(chalk.gray('\n[1/7] Looking up user...'));
    const userResult = await pool.query(
      'SELECT id, name, role, status FROM users WHERE email = $1',
      [options.email]
    );

    if (userResult.rows.length === 0) {
      console.error(chalk.red(`No user found with email: ${options.email}`));
      process.exit(1);
    }

    const user = userResult.rows[0];
    console.log(`  Found: ${user.name} (${user.role})`);

    if (user.status !== 'active') {
      console.log(chalk.yellow(`  User is already ${user.status}`));
      // continue anyway to clean up any remaining access
    }

    // Safety check for admin accounts
    if (user.role === 'admin' && !options.immediate) {
      const adminCount = await pool.query(
        "SELECT COUNT(*) FROM users WHERE role = 'admin' AND status = 'active'"
      );
      if (parseInt(adminCount.rows[0].count) <= 1) {
        console.error(chalk.red('Cannot deactivate the last admin account!'));
        console.error(chalk.red('Provision a new admin first.'));
        process.exit(1);
      }
    }

    // Step 2: Deactivate database account
    console.log(chalk.gray('[2/7] Deactivating database account...'));
    if (!options.dryRun) {
      await pool.query(
        `UPDATE users SET
          status = 'deactivated',
          deactivated_at = NOW(),
          deactivation_reason = $2,
          password_hash = NULL
        WHERE id = $1`,
        [user.id, options.reason || 'No reason provided']
      );
      console.log(chalk.green('  Account deactivated'));
    }

    // Step 3: Revoke API tokens
    console.log(chalk.gray('[3/7] Revoking API tokens...'));
    if (!options.dryRun) {
      const tokenResult = await pool.query(
        `UPDATE api_tokens SET
          revoked = true,
          revoked_at = NOW(),
          revoked_reason = 'user_deprovisioned'
        WHERE user_id = $1 AND revoked = false
        RETURNING id`,
        [user.id]
      );
      console.log(chalk.green(`  Revoked ${tokenResult.rows.length} tokens`));
    }

    // Step 4: Invalidate sessions
    console.log(chalk.gray('[4/7] Invalidating active sessions...'));
    if (!options.dryRun) {
      const sessionResult = await pool.query(
        `DELETE FROM user_sessions WHERE user_id = $1 RETURNING id`,
        [user.id]
      );
      console.log(chalk.green(`  Invalidated ${sessionResult.rows.length} sessions`));
    }

    // Step 5: Remove permissions
    console.log(chalk.gray('[5/7] Removing permissions...'));
    if (!options.dryRun) {
      const permResult = await pool.query(
        `UPDATE user_permissions SET
          revoked = true,
          revoked_at = NOW()
        WHERE user_id = $1 AND revoked = false
        RETURNING permission`,
        [user.id]
      );
      console.log(chalk.green(`  Revoked ${permResult.rows.length} permissions`));
    }

    // Step 6: Disable LDAP account
    console.log(chalk.gray('[6/7] Disabling LDAP account...'));
    if (!options.dryRun) {
      try {
        await ldap.connect();
        const uid = options.email.split('@')[0];

        // disable the account
        await ldap.disableUser(uid);

        // remove from all groups
        await ldap.removeFromAllGroups(uid);

        console.log(chalk.green('  LDAP account disabled and removed from all groups'));
      } catch (err: any) {
        console.error(chalk.yellow(`  LDAP failed: ${err.message}`));
        console.error(chalk.yellow('  You MUST manually disable the LDAP account!'));
        // this is more serious than provision failure - leaving an active LDAP
        // account for a deprovisioned user is a security risk
      } finally {
        await ldap.disconnect();
      }
    }

    // Step 7: Audit log
    console.log(chalk.gray('[7/7] Writing audit log...'));
    if (!options.dryRun) {
      await pool.query(
        `INSERT INTO audit_log (id, action, resource, resource_id, performed_by, details, created_at)
         VALUES ($1, 'user_deprovisioned', 'user', $2, $3, $4, NOW())`,
        [
          uuidv4(),
          user.id,
          process.env.USER || 'unknown',
          JSON.stringify({
            email: options.email,
            reason: options.reason,
            immediate: options.immediate,
          }),
        ]
      );
    }

    console.log(chalk.green('\n=== Automated Deprovisioning Complete ==='));

    // manual steps - these are critical and must not be forgotten
    console.log(chalk.red('\n--- MANUAL STEPS REQUIRED ---'));
    console.log(chalk.red('You must complete the following manually:\n'));
    console.log('  [ ] Remove from Slack workspace');
    console.log('      (Slack Admin > Manage Members > Deactivate)');
    console.log('  [ ] Remove from PagerDuty');
    console.log('      (PagerDuty > People > Users > Delete)');
    if (user.role === 'engineering') {
      console.log('  [ ] Remove from GitHub organization');
      console.log('      (GitHub > Organization > People > Remove)');
      console.log('  [ ] Revoke AWS IAM access');
      console.log('      (AWS Console > IAM > Users > Delete)');
      console.log('  [ ] Remove from DataDog');
      console.log('  [ ] Rotate any shared credentials this user had access to');
    }
    console.log('  [ ] Remove from 1Password shared vaults');
    console.log('  [ ] Collect hardware and badge');
    console.log('  [ ] Set up email redirect (if needed)');
    console.log('  [ ] Notify manager: ' + (user.name ? user.name : options.email));

    // TODO: create a Jira ticket with the manual checklist automatically
    // tried to implement this but the Jira API integration broke after
    // they updated their auth. Will circle back.

    // TODO: also send a notification to the security team Slack channel
    // about the deprovisioning

  } catch (err: any) {
    console.error(chalk.red(`\nDeprovisioning failed: ${err.message}`));
    console.error(chalk.red('CRITICAL: Partial deprovisioning may have occurred.'));
    console.error(chalk.red('Check each system manually to ensure access is revoked.'));
    process.exit(1);
  } finally {
    await pool.end();
  }
}
