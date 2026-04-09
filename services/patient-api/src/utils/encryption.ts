import crypto from 'crypto';

/**
 * AES-256-GCM encryption for sensitive PII fields (SSN, etc.)
 *
 * HIPAA Security Rule 45 CFR 164.312(a)(2)(iv) requires encryption
 * of ePHI at rest. We use AES-256-GCM which provides both
 * confidentiality and integrity (authenticated encryption).
 *
 * KEY MANAGEMENT:
 *   The encryption key is loaded from environment variable ENCRYPTION_KEY.
 *   In production, this comes from AWS Secrets Manager via ECS task definition.
 *
 *   TODO: Implement key rotation (PLAT-2890)
 *     Currently if we need to rotate the key, we'd have to:
 *     1. Decrypt all SSNs with old key
 *     2. Re-encrypt with new key
 *     3. Update the key in Secrets Manager
 *     This is a big batch operation and we don't have tooling for it yet.
 *     Should probably use AWS KMS envelope encryption instead where
 *     we only need to rotate the KEK (Key Encryption Key).
 *
 *   TODO: Consider using AWS KMS directly for encryption (PLAT-2891)
 *     This would give us automatic key rotation, audit logging of key usage,
 *     and proper key lifecycle management. Downside is latency and cost
 *     for high-volume operations.
 *
 * IMPORTANT: Never log the encryption key or plaintext SSN values.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16; // 128 bits
const AUTH_TAG_LENGTH = 16; // 128 bits
const ENCODING = 'hex';

// Key derivation from the environment variable
// The env var should be a 64-char hex string (32 bytes = 256 bits)
function getEncryptionKey(): Buffer {
  const keyHex = process.env.ENCRYPTION_KEY;

  if (!keyHex) {
    // In development, use a hardcoded key (obviously not for production)
    if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') {
      // This is a dev-only key, DO NOT use in production
      return Buffer.from('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'hex');
    }
    throw new Error('ENCRYPTION_KEY environment variable is not set');
  }

  if (keyHex.length !== 64) {
    throw new Error('ENCRYPTION_KEY must be a 64-character hex string (32 bytes)');
  }

  return Buffer.from(keyHex, 'hex');
}

/**
 * Encrypt a plaintext string using AES-256-GCM
 *
 * Output format: iv:authTag:ciphertext (all hex encoded)
 * We store the IV and auth tag alongside the ciphertext because
 * we need them for decryption.
 *
 * @param plaintext - the string to encrypt
 * @returns encrypted string in format "iv:authTag:ciphertext"
 */
export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', ENCODING);
  encrypted += cipher.final(ENCODING);

  const authTag = cipher.getAuthTag();

  // Format: iv:authTag:ciphertext
  return `${iv.toString(ENCODING)}:${authTag.toString(ENCODING)}:${encrypted}`;
}

/**
 * Decrypt an encrypted string
 *
 * @param encryptedText - string in format "iv:authTag:ciphertext"
 * @returns decrypted plaintext string
 */
export function decrypt(encryptedText: string): string {
  const key = getEncryptionKey();
  const parts = encryptedText.split(':');

  if (parts.length !== 3) {
    throw new Error('Invalid encrypted text format');
  }

  const iv = Buffer.from(parts[0], ENCODING);
  const authTag = Buffer.from(parts[1], ENCODING);
  const ciphertext = parts[2];

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertext, ENCODING, 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

// Convenience wrappers for SSN specifically
// (we might encrypt other fields later, so keeping the generic functions too)

/**
 * Encrypt an SSN value
 * Strips dashes before encryption for consistent storage
 */
export function encryptSSN(ssn: string): string {
  // Normalize: remove dashes
  const normalized = ssn.replace(/-/g, '');

  if (!/^\d{9}$/.test(normalized)) {
    throw new Error('Invalid SSN format - must be 9 digits');
  }

  return encrypt(normalized);
}

/**
 * Decrypt an SSN value
 * Returns in xxx-xx-xxxx format
 */
export function decryptSSN(encryptedSSN: string): string {
  const decrypted = decrypt(encryptedSSN);

  // Format as xxx-xx-xxxx
  return `${decrypted.slice(0, 3)}-${decrypted.slice(3, 5)}-${decrypted.slice(5)}`;
}

/**
 * Mask an SSN for display purposes
 * Shows only last 4 digits: ***-**-1234
 */
export function maskSSN(ssn: string): string {
  const clean = ssn.replace(/-/g, '');
  return `***-**-${clean.slice(-4)}`;
}

/**
 * Hash an SSN for lookup/matching purposes
 * Uses HMAC-SHA256 so we can find matching SSNs without decrypting
 *
 * NOTE: not currently used - was going to be part of the duplicate
 * detection system but we went a different direction
 */
export function hashSSN(ssn: string): string {
  const normalized = ssn.replace(/-/g, '');
  const hmacKey = process.env.SSN_HMAC_KEY || 'dev-hmac-key'; // separate from encryption key
  return crypto.createHmac('sha256', hmacKey).update(normalized).digest('hex');
}

// old encryption that used CBC mode - replaced with GCM for authenticated encryption
// keeping for reference in case we need to decrypt old values during migration
/*
function encryptCBC(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decryptCBC(encryptedText: string): string {
  const key = getEncryptionKey();
  const [ivHex, ciphertext] = encryptedText.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}
*/
