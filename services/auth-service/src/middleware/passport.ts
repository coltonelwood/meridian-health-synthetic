import { PassportStatic } from 'passport';
import { Strategy as JwtStrategy, ExtractJwt } from 'passport-jwt';
import { Strategy as LocalStrategy } from 'passport-local';
import { Request, Response, NextFunction } from 'express';
import { UserModel } from '../models/User';
import { logger } from '../utils/logger';

const JWT_SECRET = process.env.JWT_SECRET || 'meridian-dev-secret-do-not-use-in-prod';
const userModel = new UserModel();

export function configurePassport(passport: PassportStatic) {
  // JWT Strategy - extract token from cookie or Authorization header
  passport.use(new JwtStrategy({
    jwtFromRequest: ExtractJwt.fromExtractors([
      // Try cookie first, then header
      (req: Request) => req.cookies?.meridian_session || null,
      ExtractJwt.fromAuthHeaderAsBearerToken(),
    ]),
    secretOrKey: JWT_SECRET,
  }, async (payload, done) => {
    try {
      if (payload.type !== 'access') {
        return done(null, false);
      }
      const user = await userModel.findByIdSafe(payload.sub);
      if (!user) return done(null, false);
      return done(null, user);
    } catch (err) {
      return done(err, false);
    }
  }));

  // Local strategy for username/password login
  passport.use(new LocalStrategy({
    usernameField: 'email',
    passwordField: 'password',
  }, async (email, password, done) => {
    try {
      const user = await userModel.findByEmail(email);
      if (!user) return done(null, false);

      const result = await userModel.verifyPassword(user, password);
      if (!result.success) return done(null, false);

      return done(null, user);
    } catch (err) {
      return done(err);
    }
  }));
}

// Middleware to require JWT authentication
export function authenticateJWT(req: Request, res: Response, next: NextFunction) {
  const passport = require('passport');
  passport.authenticate('jwt', { session: false }, (err: any, user: any) => {
    if (err) {
      logger.error('JWT auth error', { error: err.message });
      return res.status(500).json({ error: 'Authentication error' });
    }
    if (!user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    (req as any).user = user;
    next();
  })(req, res, next);
}

// Middleware to require specific role(s)
export function requireRole(roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = (req as any).user;
    if (!user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!roles.includes(user.role)) {
      logger.warn('Unauthorized role access attempt', {
        userId: user.id,
        userRole: user.role,
        requiredRoles: roles,
        path: req.path,
      });
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}
