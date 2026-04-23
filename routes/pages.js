import express from 'express';
import jwt from 'jsonwebtoken';
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

function getBlogDir() {
    const blogDir = process.env.BLOG_DIR;
    if (!blogDir) throw new Error('BLOG_DIR 未配置');
    return blogDir;
}

function getResourceDefinitions(blogDir) {
    return [
        {
            id: 'about',
            title: '关于页面',
            mode: 'markdown',
            category: 'page',
            description: '编辑 /about/ 页面正文内容',
            filePath: path.join(blogDir, 'src', 'content', 'spec', 'about.md'),
        },
        {
            id: 'friends-page',
            title: '友链说明文案',
            mode: 'markdown',
            category: 'page',
            description: '编辑 /friends/ 页面底部说明文案',
            filePath: path.join(blogDir, 'src', 'content', 'spec', 'friends.md'),
        },
        {
            id: 'friends-data',
            title: '友链展示管理',
            mode: 'collection',
            category: 'data',
            description: '编辑 /friends/ 页面卡片数据',
            filePath: path.join(blogDir, 'src', 'data', 'friends.ts'),
            exportName: 'friendsData',
        },
        {
            id: 'projects-data',
            title: '项目展示管理',
            mode: 'collection',
            category: 'data',
            description: '编辑 /projects/ 页面数据',
            filePath: path.join(blogDir, 'src', 'data', 'projects.ts'),
            exportName: 'projectsData',
        },
        {
            id: 'skills-data',
            title: '技能展示管理',
            mode: 'collection',
            category: 'data',
            description: '编辑 /skills/ 页面数据',
            filePath: path.join(blogDir, 'src', 'data', 'skills.ts'),
            exportName: 'skillsData',
        },
        {
            id: 'timeline-data',
            title: '时间线管理',
            mode: 'collection',
            category: 'data',
            description: '编辑 /timeline/ 页面数据',
            filePath: path.join(blogDir, 'src', 'data', 'timeline.ts'),
            exportName: 'timelineData',
        },
    ];
}

function getResourceById(blogDir, id) {
    return getResourceDefinitions(blogDir).find((item) => item.id === id);
}

function ensureManagedPath(blogDir, targetPath) {
    const resolvedBlogDir = path.resolve(blogDir);
    const resolvedTarget = path.resolve(targetPath);
    const relative = path.relative(resolvedBlogDir, resolvedTarget);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('目标文件路径不安全');
    }
}

function ensureString(value, fieldName) {
    if (typeof value !== 'string') {
        throw new Error(`${fieldName} 必须是字符串`);
    }
    return value;
}

function isValidHttpUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
}

function isValidImagePath(value) {
    return typeof value === 'string' && (value === '' || value.startsWith('/') || isValidHttpUrl(value));
}

function isValidDateString(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isValidColorString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

function parseStringArray(value, fieldName, { allowEmpty = true } = {}) {
    if (!Array.isArray(value)) {
        throw new Error(`${fieldName} 必须是数组`);
    }
    const normalized = value.map((item) => {
        if (typeof item !== 'string') {
            throw new Error(`${fieldName} 中的每一项都必须是字符串`);
        }
        return item.trim();
    }).filter(Boolean);

    if (!allowEmpty && normalized.length === 0) {
        throw new Error(`${fieldName} 至少需要一项`);
    }
    return normalized;
}

function findMatchingBracket(source, startIndex) {
    let depth = 0;
    let inSingle = false;
    let inDouble = false;
    let inTemplate = false;
    let inLineComment = false;
    let inBlockComment = false;
    let escaped = false;

    for (let i = startIndex; i < source.length; i++) {
        const char = source[i];
        const next = source[i + 1];

        if (inLineComment) {
            if (char === '\n') inLineComment = false;
            continue;
        }
        if (inBlockComment) {
            if (char === '*' && next === '/') {
                inBlockComment = false;
                i++;
            }
            continue;
        }
        if (inSingle) {
            if (!escaped && char === '\'') inSingle = false;
            escaped = !escaped && char === '\\';
            continue;
        }
        if (inDouble) {
            if (!escaped && char === '"') inDouble = false;
            escaped = !escaped && char === '\\';
            continue;
        }
        if (inTemplate) {
            if (!escaped && char === '`') inTemplate = false;
            escaped = !escaped && char === '\\';
            continue;
        }

        escaped = false;

        if (char === '/' && next === '/') {
            inLineComment = true;
            i++;
            continue;
        }
        if (char === '/' && next === '*') {
            inBlockComment = true;
            i++;
            continue;
        }
        if (char === '\'') {
            inSingle = true;
            continue;
        }
        if (char === '"') {
            inDouble = true;
            continue;
        }
        if (char === '`') {
            inTemplate = true;
            continue;
        }

        if (char === '[') {
            depth++;
        } else if (char === ']') {
            depth--;
            if (depth === 0) {
                return i;
            }
        }
    }

    throw new Error('未能找到数组结束位置');
}

function extractExportedArray(source, exportName) {
    const exportRegex = new RegExp(`export\\s+const\\s+${exportName}\\b[^=]*=`, 'm');
    const match = exportRegex.exec(source);
    if (!match) {
        throw new Error(`未找到导出数组 ${exportName}`);
    }

    const afterAssignment = match.index + match[0].length;
    const arrayStart = source.indexOf('[', afterAssignment);
    if (arrayStart === -1) {
        throw new Error(`未找到数组起始位置 ${exportName}`);
    }

    const arrayEnd = findMatchingBracket(source, arrayStart);
    const arrayLiteral = source.slice(arrayStart, arrayEnd + 1);
    const items = Function(`"use strict"; return (${arrayLiteral});`)();

    if (!Array.isArray(items)) {
        throw new Error(`${exportName} 不是数组`);
    }

    return {
        arrayStart,
        arrayEnd,
        arrayLiteral,
        items,
    };
}

function formatTsValue(value, indentLevel = 0) {
    const indent = '\t'.repeat(indentLevel);
    const childIndent = '\t'.repeat(indentLevel + 1);

    if (value === null) return 'null';
    if (typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);

    if (Array.isArray(value)) {
        if (value.length === 0) return '[]';
        return `[\n${value.map((item) => `${childIndent}${formatTsValue(item, indentLevel + 1)}`).join(',\n')}\n${indent}]`;
    }

    if (typeof value === 'object') {
        const entries = Object.entries(value).filter(([, entryValue]) => entryValue !== undefined);
        if (entries.length === 0) return '{}';
        return `{\n${entries.map(([key, entryValue]) => `${childIndent}${key}: ${formatTsValue(entryValue, indentLevel + 1)}`).join(',\n')}\n${indent}}`;
    }

    throw new Error('存在无法序列化的数据类型');
}

function writeFileAtomically(filePath, content) {
    const tempPath = `${filePath}.tmp-${Date.now()}`;
    fs.writeFileSync(tempPath, content, 'utf-8');
    fs.renameSync(tempPath, filePath);
}

function backupOriginalFile(blogDir, filePath, resourceId) {
    const backupDir = path.join(blogDir, '.admin-backups', 'pages');
    fs.mkdirSync(backupDir, { recursive: true });
    const backupPath = path.join(backupDir, `${resourceId}-${Date.now()}.bak`);
    fs.copyFileSync(filePath, backupPath);
    return backupPath;
}

function validateFriendsItems(items) {
    return items.map((item, index) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            throw new Error(`第 ${index + 1} 条友链格式无效`);
        }

        const normalized = {
            id: Number(item.id),
            title: ensureString(item.title, `第 ${index + 1} 条友链标题`).trim(),
            imgurl: ensureString(item.imgurl, `第 ${index + 1} 条友链头像`).trim(),
            desc: ensureString(item.desc, `第 ${index + 1} 条友链描述`).trim(),
            siteurl: ensureString(item.siteurl, `第 ${index + 1} 条友链地址`).trim(),
            tags: parseStringArray(item.tags ?? [], `第 ${index + 1} 条友链标签`),
        };

        if (!Number.isInteger(normalized.id) || normalized.id < 0) {
            throw new Error(`第 ${index + 1} 条友链 ID 必须是非负整数`);
        }
        if (!normalized.title) {
            throw new Error(`第 ${index + 1} 条友链标题不能为空`);
        }
        if (!normalized.desc) {
            throw new Error(`第 ${index + 1} 条友链描述不能为空`);
        }
        if (!isValidImagePath(normalized.imgurl)) {
            throw new Error(`第 ${index + 1} 条友链头像链接无效`);
        }
        if (!normalized.siteurl.startsWith('https://') || !isValidHttpUrl(normalized.siteurl)) {
            throw new Error(`第 ${index + 1} 条友链地址必须是有效的 HTTPS 链接`);
        }

        return normalized;
    });
}

function validateProjectsItems(items) {
    const validCategories = new Set(['web', 'mobile', 'desktop', 'other']);
    const validStatus = new Set(['completed', 'in-progress', 'planned']);

    return items.map((item, index) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            throw new Error(`第 ${index + 1} 个项目格式无效`);
        }

        const normalized = {
            id: ensureString(item.id, `第 ${index + 1} 个项目 ID`).trim(),
            title: ensureString(item.title, `第 ${index + 1} 个项目标题`).trim(),
            description: ensureString(item.description, `第 ${index + 1} 个项目描述`).trim(),
            image: ensureString(item.image ?? '', `第 ${index + 1} 个项目图片`).trim(),
            category: ensureString(item.category, `第 ${index + 1} 个项目分类`).trim(),
            techStack: parseStringArray(item.techStack ?? [], `第 ${index + 1} 个项目技术栈`, { allowEmpty: false }),
            status: ensureString(item.status, `第 ${index + 1} 个项目状态`).trim(),
            liveDemo: item.liveDemo ? ensureString(item.liveDemo, `第 ${index + 1} 个项目 LiveDemo`).trim() : undefined,
            sourceCode: item.sourceCode ? ensureString(item.sourceCode, `第 ${index + 1} 个项目源码`).trim() : undefined,
            visitUrl: item.visitUrl ? ensureString(item.visitUrl, `第 ${index + 1} 个项目访问链接`).trim() : undefined,
            startDate: ensureString(item.startDate, `第 ${index + 1} 个项目开始时间`).trim(),
            endDate: item.endDate ? ensureString(item.endDate, `第 ${index + 1} 个项目结束时间`).trim() : undefined,
            featured: Boolean(item.featured),
            tags: parseStringArray(item.tags ?? [], `第 ${index + 1} 个项目标签`),
            showImage: item.showImage === undefined ? undefined : Boolean(item.showImage),
        };

        if (!normalized.id) throw new Error(`第 ${index + 1} 个项目 ID 不能为空`);
        if (!normalized.title) throw new Error(`第 ${index + 1} 个项目标题不能为空`);
        if (!normalized.description) throw new Error(`第 ${index + 1} 个项目描述不能为空`);
        if (!validCategories.has(normalized.category)) {
            throw new Error(`第 ${index + 1} 个项目分类无效`);
        }
        if (!validStatus.has(normalized.status)) {
            throw new Error(`第 ${index + 1} 个项目状态无效`);
        }
        if (!isValidDateString(normalized.startDate)) {
            throw new Error(`第 ${index + 1} 个项目开始时间格式无效，应为 YYYY-MM-DD`);
        }
        if (normalized.endDate && !isValidDateString(normalized.endDate)) {
            throw new Error(`第 ${index + 1} 个项目结束时间格式无效，应为 YYYY-MM-DD`);
        }
        if (normalized.image && !isValidImagePath(normalized.image)) {
            throw new Error(`第 ${index + 1} 个项目图片地址无效`);
        }
        for (const fieldName of ['liveDemo', 'sourceCode', 'visitUrl']) {
            if (normalized[fieldName] && !isValidHttpUrl(normalized[fieldName])) {
                throw new Error(`第 ${index + 1} 个项目 ${fieldName} 链接无效`);
            }
        }

        return normalized;
    });
}

function validateSkillsItems(items) {
    const validCategories = new Set(['frontend', 'backend', 'database', 'tools', 'other']);
    const validLevels = new Set(['beginner', 'intermediate', 'advanced', 'expert']);

    return items.map((item, index) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            throw new Error(`第 ${index + 1} 个技能项格式无效`);
        }

        const years = Number(item.experience?.years ?? 0);
        const months = Number(item.experience?.months ?? 0);

        const normalized = {
            id: ensureString(item.id, `第 ${index + 1} 个技能 ID`).trim(),
            name: ensureString(item.name, `第 ${index + 1} 个技能名称`).trim(),
            description: ensureString(item.description, `第 ${index + 1} 个技能描述`).trim(),
            icon: ensureString(item.icon, `第 ${index + 1} 个技能图标`).trim(),
            category: ensureString(item.category, `第 ${index + 1} 个技能分类`).trim(),
            level: ensureString(item.level, `第 ${index + 1} 个技能等级`).trim(),
            experience: {
                years,
                months,
            },
            projects: parseStringArray(item.projects ?? [], `第 ${index + 1} 个技能项目`),
            certifications: parseStringArray(item.certifications ?? [], `第 ${index + 1} 个技能证书`),
            color: item.color ? ensureString(item.color, `第 ${index + 1} 个技能颜色`).trim() : undefined,
        };

        if (!normalized.id) throw new Error(`第 ${index + 1} 个技能 ID 不能为空`);
        if (!normalized.name) throw new Error(`第 ${index + 1} 个技能名称不能为空`);
        if (!normalized.description) throw new Error(`第 ${index + 1} 个技能描述不能为空`);
        if (!normalized.icon) throw new Error(`第 ${index + 1} 个技能图标不能为空`);
        if (!validCategories.has(normalized.category)) {
            throw new Error(`第 ${index + 1} 个技能分类无效`);
        }
        if (!validLevels.has(normalized.level)) {
            throw new Error(`第 ${index + 1} 个技能等级无效`);
        }
        if (!Number.isInteger(years) || years < 0 || !Number.isInteger(months) || months < 0) {
            throw new Error(`第 ${index + 1} 个技能经验必须是非负整数`);
        }
        if (normalized.color && !isValidColorString(normalized.color)) {
            throw new Error(`第 ${index + 1} 个技能颜色无效`);
        }

        return normalized;
    });
}

function validateTimelineItems(items) {
    const validTypes = new Set(['education', 'work', 'project', 'achievement']);
    const validLinkTypes = new Set(['website', 'certificate', 'project', 'other']);

    return items.map((item, index) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            throw new Error(`第 ${index + 1} 条时间线格式无效`);
        }

        const links = Array.isArray(item.links) ? item.links.map((link, linkIndex) => {
            if (!link || typeof link !== 'object' || Array.isArray(link)) {
                throw new Error(`第 ${index + 1} 条时间线的第 ${linkIndex + 1} 个链接格式无效`);
            }
            const normalizedLink = {
                name: ensureString(link.name, `第 ${index + 1} 条时间线链接名称`).trim(),
                url: ensureString(link.url, `第 ${index + 1} 条时间线链接地址`).trim(),
                type: ensureString(link.type, `第 ${index + 1} 条时间线链接类型`).trim(),
            };
            if (!normalizedLink.name) throw new Error(`第 ${index + 1} 条时间线链接名称不能为空`);
            if (!isValidHttpUrl(normalizedLink.url)) throw new Error(`第 ${index + 1} 条时间线链接地址无效`);
            if (!validLinkTypes.has(normalizedLink.type)) throw new Error(`第 ${index + 1} 条时间线链接类型无效`);
            return normalizedLink;
        }) : [];

        const normalized = {
            id: ensureString(item.id, `第 ${index + 1} 条时间线 ID`).trim(),
            title: ensureString(item.title, `第 ${index + 1} 条时间线标题`).trim(),
            description: ensureString(item.description, `第 ${index + 1} 条时间线描述`).trim(),
            type: ensureString(item.type, `第 ${index + 1} 条时间线类型`).trim(),
            startDate: ensureString(item.startDate, `第 ${index + 1} 条时间线开始时间`).trim(),
            endDate: item.endDate ? ensureString(item.endDate, `第 ${index + 1} 条时间线结束时间`).trim() : undefined,
            location: item.location ? ensureString(item.location, `第 ${index + 1} 条时间线地点`).trim() : undefined,
            organization: item.organization ? ensureString(item.organization, `第 ${index + 1} 条时间线组织`).trim() : undefined,
            position: item.position ? ensureString(item.position, `第 ${index + 1} 条时间线职位`).trim() : undefined,
            skills: parseStringArray(item.skills ?? [], `第 ${index + 1} 条时间线技能`),
            achievements: parseStringArray(item.achievements ?? [], `第 ${index + 1} 条时间线成就`),
            links,
            icon: item.icon ? ensureString(item.icon, `第 ${index + 1} 条时间线图标`).trim() : undefined,
            color: item.color ? ensureString(item.color, `第 ${index + 1} 条时间线颜色`).trim() : undefined,
            featured: Boolean(item.featured),
        };

        if (!normalized.id) throw new Error(`第 ${index + 1} 条时间线 ID 不能为空`);
        if (!normalized.title) throw new Error(`第 ${index + 1} 条时间线标题不能为空`);
        if (!normalized.description) throw new Error(`第 ${index + 1} 条时间线描述不能为空`);
        if (!validTypes.has(normalized.type)) throw new Error(`第 ${index + 1} 条时间线类型无效`);
        if (!isValidDateString(normalized.startDate)) {
            throw new Error(`第 ${index + 1} 条时间线开始时间格式无效，应为 YYYY-MM-DD`);
        }
        if (normalized.endDate && !isValidDateString(normalized.endDate)) {
            throw new Error(`第 ${index + 1} 条时间线结束时间格式无效，应为 YYYY-MM-DD`);
        }
        if (normalized.color && !isValidColorString(normalized.color)) {
            throw new Error(`第 ${index + 1} 条时间线颜色无效`);
        }

        return normalized;
    });
}

function validateCollectionItems(resourceId, items) {
    if (!Array.isArray(items)) {
        throw new Error('items 必须是数组');
    }

    switch (resourceId) {
        case 'friends-data':
            return validateFriendsItems(items);
        case 'projects-data':
            return validateProjectsItems(items);
        case 'skills-data':
            return validateSkillsItems(items);
        case 'timeline-data':
            return validateTimelineItems(items);
        default:
            throw new Error('不支持的数据资源');
    }
}

function saveCollectionResource(resource, items, blogDir) {
    const source = fs.readFileSync(resource.filePath, 'utf-8');
    const { arrayStart, arrayEnd } = extractExportedArray(source, resource.exportName);
    const newArrayLiteral = formatTsValue(items, 0);
    const newSource = `${source.slice(0, arrayStart)}${newArrayLiteral}${source.slice(arrayEnd + 1)}`;

    const backupPath = backupOriginalFile(blogDir, resource.filePath, resource.id);
    writeFileAtomically(resource.filePath, newSource);
    return backupPath;
}

function saveMarkdownResource(resource, content, blogDir) {
    const backupPath = fs.existsSync(resource.filePath)
        ? backupOriginalFile(blogDir, resource.filePath, resource.id)
        : null;
    fs.mkdirSync(path.dirname(resource.filePath), { recursive: true });
    writeFileAtomically(resource.filePath, content);
    return backupPath;
}

router.get('/', (req, res) => {
    try {
        const blogDir = getBlogDir();
        const items = getResourceDefinitions(blogDir).map((item) => ({
            id: item.id,
            title: item.title,
            mode: item.mode,
            category: item.category,
            description: item.description,
            relativePath: path.relative(blogDir, item.filePath).replace(/\\/g, '/'),
        }));
        res.json({ items });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/:id', (req, res) => {
    try {
        const blogDir = getBlogDir();
        const resource = getResourceById(blogDir, req.params.id);
        if (!resource) {
            return res.status(404).json({ error: '页面资源不存在' });
        }

        ensureManagedPath(blogDir, resource.filePath);

        if (resource.mode === 'markdown') {
            const exists = fs.existsSync(resource.filePath);
            const content = exists ? fs.readFileSync(resource.filePath, 'utf-8') : '';
            return res.json({
                id: resource.id,
                title: resource.title,
                mode: resource.mode,
                category: resource.category,
                description: resource.description,
                relativePath: path.relative(blogDir, resource.filePath).replace(/\\/g, '/'),
                exists,
                content,
            });
        }

        const source = fs.readFileSync(resource.filePath, 'utf-8');
        const { items } = extractExportedArray(source, resource.exportName);
        return res.json({
            id: resource.id,
            title: resource.title,
            mode: resource.mode,
            category: resource.category,
            description: resource.description,
            relativePath: path.relative(blogDir, resource.filePath).replace(/\\/g, '/'),
            items,
            count: items.length,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.put('/:id', async (req, res) => {
    try {
        const blogDir = getBlogDir();
        const resource = getResourceById(blogDir, req.params.id);
        if (!resource) {
            return res.status(404).json({ error: '页面资源不存在' });
        }

        ensureManagedPath(blogDir, resource.filePath);

        const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
        let backupPath = null;

        if (resource.mode === 'markdown') {
            if (typeof req.body.content !== 'string') {
                return res.status(400).json({ error: 'content 必须是字符串' });
            }
            backupPath = saveMarkdownResource(resource, req.body.content, blogDir);
        } else {
            const normalizedItems = validateCollectionItems(resource.id, req.body.items);
            backupPath = saveCollectionResource(resource, normalizedItems, blogDir);
        }

        await logAction(
            '编辑页面资源',
            `${resource.title} (${path.relative(blogDir, resource.filePath).replace(/\\/g, '/')})`,
            req.user.username,
            ip,
        );

        res.json({
            success: true,
            id: resource.id,
            title: resource.title,
            mode: resource.mode,
            relativePath: path.relative(blogDir, resource.filePath).replace(/\\/g, '/'),
            backupPath: backupPath ? path.relative(blogDir, backupPath).replace(/\\/g, '/') : null,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
