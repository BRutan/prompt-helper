// Path: plugins/chrome/popup.js
// Navigation-only popup. Diffs are processed in background and never rendered here.
const $ = id => document.getElementById(id);
const name = {chatgpt:'ChatGPT',claude:'Claude'};
let view = 'home';
let enabled = true;
function call(message) {
  return new Promise((resolve, reject) => chrome.runtime.sendMessage(message, response => {
    if (chrome.runtime.lastError) reject(Error(chrome.runtime.lastError.message));
    else if (!response?.ok) reject(Error(response?.error || 'Unknown error'));
    else resolve(response.result);
  }));
}
function showError(error) { $('error').textContent = error?.message || String(error); }
function clearError() { $('error').textContent = ''; }
function display() {
  for (const page of ['home','sessions','settings']) {
    $(page + '-view').classList.toggle('hidden',view !== page);
  }
}
function showToggle() {
  $('enabled-toggle').setAttribute('aria-pressed',String(enabled));
  $('enabled-toggle').setAttribute('aria-label',`Turn prompt-helper ${enabled?'off':'on'}`);
  $('enabled-state').textContent = enabled ? 'ON' : 'OFF';
}
function bounds() {
  return {left:window.screen.availLeft,top:window.screen.availTop,
    width:window.screen.availWidth,height:window.screen.availHeight};
}
async function switchView(target) {
  view = target; display(); clearError();
  if (target === 'sessions') await refreshSessions();
}
function renderSessions(sessions) {
  const counts = {chatgpt:0,claude:0};
  for (const item of sessions) if (Object.hasOwn(counts,item.provider)) counts[item.provider]++;
  $('chatgpt-count').textContent = String(counts.chatgpt);
  $('claude-count').textContent = String(counts.claude);
  const list = $('session-list'); list.replaceChildren();
  for (const provider of ['chatgpt','claude']) {
    const group = sessions.filter(s=>s.provider===provider);
    if (!group.length) continue;
    const heading = document.createElement('h2'); heading.textContent = name[provider]; list.append(heading);
    for (const entry of group) {
      const button = document.createElement('button'); button.className='session'; button.type='button'; button.setAttribute('role','listitem');
      const title = document.createElement('span');title.className='name';title.textContent=entry.title || `${name[provider]} conversation`;
      const detail = document.createElement('small');detail.textContent=`${entry.conversation_id || 'New / unsaved conversation'} · Window ${entry.window_id}${entry.active?' · Active':''}`;
      button.append(title,detail);
      button.addEventListener('click',async()=>{
        try { clearError(); await call({type:'focus-session',tab_id:entry.tab_id}); }
        catch(error) { showError(error); }
      });
      list.append(button);
    }
  }
  if (!sessions.length) {
    const empty=document.createElement('p');empty.className='muted';empty.textContent='No saved ChatGPT or Claude conversations are currently open.';list.append(empty);
  }
}
async function refreshSessions() {
  try {
    const result = await call({type:'get-open-sessions'});
    renderSessions(result.sessions || []);
    clearError();
  } catch(error) { showError(error); }
}
async function init() {
  if (new URLSearchParams(location.search).get('view') === 'sessions') {
    document.body.classList.add('standalone'); view = 'sessions';
  }
  display();
  try {
    // Request configuration only: no source, diff text, or session state.
    const config = await call({type:'get-popup-config'});
    enabled = config.enabled !== false;
    showToggle();
    $('minimum').value = config.minChars;
    $('replace').checked = config.replaceOnPaste;
    $('symbol-compression').checked = Boolean(config.symbolCompression);
    $('aggregate-session-media').checked = Boolean(config.aggregateSessionMedia);
    $('session-media-folder').value = config.sessionMediaFolder || '';
    if (view === 'sessions') await refreshSessions();
  } catch(error) { showError(error); }
}
$('sessions-button').addEventListener('click',()=>void switchView('sessions'));
$('settings-button').addEventListener('click',()=>void switchView('settings'));
$('sessions-back').addEventListener('click',()=>void switchView('home'));
$('settings-back').addEventListener('click',()=>void switchView('home'));
$('refresh-sessions').addEventListener('click',()=>void refreshSessions());
$('arrange-sessions').addEventListener('click',async()=>{
  try {
    clearError(); const result=await call({type:'arrange-sessions',screen:bounds()});
    $('session-list').setAttribute('aria-label',`${result.count} sessions arranged in separate windows`);
    await refreshSessions();
  } catch(error) { showError(error); }
});
$('dashboard-button').addEventListener('click',async()=>{
  try {
    clearError();
    // Chrome associates a toolbar popup with a browser window. Pass that ID
    // when it is a normal browser window; background validates it again.
    const current = await chrome.windows.getCurrent().catch(()=>null);
    await call({type:'open-dashboard-window',screen:bounds(),
      origin_window_id:current?.type==='normal'?current.id:null});
  }
  catch(error) { showError(error); }
});
$('enabled-toggle').addEventListener('click',async()=>{
  const toggle = $('enabled-toggle');
  toggle.disabled = true;
  try {
    const result = await call({type:'set-enabled',enabled:!enabled});
    enabled = result.enabled;
    showToggle();clearError();
  } catch(error) { showError(error); }
  finally { toggle.disabled=false; }
});
$('choose-session-media-folder').addEventListener('click',async()=>{
  const button = $('choose-session-media-folder');
  button.disabled = true;
  try {
    clearError();
    const result = await call({type:'choose-session-media-folder'});
    $('session-media-folder').value = result.folder;
  } catch(error) { showError(error); }
  finally { button.disabled = false; }
});
$('save').addEventListener('click',async()=>{
  try {
    await call({type:'set-options',minChars:Number($('minimum').value),
      replaceOnPaste:$('replace').checked,symbolCompression:$('symbol-compression').checked,
      aggregateSessionMedia:$('aggregate-session-media').checked,
      sessionMediaFolder:$('session-media-folder').value});
    $('settings-status').textContent='Settings saved.';clearError();
  } catch(error) { $('settings-status').textContent='';showError(error); }
});
void init();
