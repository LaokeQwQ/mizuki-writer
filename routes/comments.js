import express from 'express';
import jwt from 'jsonwebtoken';
import fetch from 'node-fetch';
import crypto from 'crypto';

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

// Twikoo API 帮助函数
async function twikooApi(event, data = {}) {
    const twikooUrl = process.env.TWIKOO_URL;
    if (!twikooUrl) throw new Error('TWIKOO_URL 未配置');

    const response = await fetch(twikooUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event, ...data }),
    });

    if (!response.ok) {
        throw new Error(`Twikoo API error: ${response.status}`);
    }

    return response.json();
}

// 获取 Twikoo 管理 accessToken
async function getTwikooAccessToken() {
    const password = process.env.TWIKOO_PASSWORD;
    if (!password) throw new Error('TWIKOO_PASSWORD 未配置');

    // Twikoo 使用 md5 哈希密码
    const md5Hash = crypto.createHash('md5').update(password).digest('hex');

    const result = await twikooApi('LOGIN', { password: md5Hash });
    return result.accessToken;
}

// 获取评论列表
router.get('/', async (req, res) => {
    try {
        const { page = 0, pageSize = 20, url } = req.query;

        const accessToken = await getTwikooAccessToken();

        const params = {
            accessToken,
            per: parseInt(pageSize),
            page: parseInt(page),
        };

        if (url) {
            params.url = url;
        }

        const result = await twikooApi('COMMENT_GET_FOR_ADMIN', params);

        res.json({
            comments: result.data || [],
            count: result.count || 0,
        });
    } catch (err) {
        // 如果 Twikoo 未配置，返回友好提示
        if (err.message.includes('未配置')) {
            return res.json({
                comments: [],
                count: 0,
                warning: err.message,
            });
        }
        res.status(500).json({ error: err.message });
    }
});

// 回复评论
router.post('/reply', async (req, res) => {
    try {
        const { pid, url, comment, nick, mail } = req.body;

        if (!pid || !comment) {
            return res.status(400).json({ error: '缺少必要参数' });
        }

        const adminNick = nick || process.env.ADMIN_USERNAME || 'Admin';

        const result = await twikooApi('COMMENT_SUBMIT', {
            pid,
            url: url || '/',
            comment,
            nick: adminNick,
            mail: mail || '',
            ua: 'Mizuki Admin',
        });

        res.json({ success: true, data: result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 删除评论
router.delete('/:id', async (req, res) => {
    try {
        const accessToken = await getTwikooAccessToken();

        const result = await twikooApi('COMMENT_DELETE_FOR_ADMIN', {
            accessToken,
            id: req.params.id,
        });

        res.json({ success: true, data: result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 标记评论为垃圾/非垃圾
router.post('/:id/spam', async (req, res) => {
    try {
        const accessToken = await getTwikooAccessToken();
        const { isSpam } = req.body;

        const result = await twikooApi('COMMENT_SET_SPAM_FOR_ADMIN', {
            accessToken,
            id: req.params.id,
            isSpam: isSpam ?? true,
        });

        res.json({ success: true, data: result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
