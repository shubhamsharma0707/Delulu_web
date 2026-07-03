document.addEventListener('DOMContentLoaded', async () => {
  await requireAuth();
  
  loadRequests('incoming');
  
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

async function loadRequests(type = 'incoming') {
  const list = document.getElementById('requests-list');
  list.innerHTML = '<div class="p-4 text-center">Loading...</div>';
  try {
    const data = await apiCall(`/api/connections/${type}`);
    const reqs = data.requests;
    
    if (!reqs || reqs.length === 0) {
      list.innerHTML = `<div class="p-8 text-center text-on-surface-variant flex flex-col items-center"><span class="material-symbols-outlined text-4xl mb-2">inbox</span> No ${type} requests.</div>`;
      return;
    }
    
    list.innerHTML = reqs.map(r => `
      <div class="flex items-center gap-4 p-4 rounded-2xl bg-surface-container-low shadow-sm mb-2 fade-in">
        <div class="w-14 h-14 rounded-full overflow-hidden shrink-0 border border-outline-variant/30">
          ${getAvatarHtml(r.username, r.avatar)}
        </div>
        <div class="flex-1 min-w-0">
          <h3 class="font-bold text-on-surface capitalize truncate">${r.username}</h3>
          <p class="text-sm text-on-surface-variant truncate">${r.bio || 'Wants to connect'}</p>
        </div>
        ${type === 'incoming' ? `
          <div class="flex gap-2 shrink-0">
            <button onclick="respondReq(${r.id}, 'accept')" class="w-10 h-10 rounded-full bg-primary text-white flex items-center justify-center hover:scale-110 transition-transform"><span class="material-symbols-outlined material-fill text-sm">check</span></button>
            <button onclick="respondReq(${r.id}, 'reject')" class="w-10 h-10 rounded-full bg-surface-variant text-on-surface-variant flex items-center justify-center hover:scale-110 transition-transform"><span class="material-symbols-outlined text-sm">close</span></button>
          </div>
        ` : `<span class="text-xs text-outline bg-surface px-2 py-1 rounded-md">Pending</span>`}
      </div>
    `).join('');
  } catch (err) {
    list.innerHTML = `<div class="p-4 text-error">${err.message}</div>`;
  }
}

window.respondReq = async (id, action) => {
  try {
    await apiCall('/api/connections/respond', 'POST', { connection_id: id, action });
    loadRequests('incoming');
  } catch(err) { alert(err.message); }
};
