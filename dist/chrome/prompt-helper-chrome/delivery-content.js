// Path: plugins/chrome/delivery-content.js
// Insert a staged diff into the CURRENT chat editor and click its send control.
// Confirm only when the newly submitted user message is visible in the DOM.
(() => {
  const sources = {
    chatgpt: ['#prompt-textarea', 'textarea[data-testid="prompt-textarea"]', '[contenteditable="true"][data-testid="prompt-textarea"]'],
    claude: ['[contenteditable="true"].ProseMirror', '[data-testid="chat-input"] [contenteditable="true"]', 'fieldset [contenteditable="true"]'],
  };
  const buttons = {
    chatgpt: ['button[data-testid="send-button"]', 'button[data-testid="composer-send-button"]', 'button[aria-label="Send prompt"]', 'button[aria-label="Send message"]'],
    claude: ['button[aria-label="Send message"]', 'button[data-testid="send-button"]', 'fieldset button[type="submit"]'],
  };
  const userMessages = {
    chatgpt: '[data-message-author-role="user"]',
    claude: '[data-testid="user-message"], [data-is-streaming="false"].font-user-message, .font-user-message',
  };
  let running = false;
  function sessionMatches(provider, id) {
    const host = location.hostname;
    if (provider === 'chatgpt' && !['chatgpt.com', 'chat.openai.com'].includes(host)) return false;
    if (provider === 'claude' && host !== 'claude.ai') return false;
    return location.pathname.split('/').includes(id);
  }
  const findVisible = (selectors) => selectors.map(s => document.querySelector(s)).find(el => el && el.getClientRects().length && !el.disabled);
  function composerText(el) { return el instanceof HTMLTextAreaElement ? el.value : (el.innerText || '').trim(); }
  function fillComposer(editor, text) {
    editor.focus();
    if (editor instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (!setter) return false;
      setter.call(editor, text);editor.dispatchEvent(new Event('input', { bubbles:true }));return true;
    }
    const sel = window.getSelection();sel?.selectAllChildren(editor);sel?.collapseToEnd();
    return document.execCommand('insertText', false, text);
  }
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function insertAndSend({ provider, conversation_id, text }) {
    if (running) throw Error('Another delivery is already in progress in this tab.');
    if (!sessionMatches(provider, conversation_id)) throw Error('Tab is no longer the selected conversation.');
    if (typeof text !== 'string' || !text.startsWith('BATCH DIFF |') || !text.includes('CHANGED FILES')) throw Error('Refusing an unrecognized source diff.');
    running = true;
    try {
      const editor = findVisible(sources[provider]);
      if (!editor) throw Error('Chat composer not found; website selectors may have changed.');
      if (composerText(editor)) throw Error('The chat composer is not empty. Clear or submit your current draft first.');
      const existing = new Set([...document.querySelectorAll(userMessages[provider])]);
      if (!fillComposer(editor, text)) throw Error('Chat editor rejected automatic insertion.');
      // Let React/ProseMirror update their send-button state.
      await sleep(350);
      if (!sessionMatches(provider, conversation_id)) return { confirmed:false, reason:'The conversation changed after insertion.' };
      const button = findVisible(buttons[provider]);
      if (!button || button.getAttribute('aria-disabled') === 'true') return { confirmed:false, reason:'Diff inserted as draft; no supported send button found. Send manually; delivery remains unconfirmed.' };
      button.click();
      const expected = text.slice(0, Math.min(48, text.length));
      for (let i=0; i<50; i++) {
        await sleep(200);
        if (!sessionMatches(provider, conversation_id)) break;
        const nodes = [...document.querySelectorAll(userMessages[provider])];
        if (nodes.some(node => !existing.has(node) && (node.textContent || '').includes(expected))) {
          return { confirmed:true };
        }
      }
      return { confirmed:false, reason:'Submission could not be verified in the chat transcript. The diff may already have been sent; do not retry blindly.' };
    } finally { running = false; }
  }
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.type !== 'insert-and-send-diff') return;
    insertAndSend(message.payload).then(result=>respond({ok:true,result}),error=>respond({ok:false,error:error.message}));
    return true;
  });
})();
