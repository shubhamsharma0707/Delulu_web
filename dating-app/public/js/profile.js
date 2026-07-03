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
      };
      avatarGrid.appendChild(wrapper);
    });

    document.getElementById('prof-avatar').innerHTML = getAvatarHtml(currentUser.username, currentUser.avatar);
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
