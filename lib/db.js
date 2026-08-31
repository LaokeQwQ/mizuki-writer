import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const pool = new pg.Pool({
    host: process.env.PG_HOST || 'localhost',
    port: parseInt(process.env.PG_PORT || '5432'),
    database: process.env.PG_DATABASE || 'mizuki_admin',
    user: process.env.PG_USER || 'mizuki_write',
    password: process.env.PG_PASSWORD || undefined,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    ssl: process.env.PG_SSL === 'true'
        ? { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED !== 'false' }
        : undefined,
});

// 自动建表
export async function initDatabase() {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(64) UNIQUE NOT NULL,
                nickname VARCHAR(64),
                password_hash TEXT NOT NULL,
                avatar VARCHAR(512) DEFAULT '',
                role VARCHAR(16) DEFAULT 'admin',
                created_at TIMESTAMPTZ DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS login_history (
                id SERIAL PRIMARY KEY,
                username VARCHAR(64) NOT NULL,
                ip VARCHAR(64),
                user_agent TEXT DEFAULT '',
                success BOOLEAN DEFAULT true,
                created_at TIMESTAMPTZ DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS operation_logs (
                id SERIAL PRIMARY KEY,
                username VARCHAR(64),
                action VARCHAR(128) NOT NULL,
                detail TEXT DEFAULT '',
                ip VARCHAR(64),
                created_at TIMESTAMPTZ DEFAULT NOW()
            );

            CREATE INDEX IF NOT EXISTS idx_login_history_created ON login_history(created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_operation_logs_created ON operation_logs(created_at DESC);
        `);

        // 迁移：如果 .env 中有旧的单用户配置，且 users 表为空，则导入
        const { rows } = await client.query('SELECT COUNT(*) as cnt FROM users');
        if (parseInt(rows[0].cnt) === 0 && process.env.ADMIN_PASSWORD_HASH) {
            const username = process.env.ADMIN_USERNAME || 'admin';
            await client.query(
                'INSERT INTO users (username, nickname, password_hash, role) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
                [username, username, process.env.ADMIN_PASSWORD_HASH, 'admin']
            );
            console.log(`✅ 已将 .env 中的管理员 "${username}" 迁移到数据库`);
        }

        console.log('✅ 数据库表初始化完成');
    } finally {
        client.release();
    }
}

export default pool;
