import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import pool from '../lib/db.js';
import { getLogs, getLoginHistory } from '../lib/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const router = express.Router();

// JWT 认证中间件
function authMiddleware(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: '未授权' });
    try {
        req.user = jwt.verify(token, process.env.JWT_SECRET);
        next();
    } catch (e) {
        res.status(401).json({ error: 'Token 无效' });
    }
}

router.use(authMiddleware);

// ─── 头像上传配置 ───────────────────────
const uploadsDir = path.join(__dirname, '..', 'public', 'uploads', 'avatars');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
        const safeName = req.user.username.replace(/[^a-zA-Z0-9_-]/g, '_');
        const ext = path.extname(file.originalname).toLowerCase() || '.png';
        cb(null, `${safeName}${ext}`);
    },
});

const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
    fileFilter: (req, file, cb) => {
        const allowed = /\.(jpg|jpeg|png|gif|webp|svg)$/i;
        if (allowed.test(path.extname(file.originalname))) {
            cb(null, true);
        } else {
            cb(new Error('只支持 jpg/png/gif/webp/svg 格式'));
        }
    },
});

// ─── 用户管理 ───────────────────────────

// 获取用户列表
router.get('/users', async (req, res) => {
    try {
        const { rows } = await pool.query(
            'SELECT id, username, nickname, avatar, role, created_at FROM users ORDER BY created_at ASC'
        );
        res.json({ users: rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 新增用户
router.post('/users', async (req, res) => {
    try {
        const { username, nickname, password, role } = req.body;
        if (!username || !password) {
            return res.status(400).json({ error: '用户名和密码不能为空' });
        }
        if (!/^[a-zA-Z0-9_\-]{2,32}$/.test(username)) {
            return res.status(400).json({ error: '用户名只能包含字母、数字、下划线和连字符，2-32 位' });
        }
        if (password.length < 6) {
            return res.status(400).json({ error: '密码至少6位' });
        }

        const hash = await bcrypt.hash(password, 12);
        await pool.query(
            'INSERT INTO users (username, nickname, password_hash, role) VALUES ($1, $2, $3, $4)',
            [username, nickname || username, hash, role || 'admin']
        );

        res.json({ success: true });
    } catch (err) {
        if (err.code === '23505') {
            return res.status(400).json({ error: '用户名已存在' });
        }
        res.status(500).json({ error: err.message });
    }
});

// 删除用户
router.delete('/users/:username', async (req, res) => {
    try {
        const targetUsername = req.params.username;

        // 不能删除自己
        if (targetUsername === req.user.username) {
            return res.status(400).json({ error: '不能删除当前登录的用户' });
        }

        const result = await pool.query('DELETE FROM users WHERE username = $1', [targetUsername]);
        if (result.rowCount === 0) {
            return res.status(404).json({ error: '用户不存在' });
        }

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── 头像上传 ───────────────────────────
router.post('/avatar', upload.single('avatar'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: '请选择头像文件' });
        }
        const avatarUrl = `/uploads/avatars/${req.file.filename}`;
        await pool.query('UPDATE users SET avatar = $1 WHERE username = $2', [avatarUrl, req.user.username]);
        res.json({ success: true, avatar: avatarUrl });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── 日志查询 ───────────────────────────

// 操作日志
router.get('/logs', async (req, res) => {
    try {
        const page = parseInt(req.query.page || '0');
        const pageSize = parseInt(req.query.pageSize || '30');
        const data = await getLogs(page, pageSize);
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 登录历史
router.get('/login-history', async (req, res) => {
    try {
        const page = parseInt(req.query.page || '0');
        const pageSize = parseInt(req.query.pageSize || '30');
        const data = await getLoginHistory(page, pageSize);
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
