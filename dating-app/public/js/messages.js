document.addEventListener('DOMContentLoaded', async () => {
  await requireAuth();
  loadMessagesList();

  if (socket) {
    socket.on('connection-ended', ({ connectionId }) => {
      loadMessagesList();
    });
    socket.on('match-celebration', ({ connectionId, username }) => {
      if (typeof showMatchCelebration === 'function') {
        showMatchCelebration(username, connectionId);
      }
    });
  }
});

async function loadMessagesList() {
  const list = document.getElementById('messages-list');
  showSkeleton('messages-list', 4, 'card');
  try {
    const data = await apiCall('/api/connections/active');
    const conns = data.connections;
    
    if (!conns || conns.length === 0) {
      list.innerHTML = `<div class="p-8 text-center text-on-surface-variant flex flex-col items-center"><span class="material-symbols-outlined text-4xl mb-2">forum</span> No active chats yet.</div>`;
      return;
    }
    
    list.innerHTML = conns.map(c => {
      const isRevealed = c.status === 'revealed';
      const safeUsername = escapeHtml(c.other_username);
      return `
      <a href="/chat?id=${c.id}" class="w-full flex items-center gap-4 p-4 rounded-2xl hover:bg-surface-container-low mb-2 transition-colors fade-in">
        <div class="w-14 h-14 rounded-full overflow-hidden shrink-0 border border-outline-variant/30 relative">
          ${getAvatarHtml(c.other_username, c.other_avatar)}
        </div>
        <div class="flex-1 min-w-0 text-left">
          <div class="flex justify-between items-baseline mb-1">
            <h3 class="font-bold text-on-surface capitalize truncate">${safeUsername}</h3>
          </div>
          <p class="text-sm text-primary font-medium truncate">${isRevealed ? 'Identities Revealed!' : 'Tap to chat'}</p>
        </div>
      </a>
    `}).join('');
  } catch (err) {
    list.innerHTML = `<div class="p-4 text-error">${escapeHtml(err.message)}</div>`;
  }
}
