let discoverProfiles = [];

document.addEventListener('DOMContentLoaded', async () => {
  await requireAuth();
  await loadDiscovery();
  
  const rail = document.getElementById('discovery-rail');
  if (rail) {
    document.getElementById('btn-scroll-left').onclick = () => {
      rail.scrollBy({ left: -320, behavior: 'smooth' });
    };
    document.getElementById('btn-scroll-right').onclick = () => {
      rail.scrollBy({ left: 320, behavior: 'smooth' });
    };

    let ticking = false;
    rail.addEventListener('scroll', () => {
      if (!ticking) {
        window.requestAnimationFrame(() => {
          update3DTransforms();
          updateCenterCard();
          ticking = false;
        });
        ticking = true;
      }
    });

    // Initial update after a frame
    requestAnimationFrame(() => {
      update3DTransforms();
      updateCenterCard();
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
      matchHtml = p.matching_hobbies.map(h => 
        `<span class="hobby-chip px-3 py-1 bg-white/25 backdrop-blur-md rounded-full text-xs font-semibold border border-white/40 text-on-surface shadow-sm">✨ ${h}</span>`
      ).join('');
    } else {
      matchHtml = `<span class="px-3 py-1 bg-white/20 backdrop-blur-md rounded-full text-xs border border-white/30">No shared hobbies</span>`;
    }

    // Generate all hobbies display
    const allHobbies = p.hobbies && p.hobbies.length > 0
      ? p.hobbies.map(h => 
          `<span class="px-2 py-0.5 bg-surface-container-high/60 backdrop-blur-sm rounded-full text-[10px] font-medium text-on-surface-variant border border-outline-variant/20">${h}</span>`
        ).join('')
      : '';

    return `
      <div id="discover-card-${p.id}" class="discover-card relative w-64 md:w-80 h-[500px] shrink-0 snap-center flex flex-col transition-all duration-300 origin-center justify-end group">
        <!-- Avatar Image -->
        <div class="w-full flex-grow relative flex items-end justify-center mb-4">
          <div class="w-full h-full avatar-img-wrapper transition-all duration-300">
            ${getAvatarHtml(p.username, p.avatar)} 
          </div>
        </div>
        
        <!-- Profile Info -->
        <div class="w-full text-center px-2 flex flex-col items-center">
          <h2 class="font-bold text-2xl mb-1 capitalize text-on-surface">${p.username}</h2>
          <p class="text-sm text-on-surface-variant opacity-90 mb-3 line-clamp-2">${p.bio || 'Mystery person...'}</p>
          <div class="flex flex-wrap gap-1 justify-center mb-2">
            ${allHobbies ? allHobbies : ''}
          </div>
          <div class="flex flex-wrap gap-1 justify-center mb-4">
            ${matchHtml}
          </div>
        </div>

        <!-- Glass Actions Bar -->
        <div class="w-full flex justify-center gap-6 items-center z-30 pb-2">
          <button onclick="dismissProfile(event, ${p.id})" class="w-12 h-12 rounded-full bg-surface shadow-md hover:shadow-lg border border-outline-variant/30 text-on-surface-variant flex items-center justify-center transition-all hover:scale-110 active:scale-95" title="Pass">
            <span class="material-symbols-outlined text-2xl">close</span>
          </button>
          <button onclick="connectProfile(event, ${p.id}, this)" class="px-6 py-3 rounded-full bg-gradient-to-r from-primary to-primary-container text-white flex items-center gap-2 hover:scale-105 active:scale-95 transition-all text-sm font-bold shadow-md hover:shadow-lg" title="Connect">
            <span class="material-symbols-outlined text-lg material-fill">favorite</span> Connect
          </button>
        </div>
      </div>
    `;
  }).join('');

  // Initial trigger for 3D transforms
  setTimeout(() => {
    update3DTransforms();
    updateCenterCard();
  }, 150);
}

function update3DTransforms() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  
  const rail = document.getElementById('discovery-rail');
  if (!rail) return;
  
  const railCenter = rail.scrollLeft + rail.offsetWidth / 2;
  const cards = rail.querySelectorAll('.discover-card');
  
  cards.forEach(card => {
    const cardCenter = card.offsetLeft + card.offsetWidth / 2;
    const diff = cardCenter - railCenter;
    const maxDist = rail.offsetWidth / 2 + card.offsetWidth / 2;
    const ratio = Math.min(Math.max(diff / maxDist, -1), 1);
    
    // Enhanced 3D perspective transform
    const maxAngle = 30;
    const angle = ratio * maxAngle;
    const scale = 1 - Math.abs(ratio) * 0.2;
    const translateZ = -Math.abs(ratio) * 80;
    const opacity = 1 - Math.abs(ratio) * 0.5;
    const blurAmount = Math.abs(ratio) * 2;
    
    // Main card transform with 3D perspective
    card.style.transform = `perspective(1200px) rotateY(${angle}deg) scale(${scale}) translateZ(${translateZ}px)`;
    card.style.opacity = opacity;
    card.style.zIndex = Math.round(100 - Math.abs(ratio) * 100);
    card.style.filter = `blur(${blurAmount}px)`;
    
    // Inner 3D layers - separate transforms for depth
    const inner = card.querySelector('.discover-card-inner');
    if (inner) {
      const innerAngle = angle * 0.3;
      inner.style.transform = `rotateY(${innerAngle}deg) translateZ(3px)`;
    }
    
    // Avatar wrapper - primary 3D layer with hello animation
    const imgWrapper = card.querySelector('.avatar-img-wrapper');
    if (imgWrapper) {
      if (Math.abs(ratio) < 0.2) {
        imgWrapper.classList.add('animate-hello');
        // Enhanced tilt on the avatar itself
        const tiltAngle = angle * 0.15;
        imgWrapper.style.setProperty('--tilt', `${tiltAngle}deg`);
      } else {
        imgWrapper.classList.remove('animate-hello');
        imgWrapper.style.setProperty('--tilt', '0deg');
      }
    }
  });
}

function updateCenterCard() {
  const rail = document.getElementById('discovery-rail');
  if (!rail) return;
  
  const railCenter = rail.scrollLeft + rail.offsetWidth / 2;
  const cards = rail.querySelectorAll('.discover-card');
  
  cards.forEach(card => {
    const cardCenter = card.offsetLeft + card.offsetWidth / 2;
    const diff = Math.abs(cardCenter - railCenter);
    const isCenter = diff < card.offsetWidth * 0.3;
    
    card.classList.toggle('card-center', isCenter);
  });
}

window.dismissProfile = (e, userId) => {
  e.preventDefault();
  const card = document.getElementById(`discover-card-${userId}`);
  if (card) {
    card.style.transform = 'perspective(1200px) rotateY(-15deg) scale(0.3) translateZ(-300px)';
    card.style.opacity = '0';
    setTimeout(() => {
      card.remove();
      discoverProfiles = discoverProfiles.filter(p => p.id !== userId);
      checkEmptyState();
      update3DTransforms();
      updateCenterCard();
    }, 400);
  }
};

window.connectProfile = async (e, userId, btn) => {
  e.preventDefault();
  btn.disabled = true;
  btn.innerHTML = '<span class="material-symbols-outlined text-sm">sync</span> Sending...';
  
  try {
    await apiCall('/api/connections/request', 'POST', { to_user_id: userId });
    // Successful connect -> animate card flying up/fading out with 3D
    const card = document.getElementById(`discover-card-${userId}`);
    if (card) {
      card.style.transform = 'perspective(1200px) rotateY(10deg) scale(0.8) translateY(-80px) translateZ(100px)';
      card.style.opacity = '0';
      setTimeout(() => {
        card.remove();
        discoverProfiles = discoverProfiles.filter(p => p.id !== userId);
        checkEmptyState();
        update3DTransforms();
        updateCenterCard();
      }, 400);
    }
  } catch (err) {
    alert(err.message);
    btn.disabled = false;
    btn.innerHTML = `<span class="material-symbols-outlined text-lg material-fill">favorite</span> Connect`;
  }
};

function checkEmptyState() {
  const rail = document.getElementById('discovery-rail');
  const empty = document.getElementById('discovery-empty');
  const scrollBtns = document.querySelectorAll('#btn-scroll-left, #btn-scroll-right');
  
  if (!discoverProfiles || discoverProfiles.length === 0) {
    if (rail && rail.parentElement) rail.parentElement.classList.add('hidden');
    if (empty) {
      empty.classList.remove('hidden');
      empty.classList.add('flex');
    }
    scrollBtns.forEach(b => b.classList.add('hidden'));
  } else {
    if (rail && rail.parentElement) rail.parentElement.classList.remove('hidden');
    if (empty) {
      empty.classList.add('hidden');
      empty.classList.remove('flex');
    }
    scrollBtns.forEach(b => b.classList.remove('hidden'));
    
    if (discoverProfiles.length === 1) {
      rail.classList.add('justify-center');
    } else {
      rail.classList.remove('justify-center');
    }
  }
}
