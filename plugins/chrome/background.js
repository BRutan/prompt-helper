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
      case 'list-sessions':
      case 'open-provider':
      case 'deliver-session': return dashboardRequest(message, sender);
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

// Dashboard operations are restricted to this extension's configured loopback
// origin. Pages outside that origin cannot enumerate tabs or initiate sends.
async function fromDashboard(sender) {
  const origin = new URL(sender?.url || sender?.tab?.url || 'about:blank').origin;
  const expected = localBaseUrl((await settings()).endpoint);
  if (origin !== expected) throw Error('Dashboard origin does not match prompt-helper settings.');
}
async function listBrowserSessions() {
  const tabs = await chrome.tabs.query({});
  return tabs.map(tab => ({ ...sessionFromUrl(tab.url || ''), id: tab.id,
    tab_id: tab.id, title: (tab.title || '').slice(0, 100), url: tab.url }))
    .filter(tab => tab.provider && Number.isInteger(tab.tab_id));
}
const deliveriesInFlight = new Set();
async function deliverToConversation(payload) {
  const { delivery_id, tab_id, diff_tokens, original_tokens, estimator } = payload || {};
  if (typeof delivery_id !== 'string' || !/^[a-f0-9]{32}$/.test(delivery_id)) throw Error('Invalid prepared delivery ID.');
  if (!Number.isInteger(tab_id) || !Number.isSafeInteger(diff_tokens) || diff_tokens < 0 ||
      !Number.isSafeInteger(original_tokens) || original_tokens < 0 ||
      typeof estimator !== 'string' || estimator.length > 120) throw Error('Estimate must be calculated before dispatch.');
  if (deliveriesInFlight.has(delivery_id)) throw Error('This delivery is already in progress.');
  deliveriesInFlight.add(delivery_id);
  try {
    const staged = await api('/api/v1/chat-sessions/delivery?' + new URLSearchParams({ delivery_id }));
    if (staged.status !== 'prepared') throw Error('This delivery was already recorded as sent.');
    if (staged.diff_tokens !== diff_tokens || staged.original_tokens !== original_tokens || staged.estimator !== estimator) {
      throw Error('Token estimates must be saved to this delivery before dispatch.');
    }
    if (!staged.files.some(file => file.status !== 'unchanged')) throw Error('There are no changed files to send.');
    const tab = await chrome.tabs.get(tab_id);
    const identity = sessionFromUrl(tab.url || '');
    if (identity?.provider !== staged.provider || identity?.conversation_id !== staged.conversation_id) {
      throw Error('The selected browser tab no longer matches the prepared conversation.');
    }
    const response = await chrome.tabs.sendMessage(tab_id, { type: 'insert-and-send-diff',
      payload: { provider: staged.provider, conversation_id: staged.conversation_id, text: staged.llm_diff } });
    if (!response?.ok) throw Error(response?.error || 'Browser rejected the diff.');
    if (!response.result?.confirmed) return { status:'unconfirmed', reason:response.result?.reason || 'Submission not verified.' };
    const ack = await api('/api/v1/chat-sessions/delivery', { method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({delivery_id,diff_tokens,original_tokens,estimator}) });
    return { ...ack, provider:staged.provider, conversation_id:staged.conversation_id };
  } finally { deliveriesInFlight.delete(delivery_id); }
}

async function dashboardRequest(message, sender) {
  await fromDashboard(sender);
  if (message.type === 'list-sessions') return { sessions: await listBrowserSessions() };
  if (message.type === 'open-provider') {
    const provider = message.payload?.provider;
    if (!['chatgpt','claude'].includes(provider)) throw Error('Unknown provider.');
    const tab = await chrome.tabs.create({ url: provider === 'chatgpt' ? 'https://chatgpt.com/' : 'https://claude.ai/', active:true });
    return { tab_id:tab.id, provider, status:'opened', note:'Start a conversation, then refresh sessions to discover its saved URL.' };
  }
  return deliverToConversation(message.payload);
}
