import express from 'express';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';
import { marked } from 'marked';
import { logAction } from '../lib/logger.js';

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
    if (result.published) {
        const d = new Date(result.published);
        if (!isNaN(d.getTime())) result.published = d;
    }
    return result;
}

// Auto-generate slug from title
function generateSlug(title) {
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
    if (!slug) return null;
    // 禁止 .. 和绝对路径
    const normalized = slug.replace(/\\/g, '/');
    if (normalized.includes('..') || path.isAbsolute(normalized)) return null;
    // 只允许字母、数字、中文、日文、连字符、下划线、斜杠
    if (!/^[\w\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\-/]+$/.test(normalized)) return null;
    return normalized;
}

// 递归获取所有 .md 文件
function getAllMdFiles(dir, basePath = '') {
    const results = [];
    if (!fs.existsSync(dir)) return results;
    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
        const fullPath = path.join(dir, item.name);
        const relPath = basePath ? `${basePath}/${item.name}` : item.name;
        if (item.isDirectory()) {
            results.push(...getAllMdFiles(fullPath, relPath));
        } else if (item.name.endsWith('.md') || item.name.endsWith('.mdx')) {
            results.push({ fullPath, relPath });
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
            const content = fs.readFileSync(fullPath, 'utf-8');
            const { data } = matter(content);
            const stats = fs.statSync(fullPath);
            const slug = relPath.replace(/\.(md|mdx)$/, '');
            return {
                slug,
                filename: relPath,
                title: data.title || slug,
                published: data.published || null,
                description: data.description || '',
                tags: data.tags || [],
                category: data.category || '',
                draft: data.draft || false,
                pinned: data.pinned || false,
                image: data.image || '',
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
        res.status(500).json({ error: err.message });
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
            const raw = fs.readFileSync(fullPath, 'utf-8');
            const { data } = matter(raw);
            if (Array.isArray(data.tags)) data.tags.forEach((t) => tagsSet.add(t));
            if (data.category) categoriesSet.add(data.category);
        }

        res.json({
            tags: [...tagsSet].sort(),
            categories: [...categoriesSet].sort(),
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 获取单篇文章
router.get('/:slug(*)', (req, res) => {
    try {
        const postsDir = getPostsDir();
        const slug = sanitizeSlug(req.params.slug);
        if (!slug) return res.status(400).json({ error: 'slug 格式无效' });

        let filePath = path.join(postsDir, `${slug}.md`);
        if (!fs.existsSync(filePath)) {
            filePath = path.join(postsDir, `${slug}.mdx`);
        }
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: '文章不存在' });
        }

        const raw = fs.readFileSync(filePath, 'utf-8');
        const { data, content } = matter(raw);

        res.json({
            slug,
            frontmatter: data,
            content,
            raw,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 创建新文章
router.post('/', async (req, res) => {
    try {
        const postsDir = getPostsDir();
        let { slug, frontmatter, content } = req.body;

        if (!slug && frontmatter?.title) {
            slug = generateSlug(frontmatter.title);
        }
        if (!slug) return res.status(400).json({ error: '文章 slug 不能为空' });
        slug = sanitizeSlug(slug);
        if (!slug) return res.status(400).json({ error: 'slug 格式无效' });

        const filePath = path.join(postsDir, `${slug}.md`);

        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        if (fs.existsSync(filePath)) {
            return res.status(400).json({ error: '同名文章已存在' });
        }

        const fm = normalizeFrontmatter({
            title: frontmatter.title || slug,
            published: frontmatter.published || new Date(),
            description: frontmatter.description || '',
            tags: frontmatter.tags || [],
            category: frontmatter.category || '',
            draft: frontmatter.draft ?? true,
            pinned: frontmatter.pinned ?? false,
            comment: frontmatter.comment ?? true,
            ...(frontmatter.image ? { image: frontmatter.image } : {}),
        });

        const fileContent = matter.stringify(content || '', fm);
        fs.writeFileSync(filePath, fileContent, 'utf-8');

        const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
        await logAction('创建文章', `标题: ${fm.title} (${slug})`, req.user.username, ip);

        res.json({ success: true, slug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 更新文章
router.put('/:slug(*)', async (req, res) => {
    try {
        const postsDir = getPostsDir();
        const slug = sanitizeSlug(req.params.slug);
        if (!slug) return res.status(400).json({ error: 'slug 格式无效' });
        const { frontmatter, content } = req.body;

        let filePath = path.join(postsDir, `${slug}.md`);
        if (!fs.existsSync(filePath)) {
            filePath = path.join(postsDir, `${slug}.mdx`);
        }
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: '文章不存在' });
        }

        const normalizedFm = normalizeFrontmatter(frontmatter || {});
        const fileContent = matter.stringify(content || '', normalizedFm);
        fs.writeFileSync(filePath, fileContent, 'utf-8');

        const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
        await logAction('编辑文章', `标题: ${normalizedFm.title || slug} (${slug})`, req.user.username, ip);

        res.json({ success: true, slug });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 删除文章
router.delete('/:slug(*)', async (req, res) => {
    try {
        const postsDir = getPostsDir();
        const slug = sanitizeSlug(req.params.slug);
        if (!slug) return res.status(400).json({ error: 'slug 格式无效' });

        let filePath = path.join(postsDir, `${slug}.md`);
        if (!fs.existsSync(filePath)) {
            filePath = path.join(postsDir, `${slug}.mdx`);
        }
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: '文章不存在' });
        }

        fs.unlinkSync(filePath);

        const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
        await logAction('删除文章', slug, req.user.username, ip);

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 批量删除文章
router.post('/batch-delete', async (req, res) => {
    try {
        const postsDir = getPostsDir();
        const { slugs } = req.body;

        if (!slugs || !Array.isArray(slugs) || slugs.length === 0) {
            return res.status(400).json({ error: '请选择要删除的文章' });
        }

        const deleted = [];
        const errors = [];

        for (const rawSlug of slugs) {
            const slug = sanitizeSlug(rawSlug);
            if (!slug) { errors.push(`${rawSlug}: slug 格式无效`); continue; }
            let filePath = path.join(postsDir, `${slug}.md`);
            if (!fs.existsSync(filePath)) {
                filePath = path.join(postsDir, `${slug}.mdx`);
            }
            if (!fs.existsSync(filePath)) {
                errors.push(`${slug}: 文件不存在`);
                continue;
            }
            try {
                fs.unlinkSync(filePath);
                deleted.push(slug);
            } catch (e) {
                errors.push(`${slug}: ${e.message}`);
            }
        }

        const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
        await logAction('批量删除文章', `已删除 ${deleted.length} 篇: ${deleted.join(', ')}`, req.user.username, ip);

        res.json({ success: true, deleted, errors });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Markdown 预览
router.post('/preview', (req, res) => {
    try {
        const { content } = req.body;
        const html = marked(content || '');
        res.json({ html });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
