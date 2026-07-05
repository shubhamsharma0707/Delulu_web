import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, sendSignInLinkToEmail, isSignInWithEmailLink, signInWithEmailLink } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyA3ZqXEQrLirVjRv338T4q_EXjPlGN_06s",
  authDomain: "delulu-final.firebaseapp.com",
  projectId: "delulu-final",
  storageBucket: "delulu-final.firebasestorage.app",
  messagingSenderId: "547753348022",
  appId: "1:547753348022:web:c5d0e6abd07bffecd08f17"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

document.addEventListener('DOMContentLoaded', async () => {
  // Check session; if logged in, redirect to /discover
  try {
    const data = await apiCall('/api/session');
    if (data.authenticated) {
      window.location.href = '/discover';
      return;
    }
  } catch (err) {}

  // State
  let currentEmail = window.localStorage.getItem('emailForSignIn') || '';
  const errEl = document.getElementById('email-error');

  // DOM refs
  const stageEmail = document.getElementById('stage-email');
  const stageOtp = document.getElementById('stage-otp');
  const stageProfile = document.getElementById('stage-profile');
  const inputEmail = document.getElementById('input-email');
  const otpEmailDisplay = document.getElementById('otp-email-display');
  const inputOtp = document.getElementById('input-otp');

  const stepDots = [1, 2, 3].map(i => document.getElementById(`step-dot-${i}`));
  const stepLines = [1, 2].map(i => document.getElementById(`step-line-${i}`));

  function showStage(stage) {
    [stageEmail, stageOtp, stageProfile].forEach(s => {
      s.classList.add('hidden');
      s.classList.remove('stage-enter');
    });
    // RequestAnimationFrame ensures the browser registers the hidden state
    // before we apply the animation class, so the fade-in plays properly
    requestAnimationFrame(() => {
      stage.classList.remove('hidden');
      requestAnimationFrame(() => {
        stage.classList.add('stage-enter');
      });
    });

    // Update progress dots
    const stageMap = { 0: stageEmail, 1: stageOtp, 2: stageProfile };
    const currentIdx = Object.values(stageMap).indexOf(stage);
    
    stepDots.forEach((dot, i) => {
      dot.classList.remove('active', 'completed');
      if (i < currentIdx) dot.classList.add('completed');
      else if (i === currentIdx) dot.classList.add('active');
    });
    stepLines.forEach((line, i) => {
      line.className = `h-px w-8 ${i < currentIdx ? 'bg-primary' : 'bg-outline-variant'}`;
    });
  }

  // ===== STAGE 1: Send OTP =====
  document.getElementById('form-email').onsubmit = async (e) => {
    e.preventDefault();
    const email = inputEmail.value.trim().toLowerCase();
    const domain = email.split('@')[1];

    // Client-side validation
    const allowedDomains = ['rishihood.edu.in', 'vitbhopal.ac.in', 'nst.rishihood.edu.in'];
    if (!domain || !allowedDomains.includes(domain)) {
      errEl.textContent = 'Only @rishihood.edu.in, @nst.rishihood.edu.in and @vitbhopal.ac.in email addresses are allowed';
      errEl.classList.remove('hidden');
      return;
    }
    errEl.classList.add('hidden');

    const btn = document.getElementById('btn-send-otp');
    btn.disabled = true;
    btn.textContent = 'Sending Magic Link...';

    try {
      // Use our backend to generate the link directly (bypasses Firebase sending quota)
      const res = await fetch('/api/auth/send-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });
      
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to generate link');

      window.localStorage.setItem('emailForSignIn', email);
      currentEmail = email;
      
      // Instantly log the user in using the developer bypass link!
      if (data.devLink) {
        window.location.href = data.devLink;
        return;
      }

      otpEmailDisplay.textContent = email;
      showStage(stageOtp);
    } catch (err) {
      console.error(err);
      errEl.textContent = 'Failed to send link. ' + err.message;
      errEl.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Send Magic Link';
    }
  };

  // ===== STAGE 2: Handle Magic Link Verification =====
  // Check if the user is returning from a magic link click
  if (isSignInWithEmailLink(auth, window.location.href)) {
    let email = window.localStorage.getItem('emailForSignIn');
    if (!email) {
      // If opened on a different device, prompt for email
      email = window.prompt('Please provide your email for confirmation');
    }

    if (email) {
      try {
        // Sign in with Firebase
        const result = await signInWithEmailLink(auth, email, window.location.href);
        window.localStorage.removeItem('emailForSignIn');

        // Get the secure ID token to send to our backend
        const idToken = await result.user.getIdToken();

        // Establish the session on our backend
        const rememberMe = document.getElementById('remember-me')?.checked || true;
        const data = await apiCall('/api/auth/verify-firebase-token', 'POST', { 
          idToken,
          rememberMe
        });

        if (data.isNewUser) {
          showStage(stageProfile);
          document.getElementById('profile-username').focus();
        } else {
          window.location.href = '/discover';
        }
      } catch (error) {
        console.error("Error signing in with email link", error);
        errEl.textContent = 'Link is invalid or has expired.';
        errEl.classList.remove('hidden');
      }
    }
  }

  // Back to email
  document.getElementById('btn-back-email').onclick = () => {
    showStage(stageEmail);
    inputEmail.focus();
  };

  // ===== STAGE 3: Complete Profile (new users) =====
  const profileGender = document.getElementById('profile-gender');
  const avatarPickerContainer = document.getElementById('avatar-picker-container');
  const avatarGrid = document.getElementById('avatar-grid');
  const profileAvatarInput = document.getElementById('profile-avatar');

  profileGender.onchange = () => {
    const gender = profileGender.value;
    avatarGrid.innerHTML = '';
    profileAvatarInput.value = '';
    
    if (!gender) {
      avatarPickerContainer.classList.add('hidden');
      return;
    }
    
    avatarPickerContainer.classList.remove('hidden');
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
      wrapper.innerHTML = `<img src="/avatars/${av}.jpeg" class="w-full h-full object-cover">`;
      wrapper.onclick = () => {
        avatarGrid.querySelectorAll('.aspect-square').forEach(el => el.classList.remove('border-primary', 'border-2', 'ring-2', 'ring-primary/20'));
        wrapper.classList.add('border-primary', 'border-2', 'ring-2', 'ring-primary/20');
        profileAvatarInput.value = av;
      };
      avatarGrid.appendChild(wrapper);
    });
  };

  document.getElementById('form-profile').onsubmit = async (e) => {
    e.preventDefault();

    const username = document.getElementById('profile-username').value.trim();
    const gender = profileGender.value;
    const bio = document.getElementById('profile-bio').value.trim();
    const hobbiesStr = document.getElementById('profile-hobbies').value;
    const avatar = profileAvatarInput.value;

    if (!avatar) {
      document.getElementById('profile-error').textContent = 'Please select an avatar';
      document.getElementById('profile-error').classList.remove('hidden');
      return;
    }

    let hobbies = [];
    if (hobbiesStr) {
      hobbies = hobbiesStr.split(',').map(s => s.trim()).filter(Boolean);
    }

    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = 'Creating...';
    document.getElementById('profile-error').classList.add('hidden');

    try {
      await apiCall('/api/auth/complete-profile', 'POST', {
        email: currentEmail,
        username,
        gender,
        bio,
        hobbies,
        avatar
      });
      window.location.href = '/discover';
    } catch (err) {
      document.getElementById('profile-error').textContent = err.message;
      document.getElementById('profile-error').classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Create Profile';
    }
  };
});
