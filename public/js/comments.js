/* ============================================
   Mizuki Admin — Comments Management
   ============================================ */

let commentsEventsBound = false;
let commentsLoadRequestId = 0;

function commentDomId(id) {
    return encodeURIComponent(String(id));
}

function bindCommentEvents() {
    if (commentsEventsBound) return;
    const container = document.getElementById('comments-list');
    if (!container) return;
    commentsEventsBound = true;
    container.addEventListener('click', (event) => {
        const button = event.target.closest('[data-comment-action]');
        if (!button) return;
        const id = button.dataset.commentId;
        const action = button.dataset.commentAction;
        if (action === 'reply-toggle') window.toggleReplyForm(id);
        if (action === 'reply-submit') window.submitReply(id, button.dataset.commentUrl || '');
        if (action === 'delete') window.deleteComment(id);
        if (action === 'spam') window.markSpam(id, button.dataset.spam === 'true');
    });
}

// ─── Load Comments ─────────────────────
window.loadComments = async function (page = 0) {
    const requestId = ++commentsLoadRequestId;
    const container = document.getElementById('comments-list');
    container.innerHTML = `
    <div class="loading-state">
      <span class="material-symbols-rounded">sync</span>
      <p>加载评论中…</p>
    </div>`;

    try {
        const data = await window.api(`/comments?page=${page}&pageSize=30`);
        if (requestId !== commentsLoadRequestId) return;

        if (data.warning) {
            container.innerHTML = `
        <div class="no-comments">
          <span class="material-symbols-rounded">settings</span>
          <p>评论功能需要配置</p>
          <p style="font-size:0.82rem;margin-top:8px;opacity:0.7">
            请在 .env 文件中配置 TWIKOO_URL 和 TWIKOO_PASSWORD
          </p>
        </div>`;
            return;
        }

        if (!data.comments || data.comments.length === 0) {
            container.innerHTML = `
        <div class="no-comments">
          <span class="material-symbols-rounded">forum</span>
          <p>暂无评论</p>
        </div>`;
            return;
        }

        container.innerHTML = data.comments.map(comment => renderComment(comment)).join('');
        bindCommentEvents();
    } catch (err) {
        if (requestId !== commentsLoadRequestId) return;
        container.innerHTML = `
      <div class="no-comments">
        <span class="material-symbols-rounded">error</span>
        <p>加载评论失败</p>
        <p style="font-size:0.82rem;margin-top:8px;opacity:0.7">${window.escapeHtml(err.message)}</p>
      </div>`;
    }
};

function renderComment(comment) {
    const nick = comment.nick || '匿名';
    const avatar = nick.charAt(0).toUpperCase();
    const time = comment.created ? new Date(comment.created).toLocaleString('zh-CN') : '';
    const content = comment.comment || '';
    const url = comment.url || '';
    const isSpam = comment.isSpam;
    const id = String(comment._id || comment.id || '');
    const domId = commentDomId(id);

    return `
    <div class="comment-card ${isSpam ? 'spam' : ''}" data-id="${window.escapeAttr(id)}">
      <div class="comment-header">
        <div class="comment-author">
          <div class="comment-avatar">${window.escapeHtml(avatar)}</div>
          <div>
            <div class="comment-nick">${window.escapeHtml(nick)}</div>
            <div class="comment-time">${window.escapeHtml(time)}</div>
          </div>
          ${url ? `<span class="comment-url">${window.escapeHtml(url)}</span>` : ''}
          ${isSpam ? '<span class="draft-badge" style="background:#FFDAD6;color:#BA1A1A">垃圾评论</span>' : ''}
        </div>
      </div>
      <div class="comment-content">${window.escapeHtml(content)}</div>
      <div class="comment-actions">
        <button class="btn-text" data-comment-action="reply-toggle" data-comment-id="${window.escapeAttr(id)}">
          <span class="material-symbols-rounded" style="font-size:18px">reply</span>
          回复
        </button>
        ${isSpam
            ? `<button class="btn-text" data-comment-action="spam" data-comment-id="${window.escapeAttr(id)}" data-spam="false">
              <span class="material-symbols-rounded" style="font-size:18px">check</span>
              取消垃圾
            </button>`
            : `<button class="btn-text" data-comment-action="spam" data-comment-id="${window.escapeAttr(id)}" data-spam="true">
              <span class="material-symbols-rounded" style="font-size:18px">block</span>
              标记垃圾
            </button>`
        }
        <button class="btn-text btn-danger" data-comment-action="delete" data-comment-id="${window.escapeAttr(id)}">
          <span class="material-symbols-rounded" style="font-size:18px">delete</span>
          删除
        </button>
      </div>
      <div class="comment-reply-form" id="reply-form-${domId}">
        <textarea class="comment-reply-textarea" id="reply-text-${domId}" placeholder="输入回复内容…"></textarea>
        <div class="reply-actions">
          <button class="btn-text" data-comment-action="reply-toggle" data-comment-id="${window.escapeAttr(id)}">取消</button>
          <button class="btn-primary compact" data-comment-action="reply-submit" data-comment-id="${window.escapeAttr(id)}" data-comment-url="${window.escapeAttr(url)}">
            <span class="material-symbols-rounded" style="font-size:16px">send</span>
            发送
          </button>
        </div>
      </div>
    </div>
  `;
}

// ─── Reply ─────────────────────────────
window.toggleReplyForm = function (id) {
    const form = document.getElementById(`reply-form-${commentDomId(id)}`);
    if (!form) return;
    form.classList.toggle('visible');
};

window.submitReply = async function (pid, url) {
    const textarea = document.getElementById(`reply-text-${commentDomId(pid)}`);
    if (!textarea) return;
    const comment = textarea.value.trim();
    if (!comment) return window.showToast('回复内容不能为空', 'error');

    try {
        await window.api('/comments/reply', {
            method: 'POST',
            body: JSON.stringify({ pid, url, comment }),
        });
        window.showToast('回复成功', 'success');
        textarea.value = '';
        window.toggleReplyForm(pid);
        // Reload comments
        setTimeout(() => window.loadComments(), 1000);
    } catch (err) {
        window.showToast('回复失败: ' + err.message, 'error');
    }
};

// ─── Delete ────────────────────────────
window.deleteComment = async function (id) {
    const confirmed = await window.showConfirm('删除评论', '确定要删除这条评论吗？');
    if (!confirmed) return;

    try {
        await window.api(`/comments/${encodeURIComponent(id)}`, { method: 'DELETE' });
        window.showToast('评论已删除', 'success');
        // Remove the card from DOM
        const card = [...document.querySelectorAll('.comment-card')].find((item) => item.dataset.id === String(id));
        if (card) {
            card.style.opacity = '0';
            card.style.transform = 'translateX(20px)';
            card.style.transition = 'all 0.3s ease';
            setTimeout(() => card.remove(), 300);
        }
    } catch (err) {
        window.showToast('删除失败: ' + err.message, 'error');
    }
};

// ─── Spam ──────────────────────────────
window.markSpam = async function (id, isSpam) {
    try {
        await window.api(`/comments/${encodeURIComponent(id)}/spam`, {
            method: 'POST',
            body: JSON.stringify({ isSpam }),
        });
        window.showToast(isSpam ? '已标记为垃圾评论' : '已取消垃圾标记', 'success');
        window.loadComments();
    } catch (err) {
        window.showToast('操作失败: ' + err.message, 'error');
    }
};

// ─── Refresh ───────────────────────────
document.getElementById('btn-refresh-comments').addEventListener('click', () => {
    window.loadComments();
});
