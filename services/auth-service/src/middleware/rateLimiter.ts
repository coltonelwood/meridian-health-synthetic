import rateLimit from 'express-rate-limit';
import { Request, Response } from 'express';
import { logger } from '../utils/logger';

// Rate limiting for auth endpoints
// These are critical to prevent brute force attacks

// TODO: move these to config/env vars
// Also should be using Redis store for distributed rate limiting
// Right now each instance has its own counter which means the actual
// limit is N * number_of_instances

export const rateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per window per IP
  standardHeaders: true,
  legacyHeaders: false,
  // Skip rate limiting for health checks
  skip: (req: Request) => req.path === '/health',
  handler: (req: Request, res: Response) => {
    logger.warn('Rate limit exceeded', {
      ip: req.ip,
      path: req.path,
      // Don't log headers in prod - could contain tokens
      headers: process.env.NODE_ENV === 'development' ? req.headers : undefined,
    });
    res.status(429).json({
      error: 'Too many requests, please try again later',
      retryAfter: 900, // 15 minutes in seconds
    });
  },
});

// Stricter rate limit for login endpoint specifically
export const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // only 5 login attempts per 15 minutes per IP
  standardHeaders: true,
  legacyHeaders: false,
  // TODO: also rate limit by email address, not just IP
  // Right now an attacker can try 5 passwords per IP but if they have
  // a botnet they can try 5 * N_bots passwords
  handler: (req: Request, res: Response) => {
    logger.warn('Login rate limit exceeded', {
      ip: req.ip,
      email: req.body?.email ? req.body.email.replace(/(.{2}).*(@.*)/, '$1***$2') : 'unknown',
    });
    res.status(429).json({
      error: 'Too many login attempts. Please try again in 15 minutes.',
      retryAfter: 900,
    });
  },
  // This keyGenerator is supposed to combine IP + email but it doesn't
  // work correctly because req.body might not be parsed yet
  // TODO: fix this - probably need to apply body parser before rate limiter
  keyGenerator: (req: Request) => {
    return req.ip || 'unknown';
    // return `${req.ip}:${req.body?.email || 'unknown'}`;  // broken, see above
  },
});

// Rate limit for password reset requests
export const passwordResetRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3, // 3 reset requests per hour per IP
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req: Request, res: Response) => {
    // Still return 200 to prevent enumeration
    // but don't actually send the email
    res.json({
      message: 'If an account exists with that email, a password reset link has been sent.',
    });
  },
});

// Rate limit for MFA verification
// More generous because users might fumble with their authenticator app
export const mfaRateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 10, // 10 attempts per 5 minutes
  standardHeaders: true,
  legacyHeaders: false,
});
