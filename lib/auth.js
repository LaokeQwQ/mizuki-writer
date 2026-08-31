import jwt from 'jsonwebtoken';
import pool from './db.js';
import { sendInternalError } from './http.js';

const VALID_ROLES = new Set(['admin', 'editor']);

export function getBearerToken(req) {
    const value = req.headers.authorization;
    if (typeof value !== 'string') return null;
    const match = value.match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : null;
}

export async function userFromToken(token) {
    if (!token || !process.env.JWT_SECRET) return null;

    let payload;
    try {
        payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    } catch {
        return null;
    }

    if (!payload || typeof payload.username !== 'string' || !payload.username) {
        return null;
    }

    const { rows } = await pool.query(
        'SELECT username, nickname, avatar, role, created_at FROM users WHERE username = $1',
        [payload.username],
    );
    if (rows.length === 0 || !VALID_ROLES.has(rows[0].role)) return null;

    // Use the current database role instead of trusting the value embedded in an old JWT.
    return { ...payload, ...rows[0] };
}

export async function authMiddleware(req, res, next) {
    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ error: '未授权' });
    if (!process.env.JWT_SECRET) return res.status(503).json({ error: '认证服务未配置' });

    try {
        const user = await userFromToken(token);
        if (!user) return res.status(401).json({ error: 'Token 无效或已失效' });
        req.user = user;
        return next();
    } catch (error) {
        return sendInternalError(res, error, '认证失败');
    }
}

export function requireRole(...roles) {
    const allowed = new Set(roles);
    return (req, res, next) => {
        if (!req.user || !allowed.has(req.user.role)) {
            return res.status(403).json({ error: '权限不足' });
        }
        return next();
    };
}

export { VALID_ROLES };
