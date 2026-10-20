// Path: plugins/chrome/content.js
// Only active chat composers are processed. Clipboard content is never sent
// anywhere except the user's loopback prompt-helper backend.
(() => {
  const FRAME = /^={8,}\r?\nSOURCE_DIR:[ \t]*\/[^\r\n]+\r?\nFILE:[ \t]*[^\r\n]+\r?\n={8,}(?:\r?\n|$)/m;
  const HEADER = /^(?:\/\/|#|--|<!--|\/\*|)?[ \t]*Path:[ \t]*(?:\/|[\w.-]+\/)[^\r\n]+/m;
  let processing = false;
  let minChars = 1000;
  let replaceOnPaste = true;
  chrome.storage.local.get({ minChars: 1000, replaceOnPaste: true }, settings => {
    minChars = Number(settings.minChars) || 1000;
    replaceOnPaste = settings.replaceOnPaste !== false;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.minChars) minChars = Number(changes.minChars.newValue) || 1000;
    if (changes.replaceOnPaste) replaceOnPaste = changes.replaceOnPaste.newValue !== false;
  });

  function candidate(text) { return text && text.length >= minChars && (FRAME.test(text) || HEADER.test(text)); }
  function editorFrom(target) {
    const el = target?.nodeType === Node.ELEMENT_NODE ? target : target?.parentElement;
    const editor = el?.closest('textarea, [contenteditable="true"], [role="textbox"]');
    if (!editor || !editor.isConnected) return null;
    // Do not watch editable search boxes, code blocks, or past messages.
    if (editor.matches('textarea') && /search/i.test(editor.getAttribute('aria-label') || '')) return null;
    if (!editor.matches('textarea') && !editor.matches('#prompt-textarea, [data-testid="chat-input"], .ProseMirror, [role="textbox"]')) return null;
    return editor;
  }
  function insertText(editor, text) {
    editor.focus();
    if (editor instanceof HTMLTextAreaElement) {
      const start = editor.selectionStart;
      const end = editor.selectionEnd;
      editor.setRangeText(text, start, end, 'end');
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      return true;
    }
    // ProseMirror/React editors use the browser's own editing transaction.
    return document.execCommand('insertText', false, text);
  }
  function send(content) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'process-source', content }, response => {
        if (chrome.runtime.lastError) reject(Error(chrome.runtime.lastError.message));
        else if (!response?.ok) reject(Error(response?.error || 'Session diff failed'));
        else resolve(response.result);
      });
    });
  }
  function toast(message, error = false) {
    let node = document.getElementById('prompt-helper-chrome-status');
    if (!node) {
      node = document.createElement('div');
      node.id = 'prompt-helper-chrome-status';
      Object.assign(node.style, { position: 'fixed', bottom: '18px', right: '18px', zIndex: '2147483647',
        maxWidth: '360px', padding: '10px 14px', borderRadius: '8px', background: '#253046', color: 'white',
        boxShadow: '0 4px 16px #0004', font: '13px system-ui, sans-serif', pointerEvents: 'none' });
      document.documentElement.append(node);
    }
    node.style.background = error ? '#a43c47' : '#253046';
    node.textContent = message;
    // No timers required for correctness; later actions replace this message.
  }
  document.addEventListener('paste', async event => {
    if (processing || event.defaultPrevented) return;
    const editor = editorFrom(event.target);
    if (!editor) return;
    const original = event.clipboardData?.getData('text/plain') || '';
    if (!candidate(original)) return;
    // On new chats, wait for the provider to assign a conversation ID so pastes
    // cannot be written against the wrong conversation.
    if (!/\/(?:c|chat)\/[A-Za-z0-9_-]+(?:\/|$)/.test(location.pathname)) return;
    const replacing = replaceOnPaste;
    if (replacing) event.preventDefault();
    processing = true;
    toast('Generating conversation-scoped source diff…');
    try {
      const result = await send(original);
      // If the user moved away before processing finished, restore the source
      // into the original editor rather than injecting a diff into another chat.
      const samePage = location.pathname.includes(result.session.conversation_id);
      if (!replacing || !samePage || !editor.isConnected) {
        toast('Session diff saved. Open the extension popup to copy it.');
        return;
      }
      if (!insertText(editor, result.replacement_text)) throw Error('Editor insertion was rejected.');
      toast(`Session diff ready: ${result.changed} changed file(s).`);
    } catch (error) {
      // Fail open: if the backend is down, users must not lose their paste.
      if (replacing && editor.isConnected) insertText(editor, original);
      toast(`prompt-helper: ${error.message}. ${replacing ? 'Original paste restored.' : 'Original paste retained.'}`, true);
    } finally { processing = false; }
  }, true);
})();
