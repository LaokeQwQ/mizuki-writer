# Mizuki Writer

一个面向 **Mizuki 博客** 的自托管写作与管理面板。

`Mizuki Writer` 提供文章编辑、评论管理、页面内容管理、结构化数据管理、站点构建和 CDN 刷新能力，适合部署在你自己的服务器上，为基于 **Mizuki + Astro** 的博客提供一套独立后台。

---

## 项目简介

Mizuki 本身是一个偏静态站点的博客主题，而内容往往分散在：

- `src/content/posts`
- `src/content/spec`
- `src/data/*.ts`

这对熟悉 Git 和代码编辑的人很友好，但对日常维护、快速写作、评论处理和页面级内容管理并不够顺手。

`Mizuki Writer` 的目标，就是把这些能力集中到一个独立的后台里：

- 写文章
- 编辑 About / Friends 等说明页
- 管理项目、技能、时间线等结构化展示数据
- 触发博客构建
- 刷新 DogeCloud CDN
- 审核或回复 Twikoo 评论

它不是一个通用 CMS，而是一套**专门为 Mizuki 内容结构设计**的后台。

---

## 核心功能

### 1. 文章管理

- 浏览、搜索、编辑、删除 Markdown / MDX 文章
- 自动读取 frontmatter
- 支持文章预览
- 支持批量删除
- 可直接触发构建和 CDN 刷新

### 2. 页面管理

支持管理以下资源：

- `src/content/spec/about.md`
- `src/content/spec/friends.md`
- `src/data/friends.ts`
- `src/data/projects.ts`
- `src/data/skills.ts`
- `src/data/timeline.ts`

其中：

- Markdown 页面支持正文编辑和预览
- 结构化数据支持条目式 CRUD

### 3. 评论管理

- 接入 Twikoo 后台接口
- 查看评论
- 回复评论
- 删除评论
- 标记垃圾评论

### 4. 构建与发布

- 在后台直接执行博客构建
- 支持读取构建日志
- 支持 DogeCloud CDN 刷新
- 支持单独查看 CDN 操作日志

### 5. 后台用户与审计

- PostgreSQL 存储管理员账户
- 支持用户管理
- 登录日志
- 操作日志

---

## 适用场景

适合以下使用方式：

- 你正在使用 Mizuki 作为博客主题
- 博客部署在自己的服务器上
- 希望通过浏览器维护文章和页面，而不是频繁 SSH 改文件
- 希望把 About / Friends / Projects / Skills / Timeline 等数据也纳入后台管理
- 希望构建和 CDN 刷新可以在一个界面里完成

### 适用性说明

- 适用于 `Pages` / `Vercel` / 纯静态托管后直接在线写作的场景：`x`
- 适用于想把博客部署在自己的服务器上，并希望像 `Typecho` 等传统博客项目一样使用后台，让“写作、管理、构建、发布”这件事不再复杂：`√`

换句话说，`Mizuki Writer` 更偏向一套 **服务器端部署的博客写作工作台**，而不是一个为纯静态托管平台设计的在线 CMS。

---

## 技术栈

### 后端

- Node.js
- Express
- PostgreSQL
- JWT
- bcryptjs
- Multer
- gray-matter
- marked

### 前端

- 原生 HTML / CSS / JavaScript
- Material Symbols（本地化）
- 响应式管理台布局

### 外部服务

- Mizuki 博客项目
- Twikoo 评论系统
- DogeCloud CDN API

---

## 项目原理

`Mizuki Writer` 本身并不直接渲染博客页面，而是作为一个独立后台进程运行。

它通过 `.env` 中的 `BLOG_DIR` 指向你的 Mizuki 博客项目根目录，然后完成以下动作：

### 文章管理原理

- 读取 `BLOG_DIR/src/content/posts`
- 递归收集 `.md` / `.mdx`
- 用 `gray-matter` 解析 frontmatter
- 保存时重新写回 Markdown 文件

### 页面管理原理

- Markdown 页面：直接读写 `src/content/spec/*.md`
- 结构化数据页面：解析 `src/data/*.ts` 中导出的数组
- 保存时做：
  - 基本字段校验
  - 备份原文件
  - 原子写入

### 评论管理原理

- 后台通过 Twikoo API 登录
- 获取 access token
- 再调用管理员接口获取、删除、回复评论

### 构建原理

- 后台在 `BLOG_DIR` 下执行 `pnpm build`
- 捕获构建日志
- 构建完成后可继续调用 DogeCloud 刷新 API

### CDN 刷新原理

- 提交首页 URL
- 自动收集所有文章 URL
- 分批调用 DogeCloud 刷新接口
- 记录操作结果与任务状态

---

## 目录结构

```text
mizuki-writer/
├─ lib/
│  ├─ db.js
│  └─ logger.js
├─ public/
│  ├─ css/
│  ├─ fonts/
│  ├─ js/
│  └─ index.html
├─ routes/
│  ├─ auth.js
│  ├─ build.js
│  ├─ comments.js
│  ├─ pages.js
│  ├─ posts.js
│  └─ settings.js
├─ .env.example
├─ package.json
├─ package-lock.json
├─ server.js
└─ README.md
```

---

## 使用方法

### 1. 安装依赖

```bash
npm ci
```

### 2. 准备环境变量

复制一份环境变量模板：

```bash
cp .env.example .env
```

然后填写你自己的配置。

### 3. 启动开发模式

```bash
npm run dev
```

### 4. 启动生产模式

```bash
npm start
```

---

## 环境变量说明

| 变量名 | 说明 |
|---|---|
| `HOST` | 监听地址，默认 `127.0.0.1`；对外提供服务时应放在 HTTPS 反向代理后并显式设置 |
| `PORT` | 后台端口 |
| `TRUST_PROXY` | 是否信任反向代理并使用代理转发的客户端 IP；`true` 信任一跳，也可填正整数，默认 `false` |
| `CORS_ORIGIN` | 可选的跨域来源白名单，多个来源用逗号分隔；未设置时不启用 CORS |
| `ENABLE_HSTS` | HTTPS 反向代理已验证可用时设为 `true`，为浏览器启用 HSTS |
| `JWT_SECRET` | 登录 JWT 密钥；生产环境必须显式配置，开发环境缺省时仅使用不持久化的临时密钥 |
| `ADMIN_USERNAME` | 默认管理员用户名 |
| `ADMIN_PASSWORD_HASH` | 可选的旧单管理员密码哈希迁移值；常规首次初始化请留空 |
| `BLOG_DIR` | Mizuki 博客项目根目录 |
| `TWIKOO_URL` | Twikoo 服务地址 |
| `ALLOW_INSECURE_TWIKOO` | 是否允许 HTTP Twikoo 地址，仅建议本地开发使用 |
| `TWIKOO_PASSWORD` | Twikoo 管理密码 |
| `SITE_URL` | 站点完整 URL，用于 CDN 刷新 |
| `ALLOW_INSECURE_SITE_URL` | 是否允许 HTTP 站点地址，仅建议本地开发使用 |
| `DOGECLOUD_ACCESS_KEY` | DogeCloud AccessKey |
| `DOGECLOUD_SECRET_KEY` | DogeCloud SecretKey |
| `PG_HOST` | PostgreSQL 主机 |
| `PG_PORT` | PostgreSQL 端口 |
| `PG_DATABASE` | PostgreSQL 数据库名 |
| `PG_USER` | PostgreSQL 用户名 |
| `PG_PASSWORD` | PostgreSQL 密码 |
| `PG_SSL` | 是否启用 PostgreSQL TLS |
| `PG_SSL_REJECT_UNAUTHORIZED` | PostgreSQL TLS 是否校验证书，默认 `true` |

---

## 与 Mizuki 的目录约定

后台默认面向以下 Mizuki 结构：

### 文章

```text
src/content/posts/
```

### 说明页

```text
src/content/spec/about.md
src/content/spec/friends.md
```

### 页面结构化数据

```text
src/data/friends.ts
src/data/projects.ts
src/data/skills.ts
src/data/timeline.ts
```

如果你的项目结构不同，需要自行调整对应路由逻辑。

---

## 安全说明

### 强烈建议

- 不要把任何 `.env.*` 配置文件提交到仓库（`.env.example` 除外）
- 不要在仓库里保留真实的 Twikoo 密码、数据库密码、DogeCloud 密钥
- 若任何密钥曾在日志、聊天、截图或历史提交中暴露，请立即轮换

### 已内置的基础安全措施

- JWT 登录鉴权
- 登录限流
- 后台用户信息存储于 PostgreSQL
- 操作日志记录
- 路径遍历防护
- 结构化页面资源写入前校验
- 受限的页面数据字面量解析（不会执行博客源码）
- Markdown 预览中的原始 HTML 和危险链接过滤
- 生产环境不自动把 JWT 密钥写入磁盘

---

## DogeCloud CDN 注意事项

如果启用 DogeCloud 刷新：

- `SITE_URL` 必须与当前账号下已接入且 `online` 的加速域名一致
- 刷新请求使用表单编码
- 含中文 slug 的文章 URL 会先做编码

如果返回类似：

```text
提交的 URL 中没有找到属于你的域名
```

优先检查：

- 域名是否在当前账号下
- 域名是否为 `online`
- `SITE_URL` 是否与接入域名完全一致

---

## Twikoo 评论说明

评论管理依赖：

- `TWIKOO_URL`
- `TWIKOO_PASSWORD`

未配置时，后台评论模块会以“未配置”状态运行，而不是直接崩溃。

---

## 部署方式

推荐的部署方式一共三种：

### 1. PM2 管理器（推荐）

这是最推荐的方式，适合大多数自部署博客场景。

优点：

- 易于守护进程
- 支持重启、查看日志、开机自启
- 和博客站点一起部署时维护成本低

示例：

```bash
npm ci --omit=dev
pm2 start server.js --name mizuki-writer
pm2 save
```

### 2. screen 部署

适合轻量使用，或者你只是想先快速跑起来测试。

示例思路：

```bash
npm ci --omit=dev
screen -S mizuki-writer
node server.js
```

然后使用：

- `Ctrl + A` 再按 `D` 退出到后台
- `screen -r mizuki-writer` 重新进入会话

这种方式简单直接，但不如 PM2 适合长期维护。

### 3. 其他进程管理器

如果你已经有自己的运行体系，也可以使用其他进程管理方式，例如：

- `systemd`
- `supervisor`
- 容器编排环境中的进程守护方案

只要能够稳定运行：

```bash
node server.js
```

并正确配置环境变量、日志和自启动即可。

---

## 为什么叫 Mizuki Writer

因为它更像一个围绕 Mizuki 内容模型构建的“写作与管理工作台”，而不是一个传统意义上的大而全 CMS。

它更专注于：

- 博客写作
- 页面维护
- 展示数据管理
- 构建发布闭环

---

## 未来方向

后续可以继续扩展的方向包括：

- 媒体资源上传与统一管理
- 更细粒度的页面 schema 编辑器
- 站点设置与 `src/config.ts` 的结构化管理
- 评论审核规则
- 多用户权限分层
- 内容版本历史

---

## 许可证

当前仓库未附带独立许可证文件。  
如需开源发布，建议在发布前补充明确的 License。
