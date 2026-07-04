// 3D Avatar Scene using Three.js
let scene, camera, renderer;
let avatarGroups = [];
let particles;
let mouseX = 0, mouseY = 0;
let targetMouseX = 0, targetMouseY = 0;
let isSceneReady = false;
let currentCenterIndex = 0;
let targetIndex = 0;
let onCardClick = null;
let onCardConnect = null;
let sceneContainer;
let profilesData = [];

function loadAndProcessTexture(path, callback) {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    
    try {
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imgData.data;
      const w = canvas.width;
      const h = canvas.height;
      
      // Flood fill traversal state
      const visited = new Uint8Array(w * h);
      const queue = [];
      
      const isLightPixel = (x, y) => {
        const idx = (y * w + x) * 4;
        const r = data[idx];
        const g = data[idx+1];
        const b = data[idx+2];
        
        const isNeutral = (Math.abs(r - g) < 12 && Math.abs(g - b) < 12);
        const isLight = (r > 100 && g > 100 && b > 100);
        return isNeutral && isLight;
      };
      
      const addNode = (x, y) => {
        if (x < 0 || x >= w || y < 0 || y >= h) return;
        const idx = y * w + x;
        if (visited[idx]) return;
        
        if (isLightPixel(x, y)) {
          visited[idx] = 1;
          queue.push(idx);
        }
      };
      
      for (let x = 0; x < w; x++) {
        addNode(x, 0);
        addNode(x, h - 1);
      }
      for (let y = 0; y < h; y++) {
        addNode(0, y);
        addNode(w - 1, y);
      }
      
      let head = 0;
      while (head < queue.length) {
        const idx = queue[head++];
        const x = idx % w;
        const y = Math.floor(idx / w);
        
        data[idx * 4 + 3] = 0;
        
        addNode(x + 1, y);
        addNode(x - 1, y);
        addNode(x, y + 1);
        addNode(x, y - 1);
      }
      
      ctx.putImageData(imgData, 0, 0);
    } catch (e) {
      console.warn("Failed to apply chroma key filter due to security/CORS, loading fallback texture:", e);
    }
    
    const texture = new THREE.CanvasTexture(canvas);
    if (THREE.sRGBEncoding) {
      texture.encoding = THREE.sRGBEncoding;
    }
    texture.needsUpdate = true;
    callback(texture);
  };
  img.onerror = (err) => {
    console.error("Error loading image:", path, err);
  };
  img.src = path;
}

function initAvatarScene(containerId, profiles) {
  destroyAvatarScene();
  
  sceneContainer = document.getElementById(containerId);
  if (!sceneContainer) return;
  
  const rect = sceneContainer.getBoundingClientRect();
  const width = rect.width || window.innerWidth;
  const height = rect.height || 500;

  // Scene
  scene = new THREE.Scene();
  scene.background = null; // transparent

  // Camera
  camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
  camera.position.set(0, 1.5, 8);
  camera.lookAt(0, 0, 0);

  // Renderer
  renderer = new THREE.WebGLRenderer({ 
    alpha: true, 
    antialias: true,
    powerPreference: "high-performance"
  });
  renderer.setSize(width, height);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  if (renderer.toneMapping) {
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;
  }
  sceneContainer.appendChild(renderer.domElement);

  // Lighting
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambientLight);

  const mainLight = new THREE.DirectionalLight(0xffffff, 1.2);
  mainLight.position.set(5, 8, 5);
  mainLight.castShadow = true;
  scene.add(mainLight);

  const fillLight = new THREE.DirectionalLight(0xffb4a6, 0.5);
  fillLight.position.set(-3, 2, 4);
  scene.add(fillLight);

  const rimLight = new THREE.DirectionalLight(0xff7e67, 0.4);
  rimLight.position.set(0, -2, -6);
  scene.add(rimLight);

  // Store profiles data
  profilesData = profiles;

  // Create avatar cards
  createAvatarCards(profiles);

  // Particles
  createParticles();

  // Drag-to-scroll implementation
  let isDragging = false;
  let startX = 0;
  let scrollStart = 0;

  sceneContainer.style.touchAction = 'none'; // Prevent browser scroll during grab
  
  sceneContainer.addEventListener('pointerdown', (e) => {
    isDragging = true;
    startX = e.clientX;
    scrollStart = targetIndex;
    sceneContainer.style.cursor = 'grabbing';
    sceneContainer.setPointerCapture(e.pointerId);
  });

  sceneContainer.addEventListener('pointermove', (e) => {
    if (!isDragging) return;
    const deltaX = e.clientX - startX;
    const sensitivity = 0.005;
    let newIndex = scrollStart - deltaX * sensitivity;
    newIndex = Math.max(0, Math.min(newIndex, profilesData.length - 1));
    targetIndex = newIndex;
  });

  const endDrag = (e) => {
    if (!isDragging) return;
    isDragging = false;
    sceneContainer.style.cursor = 'grab';
    if (e && e.pointerId) {
      try {
        sceneContainer.releasePointerCapture(e.pointerId);
      } catch (err) {}
    }
    
    // Snap to nearest integer index
    targetIndex = Math.round(targetIndex);
    
    // Sync back to discover.js state
    if (typeof window.setCurrentIndex === 'function') {
      window.setCurrentIndex(targetIndex);
    }
    if (typeof window.updateProfileOverlay === 'function') {
      window.updateProfileOverlay(targetIndex);
    }
    if (typeof window.updateNavButtons === 'function') {
      window.updateNavButtons();
    }
  };

  sceneContainer.addEventListener('pointerup', endDrag);
  sceneContainer.addEventListener('pointercancel', endDrag);

  // Events
  window.addEventListener('resize', onResize);
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('touchmove', onTouchMove, { passive: true });

  isSceneReady = true;
  animate();
}

function createAvatarCards(profiles) {
  // Remove old groups
  avatarGroups.forEach(g => scene.remove(g));
  avatarGroups = [];

  const cardWidth = 2.2;
  const cardHeight = 3.6;
  const spacing = 4.2;
  const totalWidth = (profiles.length - 1) * spacing;

  profiles.forEach((profile, i) => {
    const group = new THREE.Group();
    group.userData = { profile, index: i, state: 'idle', lastSwap: Date.now() };
    
    const xPos = i * spacing - totalWidth / 2;
    group.position.set(xPos, 0, 0);

    // Get asset paths (fallback to old structure just in case)
    let idlePath = null, wavePath = null;
    if (profile.avatar && typeof profile.avatar === 'object') {
      idlePath = profile.avatar.idle;
      wavePath = profile.avatar.wave;
    } else if (profile.avatar) {
      idlePath = `/avatars/${profile.gender || 'male'}/${profile.avatar}.jpeg`;
      wavePath = `/avatars/${profile.gender || 'male'}/${profile.avatar}.jpeg`;
    }

    if (idlePath) {
      const avatarGeo = new THREE.PlaneGeometry(cardWidth * 1.8, cardHeight * 1.3);
      
      const avatarMat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        side: THREE.DoubleSide
      });
      const avatarMesh = new THREE.Mesh(avatarGeo, avatarMat);
      avatarMesh.position.set(0, 0.4, 0);
      group.add(avatarMesh);
      group.userData.mesh = avatarMesh;

      loadAndProcessTexture(idlePath, (texIdle) => {
        group.userData.texIdle = texIdle;
        
        // Auto-scale mesh width to match image aspect ratio
        if (texIdle.image && texIdle.image.width && texIdle.image.height) {
          const aspect = texIdle.image.width / texIdle.image.height;
          const baseAspect = (cardWidth * 1.8) / (cardHeight * 1.3);
          avatarMesh.scale.x = aspect / baseAspect;
        }

        if (group.userData.state === 'idle') {
          avatarMat.map = texIdle;
          avatarMat.needsUpdate = true;
        }
        
        loadAndProcessTexture(wavePath, (texWave) => {
          group.userData.texWave = texWave;
        });
      });

    } else {
      // Fallback
      const initial = profile.username.charAt(0).toUpperCase();
      const canvas = document.createElement('canvas');
      canvas.width = 256; canvas.height = 256;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffdad4'; ctx.fillRect(0, 0, 256, 256);
      ctx.fillStyle = '#731709'; ctx.font = 'bold 120px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(initial, 128, 128);
      
      const texture = new THREE.CanvasTexture(canvas);
      const mat = new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(cardWidth, cardHeight), mat);
      group.add(mesh);
    }

    scene.add(group);
    avatarGroups.push(group);
  });

  updateSceneFromScroll(0);
}

function createParticles() {
  const particleCount = 200;
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(particleCount * 3);
  const sizes = new Float32Array(particleCount);

  for (let i = 0; i < particleCount; i++) {
    positions[i * 3] = (Math.random() - 0.5) * 20;
    positions[i * 3 + 1] = (Math.random() - 0.5) * 10;
    positions[i * 3 + 2] = (Math.random() - 0.5) * 10 - 2;
    sizes[i] = Math.random() * 3 + 1;
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

  const textureCanvas = document.createElement('canvas');
  textureCanvas.width = 32;
  textureCanvas.height = 32;
  const ctx = textureCanvas.getContext('2d');
  const gradient = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
  gradient.addColorStop(0, 'rgba(165, 59, 41, 0.4)');
  gradient.addColorStop(0.3, 'rgba(165, 59, 41, 0.15)');
  gradient.addColorStop(1, 'rgba(165, 59, 41, 0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 32, 32);
  const particleTexture = new THREE.CanvasTexture(textureCanvas);

  const particleMat = new THREE.PointsMaterial({
    size: 0.15,
    map: particleTexture,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    opacity: 0.6,
  });

  particles = new THREE.Points(geometry, particleMat);
  scene.add(particles);
}

function updateSceneFromScroll(index) {
  const spacing = 4.2;
  const totalWidth = (avatarGroups.length - 1) * spacing;
  const xOffset = totalWidth / 2 - index * spacing;
  
  avatarGroups.forEach((group, i) => {
    const baseX = i * spacing - totalWidth / 2;
    const targetX = baseX + xOffset;
    
    // Smooth interpolation
    group.position.x += (targetX - group.position.x) * 0.22;
    
    // Calculate distance from center for effects (center is always X = 0)
    const distFromCenter = Math.abs(group.position.x);
    const maxDist = 6;
    const ratio = Math.min(distFromCenter / maxDist, 1);
    
    // Scale based on distance
    const scale = 1 - ratio * 0.3;
    group.scale.set(scale, scale, scale);
    
    // Y-axis floating
    const floatOffset = Math.sin(Date.now() * 0.001 + i * 1.5) * 0.08;
    group.position.y = floatOffset;
    
    // Z-axis depth
    group.position.z = -ratio * 2;
    
    // Opacity based on distance
    const children = group.children;
    children.forEach(child => {
      if (child.material) {
        const baseOpacity = ratio < 0.5 ? 1 : 1 - (ratio - 0.5) * 2;
        child.material.opacity = Math.max(0.1, baseOpacity);
        child.material.transparent = true;
      }
    });
    
    // Animation state logic
    const now = Date.now();
    if (ratio < 0.3) {
      // Centered card: swap textures every 3 seconds (2500ms idle, 500ms wave)
      if (now - group.userData.lastSwap > 3000) {
        group.userData.lastSwap = now;
        group.userData.state = 'wave';
        if (group.userData.mesh && group.userData.texWave) {
          group.userData.mesh.material.map = group.userData.texWave;
          group.userData.mesh.material.needsUpdate = true;
        }
        
        // Schedule return to idle after 500ms
        setTimeout(() => {
          if (group.userData && group.userData.mesh && group.userData.texIdle) {
            group.userData.state = 'idle';
            group.userData.mesh.material.map = group.userData.texIdle;
            group.userData.mesh.material.needsUpdate = true;
          }
        }, 500);
      }
      
      const waveTime = now * 0.002;
      const waveAmount = 0.04;
      group.rotation.y = Math.sin(waveTime) * waveAmount;
      group.rotation.x = Math.sin(waveTime * 0.7) * waveAmount * 0.5;
      group.position.y += Math.sin(waveTime * 1.3) * 0.04;
    } else {
      // Not centered: ensure idle state
      if (group.userData.state !== 'idle') {
        group.userData.state = 'idle';
        if (group.userData.mesh && group.userData.texIdle) {
          group.userData.mesh.material.map = group.userData.texIdle;
          group.userData.mesh.material.needsUpdate = true;
        }
      }
      group.rotation.y = 0;
      group.rotation.x = 0;
    }
  });
}

function onResize() {
  if (!sceneContainer || !camera || !renderer) return;
  const rect = sceneContainer.getBoundingClientRect();
  const width = rect.width || window.innerWidth;
  const height = rect.height || 500;
  
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height);
}

function onMouseMove(e) {
  targetMouseX = (e.clientX / window.innerWidth) * 2 - 1;
  targetMouseY = -(e.clientY / window.innerHeight) * 2 + 1;
}

function onTouchMove(e) {
  if (e.touches.length > 0) {
    targetMouseX = (e.touches[0].clientX / window.innerWidth) * 2 - 1;
    targetMouseY = -(e.touches[0].clientY / window.innerHeight) * 2 + 1;
  }
}

function animate() {
  if (!isSceneReady) return;
  
  requestAnimationFrame(animate);

  // Smooth currentIndex toward targetIndex
  currentCenterIndex += (targetIndex - currentCenterIndex) * 0.22;

  // Smooth mouse follow
  mouseX += (targetMouseX - mouseX) * 0.05;
  mouseY += (targetMouseY - mouseY) * 0.05;

  // Camera parallax from mouse
  if (camera) {
    camera.position.x = mouseX * 0.3;
    camera.position.y = 1.5 + mouseY * 0.2;
    camera.lookAt(0, 0.3, 0);
  }

  // Update 3D card positions from current index
  updateSceneFromScroll(currentCenterIndex);

  // Animate particles
  if (particles) {
    const positions = particles.geometry.attributes.position.array;
    for (let i = 1; i < positions.length; i += 3) {
      positions[i] += Math.sin(Date.now() * 0.0005 + i) * 0.001;
      positions[i - 1] += Math.cos(Date.now() * 0.0005 + i) * 0.001;
    }
    particles.geometry.attributes.position.needsUpdate = true;
    particles.rotation.y += 0.0003;
  }

  renderer.render(scene, camera);
}

function destroyAvatarScene() {
  isSceneReady = false;
  if (renderer) {
    renderer.dispose();
    if (renderer.domElement && renderer.domElement.parentNode) {
      renderer.domElement.parentNode.removeChild(renderer.domElement);
    }
  }
  avatarGroups = [];
  scene = null;
  camera = null;
  renderer = null;
  particles = null;
}

// Exposed navigation — called by discover.js
window.updateAvatarScene = function(index) {
  if (index < 0) index = 0;
  if (index >= profilesData.length) index = profilesData.length - 1;
  targetIndex = index;
  
  // Also update profile overlay if the function exists
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
