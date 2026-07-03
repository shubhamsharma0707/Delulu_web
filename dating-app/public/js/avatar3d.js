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
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i+1];
        const b = data[i+2];
        
        // Threshold for near-white backgrounds
        const maxVal = Math.max(r, g, b);
        if (maxVal > 240) {
          // Smooth alpha transition to prevent jagged edges
          const alpha = Math.max(0, (255 - maxVal) / 15);
          data[i+3] = Math.min(data[i+3], alpha * 255);
        }
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
  const spacing = 3.2;
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
      idlePath = `/avatars/${profile.gender || 'male'}/${profile.avatar}/idle.jpeg`;
      wavePath = `/avatars/${profile.gender || 'male'}/${profile.avatar}/wave.jpeg`;
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

function updateSceneFromScroll(scrollLeft) {
  const containerWidth = sceneContainer ? sceneContainer.offsetWidth : window.innerWidth;
  const totalWidth = Math.max((avatarGroups.length - 1), 1) * 3.2;
  
  // Convert scroll position to 3D position offset
  const scrollRatio = scrollLeft / Math.max(containerWidth * 0.5, 1);
  const xOffset = -scrollRatio * 1.5;
  
  avatarGroups.forEach((group, i) => {
    const baseX = i * 3.2 - totalWidth / 2;
    const targetX = baseX + xOffset;
    
    // Smooth interpolation
    group.position.x += (targetX - group.position.x) * 0.08;
    
    // Calculate distance from center for effects
    const centerX = -xOffset;
    const distFromCenter = Math.abs(group.position.x - centerX);
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
  currentCenterIndex += (targetIndex - currentCenterIndex) * 0.08;

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
  updateSceneFromScroll(currentCenterIndex * 60);

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
