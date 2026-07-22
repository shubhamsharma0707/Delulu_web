document.addEventListener('DOMContentLoaded', async () => {
  await requireAuth();
  
  loadRequests('incoming');

  // Auto-refresh when tab becomes visible (compensates for mock socket)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      loadRequests(document.getElementById('tab-req-incoming').classList.contains('text-primary') ? 'incoming' : 'sent');
    }
  });
  
  document.getElementById('tab-req-incoming').onclick = () => {
    document.getElementById('tab-req-incoming').classList.replace('text-on-surface-variant', 'text-primary');
    document.getElementById('tab-req-incoming').classList.add('border-b-2', 'border-primary');
    document.getElementById('tab-req-sent').classList.replace('text-primary', 'text-on-surface-variant');
    document.getElementById('tab-req-sent').classList.remove('border-b-2', 'border-primary');
    loadRequests('incoming');
  };
  document.getElementById('tab-req-sent').onclick = () => {
    document.getElementById('tab-req-sent').classList.replace('text-on-surface-variant', 'text-primary');
    document.getElementById('tab-req-sent').classList.add('border-b-2', 'border-primary');
    document.getElementById('tab-req-incoming').classList.replace('text-primary', 'text-on-surface-variant');
    document.getElementById('tab-req-incoming').classList.remove('border-b-2', 'border-primary');
    loadRequests('sent');
  };
});

let _requestsLoading = false;

async function loadRequests(type = 'incoming') {
  if (_requestsLoading) return;
  _requestsLoading = true;
  const list = document.getElementById('requests-list');

  // Instant zero-latency render from local storage cache (eliminates waiting delay)
  let hasCache = false;
  try {
    const cached = localStorage.getItem(`cached_requests_${type}`);
    if (cached) {
      const cachedReqs = JSON.parse(cached);
      if (cachedReqs.length > 0) {
        hasCache = true;
        list.innerHTML = cachedReqs.map(r => renderRequestItem(r, type)).join('');
      }
    }
  } catch (e) {}

  if (!hasCache) {
    list.innerHTML = '<div class="p-4 text-center text-on-surface-variant animate-pulse">Loading requests...</div>';
  }

  try {
    const data = await apiCall(`/api/connections/${type}`);
    const reqs = data.requests;

    try {
      localStorage.setItem(`cached_requests_${type}`, JSON.stringify(reqs || []));
    } catch (e) {}

    if (!reqs || reqs.length === 0) {
      list.innerHTML = `<div class="p-8 text-center text-on-surface-variant flex flex-col items-center"><span class="material-symbols-outlined text-4xl mb-2">inbox</span> No ${type} requests.</div>`;
      return;
    }

    list.innerHTML = reqs.map(r => renderRequestItem(r, type)).join('');

    // Bind click events programmatically to prevent adblocker/browser security policies from blocking inline script handlers
    list.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        const action = btn.getAttribute('data-action');
        const id = Number(btn.getAttribute('data-id'));
        if (action === 'accept' || action === 'reject') {
          await respondReq(id, action);
        } else if (action === 'revoke') {
          await revokeReq(id);
        }
      });
    });
  } catch (err) {
    list.innerHTML = `<div class="p-4 text-error">${escapeHtml(err.message)}</div>`;
  } finally {
    _requestsLoading = false;
  }
}

window.respondReq = async (id, action) => {
  try {
    await apiCall('/api/connections/respond', 'POST', { connection_id: id, action });
    loadRequests('incoming');
  } catch(err) { showToast(err.message, 'error'); }
};

window.revokeReq = async (id) => {
  try {
    await apiCall(`/api/connections/${id}`, 'DELETE');
    loadRequests('sent');
  } catch (err) {
    showToast(err.message, 'error');
  }
};
