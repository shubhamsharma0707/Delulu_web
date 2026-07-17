// CSS-based Avatar Carousel — replaces Three.js WebGL to guarantee pixel-perfect colors
let avatarGroups = [];
let isSceneReady = false;
let currentCenterIndex = 0;
let targetIndex = 0;
let sceneContainer;
let profilesData = [];
let animationId = null;
let waveTimers = [];

function initAvatarScene(containerId, profiles) {
  destroyAvatarScene();

  sceneContainer = document.getElementById(containerId);
  if (!sceneContainer) return;

  profilesData = profiles;
  currentCenterIndex = 0;
  targetIndex = 0;

  // Build the CSS carousel DOM
  sceneContainer.innerHTML = '';
  sceneContainer.style.cssText = `
    position: relative;
    width: 100%;
    height: 100%;
    overflow: visible;
    display: flex;
    align-items: flex-end;
    justify-content: center;
  `;

  avatarGroups = profiles.map((profile, i) => {
    const idleSrc = profile.avatar && typeof profile.avatar === 'object'
      ? profile.avatar.idle
      : profile.avatar ? `/avatars/${profile.avatar}.png` : null;
    const waveSrc = profile.avatar && typeof profile.avatar === 'object'
      ? profile.avatar.wave
      : idleSrc;

    const wrapper = document.createElement('div');
    wrapper.dataset.index = i;
    wrapper.style.cssText = `
      position: absolute;
      bottom: 0;
      left: 50%;
      display: flex;
      flex-direction: column;
      align-items: center;
      transform-origin: bottom center;
      transition: transform 0.5s cubic-bezier(0.34,1.56,0.64,1), opacity 0.4s ease;
      pointer-events: none;
      will-change: transform, opacity;
    `;

    if (idleSrc) {
      const imgIdle = document.createElement('img');
      imgIdle.src = idleSrc;
      imgIdle.dataset.idle = idleSrc;
      imgIdle.dataset.wave = waveSrc || idleSrc;
      imgIdle.alt = profile.username;
      imgIdle.draggable = false;
      imgIdle.style.cssText = `
        width: auto;
        height: 320px;
        object-fit: contain;
        display: block;
        pointer-events: none;
        user-select: none;
        -webkit-user-drag: none;
      `;
      wrapper.appendChild(imgIdle);
      wrapper.dataset.state = 'idle';
    } else {
      // Fallback letter avatar
      const fallback = document.createElement('div');
      fallback.textContent = profile.username.charAt(0).toUpperCase();
      fallback.style.cssText = `
        width: 120px;
        height: 120px;
        border-radius: 50%;
        background: #ffdad4;
        color: #731709;
        font-size: 56px;
        font-weight: 700;
        display: flex;
        align-items: center;
        justify-content: center;
      `;
      wrapper.appendChild(fallback);
    }

    sceneContainer.appendChild(wrapper);
    return wrapper;
  });

  isSceneReady = true;
  updateLayout(0);
  startAnimation();
  startWaveCycle();

  // Touch/pointer drag support
  let dragStart = null;
  let dragging = false;

  const onPointerDown = (e) => {
    dragStart = e.clientX ?? e.touches?.[0]?.clientX;
    dragging = true;
  };
  const onPointerMove = (e) => {
    if (!dragging || dragStart === null) return;
    const x = e.clientX ?? e.touches?.[0]?.clientX;
    if (Math.abs(x - dragStart) > 40) {
      const dir = x < dragStart ? 1 : -1;
      dragging = false;
      dragStart = null;
      window.updateAvatarScene(Math.max(0, Math.min(profilesData.length - 1, targetIndex + dir)));
      if (typeof window.updateNavButtons === 'function') window.updateNavButtons();
    }
  };
  const onPointerEnd = () => { dragging = false; dragStart = null; };

  sceneContainer.addEventListener('pointerdown', onPointerDown);
  sceneContainer.addEventListener('pointermove', onPointerMove);
  sceneContainer.addEventListener('pointerup', onPointerEnd);
  sceneContainer.addEventListener('pointercancel', onPointerEnd);

  window.__avatarListeners = { onPointerDown, onPointerMove, onPointerEnd };
}

function updateLayout(centerIdx) {
  const total = avatarGroups.length;
  if (!total) return;

  const isMobile = window.innerWidth < 768;
  // Spacing between cards in px (visual center-to-center)
  const spacing = isMobile ? 90 : 140;

  avatarGroups.forEach((wrapper, i) => {
    const offset = i - centerIdx;
    const absOffset = Math.abs(offset);

    const tx = offset * spacing;
    const scale = 1 - Math.min(absOffset * 0.18, 0.55);
    const opacity = absOffset > 2.5 ? 0 : Math.max(0.1, 1 - absOffset * 0.38);
    const zIndex = 100 - Math.round(absOffset * 10);

    wrapper.style.transform = `translateX(calc(-50% + ${tx}px)) scale(${scale})`;
    wrapper.style.opacity = opacity;
    wrapper.style.zIndex = zIndex;
  });
}

function startAnimation() {
  let lastTime = 0;
  const floatAmplitude = 6; // px up/down

  function frame(ts) {
    if (!isSceneReady) return;
    animationId = requestAnimationFrame(frame);

    // Lerp currentCenterIndex toward targetIndex
    currentCenterIndex += (targetIndex - currentCenterIndex) * 0.12;

    // Update card positions
    updateLayout(currentCenterIndex);

    // Floating bob only on the center card
    const centerWrapper = avatarGroups[Math.round(currentCenterIndex)];
    if (centerWrapper) {
      const img = centerWrapper.querySelector('img');
      if (img) {
        const bob = Math.sin(ts * 0.002) * floatAmplitude;
        img.style.marginBottom = bob + 'px';
      }
    }
  }

  animationId = requestAnimationFrame(frame);
}

function startWaveCycle() {
  // Swap idle→wave→idle for center card on a 3s cycle
  function scheduleWave() {
    const id = setTimeout(() => {
      if (!isSceneReady) return;

      const centerWrapper = avatarGroups[Math.round(targetIndex)];
      if (centerWrapper && centerWrapper.dataset.state === 'idle') {
        const img = centerWrapper.querySelector('img');
        if (img && img.dataset.wave) {
          centerWrapper.dataset.state = 'wave';
          img.src = img.dataset.wave;

          const restoreId = setTimeout(() => {
            if (centerWrapper && img) {
              centerWrapper.dataset.state = 'idle';
              img.src = img.dataset.idle;
            }
            scheduleWave();
          }, 600);
          waveTimers.push(restoreId);
        } else {
          scheduleWave();
        }
      } else {
        scheduleWave();
      }
    }, 3000);
    waveTimers.push(id);
  }

  scheduleWave();
}

function destroyAvatarScene() {
  isSceneReady = false;

  if (animationId) {
    cancelAnimationFrame(animationId);
    animationId = null;
  }

  waveTimers.forEach(id => clearTimeout(id));
  waveTimers = [];

  if (window.__avatarListeners && sceneContainer) {
    const { onPointerDown, onPointerMove, onPointerEnd } = window.__avatarListeners;
    sceneContainer.removeEventListener('pointerdown', onPointerDown);
    sceneContainer.removeEventListener('pointermove', onPointerMove);
    sceneContainer.removeEventListener('pointerup', onPointerEnd);
    sceneContainer.removeEventListener('pointercancel', onPointerEnd);
    window.__avatarListeners = null;
  }

  if (sceneContainer) {
    sceneContainer.innerHTML = '';
    sceneContainer.style.cssText = '';
  }

  avatarGroups = [];
  profilesData = [];
  sceneContainer = null;
  currentCenterIndex = 0;
  targetIndex = 0;
}

// Exposed navigation — called by discover.js
window.updateAvatarScene = function(index) {
  if (!profilesData.length) return;
  if (index < 0) index = 0;
  if (index >= profilesData.length) index = profilesData.length - 1;
  targetIndex = index;

  if (typeof window.updateProfileOverlay === 'function') {
    window.updateProfileOverlay(index);
  }
  if (typeof window.updateNavButtons === 'function') {
    window.updateNavButtons();
  }
};

// Expose to window
window.initAvatarScene = initAvatarScene;
window.destroyAvatarScene = destroyAvatarScene;
