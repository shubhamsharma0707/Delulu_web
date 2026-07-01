let discoverProfiles = [];
let currentDiscoverIndex = 0;

document.addEventListener('DOMContentLoaded', async () => {
  await requireAuth();
  loadDiscovery();
  
  document.getElementById('btn-like').onclick = async () => {
    const p = discoverProfiles[currentDiscoverIndex];
    if (!p) return;
    try {
      await apiCall('/api/connections/request', 'POST', { to_user_id: p.id });
      nextProfile();
    } catch(err) { alert(err.message); }
  };
  document.getElementById('btn-pass').onclick = nextProfile;
});

async function loadDiscovery() {
  try {
    const data = await apiCall('/api/discover');
    discoverProfiles = data.profiles;
    currentDiscoverIndex = 0;
    renderDiscovery();
  } catch (err) { console.error(err); }
}

function renderDiscovery() {
  const stack = document.getElementById('discovery-stack');
  const empty = document.getElementById('discovery-empty');
  const actions = document.getElementById('discovery-actions');
  
  const p = discoverProfiles[currentDiscoverIndex];
  if (!p) {
    stack.innerHTML = '';
    empty.classList.remove('hidden');
    empty.classList.add('flex');
    actions.classList.add('hidden');
    actions.classList.remove('flex');
    return;
  }
  
  empty.classList.add('hidden');
  empty.classList.remove('flex');
  actions.classList.remove('hidden');
  actions.classList.add('flex');
  
  let matchHtml = '';
  if (p.matching_hobbies && p.matching_hobbies.length > 0) {
    matchHtml = p.matching_hobbies.map(h => `<span class="px-3 py-1 bg-white/20 backdrop-blur-md rounded-full font-label-sm text-sm border border-white/40">${h}</span>`).join('');
  } else {
    matchHtml = `<span class="px-3 py-1 bg-white/20 backdrop-blur-md rounded-full font-label-sm text-sm border border-white/40">No shared hobbies yet</span>`;
  }
  
  stack.innerHTML = `
    <div class="absolute inset-0 bg-surface rounded-xl shadow-[0_8px_32px_rgba(165,59,41,0.1)] overflow-hidden flex flex-col z-10 slide-up">
      <div class="w-full h-full absolute inset-0">
        ${getAvatarHtml(p.username, p.profile_pic, false)} 
      </div>
      <div class="absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-black/80 via-black/30 to-transparent"></div>
      <div class="absolute bottom-0 left-0 w-full p-6 text-white flex flex-col justify-end z-20">
        <h1 class="font-bold text-3xl mb-1 capitalize">${p.username}</h1>
        <p class="text-sm opacity-90 mb-3">${p.bio || 'Mystery person...'}</p>
        <div class="flex flex-wrap gap-2 mb-2">
          ${matchHtml}
        </div>
      </div>
    </div>
  `;
}

function nextProfile() {
  currentDiscoverIndex++;
  renderDiscovery();
}
