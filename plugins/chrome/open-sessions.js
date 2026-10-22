// Path: plugins/chrome/open-sessions.js
// Enumerate every open ChatGPT/Claude tab, regardless of window or active state.
import { sessionFromUrl } from './session.js';

function providerForUrl(input) {
  try {
    const url = new URL(input);
    if (url.protocol !== 'https:') return null;
    if (url.hostname === 'chatgpt.com' || url.hostname === 'chat.openai.com') return 'chatgpt';
    if (url.hostname === 'claude.ai') return 'claude';
  } catch { /* Missing URL while Chrome is navigating. */ }
  return null;
}

export function browserConversation(tab) {
  if (!Number.isInteger(tab?.id)) return null;
  const url = String(tab.url || tab.pendingUrl || '');
  const provider = providerForUrl(url);
  if (!provider) return null;
  const parsed = sessionFromUrl(url);
  // A new conversation has no stable ID until the provider assigns one.
  // Still show its OPEN tab in the sessions list and allow arranging/focusing it.
  const unsaved = !parsed;
  return {
    provider,
    conversation_id: parsed?.conversation_id || null,
    unsaved,
    tab_id: tab.id,
    window_id: tab.windowId,
    active: Boolean(tab.active),
    title: String(tab.title || `${provider === 'chatgpt' ? 'ChatGPT' : 'Claude'} ${unsaved ? '(new chat)' : 'conversation'}`).slice(0, 120),
    url,
  };
}

export function openConversations(windows, looseTabs = []) {
  // Use the actual window graph (Chrome normal AND popup windows) first. The
  // tab fallback covers Chrome versions that omit populate from a window.
  const seen = new Set();
  const result = [];
  const add = tab => {
    if (seen.has(tab?.id)) return;
    const item = browserConversation(tab);
    if (!item) return;
    seen.add(tab.id);
    result.push(item);
  };
  for (const win of windows || []) {
    for (const tab of win.tabs || []) {
      add({ ...tab, windowId: tab.windowId ?? win.id });
    }
  }
  for (const tab of looseTabs || []) add(tab);
  // Stable, user-understandable ordering across all Chrome windows.
  return result.sort((a, b) => a.window_id - b.window_id || a.tab_id - b.tab_id);
}

export function dashboardGeometry(screen) {
  const width = Math.floor(Number(screen?.width));
  const height = Math.floor(Number(screen?.height));
  const left = Math.round(Number(screen?.left));
  const top = Math.round(Number(screen?.top));
  if (![width, height, left, top].every(Number.isFinite) || width < 1060 || height < 400) {
    throw Error('A display at least 1060px wide and 400px high is required.');
  }
  const firstWidth = Math.floor(width / 2);
  return {
    chrome: { left, top, width: firstWidth, height },
    dashboard: { left: left + firstWidth, top, width: width - firstWidth, height },
  };
}
