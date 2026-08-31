/* ============================================
   Mizuki Admin — Enhanced Markdown Editor
   ============================================ */

let editingSlug = null;
let previewVisible = false;
let previewDebounce = null;
let editorLoadRequest = 0;
let previewRequestId = 0;
let previewController = null;
let isFullscreen = false;
let findBarVisible = false;
let emojiPickerVisible = false;

// ─── Emoji & Kaomoji Data ──────────────
const emojiData = {
    '常用': ['😀', '😂', '🥹', '😊', '😍', '🥰', '😘', '🤔', '😅', '😭', '😤', '🫠', '👍', '👎', '❤️', '🔥', '✨', '🎉', '🎊', '💯', '👏', '🙏', '💪', '🤝', '⭐', '🌸', '🌟', '💖', '✅', '❌', '⚡', '💡', '📌', '🚀', '🎵', '☕'],
    '颜文字': ['(◕‿◕)', '(≧▽≦)', '(╥_╥)', '(ノ◕ヮ◕)ノ*:・゚✧', '(｡◕‿◕｡)', '(✿◠‿◠)', '(ﾉ´ヮ`)ﾉ*: ・゚', '(⌒‿⌒)', '( ˘ω˘ )', '(｀・ω・´)', '(ᵔᴥᵔ)', '(=^・^=)', '(•̀ᴗ•́)و', '(╯°□°)╯︵ ┻━┻', '┬─┬ノ( º _ ºノ)', '¯\\_(ツ)_/¯', '(ง •_•)ง', '(☞ﾟヮﾟ)☞', '(ᗒᗣᗕ)՞', '(◡ ω ◡)', '♡(◡‿◡)', '(｡♥‿♥｡)', '(ノ>ω<)ノ', 'ヽ(>∀<☆)ノ', '(⁄ ⁄•⁄ω⁄•⁄ ⁄)', '(´；ω；`)', '(T_T)', 'Σ(°△°|||)', '(; ̄Д ̄)', '(*≧▽≦)'],
    '表情': ['😀', '😃', '😄', '😁', '😆', '🥹', '😅', '🤣', '😂', '🙂', '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😗', '😚', '😙', '🥲', '😋', '😛', '😜', '🤪', '😝', '🤑', '🤗', '🤭', '🫢', '🫣', '🤫', '🤔', '🫡', '🤐', '🤨', '😐', '😑', '😶', '😏', '😒', '🙄', '😬', '😮‍💨', '🤥', '😌', '😔', '😪', '🤤', '😴', '😷', '🤒'],
    '手势': ['👋', '🤚', '🖐', '✋', '🖖', '🫱', '🫲', '🫳', '🫴', '👌', '🤌', '🤏', '✌️', '🤞', '🫰', '🤟', '🤘', '🤙', '👈', '👉', '👆', '🖕', '👇', '☝️', '🫵', '👍', '👎', '✊', '👊', '🤛', '🤜', '👏', '🙌', '🫶', '👐', '🤲', '🙏', '✍️', '💅', '🤳'],
    '自然': ['🌸', '🌺', '🌹', '🌻', '🌼', '🌷', '💐', '🌿', '🍀', '🍁', '🍂', '🍃', '🌲', '🌳', '🌴', '🌵', '🌾', '🌱', '🪴', '🍄', '🐚', '🌊', '🌈', '☀️', '🌙', '⭐', '🌟', '💫', '✨', '☁️', '⛅', '🌤', '🌧', '⛈', '🌨', '❄️', '🔥', '💧', '🌍'],
    '动物': ['🐱', '🐶', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🐔', '🦄', '🐝', '🦋', '🐌', '🐛', '🐢', '🐍', '🦎', '🐙', '🦑', '🐠', '🐟', '🐬', '🐳', '🦈', '🐊', '🦩', '🐧', '🦜', '🦚', '🐦'],
    '食物': ['🍎', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🫐', '🍒', '🍑', '🥝', '🍕', '🍔', '🍟', '🌮', '🍜', '🍣', '🍱', '🍙', '🍘', '🍰', '🧁', '🍩', '🍪', '🍫', '☕', '🍵', '🧋', '🥤', '🍺'],
};

// ─── Init Editor ───────────────────────
window.initEditor = async function (slug = null) {
    const requestId = ++editorLoadRequest;
    editingSlug = slug;
    previewVisible = false;
    const previewPane = document.getElementById('editor-preview-pane');
    const writePane = document.getElementById('editor-write-pane');
    previewPane.classList.add('hidden');
    writePane.style.flex = '1';

    // Close find bar and emoji picker
    closeFindBar();
    closeEmojiPicker();
    if (isFullscreen) toggleFullscreen();

    // Reset form
    document.getElementById('fm-title').value = '';
    document.getElementById('fm-slug').value = '';
    document.getElementById('fm-published').value = new Date().toISOString().split('T')[0];
    document.getElementById('fm-description').value = '';
    document.getElementById('fm-category').value = '';
    document.getElementById('fm-tags').value = '';
    document.getElementById('fm-draft').checked = true;
    document.getElementById('fm-pinned').checked = false;
    document.getElementById('fm-comment').checked = true;
    document.getElementById('editor-content').value = '';

    updateStatusBar();

    // Populate category datalist
    try {
        const meta = await window.api('/posts/meta/tags-categories').catch(() => ({ tags: [], categories: [] }));
        if (requestId !== editorLoadRequest) return;
        const datalist = document.getElementById('category-list');
        datalist.innerHTML = (meta.categories || []).map(c => `<option value="${window.escapeAttr(c)}">`).join('');
    } catch { }

    if (slug) {
        document.getElementById('editor-title').textContent = '编辑文章';
        document.getElementById('fm-slug').disabled = true;
        try {
            const data = await window.api(`/posts/${encodeURIComponent(slug)}`);
            if (requestId !== editorLoadRequest) return;
            const fm = data.frontmatter;
            document.getElementById('fm-title').value = fm.title || '';
            document.getElementById('fm-slug').value = slug;
            document.getElementById('fm-published').value = fm.published ? new Date(fm.published).toISOString().split('T')[0] : '';
            document.getElementById('fm-description').value = fm.description || '';
            document.getElementById('fm-category').value = fm.category || '';
            document.getElementById('fm-tags').value = (fm.tags || []).join(', ');
            document.getElementById('fm-draft').checked = fm.draft || false;
            document.getElementById('fm-pinned').checked = fm.pinned || false;
            document.getElementById('fm-comment').checked = fm.comment !== false;
            document.getElementById('editor-content').value = data.content || '';
            updateStatusBar();
        } catch (err) {
            if (requestId !== editorLoadRequest) return;
            window.showToast('加载文章失败: ' + err.message, 'error');
        }
    } else {
        document.getElementById('editor-title').textContent = '写文章';
        document.getElementById('fm-slug').disabled = false;
    }
};

// ─── Save ──────────────────────────────
document.getElementById('btn-save').addEventListener('click', async () => {
    const slug = document.getElementById('fm-slug').value.trim();
    const title = document.getElementById('fm-title').value.trim();
    const content = document.getElementById('editor-content').value;

    if (!slug) return window.showToast('文件名(Slug)不能为空', 'error');
    if (!title) return window.showToast('标题不能为空', 'error');

    const tagsStr = document.getElementById('fm-tags').value;
    const tags = tagsStr ? tagsStr.split(',').map(t => t.trim()).filter(Boolean) : [];

    const frontmatter = {
        title,
        published: document.getElementById('fm-published').value || new Date().toISOString().split('T')[0],
        description: document.getElementById('fm-description').value.trim(),
        category: document.getElementById('fm-category').value.trim(),
        tags,
        draft: document.getElementById('fm-draft').checked,
        pinned: document.getElementById('fm-pinned').checked,
        comment: document.getElementById('fm-comment').checked,
    };

    try {
        if (editingSlug) {
            await window.api(`/posts/${encodeURIComponent(editingSlug)}`, {
                method: 'PUT',
                body: JSON.stringify({ frontmatter, content }),
            });
            window.showToast('文章已更新', 'success');
        } else {
            await window.api('/posts', {
                method: 'POST',
                body: JSON.stringify({ slug, frontmatter, content }),
            });
            window.showToast('文章已创建', 'success');
            editingSlug = slug;
            document.getElementById('fm-slug').disabled = true;
            document.getElementById('editor-title').textContent = '编辑文章';
            location.hash = `#/edit/${encodeURIComponent(slug)}`;
        }
        window.postsCache = [];

        const shouldBuild = await window.showConfirm(
            '构建并刷新 CDN',
            '文章已保存。是否立即构建博客并刷新 CDN 缓存？'
        );
        if (shouldBuild && window.triggerBuildAndCdn) {
            window.triggerBuildAndCdn();
        }
    } catch (err) {
        window.showToast('保存失败: ' + err.message, 'error');
    }
});

// ─── Preview Toggle ────────────────────
document.getElementById('btn-preview-toggle').addEventListener('click', () => {
    previewVisible = !previewVisible;
    const previewPane = document.getElementById('editor-preview-pane');
    const btn = document.getElementById('btn-preview-toggle');

    if (previewVisible) {
        previewPane.classList.remove('hidden');
        btn.innerHTML = '<span class="material-symbols-rounded">edit</span> 编辑';
        updatePreview();
    } else {
        previewRequestId++;
        previewController?.abort();
        previewController = null;
        previewPane.classList.add('hidden');
        btn.innerHTML = '<span class="material-symbols-rounded">visibility</span> 预览';
    }
});

// Live preview
document.getElementById('editor-content').addEventListener('input', () => {
    updateStatusBar();
    if (!previewVisible) return;
    clearTimeout(previewDebounce);
    previewDebounce = setTimeout(updatePreview, 500);
});

async function updatePreview() {
    const content = document.getElementById('editor-content').value;
    const requestId = ++previewRequestId;
    previewController?.abort();
    previewController = new AbortController();
    try {
        const data = await window.api('/posts/preview', {
            method: 'POST',
            body: JSON.stringify({ content }),
            signal: previewController.signal,
        });
        if (requestId !== previewRequestId || !previewVisible) return;
        const previewEl = document.getElementById('editor-preview');
        previewEl.innerHTML = data.html;
        // Make preview elements clickable → jump to source line
        previewEl.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,table').forEach(el => {
            el.style.cursor = 'pointer';
            el.title = '点击定位到源码';
            el.addEventListener('click', () => {
                const text = el.textContent.trim().slice(0, 30);
                jumpToSourceText(text);
            });
        });
    } catch (error) {
        if (error?.name === 'AbortError' || requestId !== previewRequestId) return;
        document.getElementById('editor-preview').innerHTML = '<p style="color:red">预览加载失败</p>';
    }
}

// Click preview element → scroll editor to matching text
function jumpToSourceText(text) {
    const textarea = document.getElementById('editor-content');
    const content = textarea.value;
    const idx = content.indexOf(text);
    if (idx === -1) return;
    textarea.focus();
    textarea.setSelectionRange(idx, idx + text.length);
    // Scroll to selection
    const lines = content.substring(0, idx).split('\n');
    const lineHeight = parseFloat(getComputedStyle(textarea).lineHeight);
    textarea.scrollTop = Math.max(0, (lines.length - 3) * lineHeight);
}

// ─── Status Bar ────────────────────────
function updateStatusBar() {
    const textarea = document.getElementById('editor-content');
    const content = textarea.value;
    const charCount = content.replace(/\s/g, '').length;
    const lineCount = content ? content.split('\n').length : 0;
    document.getElementById('editor-word-count').textContent = `${charCount} 字 · ${lineCount} 行`;
}

// Cursor position
document.getElementById('editor-content').addEventListener('click', updateCursorPos);
document.getElementById('editor-content').addEventListener('keyup', updateCursorPos);

function updateCursorPos() {
    const textarea = document.getElementById('editor-content');
    const pos = textarea.selectionStart;
    const text = textarea.value.substring(0, pos);
    const lines = text.split('\n');
    const line = lines.length;
    const col = lines[lines.length - 1].length + 1;
    document.getElementById('editor-cursor-pos').textContent = `行 ${line}, 列 ${col}`;
}

// ─── Find & Replace ────────────────────
let findMatches = [];
let findIndex = -1;

function toggleFindBar() {
    if (findBarVisible) {
        closeFindBar();
    } else {
        openFindBar();
    }
}

function openFindBar() {
    findBarVisible = true;
    let bar = document.getElementById('editor-find-bar');
    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'editor-find-bar';
        bar.className = 'editor-find-bar';
        bar.innerHTML = `
            <span class="material-symbols-rounded" style="font-size:18px;color:var(--md-on-surface-variant)">search</span>
            <input type="text" id="find-input" placeholder="查找…">
            <span id="find-count" class="find-count"></span>
            <button class="find-btn" id="find-prev" title="上一个"><span class="material-symbols-rounded" style="font-size:16px">keyboard_arrow_up</span></button>
            <button class="find-btn" id="find-next" title="下一个"><span class="material-symbols-rounded" style="font-size:16px">keyboard_arrow_down</span></button>
            <input type="text" id="replace-input" placeholder="替换…" style="width:160px">
            <button class="find-btn" id="replace-one" title="替换"><span class="material-symbols-rounded" style="font-size:16px">find_replace</span></button>
            <button class="find-btn" id="find-close" title="关闭"><span class="material-symbols-rounded" style="font-size:16px">close</span></button>
        `;
        const toolbar = document.querySelector('.editor-toolbar');
        toolbar.parentNode.insertBefore(bar, toolbar.nextSibling);

        document.getElementById('find-input').addEventListener('input', doFind);
        document.getElementById('find-next').addEventListener('click', () => findNav(1));
        document.getElementById('find-prev').addEventListener('click', () => findNav(-1));
        document.getElementById('replace-one').addEventListener('click', doReplace);
        document.getElementById('find-close').addEventListener('click', closeFindBar);
    } else {
        bar.style.display = 'flex';
    }
    document.getElementById('find-input').focus();
    // If there's selected text, use it as search
    const textarea = document.getElementById('editor-content');
    const selected = textarea.value.substring(textarea.selectionStart, textarea.selectionEnd);
    if (selected && selected.length < 100) {
        document.getElementById('find-input').value = selected;
        doFind();
    }
}

function closeFindBar() {
    findBarVisible = false;
    const bar = document.getElementById('editor-find-bar');
    if (bar) bar.style.display = 'none';
    findMatches = [];
    findIndex = -1;
}

function doFind() {
    const query = document.getElementById('find-input').value;
    const textarea = document.getElementById('editor-content');
    const content = textarea.value;
    findMatches = [];
    findIndex = -1;

    if (!query) {
        document.getElementById('find-count').textContent = '';
        return;
    }

    let idx = content.indexOf(query);
    while (idx !== -1) {
        findMatches.push(idx);
        idx = content.indexOf(query, idx + 1);
    }

    document.getElementById('find-count').textContent = findMatches.length > 0
        ? `${findMatches.length} 个匹配`
        : '无匹配';

    if (findMatches.length > 0) findNav(1);
}

function findNav(dir) {
    if (findMatches.length === 0) return;
    findIndex = (findIndex + dir + findMatches.length) % findMatches.length;
    const query = document.getElementById('find-input').value;
    const textarea = document.getElementById('editor-content');
    const pos = findMatches[findIndex];
    textarea.focus();
    textarea.setSelectionRange(pos, pos + query.length);
    // Scroll
    const lines = textarea.value.substring(0, pos).split('\n');
    const lineHeight = parseFloat(getComputedStyle(textarea).lineHeight);
    textarea.scrollTop = Math.max(0, (lines.length - 3) * lineHeight);
    document.getElementById('find-count').textContent = `${findIndex + 1} / ${findMatches.length}`;
}

function doReplace() {
    if (findMatches.length === 0 || findIndex === -1) return;
    const query = document.getElementById('find-input').value;
    const replacement = document.getElementById('replace-input').value;
    const textarea = document.getElementById('editor-content');
    const pos = findMatches[findIndex];
    textarea.value = textarea.value.substring(0, pos) + replacement + textarea.value.substring(pos + query.length);
    updateStatusBar();
    doFind(); // Re-search
}

// ─── Emoji Picker ──────────────────────
function toggleEmojiPicker() {
    if (emojiPickerVisible) {
        closeEmojiPicker();
    } else {
        openEmojiPicker();
    }
}

function openEmojiPicker() {
    emojiPickerVisible = true;
    let picker = document.getElementById('emoji-picker');
    if (picker) { picker.remove(); }

    const categories = Object.keys(emojiData);
    picker = document.createElement('div');
    picker.id = 'emoji-picker';
    picker.className = 'emoji-picker';
    picker.innerHTML = `
        <div class="emoji-picker-tabs">
            ${categories.map((cat, i) => `<button class="emoji-tab${i === 0 ? ' active' : ''}" data-cat="${cat}">${cat}</button>`).join('')}
        </div>
        <div class="emoji-grid" id="emoji-grid">
            ${renderEmojiGrid(categories[0])}
        </div>
    `;

    const btn = document.getElementById('btn-emoji');
    btn.appendChild(picker);
    btn.classList.add('active');

    // Tab switching
    picker.querySelectorAll('.emoji-tab').forEach(tab => {
        tab.addEventListener('click', (e) => {
            e.stopPropagation();
            picker.querySelectorAll('.emoji-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            document.getElementById('emoji-grid').innerHTML = renderEmojiGrid(tab.dataset.cat);
            bindEmojiClicks();
        });
    });

    bindEmojiClicks();

    // Close on outside click
    setTimeout(() => {
        document.addEventListener('click', closeEmojiOnOutside);
    }, 50);
}

function renderEmojiGrid(category) {
    const items = emojiData[category] || [];
    const isKaomoji = category === '颜文字';
    return items.map(e =>
        `<span class="emoji-item${isKaomoji ? ' kaomoji' : ''}" data-emoji="${window.escapeAttr(e)}">${window.escapeHtml(e)}</span>`
    ).join('');
}

function bindEmojiClicks() {
    document.querySelectorAll('.emoji-item').forEach(item => {
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            const emoji = item.dataset.emoji;
            insertAtCursor(emoji);
            closeEmojiPicker();
        });
    });
}

function closeEmojiOnOutside(e) {
    if (!e.target.closest('#emoji-picker') && !e.target.closest('#btn-emoji')) {
        closeEmojiPicker();
    }
}

function closeEmojiPicker() {
    emojiPickerVisible = false;
    const picker = document.getElementById('emoji-picker');
    if (picker) picker.remove();
    const btn = document.getElementById('btn-emoji');
    if (btn) btn.classList.remove('active');
    document.removeEventListener('click', closeEmojiOnOutside);
}

// ─── Fullscreen ────────────────────────
function toggleFullscreen() {
    isFullscreen = !isFullscreen;
    const area = document.querySelector('.editor-area');
    const btn = document.getElementById('btn-fullscreen');
    if (isFullscreen) {
        area.classList.add('editor-fullscreen');
        btn.innerHTML = '<span class="material-symbols-rounded" style="font-size:18px">fullscreen_exit</span>';
        btn.classList.add('active');
    } else {
        area.classList.remove('editor-fullscreen');
        btn.innerHTML = '<span class="material-symbols-rounded" style="font-size:18px">fullscreen</span>';
        btn.classList.remove('active');
    }
}

// ─── Insert Helper ─────────────────────
function insertAtCursor(text) {
    const textarea = document.getElementById('editor-content');
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    textarea.value = textarea.value.substring(0, start) + text + textarea.value.substring(end);
    const newPos = start + text.length;
    textarea.setSelectionRange(newPos, newPos);
    textarea.focus();
    updateStatusBar();
}

// ─── Toolbar Actions ───────────────────
document.querySelector('.editor-toolbar').addEventListener('click', (e) => {
    const btn = e.target.closest('.toolbar-btn');
    if (!btn) return;

    const action = btn.dataset.action;

    // Special actions (not text insertion)
    if (action === 'emoji') return toggleEmojiPicker();
    if (action === 'find') return toggleFindBar();
    if (action === 'fullscreen') return toggleFullscreen();

    const textarea = document.getElementById('editor-content');
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = textarea.value.substring(start, end);
    let insert = '';
    let cursorOffset = 0;

    switch (action) {
        case 'bold':
            insert = `**${selected || '粗体文本'}**`;
            cursorOffset = selected ? 0 : -2;
            break;
        case 'italic':
            insert = `*${selected || '斜体文本'}*`;
            cursorOffset = selected ? 0 : -1;
            break;
        case 'strikethrough':
            insert = `~~${selected || '删除线文本'}~~`;
            cursorOffset = selected ? 0 : -2;
            break;
        case 'heading':
            insert = `\n## ${selected || '标题'}`;
            break;
        case 'link':
            insert = `[${selected || '链接文本'}](url)`;
            cursorOffset = -1;
            break;
        case 'image':
            insert = `![${selected || 'alt文本'}](图片URL)`;
            cursorOffset = -1;
            break;
        case 'code':
            insert = selected ? `\n\`\`\`\n${selected}\n\`\`\`\n` : '\n```\n代码\n```\n';
            cursorOffset = selected ? 0 : -5;
            break;
        case 'quote':
            insert = `\n> ${selected || '引用内容'}`;
            break;
        case 'ul':
            insert = `\n- ${selected || '列表项'}`;
            break;
        case 'ol':
            insert = `\n1. ${selected || '列表项'}`;
            break;
        case 'table':
            insert = '\n| 标题1 | 标题2 | 标题3 |\n| --- | --- | --- |\n| 内容 | 内容 | 内容 |\n';
            break;
        case 'hr':
            insert = '\n---\n';
            break;
    }

    textarea.value = textarea.value.substring(0, start) + insert + textarea.value.substring(end);
    const newPos = start + insert.length + cursorOffset;
    textarea.setSelectionRange(newPos, newPos);
    textarea.focus();
    updateStatusBar();
});

// ─── Keyboard Shortcuts ────────────────
document.getElementById('editor-content').addEventListener('keydown', (e) => {
    const textarea = e.target;

    // Ctrl/Cmd shortcuts
    if (e.ctrlKey || e.metaKey) {
        if (e.key === 'b') {
            e.preventDefault();
            document.querySelector('.toolbar-btn[data-action="bold"]').click();
        } else if (e.key === 'i') {
            e.preventDefault();
            document.querySelector('.toolbar-btn[data-action="italic"]').click();
        } else if (e.key === 's') {
            e.preventDefault();
            document.getElementById('btn-save').click();
        } else if (e.key === 'f' && !e.shiftKey) {
            e.preventDefault();
            toggleFindBar();
        } else if (e.key === 'F' || (e.key === 'f' && e.shiftKey)) {
            e.preventDefault();
            toggleFullscreen();
        }
        return;
    }

    // Tab / Shift+Tab
    if (e.key === 'Tab') {
        e.preventDefault();
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;

        if (e.shiftKey) {
            // Dedent: remove leading 2 spaces from current line(s)
            const before = textarea.value.substring(0, start);
            const lineStart = before.lastIndexOf('\n') + 1;
            const selectedLines = textarea.value.substring(lineStart, end);
            const dedented = selectedLines.replace(/^  /gm, '');
            const diff = selectedLines.length - dedented.length;
            textarea.value = textarea.value.substring(0, lineStart) + dedented + textarea.value.substring(end);
            textarea.selectionStart = Math.max(lineStart, start - (textarea.value.substring(lineStart, start).startsWith('') ? Math.min(2, diff) : 0));
            textarea.selectionEnd = end - diff;
        } else {
            // Indent
            textarea.value = textarea.value.substring(0, start) + '  ' + textarea.value.substring(end);
            textarea.selectionStart = textarea.selectionEnd = start + 2;
        }
        updateStatusBar();
        return;
    }

    // Enter: smart list continuation
    if (e.key === 'Enter') {
        const content = textarea.value;
        const pos = textarea.selectionStart;
        const lineStart = content.lastIndexOf('\n', pos - 1) + 1;
        const currentLine = content.substring(lineStart, pos);

        // Unordered list
        const ulMatch = currentLine.match(/^(\s*)([-*+])\s/);
        if (ulMatch) {
            // If line is just the marker (empty item), remove it instead
            if (currentLine.trim() === ulMatch[2]) {
                e.preventDefault();
                textarea.value = content.substring(0, lineStart) + '\n' + content.substring(pos);
                textarea.selectionStart = textarea.selectionEnd = lineStart + 1;
                updateStatusBar();
                return;
            }
            e.preventDefault();
            const insert = `\n${ulMatch[1]}${ulMatch[2]} `;
            textarea.value = content.substring(0, pos) + insert + content.substring(pos);
            textarea.selectionStart = textarea.selectionEnd = pos + insert.length;
            updateStatusBar();
            return;
        }

        // Ordered list
        const olMatch = currentLine.match(/^(\s*)(\d+)\.\s/);
        if (olMatch) {
            if (currentLine.trim() === `${olMatch[2]}.`) {
                e.preventDefault();
                textarea.value = content.substring(0, lineStart) + '\n' + content.substring(pos);
                textarea.selectionStart = textarea.selectionEnd = lineStart + 1;
                updateStatusBar();
                return;
            }
            e.preventDefault();
            const nextNum = parseInt(olMatch[2]) + 1;
            const insert = `\n${olMatch[1]}${nextNum}. `;
            textarea.value = content.substring(0, pos) + insert + content.substring(pos);
            textarea.selectionStart = textarea.selectionEnd = pos + insert.length;
            updateStatusBar();
            return;
        }
    }
});

// ─── Auto-pair brackets/quotes ─────────
const pairs = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' };

document.getElementById('editor-content').addEventListener('keypress', (e) => {
    const textarea = e.target;
    const char = e.key;

    if (pairs[char]) {
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const selected = textarea.value.substring(start, end);

        if (selected) {
            // Wrap selection
            e.preventDefault();
            const wrapped = char + selected + pairs[char];
            textarea.value = textarea.value.substring(0, start) + wrapped + textarea.value.substring(end);
            textarea.selectionStart = start + 1;
            textarea.selectionEnd = start + 1 + selected.length;
        } else {
            // Auto-pair
            e.preventDefault();
            textarea.value = textarea.value.substring(0, start) + char + pairs[char] + textarea.value.substring(end);
            textarea.selectionStart = textarea.selectionEnd = start + 1;
        }
        updateStatusBar();
    }
});

// ─── Auto-generate slug from title ─────
document.getElementById('fm-title').addEventListener('input', (e) => {
    if (editingSlug) return;
    const slugField = document.getElementById('fm-slug');
    if (slugField.disabled) return;

    const title = e.target.value.trim();
    const slug = title
        .toLowerCase()
        .replace(/[^\w\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
    slugField.value = slug;
});
