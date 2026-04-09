/**
 * Redis Session Store Configuration (DEPRECATED)
 *
 * DEPRECATED: The new auth system uses stateless JWTs.
 * This session-based approach is no longer used.
 *
 * This module configured the Redis-based session store and handled
 * session cleanup. It also implemented the HIPAA-required
 * auto-logout after 15 minutes of inactivity.
 *
 * Original author: Sarah Okonkwo
 * Created: 2019-04
 * Last modified: 2023-11
 */

'use strict';

const session = require('express-session');
const RedisStore = require('connect-redis')(session);
const Redis = require('ioredis');
const crypto = require('crypto');

// Redis connection configuration
const REDIS_CONFIG = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
  db: parseInt(process.env.REDIS_SESSION_DB || '2', 10),
  keyPrefix: 'mht:sess:',

  // Connection resilience
  retryStrategy: function (times) {
    var delay = Math.min(times * 50, 2000);
    console.log('Redis session store reconnecting, attempt ' + times + ', delay ' + delay + 'ms');
    return delay;
  },
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  connectTimeout: 10000,

  // TLS for production
  tls: process.env.REDIS_TLS === 'true' ? {
    rejectUnauthorized: true
  } : undefined,

  // Sentinel config for HA (used in production)
  // In production we used Redis Sentinel for automatic failover.
  // After the 2023-03 outage where Redis went down and all users
  // were logged out, we added Sentinel. But honestly, migrating to
  // JWTs was the better long-term fix.
  sentinels: process.env.REDIS_SENTINELS ? JSON.parse(process.env.REDIS_SENTINELS) : undefined,
  name: process.env.REDIS_SENTINEL_MASTER || undefined
};

// Create Redis client
var redisClient;

function getRedisClient() {
  if (!redisClient) {
    if (REDIS_CONFIG.sentinels) {
      redisClient = new Redis({
        sentinels: REDIS_CONFIG.sentinels,
        name: REDIS_CONFIG.name,
        password: REDIS_CONFIG.password,
        db: REDIS_CONFIG.db,
        keyPrefix: REDIS_CONFIG.keyPrefix,
        retryStrategy: REDIS_CONFIG.retryStrategy,
        tls: REDIS_CONFIG.tls
      });
    } else {
      redisClient = new Redis(REDIS_CONFIG);
    }

    redisClient.on('connect', function () {
      console.log('Session store: Redis connected');
    });

    redisClient.on('error', function (err) {
      console.error('Session store: Redis error:', err.message);
      // Don't crash the app if Redis goes down - degrade gracefully
      // (In practice, "degrade gracefully" meant "silently fail to create sessions"
      //  which was arguably worse than crashing)
    });

    redisClient.on('close', function () {
      console.warn('Session store: Redis connection closed');
    });
  }

  return redisClient;
}

// Session store instance
function createSessionStore() {
  var client = getRedisClient();

  return new RedisStore({
    client: client,
    prefix: '',  // Already set in keyPrefix
    ttl: 1800,   // 30 minutes - matches HIPAA timeout requirement

    // Disable touch to reduce Redis writes
    // We handle session extension manually on activity
    disableTouch: false,

    // Serialize/deserialize with JSON
    serializer: {
      stringify: function (sess) {
        // Strip any PHI from the session before storing
        // We learned the hard way that devs were accidentally
        // putting patient data in req.session
        var cleanSession = Object.assign({}, sess);

        // Remove any fields that might contain PHI
        delete cleanSession.patientRecord;
        delete cleanSession.labResults;
        delete cleanSession.medications;

        // Only keep the minimum needed
        return JSON.stringify(cleanSession);
      },
      parse: function (str) {
        try {
          return JSON.parse(str);
        } catch (e) {
          console.error('Failed to parse session data:', e.message);
          return {};
        }
      }
    }
  });
}

// Session middleware configuration
function createSessionMiddleware() {
  var store = createSessionStore();

  return session({
    store: store,
    name: 'mht.sid',
    secret: process.env.SESSION_SECRET || generateDevSecret(),
    resave: false,
    saveUninitialized: false,

    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      maxAge: 1800000,  // 30 minutes
      sameSite: 'lax',
      domain: process.env.COOKIE_DOMAIN || undefined,
      path: '/'
    },

    // Generate session IDs with crypto for security
    genid: function (req) {
      return crypto.randomBytes(32).toString('hex');
    },

    // Rolling: reset the cookie expiry on each response
    // This means the session stays alive as long as the user is active
    rolling: true
  });
}

/**
 * Generate a development-only session secret.
 * In production, this comes from AWS Secrets Manager.
 */
function generateDevSecret() {
  console.warn('WARNING: Using generated session secret. Set SESSION_SECRET in production!');
  return 'meridian-dev-' + crypto.randomBytes(16).toString('hex');
}

// ============================================================
// Session Cleanup
// ============================================================

/**
 * Clean up expired sessions from Redis.
 *
 * Redis TTL should handle this automatically, but we had cases where
 * TTL wasn't being set properly (a bug in connect-redis 3.x).
 * This cleanup job runs as an extra safety net.
 *
 * Also cleans up orphaned "remember me" tokens.
 */
function cleanupExpiredSessions(callback) {
  var client = getRedisClient();
  var cursor = '0';
  var cleaned = 0;
  var scanned = 0;
  var batchSize = 100;
  var errors = 0;

  console.log('Starting session cleanup...');

  function scanBatch() {
    // Use SCAN instead of KEYS to avoid blocking Redis
    // Learned this the hard way when KEYS * took down Redis for 30 seconds
    client.scan(cursor, 'MATCH', 'mht:sess:*', 'COUNT', batchSize, function (err, result) {
      if (err) {
        console.error('Session cleanup scan error:', err.message);
        errors++;
        if (callback) callback(err);
        return;
      }

      cursor = result[0];
      var keys = result[1];
      scanned += keys.length;

      if (keys.length === 0) {
        if (cursor === '0') {
          finishCleanup();
        } else {
          scanBatch();
        }
        return;
      }

      // Check each session
      var pipeline = client.pipeline();
      keys.forEach(function (key) {
        pipeline.ttl(key);
      });

      pipeline.exec(function (err, results) {
        if (err) {
          console.error('Session cleanup TTL check error:', err.message);
          errors++;
          scanBatch();
          return;
        }

        var expiredKeys = [];
        results.forEach(function (result, index) {
          var ttl = result[1];
          // TTL of -1 means no expiry set (bug)
          // TTL of -2 means key doesn't exist (race condition)
          if (ttl === -1) {
            expiredKeys.push(keys[index]);
          }
        });

        if (expiredKeys.length > 0) {
          // Delete sessions with no TTL set
          var delPipeline = client.pipeline();
          expiredKeys.forEach(function (key) {
            delPipeline.del(key);
          });

          delPipeline.exec(function (err) {
            if (err) {
              console.error('Session cleanup delete error:', err.message);
              errors++;
            } else {
              cleaned += expiredKeys.length;
            }

            if (cursor === '0') {
              finishCleanup();
            } else {
              scanBatch();
            }
          });
        } else {
          if (cursor === '0') {
            finishCleanup();
          } else {
            scanBatch();
          }
        }
      });
    });
  }

  function finishCleanup() {
    var summary = {
      timestamp: new Date().toISOString(),
      scanned: scanned,
      cleaned: cleaned,
      errors: errors
    };

    console.log('Session cleanup complete:', JSON.stringify(summary));

    if (callback) callback(null, summary);
  }

  scanBatch();
}

/**
 * Get session statistics for monitoring.
 */
function getSessionStats(callback) {
  var client = getRedisClient();

  client.dbsize(function (err, count) {
    if (err) {
      return callback(err);
    }

    // Note: dbsize returns ALL keys in the database, not just sessions.
    // If we were sharing the Redis database (which we were in dev),
    // this number would be inaccurate. In production, session store
    // had its own Redis database (db 2).

    var stats = {
      activeSessions: count,
      timestamp: new Date().toISOString()
    };

    callback(null, stats);
  });
}

/**
 * Force-expire a specific user's sessions.
 * Used when an admin needs to force-logout a user (e.g., account compromise).
 */
function invalidateUserSessions(userId, callback) {
  var client = getRedisClient();
  var cursor = '0';
  var invalidated = 0;

  // This is O(n) scan which is slow, but we rarely needed it.
  // The new JWT system has a proper token blacklist.

  function scan() {
    client.scan(cursor, 'MATCH', 'mht:sess:*', 'COUNT', 100, function (err, result) {
      if (err) return callback(err);

      cursor = result[0];
      var keys = result[1];

      if (keys.length === 0) {
        if (cursor === '0') {
          return callback(null, invalidated);
        }
        return scan();
      }

      var pipeline = client.pipeline();
      keys.forEach(function (key) {
        pipeline.get(key);
      });

      pipeline.exec(function (err, results) {
        if (err) return callback(err);

        var keysToDelete = [];
        results.forEach(function (result, index) {
          try {
            var sessionData = JSON.parse(result[1]);
            if (sessionData.passport &&
                sessionData.passport.user &&
                sessionData.passport.user.id === userId) {
              keysToDelete.push(keys[index]);
            }
          } catch (e) {
            // Corrupt session data - delete it anyway
            keysToDelete.push(keys[index]);
          }
        });

        if (keysToDelete.length > 0) {
          var delPipeline = client.pipeline();
          keysToDelete.forEach(function (key) {
            delPipeline.del(key);
          });

          delPipeline.exec(function (err) {
            if (!err) invalidated += keysToDelete.length;

            if (cursor === '0') {
              console.log('Invalidated ' + invalidated + ' sessions for user ' + userId);
              callback(null, invalidated);
            } else {
              scan();
            }
          });
        } else {
          if (cursor === '0') {
            callback(null, invalidated);
          } else {
            scan();
          }
        }
      });
    });
  }

  scan();
}

module.exports = {
  createSessionMiddleware: createSessionMiddleware,
  createSessionStore: createSessionStore,
  cleanupExpiredSessions: cleanupExpiredSessions,
  getSessionStats: getSessionStats,
  invalidateUserSessions: invalidateUserSessions,
  getRedisClient: getRedisClient
};
