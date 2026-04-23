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

// 自动生成 JWT_SECRET（如果未设置）
if (!process.env.JWT_SECRET) {
  const secret = crypto.randomBytes(64).toString('hex');
  const envPath = path.join(__dirname, '.env');
  let envContent = '';
  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, 'utf-8');
    envContent = envContent.replace(/^JWT_SECRET=.*$/m, `JWT_SECRET=${secret}`);
    if (!envContent.includes('JWT_SECRET=')) {
      envContent += `\nJWT_SECRET=${secret}\n`;
    }
  } else {
    envContent = `JWT_SECRET=${secret}\n`;
  }
  fs.writeFileSync(envPath, envContent, 'utf-8');
  process.env.JWT_SECRET = secret;
  console.log('✅ JWT_SECRET generated and saved to .env');
}

// 确保 uploads 目录存在
const uploadsDir = path.join(__dirname, 'public', 'uploads', 'avatars');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// 中间件
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 静态文件服务
app.use(express.static(path.join(__dirname, 'public')));

// API 路由
app.use('/api/auth', authRoutes);
app.use('/api/posts', postsRoutes);
app.use('/api/comments', commentsRoutes);
app.use('/api/build', buildRoutes);
app.use('/api/pages', pagesRoutes);
app.use('/api/settings', settingsRoutes);

// SPA fallback — 所有非 API 路由返回 index.html
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api/')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

// 错误处理
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: '服务器内部错误', message: err.message });
});

// 启动
async function start() {
  try {
    await initDatabase();
    await ensureSetupToken();

    app.listen(PORT, () => {
      console.log(`\n🌸 Mizuki Admin Dashboard`);
      console.log(`   http://localhost:${PORT}`);
      console.log(`   Blog dir: ${process.env.BLOG_DIR || '(not configured)'}\n`);
    });
  } catch (err) {
    console.error('❌ 启动失败:', err.message);
    process.exit(1);
  }
}

start();
