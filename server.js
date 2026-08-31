import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

import { initDatabase } from './lib/db.js';
import authRoutes, { ensureSetupToken } from './routes/auth.js';
import postsRoutes from './routes/posts.js';
import commentsRoutes from './routes/comments.js';
import buildRoutes from './routes/build.js';
import pagesRoutes from './routes/pages.js';
import settingsRoutes from './routes/settings.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '127.0.0.1';

app.disable('x-powered-by');
const trustProxy = process.env.TRUST_PROXY === 'true'
  ? 1
  : Number.isInteger(Number(process.env.TRUST_PROXY)) && Number(process.env.TRUST_PROXY) > 0
    ? Number(process.env.TRUST_PROXY)
    : false;
app.set('trust proxy', trustProxy);

// Never persist a generated secret to the repository. Production deployments must
// provide a stable secret so restarting the process does not invalidate sessions.
if (!process.env.JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error('❌ 生产环境必须配置 JWT_SECRET');
    process.exit(1);
  }
  const secret = crypto.randomBytes(64).toString('hex');
  process.env.JWT_SECRET = secret;
  console.warn('⚠️  未配置 JWT_SECRET，当前开发进程使用临时密钥（重启后令牌失效）');
}

// 确保 uploads 目录存在
const uploadsDir = path.join(__dirname, 'public', 'uploads', 'avatars');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// 中间件
const corsOrigin = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean)
  : null;
if (corsOrigin?.length) {
  app.use(cors({ origin: corsOrigin, credentials: false }));
}
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; connect-src 'self' https://v1.hitokoto.cn",
  );
  if (process.env.ENABLE_HSTS === 'true') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb', parameterLimit: 1000 }));

// 静态文件服务
app.use(express.static(path.join(__dirname, 'public')));

// API 路由
app.use('/api/auth', authRoutes);
app.use('/api/posts', postsRoutes);
app.use('/api/comments', commentsRoutes);
app.use('/api/build', buildRoutes);
app.use('/api/pages', pagesRoutes);
app.use('/api/settings', settingsRoutes);

// Return a response for unknown API routes instead of leaving the connection open.
app.use('/api', (req, res) => {
  res.status(404).json({ error: '接口不存在' });
});

// SPA fallback — 所有非 API 路由返回 index.html
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api/')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

// 错误处理
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  if (res.headersSent) return next(err);
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: '请求 JSON 格式无效' });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: '请求内容过大' });
  }
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: '上传文件不能超过 5MB' });
  }
  if (err?.name === 'MulterError') {
    return res.status(400).json({ error: '上传文件无效' });
  }
  if (err?.message === '只支持 jpg/png/gif/webp 格式') {
    return res.status(400).json({ error: err.message });
  }
  return res.status(500).json({ error: '服务器内部错误' });
});

// 启动
async function start() {
  try {
    await initDatabase();
    await ensureSetupToken();

    app.listen(PORT, HOST, () => {
      console.log(`\n🌸 Mizuki Admin Dashboard`);
      console.log(`   http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
      console.log(`   Blog dir: ${process.env.BLOG_DIR || '(not configured)'}\n`);
    });
  } catch (err) {
    console.error('❌ 启动失败:', err.message);
    process.exit(1);
  }
}

start();
