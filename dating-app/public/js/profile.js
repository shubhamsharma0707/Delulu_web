document.addEventListener('DOMContentLoaded', async () => {
  await requireAuth();
  
  if (currentUser) {
    document.getElementById('prof-username').textContent = currentUser.username;
    document.getElementById('prof-bio').value = currentUser.bio || '';
    if (currentUser.hobbies) {
      document.getElementById('prof-hobbies').value = currentUser.hobbies.join(', ');
    }
    document.getElementById('prof-photo').value = currentUser.profile_pic || '';
    document.getElementById('prof-avatar').innerHTML = getAvatarHtml(currentUser.username, currentUser.profile_pic, true);
  }
  
  document.getElementById('profile-form').onsubmit = async (e) => {
    e.preventDefault();
    const bio = document.getElementById('prof-bio').value;
    const hobbiesStr = document.getElementById('prof-hobbies').value;
    const hobbies = hobbiesStr ? hobbiesStr.split(',').map(s=>s.trim()).filter(Boolean) : [];
    const profile_pic = document.getElementById('prof-photo').value;
    const msgEl = document.getElementById('prof-msg');
    
    try {
      await apiCall('/api/users/profile', 'PUT', { bio, hobbies, profile_pic });
      msgEl.textContent = 'Profile updated successfully!';
      msgEl.className = 'text-sm font-semibold text-primary';
      
      // Update local state and avatar
      currentUser.bio = bio;
      currentUser.hobbies = hobbies;
      currentUser.profile_pic = profile_pic;
      document.getElementById('prof-avatar').innerHTML = getAvatarHtml(currentUser.username, currentUser.profile_pic, true);
      updateHeaderAvatar();
      
      setTimeout(() => { msgEl.textContent = ''; }, 3000);
    } catch(err) {
      msgEl.textContent = err.message;
      msgEl.className = 'text-sm font-semibold text-error';
    }
  };
});
