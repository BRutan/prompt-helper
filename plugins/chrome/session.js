// Path: plugins/chrome/session.js
// Session identity follows the conversation URL, not the browser window/tab.
// This survives SPA navigation and reopening the same conversation in a new tab.
export function sessionFromUrl(input) {
  let url;
  try { url = new URL(input); } catch { return null; }
  let provider;
  let id;
  const parts = url.pathname.split('/').filter(Boolean);
  if ((url.hostname === 'chatgpt.com' || url.hostname === 'chat.openai.com') && url.protocol === 'https:') {
    provider = 'chatgpt';
    const i = parts.indexOf('c');
    if (i >= 0) id = parts[i + 1];
  } else if (url.hostname === 'claude.ai' && url.protocol === 'https:') {
    provider = 'claude';
    const i = parts.indexOf('chat');
    if (i >= 0) id = parts[i + 1];
  } else return null;
  if (!id || !/^[A-Za-z0-9_-]{1,200}$/.test(id)) return null;
  return { provider, conversation_id: id };
}

// A full framed dump or a single annotated file, never ordinary chat prose.
const FRAME = /^={8,}\r?\nSOURCE_DIR:[ \t]*\/[^\r\n]+\r?\nFILE:[ \t]*[^\r\n]+\r?\n={8,}(?:\r?\n|$)/m;
const HEADER = /^(?:\/\/|#|--|<!--|\/\*|)?[ \t]*Path:[ \t]*(?:\/|[\w.-]+\/)[^\r\n]+/m;

export function looksLikeSource(text, minChars = 1000) {
  return typeof text === 'string' && text.length >= minChars && (FRAME.test(text) || HEADER.test(text));
}

export function localBaseUrl(value) {
  let u;
  try { u = new URL(value); } catch { throw Error('Backend URL must be http://127.0.0.1:<port> or http://localhost:<port>'); }
  if (u.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(u.hostname) || u.username || u.password || u.search || u.hash) {
    throw Error('Only a local HTTP prompt-helper URL is allowed.');
  }
  const base = u.origin;
  return base;
}
