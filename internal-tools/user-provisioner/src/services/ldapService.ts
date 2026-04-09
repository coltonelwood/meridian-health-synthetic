import { Client, Change, Attribute } from 'ldapts';

/**
 * LDAP service for SSO integration.
 *
 * Connects to our internal OpenLDAP server for SSO.
 * Used for creating/disabling user accounts and managing group membership.
 *
 * Known issues:
 * TODO: Connection pooling - currently creates a new connection for each
 * operation which is slow and wastes resources. The ldapts library supports
 * connection pooling but I couldn't get it to work with our LDAP server's
 * TLS config. The connection kept dropping after ~30 seconds of idle time.
 * For now, we connect/disconnect for each provisioning operation which is
 * fine since we don't provision users that often.
 *
 * TODO: The TLS certificate verification is disabled (rejectUnauthorized: false)
 * because our LDAP server uses a self-signed cert. We should add the CA cert
 * to the trust store instead. Security team has been nagging about this.
 */
export class LDAPService {
  private client: Client;
  private connected = false;

  private readonly baseDN = 'dc=meridian,dc=health';
  private readonly userOU = 'ou=people';
  private readonly groupOU = 'ou=groups';

  constructor() {
    this.client = new Client({
      url: process.env.LDAP_URL || 'ldaps://ldap.meridianhealth.internal:636',
      tlsOptions: {
        // TODO: fix this - should use proper CA cert
        rejectUnauthorized: false,
      },
      // timeout in ms - LDAP server is slow sometimes
      timeout: 10000,
      connectTimeout: 5000,
    });
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    try {
      await this.client.bind(
        process.env.LDAP_BIND_DN || 'cn=admin,dc=meridian,dc=health',
        process.env.LDAP_BIND_PASSWORD || ''
      );
      this.connected = true;
    } catch (err: any) {
      throw new Error(`LDAP bind failed: ${err.message}`);
    }
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;

    try {
      await this.client.unbind();
    } catch {
      // ignore unbind errors
    }
    this.connected = false;
  }

  async createUser(params: {
    uid: string;
    cn: string;
    mail: string;
    userPassword: string;
  }): Promise<void> {
    const dn = `uid=${params.uid},${this.userOU},${this.baseDN}`;

    // split name into first/last for LDAP schema
    const nameParts = params.cn.split(' ');
    const givenName = nameParts[0] || params.uid;
    const sn = nameParts.slice(1).join(' ') || params.uid;

    await this.client.add(dn, {
      objectClass: ['inetOrgPerson', 'posixAccount', 'top'],
      uid: params.uid,
      cn: params.cn,
      givenName,
      sn,
      mail: params.mail,
      userPassword: params.userPassword,
      uidNumber: String(await this.getNextUidNumber()),
      gidNumber: '1000', // default group
      homeDirectory: `/home/${params.uid}`,
      loginShell: '/bin/bash',
      // custom attribute for account status
      // uses the meridianAccountStatus attribute from our custom schema
      // TODO: our custom LDAP schema is undocumented. It's in /etc/ldap/schema/meridian.schema
      // on the LDAP server but nowhere in version control.
    });
  }

  async disableUser(uid: string): Promise<void> {
    const dn = `uid=${uid},${this.userOU},${this.baseDN}`;

    // "disable" by setting the login shell to /sbin/nologin
    // and prefixing the password with {DISABLED}
    // This is a hack but OpenLDAP doesn't have a proper "disabled" flag
    // like Active Directory does
    try {
      await this.client.modify(dn, [
        new Change({
          operation: 'replace',
          modification: new Attribute({
            type: 'loginShell',
            values: ['/sbin/nologin'],
          }),
        }),
      ]);

      // also lock the password
      // NOTE: this uses the ppolicy overlay which might not be enabled
      // on all LDAP server instances. If it fails, the loginShell change
      // is still effective.
      try {
        await this.client.modify(dn, [
          new Change({
            operation: 'replace',
            modification: new Attribute({
              type: 'pwdAccountLockedTime',
              values: ['000001010000Z'], // permanent lock
            }),
          }),
        ]);
      } catch {
        // ppolicy might not be enabled, that's okay
        console.warn('Could not lock password via ppolicy, loginShell disabled only');
      }
    } catch (err: any) {
      throw new Error(`Failed to disable LDAP user ${uid}: ${err.message}`);
    }
  }

  async addToGroup(groupDN: string, uid: string): Promise<void> {
    try {
      await this.client.modify(groupDN, [
        new Change({
          operation: 'add',
          modification: new Attribute({
            type: 'memberUid',
            values: [uid],
          }),
        }),
      ]);
    } catch (err: any) {
      // "already a member" errors are fine, ignore them
      if (err.message?.includes('already exists') || err.code === 20) {
        return;
      }
      throw err;
    }
  }

  async removeFromGroup(groupDN: string, uid: string): Promise<void> {
    try {
      await this.client.modify(groupDN, [
        new Change({
          operation: 'delete',
          modification: new Attribute({
            type: 'memberUid',
            values: [uid],
          }),
        }),
      ]);
    } catch (err: any) {
      // "not a member" errors are fine
      if (err.message?.includes('no such attribute') || err.code === 16) {
        return;
      }
      throw err;
    }
  }

  async removeFromAllGroups(uid: string): Promise<void> {
    // find all groups this user belongs to
    const searchResult = await this.client.search(`${this.groupOU},${this.baseDN}`, {
      filter: `(memberUid=${uid})`,
      scope: 'sub',
      attributes: ['dn'],
    });

    for (const entry of searchResult.searchEntries) {
      try {
        await this.removeFromGroup(entry.dn, uid);
      } catch (err) {
        // log but continue - we want to remove from as many groups as possible
        console.warn(`Failed to remove ${uid} from ${entry.dn}:`, err);
      }
    }
  }

  /**
   * Get the next available UID number for POSIX account.
   *
   * This is not atomic and has a race condition if two users are
   * provisioned simultaneously. In practice this never happens because
   * only one person runs the provisioner at a time, but still...
   * TODO: use LDAP extended operation or a sequence table instead
   */
  private async getNextUidNumber(): Promise<number> {
    const result = await this.client.search(`${this.userOU},${this.baseDN}`, {
      filter: '(objectClass=posixAccount)',
      scope: 'sub',
      attributes: ['uidNumber'],
    });

    let maxUid = 10000; // start from 10000
    for (const entry of result.searchEntries) {
      const uid = parseInt(entry['uidNumber'] as string);
      if (uid > maxUid) maxUid = uid;
    }

    return maxUid + 1;
  }
}
