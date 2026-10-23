// Path: plugins/chrome/session-media-upload.js
// The extension cannot choose a native file dialog's directory with web APIs.
// On an explicit upload/plus click, ask the user-installed native host to
// navigate an *existing* macOS Chrome Open panel (requires Accessibility).
(() => {
  if (globalThis.__promptHelperMediaUploadActive) return;
  globalThis.__promptHelperMediaUploadActive = true;
  let enabled = false;
  chrome.storage.local.get({aggregateSessionMedia:false}, v => { enabled = v.aggregateSessionMedia === true; });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.aggregateSessionMedia) enabled = changes.aggregateSessionMedia.newValue === true;
  });
  let lastAttempt = 0;
  const isUploadControl = target => {
    const el = target?.closest?.('button,[role="button"],[role="menuitem"],label,input[type="file"]');
    if (!el) return false;
    const label = [el.getAttribute('aria-label'), el.getAttribute('data-testid'),
      el.getAttribute('title'), el.innerText].filter(Boolean).join(' ').slice(0,300).toLowerCase();
    return /upload|attach|add files|add photos|add attachment|composer-plus|composer-attachment|add files and more/.test(label);
  };
  document.addEventListener('click', event => {
    if (!enabled || !isUploadControl(event.target)) return;
    if (!/^\/(c|chat)\/[A-Za-z0-9_-]+(?:\/|$)/.test(location.pathname)) return;
    const now = Date.now();
    if (now - lastAttempt < 1300) return;
    lastAttempt = now;
    chrome.runtime.sendMessage({type:'session-media-upload-dialog'}, () => {
      // Finder chooser remains usable if the native host lacks Accessibility.
      void chrome.runtime.lastError;
    });
  }, true);
})();
