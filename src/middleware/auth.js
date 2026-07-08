import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import { verifyToken } from '../utils/token.js';
import User from '../models/User.js';

/**
 * Authenticate the request. Accepts either:
 *   - Authorization: Bearer <jwt>   (normal user login)
 *   - x-admin-token: <ADMIN_TOKEN>  (manager shortcut from .env)
 * Sets req.user. Throws 401 if neither is valid.
 */
export const protect = asyncHandler(async (req, res, next) => {
  const adminToken = req.headers['x-admin-token'];
  if (adminToken && process.env.ADMIN_TOKEN && adminToken === process.env.ADMIN_TOKEN) {
    req.user = { _id: 'admin-token', name: 'מנהל', role: 'manager', isAdminToken: true };
    return next();
  }

  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw ApiError.unauthorized();

  let decoded;
  try {
    decoded = verifyToken(token);
  } catch {
    throw ApiError.unauthorized('טוקן לא תקין או שפג תוקפו');
  }
  const user = await User.findById(decoded.id);
  if (!user || !user.active) throw ApiError.unauthorized('המשתמש לא קיים או לא פעיל');
  req.user = user;

  // "View as" (impersonation): a super-admin may act as another user for this request.
  // The real token stays the super-admin's; only req.user is swapped, and scopeToRep
  // (which runs after) then scopes to the impersonated user's role.
  const impId = req.headers['x-impersonate-user'];
  if (impId && user.superAdmin) {
    const target = await User.findById(impId);
    if (target && target.active) {
      req.impersonator = user;
      req.user = target;
    }
  }
  next();
});

/** Allow only managers (or the admin token). */
export const requireManager = (req, res, next) => {
  if (req.user?.role !== 'manager') throw ApiError.forbidden('הפעולה מותרת למנהל בלבד');
  next();
};

/**
 * Reps may only access their own data. Managers see everything.
 * Use req.scopeRepId in controllers to constrain queries.
 */
export const scopeToRep = (req, res, next) => {
  if (req.user?.role === 'rep') req.scopeRepId = String(req.user._id);
  else req.scopeRepId = null; // manager: no constraint
  next();
};
