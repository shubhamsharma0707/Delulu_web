// 3-avatar discover carousel: center card is hero, left/right are peeking side cards
// Uses fixed slot offsets so gap is always visible regardless of screen size

let isSceneReady = false;
let currentCenterIndex = 0;
let targetIndex = 0;
let sceneContainer;
let profilesData = [];
let animationId = null;
let waveTimers = [];
let avatarEls = []; // one DOM element per profile

// ─── Slot offsets from screen center (in vw units converted at runtime) ──────
// Slot -1 (left)  : -38vw
// Slot  0 (center): 0
// Slot +1 (right) : +38vw
function getSlotOffset() {
  return Math.round(window.innerWidth * 0.38);
}

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
      transform-origin: bottom center;
      transition: transform 0.45s cubic-bezier(0.34,1.4,0.64,1), opacity 0.35s ease;
      will-change: transform, opacity;
    `;

    if (idleSrc) {
      const img = document.createElement('img');
      img.src = idleSrc;
      img.dataset.idle = idleSrc;
      img.dataset.wave = waveSrc || idleSrc;
      img.alt = profile.username || '';
      img.draggable = false;
      img.style.cssText = `
        height: 300px;
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
      fallback.textContent = (profile.username || '?').charAt(0).toUpperCase();
      fallback.style.cssText = `
        width:110px;height:110px;border-radius:50%;
        background:#ffdad4;color:#731709;
        font-size:52px;font-weight:700;
        display:flex;align-items:center;justify-content:center;
      `;
      wrapper.appendChild(fallback);
    }

    sceneContainer.appendChild(wrapper);
    return wrapper;
  });

  isSceneReady = true;
  applyLayout(targetIndex); // initial placement (no animation)
  startFloatAnimation();
  startWaveCycle();

  // ── Swipe / drag ──────────────────────────────────────────────────────────
  let dragStartX = null;
  const onPointerDown = (e) => { dragStartX = e.clientX ?? e.touches?.[0]?.clientX ?? null; };
  const onPointerMove = (e) => {
    if (dragStartX === null) return;
    const x = e.clientX ?? e.touches?.[0]?.clientX ?? dragStartX;
    if (Math.abs(x - dragStartX) > 48) {
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

// ─── Position every avatar relative to the current center index ───────────
function applyLayout(centerIdx) {
  const slotPx = getSlotOffset(); // px distance between slots

  avatarEls.forEach((wrapper, i) => {
    const slot = i - centerIdx;        // -2, -1, 0, 1, 2 …
    const absSlot = Math.abs(slot);

    // Only show center and immediate neighbours
    const visible = absSlot <= 1;
    if (!visible) {
      wrapper.style.opacity = '0';
      wrapper.style.pointerEvents = 'none';
      wrapper.style.transform = `translateX(calc(-50% + ${slot * slotPx}px)) scale(0.6)`;
      return;
    }

    const tx    = slot * slotPx;                          // px offset from center
    const scale = slot === 0 ? 1.0 : 0.68;              // center full, sides 68 %
    const opacity = slot === 0 ? 1 : 0.45;              // center bright, sides faded

    wrapper.style.opacity = String(opacity);
    wrapper.style.pointerEvents = slot === 0 ? 'auto' : 'none';
    wrapper.style.transform = `translateX(calc(-50% + ${tx}px)) scale(${scale})`;
    wrapper.style.zIndex = slot === 0 ? '10' : '1';
  });
}

// ─── Floating bob on center avatar ────────────────────────────────────────
function startFloatAnimation() {
  function frame(ts) {
    if (!isSceneReady) return;
    animationId = requestAnimationFrame(frame);

    const el = avatarEls[targetIndex];
    if (el) {
      const img = el.querySelector('img');
      if (img) img.style.marginBottom = (Math.sin(ts * 0.002) * 7) + 'px';
    }
  }
  animationId = requestAnimationFrame(frame);
}

// ─── Wave animation on center avatar every 3 s ────────────────────────────
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
          const r = setTimeout(() => {
            if (el && img) { el.dataset.state = 'idle'; img.src = img.dataset.idle; }
            scheduleWave();
          }, 600);
          waveTimers.push(r);
        } else { scheduleWave(); }
      } else { scheduleWave(); }
    }, 3000);
    waveTimers.push(id);
  }
  scheduleWave();
}

// ─── Cleanup ──────────────────────────────────────────────────────────────
function destroyAvatarScene() {
  isSceneReady = false;

  if (animationId) { cancelAnimationFrame(animationId); animationId = null; }
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

  if (sceneContainer) { sceneContainer.innerHTML = ''; sceneContainer.style.cssText = ''; }
  avatarEls = []; profilesData = []; sceneContainer = null;
  currentCenterIndex = 0; targetIndex = 0;
}

// ─── Public API (called by discover.js) ───────────────────────────────────
window.updateAvatarScene = function(index) {
  if (!profilesData.length) return;
  index = Math.max(0, Math.min(profilesData.length - 1, index));
  targetIndex = index;
  currentCenterIndex = index;

  applyLayout(index);

  if (typeof window.updateProfileOverlay === 'function') window.updateProfileOverlay(index);
  if (typeof window.updateNavButtons === 'function') window.updateNavButtons();
};

window.initAvatarScene = initAvatarScene;
window.destroyAvatarScene = destroyAvatarScene;
