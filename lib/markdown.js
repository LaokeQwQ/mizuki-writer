import { marked } from 'marked';

function escapeHtml(value = '') {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function safeUrl(value, { image = false } = {}) {
    if (typeof value !== 'string') return '';
    const url = value.trim();
    if (!url || /[\u0000-\u001f\u007f\\]/.test(url)) return '';
    const normalizedProtocol = url.replace(/[\u0000-\u0020]+/g, '');
    if (/^(?:javascript|vbscript|data):/i.test(normalizedProtocol) || url.startsWith('//')) return '';
    if (image && !/^(?:https?:\/\/|\/|\.\.?\/)/i.test(url)) return '';
    if (!image && !/^(?:https?:\/\/|mailto:|tel:|\/|\.\.?\/|#)/i.test(url)) return '';
    if (/^(?:https?:\/\/|mailto:|tel:)/i.test(url)) {
        try {
            const parsed = new URL(url);
            if (parsed.username || parsed.password) return '';
        } catch {
            return '';
        }
    }
    return url;
}

function tokenText(parser, tokens, fallback = '') {
    return parser?.parseInline && Array.isArray(tokens)
        ? parser.parseInline(tokens)
        : escapeHtml(fallback);
}

export function renderSafeMarkdown(source = '') {
    const renderer = new marked.Renderer();

    renderer.html = (token) => escapeHtml(typeof token === 'string' ? token : token?.text || '');
    renderer.link = function (token) {
        const href = safeUrl(token?.href);
        const text = tokenText(this.parser, token?.tokens, token?.text);
        if (!href) return text;
        const title = token?.title ? ` title="${escapeHtml(token.title)}"` : '';
        return `<a href="${escapeHtml(href)}"${title} rel="noopener noreferrer">${text}</a>`;
    };
    renderer.image = function (token) {
        const src = safeUrl(token?.href, { image: true });
        if (!src) return escapeHtml(token?.text || '');
        const title = token?.title ? ` title="${escapeHtml(token.title)}"` : '';
        return `<img src="${escapeHtml(src)}" alt="${escapeHtml(token?.text || '')}"${title} loading="lazy" referrerpolicy="no-referrer">`;
    };

    return marked.parse(String(source), { renderer });
}
