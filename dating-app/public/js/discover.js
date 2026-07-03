let discoverProfiles = [];

document.addEventListener('DOMContentLoaded', async () => {
  await requireAuth();
  await loadDiscovery();
  
  const rail = document.getElementById('discovery-rail');
  if (rail) {
    document.getElementById('btn-scroll-left').onclick = () => {
      rail.scrollBy({ left: -312, behavior: 'smooth' }); // card width 288 (w-72) + gap 24 (gap-6)
    };
    document.getElementById('btn-scroll-right').onclick = () => {
      rail.scrollBy({ left: 312, behavior: 'smooth' });
    };

    let ticking = false;
    rail.addEventListener('scroll', () => {
      if (!ticking) {
        window.requestAnimationFrame(() => {
          update3DTransforms();
          ticking = false;
        });
        ticking = true;
      }
    });
  }
});

async function loadDiscovery() {
  try {
    const data = await apiCall('/api/discover');
    discoverProfiles = data.profiles;
    renderDiscoveryRail();
  } catch (err) {
    console.error(err);
  }
}

function renderDiscoveryRail() {
  const rail = document.getElementById('discovery-rail');
  checkEmptyState();
  if (!discoverProfiles || discoverProfiles.length === 0) return;
  
  rail.innerHTML = discoverProfiles.map(p => {
    let matchHtml = '';
    if (p.matching_hobbies && p.matching_hobbies.length > 0) {
      matchHtml = p.matching_hobbies.map(h => `<span class="px-2 py-0.5 bg-white/20 backdrop-blur-md rounded-full text-xs border border-white/30">${h}</span>`).join('');
    } else {
      matchHtml = `<span class="px-2 py-0.5 bg-white/20 backdrop-blur-md rounded-full text-xs border border-white/30">No shared hobbies</span>`;
    }
    
    return `
      <div id="discover-card-${p.id}" class="discover-card relative w-72 h-[420px] shrink-0 snap-center bg-surface rounded-3xl shadow-[0_8px_32px_rgba(165,59,41,0.1)] overflow-hidden flex flex-col transition-all duration-300 origin-center">
        <!-- Avatar BG -->
        <div class="w-full h-full absolute inset-0 bg-primary/5">
          ${getAvatarHtml(p.username, p.avatar)} 
        </div>
        <!-- Gradient Overlay -->
        <div class="absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-black/90 via-black/40 to-transparent z-10"></div>
        
        <!-- Profile Info -->
        <div class="absolute bottom-16 left-0 w-full p-5 text-white flex flex-col justify-end z-20 pointer-events-none">
          <h2 class="font-bold text-2xl mb-0.5 capitalize truncate">${p.username}</h2>
          <p class="text-xs opacity-90 mb-3 line-clamp-2">${p.bio || 'Mystery person...'}</p>
          <div class="flex flex-wrap gap-1">
            ${matchHtml}
          </div>
        </div>

        <!-- Glass Actions Bar -->
        <div class="absolute bottom-4 left-4 right-4 flex justify-between items-center z-30">
          <button onclick="dismissProfile(event, ${p.id})" class="w-10 h-10 rounded-full bg-black/40 hover:bg-black/60 text-white flex items-center justify-center transition-all hover:scale-110 active:scale-95 shadow-sm" title="Pass">
            <span class="material-symbols-outlined text-xl">close</span>
          </button>
          <button onclick="connectProfile(event, ${p.id}, this)" class="px-4 py-2 rounded-full bg-gradient-to-r from-primary to-primary-container text-white flex items-center gap-1.5 hover:scale-105 active:scale-95 transition-all text-xs font-bold shadow-md" title="Connect">
            <span class="material-symbols-outlined text-sm material-fill">favorite</span> Connect
          </button>
        </div>
      </div>
    `;
  }).join('');

  // Initial trigger for 3D transforms
  setTimeout(update3DTransforms, 100);
}

function update3DTransforms() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return;
  }
  const rail = document.getElementById('discovery-rail');
  if (!rail) return;
  
  const railCenter = rail.scrollLeft + rail.offsetWidth / 2;
  const cards = rail.querySelectorAll('.discover-card');
  
  cards.forEach(card => {
    const cardCenter = card.offsetLeft + card.offsetWidth / 2;
    const diff = cardCenter - railCenter;
    const maxDist = rail.offsetWidth / 2;
    const ratio = Math.min(Math.max(diff / maxDist, -1), 1); // Clamp to [-1, 1]
    
    const maxAngle = 15;
    const angle = -ratio * maxAngle;
    const scale = 1 - Math.abs(ratio) * 0.12;
    const opacity = 1 - Math.abs(ratio) * 0.35;
    
    card.style.transform = `perspective(1200px) rotateY(${angle}deg) scale(${scale})`;
    card.style.opacity = opacity;
  });
}

window.dismissProfile = (e, userId) => {
  e.preventDefault();
  const card = document.getElementById(`discover-card-${userId}`);
  if (card) {
    card.classList.add('scale-50', 'opacity-0');
    setTimeout(() => {
      card.remove();
      discoverProfiles = discoverProfiles.filter(p => p.id !== userId);
      checkEmptyState();
      update3DTransforms();
    }, 300);
  }
};

window.connectProfile = async (e, userId, btn) => {
  e.preventDefault();
  btn.disabled = true;
  btn.textContent = 'Connecting...';
  
  try {
    await apiCall('/api/connections/request', 'POST', { to_user_id: userId });
    // Successful connect -> animate card flying up/fading out
    const card = document.getElementById(`discover-card-${userId}`);
    if (card) {
      card.classList.add('-translate-y-12', 'opacity-0');
      setTimeout(() => {
        card.remove();
        discoverProfiles = discoverProfiles.filter(p => p.id !== userId);
        checkEmptyState();
        update3DTransforms();
      }, 300);
    }
  } catch (err) {
    alert(err.message);
    btn.disabled = false;
    btn.innerHTML = `<span class="material-symbols-outlined text-sm material-fill">favorite</span> Connect`;
  }
};

function checkEmptyState() {
  const rail = document.getElementById('discovery-rail');
  const empty = document.getElementById('discovery-empty');
  
  if (!discoverProfiles || discoverProfiles.length === 0) {
    rail.parentElement.classList.add('hidden');
    empty.classList.remove('hidden');
    empty.classList.add('flex');
  } else {
    rail.parentElement.classList.remove('hidden');
    empty.classList.add('hidden');
    empty.classList.remove('flex');
    
    if (discoverProfiles.length === 1) {
      rail.classList.add('justify-center');
    } else {
      rail.classList.remove('justify-center');
    }
  }
}

