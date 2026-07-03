let previewRenderer, previewScene, previewCamera, previewMesh, previewAnimationId;
let previewTexIdle, previewTexWave;
let previewState = 'idle';
let previewLastSwap = Date.now();

document.addEventListener('DOMContentLoaded', async () => {
  await requireAuth();
  
  if (currentUser) {
    document.getElementById('prof-username').textContent = currentUser.username;
    document.getElementById('prof-bio').value = currentUser.bio || '';
    if (currentUser.hobbies) {
      document.getElementById('prof-hobbies').value = currentUser.hobbies.join(', ');
    }
    
    // Avatar selection grid setup
    const avatarGrid = document.getElementById('prof-avatar-grid');
    const avatarInput = document.getElementById('prof-avatar-input');
    const gender = currentUser.gender || 'other';
    avatarInput.value = currentUser.avatar || '';

    let avatars = [];
    if (gender === 'male') {
      for (let i = 1; i <= 10; i++) avatars.push(`male_${String(i).padStart(2, '0')}`);
    } else if (gender === 'female') {
      for (let i = 1; i <= 10; i++) avatars.push(`female_${String(i).padStart(2, '0')}`);
    } else {
      for (let i = 1; i <= 10; i++) {
        avatars.push(`female_${String(i).padStart(2, '0')}`);
        avatars.push(`male_${String(i).padStart(2, '0')}`);
      }
    }

    avatars.forEach(av => {
      const wrapper = document.createElement('div');
      wrapper.className = 'aspect-square rounded-lg overflow-hidden border border-outline-variant/30 hover:border-primary/50 cursor-pointer transition-all flex items-center justify-center p-1 bg-surface-container';
      if (currentUser.avatar === av) {
        wrapper.classList.add('border-primary', 'border-2', 'ring-2', 'ring-primary/20');
      }
      wrapper.innerHTML = `<img src="/avatars/${av}.jpeg" class="w-full h-full object-cover">`;
      wrapper.onclick = () => {
        avatarGrid.querySelectorAll('.aspect-square').forEach(el => el.classList.remove('border-primary', 'border-2', 'ring-2', 'ring-primary/20'));
        wrapper.classList.add('border-primary', 'border-2', 'ring-2', 'ring-primary/20');
        avatarInput.value = av;
        update3DPreview(av, gender);
      };
      avatarGrid.appendChild(wrapper);
    });

    document.getElementById('prof-avatar').innerHTML = getAvatarHtml(currentUser.username, currentUser.avatar);
    
    // Initial 3D avatar preview load
    if (currentUser.avatar) {
      update3DPreview(currentUser.avatar, gender);
    }
  }
  
  document.getElementById('profile-form').onsubmit = async (e) => {
    e.preventDefault();
    const bio = document.getElementById('prof-bio').value;
    const hobbiesStr = document.getElementById('prof-hobbies').value;
    const hobbies = hobbiesStr ? hobbiesStr.split(',').map(s=>s.trim()).filter(Boolean) : [];
    const avatar = document.getElementById('prof-avatar-input').value;
    const msgEl = document.getElementById('prof-msg');
    
    if (!avatar) {
      msgEl.textContent = 'Please select an avatar';
      msgEl.className = 'text-sm font-semibold text-error';
      msgEl.classList.remove('hidden');
      return;
    }

    try {
      await apiCall('/api/users/me', 'PUT', { bio, hobbies, avatar });
      msgEl.textContent = 'Profile updated successfully!';
      msgEl.className = 'text-sm font-semibold text-primary';
      msgEl.classList.remove('hidden');
      
      // Update local state and avatar
      currentUser.bio = bio;
      currentUser.hobbies = hobbies;
      currentUser.avatar = avatar;
      document.getElementById('prof-avatar').innerHTML = getAvatarHtml(currentUser.username, currentUser.avatar);
      updateHeaderAvatar();
      
      setTimeout(() => { msgEl.classList.add('hidden'); msgEl.textContent = ''; }, 3000);
    } catch(err) {
      msgEl.textContent = err.message;
      msgEl.className = 'text-sm font-semibold text-error';
      msgEl.classList.remove('hidden');
    }
  };
});

// Three.js 3D Preview Engine
function init3DPreview() {
  const container = document.getElementById('profile-3d-preview');
  if (!container) return;

  container.innerHTML = '';

  const rect = container.getBoundingClientRect();
  const width = container.clientWidth || rect.width || 300;
  const height = container.clientHeight || rect.height || 400;

  // Scene
  previewScene = new THREE.Scene();

  // Camera
  previewCamera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
  previewCamera.position.set(0, 0, 5);

  // Renderer
  previewRenderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  previewRenderer.setSize(width, height);
  previewRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(previewRenderer.domElement);

  // Ambient Lighting
  const ambientLight = new THREE.AmbientLight(0xffffff, 1.0);
  previewScene.add(ambientLight);

  // Resize Handler
  window.addEventListener('resize', onPreviewResize);

  // Run loop
  animatePreview();
}

function onPreviewResize() {
  const container = document.getElementById('profile-3d-preview');
  if (!container || !previewRenderer || !previewCamera) return;
  const width = container.clientWidth;
  const height = container.clientHeight;
  previewCamera.aspect = width / height;
  previewCamera.updateProjectionMatrix();
  previewRenderer.setSize(width, height);
}

function animatePreview() {
  previewAnimationId = requestAnimationFrame(animatePreview);

  if (previewMesh) {
    // Gentle breathing/floating animations
    previewMesh.position.y = 0.1 * Math.sin(Date.now() * 0.002);
    
    // Scale pulsation
    const scaleFactor = 1.0 + 0.015 * Math.sin(Date.now() * 0.001);
    previewMesh.scale.y = scaleFactor;

    // Swap wave and idle textures dynamically (identical to discover feed behavior)
    if (previewTexIdle && previewTexWave) {
      const now = Date.now();
      if (previewState === 'idle' && now - previewLastSwap > 4000) {
        previewState = 'wave';
        previewMesh.material.map = previewTexWave;
        previewMesh.material.needsUpdate = true;
        previewLastSwap = now;
      } else if (previewState === 'wave' && now - previewLastSwap > 1500) {
        previewState = 'idle';
        previewMesh.material.map = previewTexIdle;
        previewMesh.material.needsUpdate = true;
        previewLastSwap = now;
      }
    }
  }

  previewRenderer.render(previewScene, previewCamera);
}

function loadAndProcessTexture(url, callback) {
  const loader = new THREE.TextureLoader();
  loader.load(url, (texture) => {
    const img = texture.image;
    
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imgData.data;
    const w = canvas.width;
    const h = canvas.height;
    
    // Sample background colors dynamically from top, left, and right outer edges
    const bgColors = [];
    const samplePixel = (x, y) => {
      const idx = (y * w + x) * 4;
      const r = data[idx];
      const g = data[idx+1];
      const b = data[idx+2];
      
      const exists = bgColors.some(c => 
        Math.abs(c.r - r) < 10 && 
        Math.abs(c.g - g) < 10 && 
        Math.abs(c.b - b) < 10
      );
      if (!exists) {
        bgColors.push({ r, g, b });
      }
    };
    
    // Sample along top rows
    for (let x = 0; x < w; x += Math.max(1, Math.floor(w / 20))) {
      samplePixel(x, 0);
      samplePixel(x, 3);
      samplePixel(x, 6);
    }
    // Sample along upper side edges (top 15% height)
    for (let y = 0; y < Math.floor(h * 0.15); y += 4) {
      samplePixel(0, y);
      samplePixel(w - 1, y);
    }
    
    // Remove all pixels matching the sampled colors
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i+1];
      const b = data[i+2];
      
      const isBg = bgColors.some(c => 
        Math.abs(c.r - r) < 22 && 
        Math.abs(c.g - g) < 22 && 
        Math.abs(c.b - b) < 22
      );
      
      if (isBg) {
        data[i+3] = 0;
      }
    }
    ctx.putImageData(imgData, 0, 0);
    
    const cleanTexture = new THREE.CanvasTexture(canvas);
    cleanTexture.minFilter = THREE.LinearFilter;
    callback(cleanTexture);
  }, undefined, (err) => {
    console.error('Failed to load texture:', url, err);
  });
}

function update3DPreview(avatarCode, gender) {
  if (!previewScene) {
    init3DPreview();
  }

  if (previewMesh) {
    previewScene.remove(previewMesh);
    previewMesh.geometry.dispose();
    previewMesh.material.dispose();
    previewMesh = null;
  }

  previewTexIdle = null;
  previewTexWave = null;
  previewState = 'idle';
  previewLastSwap = Date.now();

  // Normalize path resolution depending on type mapping
  let idleUrl, waveUrl;
  if (avatarCode.startsWith('/') || avatarCode.startsWith('http')) {
    idleUrl = avatarCode;
    waveUrl = avatarCode;
  } else {
    idleUrl = `/avatars/${gender}/${avatarCode}/idle.jpeg`;
    waveUrl = `/avatars/${gender}/${avatarCode}/wave.jpeg`;
  }

  // Set card base width/height to look exactly like the discover cards
  const geometry = new THREE.PlaneGeometry(2.3, 4.4);
  const material = new THREE.MeshBasicMaterial({
    transparent: true,
    side: THREE.DoubleSide
  });

  previewMesh = new THREE.Mesh(geometry, material);
  previewMesh.position.set(0, 0, 0);
  previewScene.add(previewMesh);

  // Load and apply clean processed textures
  loadAndProcessTexture(idleUrl, (texIdle) => {
    previewTexIdle = texIdle;
    
    // Scale horizontally based on actual image aspect ratio to avoid stretching
    if (texIdle.image && texIdle.image.width && texIdle.image.height) {
      const aspect = texIdle.image.width / texIdle.image.height;
      const baseAspect = 2.3 / 4.4;
      previewMesh.scale.x = aspect / baseAspect;
    }

    if (previewState === 'idle') {
      material.map = texIdle;
      material.needsUpdate = true;
    }
    
    loadAndProcessTexture(waveUrl, (texWave) => {
      previewTexWave = texWave;
    });
  });
}
