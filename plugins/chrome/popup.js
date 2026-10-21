// Path: plugins/chrome/popup.js
const $ = id => document.getElementById(id);
function call(message) {
  return new Promise((resolve, reject) => chrome.runtime.sendMessage(message, response => {
    if (chrome.runtime.lastError) reject(Error(chrome.runtime.lastError.message));
    else if (!response?.ok) reject(Error(response?.error || 'Unknown error'));
    else resolve(response.result);
  }));
}
function showError(error) { $('error').textContent = error?.message || String(error); }
async function init() {
  try {
    const { session, state, config } = await call({ type: 'get-status' });
    $('where').textContent = session ? `${session.provider} · ${session.conversation_id}` : 'Open an existing ChatGPT or Claude conversation.';
    $('endpoint').value = config.endpoint;
    $('minimum').value = config.minChars;
    $('replace').checked = config.replaceOnPaste;
    $('symbol-compression').checked = Boolean(config.symbolCompression);
    if (state) {
      $('status').textContent = `${state.changed} changed file(s) · ${state.additions} additions · ${state.deletions} deletions`;
      $('diff').value = state.session_diff || '';
    }
  } catch (error) { showError(error); }
}
$('load').addEventListener('click', async () => {
  try {
    const data = await call({ type: 'load-session' });
    $('diff').value = data.session_diff?.llm_diff || '';
    $('status').textContent = `Current session: ${data.session_diff?.changed ?? 0} changed file(s)`;
    $('error').textContent = '';
  } catch (error) { showError(error); }
});
$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('diff').value); $('status').textContent = 'Copied current session diff.'; }
  catch (error) { showError(error); }
});
$('save').addEventListener('click', async () => {
  try {
    await call({ type: 'set-options', endpoint: $('endpoint').value,
      minChars: Number($('minimum').value), replaceOnPaste: $('replace').checked, symbolCompression: $('symbol-compression').checked });
    $('status').textContent = 'Settings saved.'; $('error').textContent = '';
  } catch (error) { showError(error); }
});
init();
