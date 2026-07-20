// Per-user SSE stream for real-time messages list updates
let userEventSource = null;

function initUserStream() {
  if (userEventSource) return; // Already connected
  userEventSource = new EventSource(resolveUrl('/api/user/stream'));

  userEventSource.onmessage = (event) => {
    if (!event.data || event.data.startsWith(':')) return;
    let data;
    try { data = JSON.parse(event.data); } catch { return; }

    if (data.type === 'message') {
      // Update chat list instantly with the new message
      updateChatListItem({
        connectionId: data.connectionId,
        lastMessage: data.lastMessage,
        lastMessageTime: data.lastMessageTime,
        senderId: data.senderId
      });

      // Fire native notification if app is backgrounded
      if (document.hidden && typeof window.showNativeNotification === 'function') {
        window.showNativeNotification({
          title: 'New message',
          body: data.lastMessage || 'You have a new message',
          url: `messages.html`,
          id: data.connectionId
        });
      }
    }
  };

  userEventSource.onerror = () => {
    // Auto-reconnect after 5 seconds on error
    userEventSource = null;
    setTimeout(initUserStream, 5000);
  };
}

document.addEventListener('DOMContentLoaded', async () => {
  await requireAuth();
  loadMessagesList();
  initUserStream();

  // Auto-refresh when tab becomes visible (compensates for mock socket)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      loadMessagesList({ skipRecent: true });
      // Reconnect SSE if it dropped while backgrounded
      if (!userEventSource) initUserStream();
    }
  });

  if (socket) {
    
    // Real-time chat list updates
    socket.on('chat-update', (data) => {
      updateChatListItem(data);
    });
    
    // Presence updates for chat list
    socket.on('user-online', (data) => {
      updatePresenceDot(data.userId, true);
    });
    socket.on('user-offline', (data) => {
      updatePresenceDot(data.userId, false);
    });
    
    // Update messages list when a message is read
    socket.on('messages-read', (data) => {
      const conn = chatListCache.find(c => c.id == data.connectionId);
      if (conn) {
        conn.last_read = true;
        const list = document.getElementById('messages-list');
        if (list) {
          const links = list.querySelectorAll('a');
          links.forEach(link => {
            if (link.href.includes(`chat.html?id=${data.connectionId}`) || link.href.includes(`/chat?id=${data.connectionId}`)) {
              const safeUsername = escapeHtml(conn.other_username);
              const isRevealed = conn.status === 'revealed';
              const lastMsg = renderLastMessage(conn);
              link.outerHTML = renderChatListItem(conn, safeUsername, isRevealed, lastMsg);
            }
          });
        }
      }
    });
  }
});

// Cache of connection data for live updates
let chatListCache = [];
let lastMessagesListLoadAt = 0;

// In-flight guard to prevent concurrent API calls if multiple socket events fire
// before the first fetch completes. The second call simply returns early.
let _messagesListLoading = false;

async function loadMessagesList(options = {}) {
  if (_messagesListLoading) return;
  if (options.skipRecent && Date.now() - lastMessagesListLoadAt < 5000) return;
  _messagesListLoading = true;
  const list = document.getElementById('messages-list');
  if (!chatListCache.length) {
    showSkeleton('messages-list', 4, 'card');
  }
  try {
    const data = await apiCall('/api/connections/active');
    lastMessagesListLoadAt = Date.now();
    const conns = data.connections;
    chatListCache = conns;
    
    if (!conns || conns.length === 0) {
      list.innerHTML = `<div class="p-8 text-center text-on-surface-variant flex flex-col items-center"><span class="material-symbols-outlined text-4xl mb-2">forum</span> No active chats yet.</div>`;
      return;
    }
    
    list.innerHTML = conns.map(c => {
      const safeUsername = escapeHtml(c.other_username);
      const isRevealed = c.status === 'revealed';
      const lastMsg = renderLastMessage(c);
      return renderChatListItem(c, safeUsername, isRevealed, lastMsg);
    }).join('');

    // Request presence info for connected users
    if (socket) {
      conns.forEach(c => {
        if (c.other_user_id) {
          socket.emit('request-presence', { userId: c.other_user_id });
        }
      });
    }
  } catch (err) {
    list.innerHTML = `<div class="p-4 text-error">${escapeHtml(err.message)}</div>`;
  } finally {
    _messagesListLoading = false;
  }
}

function renderLastMessage(c) {
  if (!c.last_message) {
    return c.status === 'revealed' 
      ? '<span class="text-primary font-medium">Identities Revealed</span>' 
      : '<span class="text-on-surface-variant/60 text-[13px]">Tap to start chatting</span>';
  }
  
  const msgText = c.last_message.length > 40 
    ? escapeHtml(c.last_message.substring(0, 40)) + '...' 
    : escapeHtml(c.last_message);
  
  // Check if the last message was from the other user and was read
  const isUnread = c.last_sender_id && c.last_sender_id !== currentUser?.id && !c.last_read;
  
  let statusIcon = '';
  if (c.last_sender_id === currentUser?.id) {
    statusIcon = c.last_read 
      ? '<span class="material-symbols-outlined text-[12px] text-blue-500 align-middle" style="font-variation-settings: \'FILL\' 1">done_all</span> '
      : '<span class="material-symbols-outlined text-[12px] opacity-50 align-middle">check</span> ';
  }
  
  const prefix = statusIcon || (isUnread ? '' : '');
  return `<span class="${isUnread ? 'font-bold text-on-surface' : 'text-on-surface-variant'} text-[13px]">${prefix}${msgText}</span>`;
}

function renderChatListItem(c, safeUsername, isRevealed, lastMsg) {
  const isUnread = c.last_sender_id && c.last_sender_id !== currentUser?.id && !c.last_read;
  
  return `
    <a href="chat.html?id=${c.id}" class="w-full flex items-center gap-4 p-4 rounded-2xl hover:bg-surface-container-low mb-2 transition-colors fade-in relative ${isUnread ? 'bg-primary-fixed/10 border border-primary/10' : ''}">
      <div class="w-14 h-14 rounded-full overflow-hidden shrink-0 border border-outline-variant/30 relative">
        ${getAvatarHtml(c.other_username, c.other_avatar)}
        <div class="presence-dot absolute bottom-0 right-0 w-3.5 h-3.5 rounded-full border-2 border-surface hidden" data-user-id="${c.other_user_id}"></div>
      </div>
      <div class="flex-1 min-w-0 text-left">
        <div class="flex justify-between items-baseline mb-0.5">
          <h3 class="font-bold text-on-surface capitalize truncate text-[15px]">${safeUsername}</h3>
          ${c.last_message_time ? `<span class="text-[11px] text-on-surface-variant/60 shrink-0 ml-2">${formatChatTime(c.last_message_time)}</span>` : ''}
        </div>
        <div class="flex items-center gap-1.5">
          ${lastMsg}
        </div>
      </div>
      ${isUnread ? '<div class="w-2.5 h-2.5 rounded-full bg-primary shrink-0"></div>' : ''}
    </a>
  `;
}

function formatChatTime(dateStr) {
  if (!dateStr) return '';
  const now = new Date();
  const d = new Date(dateStr);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const msgDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.floor((today - msgDay) / (1000 * 60 * 60 * 24));
  
  if (diffDays === 0) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return d.toLocaleDateString('en-US', { weekday: 'short' });
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Real-time update a single chat list item via socket
function updateChatListItem(data) {
  const { connectionId, lastMessage, lastMessageTime, senderId } = data;
  
  // Use findIndex immediately to capture the index BEFORE any concurrent modification.
  // Using indexOf(conn) after other operations is racy because a concurrent call
  // may have already spliced the reference out of the array, causing splice(-1, 1)
  // to remove the wrong element.
  const idx = chatListCache.findIndex(c => c.id == connectionId);
  if (idx === -1) {
    // Reload full list if we don't have this connection cached
    loadMessagesList();
    return;
  }
  
  const conn = chatListCache[idx];
  conn.last_message = lastMessage;
  conn.last_message_time = lastMessageTime;
  conn.last_sender_id = senderId;
  
  // If the current user sent the message (via API), mark as read immediately
  if (senderId === currentUser?.id) {
    conn.last_read = true;
  } else {
    conn.last_read = false;
  }
  
  const list = document.getElementById('messages-list');
  if (!list) return;
  
  // Move this connection to the top and re-render
  chatListCache.splice(idx, 1);
  chatListCache.unshift(conn);
  
  list.innerHTML = chatListCache.map(c => {
    const safeUsername = escapeHtml(c.other_username);
    const isRevealed = c.status === 'revealed';
    const lastMsg = renderLastMessage(c);
    return renderChatListItem(c, safeUsername, isRevealed, lastMsg);
  }).join('');
}

// Update presence dot for a user in the chat list
function updatePresenceDot(userId, isOnline) {
  const dot = document.querySelector(`.presence-dot[data-user-id="${userId}"]`);
  if (dot) {
    if (isOnline) {
      dot.classList.remove('hidden');
      dot.style.background = '#22c55e'; // green-500
    } else {
      dot.classList.add('hidden');
    }
  }
}

