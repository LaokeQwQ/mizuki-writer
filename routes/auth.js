import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import pool from '../lib/db.js';
import { logLogin, logAction } from '../lib/logger.js';
import { authMiddleware, getBearerToken, userFromToken, VALID_ROLES } from '../lib/auth.js';
import { getClientIp, sendInternalError } from '../lib/http.js';

const router = express.Router();

// ─── Rate limiting (simple in-memory) ──
const loginAttempts = new Map();
const setupAttempts = new Map();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000; // 15 min
const MAX_TRACKED_IPS = 10_000;
const MAX_SETUP_ATTEMPTS = 10;

function isValidPassword(password) {
    return typeof password === 'string'
        && password.length >= 6
        && Buffer.byteLength(password, 'utf8') <= 72;
}

function pruneRateLimit(now = Date.now()) {
    for (const [ip, record] of loginAttempts) {
        if (now - record.firstAttempt > WINDOW_MS) loginAttempts.delete(ip);
    }
    if (loginAttempts.size < MAX_TRACKED_IPS) return;
    const oldest = loginAttempts.keys().next().value;
    if (oldest) loginAttempts.delete(oldest);
}

function checkRateLimit(ip) {
    const now = Date.now();
    pruneRateLimit(now);
    const record = loginAttempts.get(ip);
    if (!record) return true;
    if (now - record.firstAttempt > WINDOW_MS) {
        loginAttempts.delete(ip);
        return true;
    }
    return record.count < MAX_ATTEMPTS;
}

function recordAttempt(ip) {
    const now = Date.now();
    pruneRateLimit(now);
    const record = loginAttempts.get(ip);
    if (!record || now - record.firstAttempt > WINDOW_MS) {
        loginAttempts.set(ip, { count: 1, firstAttempt: now });
    } else {
        record.count++;
    }
}

function clearAttempts(ip) {
    loginAttempts.delete(ip);
}

function checkSetupRateLimit(ip) {
    const now = Date.now();
    for (const [trackedIp, record] of setupAttempts) {
        if (now - record.firstAttempt > WINDOW_MS) setupAttempts.delete(trackedIp);
    }
    if (setupAttempts.size >= MAX_TRACKED_IPS && !setupAttempts.has(ip)) {
        const oldest = setupAttempts.keys().next().value;
        if (oldest) setupAttempts.delete(oldest);
    }
    const record = setupAttempts.get(ip);
    if (!record) {
        setupAttempts.set(ip, { count: 0, firstAttempt: now });
        return true;
    }
    return record.count < MAX_SETUP_ATTEMPTS;
}

function recordSetupAttempt(ip) {
    const record = setupAttempts.get(ip);
    if (record) record.count++;
}

// ─── Setup Token ───────────────────────
let setupToken = null;
let setupTokenPromise = null;

function timingSafeStringEqual(left, right) {
    if (typeof left !== 'string' || typeof right !== 'string') return false;
    const leftBuffer = Buffer.from(left, 'utf8');
    const rightBuffer = Buffer.from(right, 'utf8');
    if (leftBuffer.length !== rightBuffer.length) return false;
    return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

async function ensureSetupToken() {
    if (setupToken) return;
    if (setupTokenPromise) return setupTokenPromise;

    setupTokenPromise = (async () => {
        // 检查数据库中是否已有用户
        const { rows } = await pool.query('SELECT COUNT(*) as cnt FROM users');
        if (Number.parseInt(rows[0].cnt, 10) > 0) return; // 已有用户

        if (setupToken) return; // 已生成
        setupToken = crypto.randomBytes(16).toString('hex');
        console.log('\n' + '='.repeat(60));
        console.log('⚠️  管理员密码未设置！');
        console.log('   请使用以下安全令牌完成初始化设置：');
        console.log(`   🔑 Setup Token: ${setupToken}`);
        console.log('   打开管理后台后输入此令牌才能设置密码');
        console.log('='.repeat(60) + '\n');
    })();

    try {
        await setupTokenPromise;
    } finally {
        setupTokenPromise = null;
    }
}

// 检查是否需要初始设置
router.get('/check', async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT COUNT(*) as cnt FROM users');
        const needsSetup = parseInt(rows[0].cnt) === 0;

        const token = getBearerToken(req);
        let loggedIn = false;

        if (token && process.env.JWT_SECRET) {
            loggedIn = Boolean(await userFromToken(token));
        }

        res.json({
            needsSetup,
            needsToken: needsSetup,
            loggedIn,
        });
    } catch (err) {
        sendInternalError(res, err, '检查认证状态失败');
    }
});

// 首次设置密码 — 需要 setup token
router.post('/setup', async (req, res) => {
    try {
        const ip = getClientIp(req);
        if (!checkSetupRateLimit(ip)) {
            return res.status(429).json({ error: '初始化尝试次数过多，请15分钟后再试' });
        }

        const { username, password, token } = req.body || {};

        if (!timingSafeStringEqual(token, setupToken)) {
            recordSetupAttempt(ip);
            return res.status(403).json({ error: '安全令牌无效，请查看服务器日志获取令牌' });
        }

        const uname = typeof username === 'string' && username.trim() ? username.trim() : 'admin';
        if (!/^[a-zA-Z0-9_-]{2,32}$/.test(uname)) {
            recordSetupAttempt(ip);
            return res.status(400).json({ error: '用户名只能包含字母、数字、下划线和连字符，2-32 位' });
        }
        if (!isValidPassword(password)) {
            recordSetupAttempt(ip);
            return res.status(400).json({ error: '密码长度需为 6-72 字节' });
        }

        // Serialize first-time setup across all app processes and re-check the
        // user count while holding the transaction lock.
        const client = await pool.connect();
        let transactionActive = false;
        try {
            await client.query('BEGIN');
            transactionActive = true;
            await client.query("SELECT pg_advisory_xact_lock(hashtextextended('mizuki-writer-setup', 0))");

            const { rows } = await client.query('SELECT COUNT(*) as cnt FROM users');
            if (Number.parseInt(rows[0].cnt, 10) > 0) {
                await client.query('ROLLBACK');
                transactionActive = false;
                return res.status(400).json({ error: '管理员密码已设置' });
            }

            // Another process may have changed the in-memory token while this
            // request was waiting for the database lock.
            if (!timingSafeStringEqual(token, setupToken)) {
                await client.query('ROLLBACK');
                transactionActive = false;
                recordSetupAttempt(ip);
                return res.status(403).json({ error: '安全令牌无效，请查看服务器日志获取令牌' });
            }

            const hash = await bcrypt.hash(password, 12);
            await client.query(
                'INSERT INTO users (username, nickname, password_hash, role) VALUES ($1, $2, $3, $4)',
                [uname, uname, hash, 'admin']
            );
            await client.query('COMMIT');
            transactionActive = false;
        } catch (error) {
            if (transactionActive) await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            client.release();
        }

        // Invalidate setup token
        setupToken = null;
        setupAttempts.delete(ip);
        console.log(`✅ 管理员账户已设置 (来自 IP: ${ip})`);
        await logAction('初始化设置', `管理员 "${uname}" 已创建`, uname, ip);

        const jwtToken = jwt.sign(
            { username: uname, role: 'admin' },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );

        res.json({ success: true, token: jwtToken, nickname: uname });
    } catch (err) {
        if (err?.code === '23505') {
            return res.status(409).json({ error: '管理员账户已被创建，请重新登录' });
        }
        sendInternalError(res, err, '初始化管理员失败');
    }
});

// 登录
router.post('/login', async (req, res) => {
    const ip = getClientIp(req);
    const ua = req.headers['user-agent'] || '';

    if (!checkRateLimit(ip)) {
        return res.status(429).json({ error: '登录尝试次数过多，请15分钟后再试' });
    }

    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
        recordAttempt(ip);
        return res.status(400).json({ error: '用户名和密码不能为空' });
    }
    if (username.length > 64) {
        recordAttempt(ip);
        return res.status(400).json({ error: '用户名格式无效' });
    }
    if (Buffer.byteLength(password, 'utf8') > 256) {
        recordAttempt(ip);
        return res.status(400).json({ error: '密码长度无效' });
    }

    try {
        const { rows } = await pool.query(
            'SELECT username, nickname, password_hash, avatar, role FROM users WHERE username = $1',
            [username]
        );

        if (rows.length === 0) {
            recordAttempt(ip);
            await logLogin(username, ip, ua, false);
            return res.status(401).json({ error: '用户名或密码错误' });
        }

        const user = rows[0];
        if (!VALID_ROLES.has(user.role)) {
            recordAttempt(ip);
            await logLogin(username, ip, ua, false);
            return res.status(401).json({ error: '用户名或密码错误' });
        }
        const valid = await bcrypt.compare(password, user.password_hash);

        if (!valid) {
            recordAttempt(ip);
            await logLogin(username, ip, ua, false);
            return res.status(401).json({ error: '用户名或密码错误' });
        }

        clearAttempts(ip);
        await logLogin(username, ip, ua, true);
        await logAction('用户登录', `IP: ${ip}`, username, ip);

        const jwtToken = jwt.sign(
            { username: user.username, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );

        res.json({
            success: true,
            token: jwtToken,
            nickname: user.nickname || user.username,
            avatar: user.avatar || '',
        });
    } catch (err) {
        sendInternalError(res, err, '用户登录失败');
    }
});

// 获取当前用户信息
router.get('/profile', authMiddleware, async (req, res) => {
    try {
        res.json({
            username: req.user.username,
            nickname: req.user.nickname,
            avatar: req.user.avatar || '',
            role: req.user.role,
            created_at: req.user.created_at,
        });
    } catch (err) {
        sendInternalError(res, err, '获取用户信息失败');
    }
});

// 导出 ensureSetupToken 供启动时调用
export { ensureSetupToken };
export default router;
