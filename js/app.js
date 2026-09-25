// Wiring and startup: keyboard shortcut, offline banner, service worker, boot.
// Loaded last — boot calls into every other file.
//
// Classic script, not a module: see the note in index.html.

// ── Keyboard ───────────────────────────────────────────────────────────
document.getElementById('taskInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') addTask();
});

// ── Offline detection ─────────────────────────────────────────────────
function updateOnlineStatus() {
  document.getElementById('offlineBanner')
    .classList.toggle('visible', !navigator.onLine);
}
window.addEventListener('online',  updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);
updateOnlineStatus();

// ── Service Worker ────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js')
      .then(reg  => console.log('SW registered:', reg.scope))
      .catch(err => console.warn('SW registration failed:', err));
  });
}

// ── Boot ───────────────────────────────────────────────────────────────
load();
loadCategories();
loadSettings();
loadLastBackup();
render();
