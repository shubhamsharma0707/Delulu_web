let discoverProfiles = [];
let currentIndex = 0;
let navTimeout = null;

document.addEventListener('DOMContentLoaded', async () => {
  await requireAuth();
  await loadDiscovery();
  
  // Scroll buttons for 3D scene
  document.getElementById('btn-scroll-left').onclick = () => navigateCards(-1);
  document.getElementById('btn-scroll-right').onclick = () => navigateCards(1);

  // Connect button for 3D scene
  const dismissBtn = document.getElementById('btn-discover-dismiss');
  if (dismissBtn) {
    dismissBtn.onclick = () => handleDismissCenter();
  }
  document.getElementById('btn-discover-connect').onclick = () => handleConnectCenter();

  // Keyboard navigation
  document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') navigateCards(-1);
    if (e.key === 'ArrowRight') navigateCards(1);
  });

  // Smooth scroll wheel/trackpad navigation (debounced vertical scrolling mapped to swiping)
  let lastScrollTime = 0;
  const scrollCooldown = 280; // ms between card swiping transitions
  
  window.addEventListener('wheel', (e) => {
    if (!discoverProfiles.length) return;
    
    // Catch significant vertical scrolls
    if (Math.abs(e.deltaY) > 15) {
      e.preventDefault(); // Stop default vertical scroll repaints
      
      const now = Date.now();
      if (now - lastScrollTime > scrollCooldown) {
        lastScrollTime = now;
        const direction = e.deltaY > 0 ? 1 : -1;
        navigateCards(direction);
      }
    }
  }, { passive: false });
});

async function handleDismissCenter() {
  const profile = discoverProfiles[currentIndex];
  if (!profile) return;
  
  try {
    await apiCall('/api/connections/dismiss', 'POST', { to_user_id: profile.id });
    removeProfileAt(currentIndex);
  } catch (err) {
    alert(err.message);
  }
}

async function handleConnectCenter() {
  const profile = discoverProfiles[currentIndex];
  if (!profile) return;
  
  const btn = document.getElementById('btn-discover-connect');
  btn.disabled = true;
  btn.querySelector('span:not(.material-symbols-outlined)').textContent = 'Sending...';
  
  try {
    await apiCall('/api/connections/request', 'POST', { to_user_id: profile.id });
    removeProfileAt(currentIndex);
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    btn.querySelector('span:not(.material-symbols-outlined)').textContent = 'Connect';
  }
}

function removeProfileAt(index) {
  discoverProfiles.splice(index, 1);
  checkEmptyState();
  
  if (discoverProfiles.length > 0) {
    // Re-initialize 3D scene with the updated profile list
    if (typeof initAvatarScene === 'function') {
      initAvatarScene('avatar-3d-container', discoverProfiles);
      // Snap back to nearest index
      currentIndex = Math.min(index, discoverProfiles.length - 1);
      window.updateAvatarScene(currentIndex);
    }
  } else {
    // Empty state
    if (typeof destroyAvatarScene === 'function') {
      destroyAvatarScene();
    }
  }
}

function navigateCards(dir) {
  if (!discoverProfiles.length) return;
  
  currentIndex += dir;
  if (currentIndex < 0) currentIndex = 0;
  if (currentIndex >= discoverProfiles.length) currentIndex = discoverProfiles.length - 1;
  
  // Update scene via scroll simulation
  const scene = document.getElementById('avatar-3d-container');
  if (scene && window.updateAvatarScene) {
    window.updateAvatarScene(currentIndex);
  }
  
  updateProfileOverlay(currentIndex);
  updateNavButtons();
}

function updateNavButtons() {
  document.getElementById('btn-scroll-left').style.opacity = currentIndex <= 0 ? '0.3' : '1';
  document.getElementById('btn-scroll-left').style.pointerEvents = currentIndex <= 0 ? 'none' : 'auto';
  document.getElementById('btn-scroll-right').style.opacity = currentIndex >= discoverProfiles.length - 1 ? '0.3' : '1';
  document.getElementById('btn-scroll-right').style.pointerEvents = currentIndex >= discoverProfiles.length - 1 ? 'none' : 'auto';
}

function updateProfileOverlay(index) {
  const p = discoverProfiles[index];
  if (!p) return;
  
  const overlay = document.getElementById('center-profile-info');
  if (!overlay) return;
  
  document.getElementById('center-username').textContent = p.username;
  document.getElementById('center-bio').textContent = p.bio || 'Mystery person...';
  
  const hobbiesEl = document.getElementById('center-hobbies');
  if (p.hobbies && p.hobbies.length > 0) {
    hobbiesEl.innerHTML = p.hobbies.map(h => 
      `<span class="px-3 py-1 bg-white/40 backdrop-blur-md rounded-full text-xs font-semibold text-on-surface-variant border border-white/50 shadow-sm">${escapeHtml(h)}</span>`
    ).join('');
  }
}

// Dynamically load Three.js when discover page needs it, to avoid blocking render
function loadThreeJS(callback) {
  if (typeof THREE !== 'undefined') {
    callback();
    return;
  }
  const script = document.createElement('script');
  script.src = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
  script.onload = callback;
  script.onerror = () => {
    console.warn('Three.js failed to load, using fallback cards');
    renderFallbackCards();
  };
  document.head.appendChild(script);
}

async function loadDiscovery() {
  try {
    const data = await apiCall('/api/discover');
    discoverProfiles = data.profiles;
    
    // Cache profiles in sessionStorage for instant back-navigation
    try {
      sessionStorage.setItem('discover_profiles', JSON.stringify(data.profiles));
    } catch (e) {}
    
    init3DScene();
  } catch (err) {
    // Try loading from cache if offline
    try {
      const cached = sessionStorage.getItem('discover_profiles');
      if (cached) {
        discoverProfiles = JSON.parse(cached);
        init3DScene();
        return;
      }
    } catch (e) {}
    console.error(err);
  }
}

function init3DScene() {
  checkEmptyState();
  if (!discoverProfiles || discoverProfiles.length === 0) return;
  
  const container = document.getElementById('avatar-3d-container');
  const overlay = document.getElementById('profile-overlay');
  if (!container) return;
  
  // Load Three.js dynamically first, then initialize scene
  loadThreeJS(() => {
    if (typeof initAvatarScene === 'function') {
      initAvatarScene('avatar-3d-container', discoverProfiles);
      
      // After scene is set up, show first profile
      setTimeout(() => {
        currentIndex = 0;
        updateProfileOverlay(0);
        updateNavButtons();
        if (overlay) overlay.classList.remove('hidden');
      }, 500);
    } else {
      renderFallbackCards();
    }
  });
}

function renderFallbackCards() {
  const container = document.getElementById('avatar-3d-container');
  if (!container) return;
  
  container.innerHTML = `
    <div class="w-full h-full flex items-center justify-center overflow-x-auto snap-x snap-mandatory gap-6 px-8" id="fallback-rail">
      ${discoverProfiles.map((p, i) => {
        const safeUsername = escapeHtml(p.username);
        const safeBio = escapeHtml(p.bio || 'Mystery person...');
        const hobbyChips = (p.hobbies || []).slice(0, 3).map(h => 
          `<span class="px-2 py-0.5 bg-surface-container-high/60 rounded-full text-[10px]">${escapeHtml(h)}</span>`
        ).join('');
        return `
          <div class="discover-card relative w-64 h-[420px] shrink-0 snap-center flex flex-col items-center justify-center bg-white/60 backdrop-blur-xl rounded-3xl shadow-xl border border-white/40 p-4 transition-all duration-300" id="fallback-card-${i}">
            <div class="w-40 h-40 rounded-2xl overflow-hidden shadow-lg mb-3 avatar-img-wrapper transition-all duration-300 ${i === 0 ? 'animate-hello' : ''}">
              ${getAvatarHtml(p.username, p.avatar)}
            </div>
            <h3 class="font-bold text-xl capitalize text-on-surface">${safeUsername}</h3>
            <p class="text-xs text-on-surface-variant mt-1 line-clamp-2 text-center">${safeBio}</p>
            <div class="flex flex-wrap gap-1 justify-center mt-2 mb-3">
              ${hobbyChips}
            </div>
            <div class="flex gap-3 mt-auto">
              <button data-fallback-action="dismiss" data-index="${i}" class="w-10 h-10 rounded-full bg-white shadow-md border border-outline-variant/20 flex items-center justify-center text-on-surface-variant hover:scale-110 transition-all">
                <span class="material-symbols-outlined">close</span>
              </button>
              <button data-fallback-action="connect" data-index="${i}" class="px-5 py-2 rounded-full bg-gradient-to-r from-primary to-primary-container text-white text-sm font-bold shadow-md hover:scale-105 transition-all">
                <span class="material-symbols-outlined text-sm material-fill">favorite</span> Connect
              </button>
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;

  // Bind fallback card events programmatically to prevent adblock/security policy blocking
  container.querySelectorAll('[data-fallback-action]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const action = btn.getAttribute('data-fallback-action');
      const idx = Number(btn.getAttribute('data-index'));
      if (action === 'dismiss') {
        dismissFallback(idx);
      } else if (action === 'connect') {
        connectFallback(idx, btn);
      }
    });
  });
}

function checkEmptyState() {
  const container = document.getElementById('avatar-3d-container');
  const empty = document.getElementById('discovery-empty');
  const overlay = document.getElementById('profile-overlay');
  const navBtns = document.getElementById('btn-scroll-left');
  
  if (!discoverProfiles || discoverProfiles.length === 0) {
    if (container) container.classList.add('hidden');
    if (overlay) overlay.classList.add('hidden');
    if (navBtns) navBtns.parentElement.classList.add('hidden');
    if (empty) {
      empty.classList.remove('hidden');
      empty.classList.add('flex');
    }
  } else {
    if (container) container.classList.remove('hidden');
    if (navBtns) navBtns.parentElement.classList.remove('hidden');
    if (empty) {
      empty.classList.add('hidden');
      empty.classList.remove('flex');
    }
  }
}

// Fallback dismiss
window.dismissFallback = (index) => {
  const card = document.getElementById(`fallback-card-${index}`);
  if (card) {
    card.style.transform = 'scale(0.5) rotateY(-20deg)';
    card.style.opacity = '0';
    setTimeout(() => {
      discoverProfiles.splice(index, 1);
      renderFallbackCards();
      checkEmptyState();
    }, 300);
  }
};

// Fallback connect
window.connectFallback = async (index, btn) => {
  const profile = discoverProfiles[index];
  if (!profile) return;
  
  btn.disabled = true;
  btn.innerHTML = 'Sending...';
  
  try {
    await apiCall('/api/connections/request', 'POST', { to_user_id: profile.id });
    discoverProfiles.splice(index, 1);
    renderFallbackCards();
    checkEmptyState();
  } catch (err) {
    alert(err.message);
    btn.innerHTML = 'Connect';
    btn.disabled = false;
  }
};

// Expose for avatar3d.js to call
window.getDiscoverProfiles = () => discoverProfiles;
window.updateProfileOverlay = updateProfileOverlay;
window.updateNavButtons = updateNavButtons;
window.getCurrentIndex = () => currentIndex;
window.setCurrentIndex = (idx) => { currentIndex = idx; };
window.removeProfile = (id) => {
  discoverProfiles = discoverProfiles.filter(p => p.id !== id);
  checkEmptyState();
};
