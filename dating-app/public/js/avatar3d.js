// Single-avatar display — shows one avatar at a time, centered, fades on navigate
let isSceneReady = false;
let currentCenterIndex = 0;
let targetIndex = 0;
let sceneContainer;
let profilesData = [];
let animationId = null;
let waveTimers = [];
let avatarEls = [];  // array of wrapper divs, one per profile

function initAvatarScene(containerId, profiles) {
  destroyAvatarScene();

  sceneContainer = document.getElementById(containerId);
  if (!sceneContainer) return;

  profilesData = profiles;
  currentCenterIndex = 0;
  targetIndex = 0;

  sceneContainer.innerHTML = '';
  sceneContainer.style.cssText = `
    position: relative;
    width: 100%;
    height: 100%;
    min-height: 340px;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    overflow: visible;
  `;

  avatarEls = profiles.map((profile, i) => {
    const idleSrc = profile.avatar && typeof profile.avatar === 'object'
      ? profile.avatar.idle
      : profile.avatar ? `/avatars/${profile.avatar}.png` : null;
    const waveSrc = profile.avatar && typeof profile.avatar === 'object'
      ? profile.avatar.wave
      : idleSrc;

    const wrapper = document.createElement('div');
    wrapper.dataset.index = i;
    wrapper.dataset.state = 'idle';
    wrapper.style.cssText = `
      position: absolute;
      bottom: 0;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      align-items: flex-end;
      justify-content: center;
      opacity: ${i === 0 ? '1' : '0'};
      transition: opacity 0.35s ease;
      pointer-events: ${i === 0 ? 'auto' : 'none'};
    `;

    if (idleSrc) {
      const img = document.createElement('img');
      img.src = idleSrc;
      img.dataset.idle = idleSrc;
      img.dataset.wave = waveSrc || idleSrc;
      img.alt = profile.username;
      img.draggable = false;
      img.style.cssText = `
        height: 320px;
        width: auto;
        object-fit: contain;
        display: block;
        pointer-events: none;
        user-select: none;
        -webkit-user-drag: none;
      `;
      wrapper.appendChild(img);
    } else {
      const fallback = document.createElement('div');
      fallback.textContent = profile.username.charAt(0).toUpperCase();
      fallback.style.cssText = `
        width: 120px; height: 120px; border-radius: 50%;
        background: #ffdad4; color: #731709;
        font-size: 56px; font-weight: 700;
        display: flex; align-items: center; justify-content: center;
      `;
      wrapper.appendChild(fallback);
    }

    sceneContainer.appendChild(wrapper);
    return wrapper;
  });

  isSceneReady = true;
  startFloatAnimation();
  startWaveCycle();

  // Swipe/drag support
  let dragStartX = null;

  const onPointerDown = (e) => {
    dragStartX = e.clientX ?? e.touches?.[0]?.clientX ?? null;
  };
  const onPointerMove = (e) => {
    if (dragStartX === null) return;
    const x = e.clientX ?? e.touches?.[0]?.clientX ?? dragStartX;
    if (Math.abs(x - dragStartX) > 50) {
      const dir = x < dragStartX ? 1 : -1;
      dragStartX = null;
      window.updateAvatarScene(Math.max(0, Math.min(profilesData.length - 1, targetIndex + dir)));
    }
  };
  const onPointerEnd = () => { dragStartX = null; };

  sceneContainer.addEventListener('pointerdown', onPointerDown);
  sceneContainer.addEventListener('pointermove', onPointerMove);
  sceneContainer.addEventListener('pointerup', onPointerEnd);
  sceneContainer.addEventListener('pointercancel', onPointerEnd);
  window.__avatarListeners = { onPointerDown, onPointerMove, onPointerEnd };
}

function showAvatar(index) {
  avatarEls.forEach((el, i) => {
    const visible = i === index;
    el.style.opacity = visible ? '1' : '0';
    el.style.pointerEvents = visible ? 'auto' : 'none';
  });
}

function startFloatAnimation() {
  const floatAmplitude = 7;

  function frame(ts) {
    if (!isSceneReady) return;
    animationId = requestAnimationFrame(frame);

    const centerEl = avatarEls[targetIndex];
    if (centerEl) {
      const img = centerEl.querySelector('img');
      if (img) {
        img.style.marginBottom = (Math.sin(ts * 0.002) * floatAmplitude) + 'px';
      }
    }
  }

  animationId = requestAnimationFrame(frame);
}

function startWaveCycle() {
  function scheduleWave() {
    const id = setTimeout(() => {
      if (!isSceneReady) return;
      const el = avatarEls[targetIndex];
      if (el && el.dataset.state === 'idle') {
        const img = el.querySelector('img');
        if (img && img.dataset.wave) {
          el.dataset.state = 'wave';
          img.src = img.dataset.wave;
          const restoreId = setTimeout(() => {
            if (el && img) {
              el.dataset.state = 'idle';
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

  avatarEls = [];
  profilesData = [];
  sceneContainer = null;
  currentCenterIndex = 0;
  targetIndex = 0;
}

// Called by discover.js when navigating
window.updateAvatarScene = function(index) {
  if (!profilesData.length) return;
  if (index < 0) index = 0;
  if (index >= profilesData.length) index = profilesData.length - 1;
  targetIndex = index;
  currentCenterIndex = index;

  showAvatar(index);

  if (typeof window.updateProfileOverlay === 'function') window.updateProfileOverlay(index);
  if (typeof window.updateNavButtons === 'function') window.updateNavButtons();
};

window.initAvatarScene = initAvatarScene;
window.destroyAvatarScene = destroyAvatarScene;
