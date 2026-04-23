import pool from './db.js';

/**
 * 记录操作日志
 */
export async function logAction(action, detail = '', username = 'system', ip = '') {
    try {
        await pool.query(
            'INSERT INTO operation_logs (username, action, detail, ip) VALUES ($1, $2, $3, $4)',
            [username, action, detail, ip]
        );
    } catch (err) {
        console.error('日志记录失败:', err.message);
    }
}

/**
 * 记录登录历史
 */
export async function logLogin(username, ip, userAgent = '', success = true) {
    try {
        await pool.query(
            'INSERT INTO login_history (username, ip, user_agent, success) VALUES ($1, $2, $3, $4)',
            [username, ip, userAgent, success]
        );
    } catch (err) {
        console.error('登录日志记录失败:', err.message);
    }
}

/**
 * 获取操作日志（分页）
 */
export async function getLogs(page = 0, pageSize = 30) {
    const offset = page * pageSize;
    const [logs, count] = await Promise.all([
        pool.query(
            'SELECT id, username, action, detail, ip, created_at FROM operation_logs ORDER BY created_at DESC LIMIT $1 OFFSET $2',
            [pageSize, offset]
        ),
        pool.query('SELECT COUNT(*) as cnt FROM operation_logs'),
    ]);
    return { logs: logs.rows, total: parseInt(count.rows[0].cnt) };
}

/**
 * 获取登录历史（分页）
 */
export async function getLoginHistory(page = 0, pageSize = 30) {
    const offset = page * pageSize;
    const [logs, count] = await Promise.all([
        pool.query(
            'SELECT id, username, ip, user_agent, success, created_at FROM login_history ORDER BY created_at DESC LIMIT $1 OFFSET $2',
            [pageSize, offset]
        ),
        pool.query('SELECT COUNT(*) as cnt FROM login_history'),
    ]);
    return { logs: logs.rows, total: parseInt(count.rows[0].cnt) };
}
