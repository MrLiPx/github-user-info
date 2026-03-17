/**
 * GitHub User Lookup — app.js
 */

'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────

const API_BASE   = 'https://api.github.com';
const API_HDRS   = { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
const TIMEOUT    = 9_000;
const CACHE_TTL  = 5 * 60 * 1000; // 5 min

// Language → colour mapping
const LANG_COLORS = {
  JavaScript:'#f1e05a', TypeScript:'#3178c6', Python:'#3572a5',
  HTML:'#e34c26', CSS:'#563d7c', Rust:'#dea584', Go:'#00add8',
  Java:'#b07219', 'C++':'#f34b7d', C:'#555555', Ruby:'#701516',
  PHP:'#4f5d95', Shell:'#89e051', Swift:'#f05138', Kotlin:'#a97bff',
  Dart:'#00b4ab', Vue:'#41b883', Svelte:'#ff3e00', Dockerfile:'#384d54',
};

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const UI = {
  input:       () => document.getElementById('usernameInput'),
  searchBtn:   () => document.getElementById('searchBtn'),
  landing:     () => document.getElementById('landingUI'),
  loading:     () => document.getElementById('loadingUI'),
  content:     () => document.getElementById('profileContent'),
  errors:      () => document.getElementById('errorContainer'),
  reposView:   () => document.getElementById('reposView'),
  starsView:   () => document.getElementById('starsView'),
  starsGrid:   () => document.getElementById('starsGrid'),
  starsLoad:   () => document.getElementById('starsLoading'),
};

// ─── State ────────────────────────────────────────────────────────────────────

let currentUser  = '';
let starsLoaded  = false;

// ─── Utils ────────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function fmt(n) {
  if (n === null || n === undefined) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/,'') + 'M';
  if (n >= 1_000)     return (n / 1_000)    .toFixed(1).replace(/\.0$/,'') + 'k';
  return n.toLocaleString();
}

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { year:'numeric', month:'long' });
}

// ─── Fetch with timeout + cache ───────────────────────────────────────────────

async function apiFetch(url) {
  // Check sessionStorage cache
  const cacheKey = `gul_${url}`;
  try {
    const cached = sessionStorage.getItem(cacheKey);
    if (cached) {
      const { ts, data } = JSON.parse(cached);
      if (Date.now() - ts < CACHE_TTL) return data;
    }
  } catch {}

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);

  try {
    const res = await fetch(url, { headers: API_HDRS, signal: ctrl.signal });
    clearTimeout(timer);

    if (res.status === 403) {
      const remaining = res.headers.get('X-RateLimit-Remaining');
      if (remaining === '0') {
        const reset = res.headers.get('X-RateLimit-Reset');
        const mins  = reset ? Math.ceil((+reset * 1000 - Date.now()) / 60000) : null;
        throw Object.assign(new Error('rate_limit'), { rateMins: mins });
      }
    }

    if (!res.ok) {
      throw Object.assign(new Error('http_error'), { status: res.status });
    }

    const data = await res.json();
    try { sessionStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), data })); } catch {}
    return data;

  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw Object.assign(new Error('timeout'), {});
    throw err;
  }
}

// ─── UI state machine ─────────────────────────────────────────────────────────

function setState(mode) {
  UI.landing().classList.toggle ('hidden', mode !== 'landing');
  UI.loading().classList.toggle ('hidden', mode !== 'loading');
  UI.content().classList.toggle ('hidden', mode !== 'content');
  UI.errors() .classList.toggle ('hidden', mode !== 'error');
}

// ─── Error display ────────────────────────────────────────────────────────────

function showError(err) {
  setState('error');
  let icon  = 'fi-rr-exclamation';
  let title = 'Something went wrong';
  let msg   = 'An unexpected error occurred. Please try again.';

  if (err.status === 404) {
    icon  = 'fi-rr-search';
    title = 'User not found';
    msg   = `No GitHub account matches <strong>${esc(UI.input().value.trim())}</strong>. Check the spelling and try again.`;
  } else if (err.message === 'rate_limit') {
    icon  = 'fi-rr-hourglass-end';
    title = 'Rate limit reached';
    msg   = err.rateMins
      ? `GitHub API rate limit exceeded. Resets in ~${err.rateMins} min.`
      : 'GitHub API rate limit exceeded. Please wait a few minutes and try again.';
  } else if (err.message === 'timeout') {
    icon  = 'fi-rr-wifi-slash';
    title = 'Request timed out';
    msg   = 'GitHub took too long to respond. Check your connection and try again.';
  }

  UI.errors().innerHTML = `
    <div class="error-card">
      <div class="error-icon"><i class="fi ${icon}" aria-hidden="true"></i></div>
      <div>
        <p class="error-title">${title}</p>
        <p class="error-msg">${msg}</p>
      </div>
    </div>`;
}

// ─── Search flow ──────────────────────────────────────────────────────────────

function handleSearch() {
  const query = UI.input().value.trim();
  if (!query) { UI.input().focus(); return; }
  const url = new URL(window.location.href);
  url.searchParams.set('usn', query);
  url.hash = 'repos';
  history.pushState({}, '', url.pathname + url.search + url.hash);
  loadProfile(query);
}

function resetToLanding() {
  history.pushState({}, '', window.location.pathname);
  UI.input().value = '';
  currentUser  = '';
  starsLoaded  = false;
  document.title = 'GitHub User Lookup — Developer Profile Explorer';
  setState('landing');
}

async function loadProfile(username) {
  if (!username) return;
  setState('loading');
  starsLoaded = false;

  try {
    const [user, repos] = await Promise.all([
      apiFetch(`${API_BASE}/users/${username}`),
      apiFetch(`${API_BASE}/users/${username}/repos?sort=updated&per_page=100`),
    ]);
    currentUser = user.login;
    renderProfile(user, repos);
    setState('content');
    handleHashChange();

    // Update title and OG dynamically
    document.title = `${user.name || user.login} (@${user.login}) — GitHub User Lookup`;
  } catch (err) {
    showError(err);
  }
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function renderProfile(user, repos) {
  // Avatar
  const avatarEl = document.getElementById('avatar');
  avatarEl.src = user.avatar_url;
  avatarEl.alt = `${esc(user.login)} GitHub avatar`;

  // Name & handle
  document.getElementById('fullName').textContent = user.name || user.login;
  document.getElementById('loginId').textContent  = user.login;
  const loginLink = document.getElementById('loginLink');
  loginLink.href = user.html_url;
  loginLink.setAttribute('aria-label', `@${user.login} on GitHub`);

  // Hireable
  document.getElementById('hireableStatus').classList.toggle('hidden', !user.hireable);

  // Bio
  document.getElementById('bioText').textContent = user.bio || '';

  // Stats
  document.getElementById('statFollowers').textContent = fmt(user.followers);
  document.getElementById('statFollowing').textContent = fmt(user.following);
  document.getElementById('statRepos')    .textContent = fmt(user.public_repos);
  document.getElementById('statGists')    .textContent = fmt(user.public_gists);

  // Meta
  document.getElementById('valJoined').textContent = `Joined ${fmtDate(user.created_at)}`;
  setMeta('valLocation', user.location,  'locBox');
  setMeta('valCompany',  user.company,   'compBox');
  setMetaLink('valBlog', user.blog, 'linkBox');

  // Achievements
  renderBadges(user);

  // Repos
  const sorted = [...repos]
    .filter(r => !r.fork)
    .sort((a, b) => b.stargazers_count - a.stargazers_count);
  renderCards('reposView', sorted.length ? sorted : repos);
}

function setMeta(elId, value, boxId) {
  const box = document.getElementById(boxId);
  if (value) {
    document.getElementById(elId).textContent = value;
    box.classList.remove('hidden');
  } else {
    box.classList.add('hidden');
  }
}

function setMetaLink(elId, value, boxId) {
  const box = document.getElementById(boxId);
  const el  = document.getElementById(elId);
  if (value) {
    const href    = value.startsWith('http') ? value : `https://${value}`;
    el.href       = href;
    el.textContent = value.replace(/^https?:\/\//, '').replace(/\/$/, '');
    box.classList.remove('hidden');
  } else {
    box.classList.add('hidden');
  }
}

function renderBadges(user) {
  const box = document.getElementById('achievementsList');
  const badges = [];

  if (user.site_admin)                         badges.push(['fi-rr-shield-check', 'GitHub Staff',     'badge-blue']);
  if (user.followers  >= 1000)                 badges.push(['fi-rr-star',         'Influencer',        'badge-amber']);
  if (user.followers  >= 100)                  badges.push(['fi-rr-flame',        'Rising Star',       'badge-amber']);
  if (user.public_repos >= 50)                 badges.push(['fi-rr-layers',       'Prolific Dev',      'badge-green']);
  if (user.hireable)                           badges.push(['fi-rr-bolt',         'Open to Work',      'badge-green']);
  if (user.public_gists >= 20)                 badges.push(['fi-rr-code-branch',  'Gist Hoarder',      'badge-purple']);

  box.innerHTML = badges.map(([icon, label, cls]) =>
    `<span class="badge ${cls}" role="listitem">
       <i class="fi ${icon}" aria-hidden="true"></i>${esc(label)}
     </span>`
  ).join('');
}

function repoCard(item) {
  const lang  = item.language || '';
  const color = LANG_COLORS[lang] || '#484f58';
  const desc  = item.description || 'No description provided.';

  return `
    <a class="repo-card" href="${esc(item.html_url)}" target="_blank" rel="noopener noreferrer"
       aria-label="${esc(item.name)} on GitHub">
      <div class="repo-card-top">
        <span class="repo-name">${esc(item.name)}</span>
        ${item.fork ? `<span class="repo-lang-tag">fork</span>` : ''}
      </div>
      <p class="repo-desc">${esc(desc)}</p>
      <div class="repo-footer">
        <span class="repo-stat" aria-label="${item.stargazers_count} stars">
          <i class="fi fi-rr-star" aria-hidden="true" style="color:${esc(LANG_COLORS.JavaScript)}"></i>
          ${esc(fmt(item.stargazers_count))}
        </span>
        <span class="repo-stat" aria-label="${item.forks_count} forks">
          <i class="fi fi-rr-code-fork" aria-hidden="true" style="color:#4d9ef7"></i>
          ${esc(fmt(item.forks_count))}
        </span>
        ${lang ? `<span class="repo-lang-dot">
          <span class="lang-dot" style="background:${esc(color)}" aria-hidden="true"></span>
          ${esc(lang)}
        </span>` : ''}
        <i class="fi fi-rr-arrow-right repo-arrow" aria-hidden="true"></i>
      </div>
    </a>`;
}

function renderCards(containerId, items) {
  const el = document.getElementById(containerId);
  if (!items?.length) {
    el.innerHTML = `
      <div class="panel-empty">
        <i class="fi fi-rr-layers" aria-hidden="true"></i>
        <p>No repositories found.</p>
      </div>`;
    return;
  }
  const grid = document.createElement('div');
  grid.className = 'repo-grid';
  grid.innerHTML = items.map(repoCard).join('');
  el.innerHTML = '';
  el.appendChild(grid);
}

// ─── Stars ────────────────────────────────────────────────────────────────────

async function loadStars(username) {
  if (starsLoaded) return;
  UI.starsGrid().innerHTML = '';
  UI.starsLoad().classList.remove('hidden');

  try {
    const stars = await apiFetch(`${API_BASE}/users/${username}/starred?per_page=30`);
    starsLoaded = true;
    renderCards('starsGrid', stars);
  } catch (err) {
    UI.starsGrid().innerHTML = `
      <div class="panel-empty">
        <i class="fi fi-rr-exclamation" aria-hidden="true"></i>
        <p>Could not load starred repositories.</p>
      </div>`;
  } finally {
    UI.starsLoad().classList.add('hidden');
  }
}

// ─── Tab routing ──────────────────────────────────────────────────────────────

function handleHashChange() {
  const hash = (window.location.hash || '#repos').slice(1);

  UI.reposView().classList.toggle('hidden', hash !== 'repos');
  UI.starsView().classList.toggle('hidden', hash !== 'stars');

  document.querySelectorAll('.tab').forEach(t => {
    const active = t.id === `tab-${hash}`;
    t.classList.toggle('active', active);
    t.setAttribute('aria-selected', String(active));
  });

  if (hash === 'stars' && currentUser) loadStars(currentUser);
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(window.location.search);
  const user   = params.get('usn') || params.get('username');

  if (user) {
    UI.input().value = user;
    loadProfile(user);
  } else {
    setState('landing');
  }

  handleHashChange();

  // Keyboard shortcut: Cmd/Ctrl+K → focus search
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      UI.input().focus();
      UI.input().select();
    }
    if (e.key === 'Escape' && document.activeElement === UI.input()) {
      UI.input().blur();
    }
  });

  // Search triggers
  UI.input().addEventListener('keydown', e => { if (e.key === 'Enter') handleSearch(); });
  UI.searchBtn().addEventListener('click', handleSearch);

  // Example chips
  document.querySelectorAll('.example-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      UI.input().value = chip.dataset.user;
      handleSearch();
    });
  });
});

window.addEventListener('hashchange', handleHashChange);
window.addEventListener('popstate', () => {
  const params = new URLSearchParams(window.location.search);
  const user   = params.get('usn');
  if (user) {
    UI.input().value = user;
    loadProfile(user);
  } else {
    setState('landing');
  }
});
