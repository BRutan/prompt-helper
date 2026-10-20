// Path: plugins/chrome/background.js
import { sessionFromUrl, looksLikeSource, localBaseUrl } from './session.js';

const DEFAULTS = { endpoint: 'http://127.0.0.1:5173', minChars: 1000, replaceOnPaste: true };
const API_PATH = '/api/v1/chat-sessions/diff';
const inFlight = new Map();
const recent = new Map();

async function settings() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
}

async function activeSender(sender) {
  const tab = sender.tab;
  if (!tab || !tab.active || !sessionFromUrl(tab.url || sender.url || '')) return null;
  const win = await chrome.windows.get(tab.windowId);
  if (!win.focused) return null;
  const [active] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  return active?.id === tab.id ? sessionFromUrl(tab.url) : null;
}

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function api(path, options = {}) {
  const base = localBaseUrl((await settings()).endpoint);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 125000);
  try {
    const response = await fetch(base + path, { ...options, signal: controller.signal, cache: 'no-store' });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw Error(body?.error || `prompt-helper returned HTTP ${response.status}`);
    return body;
  } finally { clearTimeout(timeout); }
}

function badge(tabId, text, color) {
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
}

async function processPaste(message, sender) {
  const session = await activeSender(sender);
  if (!session) throw Error('ChatGPT or Claude must be in the active, focused Chrome tab and have a saved conversation URL.');
  const config = await settings();
  if (!looksLikeSource(message.content, Number(config.minChars) || DEFAULTS.minChars)) throw Error('Not a recognized long source dump.');
  const tabId = sender.tab.id;
  const key = `${session.provider}:${session.conversation_id}`;
  const digest = await sha256(message.content);
  const fingerprint = `${key}:${digest}`;
  if (inFlight.has(fingerprint)) return inFlight.get(fingerprint);
  if (recent.get(key)?.digest === digest) return recent.get(key).result;
  badge(tabId, '…', '#6575a5');
  const operation = (async () => {
    try {
      const response = await api(API_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...session, content: message.content })
      });
      const text = response.changed > 0 ? response.llm_diff : 'No source-file changes in this conversation session.';
      const result = {
        status: response.status, changed: response.changed, total: response.total,
        additions: response.additions, deletions: response.deletions,
        replacement_text: text, session_diff: response.session_diff?.llm_diff || '', session
      };
      recent.set(key, { digest, result });
      await chrome.storage.session.set({ [`tab:${tabId}`]: { ...result, updated_at: Date.now() } });
      badge(tabId, response.changed ? String(response.changed) : '0', '#347b64');
      return result;
    } catch (error) {
      badge(tabId, '!', '#bc4552');
      throw error;
    } finally { inFlight.delete(fingerprint); }
  })();
  inFlight.set(fingerprint, operation);
  return operation;
}

async function getStatus(sender) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const session = sessionFromUrl(tab?.url || '');
  const state = tab ? (await chrome.storage.session.get(`tab:${tab.id}`))[`tab:${tab.id}`] : null;
  return { session, state: state?.session?.conversation_id === session?.conversation_id ? state : null,
           config: await settings(), tab_id: tab?.id };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case 'process-source': return processPaste(message, sender);
      case 'get-status': return getStatus(sender);
      case 'set-options': {
        const endpoint = localBaseUrl(message.endpoint);
        const minChars = Number(message.minChars);
        if (!Number.isInteger(minChars) || minChars < 100 || minChars > 1000000) throw Error('minChars must be 100..1000000');
        const options = { endpoint, minChars, replaceOnPaste: Boolean(message.replaceOnPaste) };
        await chrome.storage.local.set(options);
        return options;
      }
      case 'load-session': {
        const { session } = await getStatus(sender);
        if (!session) throw Error('Open a saved ChatGPT or Claude conversation first.');
        return api(API_PATH + '?' + new URLSearchParams(session));
      }
      default: throw Error('Unknown message type');
    }
  })().then(result => sendResponse({ ok: true, result }), error => sendResponse({ ok: false, error: String(error.message || error) }));
  return true;
});
