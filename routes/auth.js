import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import pool from '../lib/db.js';
import { logLogin, logAction } from '../lib/logger.js';

const router = express.Router();

// ─── Rate limiting (simple in-memory) ──
const loginAttempts = new Map();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000; // 15 min

function checkRateLimit(ip) {
    const now = Date.now();
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

// ─── Setup Token ───────────────────────
let setupToken = null;

async function ensureSetupToken() {
    // 检查数据库中是否已有用户
    const { rows } = await pool.query('SELECT COUNT(*) as cnt FROM users');
    if (parseInt(rows[0].cnt) > 0) return; // 已有用户

    if (setupToken) return; // 已生成
    setupToken = crypto.randomBytes(16).toString('hex');
    console.log('\n' + '='.repeat(60));
    console.log('⚠️  管理员密码未设置！');
    console.log('   请使用以下安全令牌完成初始化设置：');
    console.log(`   🔑 Setup Token: ${setupToken}`);
    console.log('   打开管理后台后输入此令牌才能设置密码');
    console.log('='.repeat(60) + '\n');
}

// 检查是否需要初始设置
router.get('/check', async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT COUNT(*) as cnt FROM users');
        const needsSetup = parseInt(rows[0].cnt) === 0;

        const token = req.headers.authorization?.replace('Bearer ', '');
        let loggedIn = false;

        if (token && process.env.JWT_SECRET) {
            try {
                jwt.verify(token, process.env.JWT_SECRET);
                loggedIn = true;
            } catch (e) {
                loggedIn = false;
            }
        }

        res.json({
            needsSetup,
            needsToken: needsSetup,
            loggedIn,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 首次设置密码 — 需要 setup token
router.post('/setup', async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT COUNT(*) as cnt FROM users');
        if (parseInt(rows[0].cnt) > 0) {
            return res.status(400).json({ error: '管理员密码已设置' });
        }

        const { username, password, token } = req.body;

        if (!token || token !== setupToken) {
            return res.status(403).json({ error: '安全令牌无效，请查看服务器日志获取令牌' });
        }

        if (!password || password.length < 6) {
            return res.status(400).json({ error: '密码至少6位' });
        }

        const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
        const hash = await bcrypt.hash(password, 12);
        const uname = username || 'admin';

        await pool.query(
            'INSERT INTO users (username, nickname, password_hash, role) VALUES ($1, $2, $3, $4)',
            [uname, uname, hash, 'admin']
        );

        // Invalidate setup token
        setupToken = null;
        console.log(`✅ 管理员账户已设置 (来自 IP: ${ip})`);
        await logAction('初始化设置', `管理员 "${uname}" 已创建`, uname, ip);

        const jwtToken = jwt.sign(
            { username: uname, role: 'admin' },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );

        res.json({ success: true, token: jwtToken, nickname: uname });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 登录
router.post('/login', async (req, res) => {
    const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    const ua = req.headers['user-agent'] || '';

    if (!checkRateLimit(ip)) {
        return res.status(429).json({ error: '登录尝试次数过多，请15分钟后再试' });
    }

    const { username, password } = req.body;

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
        res.status(500).json({ error: err.message });
    }
});

// 获取当前用户信息
router.get('/profile', (req, res, next) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: '未授权' });
    try {
        req.user = jwt.verify(token, process.env.JWT_SECRET);
        next();
    } catch (e) {
        res.status(401).json({ error: 'Token 无效' });
    }
}, async (req, res) => {
    try {
        const { rows } = await pool.query(
            'SELECT username, nickname, avatar, role, created_at FROM users WHERE username = $1',
            [req.user.username]
        );
        if (rows.length === 0) {
            return res.status(404).json({ error: '用户不存在' });
        }
        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 导出 ensureSetupToken 供启动时调用
export { ensureSetupToken };
export default router;
