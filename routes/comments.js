import express from 'express';
import fetch from 'node-fetch';
import crypto from 'crypto';
import { authMiddleware, requireRole } from '../lib/auth.js';
import { parsePage, parsePageSize } from '../lib/http.js';

const router = express.Router();

// JWT 认证中间件
router.use(authMiddleware);
router.use(requireRole('admin', 'editor'));

// Twikoo API 帮助函数
async function twikooApi(event, data = {}) {
    const twikooUrl = process.env.TWIKOO_URL;
    if (!twikooUrl) throw new Error('TWIKOO_URL 未配置');
    if (typeof twikooUrl !== 'string' || /[\u0000-\u001f\u007f\\]/.test(twikooUrl)) {
        throw new Error('TWIKOO_URL 配置无效');
    }
    let parsedUrl;
    try {
        parsedUrl = new URL(twikooUrl);
    } catch {
        throw new Error('TWIKOO_URL 配置无效');
    }
    if (parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
        throw new Error('TWIKOO_URL 不得包含凭据、查询参数或片段');
    }
    if (!parsedUrl.hostname) throw new Error('TWIKOO_URL 配置无效');
    const allowInsecure = process.env.ALLOW_INSECURE_TWIKOO === 'true';
    if (parsedUrl.protocol !== 'https:' && !(allowInsecure && parsedUrl.protocol === 'http:')) {
        throw new Error('TWIKOO_URL 必须使用 HTTPS');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    let response;
    try {
        response = await fetch(parsedUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ event, ...data }),
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timeout);
    }

    if (!response.ok) {
        throw new Error(`Twikoo API error: ${response.status}`);
    }

    const result = await response.json();
    if (!result || typeof result !== 'object') throw new Error('Twikoo API 响应无效');
    return result;
}

// 获取 Twikoo 管理 accessToken
async function getTwikooAccessToken() {
    const password = process.env.TWIKOO_PASSWORD;
    if (!password) throw new Error('TWIKOO_PASSWORD 未配置');

    // Twikoo 使用 md5 哈希密码
    const md5Hash = crypto.createHash('md5').update(password).digest('hex');

    const result = await twikooApi('LOGIN', { password: md5Hash });
    if (typeof result?.accessToken !== 'string' || !result.accessToken) {
        throw new Error('Twikoo 登录响应无效');
    }
    return result.accessToken;
}

// 获取评论列表
router.get('/', async (req, res) => {
    try {
        const { url } = req.query;
        const page = parsePage(req.query.page, 0);
        const pageSize = parsePageSize(req.query.pageSize, 20, 100);

        const accessToken = await getTwikooAccessToken();

        const params = {
            accessToken,
            per: parseInt(pageSize),
            page: parseInt(page),
        };

        if (url !== undefined) {
            if (typeof url !== 'string' || url.length > 2000) {
                return res.status(400).json({ error: '评论页面地址无效' });
            }
            params.url = url;
        }

        const result = await twikooApi('COMMENT_GET_FOR_ADMIN', params);

        const comments = Array.isArray(result.data) ? result.data : [];
        const count = Number.isSafeInteger(result.count) && result.count >= 0 ? result.count : comments.length;
        res.json({ comments, count });
    } catch (err) {
        // 如果 Twikoo 未配置，返回友好提示
        if (err.message.includes('未配置')) {
            return res.json({
                comments: [],
                count: 0,
                warning: err.message,
            });
        }
        console.error('获取评论失败:', err);
        res.status(502).json({ error: '评论服务暂时不可用' });
    }
});

// 回复评论
router.post('/reply', async (req, res) => {
    try {
        const { pid, url, comment, nick, mail } = req.body || {};

        if (typeof pid !== 'string' || !pid || pid.length > 256 || typeof comment !== 'string' || !comment.trim() || comment.length > 20_000) {
            return res.status(400).json({ error: '缺少必要参数' });
        }
        if (url !== undefined && (typeof url !== 'string' || url.length > 2000)) {
            return res.status(400).json({ error: '评论页面地址无效' });
        }
        if (nick !== undefined && (typeof nick !== 'string' || nick.length > 128)) {
            return res.status(400).json({ error: '昵称无效' });
        }
        if (mail !== undefined && (typeof mail !== 'string' || mail.length > 320)) {
            return res.status(400).json({ error: '邮箱无效' });
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
        console.error('回复评论失败:', err);
        res.status(502).json({ error: '评论服务暂时不可用' });
    }
});

// 删除评论
router.delete('/:id', async (req, res) => {
    try {
        const id = String(req.params.id || '');
        if (!id || id.length > 256) return res.status(400).json({ error: '评论 ID 无效' });
        const accessToken = await getTwikooAccessToken();

        const result = await twikooApi('COMMENT_DELETE_FOR_ADMIN', {
            accessToken,
            id,
        });

        res.json({ success: true, data: result });
    } catch (err) {
        console.error('删除评论失败:', err);
        res.status(502).json({ error: '评论服务暂时不可用' });
    }
});

// 标记评论为垃圾/非垃圾
router.post('/:id/spam', async (req, res) => {
    try {
        const id = String(req.params.id || '');
        if (!id || id.length > 256) return res.status(400).json({ error: '评论 ID 无效' });
        const accessToken = await getTwikooAccessToken();
        const { isSpam } = req.body || {};
        if (isSpam !== undefined && typeof isSpam !== 'boolean') {
            return res.status(400).json({ error: '垃圾标记参数无效' });
        }

        const result = await twikooApi('COMMENT_SET_SPAM_FOR_ADMIN', {
            accessToken,
            id,
            isSpam: isSpam ?? true,
        });

        res.json({ success: true, data: result });
    } catch (err) {
        console.error('标记评论失败:', err);
        res.status(502).json({ error: '评论服务暂时不可用' });
    }
});

export default router;
