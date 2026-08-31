import express from 'express';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import pool from '../lib/db.js';
import { getLogs, getLoginHistory, logAction } from '../lib/logger.js';
import { authMiddleware, requireRole, VALID_ROLES } from '../lib/auth.js';
import { getClientIp, parsePage, parsePageSize, sendInternalError } from '../lib/http.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const router = express.Router();

function isValidPassword(password) {
    return typeof password === 'string'
        && password.length >= 6
        && Buffer.byteLength(password, 'utf8') <= 72;
}

// JWT 认证中间件
router.use(authMiddleware);
router.use(requireRole('admin'));

// ─── 头像上传配置 ───────────────────────
const uploadsDir = path.join(__dirname, '..', 'public', 'uploads', 'avatars');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
        const safeName = req.user.username.replace(/[^a-zA-Z0-9_-]/g, '_');
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, `${safeName}${ext}`);
    },
});

const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
    fileFilter: (req, file, cb) => {
        const allowed = /\.(jpg|jpeg|png|gif|webp)$/i;
        const allowedMimeTypes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
        if (allowed.test(path.extname(file.originalname)) && allowedMimeTypes.has(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('只支持 jpg/png/gif/webp 格式'));
        }
    },
});

function removeUploadedFile(filePath) {
    if (!filePath) return;
    try {
        fs.unlinkSync(filePath);
    } catch {
        // The upload may already have been removed; keep the original error.
    }
}

// ─── 用户管理 ───────────────────────────

// 获取用户列表
router.get('/users', async (req, res) => {
    try {
        const { rows } = await pool.query(
            'SELECT id, username, nickname, avatar, role, created_at FROM users ORDER BY created_at ASC'
        );
        res.json({ users: rows });
    } catch (err) {
        sendInternalError(res, err, '获取用户列表失败');
    }
});

// 新增用户
router.post('/users', async (req, res) => {
    try {
        const { username, nickname, password, role } = req.body || {};
        if (typeof username !== 'string' || !username || typeof password !== 'string' || !password) {
            return res.status(400).json({ error: '用户名和密码不能为空' });
        }
        if (!/^[a-zA-Z0-9_\-]{2,32}$/.test(username)) {
            return res.status(400).json({ error: '用户名只能包含字母、数字、下划线和连字符，2-32 位' });
        }
        if (!isValidPassword(password)) {
            return res.status(400).json({ error: '密码长度需为 6-72 字节' });
        }
        if (nickname !== undefined && (typeof nickname !== 'string' || nickname.length > 64)) {
            return res.status(400).json({ error: '昵称长度无效' });
        }
        const normalizedRole = role === undefined ? 'admin' : role;
        if (!VALID_ROLES.has(normalizedRole)) {
            return res.status(400).json({ error: '用户角色无效' });
        }

        const hash = await bcrypt.hash(password, 12);
        await pool.query(
            'INSERT INTO users (username, nickname, password_hash, role) VALUES ($1, $2, $3, $4)',
            [username, nickname || username, hash, normalizedRole]
        );
        await logAction('新增用户', username, req.user.username, getClientIp(req));

        res.json({ success: true });
    } catch (err) {
        if (err.code === '23505') {
            return res.status(400).json({ error: '用户名已存在' });
        }
        sendInternalError(res, err, '新增用户失败');
    }
});

// 删除用户
router.delete('/users/:username', async (req, res) => {
    try {
        const targetUsername = req.params.username;
        if (typeof targetUsername !== 'string' || !targetUsername || targetUsername.length > 64) {
            return res.status(400).json({ error: '用户名格式无效' });
        }

        // 不能删除自己
        if (targetUsername === req.user.username) {
            return res.status(400).json({ error: '不能删除当前登录的用户' });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const targetResult = await client.query('SELECT role FROM users WHERE username = $1 FOR UPDATE', [targetUsername]);
            if (targetResult.rowCount === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: '用户不存在' });
            }
            if (targetResult.rows[0].role === 'admin') {
                const adminRows = await client.query("SELECT id FROM users WHERE role = 'admin' FOR UPDATE");
                if (adminRows.rowCount <= 1) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ error: '不能删除最后一个管理员' });
                }
            }
            await client.query('DELETE FROM users WHERE username = $1', [targetUsername]);
            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            client.release();
        }

        await logAction('删除用户', targetUsername, req.user.username, getClientIp(req));
        res.json({ success: true });
    } catch (err) {
        sendInternalError(res, err, '删除用户失败');
    }
});

// ─── 头像上传 ───────────────────────────
router.post('/avatar', upload.single('avatar'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: '请选择头像文件' });
        }

        const header = fs.readFileSync(req.file.path).subarray(0, 12);
        const isJpeg = header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
        const isPng = header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        const isGif = header.subarray(0, 6).toString('ascii') === 'GIF87a' || header.subarray(0, 6).toString('ascii') === 'GIF89a';
        const isWebp = header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WEBP';
        if (!isJpeg && !isPng && !isGif && !isWebp) {
            removeUploadedFile(req.file.path);
            return res.status(400).json({ error: '头像文件内容无效' });
        }
        const avatarUrl = `/uploads/avatars/${req.file.filename}`;
        await pool.query('UPDATE users SET avatar = $1 WHERE username = $2', [avatarUrl, req.user.username]);
        res.json({ success: true, avatar: avatarUrl });
    } catch (err) {
        removeUploadedFile(req.file?.path);
        sendInternalError(res, err, '上传头像失败');
    }
});

// ─── 日志查询 ───────────────────────────

// 操作日志
router.get('/logs', async (req, res) => {
    try {
        const page = parsePage(req.query.page, 0);
        const pageSize = parsePageSize(req.query.pageSize, 30, 100);
        const data = await getLogs(page, pageSize);
        res.json(data);
    } catch (err) {
        sendInternalError(res, err, '获取操作日志失败');
    }
});

// 登录历史
router.get('/login-history', async (req, res) => {
    try {
        const page = parsePage(req.query.page, 0);
        const pageSize = parsePageSize(req.query.pageSize, 30, 100);
        const data = await getLoginHistory(page, pageSize);
        res.json(data);
    } catch (err) {
        sendInternalError(res, err, '获取登录历史失败');
    }
});

export default router;
