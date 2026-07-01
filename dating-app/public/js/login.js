document.addEventListener('DOMContentLoaded', async () => {
  // Check session; if logged in, redirect to /discover
  try {
    const data = await apiCall('/api/session');
    if (data.authenticated) {
      window.location.href = '/discover';
      return;
    }
  } catch (err) {}

  let authMode = 'login';
  
  const loginTab = document.getElementById('tab-login');
  const signupTab = document.getElementById('tab-signup');
  const signupFields = document.getElementById('signup-fields');
  const errEl = document.getElementById('auth-error');

  function toggleAuthMode(mode) {
    authMode = mode;
    errEl.classList.add('hidden');
    
    if (mode === 'login') {
      loginTab.classList.add('text-primary', 'border-b-2', 'border-primary');
      loginTab.classList.remove('text-on-surface-variant');
      signupTab.classList.add('text-on-surface-variant');
      signupTab.classList.remove('text-primary', 'border-b-2', 'border-primary');
      signupFields.classList.add('hidden');
      signupFields.classList.remove('flex');
      document.getElementById('auth-gender').removeAttribute('required');
    } else {
      signupTab.classList.add('text-primary', 'border-b-2', 'border-primary');
      signupTab.classList.remove('text-on-surface-variant');
      loginTab.classList.add('text-on-surface-variant');
      loginTab.classList.remove('text-primary', 'border-b-2', 'border-primary');
      signupFields.classList.remove('hidden');
      signupFields.classList.add('flex');
      document.getElementById('auth-gender').setAttribute('required', 'true');
    }
  }

  loginTab.onclick = () => toggleAuthMode('login');
  signupTab.onclick = () => toggleAuthMode('signup');

  document.getElementById('auth-form').onsubmit = async (e) => {
    e.preventDefault();
    const username = document.getElementById('auth-username').value.trim();
    const passcode = document.getElementById('auth-passcode').value.trim();
    
    try {
      if (authMode === 'login') {
        await apiCall('/api/users/login', 'POST', { username, passcode });
      } else {
        const gender = document.getElementById('auth-gender').value;
        const bio = document.getElementById('auth-bio').value;
        let hobbies = [];
        const hobbiesStr = document.getElementById('auth-hobbies').value;
        if (hobbiesStr) {
          hobbies = hobbiesStr.split(',').map(s=>s.trim()).filter(Boolean);
        }
        const profile_pic = document.getElementById('auth-photo').value;
        await apiCall('/api/users/create', 'POST', { username, passcode, gender, bio, hobbies, profile_pic });
      }
      window.location.href = '/discover';
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    }
  };
});
