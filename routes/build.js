import express from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { logAction } from '../lib/logger.js';

const router = express.Router();

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

let buildState = {
    building: false,
    lastBuild: null,
    lastResult: null,
    log: '',
    cdnRefreshing: false,
    cdnResult: null,
    cdnTaskId: null,
    cdnLog: '',
};

function stripAnsi(input = '') {
    return String(input).replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

async function dogeCloudApi(apiPath, data = {}) {
    const accessKey = process.env.DOGECLOUD_ACCESS_KEY;
    const secretKey = process.env.DOGECLOUD_SECRET_KEY;

    if (!accessKey || !secretKey) {
        throw new Error('DOGECLOUD_ACCESS_KEY 或 DOGECLOUD_SECRET_KEY 未配置');
    }

    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(data)) {
        if (Array.isArray(value)) {
            body.append(key, value.map((entry) => String(entry)).join(','));
        } else {
            body.append(key, String(value));
        }
    }
    const bodyStr = body.toString();

    const signStr = apiPath + '\n' + bodyStr;
    const sign = crypto
        .createHmac('sha1', secretKey)
        .update(Buffer.from(signStr, 'utf8'))
        .digest('hex');

    const response = await fetch('https://api.dogecloud.com' + apiPath, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: 'TOKEN ' + accessKey + ':' + sign,
        },
        body: bodyStr,
    });

    const result = await response.json();
    if (result.code !== 200) {
        throw new Error(`多吉云 API 错误: ${result.msg || result.err_code || '未知错误'}`);
    }

    return result.data;
}

function getAllPostUrls() {
    const siteUrl = process.env.SITE_URL;
    const blogDir = process.env.BLOG_DIR;
    if (!siteUrl || !blogDir) return [];

    const postsDir = path.join(blogDir, 'src', 'content', 'posts');
    const urls = [];

    function walk(dir, basePath = '') {
        if (!fs.existsSync(dir)) return;
        const items = fs.readdirSync(dir, { withFileTypes: true });
        for (const item of items) {
            const fullPath = path.join(dir, item.name);
            const relPath = basePath ? `${basePath}/${item.name}` : item.name;
            if (item.isDirectory()) {
                walk(fullPath, relPath);
            } else if (item.name.endsWith('.md') || item.name.endsWith('.mdx')) {
                const slug = relPath.replace(/\.(md|mdx)$/, '');
                const baseUrl = siteUrl.endsWith('/') ? siteUrl : siteUrl + '/';
                urls.push(encodeURI(`${baseUrl}posts/${slug}/`));
            }
        }
    }

    walk(postsDir);
    return urls;
}

router.post('/', async (req, res) => {
    if (buildState.building) {
        return res.status(409).json({ error: '正在构建中，请稍候' });
    }

    const blogDir = process.env.BLOG_DIR;
    if (!blogDir) {
        return res.status(500).json({ error: 'BLOG_DIR 未配置' });
    }

    const autoCdn = req.body.autoCdn !== false;

    buildState.building = true;
    buildState.log = '';
    buildState.lastResult = null;
    buildState.cdnRefreshing = false;
    buildState.cdnResult = null;
    buildState.cdnTaskId = null;
    buildState.cdnLog = '';

    const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    await logAction('触发构建', autoCdn ? '自动刷新 CDN' : '不刷新 CDN', req.user.username, ip);

    const isWindows = process.platform === 'win32';
    const cmd = isWindows ? 'pnpm.cmd' : 'pnpm';
    const build = spawn(cmd, ['build'], {
        cwd: blogDir,
        shell: true,
        env: {
            ...process.env,
            FORCE_COLOR: '0',
            NO_COLOR: '1',
            TERM: 'dumb',
            CI: '1',
        },
    });

    build.stdout.on('data', (data) => {
        buildState.log += stripAnsi(data.toString());
    });

    build.stderr.on('data', (data) => {
        buildState.log += stripAnsi(data.toString());
    });

    build.on('close', async (code) => {
        buildState.building = false;
        buildState.lastBuild = new Date().toISOString();
        buildState.lastResult = code === 0 ? 'success' : 'failed';

        if (code === 0) {
            await logAction('构建完成', '构建成功', req.user.username, ip);
        } else {
            await logAction('构建失败', `退出码: ${code}`, req.user.username, ip);
        }

        if (code === 0 && autoCdn) {
            await triggerCdnRefresh(req.user.username, ip);
        }
    });

    build.on('error', async (err) => {
        buildState.building = false;
        buildState.lastBuild = new Date().toISOString();
        buildState.lastResult = 'error';
        buildState.log += stripAnsi(`\nError: ${err.message}`);
        await logAction('构建错误', err.message, req.user.username, ip);
    });

    res.json({ success: true, message: '构建已启动' });
});

async function triggerCdnRefresh(username = 'system', ip = '') {
    const siteUrl = process.env.SITE_URL;
    const accessKey = process.env.DOGECLOUD_ACCESS_KEY;

    if (!siteUrl || !accessKey) {
        buildState.cdnLog = '跳过 CDN 刷新（SITE_URL 或多吉云密钥未配置）';
        buildState.cdnResult = 'skipped';
        return;
    }

    buildState.cdnRefreshing = true;
    buildState.cdnLog = '正在刷新 CDN 缓存…\n';

    try {
        const baseUrl = siteUrl.endsWith('/') ? siteUrl : siteUrl + '/';
        const postUrls = getAllPostUrls();
        const allUrls = [encodeURI(baseUrl), ...postUrls];

        buildState.cdnLog += `→ 提交刷新 ${allUrls.length} 个 URL:\n`;
        buildState.cdnLog += `  - ${baseUrl}\n`;
        if (postUrls.length > 0) {
            buildState.cdnLog += `  - ${postUrls.length} 篇文章 URL\n`;
        }

        const batchSize = 20;
        const totalTaskIds = [];

        for (let i = 0; i < allUrls.length; i += batchSize) {
            const batch = allUrls.slice(i, i + batchSize);
            const result = await dogeCloudApi('/cdn/refresh/add.json', {
                rtype: 'url',
                urls: batch,
            });
            if (result.task_id) totalTaskIds.push(result.task_id);
            buildState.cdnLog += `  ✓ 批次 ${Math.floor(i / batchSize) + 1}：已提交 ${batch.length} 个 URL\n`;
        }

        buildState.cdnTaskId = totalTaskIds[0] || null;
        buildState.cdnRefreshing = false;
        buildState.cdnResult = 'success';
        buildState.cdnLog += `\n✅ CDN 刷新任务已全部提交（共 ${allUrls.length} 个 URL）`;

        await logAction('CDN 刷新', `已提交 ${allUrls.length} 个 URL`, username, ip);
    } catch (err) {
        buildState.cdnRefreshing = false;
        buildState.cdnResult = 'failed';
        buildState.cdnLog += `\n❌ CDN 刷新失败: ${err.message}`;
        await logAction('CDN 刷新失败', err.message, username, ip);
    }
}

router.get('/status', (req, res) => {
    res.json({
        building: buildState.building,
        lastBuild: buildState.lastBuild,
        lastResult: buildState.lastResult,
        log: buildState.log,
        cdnRefreshing: buildState.cdnRefreshing,
        cdnResult: buildState.cdnResult,
        cdnTaskId: buildState.cdnTaskId,
        cdnLog: buildState.cdnLog,
    });
});

router.post('/cdn-refresh', async (req, res) => {
    if (buildState.cdnRefreshing) {
        return res.status(409).json({ error: '正在刷新 CDN 中，请稍候' });
    }
    const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    try {
        await triggerCdnRefresh(req.user.username, ip);
        res.json({ success: true, cdnResult: buildState.cdnResult, cdnLog: buildState.cdnLog });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/cdn-status', async (req, res) => {
    const taskId = req.query.id || buildState.cdnTaskId;
    if (!taskId) {
        return res.json({ tasks: [], message: '没有进行中的 CDN 任务' });
    }
    try {
        const data = await dogeCloudApi('/cdn/refresh/query.json', { id: taskId });
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
