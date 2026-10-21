// Path: plugins/chrome/dashboard-bridge.js
// Same-origin dashboard <-> Chrome extension message bridge. Never accepts
// requests from another frame or forwards arbitrary URL / HTTP requests.
(() => {
  const requestTypes = new Set(['list-sessions', 'open-provider', 'deliver-session', 'symbol-settings', 'set-symbol-compression', 'commit-symbol-registry']);
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const msg = event.data;
    if (!msg || msg.channel !== 'prompt-helper-dashboard' || typeof msg.id !== 'string' ||
        msg.id.length > 80 || !requestTypes.has(msg.type)) return;
    chrome.runtime.sendMessage({ type: msg.type, payload: msg.payload || {} }, response => {
      const failure = chrome.runtime.lastError?.message;
      window.postMessage({ channel: 'prompt-helper-extension', id: msg.id,
        ok: !failure && !!response?.ok, result: response?.result || null,
        error: failure || response?.error || null }, location.origin);
    });
  });
  window.postMessage({ channel: 'prompt-helper-extension-ready' }, location.origin);
})();
