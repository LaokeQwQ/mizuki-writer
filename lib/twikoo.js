import crypto from 'crypto';

/**
 * Twikoo 的管理员 accessToken 就是管理密码的 MD5（客户端登录后同样保存这个值）。
 * LOGIN 事件本身只返回 code/ticket，不会返回可用于管理接口的 accessToken。
 */
export function deriveTwikooAdminToken(password) {
    if (typeof password !== 'string' || !password) {
        throw new Error('TWIKOO_PASSWORD 未配置');
    }
    return crypto.createHash('md5').update(password, 'utf8').digest('hex');
}

/**
 * 后台分页统一使用 0 基页码，Twikoo 管理接口使用 1 基页码。
 */
export function toTwikooPage(page) {
    const normalized = Number.isSafeInteger(page) && page >= 0 ? page : 0;
    return normalized + 1;
}

/**
 * Twikoo 的业务错误同样以 HTTP 200 返回，需要根据 code 判断。
 * @returns {string|null} 错误信息；成功时返回 null
 */
export function getTwikooResponseError(result) {
    if (!result || typeof result !== 'object') return 'Twikoo API 响应无效';
    if (typeof result.code === 'number' && result.code !== 0) {
        return typeof result.message === 'string' && result.message
            ? result.message
            : `Twikoo API 错误 (${String(result.code)})`;
    }
    // Twikoo 1.x 的 COMMENT_SUBMIT 成功响应只有 id 没有 code；出现 message
    // 且没有成功 code 时仍应按失败处理。
    if (result.code === undefined && typeof result.message === 'string' && result.message) {
        return result.message;
    }
    return null;
}
