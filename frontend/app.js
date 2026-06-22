// app.js — typeahead frontend logic.
//
// Three decisions worth noting:
//   1. Debounce: wait until the user pauses typing before calling the backend,
//      so "iphone" is 1 request, not 6.
//   2. MIN_CHARS = 2: don't query on a single character (huge, low-value result
//      set and the most expensive query to sort server-side).
//   3. Race guard: a fast typist can have several requests in flight; a slow
//      earlier one must not overwrite a newer result. AbortController cancels the
//      previous request, and a monotonic request id ignores any stale response
//      that still slips through.

const DEBOUNCE_MS = 200;
const MIN_CHARS = 2;

const $input = document.getElementById('search-input');
const $box = document.querySelector('.search-box');
const $list = document.getElementById('suggestions');
const $status = document.getElementById('status');
const $spinner = document.getElementById('spinner');
const $clear = document.getElementById('clear-btn');
const $banner = document.getElementById('search-response');
const $trendingList = document.getElementById('trending-list');
const $trendingEmpty = document.getElementById('trending-empty');

let suggestions = [];     // current suggestion objects {query, count}
let activeIndex = -1;     // highlighted item for keyboard nav (-1 = none)
let latestRequestId = 0;  // race guard: only the newest response may render
let inFlight = null;      // AbortController of the current /suggest request

// --- debounce: returns a wrapped fn that only runs after `wait` ms of quiet --
function debounce(fn, wait) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

// --- core: fetch suggestions for the current input value --------------------
async function fetchSuggestions(prefix) {
  // cancel any request still in flight — its result is now irrelevant
  if (inFlight) inFlight.abort();
  const controller = new AbortController();
  inFlight = controller;
  const requestId = ++latestRequestId;

  showSpinner(true);
  setStatus('');
  try {
    const res = await fetch(`/suggest?q=${encodeURIComponent(prefix)}`, {
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // RACE GUARD: if a newer request started while we awaited, drop this one.
    if (requestId !== latestRequestId) return;

    renderSuggestions(data.suggestions || [], prefix);
  } catch (err) {
    if (err.name === 'AbortError') return; // expected when we cancel — ignore
    if (requestId !== latestRequestId) return;
    showError();
  } finally {
    if (requestId === latestRequestId) showSpinner(false);
  }
}

// --- rendering --------------------------------------------------------------
function renderSuggestions(items, prefix) {
  suggestions = items;
  activeIndex = -1;
  $list.innerHTML = '';

  if (items.length === 0) {
    closeList();
    setStatus(`No suggestions for “${prefix}”.`);
    return;
  }

  for (let i = 0; i < items.length; i++) {
    const { query, count } = items[i];
    const li = document.createElement('li');
    li.className = 'suggestion';
    li.id = `suggestion-${i}`;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', 'false');

    // Visually separate the typed prefix (bold) from the rest (muted).
    const rest = query.slice(prefix.length);
    li.innerHTML = `
      <span class="suggestion-text">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.3-4.3"></path>
        </svg>
        <span class="suggestion-label">${escapeHtml(query.slice(0, prefix.length))}<span class="match">${escapeHtml(rest)}</span></span>
      </span>
      <span class="suggestion-count">${formatCount(count)}</span>`;

    li.addEventListener('mousedown', (e) => {
      e.preventDefault();         // keep focus in the input
      submitSearch(query);
    });
    li.addEventListener('mouseenter', () => setActive(i));
    $list.appendChild(li);
  }

  openList();
  setStatus('');
}

function setActive(i) {
  const children = $list.children;
  if (activeIndex >= 0 && children[activeIndex]) {
    children[activeIndex].classList.remove('active');
    children[activeIndex].setAttribute('aria-selected', 'false');
  }
  activeIndex = i;
  if (i >= 0 && children[i]) {
    children[i].classList.add('active');
    children[i].setAttribute('aria-selected', 'true');
    children[i].scrollIntoView({ block: 'nearest' });
    $input.setAttribute('aria-activedescendant', `suggestion-${i}`);
  } else {
    $input.removeAttribute('aria-activedescendant');
  }
}

// --- search submission (POST /search; counts are batched server-side) -------
async function submitSearch(query) {
  const q = (query ?? $input.value).trim();
  if (!q) return;
  $input.value = q;
  closeList();

  try {
    const res = await fetch('/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    showBanner(data.message || 'Searched', q);
    loadTrending(); // a new search may change trending
  } catch (err) {
    // network/server error — show a friendly, accurate message
    showBanner('Could not reach the server — please try again', q, true);
  }
}

// --- trending (degrades gracefully if unavailable) --------------------------
async function loadTrending() {
  try {
    const res = await fetch('/trending');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const items = data.trending || [];
    if (items.length === 0) throw new Error('empty');

    $trendingEmpty.hidden = true;
    $trendingList.innerHTML = '';
    for (const item of items) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="t-label">${escapeHtml(item.query)}</span>`;
      li.addEventListener('click', () => {
        $input.value = item.query;
        submitSearch(item.query);
      });
      $trendingList.appendChild(li);
    }
  } catch {
    $trendingList.innerHTML = '';
    $trendingEmpty.hidden = false; // keep the placeholder message
  }
}

// --- small UI helpers -------------------------------------------------------
function openList() {
  $list.hidden = false;
  $box.setAttribute('aria-expanded', 'true');
}
function closeList() {
  $list.hidden = true;
  $box.setAttribute('aria-expanded', 'false');
  activeIndex = -1;
  $input.removeAttribute('aria-activedescendant');
}
function showSpinner(on) { $spinner.hidden = !on; }
function setStatus(msg, isError = false) {
  $status.textContent = msg;
  $status.classList.toggle('error', isError);
}
function showError() {
  closeList();
  $status.innerHTML =
    'Something went wrong. <button class="retry" id="retry-btn">Retry</button>';
  $status.classList.add('error');
  document.getElementById('retry-btn')?.addEventListener('click', onInput);
}
function showBanner(message, query, muted = false) {
  $banner.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5"></path>
    </svg>
    <span><b>${escapeHtml(message)}</b> — “${escapeHtml(query)}”</span>`;
  $banner.style.opacity = muted ? '0.7' : '1';
  $banner.hidden = false;
}
function formatCount(n) { return Number(n).toLocaleString(); }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// --- input handling (debounced) ---------------------------------------------
function onInput() {
  const value = $input.value.trim();
  $clear.hidden = value.length === 0;

  if (value.length < MIN_CHARS) {
    // below the trigger threshold: cancel anything pending, clear the dropdown
    if (inFlight) inFlight.abort();
    latestRequestId++; // invalidate any in-flight response
    closeList();
    setStatus(value.length === 1 ? 'Keep typing…' : '');
    showSpinner(false);
    return;
  }
  fetchSuggestions(value);
}
const debouncedInput = debounce(onInput, DEBOUNCE_MS);

// --- keyboard navigation ----------------------------------------------------
$input.addEventListener('keydown', (e) => {
  const open = !$list.hidden && suggestions.length > 0;
  switch (e.key) {
    case 'ArrowDown':
      if (open) { e.preventDefault(); setActive((activeIndex + 1) % suggestions.length); }
      break;
    case 'ArrowUp':
      if (open) {
        e.preventDefault();
        setActive((activeIndex - 1 + suggestions.length) % suggestions.length);
      }
      break;
    case 'Enter':
      // pick the highlighted suggestion if any, else submit the typed text
      if (open && activeIndex >= 0) submitSearch(suggestions[activeIndex].query);
      else submitSearch();
      break;
    case 'Escape':
      closeList();
      break;
  }
});

$input.addEventListener('input', () => { $banner.hidden = true; debouncedInput(); });
$input.addEventListener('focus', () => { if (suggestions.length) openList(); });
// close the dropdown when focus leaves the search area
document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-wrap')) closeList();
});
$clear.addEventListener('click', () => {
  $input.value = '';
  $clear.hidden = true;
  closeList();
  setStatus('');
  $input.focus();
});

// the magnifier doubles as a submit button (Enter and clicking a suggestion also submit)
document.getElementById('search-btn').addEventListener('click', () => submitSearch());

// pointer-reactive specular sheen on the glass search box (purely visual — feeds
// the cursor position to a CSS radial highlight; no effect on search behavior).
$box.addEventListener('pointermove', (e) => {
  const r = $box.getBoundingClientRect();
  $box.style.setProperty('--mx', `${e.clientX - r.left}px`);
  $box.style.setProperty('--my', `${e.clientY - r.top}px`);
});

// initial trending load
loadTrending();
