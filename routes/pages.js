import express from 'express';
import fs from 'fs';
import path from 'path';
import { logAction } from '../lib/logger.js';
import { authMiddleware, requireRole } from '../lib/auth.js';
import { getClientIp, sendInternalError } from '../lib/http.js';
import { parseArrayLiteral } from '../lib/safe-literal.js';

const router = express.Router();
const MAX_MARKDOWN_BYTES = 1_000_000;
const MAX_COLLECTION_ITEMS = 1_000;
const MAX_COLLECTION_SOURCE_BYTES = 5 * 1024 * 1024;
const MAX_FIELD_BYTES = 10_000;
const resourceLocks = new Map();

router.use(authMiddleware);
router.use(requireRole('admin', 'editor'));

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

function ensureManagedPath(blogDir, targetPath) {
    const resolvedBlogDir = path.resolve(blogDir);
    const resolvedTarget = path.resolve(targetPath);
    const relative = path.relative(resolvedBlogDir, resolvedTarget);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('目标文件路径不安全');
    }

    let realBlogDir;
    try {
        realBlogDir = fs.realpathSync(resolvedBlogDir);
    } catch {
        throw new Error('博客目录不存在或路径不安全');
    }

    let existingPath = resolvedTarget;
    while (!pathExists(existingPath)) {
        const parent = path.dirname(existingPath);
        if (parent === existingPath) throw new Error('目标文件路径不安全');
        existingPath = parent;
    }
    const realExistingPath = fs.realpathSync(existingPath);
    if (!isPathInside(realBlogDir, realExistingPath)) {
        throw new Error('目标文件路径不安全');
    }
    if (pathExists(resolvedTarget) && fs.lstatSync(resolvedTarget).isSymbolicLink()) {
        throw new Error('目标文件路径不安全');
    }
}

function ensureString(value, fieldName) {
    if (typeof value !== 'string') {
        throw new Error(`${fieldName} 必须是字符串`);
    }
    return value;
}

function normalizeRequiredString(value, fieldName, maxBytes = MAX_FIELD_BYTES) {
    const normalized = ensureString(value, fieldName).trim();
    if (!normalized) throw new Error(`${fieldName} 不能为空`);
    if (Buffer.byteLength(normalized, 'utf8') > maxBytes) {
        throw new Error(`${fieldName} 文本过长`);
    }
    return normalized;
}

function normalizeOptionalString(value, fieldName, maxBytes = MAX_FIELD_BYTES) {
    if (value === undefined || value === null || value === '') return undefined;
    const normalized = ensureString(value, fieldName).trim();
    if (!normalized) return undefined;
    if (Buffer.byteLength(normalized, 'utf8') > maxBytes) {
        throw new Error(`${fieldName} 文本过长`);
    }
    return normalized;
}

function normalizeBoolean(value, fieldName, fallback = undefined) {
    if (value === undefined || value === null) return fallback;
    if (typeof value !== 'boolean') throw new Error(`${fieldName} 必须是布尔值`);
    return value;
}

function normalizeNonNegativeInteger(value, fieldName) {
    let normalized = value;
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) normalized = Number(value.trim());
    if (!Number.isSafeInteger(normalized) || normalized < 0) {
        throw new Error(`${fieldName} 必须是非负整数`);
    }
    return normalized;
}

function isValidationError(error) {
    return typeof error?.message === 'string'
        && /(?:必须|无效|不能为空|至少|不能重复|超出限制|过长|格式|应为)/.test(error.message);
}

function isValidHttpUrl(value) {
    if (typeof value !== 'string' || /[\u0000-\u0020\u007f\\]/.test(value)) return false;
    try {
        const url = new URL(value);
        return (url.protocol === 'http:' || url.protocol === 'https:')
            && !url.username && !url.password;
    } catch {
        return false;
    }
}

function isValidImagePath(value) {
    return typeof value === 'string'
        && !/[\u0000-\u001f\u007f\\]/.test(value)
        && (value === '' || (value.startsWith('/') && !value.startsWith('//')) || isValidHttpUrl(value));
}

function isValidDateString(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isValidColorString(value) {
    return typeof value === 'string'
        && value.trim().length > 0
        && Buffer.byteLength(value, 'utf8') <= 128
        && !/[\u0000-\u001f\u007f]/.test(value)
        && !/[{};"'`<>\\]/.test(value)
        && !/url\s*\(|expression\s*\(/i.test(value);
}

function parseStringArray(value, fieldName, { allowEmpty = true } = {}) {
    if (!Array.isArray(value)) {
        throw new Error(`${fieldName} 必须是数组`);
    }
    if (value.length > 500) throw new Error(`${fieldName} 条目数量超出限制`);
    const normalized = value.map((item) => {
        if (typeof item !== 'string') {
            throw new Error(`${fieldName} 中的每一项都必须是字符串`);
        }
        if (Buffer.byteLength(item, 'utf8') > 500) throw new Error(`${fieldName} 中的文本过长`);
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
    const items = parseArrayLiteral(arrayLiteral);

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

function backupOriginalFile(blogDir, filePath, resourceId) {
    const backupDir = path.join(blogDir, '.admin-backups', 'pages');
    fs.mkdirSync(backupDir, { recursive: true });
    const backupPath = path.join(backupDir, `${resourceId}-${Date.now()}-${Math.random().toString(16).slice(2)}.bak`);
    fs.copyFileSync(filePath, backupPath);
    return backupPath;
}

function validateFriendsItems(items) {
    return items.map((item, index) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            throw new Error(`第 ${index + 1} 条友链格式无效`);
        }

        const normalized = {
            id: normalizeNonNegativeInteger(item.id, `第 ${index + 1} 条友链 ID`),
            title: normalizeRequiredString(item.title, `第 ${index + 1} 条友链标题`, 500),
            imgurl: normalizeOptionalString(item.imgurl, `第 ${index + 1} 条友链头像`, 2_000) || '',
            desc: normalizeRequiredString(item.desc, `第 ${index + 1} 条友链描述`, 5_000),
            siteurl: normalizeRequiredString(item.siteurl, `第 ${index + 1} 条友链地址`, 2_000),
            tags: parseStringArray(item.tags ?? [], `第 ${index + 1} 条友链标签`),
        };

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
            id: normalizeRequiredString(item.id, `第 ${index + 1} 个项目 ID`, 256),
            title: normalizeRequiredString(item.title, `第 ${index + 1} 个项目标题`, 500),
            description: normalizeRequiredString(item.description, `第 ${index + 1} 个项目描述`, 5_000),
            image: normalizeOptionalString(item.image, `第 ${index + 1} 个项目图片`, 2_000) || '',
            category: normalizeRequiredString(item.category, `第 ${index + 1} 个项目分类`, 64),
            techStack: parseStringArray(item.techStack ?? [], `第 ${index + 1} 个项目技术栈`, { allowEmpty: false }),
            status: normalizeRequiredString(item.status, `第 ${index + 1} 个项目状态`, 32),
            liveDemo: normalizeOptionalString(item.liveDemo, `第 ${index + 1} 个项目 LiveDemo`, 2_000),
            sourceCode: normalizeOptionalString(item.sourceCode, `第 ${index + 1} 个项目源码`, 2_000),
            visitUrl: normalizeOptionalString(item.visitUrl, `第 ${index + 1} 个项目访问链接`, 2_000),
            startDate: normalizeRequiredString(item.startDate, `第 ${index + 1} 个项目开始时间`, 32),
            endDate: normalizeOptionalString(item.endDate, `第 ${index + 1} 个项目结束时间`, 32),
            featured: normalizeBoolean(item.featured, `第 ${index + 1} 个项目精选`, false),
            tags: parseStringArray(item.tags ?? [], `第 ${index + 1} 个项目标签`),
            showImage: normalizeBoolean(item.showImage, `第 ${index + 1} 个项目显示图片`),
        };

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

        if (item.experience !== undefined && item.experience !== null
            && (typeof item.experience !== 'object' || Array.isArray(item.experience))) {
            throw new Error(`第 ${index + 1} 个技能经验格式无效`);
        }
        const experience = item.experience || {};
        const years = normalizeNonNegativeInteger(experience.years ?? 0, `第 ${index + 1} 个技能经验年数`);
        const months = normalizeNonNegativeInteger(experience.months ?? 0, `第 ${index + 1} 个技能经验月数`);

        const normalized = {
            id: normalizeRequiredString(item.id, `第 ${index + 1} 个技能 ID`, 256),
            name: normalizeRequiredString(item.name, `第 ${index + 1} 个技能名称`, 500),
            description: normalizeRequiredString(item.description, `第 ${index + 1} 个技能描述`, 5_000),
            icon: normalizeRequiredString(item.icon, `第 ${index + 1} 个技能图标`, 256),
            category: normalizeRequiredString(item.category, `第 ${index + 1} 个技能分类`, 64),
            level: normalizeRequiredString(item.level, `第 ${index + 1} 个技能等级`, 64),
            experience: {
                years,
                months,
            },
            projects: parseStringArray(item.projects ?? [], `第 ${index + 1} 个技能项目`),
            certifications: parseStringArray(item.certifications ?? [], `第 ${index + 1} 个技能证书`),
            color: normalizeOptionalString(item.color, `第 ${index + 1} 个技能颜色`, 128),
        };

        if (!validCategories.has(normalized.category)) {
            throw new Error(`第 ${index + 1} 个技能分类无效`);
        }
        if (!validLevels.has(normalized.level)) {
            throw new Error(`第 ${index + 1} 个技能等级无效`);
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

        if (item.links !== undefined && item.links !== null && !Array.isArray(item.links)) {
            throw new Error(`第 ${index + 1} 条时间线链接必须是数组`);
        }
        const rawLinks = item.links ?? [];
        if (rawLinks.length > 100) throw new Error(`第 ${index + 1} 条时间线链接数量超出限制`);
        const links = rawLinks.map((link, linkIndex) => {
            if (!link || typeof link !== 'object' || Array.isArray(link)) {
                throw new Error(`第 ${index + 1} 条时间线的第 ${linkIndex + 1} 个链接格式无效`);
            }
            const normalizedLink = {
                name: normalizeRequiredString(link.name, `第 ${index + 1} 条时间线链接名称`, 500),
                url: normalizeRequiredString(link.url, `第 ${index + 1} 条时间线链接地址`, 2_000),
                type: normalizeRequiredString(link.type, `第 ${index + 1} 条时间线链接类型`, 32),
            };
            if (!isValidHttpUrl(normalizedLink.url)) throw new Error(`第 ${index + 1} 条时间线链接地址无效`);
            if (!validLinkTypes.has(normalizedLink.type)) throw new Error(`第 ${index + 1} 条时间线链接类型无效`);
            return normalizedLink;
        });

        const normalized = {
            id: normalizeRequiredString(item.id, `第 ${index + 1} 条时间线 ID`, 256),
            title: normalizeRequiredString(item.title, `第 ${index + 1} 条时间线标题`, 500),
            description: normalizeRequiredString(item.description, `第 ${index + 1} 条时间线描述`, 5_000),
            type: normalizeRequiredString(item.type, `第 ${index + 1} 条时间线类型`, 64),
            startDate: normalizeRequiredString(item.startDate, `第 ${index + 1} 条时间线开始时间`, 32),
            endDate: normalizeOptionalString(item.endDate, `第 ${index + 1} 条时间线结束时间`, 32),
            location: normalizeOptionalString(item.location, `第 ${index + 1} 条时间线地点`, 500),
            organization: normalizeOptionalString(item.organization, `第 ${index + 1} 条时间线组织`, 500),
            position: normalizeOptionalString(item.position, `第 ${index + 1} 条时间线职位`, 500),
            skills: parseStringArray(item.skills ?? [], `第 ${index + 1} 条时间线技能`),
            achievements: parseStringArray(item.achievements ?? [], `第 ${index + 1} 条时间线成就`),
            links,
            icon: normalizeOptionalString(item.icon, `第 ${index + 1} 条时间线图标`, 256),
            color: normalizeOptionalString(item.color, `第 ${index + 1} 条时间线颜色`, 128),
            featured: normalizeBoolean(item.featured, `第 ${index + 1} 条时间线精选`, false),
        };

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
    if (items.length > MAX_COLLECTION_ITEMS) {
        throw new Error(`items 最多允许 ${MAX_COLLECTION_ITEMS} 条`);
    }

    let normalized;
    switch (resourceId) {
        case 'friends-data':
            normalized = validateFriendsItems(items);
            break;
        case 'projects-data':
            normalized = validateProjectsItems(items);
            break;
        case 'skills-data':
            normalized = validateSkillsItems(items);
            break;
        case 'timeline-data':
            normalized = validateTimelineItems(items);
            break;
        default:
            throw new Error('不支持的数据资源');
    }
    const ids = new Set();
    for (const item of normalized) {
        const id = String(item.id);
        if (ids.has(id)) throw new Error('条目 ID 不能重复');
        ids.add(id);
    }
    if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > MAX_COLLECTION_SOURCE_BYTES) {
        throw new Error('items 数据内容超出限制');
    }
    return normalized;
}

async function withResourceLock(key, operation) {
    const previous = resourceLocks.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    resourceLocks.set(key, current);
    await previous;
    try {
        return await operation();
    } finally {
        release();
        if (resourceLocks.get(key) === current) resourceLocks.delete(key);
    }
}

function saveCollectionResource(resource, items, blogDir) {
    const stats = fs.statSync(resource.filePath);
    if (!stats.isFile() || stats.size > MAX_COLLECTION_SOURCE_BYTES) {
        throw new Error('数据源文件过大或格式无效');
    }
    const source = fs.readFileSync(resource.filePath, 'utf-8');
    const { arrayStart, arrayEnd } = extractExportedArray(source, resource.exportName);
    const newArrayLiteral = formatTsValue(items, 0);
    const newSource = `${source.slice(0, arrayStart)}${newArrayLiteral}${source.slice(arrayEnd + 1)}`;
    if (Buffer.byteLength(newSource, 'utf8') > MAX_COLLECTION_SOURCE_BYTES) {
        throw new Error('数据源文件过大或格式无效');
    }

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
        sendInternalError(res, err, '读取页面资源列表失败');
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
            if (exists && fs.statSync(resource.filePath).size > MAX_MARKDOWN_BYTES) {
                return res.status(413).json({ error: 'Markdown 内容不能超过 1MB' });
            }
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

        const stats = fs.statSync(resource.filePath);
        if (!stats.isFile() || stats.size > MAX_COLLECTION_SOURCE_BYTES) {
            return res.status(413).json({ error: '数据源文件过大' });
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
        sendInternalError(res, err, '读取页面资源详情失败');
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

        const ip = getClientIp(req);
        let backupPath = null;

        if (resource.mode === 'markdown') {
            if (typeof req.body?.content !== 'string') {
                return res.status(400).json({ error: 'content 必须是字符串' });
            }
            if (Buffer.byteLength(req.body.content, 'utf8') > MAX_MARKDOWN_BYTES) {
                return res.status(413).json({ error: 'Markdown 内容不能超过 1MB' });
            }
            backupPath = await withResourceLock(resource.filePath, () => saveMarkdownResource(resource, req.body.content, blogDir));
        } else {
            const normalizedItems = validateCollectionItems(resource.id, req.body?.items);
            backupPath = await withResourceLock(resource.filePath, () => saveCollectionResource(resource, normalizedItems, blogDir));
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
        if (isValidationError(err)) return res.status(400).json({ error: err.message });
        sendInternalError(res, err, '保存页面资源失败');
    }
});

export default router;
