import express from 'express';
import crypto from 'crypto';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { logAction } from '../lib/logger.js';
import { authMiddleware, requireRole } from '../lib/auth.js';
import { getClientIp, sendInternalError } from '../lib/http.js';

const router = express.Router();

router.use(authMiddleware);
router.use(requireRole('admin', 'editor'));

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

const MAX_BUILD_LOG_LENGTH = 1_000_000;
const MAX_CDN_URLS = 10_000;
const MAX_POST_DIRECTORY_DEPTH = 20;
const BUILD_TIMEOUT_MS = 15 * 60 * 1000;

function stripAnsi(input = '') {
    return String(input).replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

function appendBuildLog(value) {
    buildState.log = `${buildState.log}${stripAnsi(value)}`;
    if (buildState.log.length > MAX_BUILD_LOG_LENGTH) {
        buildState.log = buildState.log.slice(-MAX_BUILD_LOG_LENGTH);
    }
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

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    let response;
    try {
        response = await fetch('https://api.dogecloud.com' + apiPath, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Authorization: 'TOKEN ' + accessKey + ':' + sign,
            },
            body: bodyStr,
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timeout);
    }

    if (!response.ok) throw new Error(`多吉云 API HTTP 错误: ${response.status}`);
    const result = await response.json();
    if (!result || typeof result !== 'object') throw new Error('多吉云 API 响应无效');
    if (result.code !== 200) {
        throw new Error(`多吉云 API 错误: ${result.msg || result.err_code || '未知错误'}`);
    }

    return result.data || {};
}

function normalizeSiteUrl(value, allowInsecure = false) {
    if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f\\]/.test(value)) {
        throw new Error('SITE_URL 配置无效');
    }
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'https:' && !(allowInsecure && parsed.protocol === 'http:')) {
        throw new Error('SITE_URL 必须使用 HTTPS');
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new Error('SITE_URL 不得包含凭据、查询参数或片段');
    }
    if (!parsed.hostname) throw new Error('SITE_URL 配置无效');
    if (!parsed.pathname.endsWith('/')) parsed.pathname += '/';
    return parsed;
}

function normalizeTaskId(value) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
    if (typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(value)) return value;
    return null;
}

function getAllPostUrls(baseUrl) {
    const blogDir = process.env.BLOG_DIR;
    if (!baseUrl || !blogDir) return [];

    const postsDir = path.join(blogDir, 'src', 'content', 'posts');
    const urls = [];

    function walk(dir, basePath = '', depth = 0) {
        if (depth > MAX_POST_DIRECTORY_DEPTH) {
            throw new Error('文章目录嵌套层级过深');
        }
        if (urls.length >= MAX_CDN_URLS - 1 || !fs.existsSync(dir)) return true;
        const items = fs.readdirSync(dir, { withFileTypes: true });
        for (const item of items) {
            if (urls.length >= MAX_CDN_URLS - 1) return true;
            const fullPath = path.join(dir, item.name);
            const relPath = basePath ? `${basePath}/${item.name}` : item.name;
            if (item.isDirectory()) {
                if (walk(fullPath, relPath, depth + 1)) return true;
            } else if (item.isFile() && (item.name.endsWith('.md') || item.name.endsWith('.mdx'))) {
                const slug = relPath.replace(/\.(md|mdx)$/, '');
                const encodedSlug = slug.split('/').map((segment) => encodeURIComponent(segment)).join('/');
                urls.push(new URL(`posts/${encodedSlug}/`, baseUrl).toString());
            }
        }
        return false;
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
    if (!fs.existsSync(blogDir) || !fs.statSync(blogDir).isDirectory()) {
        return res.status(500).json({ error: 'BLOG_DIR 不存在或不是目录' });
    }
    if (req.body?.autoCdn !== undefined && typeof req.body.autoCdn !== 'boolean') {
        return res.status(400).json({ error: 'autoCdn 必须是布尔值' });
    }

    const autoCdn = req.body?.autoCdn !== false;

    buildState.building = true;
    buildState.log = '';
    buildState.lastResult = null;
    buildState.cdnRefreshing = false;
    buildState.cdnResult = null;
    buildState.cdnTaskId = null;
    buildState.cdnLog = '';

    const ip = getClientIp(req);
    await logAction('触发构建', autoCdn ? '自动刷新 CDN' : '不刷新 CDN', req.user.username, ip);

    const isWindows = process.platform === 'win32';
    const cmd = isWindows ? 'pnpm.cmd' : 'pnpm';
    const buildEnvironment = Object.fromEntries(
        [
            'PATH', 'Path', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PNPM_HOME',
            'NODE_ENV', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR',
            'HOMEDRIVE', 'HOMEPATH', 'OS',
        ]
            .map((key) => [key, process.env[key]])
            .filter(([, value]) => value !== undefined),
    );
    for (const [key, value] of Object.entries(process.env)) {
        if (/^(?:PUBLIC_|VITE_|ASTRO_)/.test(key) && value !== undefined) {
            buildEnvironment[key] = value;
        }
    }
    Object.assign(buildEnvironment, {
        FORCE_COLOR: '0',
        NO_COLOR: '1',
        TERM: 'dumb',
        CI: '1',
    });

    let build;
    try {
        build = spawn(cmd, ['build'], {
            cwd: blogDir,
            // Windows .cmd launchers require a shell; command and arguments are fixed here.
            shell: isWindows,
            env: buildEnvironment,
        });
    } catch (error) {
        buildState.building = false;
        buildState.lastBuild = new Date().toISOString();
        buildState.lastResult = 'error';
        appendBuildLog('\n无法启动构建进程。');
        await logAction('构建错误', '构建进程无法启动', req.user.username, ip);
        console.error('无法启动构建进程:', error);
        return res.status(500).json({ error: '无法启动构建进程' });
    }

    build.stdout.on('data', (data) => {
        appendBuildLog(data.toString());
    });

    build.stderr.on('data', (data) => {
        appendBuildLog(data.toString());
    });

    let completed = false;
    let forceKillTimer = null;
    const timeout = setTimeout(() => {
        appendBuildLog(`\n构建超过 ${Math.round(BUILD_TIMEOUT_MS / 60000)} 分钟，已终止。`);
        build.kill('SIGTERM');
        forceKillTimer = setTimeout(() => {
            if (!completed) build.kill('SIGKILL');
        }, 5000);
    }, BUILD_TIMEOUT_MS);

    const completeBuild = async (code, error = null) => {
        if (completed) return;
        completed = true;
        clearTimeout(timeout);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        buildState.lastBuild = new Date().toISOString();
        buildState.lastResult = error ? 'error' : code === 0 ? 'success' : 'failed';

        try {
            if (error) {
                appendBuildLog(`\nError: ${error.message}`);
                await logAction('构建错误', '构建进程启动或运行失败', req.user.username, ip);
            } else if (code === 0) {
                await logAction('构建完成', '构建成功', req.user.username, ip);
            } else {
                await logAction('构建失败', `退出码: ${code}`, req.user.username, ip);
            }

            if (code === 0 && autoCdn) {
                await triggerCdnRefresh(req.user.username, ip);
            }
        } catch (completionError) {
            console.error('完成构建后处理失败:', completionError);
            buildState.lastResult = 'error';
            appendBuildLog('\n构建完成后处理失败。');
        } finally {
            buildState.building = false;
        }
    };

    build.on('close', (code) => { void completeBuild(code); });
    build.on('error', (err) => { void completeBuild(null, err); });

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
        const parsedSiteUrl = normalizeSiteUrl(siteUrl, process.env.ALLOW_INSECURE_SITE_URL === 'true');
        const baseUrl = parsedSiteUrl.toString();
        const postUrls = getAllPostUrls(baseUrl);
        const allUrls = [baseUrl, ...postUrls];
        if (allUrls.length > MAX_CDN_URLS) throw new Error('待刷新的 URL 数量超出限制');

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
            const taskId = normalizeTaskId(result.task_id);
            if (taskId) totalTaskIds.push(taskId);
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
        buildState.cdnLog += '\n❌ CDN 刷新失败，请检查服务端日志';
        await logAction('CDN 刷新失败', 'CDN API 请求失败', username, ip);
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
    if (buildState.building) {
        return res.status(409).json({ error: '构建完成前不能刷新 CDN' });
    }
    if (buildState.cdnRefreshing) {
        return res.status(409).json({ error: '正在刷新 CDN 中，请稍候' });
    }
    const ip = getClientIp(req);
    try {
        await triggerCdnRefresh(req.user.username, ip);
        res.json({ success: true, cdnResult: buildState.cdnResult, cdnLog: buildState.cdnLog });
    } catch (err) {
        sendInternalError(res, err, '刷新 CDN 失败');
    }
});

router.get('/cdn-status', async (req, res) => {
    const requestedTaskId = req.query.id;
    if (requestedTaskId !== undefined && normalizeTaskId(requestedTaskId) === null) {
        return res.status(400).json({ error: 'CDN 任务 ID 无效' });
    }
    const taskId = requestedTaskId === undefined
        ? buildState.cdnTaskId
        : normalizeTaskId(requestedTaskId);
    if (!taskId) {
        return res.json({ tasks: [], message: '没有进行中的 CDN 任务' });
    }
    try {
        const data = await dogeCloudApi('/cdn/refresh/query.json', { id: taskId });
        res.json(data);
    } catch (err) {
        console.error('查询 CDN 状态失败:', err);
        res.status(502).json({ error: 'CDN 服务暂时不可用' });
    }
});

export default router;
