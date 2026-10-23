// Path: plugins/chrome/background.js
import { sessionFromUrl, looksLikeSource, localBaseUrl } from './session.js';
import { expandGitDiff, inverseForNative, normalizeGitDiffPaths } from './symbol-compression.js';
import { watchBuilds } from './build-watch.js';
import { IS_LOCAL, CONFIGURED_ENDPOINT } from './runtime-config.js';
import { compactGrid, layoutOverlaps } from './session-layout.js';
import { planSessionWindows } from './session-arrangement.js';
import { browserConversation, openConversations, dashboardGeometry } from './open-sessions.js';

const DEFAULTS = { enabled: true, minChars: 1000, replaceOnPaste: true, symbolCompression: false,
  aggregateSessionMedia: false, sessionMediaFolder: '' };
const API_PATH = '/api/v1/chat-sessions/diff';
const inFlight = new Map();
const recent = new Map();

async function sessionMediaNative(payload) {
  let response;
  try {
    response = await chrome.runtime.sendNativeMessage('com.prompt_helper.patch_runner', payload);
  } catch (error) {
    throw Error('Install the prompt-helper macOS native host before enabling Session Media: ' + String(error));
  }
  if (!response?.ok) throw Error(response?.error || 'Session Media native helper failed');
  return response;
}

function configuredEndpoint() {
  if (IS_LOCAL) return localBaseUrl(CONFIGURED_ENDPOINT);
  const url = new URL(CONFIGURED_ENDPOINT);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw Error('Invalid build-time remote endpoint');
  }
  return url.origin;
}

async function settings() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)), endpoint: configuredEndpoint() };
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
  const base = configuredEndpoint();
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
  if (!config.enabled) throw Error('prompt-helper is turned off.');
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case 'process-source': return processPaste(message, sender);
      case 'list-sessions':
      case 'open-provider':
      case 'deliver-session':
      case 'symbol-settings':
      case 'set-symbol-compression':
      case 'commit-symbol-registry': return dashboardRequest(message, sender);
      case 'assistant-response-complete': return responseCompleted(message.payload, sender);
      case 'assistant-response-timeout': return responseTimedOut(message.delivery_id, sender);
      case 'get-popup-config': return requireExtensionUI(sender).then(async () => {
        const config = await settings();
        // Native state is authoritative even if the browser extension is reloaded.
        try {
          const native = await sessionMediaNative({action:'session_media_status'});
          return {...config, aggregateSessionMedia:native.enabled,
            sessionMediaFolder:config.sessionMediaFolder || native.folder};
        } catch { return config; }
      });
      case 'choose-session-media-folder': {
        await requireExtensionUI(sender);
        const choice = await sessionMediaNative({action:'session_media_choose_folder'});
        // Chrome closes toolbar popups while a native macOS picker has focus.
        // Persist the selection immediately so reopening Settings retains it.
        await chrome.storage.local.set({sessionMediaFolder:choice.folder});
        return choice;
      }
      case 'session-media-upload-dialog': {
        const session = sessionFromUrl(sender?.tab?.url || '');
        if (!session || !sender.tab?.active) throw Error('Only a saved, active conversation can open session media.');
        const config = await settings();
        if (!config.aggregateSessionMedia) return {navigated:false,reason:'disabled'};
        // Native helper only navigates an existing Open dialog; it cannot pick files.
        return sessionMediaNative({action:'session_media_upload_dialog',conversation_id:session.conversation_id});
      }

      case 'set-enabled': {
        await requireExtensionUI(sender);
        if (typeof message.enabled !== 'boolean') throw Error('enabled must be a boolean');
        await chrome.storage.local.set({ enabled: message.enabled });
        if (!message.enabled) {
          const tabs = await chrome.tabs.query({});
          for (const tab of tabs) if (Number.isInteger(tab.id)) badge(tab.id, '', '#347b64');
        }
        return { enabled: message.enabled };
      }
      case 'get-open-sessions': return requireExtensionUI(sender).then(async () => ({ sessions: await listBrowserSessions(), config: await settings() }));
      case 'focus-session': return requireExtensionUI(sender).then(() => focusBrowserSession(message.tab_id));
      case 'arrange-sessions': return requireExtensionUI(sender).then(() => arrangeBrowserSessions(message.screen));
      case 'open-dashboard-window': return requireExtensionUI(sender).then(() => openDashboardCompanion(message.screen, message.origin_window_id));
      case 'set-options': {
        await requireExtensionUI(sender);
        const minChars = Number(message.minChars);
        if (!Number.isInteger(minChars) || minChars < 100 || minChars > 1000000) throw Error('minChars must be 100..1000000');
        if (typeof message.aggregateSessionMedia !== 'boolean') throw Error('Aggregate Session Media must be on or off.');
        if (typeof message.sessionMediaFolder !== 'string') throw Error('Invalid Session Media folder.');
        const prior = await settings();
        // Ordinary settings remain usable without installing the native host.
        let media = {enabled:false,folder:message.sessionMediaFolder};
        if (message.aggregateSessionMedia || prior.aggregateSessionMedia) {
          media = await sessionMediaNative({action:'session_media_configure',
            enabled:message.aggregateSessionMedia,folder:message.sessionMediaFolder});
        }
        const options = { minChars, replaceOnPaste: Boolean(message.replaceOnPaste),
          symbolCompression: Boolean(message.symbolCompression),
          aggregateSessionMedia:media.enabled, sessionMediaFolder:media.folder };
        await chrome.storage.local.set(options);
        return options;
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
  const expected = configuredEndpoint();
  if (origin !== expected) throw Error('Dashboard origin does not match prompt-helper settings.');
}
async function listBrowserSessions() {
  // chrome.tabs.query({active:true}) sees only the selected tab in a window;
  // getAll(populate) and the unfiltered tab query include EVERY tab in EVERY
  // normal and popup Chrome window, even when hidden behind another window.
  const [windows, tabs] = await Promise.all([
    chrome.windows.getAll({populate:true,windowTypes:['normal','popup']}),
    chrome.tabs.query({}),
  ]);
  return openConversations(windows,tabs);
}
// Popup-only tab/window operations. Provider web pages cannot invoke them.
async function requireExtensionUI(sender) {
  if (sender.tab || !sender.url?.startsWith(chrome.runtime.getURL('popup.html'))) {
    throw Error('Sessions controls are available only from the extension popup.');
  }
}
async function focusBrowserSession(tabId) {
  if (!Number.isInteger(tabId)) throw Error('Invalid conversation tab.');
  const tab = await chrome.tabs.get(tabId);
  if (!browserConversation(tab)) throw Error('Tab is no longer a ChatGPT or Claude conversation.');
  await chrome.tabs.update(tabId, {active:true});
  await chrome.windows.update(tab.windowId, {focused:true});
  return {tab_id:tabId,window_id:tab.windowId};
}
function screenBounds(screen) {
  const width = Number(screen?.width),height=Number(screen?.height);
  const left = Number(screen?.left),top=Number(screen?.top);
  if (![width,height,left,top].every(Number.isFinite) || width < 640 || height < 400 || width > 20000 || height > 20000 ||
      Math.abs(left) > 20000 || Math.abs(top) > 20000) throw Error('Invalid available display geometry.');
  return {width:Math.floor(width),height:Math.floor(height),left:Math.floor(left),top:Math.floor(top)};
}
let arrangementInProgress = false;
async function arrangeBrowserSessions(screen) {
  if (arrangementInProgress) throw Error('A session arrangement is already running.');
  arrangementInProgress = true;
  try {
    const bounds = screenBounds(screen);
    // Query all tabs and windows ONCE to choose which existing windows can be
    // reused. This avoids reparenting isolated tabs, which can reinitialize
    // the provider UI and retrigger account/security checks.
    const [windows, allTabs] = await Promise.all([
      chrome.windows.getAll({populate:true,windowTypes:['normal','popup']}),
      chrome.tabs.query({}),
    ]);
    const sessions = openConversations(windows,allTabs);
    if (!sessions.length) throw Error('No ChatGPT or Claude sessions are open in Chrome.');
    const rects = compactGrid(sessions.length,bounds);
    const plan = planSessionWindows(sessions,windows);
    const targets = [];
    const createdWindowIds = [];
    // Do not focus windows or navigate ChatGPT as part of arranging. Split
    // only the tabs sharing a window (or living in a popup). All others stay.
    for (const step of plan) {
      if (step.reuse_window_id !== null) {
        targets.push(step.reuse_window_id);
        continue;
      }
      const tab = await chrome.tabs.get(step.tab_id);
      if (!browserConversation(tab)) throw Error(`Conversation tab ${step.tab_id} was closed while arranging.`);
      const created = await chrome.windows.create({tabId:step.tab_id,type:'normal',focused:false});
      if (!Number.isInteger(created?.id)) throw Error('Chrome did not return a new window ID.');
      createdWindowIds.push(created.id);
      targets.push(created.id);
    }
    // macOS Chrome can ignore bounds requested in windows.create (and clamps
    // tiny rectangles to its own minimum). Apply positions to final windows,
    // after all detaches, using Chrome's normal-window update API.
    for (let i=0;i<targets.length;i++) {
      await chrome.windows.update(targets[i],{state:'normal'});
      await chrome.windows.update(targets[i],rects[i]);
    }
    // Keep a deterministic foreground chat but do not change its URL/tab.
    const previouslyFocusedId = windows.find(w=>w.focused && w.type==='normal')?.id;
    let focusIndex = sessions.findIndex(s=>s.window_id===previouslyFocusedId && s.active);
    if (focusIndex<0) focusIndex = sessions.findIndex(s=>s.active);
    const focusId = targets[focusIndex>=0?focusIndex:0];
    if (Number.isInteger(focusId)) await chrome.windows.update(focusId,{focused:true});
    return {count:targets.length,window_ids:targets,created_window_ids:createdWindowIds,
      layout:layoutOverlaps(rects)?'staggered':'tiled'};
  } finally { arrangementInProgress = false; }
}

async function normalChromeWindow(preferredId) {
  // The extension action popup is NOT the window to resize. Reuse a browser
  // window (normal) and preserve all of its tabs and unsent composer content.
  if (Number.isInteger(preferredId)) {
    try {
      const preferred = await chrome.windows.get(preferredId);
      if (preferred?.type === 'normal') return preferred;
    } catch { /* Window closed between button press and handler. */ }
  }
  const last = await chrome.windows.getLastFocused({windowTypes:['normal']}).catch(()=>null);
  if (last?.type === 'normal') return last;
  const windows = await chrome.windows.getAll({populate:true,windowTypes:['normal']});
  const candidates = windows.filter(w => w.type === 'normal');
  // Prefer a normal window holding a provider session if Chrome focus changed.
  const matching = candidates.find(w => w.tabs?.some(t => browserConversation(t)));
  return matching || candidates.find(w => w.focused) || candidates[0] || null;
}
async function openDashboardCompanion(screen,preferredWindowId) {
  const b = screenBounds(screen);
  const geometry = dashboardGeometry(b);
  const origin = await normalChromeWindow(preferredWindowId);
  if (!origin) throw Error('Open a normal Google Chrome window before opening the dashboard.');
  // Existing Chrome window on the LEFT, not another prompt-helper plugin window.
  await chrome.windows.update(origin.id,{state:'normal',...geometry.chrome,focused:false});
  const dashboardUrl = configuredEndpoint()+'/';
  const all = await chrome.windows.getAll({populate:true});
  // Reuse an existing dashboard window, except the origin that was just resized.
  const prior = all.find(w => w.id !== origin.id && w.tabs?.some(t => t.url === dashboardUrl));
  let dashboard;
  if (prior) {
    await chrome.windows.update(prior.id,{state:'normal',...geometry.dashboard,focused:true});
    dashboard = prior;
  } else {
    dashboard = await chrome.windows.create({url:dashboardUrl,type:'popup',
      ...geometry.dashboard,focused:true});
  }
  return {chrome_window_id:origin.id,dashboard_window_id:dashboard.id};
}

function validSymbolIdentity(provider,id){return ['chatgpt','claude'].includes(provider)&&typeof id==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(id);}
const deliveriesInFlight = new Set();
async function deliverToConversation(payload) {
  if (!(await settings()).enabled) throw Error('prompt-helper is turned off.');
  const { delivery_id, tab_id, diff_tokens, original_tokens, estimator, repo_path, compressed_diff, symbol_registry, compression_enabled } = payload || {};
  if (typeof delivery_id !== 'string' || !/^[a-f0-9]{32}$/.test(delivery_id)) throw Error('Invalid prepared delivery ID.');
  if (!Number.isInteger(tab_id) || !Number.isSafeInteger(diff_tokens) || diff_tokens < 0 ||
      !Number.isSafeInteger(original_tokens) || original_tokens < 0 ||
      typeof estimator !== 'string' || estimator.length > 120) throw Error('Estimate must be calculated before dispatch.');
  if (typeof repo_path !== 'string' || !repo_path.startsWith('/') || repo_path.length > 4096 || repo_path.includes('\0')) throw Error('An absolute local target Git repository path is required.');
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
    if (!staged.user_prompt?.trim()) throw Error('A required user instruction must be saved with the delivery.');
    const config=await settings();
    if(Boolean(compression_enabled)!==Boolean(config.symbolCompression))throw Error('Compression setting changed since preview. Prepare again.');
    const registryKey=`symbol-registry:${staged.provider}:${staged.conversation_id}`;
    let registry={};
    let diff=staged.llm_diff;
    if(config.symbolCompression){
      if(typeof staged.git_diff!=='string'||!staged.git_diff.trim())throw Error('Delivery has no persisted Git diff; prepare again.');
      if(typeof compressed_diff!=='string'||!symbol_registry||typeof symbol_registry!=='object')throw Error('Symbol-compressed Git diff and mapping required.');
      const stored=(await chrome.storage.local.get(registryKey))[registryKey]||{};
      // Persistent aliases can never be silently remapped between deliveries.
      for(const [path, names] of Object.entries(stored))for(const [word,alias] of Object.entries(names||{})){
        if(symbol_registry[path]?.[word]!==alias)throw Error('Symbol mapping changed since last successful send. Prepare again.');
      }
      const original=normalizeGitDiffPaths(staged.git_diff,staged.files,repo_path);
      if(expandGitDiff(compressed_diff,symbol_registry)!==original)throw Error('Compressed Git diff does not decode to the server-stored original.');
      registry=symbol_registry;
      diff=compressed_diff;
    }
    const text = `USER REQUEST\n${staged.user_prompt}\n\n${config.symbolCompression?'SYMBOL-COMPRESSED GIT DIFF':'SOURCE CHANGES'}\n${diff}\n\n${config.symbolCompression?'The diff uses temporary local aliases for eligible private symbols. Preserve aliases when editing; the local patch runner restores their original names before git apply. Never rename external APIs, exports or public symbols.\n\n':''}Return an applicable Git patch as one downloadable .patch or .zip file, and give the git apply command. Do not require any other shell commands to apply it.`;
    // Persist the explicitly selected repo and identity, never take it from the chatbot reply.
    await chrome.storage.local.set({ [`pending-symbols:${delivery_id}`]:config.symbolCompression?registry:null, [`patch-delivery:${delivery_id}`]: {repo_path,tab_id,
      provider:staged.provider,conversation_id:staged.conversation_id, symbol_registry: config.symbolCompression?inverseForNative(registry):null} });
    const response = await chrome.tabs.sendMessage(tab_id, { type: 'insert-and-send-diff',
      payload: { provider: staged.provider, conversation_id: staged.conversation_id, delivery_id, text } });
    if (!response?.ok) throw Error(response?.error || 'Browser rejected the diff.');
    if (!response.result?.confirmed) return { status:'unconfirmed', reason:response.result?.reason || 'Submission not verified.' };
    const ack = await api('/api/v1/chat-sessions/delivery', { method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({delivery_id,diff_tokens,original_tokens,estimator}) });
    if(config.symbolCompression)await chrome.storage.local.set({[registryKey]:registry});
    await chrome.storage.local.remove(`pending-symbols:${delivery_id}`);
    return { ...ack, provider:staged.provider, conversation_id:staged.conversation_id };
  } finally { deliveriesInFlight.delete(delivery_id); }
}

async function dashboardRequest(message, sender) {
  await fromDashboard(sender);
  if (message.type === 'list-sessions') return { sessions: await listBrowserSessions() };
  if (message.type === 'symbol-settings') {
    const provider=message.payload?.provider, conversation_id=message.payload?.conversation_id;
    if(!validSymbolIdentity(provider,conversation_id))throw Error('Select a saved conversation.');
    const key=`symbol-registry:${provider}:${conversation_id}`;
    return {enabled:(await settings()).symbolCompression,registry:(await chrome.storage.local.get(key))[key]||{}};
  }
  if (message.type === 'set-symbol-compression') {
    const enabled=message.payload?.enabled;
    if(typeof enabled!=='boolean')throw Error('Invalid compression toggle');
    await chrome.storage.local.set({symbolCompression:enabled});
    return {enabled};
  }
  if (message.type === 'commit-symbol-registry') {
    const id=message.payload?.delivery_id;
    if(typeof id!=='string'||!/^[a-f0-9]{32}$/.test(id))throw Error('Invalid delivery');
    const record=await api('/api/v1/chat-sessions/delivery?'+new URLSearchParams({delivery_id:id}));
    if(record.status!=='sent')throw Error('Delivery is not confirmed as sent');
    const mapping=(await chrome.storage.local.get(`pending-symbols:${id}`))[`pending-symbols:${id}`];
    if(mapping){await chrome.storage.local.set({[`symbol-registry:${record.provider}:${record.conversation_id}`]:mapping});
      await chrome.storage.local.remove(`pending-symbols:${id}`);}
    return {committed:!!mapping};
  }
  if (message.type === 'open-provider') {
    const provider = message.payload?.provider;
    if (!['chatgpt','claude'].includes(provider)) throw Error('Unknown provider.');
    const tab = await chrome.tabs.create({ url: provider === 'chatgpt' ? 'https://chatgpt.com/' : 'https://claude.ai/', active:true });
    return { tab_id:tab.id, provider, status:'opened', note:'Start a conversation, then refresh sessions to discover its saved URL.' };
  }
  return deliverToConversation(message.payload);
}

// A completion observation is accepted only from the same conversation tab
// that sent the original delivery; downloading and git apply are performed
// once for that delivery even if the page watcher emits a duplicate event.
const completedInFlight=new Set();
async function recordPatchEvent(event){
  return api('/api/v1/chat-sessions/patch-event',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify(event)});
}
async function responseTimedOut(id,sender){
  const state=(await chrome.storage.local.get(`patch-delivery:${id}`))[`patch-delivery:${id}`];
  if(!state || sender.tab?.id!==state.tab_id)return {ignored:true};
  return recordPatchEvent({delivery_id:id,status:'timeout',details:'No completed assistant response detected within 30 minutes.'});
}
// Limit automatic corrective follow-ups to two to prevent a runaway chat loop.
const MAX_PATCH_ATTEMPTS=3;
async function sendPatchError(state,id,reason,attempt){
  if(attempt>=MAX_PATCH_ATTEMPTS)return {retried:false,extra:' | Automatic retry limit reached (3 attempts).'};
  const text='PATCH APPLICATION FAILED\n'+
    `No patch has been applied to the selected Git repository (${state.repo_path}).\n`+
    `Delivery: ${id}\nError: ${reason.slice(0,3500)}\n`+
    'Please regenerate a corrected, downloadable .patch or .zip containing exactly one Git patch against the source files already supplied. Do not assume anything was applied.';
  try {
    const reported=await chrome.tabs.sendMessage(state.tab_id,{type:'report-patch-error',
      payload:{provider:state.provider,conversation_id:state.conversation_id,text}});
    const report=reported?.result;
    if(!report?.confirmed)return {retried:false,extra:' | Automatic chatbot error report not confirmed; report manually.'};
    const watcher=await chrome.tabs.sendMessage(state.tab_id,{type:'monitor-assistant',payload:{
      provider:state.provider,conversation_id:state.conversation_id,delivery_id:id,
      started_at:report.submitted_at,before_count:report.before_count,before_text:report.before_text
    }});
    if(!watcher?.ok)return {retried:false,extra:' | Correction was requested, but the response monitor could not restart.'};
    return {retried:true,extra:' | Correction requested; monitoring next chatbot response.'};
  } catch(error){return {retried:false,extra:` | Error report or response watcher could not start: ${String(error).slice(0,400)}`};}
}
async function responseCompleted(data,sender){
  if (!(await settings()).enabled) return {status:'disabled'};
  const id=data?.delivery_id;
  if(typeof id!=='string'|| !/^[a-f0-9]{32}$/.test(id))throw Error('Invalid delivery ID.');
  const key=`patch-delivery:${id}`;
  const state=(await chrome.storage.local.get(key))[key];
  if(!state || sender.tab?.id!==state.tab_id ||
     sessionFromUrl(sender.tab.url||'')?.conversation_id!==state.conversation_id)throw Error('Response is not from the expected conversation tab.');
  if(!Number.isSafeInteger(data.response_ms)||data.response_ms<0||data.response_ms>86400000)throw Error('Invalid response time.');
  if(completedInFlight.has(id))return {status:'in-progress'};
  const existing=(await chrome.storage.local.get(`patch-finished:${id}`))[`patch-finished:${id}`];
  if(existing)return {status:'already-processed'};
  completedInFlight.add(id);
  const attemptKey=`patch-attempts:${id}`;
  const attempt=Number((await chrome.storage.local.get(attemptKey))[attemptKey]||0)+1;
  await chrome.storage.local.set({[attemptKey]:attempt});
  let retried=false;
  const result={delivery_id:id,response_ms:data.response_ms, status:'no_patch', details:''};
  try{
    const files=Array.isArray(data.files)?data.files:[];
    if(!files.length){
      result.details='Assistant response completed; no downloadable .patch, .diff, or .zip link was detected.';
      const retry=await sendPatchError(state,id,result.details,attempt);
      retried=retry.retried;result.details+=retry.extra;
      await recordPatchEvent(result);
      return result;
    }
    await recordPatchEvent({...result,status:'observed',details:`Assistant finished; ${files.length} patch link(s) detected.`});
    const candidate=files.find(f=>/\.(?:zip|patch|diff)(?:$|[?#])/i.test(f.url||''))||files[0];
    let filename='';
    try{
      filename=await downloadPatch(candidate,state.tab_id,id);
      let applied;
      try {
        applied=await chrome.runtime.sendNativeMessage('com.prompt_helper.patch_runner',
          {action:'apply_patch',repo_path:state.repo_path,download_path:filename, symbol_mapping:state.symbol_registry||null});
      }catch(error){throw Error('Native Git helper unavailable or failed: '+String(error));}
      if(applied?.ok){
        result.status='applied';result.details=`Applied ${applied.filename} to ${state.repo_path}`;
      }else{
        result.status='apply_failed';result.details=`${applied?.stage||'native host'}: ${applied?.output||applied?.error||'unknown error'}`;
      }
    }catch(error){
      result.status=filename?'apply_failed':'download_failed';result.details=String(error.message||error);
    }
    await recordPatchEvent({...result,filename:filename.split('/').at(-1)||''});
    if(result.status!=='applied'){
      const retry=await sendPatchError(state,id,result.details,attempt);
      retried=retry.retried;
      result.details+=retry.extra;
      await recordPatchEvent({...result,filename:filename.split('/').at(-1)||''});
    }
    return result;
  } finally {
    if(!retried)await chrome.storage.local.set({[`patch-finished:${id}`]:true});
    completedInFlight.delete(id);
  }
}
function waitDownload(id,timeout=120000){
  return new Promise((resolve,reject)=>{
    let timer;
    function detach(){clearTimeout(timer);chrome.downloads.onChanged.removeListener(listener)}
    function listener(delta){
      if(delta.id!==id)return;
      if(delta.state?.current==='complete'){detach();resolve(id)}
      else if(delta.state?.current==='interrupted'){detach();reject(Error('Browser download was interrupted'))}
    }
    chrome.downloads.onChanged.addListener(listener);
    chrome.downloads.search({id}).then(items=>{
      if(items[0]?.state==='complete'){detach();resolve(id)}
    }).catch(()=>{});
    timer=setTimeout(()=>{detach();reject(Error('Timed out downloading the generated patch'))},timeout);
  });
}
async function downloadPatch(candidate,tab_id,id){
  const href=candidate?.url;
  if(typeof href!=='string'||!(/^(https:\/\/|sandbox:)/.test(href)))throw Error('Unsupported patch link.');
  let downloadId;
  if(href.startsWith('https://')){
    try {
      downloadId=await chrome.downloads.download({url:href,conflictAction:'uniquify',saveAs:false});
    }catch{} // Authenticated/sandbox links may need an in-page click.
  }
  if(!Number.isInteger(downloadId)){
    // Correlate the next *matching filename* that was created by clicking the
    // assistant's attachment; never apply unrelated background downloads.
    const created=new Promise((resolve,reject)=>{
      let timer;
      const handler=item=>{
        if(item.tabId!==tab_id)return;
        if(!/\.(?:zip|diff|patch)(?:$|[?#])/i.test(item.filename||item.url||''))return;
        cleanup();resolve(item.id);
      };
      function cleanup(){clearTimeout(timer);chrome.downloads.onCreated.removeListener(handler)}
      chrome.downloads.onCreated.addListener(handler);
      timer=setTimeout(()=>{cleanup();reject(Error('No matching patch download started from the assistant attachment'))},20000);
    });
    const clicked=await chrome.tabs.sendMessage(tab_id,{type:'click-assistant-patch',url:href});
    if(!clicked?.ok)throw Error(clicked?.error||'Could not click the assistant attachment');
    downloadId=await created;
  }
  await waitDownload(downloadId);
  const items=await chrome.downloads.search({id:downloadId});
  const item=items[0];
  if(item?.state!=='complete'||!/\.(?:zip|patch|diff)$/i.test(item.filename||''))throw Error('Downloaded attachment is not a patch or ZIP');
  return item.filename;
}

// Rebuilds update a stable folder; watch the build marker to reload in Chrome.
watchBuilds();

// Static manifest scripts attach automatically on new loads, but Chrome does
// not inject them retroactively into pages that were open during installation.
const activation = new Map();
const CHAT_FILES = ['content.js','delivery-content.js','response-monitor.js','session-media-upload.js'];
async function activateExistingTab(tab) {
  if (!tab || !Number.isInteger(tab.id) || !sessionFromUrl(tab.url || '')) return false;
  if (activation.has(tab.id)) return activation.get(tab.id);
  const operation = (async () => {
    try {
      const ready = await chrome.tabs.sendMessage(tab.id,{type:'prompt-helper-content-ready'}).catch(()=>null);
      if (ready?.ready) return true;
      await chrome.scripting.executeScript({target:{tabId:tab.id},files:CHAT_FILES});
      return true;
    } catch (error) {
      console.debug('prompt-helper: cannot activate tab', tab.id, error);
      return false;
    } finally { activation.delete(tab.id); }
  })();
  activation.set(tab.id,operation);
  return operation;
}
async function activateOpenConversations() {
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(tabs.map(tab=>activateExistingTab(tab)));
}
chrome.runtime.onInstalled.addListener(()=>void activateOpenConversations());
chrome.runtime.onStartup.addListener(()=>void activateOpenConversations());
// The action popup can request activation on demand if Chrome missed startup.
chrome.tabs.onUpdated.addListener((tabId,changed,tab)=>{
  if (changed.status==='complete' && sessionFromUrl(tab.url || '')) void activateExistingTab(tab);
});
void activateOpenConversations();
