/**
 * Feature Flag Evaluation Engine
 * ================================
 *
 * Author: Amanda Jiang (ajiang@meridianhealth.io)
 * Created: 2024-02-10
 * Last Modified: 2025-12-20 by ajiang
 *
 * Evaluates feature flags for a given context (user, organization, etc.).
 * Supports multiple targeting strategies:
 *   - Percentage rollout (deterministic hash-based)
 *   - User list (specific user IDs)
 *   - Organization list
 *   - Property-based (evaluate against context properties)
 *   - Kill switch (simple on/off)
 *
 * Has an in-memory cache with TTL to avoid reading the config file on every
 * request. The cache is refreshed every 60 seconds.
 *
 * Usage:
 *   import { evaluateFlag, isEnabled } from './evaluate';
 *
 *   const context = {
 *     userId: 'user-123',
 *     organizationId: 'org-456',
 *     properties: { role: 'provider', specialty: 'cardiology' }
 *   };
 *
 *   if (isEnabled('new-scheduling-ui', context)) {
 *     // show new UI
 *   }
 */

import { createHash } from 'crypto';
import { readFileSync, watchFile } from 'fs';
import { join } from 'path';

// -- Types -------------------------------------------------------------------

interface FlagTargeting {
  type: 'percentage' | 'user_list' | 'organization_list' | 'property' | 'kill_switch';
  seed?: string;
  userIds?: string[];
  organizationIds?: string[];
  property?: string;
  operator?: 'equals' | 'not_equals' | 'contains' | 'in' | 'gt' | 'lt';
  value?: unknown;
}

interface FlagConfig {
  description: string;
  enabled: boolean;
  rolloutPercentage: number;
  targeting: FlagTargeting;
  allowList?: string[];
  excludeOrganizations?: string[];
  excludeUsers?: string[];
  createdAt: string;
  createdBy: string;
  notes?: string;
}

interface FlagsFile {
  flags: Record<string, FlagConfig>;
}

interface EvaluationContext {
  userId?: string;
  organizationId?: string;
  patientId?: string;
  providerId?: string;
  properties?: Record<string, unknown>;
}

interface EvaluationResult {
  enabled: boolean;
  reason: string;
  flagName: string;
  context: EvaluationContext;
}

// -- Cache -------------------------------------------------------------------

const CONFIG_PATH = join(__dirname, 'flag-config.json');
const CACHE_TTL_MS = 60 * 1000;  // 60 seconds

let cachedConfig: FlagsFile | null = null;
let cacheTimestamp = 0;

function loadConfig(): FlagsFile {
  const now = Date.now();

  if (cachedConfig && (now - cacheTimestamp) < CACHE_TTL_MS) {
    return cachedConfig;
  }

  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    cachedConfig = JSON.parse(raw);
    cacheTimestamp = now;

    // Strip comments (JSON doesn't support them but we use them in the config)
    // Actually, our config uses "_comment" keys which are valid JSON, so this
    // isn't needed. Leaving the comment here in case someone adds // comments
    // and wonders why things break.

    return cachedConfig!;
  } catch (err) {
    console.error(`Failed to load feature flag config: ${(err as Error).message}`);
    // Return empty config on error - all flags will evaluate to false
    // This is the safe default (fail closed)
    if (cachedConfig) {
      console.warn('Using stale cached config');
      return cachedConfig;
    }
    return { flags: {} };
  }
}

// Watch for config file changes (hot reload in development)
if (process.env.NODE_ENV !== 'production') {
  try {
    watchFile(CONFIG_PATH, { interval: 5000 }, () => {
      console.log('[feature-flags] Config file changed, invalidating cache');
      cachedConfig = null;
      cacheTimestamp = 0;
    });
  } catch {
    // watchFile might not work in all environments (e.g., Docker without inotify)
  }
}

// -- Hash-based percentage rollout -------------------------------------------

/**
 * Deterministic hash to decide if a entity is in the rollout percentage.
 * Uses the flag name + entity ID as input so that each flag has a different
 * set of users at each percentage level.
 */
function isInPercentage(flagName: string, entityId: string, percentage: number): boolean {
  if (percentage >= 100) return true;
  if (percentage <= 0) return false;

  const hash = createHash('md5')
    .update(`${flagName}:${entityId}`)
    .digest();

  // Use first 4 bytes as a uint32 and mod 100
  const value = hash.readUInt32BE(0) % 100;
  return value < percentage;
}

// -- Evaluation --------------------------------------------------------------

export function evaluateFlag(flagName: string, context: EvaluationContext): EvaluationResult {
  const config = loadConfig();
  const flag = config.flags[flagName];

  const result: EvaluationResult = {
    enabled: false,
    reason: '',
    flagName,
    context,
  };

  // Flag doesn't exist
  if (!flag) {
    result.reason = 'flag_not_found';
    return result;
  }

  // Flag is globally disabled
  if (!flag.enabled) {
    result.reason = 'flag_disabled';
    return result;
  }

  // Check exclude lists
  if (flag.excludeOrganizations && context.organizationId) {
    if (flag.excludeOrganizations.includes(context.organizationId)) {
      result.reason = 'excluded_organization';
      return result;
    }
  }

  if (flag.excludeUsers && context.userId) {
    if (flag.excludeUsers.includes(context.userId)) {
      result.reason = 'excluded_user';
      return result;
    }
  }

  // Check allow list (bypass targeting rules)
  if (flag.allowList) {
    const entityId = context.organizationId || context.userId || '';
    if (flag.allowList.includes(entityId)) {
      result.enabled = true;
      result.reason = 'allow_list';
      return result;
    }
  }

  // Evaluate targeting
  switch (flag.targeting.type) {
    case 'kill_switch':
      // Kill switch: if enabled is true, flag is on for everyone
      result.enabled = flag.enabled;
      result.reason = 'kill_switch';
      break;

    case 'percentage': {
      // Determine which entity ID to use for the hash
      const seedField = flag.targeting.seed || 'user_id';
      let entityId = '';

      switch (seedField) {
        case 'user_id':
          entityId = context.userId || '';
          break;
        case 'organization_id':
          entityId = context.organizationId || '';
          break;
        case 'patient_id':
          entityId = context.patientId || '';
          break;
        case 'provider_id':
          entityId = context.providerId || '';
          break;
        default:
          entityId = context.userId || '';
      }

      if (!entityId) {
        result.reason = 'missing_seed_field';
        return result;
      }

      result.enabled = isInPercentage(flagName, entityId, flag.rolloutPercentage);
      result.reason = result.enabled ? 'percentage_included' : 'percentage_excluded';
      break;
    }

    case 'user_list':
      if (!context.userId) {
        result.reason = 'missing_user_id';
        return result;
      }
      result.enabled = (flag.targeting.userIds || []).includes(context.userId);
      result.reason = result.enabled ? 'user_list_match' : 'user_list_no_match';
      break;

    case 'organization_list':
      if (!context.organizationId) {
        result.reason = 'missing_organization_id';
        return result;
      }
      result.enabled = (flag.targeting.organizationIds || []).includes(context.organizationId);
      result.reason = result.enabled ? 'org_list_match' : 'org_list_no_match';
      break;

    case 'property': {
      if (!context.properties || !flag.targeting.property) {
        result.reason = 'missing_property';
        return result;
      }

      const propPath = flag.targeting.property.split('.');
      let propValue: unknown = context.properties;
      for (const key of propPath) {
        if (propValue && typeof propValue === 'object') {
          propValue = (propValue as Record<string, unknown>)[key];
        } else {
          propValue = undefined;
          break;
        }
      }

      if (propValue === undefined) {
        result.reason = 'property_not_found';
        return result;
      }

      const targetValue = flag.targeting.value;

      switch (flag.targeting.operator) {
        case 'equals':
          result.enabled = propValue === targetValue;
          break;
        case 'not_equals':
          result.enabled = propValue !== targetValue;
          break;
        case 'contains':
          result.enabled = String(propValue).includes(String(targetValue));
          break;
        case 'in':
          result.enabled = Array.isArray(targetValue) && targetValue.includes(propValue);
          break;
        case 'gt':
          result.enabled = Number(propValue) > Number(targetValue);
          break;
        case 'lt':
          result.enabled = Number(propValue) < Number(targetValue);
          break;
        default:
          result.enabled = propValue === targetValue;
      }

      result.reason = result.enabled ? 'property_match' : 'property_no_match';
      break;
    }

    default:
      result.reason = 'unknown_targeting_type';
  }

  return result;
}

/**
 * Simple boolean check - the one you'll use 99% of the time.
 */
export function isEnabled(flagName: string, context: EvaluationContext): boolean {
  return evaluateFlag(flagName, context).enabled;
}

/**
 * Get all flags and their states for a context.
 * Useful for sending flag state to the frontend in one shot.
 */
export function getAllFlags(context: EvaluationContext): Record<string, boolean> {
  const config = loadConfig();
  const result: Record<string, boolean> = {};

  for (const flagName of Object.keys(config.flags)) {
    result[flagName] = isEnabled(flagName, context);
  }

  return result;
}

/**
 * Force-refresh the config cache.
 * Call this after updating the config file programmatically.
 */
export function invalidateCache(): void {
  cachedConfig = null;
  cacheTimestamp = 0;
}

// -- CLI for testing ---------------------------------------------------------

if (require.main === module) {
  const flagName = process.argv[2];
  const userId = process.argv[3] || 'test-user';
  const orgId = process.argv[4] || 'test-org';

  if (!flagName) {
    console.log('Usage: npx tsx evaluate.ts <flag-name> [user-id] [org-id]');
    console.log('');
    console.log('Available flags:');
    const config = loadConfig();
    for (const [name, flag] of Object.entries(config.flags)) {
      const status = flag.enabled ? `ON (${flag.rolloutPercentage}%)` : 'OFF';
      console.log(`  ${name.padEnd(35)} ${status.padEnd(10)} ${flag.description}`);
    }
    process.exit(0);
  }

  const context: EvaluationContext = {
    userId,
    organizationId: orgId,
  };

  const result = evaluateFlag(flagName, context);
  console.log(JSON.stringify(result, null, 2));
}
