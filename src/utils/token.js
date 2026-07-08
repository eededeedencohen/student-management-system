import jwt from 'jsonwebtoken';

const secret = () => process.env.JWT_SECRET || 'dev-secret-change-me';

export const signToken = (payload) =>
  jwt.sign(payload, secret(), { expiresIn: process.env.JWT_EXPIRES_IN || '30d' });

export const verifyToken = (token) => jwt.verify(token, secret());
