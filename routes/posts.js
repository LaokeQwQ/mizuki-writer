import express from 'express';
import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';
import { logAction } from '../lib/logger.js';
import { authMiddleware, requireRole } from '../lib/auth.js';
import { getClientIp, sendInternalError } from '../lib/http.js';
import { renderSafeMarkdown } from '../lib/markdown.js';

const router = express.Router();
const MAX_POST_CONTENT_BYTES = 5 * 1024 * 1024;
const MAX_POST_FILE_BYTES = 10 * 1024 * 1024;

// JWT 认证中间件
router.use(authMiddleware);
router.use(requireRole('admin', 'editor'));

function getPostsDir() {
    const blogDir = process.env.BLOG_DIR;
    if (!blogDir) throw new Error('BLOG_DIR 未配置');
    return path.join(blogDir, 'src', 'content', 'posts');
}

function getAssetsDir() {
    const blogDir = process.env.BLOG_DIR;
    if (!blogDir) throw new Error('BLOG_DIR 未配置');
    return path.join(blogDir, 'src', 'assets');
}

// Normalize frontmatter dates
function normalizeFrontmatter(fm) {
    const result = { ...fm };
    if (result.published !== undefined && result.published !== null && result.published !== '') {
        if (typeof result.published !== 'string'
            && typeof result.published !== 'number'
            && !(result.published instanceof Date)) {
            throw new Error('published 日期格式无效');
        }
        const d = new Date(result.published);
        if (Number.isNaN(d.getTime())) throw new Error('published 日期格式无效');
        result.published = d;
    }
    return result;
}

// Auto-generate slug from title
function generateSlug(title) {
    if (typeof title !== 'string') throw new Error('title 必须是字符串');
    return title
        .toLowerCase()
        .replace(/[^\w\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        || `post-${Date.now()}`;
}

// 防止路径遍历攻击
function sanitizeSlug(slug) {
    if (typeof slug !== 'string' || !slug || slug.length > 256) return null;
    // 禁止 .. 和绝对路径
    const normalized = slug.replace(/\\/g, '/');
    if (normalized.includes('..') || path.isAbsolute(normalized)) return null;
    const segments = normalized.split('/');
    if (segments.some((segment) => !segment || segment === '.')) return null;
    // 只允许字母、数字、中文、日文、连字符、下划线、斜杠
    if (!/^[\w\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\-/]+$/.test(normalized)) return null;
    return normalized;
}

function isPathInside(basePath, targetPath) {
    const relative = path.relative(basePath, targetPath);
    return relative === ''
        || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function pathExists(filePath) {
    try {
        fs.lstatSync(filePath);
        return true;
    } catch {
        return false;
    }
}

function assertPostPathInside(postsDir, targetPath) {
    let realPostsDir;
    try {
        realPostsDir = fs.realpathSync(postsDir);
    } catch {
        throw new Error('文章目录不存在或路径不安全');
    }

    // Resolve the nearest existing ancestor so a symlink in a newly-created
    // nested path cannot redirect writes outside the posts directory.
    let existingPath = path.resolve(targetPath);
    while (!pathExists(existingPath)) {
        const parent = path.dirname(existingPath);
        if (parent === existingPath) throw new Error('文章路径不安全');
        existingPath = parent;
    }
    const realExistingPath = fs.realpathSync(existingPath);
    if (!isPathInside(realPostsDir, realExistingPath)) {
        throw new Error('文章路径不安全');
    }
}

function findPostFilePath(postsDir, slug) {
    const markdownPath = path.join(postsDir, `${slug}.md`);
    const mdxPath = path.join(postsDir, `${slug}.mdx`);
    let realPostsDir;
    try {
        realPostsDir = fs.realpathSync(postsDir);
    } catch {
        return null;
    }

    for (const candidate of [markdownPath, mdxPath]) {
        try {
            // lstat deliberately rejects symlinked article files. This keeps
            // reads, updates, and deletes confined to the managed tree.
            if (!fs.lstatSync(candidate).isFile()) continue;
            const realCandidate = fs.realpathSync(candidate);
            if (!isPathInside(realPostsDir, realCandidate)) continue;
            return candidate;
        } catch {
            // A file can disappear between the directory scan and this check.
        }
    }
    return null;
}

function writeFileAtomically(filePath, content) {
    const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    try {
        fs.writeFileSync(tempPath, content, 'utf-8');
        fs.renameSync(tempPath, filePath);
    } finally {
        try {
            if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        } catch {
            // Preserve the original write error if cleanup itself fails.
        }
    }
}

function ensureFrontmatterObject(value) {
    if (value === undefined || value === null) return {};
    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('frontmatter 必须是对象');
    }
    return value;
}

function validatePostFrontmatter(value, slug) {
    const result = { ...ensureFrontmatterObject(value) };
    for (const key of ['__proto__', 'prototype', 'constructor']) delete result[key];
    for (const field of ['title', 'description', 'category', 'image']) {
        if (result[field] !== undefined && typeof result[field] !== 'string') {
            throw new Error(`${field} 必须是字符串`);
        }
    }
    if (result.title !== undefined && Buffer.byteLength(result.title, 'utf8') > 500) throw new Error('title 长度不能超过 500');
    if (result.description !== undefined && Buffer.byteLength(result.description, 'utf8') > 5000) throw new Error('description 长度不能超过 5000');
    if (result.category !== undefined && Buffer.byteLength(result.category, 'utf8') > 200) throw new Error('category 长度不能超过 200');
    if (result.image !== undefined && Buffer.byteLength(result.image, 'utf8') > 2000) throw new Error('image 长度不能超过 2000');
    if (result.image !== undefined && !isSafeImageReference(result.image)) {
        throw new Error('image 图片地址无效');
    }
    if (result.tags !== undefined) {
        if (!Array.isArray(result.tags) || result.tags.length > 100 || result.tags.some((tag) => typeof tag !== 'string' || Buffer.byteLength(tag, 'utf8') > 100)) {
            throw new Error('tags 格式无效');
        }
        result.tags = result.tags.map((tag) => tag.trim()).filter(Boolean);
    }
    for (const field of ['draft', 'pinned', 'comment']) {
        if (result[field] !== undefined && typeof result[field] !== 'boolean') {
            throw new Error(`${field} 必须是布尔值`);
        }
    }
    if (result.published === undefined || result.published === null || result.published === '') {
        result.published = new Date();
    }
    if (!result.title) result.title = slug;
    try {
        if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 256 * 1024) {
            throw new Error('frontmatter 内容不能超过 256KB');
        }
    } catch (error) {
        if (error.message === 'frontmatter 内容不能超过 256KB') throw error;
        throw new Error('frontmatter 格式无效');
    }
    return normalizeFrontmatter(result);
}

function ensurePostContent(value) {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') throw new Error('content 必须是字符串');
    if (Buffer.byteLength(value, 'utf8') > MAX_POST_CONTENT_BYTES) {
        throw new Error('content 不能超过 5MB');
    }
    return value;
}

function isSafeImageReference(value) {
    if (typeof value !== 'string' || /[\u0000-\u001f\u007f\\]/.test(value)) return false;
    const url = value.trim();
    if (!url) return true;
    if (url.startsWith('//')) return false;
    if (url.startsWith('/') || url.startsWith('./') || url.startsWith('../')) return true;
    try {
        const parsed = new URL(url);
        return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
            && !parsed.username && !parsed.password;
    } catch {
        return false;
    }
}

// 递归获取所有 .md 文件
function getAllMdFiles(dir, basePath = '', depth = 0) {
    const results = [];
    if (depth > 20) throw new Error('文章目录嵌套层级过深');
    if (!fs.existsSync(dir)) return results;
    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
        const fullPath = path.join(dir, item.name);
        const relPath = basePath ? `${basePath}/${item.name}` : item.name;
        if (item.isDirectory()) {
            results.push(...getAllMdFiles(fullPath, relPath, depth + 1));
            if (results.length > 10_000) throw new Error('文章数量超出限制');
        } else if (item.isFile() && (item.name.endsWith('.md') || item.name.endsWith('.mdx'))) {
            results.push({ fullPath, relPath });
            if (results.length > 10_000) throw new Error('文章数量超出限制');
        }
    }
    return results;
}

// 获取所有文章列表
router.get('/', (req, res) => {
    try {
        const postsDir = getPostsDir();
        const files = getAllMdFiles(postsDir);
        const posts = files.map(({ fullPath, relPath }) => {
            const stats = fs.statSync(fullPath);
            if (stats.size > MAX_POST_FILE_BYTES) throw new Error('文章文件过大');
            const content = fs.readFileSync(fullPath, 'utf-8');
            const { data } = matter(content);
            const slug = relPath.replace(/\.(md|mdx)$/, '');
            return {
                slug,
                filename: relPath,
                title: typeof data.title === 'string' && data.title ? data.title : slug,
                published: data.published || null,
                description: typeof data.description === 'string' ? data.description : '',
                tags: Array.isArray(data.tags) ? data.tags.filter((tag) => typeof tag === 'string') : [],
                category: typeof data.category === 'string' ? data.category : '',
                draft: data.draft === true,
                pinned: data.pinned === true,
                image: typeof data.image === 'string' ? data.image : '',
                comment: data.comment !== false,
                lastModified: stats.mtime,
            };
        });

        posts.sort((a, b) => {
            if (!a.published) return 1;
            if (!b.published) return -1;
            return new Date(b.published) - new Date(a.published);
        });

        res.json({ posts, total: posts.length });
    } catch (err) {
        sendInternalError(res, err, '获取文章列表失败');
    }
});

// 获取所有分类和标签
router.get('/meta/tags-categories', (req, res) => {
    try {
        const postsDir = getPostsDir();
        const files = getAllMdFiles(postsDir);
        const tagsSet = new Set();
        const categoriesSet = new Set();

        for (const { fullPath } of files) {
            if (fs.statSync(fullPath).size > MAX_POST_FILE_BYTES) {
                return res.status(413).json({ error: '文章文件过大' });
            }
            const raw = fs.readFileSync(fullPath, 'utf-8');
            const { data } = matter(raw);
            if (Array.isArray(data.tags)) {
                data.tags.forEach((tag) => {
                    if (typeof tag === 'string' && tag.length <= 500) tagsSet.add(tag);
                });
            }
            if (typeof data.category === 'string' && data.category.length <= 500) categoriesSet.add(data.category);
        }

        res.json({
            tags: [...tagsSet].sort(),
            categories: [...categoriesSet].sort(),
        });
    } catch (err) {
        sendInternalError(res, err, '获取文章元数据失败');
    }
});

// 获取单篇文章
router.get('/:slug(*)', (req, res) => {
    try {
        const postsDir = getPostsDir();
        const slug = sanitizeSlug(req.params.slug);
        if (!slug) return res.status(400).json({ error: 'slug 格式无效' });

        const filePath = findPostFilePath(postsDir, slug);
        if (!filePath) {
            return res.status(404).json({ error: '文章不存在' });
        }

        const stats = fs.statSync(filePath);
        if (stats.size > MAX_POST_FILE_BYTES) return res.status(413).json({ error: '文章文件过大' });
        const raw = fs.readFileSync(filePath, 'utf-8');
        const { data, content } = matter(raw);

        res.json({
            slug,
            frontmatter: data,
            content,
            raw,
        });
    } catch (err) {
        sendInternalError(res, err, '获取文章详情失败');
    }
});

// 创建新文章
router.post('/', async (req, res) => {
    try {
        const postsDir = getPostsDir();
        let { slug, frontmatter, content } = req.body || {};
        frontmatter = ensureFrontmatterObject(frontmatter);
        content = ensurePostContent(content);

        if (!slug && frontmatter?.title) {
            slug = generateSlug(frontmatter.title);
        }
        if (!slug) return res.status(400).json({ error: '文章 slug 不能为空' });
        slug = sanitizeSlug(slug);
        if (!slug) return res.status(400).json({ error: 'slug 格式无效' });

        const filePath = path.join(postsDir, `${slug}.md`);
        const mdxPath = path.join(postsDir, `${slug}.mdx`);

        const dir = path.dirname(filePath);
        if (!fs.existsSync(postsDir)) {
            fs.mkdirSync(postsDir, { recursive: true });
        }
        if (!fs.statSync(postsDir).isDirectory()) {
            throw new Error('文章目录不存在或不是目录');
        }
        assertPostPathInside(postsDir, dir);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        assertPostPathInside(postsDir, dir);

        if (fs.existsSync(filePath) || fs.existsSync(mdxPath)) {
            return res.status(400).json({ error: '同名文章已存在' });
        }

        const fm = validatePostFrontmatter({
            ...frontmatter,
            title: frontmatter.title ?? slug,
            published: frontmatter.published ?? new Date(),
            description: frontmatter.description ?? '',
            tags: frontmatter.tags ?? [],
            category: frontmatter.category ?? '',
            draft: frontmatter.draft ?? true,
            pinned: frontmatter.pinned ?? false,
            comment: frontmatter.comment ?? true,
        }, slug);

        const fileContent = matter.stringify(content, fm);
        try {
            fs.writeFileSync(filePath, fileContent, { encoding: 'utf-8', flag: 'wx' });
        } catch (error) {
            if (error.code === 'EEXIST') return res.status(409).json({ error: '同名文章已存在' });
            throw error;
        }

        const ip = getClientIp(req);
        await logAction('创建文章', `标题: ${fm.title} (${slug})`, req.user.username, ip);

        res.json({ success: true, slug });
    } catch (err) {
        if (/^(?:frontmatter|content|published|title|description|category|image|tags|draft|pinned|comment) /.test(err.message)) {
            return res.status(400).json({ error: err.message });
        }
        sendInternalError(res, err, '创建文章失败');
    }
});

// 更新文章
router.put('/:slug(*)', async (req, res) => {
    try {
        const postsDir = getPostsDir();
        const slug = sanitizeSlug(req.params.slug);
        if (!slug) return res.status(400).json({ error: 'slug 格式无效' });
        const { frontmatter, content } = req.body || {};
        const incomingFm = ensureFrontmatterObject(frontmatter);

        const filePath = findPostFilePath(postsDir, slug);
        if (!filePath) {
            return res.status(404).json({ error: '文章不存在' });
        }

        if (fs.statSync(filePath).size > MAX_POST_FILE_BYTES) {
            return res.status(413).json({ error: '文章文件过大' });
        }
        const existing = matter(fs.readFileSync(filePath, 'utf-8'));
        const postContent = content === undefined ? existing.content : ensurePostContent(content);
        const normalizedFm = validatePostFrontmatter({ ...existing.data, ...incomingFm }, slug);
        const fileContent = matter.stringify(postContent, normalizedFm);
        writeFileAtomically(filePath, fileContent);

        const ip = getClientIp(req);
        await logAction('编辑文章', `标题: ${normalizedFm.title || slug} (${slug})`, req.user.username, ip);

        res.json({ success: true, slug });
    } catch (err) {
        if (/^(?:frontmatter|content|published|title|description|category|image|tags|draft|pinned|comment) /.test(err.message)) {
            return res.status(400).json({ error: err.message });
        }
        sendInternalError(res, err, '编辑文章失败');
    }
});

// 删除文章
router.delete('/:slug(*)', async (req, res) => {
    try {
        const postsDir = getPostsDir();
        const slug = sanitizeSlug(req.params.slug);
        if (!slug) return res.status(400).json({ error: 'slug 格式无效' });

        const filePath = findPostFilePath(postsDir, slug);
        if (!filePath) {
            return res.status(404).json({ error: '文章不存在' });
        }

        fs.unlinkSync(filePath);

        const ip = getClientIp(req);
        await logAction('删除文章', slug, req.user.username, ip);

        res.json({ success: true });
    } catch (err) {
        sendInternalError(res, err, '删除文章失败');
    }
});

// 批量删除文章
router.post('/batch-delete', async (req, res) => {
    try {
        const postsDir = getPostsDir();
        const { slugs } = req.body || {};

        if (!slugs || !Array.isArray(slugs) || slugs.length === 0) {
            return res.status(400).json({ error: '请选择要删除的文章' });
        }
        if (slugs.length > 100) {
            return res.status(400).json({ error: '一次最多删除 100 篇文章' });
        }

        const deleted = [];
        const errors = [];

        for (const rawSlug of slugs) {
            const slug = sanitizeSlug(rawSlug);
            if (!slug) { errors.push(`${rawSlug}: slug 格式无效`); continue; }
            const filePath = findPostFilePath(postsDir, slug);
            if (!filePath) {
                errors.push(`${slug}: 文件不存在`);
                continue;
            }
            try {
                fs.unlinkSync(filePath);
                deleted.push(slug);
            } catch (e) {
                console.error(`删除文章失败 (${slug}):`, e);
                errors.push(`${slug}: 文件删除失败`);
            }
        }

        const ip = getClientIp(req);
        await logAction('批量删除文章', `已删除 ${deleted.length} 篇: ${deleted.join(', ')}`, req.user.username, ip);

        res.json({ success: true, deleted, errors });
    } catch (err) {
        sendInternalError(res, err, '批量删除文章失败');
    }
});

// Markdown 预览
router.post('/preview', (req, res) => {
    try {
        const { content } = req.body || {};
        if (typeof content !== 'string') return res.status(400).json({ error: 'content 必须是字符串' });
        if (Buffer.byteLength(content, 'utf8') > 1 * 1024 * 1024) {
            return res.status(413).json({ error: '预览内容不能超过 1MB' });
        }
        const html = renderSafeMarkdown(content);
        res.json({ html });
    } catch (err) {
        sendInternalError(res, err, 'Markdown 预览失败');
    }
});

export default router;
export { sanitizeSlug, findPostFilePath };
