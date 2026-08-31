export function getClientIp(req) {
    return req.ip || req.socket?.remoteAddress || 'unknown';
}

export function sendInternalError(res, error, context = '请求失败') {
    console.error(`${context}:`, error);
    if (res.headersSent) return;
    return res.status(500).json({ error: '服务器内部错误' });
}

const MAX_PAGE = 100_000;

function parseNonNegativeInteger(value) {
    if (typeof value === 'number') {
        return Number.isSafeInteger(value) && value >= 0 ? value : null;
    }
    if (typeof value !== 'string') return null;
    const normalized = value.trim();
    if (!/^\d+$/.test(normalized)) return null;
    const parsed = Number(normalized);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function parsePage(value, fallback = 0, max = MAX_PAGE) {
    const safeMax = Number.isSafeInteger(max) && max >= 0 ? max : MAX_PAGE;
    const safeFallback = parseNonNegativeInteger(fallback);
    const defaultPage = safeFallback === null ? 0 : Math.min(safeFallback, safeMax);
    const page = parseNonNegativeInteger(value);
    return page === null ? defaultPage : Math.min(page, safeMax);
}

export function parsePageSize(value, fallback = 30, max = 100) {
    const safeMax = Number.isSafeInteger(max) && max >= 1 ? max : 100;
    const parsedFallback = parseNonNegativeInteger(fallback);
    const defaultPageSize = parsedFallback === null || parsedFallback < 1
        ? Math.min(30, safeMax)
        : Math.min(parsedFallback, safeMax);
    const pageSize = parseNonNegativeInteger(value);
    if (pageSize === null || pageSize < 1) return defaultPageSize;
    return Math.min(pageSize, safeMax);
}
