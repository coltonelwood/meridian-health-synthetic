import chalk from 'chalk';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { LDAPService } from '../services/ldapService';
import * as nodemailer from 'nodemailer';

interface ProvisionOptions {
  email: string;
  name: string;
  role: string;
  department?: string;
  title?: string;
  manager?: string;
  skipLdap: boolean;
  skipEmail: boolean;
  dryRun: boolean;
}

// Role -> permissions mapping
// TODO: this should come from a database table, not be hardcoded here
const ROLE_PERMISSIONS: Record<string, string[]> = {
  admin: [
    'patients:read', 'patients:write', 'patients:delete',
    'claims:read', 'claims:write', 'claims:approve',
    'reports:read', 'reports:generate',
    'users:read', 'users:write', 'users:manage',
    'system:config', 'system:audit',
  ],
  provider: [
    'patients:read', 'patients:write',
    'claims:read', 'claims:write',
    'reports:read',
    'schedule:read', 'schedule:write',
  ],
  staff: [
    'patients:read', 'patients:write',
    'claims:read',
    'reports:read',
    'schedule:read',
  ],
  support: [
    'patients:read',
    'claims:read', 'claims:write',
    'reports:read',
  ],
  engineering: [
    'system:config', 'system:audit', 'system:debug',
    'reports:read', 'reports:generate',
    // engineers can't access patient data by default
    // they need a separate PHI access grant which goes through compliance
  ],
};

// LDAP groups for each role
const ROLE_LDAP_GROUPS: Record<string, string[]> = {
  admin: ['cn=admins,ou=groups,dc=meridian,dc=health', 'cn=all-staff,ou=groups,dc=meridian,dc=health'],
  provider: ['cn=providers,ou=groups,dc=meridian,dc=health', 'cn=clinical,ou=groups,dc=meridian,dc=health'],
  staff: ['cn=staff,ou=groups,dc=meridian,dc=health', 'cn=all-staff,ou=groups,dc=meridian,dc=health'],
  support: ['cn=support,ou=groups,dc=meridian,dc=health', 'cn=all-staff,ou=groups,dc=meridian,dc=health'],
  engineering: ['cn=engineering,ou=groups,dc=meridian,dc=health', 'cn=all-staff,ou=groups,dc=meridian,dc=health'],
};

export async function provisionCommand(options: ProvisionOptions): Promise<void> {
  console.log(chalk.blue('\n=== User Provisioning ==='));
  console.log(`Email: ${options.email}`);
  console.log(`Name:  ${options.name}`);
  console.log(`Role:  ${options.role}`);
  if (options.dryRun) {
    console.log(chalk.yellow('DRY RUN - no changes will be made\n'));
  }

  // validate role
  if (!ROLE_PERMISSIONS[options.role]) {
    console.error(chalk.red(`Invalid role: ${options.role}`));
    console.error(`Valid roles: ${Object.keys(ROLE_PERMISSIONS).join(', ')}`);
    process.exit(1);
  }

  // validate email format
  if (!options.email.endsWith('@meridianhealth.io') && !options.email.endsWith('@meridianhealth.com')) {
    console.error(chalk.red('Email must be a @meridianhealth.io or @meridianhealth.com address'));
    process.exit(1);
  }

  const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'meridian_health',
    user: process.env.DB_USER || 'provisioner',
    password: process.env.DB_PASSWORD,
  });

  const ldap = new LDAPService();

  try {
    // Step 1: Check if user already exists
    console.log(chalk.gray('\n[1/5] Checking for existing account...'));
    const existing = await pool.query(
      'SELECT id, status FROM users WHERE email = $1',
      [options.email]
    );

    if (existing.rows.length > 0) {
      const user = existing.rows[0];
      if (user.status === 'active') {
        console.error(chalk.red(`User ${options.email} already exists and is active`));
        process.exit(1);
      }
      // if they were deactivated, we could re-activate them
      // TODO: prompt "User was previously deactivated. Re-activate? [y/n]"
      console.log(chalk.yellow(`Note: User was previously deactivated (ID: ${user.id})`));
    }

    // Step 2: Create database record
    console.log(chalk.gray('[2/5] Creating database record...'));
    const userId = uuidv4();
    const tempPassword = generateTempPassword();

    if (!options.dryRun) {
      await pool.query(
        `INSERT INTO users (
          id, email, name, role, department, title, manager_email,
          status, password_hash, must_change_password, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', crypt($8, gen_salt('bf')), true, NOW())`,
        [
          userId, options.email, options.name, options.role,
          options.department || null, options.title || null,
          options.manager || null, tempPassword,
        ]
      );

      // set permissions
      const permissions = ROLE_PERMISSIONS[options.role];
      for (const perm of permissions) {
        await pool.query(
          'INSERT INTO user_permissions (user_id, permission, granted_at) VALUES ($1, $2, NOW())',
          [userId, perm]
        );
      }
    }
    console.log(chalk.green(`  Created user: ${userId}`));
    console.log(chalk.green(`  Permissions: ${ROLE_PERMISSIONS[options.role].length} granted`));

    // Step 3: Create LDAP account
    if (!options.skipLdap) {
      console.log(chalk.gray('[3/5] Creating LDAP account...'));
      if (!options.dryRun) {
        try {
          await ldap.connect();
          await ldap.createUser({
            uid: options.email.split('@')[0],
            cn: options.name,
            mail: options.email,
            userPassword: tempPassword,
          });

          // add to groups
          const groups = ROLE_LDAP_GROUPS[options.role] || [];
          for (const group of groups) {
            await ldap.addToGroup(group, options.email.split('@')[0]);
          }
          console.log(chalk.green(`  LDAP account created, added to ${groups.length} groups`));
        } catch (err: any) {
          // LDAP failure is non-fatal - we can retry later
          console.error(chalk.yellow(`  LDAP failed: ${err.message}`));
          console.error(chalk.yellow('  You may need to create the LDAP account manually'));
          // TODO: queue for retry instead of just warning
        } finally {
          await ldap.disconnect();
        }
      } else {
        console.log(chalk.gray('  Would create LDAP account'));
      }
    } else {
      console.log(chalk.gray('[3/5] Skipping LDAP (--skip-ldap)'));
    }

    // Step 4: Send welcome email
    if (!options.skipEmail) {
      console.log(chalk.gray('[4/5] Sending welcome email...'));
      if (!options.dryRun) {
        try {
          await sendWelcomeEmail(options.email, options.name, tempPassword, options.role);
          console.log(chalk.green('  Welcome email sent'));
        } catch (err: any) {
          console.error(chalk.yellow(`  Email failed: ${err.message}`));
          console.error(chalk.yellow('  You will need to manually share credentials'));
        }
      } else {
        console.log(chalk.gray('  Would send welcome email'));
      }
    } else {
      console.log(chalk.gray('[4/5] Skipping email (--skip-email)'));
    }

    // Step 5: Audit log
    console.log(chalk.gray('[5/5] Writing audit log...'));
    if (!options.dryRun) {
      await pool.query(
        `INSERT INTO audit_log (id, action, resource, resource_id, performed_by, details, created_at)
         VALUES ($1, 'user_provisioned', 'user', $2, $3, $4, NOW())`,
        [
          uuidv4(),
          userId,
          process.env.USER || 'unknown', // who ran this CLI command
          JSON.stringify({
            email: options.email,
            role: options.role,
            department: options.department,
            skipLdap: options.skipLdap,
          }),
        ]
      );
    }

    console.log(chalk.green('\n=== Provisioning Complete ==='));
    console.log(`User ID:  ${userId}`);
    console.log(`Email:    ${options.email}`);
    console.log(`Role:     ${options.role}`);
    console.log(`Temp PW:  ${tempPassword}`);
    console.log(chalk.yellow('\nRemember: User must change password on first login'));

    // manual steps reminder
    console.log(chalk.cyan('\n--- Manual Steps Required ---'));
    console.log('The following must be done manually:');
    console.log('  [ ] Add to appropriate Slack channels');
    console.log('  [ ] Add to PagerDuty (if engineering/ops role)');
    console.log('  [ ] Add to 1Password vault (shared credentials)');
    console.log('  [ ] Schedule orientation meeting');
    if (options.role === 'provider') {
      console.log('  [ ] Verify NPI and medical credentials');
      console.log('  [ ] Complete DEA registration check');
      console.log('  [ ] Add to clinical scheduling system');
    }
    if (options.role === 'engineering') {
      console.log('  [ ] Add to GitHub organization');
      console.log('  [ ] Grant AWS IAM access');
      console.log('  [ ] Add to DataDog');
    }

  } catch (err: any) {
    console.error(chalk.red(`\nProvisioning failed: ${err.message}`));
    console.error(chalk.yellow('Partial provisioning may have occurred. Check the audit log.'));
    process.exit(1);
  } finally {
    await pool.end();
  }
}

function generateTempPassword(): string {
  // generate a reasonably secure temp password
  // must meet our password policy: 12+ chars, upper, lower, number, special
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  const numbers = '0123456789';
  const special = '!@#$%^&*';
  const all = upper + lower + numbers + special;

  // ensure at least one of each type
  let password = '';
  password += upper[Math.floor(Math.random() * upper.length)];
  password += lower[Math.floor(Math.random() * lower.length)];
  password += numbers[Math.floor(Math.random() * numbers.length)];
  password += special[Math.floor(Math.random() * special.length)];

  // fill the rest randomly
  for (let i = 4; i < 16; i++) {
    password += all[Math.floor(Math.random() * all.length)];
  }

  // shuffle - this is Fisher-Yates but kinda janky
  const arr = password.split('');
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }

  return arr.join('');
}

async function sendWelcomeEmail(
  to: string,
  name: string,
  tempPassword: string,
  role: string
): Promise<void> {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.meridianhealth.io',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: {
      user: process.env.SMTP_USER || 'noreply@meridianhealth.io',
      pass: process.env.SMTP_PASSWORD,
    },
  });

  await transporter.sendMail({
    from: '"Meridian Health IT" <noreply@meridianhealth.io>',
    to,
    subject: 'Welcome to Meridian Health - Your Account Details',
    html: `
      <h2>Welcome to Meridian Health, ${name}!</h2>
      <p>Your account has been created. Here are your login details:</p>
      <ul>
        <li><strong>Email:</strong> ${to}</li>
        <li><strong>Temporary Password:</strong> ${tempPassword}</li>
        <li><strong>Role:</strong> ${role}</li>
      </ul>
      <p>Please log in at <a href="https://app.meridianhealth.io">app.meridianhealth.io</a>
         and change your password immediately.</p>
      <p>If you have any issues, contact IT support at support@meridianhealth.io.</p>
      <hr>
      <p style="color: #888; font-size: 12px;">
        This is an automated message. Please do not reply.
      </p>
    `,
  });
}
