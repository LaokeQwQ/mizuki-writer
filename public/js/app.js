/* ============================================
   Mizuki Admin — Core Application
   ============================================ */

const API_BASE = '/api';

// ─── State ─────────────────────────────
let token = localStorage.getItem('mizuki_token') || null;
let currentRoute = 'dashboard';
let postsCache = [];
let metaCache = { tags: [], categories: [] };
let userProfile = null; // { username, nickname, avatar }
let selectedPosts = new Set(); // 批量选择
let managedPagesMeta = [];
let currentManagedPage = null;
let managedPagePreviewVisible = false;
let managedPagesEventsBound = false;
let managedCollectionItems = [];
let currentManagedCollectionIndex = -1;
let managedPagesDirty = false;
let managedPageRequestId = 0;

// ─── API Helper ────────────────────────
async function api(endpoint, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...options.headers };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(`${API_BASE}${endpoint}`, {
        ...options,
        headers,
    });

    if (res.status === 401) {
        token = null;
        localStorage.removeItem('mizuki_token');
        showAuth();
        throw new Error('未授权');
    }

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '请求失败');
    return data;
}

// ─── Toast ─────────────────────────────
function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `
    <span class="material-symbols-rounded" style="font-size:20px">
      ${type === 'success' ? 'check_circle' : type === 'error' ? 'error' : 'info'}
    </span>
    ${escapeHtml(message)}
  `;
    container.appendChild(toast);
    setTimeout(() => {
        toast.classList.add('toast-out');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// ─── Confirm Dialog ────────────────────
function showConfirm(title, message) {
    return new Promise((resolve) => {
        const overlay = document.getElementById('confirm-dialog');
        document.getElementById('confirm-title').textContent = title;
        document.getElementById('confirm-message').textContent = message;
        overlay.classList.remove('hidden');

        const onOk = () => { cleanup(); resolve(true); };
        const onCancel = () => { cleanup(); resolve(false); };
        const cleanup = () => {
            overlay.classList.add('hidden');
            document.getElementById('confirm-ok').removeEventListener('click', onOk);
            document.getElementById('confirm-cancel').removeEventListener('click', onCancel);
        };

        document.getElementById('confirm-ok').addEventListener('click', onOk);
        document.getElementById('confirm-cancel').addEventListener('click', onCancel);
    });
}

// ─── Auth ──────────────────────────────
async function checkAuth() {
    try {
        const data = await api('/auth/check');
        if (data.needsSetup) {
            showAuth('setup');
        } else if (data.loggedIn) {
            showApp();
        } else {
            showAuth('login');
        }
    } catch {
        showAuth('login');
    }
}

function showAuth(mode = 'login') {
    document.getElementById('auth-screen').classList.remove('hidden');
    document.getElementById('app').classList.add('hidden');

    const setupForm = document.getElementById('setup-form');
    const loginForm = document.getElementById('login-form');

    if (mode === 'setup') {
        setupForm.classList.remove('hidden');
        loginForm.classList.add('hidden');
    } else {
        setupForm.classList.add('hidden');
        loginForm.classList.remove('hidden');
    }
}

function showApp() {
    document.getElementById('auth-screen').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    navigateToHash();
    loadDashboard();
}

function showAuthError(msg) {
    const el = document.getElementById('auth-error');
    el.textContent = msg;
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), 3000);
}

// Auth forms
document.getElementById('setup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const setupToken = document.getElementById('setup-token').value.trim();
    const username = document.getElementById('setup-username').value.trim();
    const password = document.getElementById('setup-password').value;
    const confirm = document.getElementById('setup-password-confirm').value;

    if (!setupToken) return showAuthError('请输入安全令牌（查看服务器日志 pm2 logs）');
    if (password.length < 6) return showAuthError('密码至少6位');
    if (password !== confirm) return showAuthError('两次密码不一致');

    try {
        const data = await api('/auth/setup', {
            method: 'POST',
            body: JSON.stringify({ token: setupToken, username, password }),
        });
        token = data.token;
        localStorage.setItem('mizuki_token', token);
        showApp();
        showToast('设置完成，欢迎使用！', 'success');
    } catch (err) {
        showAuthError(err.message);
    }
});

document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;

    try {
        const data = await api('/auth/login', {
            method: 'POST',
            body: JSON.stringify({ username, password }),
        });
        token = data.token;
        localStorage.setItem('mizuki_token', token);
        // 缓存用户信息
        if (data.nickname || data.avatar) {
            userProfile = { nickname: data.nickname, avatar: data.avatar };
        }
        showApp();
        showToast('登录成功 👋', 'success');
    } catch (err) {
        showAuthError(err.message);
    }
});

// Logout
document.getElementById('btn-logout').addEventListener('click', () => {
    token = null;
    localStorage.removeItem('mizuki_token');
    userProfile = null;
    showAuth('login');
    showToast('已退出登录');
});

document.getElementById('btn-mobile-logout').addEventListener('click', () => {
    token = null;
    localStorage.removeItem('mizuki_token');
    userProfile = null;
    showAuth('login');
});

// ─── Routing ───────────────────────────
function navigateToHash() {
    const hash = window.location.hash.slice(1) || '/';
    let route = 'dashboard';
    let param = null;

    if (hash === '/' || hash === '') route = 'dashboard';
    else if (hash === '/posts') route = 'posts';
    else if (hash === '/new') route = 'new';
    else if (hash.startsWith('/edit/')) {
        route = 'edit';
        try {
            param = decodeURIComponent(hash.slice(6));
        } catch {
            route = 'dashboard';
        }
    }
    else if (hash === '/pages') route = 'pages';
    else if (hash.startsWith('/pages/')) {
        route = 'pages';
        try {
            param = decodeURIComponent(hash.slice(7));
        } catch {
            route = 'pages';
            param = null;
        }
    }
    else if (hash === '/comments') route = 'comments';
    else if (hash === '/build') route = 'build';
    else if (hash === '/settings') route = 'settings';

    switchPage(route, param);
}

window.addEventListener('hashchange', navigateToHash);

let currentPageEl = null;

function switchPage(route, param = null) {
    currentRoute = route;

    // Update nav active state
    document.querySelectorAll('.nav-item[data-route]').forEach(n => {
        n.classList.remove('active');
        const nr = n.dataset.route;
        if (nr === route || (nr === 'new' && route === 'edit')) {
            n.classList.add('active');
        }
    });

    // Determine target page
    let targetId;
    switch (route) {
        case 'dashboard': targetId = 'page-dashboard'; break;
        case 'posts': targetId = 'page-posts'; break;
        case 'new': case 'edit': targetId = 'page-editor'; break;
        case 'pages': targetId = 'page-pages'; break;
        case 'comments': targetId = 'page-comments'; break;
        case 'build': targetId = 'page-build'; break;
        case 'settings': targetId = 'page-settings'; break;
        default: targetId = 'page-dashboard';
    }
    const targetEl = document.getElementById(targetId);

    // Animate transition
    const allPages = document.querySelectorAll('.page');
    allPages.forEach(p => {
        if (p !== targetEl && p !== currentPageEl) {
            p.style.display = 'none';
            p.classList.remove('page-exit');
        }
    });

    if (currentPageEl && currentPageEl !== targetEl) {
        currentPageEl.classList.add('page-exit');
        const exitPage = currentPageEl;
        exitPage.addEventListener('animationend', () => {
            exitPage.style.display = 'none';
            exitPage.classList.remove('page-exit');
        }, { once: true });
    }

    targetEl.style.display = '';
    targetEl.classList.remove('hidden', 'page-exit');
    targetEl.style.animation = 'none';
    requestAnimationFrame(() => {
        targetEl.style.animation = '';
    });
    currentPageEl = targetEl;

    // Load data
    switch (route) {
        case 'dashboard': loadDashboard(); break;
        case 'posts': loadPosts(); break;
        case 'new': initEditor(); break;
        case 'edit': initEditor(param); break;
        case 'pages': loadManagedPages(param); break;
        case 'comments': loadComments(); break;
        case 'build': loadBuildStatus(); break;
        case 'settings': loadSettings(); break;
    }
}

// ─── Time-based Greeting ───────────────
function getGreeting() {
    const hour = new Date().getHours();
    if (hour >= 5 && hour < 11) return '早上好';
    if (hour >= 11 && hour < 13) return '中午好';
    if (hour >= 13 && hour < 18) return '下午好';
    return '晚上好';
}

// ─── Hitokoto API ──────────────────────
async function loadHitokoto() {
    const el = document.getElementById('welcome-hitokoto');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
        const res = await fetch('https://v1.hitokoto.cn?c=a&c=b&c=c&c=d&c=k&encode=json', { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const from = data.from ? ` —— ${data.from}` : '';
        el.textContent = `「${data.hitokoto}」${from}`;
    } catch {
        el.textContent = '「代码就是诗，Bug 就是人生。」';
    } finally {
        clearTimeout(timeout);
    }
}

// ─── Dashboard ─────────────────────────
async function loadDashboard() {
    try {
        // 加载用户信息
        if (!userProfile) {
            try {
                userProfile = await api('/auth/profile');
            } catch { userProfile = { nickname: '管理员', avatar: '' }; }
        }

        // 更新欢迎区域
        const greeting = getGreeting();
        const nickname = userProfile.nickname || userProfile.username || '管理员';
        document.getElementById('welcome-greeting').innerHTML =
            `${greeting}，<strong>${escapeHtml(nickname)}</strong>`;

        // 头像
        const avatarEl = document.getElementById('welcome-avatar');
        const avatarSrc = safeImageUrl(userProfile.avatar);
        if (avatarSrc) {
            avatarEl.innerHTML = `<img src="${escapeAttr(avatarSrc)}" alt="avatar">`;
        } else {
            avatarEl.innerHTML = `<span class="material-symbols-rounded">person</span>`;
        }

        // 一言
        loadHitokoto();

        // 加载文章数据
        const [postsData, metaData] = await Promise.all([
            api('/posts'),
            api('/posts/meta/tags-categories').catch(() => ({ tags: [], categories: [] })),
        ]);

        postsCache = postsData.posts;
        metaCache = metaData;

        document.getElementById('stat-posts').textContent = postsData.total;
        document.getElementById('stat-drafts').textContent = postsData.posts.filter(p => p.draft).length;
        document.getElementById('stat-tags').textContent = metaData.tags?.length || 0;
        document.getElementById('stat-categories').textContent = metaData.categories?.length || 0;

        // Recent posts
        const recent = postsData.posts.slice(0, 8);
        const container = document.getElementById('recent-posts');
        if (recent.length === 0) {
            container.innerHTML = `
        <div class="empty-state">
          <span class="material-symbols-rounded">edit_note</span>
          <p>还没有文章，开始写一篇吧！</p>
        </div>`;
            return;
        }

        container.innerHTML = recent.map(post => `
      <div class="recent-post-item" data-post-open="${escapeAttr(post.slug)}" role="button" tabindex="0">
        <div class="recent-post-info">
          <span class="material-symbols-rounded">article</span>
          <span class="recent-post-title">${escapeHtml(post.title)}</span>
          ${post.draft ? '<span class="draft-badge">草稿</span>' : ''}
          ${post.pinned ? '<span class="pinned-badge">置顶</span>' : ''}
        </div>
        <span class="recent-post-date">${formatDate(post.published)}</span>
      </div>
    `).join('');
        bindPostOpenEvents(container);
    } catch (err) {
        showToast('加载仪表盘失败: ' + err.message, 'error');
    }
}

// ─── Posts List ────────────────────────
async function loadPosts() {
    try {
        if (postsCache.length === 0) {
            const data = await api('/posts');
            postsCache = data.posts;
        }
        selectedPosts.clear();
        updateBatchDeleteBtn();
        renderPostsTable(postsCache);
    } catch (err) {
        showToast('加载文章列表失败: ' + err.message, 'error');
    }
}

function renderPostsTable(posts) {
    const container = document.getElementById('posts-list');

    if (posts.length === 0) {
        container.innerHTML = `
      <div class="empty-state">
        <span class="material-symbols-rounded">edit_note</span>
        <p>暂无文章</p>
      </div>`;
        return;
    }

    container.innerHTML = `
    <table class="posts-table">
      <thead>
        <tr>
          <th class="cb-col"><input type="checkbox" id="select-all-posts" title="全选"></th>
          <th>标题</th>
          <th>日期</th>
          <th>分类</th>
          <th>标签</th>
          <th>状态</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        ${posts.map(post => `
          <tr>
            <td class="cb-col"><input type="checkbox" class="post-checkbox" data-slug="${escapeAttr(post.slug)}" ${selectedPosts.has(post.slug) ? 'checked' : ''}></td>
            <td class="post-title-cell">
              <span class="post-title-link" data-post-open="${escapeAttr(post.slug)}" role="button" tabindex="0">${escapeHtml(post.title)}</span>
            </td>
            <td>${formatDate(post.published)}</td>
            <td>${post.category ? `<span class="category-chip">${escapeHtml(post.category)}</span>` : '-'}</td>
            <td>${(post.tags || []).map(t => `<span class="tag-chip">${escapeHtml(t)}</span>`).join('') || '-'}</td>
            <td>
              ${post.draft ? '<span class="draft-badge">草稿</span>' : '<span class="pinned-badge" style="background:var(--md-success-container);color:var(--md-success)">已发布</span>'}
              ${post.pinned ? '<span class="pinned-badge">置顶</span>' : ''}
            </td>
            <td class="post-actions">
              <button class="icon-btn" title="编辑" data-post-open="${escapeAttr(post.slug)}">
                <span class="material-symbols-rounded">edit</span>
              </button>
              <button class="icon-btn btn-danger" title="删除" data-post-delete="${escapeAttr(post.slug)}">
                <span class="material-symbols-rounded">delete</span>
              </button>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;

    // 全选
    container.querySelector('#select-all-posts').addEventListener('change', (e) => {
        const checkboxes = container.querySelectorAll('.post-checkbox');
        checkboxes.forEach(cb => {
            cb.checked = e.target.checked;
            if (e.target.checked) selectedPosts.add(cb.dataset.slug);
            else selectedPosts.delete(cb.dataset.slug);
        });
        updateBatchDeleteBtn();
    });

    // 单选
    container.querySelectorAll('.post-checkbox').forEach(cb => {
        cb.addEventListener('change', (e) => {
            if (e.target.checked) selectedPosts.add(e.target.dataset.slug);
            else selectedPosts.delete(e.target.dataset.slug);
            updateBatchDeleteBtn();
        });
    });

    bindPostOpenEvents(container);
    container.querySelectorAll('[data-post-delete]').forEach((button) => {
        button.addEventListener('click', () => window.deletePost(button.dataset.postDelete));
    });
}

function openPost(slug) {
    if (typeof slug !== 'string' || !slug) return;
    location.hash = `#/edit/${encodeURIComponent(slug)}`;
}

function bindPostOpenEvents(container) {
    container.querySelectorAll('[data-post-open]').forEach((element) => {
        const open = () => openPost(element.dataset.postOpen);
        element.addEventListener('click', open);
        element.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                open();
            }
        });
    });
}

function updateBatchDeleteBtn() {
    const btn = document.getElementById('btn-batch-delete');
    const count = document.getElementById('batch-delete-count');
    if (selectedPosts.size > 0) {
        btn.classList.remove('hidden');
        count.textContent = `批量删除 (${selectedPosts.size})`;
    } else {
        btn.classList.add('hidden');
    }
}

// Batch delete button
document.getElementById('btn-batch-delete').addEventListener('click', async () => {
    if (selectedPosts.size === 0) return;
    const confirmed = await showConfirm(
        '批量删除',
        `确定要删除选中的 ${selectedPosts.size} 篇文章吗？此操作不可撤销。`
    );
    if (!confirmed) return;
    try {
        const result = await api('/posts/batch-delete', {
            method: 'POST',
            body: JSON.stringify({ slugs: [...selectedPosts] }),
        });
        postsCache = postsCache.filter(p => !result.deleted.includes(p.slug));
        selectedPosts.clear();
        updateBatchDeleteBtn();
        renderPostsTable(postsCache);
        showToast(`已删除 ${result.deleted.length} 篇文章`, 'success');
        if (result.errors.length > 0) {
            showToast(`${result.errors.length} 篇删除失败`, 'error');
        }
    } catch (err) {
        showToast('批量删除失败: ' + err.message, 'error');
    }
});

// Search
document.getElementById('posts-search').addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase().trim();
    if (!query) return renderPostsTable(postsCache);
    const filtered = postsCache.filter(p =>
        p.title.toLowerCase().includes(query) ||
        p.category?.toLowerCase().includes(query) ||
        (p.tags || []).some(t => t.toLowerCase().includes(query))
    );
    renderPostsTable(filtered);
});

// Delete post
window.deletePost = async function (slug) {
    const confirmed = await showConfirm('删除文章', `确定要删除 "${slug}" 吗？此操作不可撤销。`);
    if (!confirmed) return;
    try {
        await api(`/posts/${encodeURIComponent(slug)}`, { method: 'DELETE' });
        postsCache = postsCache.filter(p => p.slug !== slug);
        renderPostsTable(postsCache);
        showToast('文章已删除', 'success');
    } catch (err) {
        showToast('删除失败: ' + err.message, 'error');
    }
};

// ─── Build ─────────────────────────────
let buildPollInterval = null;

async function loadBuildStatus() {
    try {
        const data = await api('/build/status');
        updateBuildUI(data);
        updateCdnUI(data);
        if (data.building || data.cdnRefreshing) startBuildPolling();
    } catch (err) {
        // Ignore
    }
}

function updateBuildUI(data) {
    const icon = document.getElementById('build-icon');
    const text = document.getElementById('build-status-text');
    const time = document.getElementById('build-last-time');
    const log = document.getElementById('build-log');
    const btn = document.getElementById('btn-build');

    icon.className = 'material-symbols-rounded build-icon';

    if (data.building) {
        icon.textContent = 'sync';
        icon.classList.add('building');
        text.textContent = '构建中…';
        btn.disabled = true;
        btn.innerHTML = '<span class="material-symbols-rounded">hourglass_top</span> 构建中…';
    } else {
        btn.disabled = false;
        btn.innerHTML = '<span class="material-symbols-rounded">play_arrow</span> 开始构建';
        if (data.lastResult === 'success') {
            icon.textContent = 'check_circle';
            icon.classList.add('success');
            text.textContent = '构建成功';
        } else if (data.lastResult === 'failed' || data.lastResult === 'error') {
            icon.textContent = 'error';
            icon.classList.add('failed');
            text.textContent = '构建失败';
        } else {
            icon.textContent = 'rocket_launch';
            text.textContent = '就绪';
        }
    }

    time.textContent = data.lastBuild ? `上次构建: ${new Date(data.lastBuild).toLocaleString('zh-CN')}` : '尚无构建记录';
    if (data.log) log.textContent = data.log;
}

function updateCdnUI(data) {
    const icon = document.getElementById('cdn-icon');
    const text = document.getElementById('cdn-status-text');
    const detail = document.getElementById('cdn-status-detail');
    const cdnLog = document.getElementById('cdn-log');
    const cdnBtn = document.getElementById('btn-cdn-refresh');

    icon.className = 'material-symbols-rounded cdn-icon';

    if (data.cdnRefreshing) {
        icon.textContent = 'cloud_sync';
        icon.classList.add('refreshing');
        text.textContent = '正在刷新 CDN…';
        detail.textContent = '请稍候';
        cdnBtn.disabled = true;
    } else if (data.cdnResult === 'success') {
        icon.textContent = 'cloud_done';
        icon.classList.add('success');
        text.textContent = 'CDN 刷新完成';
        detail.textContent = '缓存已更新';
        cdnBtn.disabled = false;
    } else if (data.cdnResult === 'failed') {
        icon.textContent = 'cloud_off';
        icon.classList.add('failed');
        text.textContent = 'CDN 刷新失败';
        detail.textContent = '请查看日志';
        cdnBtn.disabled = false;
    } else if (data.cdnResult === 'skipped') {
        icon.textContent = 'cloud_off';
        icon.classList.add('skipped');
        text.textContent = 'CDN 已跳过';
        detail.textContent = '未配置多吉云密钥';
        cdnBtn.disabled = false;
    } else {
        icon.textContent = 'cloud_sync';
        text.textContent = 'CDN 就绪';
        detail.textContent = '构建成功后将自动刷新';
        cdnBtn.disabled = false;
    }

    if (data.cdnLog) cdnLog.textContent = data.cdnLog;
}

function startBuildPolling() {
    if (buildPollInterval) return;
    buildPollInterval = setInterval(async () => {
        try {
            const data = await api('/build/status');
            updateBuildUI(data);
            updateCdnUI(data);
            if (!data.building && !data.cdnRefreshing) {
                clearInterval(buildPollInterval);
                buildPollInterval = null;
                if (data.lastResult === 'success') {
                    if (data.cdnResult === 'success') {
                        showToast('构建完成，CDN 已刷新！', 'success');
                    } else if (data.cdnResult === 'skipped') {
                        showToast('构建完成（CDN 未配置，已跳过）', 'success');
                    } else if (data.cdnResult === 'failed') {
                        showToast('构建完成，但 CDN 刷新失败', 'error');
                    } else {
                        showToast('构建完成！', 'success');
                    }
                } else {
                    showToast('构建失败，请查看日志', 'error');
                }
            }
        } catch {
            clearInterval(buildPollInterval);
            buildPollInterval = null;
        }
    }, 2000);
}

document.getElementById('btn-build').addEventListener('click', async () => {
    const autoCdn = document.getElementById('auto-cdn').checked;
    try {
        await api('/build', {
            method: 'POST',
            body: JSON.stringify({ autoCdn }),
        });
        showToast('构建已启动' + (autoCdn ? '，完成后将刷新 CDN' : ''), 'success');
        loadBuildStatus();
        startBuildPolling();
    } catch (err) {
        showToast(err.message, 'error');
    }
});

// 手动刷新 CDN
document.getElementById('btn-cdn-refresh').addEventListener('click', async () => {
    try {
        document.getElementById('btn-cdn-refresh').disabled = true;
        const result = await api('/build/cdn-refresh', { method: 'POST' });
        if (result.cdnResult === 'skipped') {
            showToast('CDN 未配置：请在 .env 中设置 SITE_URL 和多吉云密钥', 'error');
        } else if (result.cdnResult === 'failed') {
            showToast('CDN 刷新失败，请查看日志', 'error');
        } else {
            showToast('CDN 刷新已触发', 'success');
        }
        loadBuildStatus();
    } catch (err) {
        showToast('CDN 刷新失败: ' + err.message, 'error');
        document.getElementById('btn-cdn-refresh').disabled = false;
    }
});

// ─── Auto-build helper (called from editor.js) ─────
window.triggerBuildAndCdn = async function () {
    try {
        await api('/build', {
            method: 'POST',
            body: JSON.stringify({ autoCdn: true }),
        });
        showToast('构建已启动，完成后将刷新 CDN', 'success');
        location.hash = '#/build';
        startBuildPolling();
    } catch (err) {
        showToast(err.message, 'error');
    }
};

// ─── Managed Pages ─────────────────────
const MANAGED_COLLECTION_SCHEMAS = {
    'friends-data': {
        idField: 'id',
        titleField: 'title',
        singularLabel: '友链',
        collectionLabel: '友链列表',
        createDefault(items) {
            const maxId = items.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0);
            return {
                id: maxId + 1,
                title: '',
                imgurl: '',
                desc: '',
                siteurl: 'https://',
                tags: [],
            };
        },
        getListLabel(item) {
            return item.title || `友链 #${item.id || ''}`;
        },
        getListMeta(item) {
            return item.siteurl || '未填写站点地址';
        },
        fields: [
            { key: 'id', label: 'ID', type: 'number', required: true },
            { key: 'title', label: '站名', type: 'text', required: true },
            { key: 'siteurl', label: '域名', type: 'url', required: true, help: '建议填写 HTTPS 链接' },
            { key: 'imgurl', label: '头像链接', type: 'url', required: true, help: '支持 https:// 或 /assets/... 形式' },
            { key: 'desc', label: '描述', type: 'textarea', required: true, rows: 4, fullWidth: true },
            { key: 'tags', label: '标签', type: 'string-list', help: '每行一个标签，也支持逗号分隔', fullWidth: true },
        ],
    },
    'projects-data': {
        idField: 'id',
        titleField: 'title',
        singularLabel: '项目',
        collectionLabel: '项目列表',
        createDefault() {
            return {
                id: `project-${Date.now()}`,
                title: '',
                description: '',
                image: '',
                category: 'web',
                techStack: [],
                status: 'planned',
                liveDemo: '',
                sourceCode: '',
                visitUrl: '',
                startDate: new Date().toISOString().slice(0, 10),
                endDate: '',
                featured: false,
                tags: [],
                showImage: true,
            };
        },
        getListLabel(item) {
            return item.title || item.id || '未命名项目';
        },
        getListMeta(item) {
            return [item.category, item.status].filter(Boolean).join(' · ');
        },
        fields: [
            { key: 'id', label: '项目 ID', type: 'text', required: true },
            { key: 'title', label: '项目标题', type: 'text', required: true },
            { key: 'category', label: '分类', type: 'select', required: true, options: [
                { value: 'web', label: 'Web' },
                { value: 'mobile', label: 'Mobile' },
                { value: 'desktop', label: 'Desktop' },
                { value: 'other', label: 'Other' },
            ] },
            { key: 'status', label: '状态', type: 'select', required: true, options: [
                { value: 'completed', label: '已完成' },
                { value: 'in-progress', label: '进行中' },
                { value: 'planned', label: '计划中' },
            ] },
            { key: 'image', label: '封面图', type: 'url', help: '支持 https:// 或 /assets/... 形式', fullWidth: true },
            { key: 'description', label: '项目描述', type: 'textarea', required: true, rows: 4, fullWidth: true },
            { key: 'techStack', label: '技术栈', type: 'string-list', required: true, help: '每行一个技术名', fullWidth: true },
            { key: 'tags', label: '标签', type: 'string-list', help: '每行一个标签', fullWidth: true },
            { key: 'sourceCode', label: '源码地址', type: 'url' },
            { key: 'visitUrl', label: '访问地址', type: 'url' },
            { key: 'liveDemo', label: '演示地址', type: 'url' },
            { key: 'startDate', label: '开始日期', type: 'date', required: true },
            { key: 'endDate', label: '结束日期', type: 'date' },
            { key: 'featured', label: '精选项目', type: 'checkbox' },
            { key: 'showImage', label: '显示图片', type: 'checkbox' },
        ],
    },
    'skills-data': {
        idField: 'id',
        titleField: 'name',
        singularLabel: '技能',
        collectionLabel: '技能列表',
        createDefault() {
            return {
                id: `skill-${Date.now()}`,
                name: '',
                description: '',
                icon: '',
                category: 'frontend',
                level: 'beginner',
                experience: { years: 0, months: 0 },
                projects: [],
                certifications: [],
                color: '#3B82F6',
            };
        },
        getListLabel(item) {
            return item.name || item.id || '未命名技能';
        },
        getListMeta(item) {
            return [item.category, item.level].filter(Boolean).join(' · ');
        },
        fields: [
            { key: 'id', label: '技能 ID', type: 'text', required: true },
            { key: 'name', label: '技能名称', type: 'text', required: true },
            { key: 'icon', label: '图标名', type: 'text', required: true, help: '例如 logos:javascript' },
            { key: 'color', label: '主题色', type: 'text', help: '例如 #F7DF1E' },
            { key: 'category', label: '分类', type: 'select', required: true, options: [
                { value: 'frontend', label: '前端' },
                { value: 'backend', label: '后端' },
                { value: 'database', label: '数据库' },
                { value: 'tools', label: '工具' },
                { value: 'other', label: '其他' },
            ] },
            { key: 'level', label: '熟练度', type: 'select', required: true, options: [
                { value: 'beginner', label: 'Beginner' },
                { value: 'intermediate', label: 'Intermediate' },
                { value: 'advanced', label: 'Advanced' },
                { value: 'expert', label: 'Expert' },
            ] },
            {
                key: 'experience',
                label: '经验时长',
                type: 'group',
                fullWidth: true,
                fields: [
                    { key: 'experience.years', label: '年', type: 'number', required: true },
                    { key: 'experience.months', label: '月', type: 'number', required: true },
                ],
            },
            { key: 'description', label: '技能描述', type: 'textarea', required: true, rows: 4, fullWidth: true },
            { key: 'projects', label: '关联项目 ID', type: 'string-list', help: '每行一个项目 ID', fullWidth: true },
            { key: 'certifications', label: '证书', type: 'string-list', help: '每行一个证书名称', fullWidth: true },
        ],
    },
    'timeline-data': {
        idField: 'id',
        titleField: 'title',
        singularLabel: '时间线条目',
        collectionLabel: '时间线列表',
        createDefault() {
            return {
                id: `timeline-${Date.now()}`,
                title: '',
                description: '',
                type: 'project',
                startDate: new Date().toISOString().slice(0, 10),
                endDate: '',
                location: '',
                organization: '',
                position: '',
                skills: [],
                achievements: [],
                links: [],
                icon: '',
                color: '#7C3AED',
                featured: false,
            };
        },
        getListLabel(item) {
            return item.title || item.id || '未命名条目';
        },
        getListMeta(item) {
            return [item.type, item.startDate].filter(Boolean).join(' · ');
        },
        fields: [
            { key: 'id', label: '条目 ID', type: 'text', required: true },
            { key: 'title', label: '标题', type: 'text', required: true },
            { key: 'type', label: '类型', type: 'select', required: true, options: [
                { value: 'education', label: '教育' },
                { value: 'work', label: '工作' },
                { value: 'project', label: '项目' },
                { value: 'achievement', label: '成就' },
            ] },
            { key: 'startDate', label: '开始日期', type: 'date', required: true },
            { key: 'endDate', label: '结束日期', type: 'date' },
            { key: 'location', label: '地点', type: 'text' },
            { key: 'organization', label: '组织 / 学校 / 公司', type: 'text' },
            { key: 'position', label: '职位 / 身份', type: 'text' },
            { key: 'icon', label: '图标名', type: 'text' },
            { key: 'color', label: '主题色', type: 'text' },
            { key: 'featured', label: '精选条目', type: 'checkbox' },
            { key: 'description', label: '描述', type: 'textarea', required: true, rows: 4, fullWidth: true },
            { key: 'skills', label: '技能', type: 'string-list', help: '每行一个技能', fullWidth: true },
            { key: 'achievements', label: '成就', type: 'string-list', help: '每行一个成就', fullWidth: true },
            {
                key: 'links',
                label: '相关链接',
                type: 'object-list',
                fullWidth: true,
                itemLabel: '链接',
                createItem: () => ({ name: '', url: '', type: 'website' }),
                fields: [
                    { key: 'name', label: '名称', type: 'text', required: true },
                    { key: 'url', label: '链接', type: 'url', required: true },
                    { key: 'type', label: '类型', type: 'select', required: true, options: [
                        { value: 'website', label: '网站' },
                        { value: 'certificate', label: '证书' },
                        { value: 'project', label: '项目' },
                        { value: 'other', label: '其他' },
                    ] },
                ],
            },
        ],
    },
};

function bindManagedPagesEvents() {
    if (managedPagesEventsBound) return;
    managedPagesEventsBound = true;

    document.getElementById('btn-pages-save').addEventListener('click', saveManagedPage);
    document.getElementById('btn-pages-preview').addEventListener('click', toggleManagedPagePreview);
    document.getElementById('btn-pages-add').addEventListener('click', addManagedCollectionItem);
    document.getElementById('btn-pages-duplicate').addEventListener('click', duplicateManagedCollectionItem);
    document.getElementById('btn-pages-delete').addEventListener('click', deleteManagedCollectionItem);
    document.getElementById('btn-pages-move-up').addEventListener('click', () => moveManagedCollectionItem(-1));
    document.getElementById('btn-pages-move-down').addEventListener('click', () => moveManagedCollectionItem(1));
}

function getManagedSchema(resourceId) {
    return MANAGED_COLLECTION_SCHEMAS[resourceId] || null;
}

function setManagedPagesDirty(dirty) {
    managedPagesDirty = dirty;
    const saveBtn = document.getElementById('btn-pages-save');
    if (!saveBtn) return;
    saveBtn.innerHTML = dirty
        ? '<span class="material-symbols-rounded">save</span> 保存更改'
        : '<span class="material-symbols-rounded">save</span> 保存';
}

async function confirmDiscardManagedChanges() {
    if (!managedPagesDirty) return true;
    return await showConfirm('放弃未保存更改', '当前页面管理内容尚未保存，确定要放弃这些更改吗？');
}

function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
}

function getByPath(target, keyPath) {
    return keyPath.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), target);
}

function setByPath(target, keyPath, value) {
    const keys = keyPath.split('.');
    let current = target;
    for (let i = 0; i < keys.length - 1; i++) {
        const key = keys[i];
        if (current[key] == null || typeof current[key] !== 'object') {
            const nextKey = keys[i + 1];
            current[key] = /^\d+$/.test(nextKey) ? [] : {};
        }
        current = current[key];
    }
    current[keys[keys.length - 1]] = value;
}

function normalizeStringList(value) {
    return String(value || '')
        .split(/\n|,/)
        .map((item) => item.trim())
        .filter(Boolean);
}

function generateStringId(prefix) {
    return `${prefix}-${Date.now()}`;
}

async function loadManagedPages(initialId = null) {
    bindManagedPagesEvents();

    try {
        const data = await api('/pages');
        managedPagesMeta = data.items || [];

        const targetId = initialId || currentManagedPage?.id || managedPagesMeta[0]?.id || null;
        renderManagedPagesList(targetId);

        if (targetId) {
            await openManagedPage(targetId, false);
        } else {
            showManagedPageEmptyState();
        }
    } catch (err) {
        showToast('加载页面资源失败: ' + err.message, 'error');
    }
}

function renderManagedPagesList(activeId = null) {
    const container = document.getElementById('managed-pages-list');
    if (!container) return;

    if (!managedPagesMeta.length) {
        container.innerHTML = '<p class="form-hint">暂无可管理资源</p>';
        return;
    }

    container.innerHTML = managedPagesMeta.map((item) => `
        <button class="managed-page-item ${item.id === activeId ? 'active' : ''}" data-page-id="${escapeAttr(item.id)}">
            <span class="managed-page-item-title">${escapeHtml(item.title)}</span>
            <span class="managed-page-item-meta">${escapeHtml(item.relativePath)}</span>
        </button>
    `).join('');

    container.querySelectorAll('.managed-page-item').forEach((btn) => {
        btn.addEventListener('click', () => openManagedPage(btn.dataset.pageId, true));
    });
}

async function openManagedPage(id, updateHash = true) {
    const requestId = ++managedPageRequestId;
    try {
        if (currentManagedPage && currentManagedPage.id !== id) {
            const confirmed = await confirmDiscardManagedChanges();
            if (!confirmed || requestId !== managedPageRequestId) return;
        }
        const data = await api(`/pages/${encodeURIComponent(id)}`);
        if (requestId !== managedPageRequestId) return;
        currentManagedPage = data;
        managedPagePreviewVisible = false;
        managedCollectionItems = data.mode === 'collection' ? deepClone(data.items || []) : [];
        currentManagedCollectionIndex = managedCollectionItems.length > 0 ? 0 : -1;
        setManagedPagesDirty(false);

        renderManagedPagesList(id);
        renderManagedPageEditor();

        if (updateHash) {
            location.hash = `#/pages/${encodeURIComponent(id)}`;
        }
    } catch (err) {
        showToast('加载资源失败: ' + err.message, 'error');
    }
}

function updateManagedPageActions() {
    const isCollection = currentManagedPage?.mode === 'collection';
    const hasSelection = isCollection && currentManagedCollectionIndex >= 0;

    document.getElementById('btn-pages-preview').classList.toggle('hidden', currentManagedPage?.mode !== 'markdown');
    document.getElementById('btn-pages-add').classList.toggle('hidden', !isCollection);
    document.getElementById('btn-pages-duplicate').classList.toggle('hidden', !hasSelection);
    document.getElementById('btn-pages-delete').classList.toggle('hidden', !hasSelection);
    document.getElementById('btn-pages-move-up').classList.toggle('hidden', !hasSelection);
    document.getElementById('btn-pages-move-down').classList.toggle('hidden', !hasSelection);
}

function renderManagedPageEditor() {
    const empty = document.getElementById('managed-page-empty');
    const markdownWrap = document.getElementById('managed-markdown-wrap');
    const collectionWrap = document.getElementById('managed-collection-wrap');
    const metaCard = document.getElementById('managed-page-meta-card');
    const title = document.getElementById('managed-page-title');
    const description = document.getElementById('managed-page-description');
    const category = document.getElementById('managed-page-category');
    const type = document.getElementById('managed-page-type');
    const filePath = document.getElementById('managed-page-path');

    if (!currentManagedPage) {
        showManagedPageEmptyState();
        return;
    }

    empty.classList.add('hidden');
    metaCard.classList.remove('hidden');
    title.textContent = currentManagedPage.title;
    description.textContent = currentManagedPage.description || '';
    category.textContent = currentManagedPage.category === 'page' ? 'Markdown 页面' : '数据资源';
    type.textContent = currentManagedPage.mode === 'markdown' ? 'Markdown' : '结构化数据';
    filePath.textContent = currentManagedPage.relativePath;

    if (currentManagedPage.mode === 'markdown') {
        markdownWrap.classList.remove('hidden');
        collectionWrap.classList.add('hidden');
        document.getElementById('managed-page-content').value = currentManagedPage.content || '';
        document.getElementById('managed-page-preview-wrap').classList.add('hidden');
        document.getElementById('managed-page-preview').innerHTML = '';
        managedPagePreviewVisible = false;
        document.getElementById('btn-pages-preview').innerHTML = '<span class="material-symbols-rounded">visibility</span> 预览';
    } else {
        markdownWrap.classList.add('hidden');
        collectionWrap.classList.remove('hidden');
        renderManagedCollectionEditor();
    }

    updateManagedPageActions();
}

function showManagedPageEmptyState() {
    document.getElementById('managed-page-empty')?.classList.remove('hidden');
    document.getElementById('managed-markdown-wrap')?.classList.add('hidden');
    document.getElementById('managed-collection-wrap')?.classList.add('hidden');
    document.getElementById('managed-page-meta-card')?.classList.add('hidden');
    ['btn-pages-preview', 'btn-pages-add', 'btn-pages-duplicate', 'btn-pages-delete', 'btn-pages-move-up', 'btn-pages-move-down']
        .forEach((id) => document.getElementById(id)?.classList.add('hidden'));
}

function renderManagedCollectionEditor() {
    const schema = getManagedSchema(currentManagedPage.id);
    const heading = document.getElementById('managed-collection-heading');
    const count = document.getElementById('managed-collection-count');
    if (heading) heading.textContent = schema?.collectionLabel || '条目列表';
    if (count) count.textContent = `${managedCollectionItems.length} 项`;

    renderManagedCollectionList();
    renderManagedCollectionForm();
}

function renderManagedCollectionList() {
    const schema = getManagedSchema(currentManagedPage.id);
    const container = document.getElementById('managed-collection-list');
    if (!schema || !container) return;

    if (!managedCollectionItems.length) {
        container.innerHTML = '<div class="empty-state" style="padding: 32px 12px;"><span class="material-symbols-rounded">list_alt</span><p>当前还没有条目，点击“新增条目”开始。</p></div>';
        return;
    }

    container.innerHTML = managedCollectionItems.map((item, index) => `
        <button class="managed-collection-item ${index === currentManagedCollectionIndex ? 'active' : ''}" data-item-index="${index}">
            <span class="managed-collection-item-title">${escapeHtml(schema.getListLabel(item, index))}</span>
            <span class="managed-collection-item-meta">${escapeHtml(schema.getListMeta(item, index) || '')}</span>
        </button>
    `).join('');

    container.querySelectorAll('.managed-collection-item').forEach((button) => {
        button.addEventListener('click', () => {
            currentManagedCollectionIndex = Number(button.dataset.itemIndex);
            renderManagedCollectionEditor();
            updateManagedPageActions();
        });
    });
}

function renderManagedCollectionForm() {
    const schema = getManagedSchema(currentManagedPage.id);
    const form = document.getElementById('managed-collection-form');
    const empty = document.getElementById('managed-collection-editor-empty');
    if (!schema || !form || !empty) return;

    if (currentManagedCollectionIndex < 0 || !managedCollectionItems[currentManagedCollectionIndex]) {
        empty.classList.remove('hidden');
        form.classList.add('hidden');
        form.innerHTML = '';
        return;
    }

    empty.classList.add('hidden');
    form.classList.remove('hidden');

    const item = managedCollectionItems[currentManagedCollectionIndex];
    form.innerHTML = `<div class="managed-form-grid">${schema.fields.map((field) => renderManagedField(field, item)).join('')}</div>`;

    bindManagedCollectionFieldEvents(form);
}

function renderManagedField(field, item, pathPrefix = '') {
    const fieldPath = pathPrefix ? `${pathPrefix}.${field.key}` : field.key;
    const value = getByPath(item, fieldPath);
    const fullWidthClass = field.fullWidth ? 'full-width' : '';

    if (field.type === 'group') {
        return `
            <div class="managed-group ${fullWidthClass}">
                <div class="managed-group-title">${escapeHtml(field.label)}</div>
                <div class="managed-form-grid">
                    ${field.fields.map((child) => renderManagedField(child, item, '')).join('')}
                </div>
            </div>
        `;
    }

    if (field.type === 'object-list') {
        const items = Array.isArray(value) ? value : [];
        return `
            <div class="managed-object-list ${fullWidthClass}">
                <div class="managed-object-list-header">
                    <h4>${escapeHtml(field.label)}</h4>
                    <button type="button" class="btn-outlined compact" data-object-list-action="add" data-field-path="${escapeAttr(fieldPath)}">新增${escapeHtml(field.itemLabel || '项目')}</button>
                </div>
                <div class="managed-object-list-items">
                    ${items.length === 0 ? '<p class="form-hint">暂无条目</p>' : items.map((entry, index) => `
                        <div class="managed-object-item">
                            <div class="managed-object-item-top">
                                <span class="managed-object-item-title">${escapeHtml(entry.name || `${field.itemLabel || '项目'} ${index + 1}`)}</span>
                                <button type="button" class="btn-text btn-danger" data-object-list-action="remove" data-field-path="${escapeAttr(fieldPath)}" data-object-index="${index}">删除</button>
                            </div>
                            <div class="managed-form-grid">
                                ${field.fields.map((child) => renderManagedField(child, item, `${fieldPath}.${index}`)).join('')}
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }

    if (field.type === 'checkbox') {
        return `
            <div class="managed-form-field ${fullWidthClass}">
                <label class="managed-checkbox">
                    <input type="checkbox" data-field-path="${escapeAttr(fieldPath)}" ${value ? 'checked' : ''}>
                    <span>${escapeHtml(field.label)}</span>
                </label>
                ${field.help ? `<div class="managed-field-help">${escapeHtml(field.help)}</div>` : ''}
            </div>
        `;
    }

    if (field.type === 'textarea') {
        return `
            <div class="managed-form-field ${fullWidthClass}">
                <label>${escapeHtml(field.label)}${field.required ? ' *' : ''}</label>
                <textarea data-field-path="${escapeAttr(fieldPath)}" rows="${field.rows || 4}" placeholder="${escapeAttr(field.placeholder || '')}">${escapeHtml(value ?? '')}</textarea>
                ${field.help ? `<div class="managed-field-help">${escapeHtml(field.help)}</div>` : ''}
            </div>
        `;
    }

    if (field.type === 'select') {
        return `
            <div class="managed-form-field ${fullWidthClass}">
                <label>${escapeHtml(field.label)}${field.required ? ' *' : ''}</label>
                <select data-field-path="${escapeAttr(fieldPath)}">
                    ${field.options.map((option) => `<option value="${escapeAttr(option.value)}" ${String(value ?? '') === option.value ? 'selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}
                </select>
                ${field.help ? `<div class="managed-field-help">${escapeHtml(field.help)}</div>` : ''}
            </div>
        `;
    }

    if (field.type === 'string-list') {
        const listValue = Array.isArray(value) ? value.join('\n') : '';
        return `
            <div class="managed-form-field ${fullWidthClass}">
                <label>${escapeHtml(field.label)}${field.required ? ' *' : ''}</label>
                <textarea data-field-path="${escapeAttr(fieldPath)}" data-value-type="string-list" rows="${field.rows || 4}" placeholder="${escapeAttr(field.placeholder || '')}">${escapeHtml(listValue)}</textarea>
                ${field.help ? `<div class="managed-field-help">${escapeHtml(field.help)}</div>` : ''}
            </div>
        `;
    }

    return `
        <div class="managed-form-field ${fullWidthClass}">
            <label>${escapeHtml(field.label)}${field.required ? ' *' : ''}</label>
            <input
                type="${field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : field.type === 'url' ? 'url' : 'text'}"
                data-field-path="${escapeAttr(fieldPath)}"
                value="${escapeAttr(value ?? '')}"
                placeholder="${escapeAttr(field.placeholder || '')}"
            >
            ${field.help ? `<div class="managed-field-help">${escapeHtml(field.help)}</div>` : ''}
        </div>
    `;
}

function bindManagedCollectionFieldEvents(form) {
    form.querySelectorAll('[data-field-path]').forEach((input) => {
        const eventName = input.type === 'checkbox' || input.tagName === 'SELECT' ? 'change' : 'input';
        input.addEventListener(eventName, () => {
            if (currentManagedCollectionIndex < 0) return;
            const item = managedCollectionItems[currentManagedCollectionIndex];
            const fieldPath = input.dataset.fieldPath;
            const valueType = input.dataset.valueType;

            let nextValue;
            if (input.type === 'checkbox') {
                nextValue = input.checked;
            } else if (input.type === 'number') {
                nextValue = input.value === '' ? 0 : Number(input.value);
            } else if (valueType === 'string-list') {
                nextValue = normalizeStringList(input.value);
            } else {
                nextValue = input.value;
            }

            setByPath(item, fieldPath, nextValue);
            setManagedPagesDirty(true);
            renderManagedCollectionList();
        });
    });

    form.querySelectorAll('[data-object-list-action]').forEach((button) => {
        button.addEventListener('click', () => {
            const fieldPath = button.dataset.fieldPath;
            const action = button.dataset.objectListAction;
            const schema = getManagedSchema(currentManagedPage.id);
            const field = schema.fields.find((candidate) => candidate.key === fieldPath);
            if (!field || field.type !== 'object-list') return;

            const list = getByPath(managedCollectionItems[currentManagedCollectionIndex], fieldPath) || [];

            if (action === 'add') {
                list.push(field.createItem());
                setByPath(managedCollectionItems[currentManagedCollectionIndex], fieldPath, list);
            } else if (action === 'remove') {
                const objectIndex = Number(button.dataset.objectIndex);
                list.splice(objectIndex, 1);
                setByPath(managedCollectionItems[currentManagedCollectionIndex], fieldPath, list);
            }

            setManagedPagesDirty(true);
            renderManagedCollectionForm();
        });
    });
}

function addManagedCollectionItem() {
    const schema = getManagedSchema(currentManagedPage?.id);
    if (!schema) return;
    const newItem = schema.createDefault(managedCollectionItems);
    if (schema.idField === 'id' && typeof newItem.id === 'string' && !newItem.id) {
        newItem.id = generateStringId(currentManagedPage.id.replace('-data', ''));
    }
    managedCollectionItems.push(newItem);
    currentManagedCollectionIndex = managedCollectionItems.length - 1;
    setManagedPagesDirty(true);
    renderManagedCollectionEditor();
    updateManagedPageActions();
}

function duplicateManagedCollectionItem() {
    if (currentManagedCollectionIndex < 0) return;
    const schema = getManagedSchema(currentManagedPage?.id);
    if (!schema) return;

    const cloned = deepClone(managedCollectionItems[currentManagedCollectionIndex]);
    if (schema.idField === 'id') {
        if (typeof cloned.id === 'number') {
            const maxId = managedCollectionItems.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0);
            cloned.id = maxId + 1;
        } else {
            cloned.id = generateStringId(cloned.id || currentManagedPage.id.replace('-data', ''));
        }
    }

    managedCollectionItems.splice(currentManagedCollectionIndex + 1, 0, cloned);
    currentManagedCollectionIndex += 1;
    setManagedPagesDirty(true);
    renderManagedCollectionEditor();
    updateManagedPageActions();
}

async function deleteManagedCollectionItem() {
    if (currentManagedCollectionIndex < 0) return;
    const schema = getManagedSchema(currentManagedPage?.id);
    const item = managedCollectionItems[currentManagedCollectionIndex];
    const confirmed = await showConfirm(
        `删除${schema?.singularLabel || '条目'}`,
        `确定要删除「${schema?.getListLabel(item, currentManagedCollectionIndex) || '当前条目'}」吗？`
    );
    if (!confirmed) return;

    managedCollectionItems.splice(currentManagedCollectionIndex, 1);
    currentManagedCollectionIndex = managedCollectionItems.length ? Math.min(currentManagedCollectionIndex, managedCollectionItems.length - 1) : -1;
    setManagedPagesDirty(true);
    renderManagedCollectionEditor();
    updateManagedPageActions();
}

function moveManagedCollectionItem(direction) {
    if (currentManagedCollectionIndex < 0) return;
    const nextIndex = currentManagedCollectionIndex + direction;
    if (nextIndex < 0 || nextIndex >= managedCollectionItems.length) return;
    const [item] = managedCollectionItems.splice(currentManagedCollectionIndex, 1);
    managedCollectionItems.splice(nextIndex, 0, item);
    currentManagedCollectionIndex = nextIndex;
    setManagedPagesDirty(true);
    renderManagedCollectionEditor();
    updateManagedPageActions();
}

async function toggleManagedPagePreview() {
    if (!currentManagedPage || currentManagedPage.mode !== 'markdown') return;

    const previewWrap = document.getElementById('managed-page-preview-wrap');
    const preview = document.getElementById('managed-page-preview');
    const previewBtn = document.getElementById('btn-pages-preview');
    const content = document.getElementById('managed-page-content').value;

    if (managedPagePreviewVisible) {
        managedPagePreviewVisible = false;
        previewWrap.classList.add('hidden');
        previewBtn.innerHTML = '<span class="material-symbols-rounded">visibility</span> 预览';
        return;
    }

    try {
        const data = await api('/posts/preview', {
            method: 'POST',
            body: JSON.stringify({ content }),
        });
        preview.innerHTML = data.html || '';
        previewWrap.classList.remove('hidden');
        previewBtn.innerHTML = '<span class="material-symbols-rounded">edit</span> 收起预览';
        managedPagePreviewVisible = true;
    } catch (err) {
        showToast('预览失败: ' + err.message, 'error');
    }
}

async function saveManagedPage() {
    if (!currentManagedPage) {
        showToast('请先选择一个资源', 'error');
        return;
    }

    const payload = currentManagedPage.mode === 'markdown'
        ? { content: document.getElementById('managed-page-content').value }
        : { items: managedCollectionItems };

    try {
        await api(`/pages/${encodeURIComponent(currentManagedPage.id)}`, {
            method: 'PUT',
            body: JSON.stringify(payload),
        });

        if (currentManagedPage.mode === 'markdown') {
            currentManagedPage.content = payload.content;
        } else {
            currentManagedPage.items = deepClone(managedCollectionItems);
        }

        setManagedPagesDirty(false);
        showToast(`${currentManagedPage.title} 已保存`, 'success');

        const shouldBuild = await showConfirm(
            '构建并刷新 CDN',
            '页面资源已保存。是否立即构建博客并刷新 CDN 缓存？'
        );
        if (shouldBuild && window.triggerBuildAndCdn) {
            window.triggerBuildAndCdn();
        }
    } catch (err) {
        showToast('保存失败: ' + err.message, 'error');
    }
}

window.addEventListener('beforeunload', (event) => {
    if (!managedPagesDirty) return;
    event.preventDefault();
    event.returnValue = '';
});

// ─── Settings ──────────────────────────
let settingsLoaded = { users: false, loginHistory: false, logs: false };

function loadSettings() {
    // Tab 切换
    document.querySelectorAll('.settings-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            const tabName = tab.dataset.tab;
            document.querySelectorAll('.settings-panel').forEach(p => p.classList.add('hidden'));
            document.getElementById(`tab-${tabName}`).classList.remove('hidden');

            // Lazy load
            if (tabName === 'users' && !settingsLoaded.users) loadUsers();
            if (tabName === 'login-history' && !settingsLoaded.loginHistory) loadLoginHistory();
            if (tabName === 'operation-logs' && !settingsLoaded.logs) loadOperationLogs();
            if (tabName === 'avatar') loadAvatarPreview();
        });
    });

    // 默认加载用户列表
    loadUsers();
}

async function loadUsers() {
    try {
        const data = await api('/settings/users');
        settingsLoaded.users = true;
        const container = document.getElementById('users-list');
        if (!data.users || data.users.length === 0) {
            container.innerHTML = '<p class="form-hint">暂无用户</p>';
            return;
        }
        container.innerHTML = data.users.map(u => `
            <div class="user-card">
                <div class="user-card-avatar">
                    ${safeImageUrl(u.avatar) ? `<img src="${escapeAttr(safeImageUrl(u.avatar))}" alt="">` : `<span class="material-symbols-rounded">person</span>`}
                </div>
                <div class="user-card-info">
                    <span class="user-card-name">${escapeHtml(u.nickname || u.username)}</span>
                    <span class="user-card-username">@${escapeHtml(u.username)}</span>
                </div>
                <span class="user-card-role">${escapeHtml(u.role)}</span>
                <span class="user-card-date">${formatDateTime(u.created_at)}</span>
                <button class="icon-btn btn-danger" title="删除" data-user-delete="${escapeAttr(u.username)}">
                    <span class="material-symbols-rounded">delete</span>
                </button>
            </div>
        `).join('');
        container.querySelectorAll('[data-user-delete]').forEach((button) => {
            button.addEventListener('click', () => window.deleteUser(button.dataset.userDelete));
        });
    } catch (err) {
        showToast('加载用户列表失败: ' + err.message, 'error');
    }
}

window.deleteUser = async function (username) {
    const confirmed = await showConfirm('删除用户', `确定要删除用户 "${username}" 吗？`);
    if (!confirmed) return;
    try {
        await api(`/settings/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
        showToast('用户已删除', 'success');
        loadUsers();
    } catch (err) {
        showToast(err.message, 'error');
    }
};

document.getElementById('add-user-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('new-username').value.trim();
    const nickname = document.getElementById('new-nickname').value.trim();
    const password = document.getElementById('new-password').value;

    try {
        await api('/settings/users', {
            method: 'POST',
            body: JSON.stringify({ username, nickname, password }),
        });
        showToast('用户已添加', 'success');
        document.getElementById('add-user-form').reset();
        loadUsers();
    } catch (err) {
        showToast(err.message, 'error');
    }
});

async function loadLoginHistory(page = 0) {
    try {
        const data = await api(`/settings/login-history?page=${page}&pageSize=20`);
        settingsLoaded.loginHistory = true;
        const container = document.getElementById('login-history-list');
        if (!data.logs || data.logs.length === 0) {
            container.innerHTML = `
                <div class="empty-state" style="padding:40px 20px">
                    <span class="material-symbols-rounded" style="font-size:48px;color:var(--md-outline-variant);margin-bottom:12px">history_toggle_off</span>
                    <p style="color:var(--md-on-surface-variant)">数据库中暂无登录记录</p>
                </div>`;
            return;
        }
        container.innerHTML = `
            <table class="log-table">
                <thead>
                    <tr>
                        <th>用户</th>
                        <th>IP</th>
                        <th>状态</th>
                        <th>时间</th>
                    </tr>
                </thead>
                <tbody>
                    ${data.logs.map(log => `
                        <tr>
                            <td>${escapeHtml(log.username)}</td>
                            <td><code>${escapeHtml(log.ip || '-')}</code></td>
                            <td>${log.success
                ? '<span class="pinned-badge" style="background:var(--md-success-container);color:var(--md-success)">成功</span>'
                : '<span class="draft-badge">失败</span>'
            }</td>
                            <td>${formatDateTime(log.created_at)}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
        // 分页
        renderPagination('login-pagination', page, data.total, 20, loadLoginHistory);
    } catch (err) {
        showToast('加载登录日志失败: ' + err.message, 'error');
    }
}

async function loadOperationLogs(page = 0) {
    try {
        const data = await api(`/settings/logs?page=${page}&pageSize=20`);
        settingsLoaded.logs = true;
        const container = document.getElementById('operation-logs-list');
        if (!data.logs || data.logs.length === 0) {
            container.innerHTML = `
                <div class="empty-state" style="padding:40px 20px">
                    <span class="material-symbols-rounded" style="font-size:48px;color:var(--md-outline-variant);margin-bottom:12px">receipt_long</span>
                    <p style="color:var(--md-on-surface-variant)">数据库中暂无操作记录</p>
                </div>`;
            return;
        }
        container.innerHTML = `
            <table class="log-table">
                <thead>
                    <tr>
                        <th>用户</th>
                        <th>操作</th>
                        <th>详情</th>
                        <th>IP</th>
                        <th>时间</th>
                    </tr>
                </thead>
                <tbody>
                    ${data.logs.map(log => `
                        <tr>
                            <td>${escapeHtml(log.username || '-')}</td>
                            <td><span class="category-chip">${escapeHtml(log.action)}</span></td>
                            <td class="log-detail-cell">${escapeHtml(log.detail || '-')}</td>
                            <td><code>${escapeHtml(log.ip || '-')}</code></td>
                            <td>${formatDateTime(log.created_at)}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
        renderPagination('logs-pagination', page, data.total, 20, loadOperationLogs);
    } catch (err) {
        showToast('加载操作日志失败: ' + err.message, 'error');
    }
}

function renderPagination(containerId, currentPage, total, pageSize, loadFn) {
    const totalPages = Math.ceil(total / pageSize);
    if (totalPages <= 1) { document.getElementById(containerId).innerHTML = ''; return; }
    const container = document.getElementById(containerId);
    let html = '';
    if (currentPage > 0) html += `<button class="btn-text compact" data-page="${currentPage - 1}">上一页</button>`;
    html += `<span class="pagination-info">${currentPage + 1} / ${totalPages}</span>`;
    if (currentPage < totalPages - 1) html += `<button class="btn-text compact" data-page="${currentPage + 1}">下一页</button>`;
    container.innerHTML = html;
    container.querySelectorAll('button').forEach(btn => {
        btn.addEventListener('click', () => loadFn(parseInt(btn.dataset.page)));
    });
}

// Avatar
function loadAvatarPreview() {
    const preview = document.getElementById('avatar-preview');
    const avatarSrc = safeImageUrl(userProfile?.avatar);
    if (avatarSrc) {
        preview.replaceChildren();
        const image = document.createElement('img');
        image.src = avatarSrc;
        image.alt = 'avatar';
        image.referrerPolicy = 'no-referrer';
        preview.append(image);
    }
}

document.getElementById('btn-choose-avatar').addEventListener('click', () => {
    document.getElementById('avatar-input').click();
});

document.getElementById('avatar-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
        const preview = document.getElementById('avatar-preview');
        preview.replaceChildren();
        const image = document.createElement('img');
        image.src = typeof ev.target.result === 'string' ? ev.target.result : '';
        image.alt = 'preview';
        image.referrerPolicy = 'no-referrer';
        preview.append(image);
        document.getElementById('btn-upload-avatar').classList.remove('hidden');
    };
    reader.readAsDataURL(file);
});

document.getElementById('btn-upload-avatar').addEventListener('click', async () => {
    const input = document.getElementById('avatar-input');
    if (!input.files[0]) return;

    const formData = new FormData();
    formData.append('avatar', input.files[0]);

    try {
        const res = await fetch('/api/settings/avatar', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` },
            body: formData,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        userProfile.avatar = data.avatar;
        document.getElementById('btn-upload-avatar').classList.add('hidden');
        showToast('头像上传成功', 'success');

        // 刷新欢迎区域头像
        const welcomeAvatar = document.getElementById('welcome-avatar');
        const avatarSrc = safeImageUrl(data.avatar);
        if (avatarSrc) welcomeAvatar.innerHTML = `<img src="${escapeAttr(avatarSrc)}" alt="avatar">`;
    } catch (err) {
        showToast('上传失败: ' + err.message, 'error');
    }
});

// ─── Mobile Menu ───────────────────────
const sidebar = document.querySelector('.sidebar');
const overlay = document.getElementById('sidebar-overlay');

document.getElementById('btn-menu').addEventListener('click', () => {
    sidebar.classList.toggle('open');
    overlay.classList.toggle('hidden');
    setTimeout(() => overlay.classList.toggle('visible'), 10);
});

overlay.addEventListener('click', () => {
    sidebar.classList.remove('open');
    overlay.classList.add('hidden');
    overlay.classList.remove('visible');
});

// Close sidebar on nav click (mobile)
document.querySelectorAll('.nav-item[data-route]').forEach(n => {
    n.addEventListener('click', () => {
        if (window.innerWidth <= 900) {
            sidebar.classList.remove('open');
            overlay.classList.add('hidden');
            overlay.classList.remove('visible');
        }
    });
});

// ─── Utilities ─────────────────────────
function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeAttr(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/'/g, '&#39;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function safeImageUrl(value) {
    if (typeof value !== 'string') return '';
    const url = value.trim();
    if (!url || url.startsWith('//') || /[\u0000-\u001f\u007f\\]/.test(url)) return '';
    if (url.startsWith('/')) return url;
    if (!/^[a-z][a-z\d+.-]*:/i.test(url)) return '';
    try {
        const parsed = new URL(url);
        if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
            || parsed.username || parsed.password || !parsed.hostname) return '';
        return url;
    } catch {
        return '';
    }
}

function formatDate(dateStr) {
    if (!dateStr) return '-';
    const d = new Date(dateStr);
    return d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

function formatDateTime(dateStr) {
    if (!dateStr) return '-';
    const d = new Date(dateStr);
    return d.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// Export for other modules
window.api = api;
window.showToast = showToast;
window.showConfirm = showConfirm;
window.escapeHtml = escapeHtml;
window.escapeAttr = escapeAttr;
window.safeImageUrl = safeImageUrl;
window.metaCache = metaCache;
Object.defineProperty(window, 'postsCache', {
    configurable: true,
    get: () => postsCache,
    set: (value) => { postsCache = Array.isArray(value) ? value : []; },
});

// ─── Theme Toggle ──────────────────────
function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('mizuki_theme', theme);
    const iconName = theme === 'dark' ? 'light_mode' : 'dark_mode';
    const themeBtnIcon = document.querySelector('#btn-theme .material-symbols-rounded');
    const mobileThemeBtnIcon = document.querySelector('#btn-mobile-theme .material-symbols-rounded');
    if (themeBtnIcon) themeBtnIcon.textContent = iconName;
    if (mobileThemeBtnIcon) mobileThemeBtnIcon.textContent = iconName;
}

const savedTheme = localStorage.getItem('mizuki_theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
applyTheme(savedTheme);

document.getElementById('btn-theme')?.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    applyTheme(current === 'dark' ? 'light' : 'dark');
});
document.getElementById('btn-mobile-theme')?.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    applyTheme(current === 'dark' ? 'light' : 'dark');
});

// ─── Init ──────────────────────────────
checkAuth();
