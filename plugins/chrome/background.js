// Path: plugins/chrome/background.js
import { sessionFromUrl, localBaseUrl } from './session.js';
import { expandGitDiff, normalizeGitDiffPaths } from './symbol-compression.js';
import { watchBuilds } from './build-watch.js';
import { IS_LOCAL, CONFIGURED_ENDPOINT } from './runtime-config.js';
import { compactGrid, layoutOverlaps } from './session-layout.js';
import { planSessionWindows } from './session-arrangement.js';
import { browserConversation, openConversations, dashboardGeometry } from './open-sessions.js';

const DEFAULTS = { enabled: true, minChars: 1000, replaceOnPaste: true, symbolCompression: false,
  aggregateSessionMedia: false, sessionMediaFolder: '' };

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

// This extension never reads a ChatGPT/Claude composer or assistant message.
// Work is prepared in our own extension window and manually sent by the user.
async function api(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 125000);
  try {
    const response = await fetch(configuredEndpoint() + path, { ...options, signal: controller.signal, cache: 'no-store' });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw Error(body?.error || `prompt-helper returned HTTP ${response.status}`);
    return body;
  } finally { clearTimeout(timeout); }
}
function badge(tabId, text, color) {
  if (!Number.isInteger(tabId)) return;
  chrome.action.setBadgeText({tabId,text}).catch(()=>{});
  chrome.action.setBadgeBackgroundColor({tabId,color}).catch(()=>{});
}
const previewKey = (provider,id) => `manual-preview:${provider}:${id}`;
async function storedPreview(provider,id) {
  return (await chrome.storage.local.get(previewKey(provider,id)))[previewKey(provider,id)] || null;
}
async function sessionStatuses(sessions) {
  return Promise.all(sessions.map(async session => {
    if (session.unsaved || !session.conversation_id) return {...session,manual_status:'none'};
    const record = await storedPreview(session.provider,session.conversation_id);
    return {...session,manual_status:record?.status || 'none', patch_url:record?.patch_url || ''};
  }));
}
async function openSessionPreview(provider,conversation_id,tab_id) {
  if (!validSymbolIdentity(provider,conversation_id)) throw Error('A saved conversation is required.');
  if (Number.isInteger(tab_id)) {
    const tab=await chrome.tabs.get(tab_id);
    const selected=sessionFromUrl(tab.url || '');
    if (selected?.provider!==provider || selected?.conversation_id!==conversation_id) throw Error('Session changed; refresh sessions.');
  }
  const url=chrome.runtime.getURL('session-preview.html')+'?'+new URLSearchParams({provider,conversation_id});
  const created=await chrome.windows.create({url,type:'popup',width:620,height:670,focused:true});
  return {window_id:created.id,status:'opened'};
}
async function previewDetails(provider,id) {
  if (!validSymbolIdentity(provider,id)) throw Error('Invalid session identity.');
  const record=await storedPreview(provider,id);
  if (!record?.delivery_id) return {status:'none',provider,conversation_id:id};
  const stage=await api('/api/v1/chat-sessions/delivery?'+new URLSearchParams({delivery_id:record.delivery_id}));
  if (stage.provider!==provider || stage.conversation_id!==id) throw Error('Prepared delivery belongs to a different conversation.');
  const transient=await chrome.storage.session?.get(`preview-compression:${record.delivery_id}`).catch(()=>({})) || {};
  const compressed=transient[`preview-compression:${record.delivery_id}`];
  const useCompression=Boolean(record.compression_enabled && compressed?.diff && compressed?.registry);
  const diff=useCompression?compressed.diff:stage.llm_diff;
  const prompt=`USER REQUEST\n${stage.user_prompt}\n\n${useCompression?'SYMBOL-COMPRESSED GIT DIFF':'SOURCE CHANGES'}\n${diff}\n\n`+
    (useCompression?'The diff uses temporary local aliases for eligible private symbols. Preserve aliases when editing; the local patch runner restores their original names before git apply. Never rename external APIs, exports or public symbols.\n\n':'')+
    'Return an applicable Git patch as one downloadable .patch or .zip file, and give the git apply command. Do not require any other shell commands to apply it.';
  return {status:record.status,provider,conversation_id:id,delivery_id:record.delivery_id,
    prompt, patch_url:record.patch_url || '',compressed:useCompression,requires_reprepare:Boolean(record.compression_enabled&&!useCompression),
    tab_id:record.tab_id, staged_status:stage.status, repo_path:record.repo_path};
}
async function markManualSent(provider,id) {
  const record=await storedPreview(provider,id);
  if (!record?.delivery_id) throw Error('No prepared prompt in this session.');
  if (record.status==='responded' || record.status==='sent') return {status:record.status};
  if (record.status!=='ready') throw Error('Prompt must be prepared first.');
  const ack=await api('/api/v1/chat-sessions/delivery',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({delivery_id:record.delivery_id,diff_tokens:record.diff_tokens,
      original_tokens:record.original_tokens,estimator:record.estimator})});
  if (record.compression_enabled) {
    const stored=await chrome.storage.session?.get(`preview-compression:${record.delivery_id}`).catch(()=>({}));
    const mapping=stored?.[`preview-compression:${record.delivery_id}`]?.registry;
    if (mapping) await chrome.storage.local.set({[`symbol-registry:${provider}:${id}`]:mapping});
  }
  record.status='sent';
  await chrome.storage.local.set({[previewKey(provider,id)]:record});
  badge(record.tab_id,'!','#b88631');
  return {status:'sent',acknowledgment:ack.status};
}
async function markManualResponded(provider,id,patch_url) {
  const record=await storedPreview(provider,id);
  if (!record || !['sent','responded'].includes(record.status)) throw Error('First confirm that you manually sent the prompt.');
  const url=String(patch_url||'').trim();
  if (url) {
    let parsed;
    try {parsed=new URL(url);}catch {throw Error('Paste an HTTPS download link, not a ChatGPT sandbox path.');}
    if(parsed.protocol!=='https:' || parsed.username || parsed.password) throw Error('Only user-supplied HTTPS links are supported.');
    if(url.length>8192) throw Error('Link is too long.');
  }
  record.status='responded';record.patch_url=url;
  await chrome.storage.local.set({[previewKey(provider,id)]:record});
  badge(record.tab_id,'!','#278063');
  return {status:'responded',patch_url:url};
}
async function manualPreviewMessage(message,sender) {
  const url=sender?.url || '';
  if (!url.startsWith(chrome.runtime.getURL('session-preview.html'))) throw Error('Only the extension prompt preview can request these actions.');
  const provider=message.provider, id=message.conversation_id;
  if (!validSymbolIdentity(provider,id)) throw Error('Invalid conversation.');
  if(message.type==='get-session-preview') return previewDetails(provider,id);
  if(message.type==='mark-manual-sent') return markManualSent(provider,id);
  if(message.type==='mark-manual-responded') return markManualResponded(provider,id,message.patch_url);
  if(message.type==='focus-preview-chat') {
    const tabs=await chrome.tabs.query({});
    const tab=tabs.find(t=>{const p=sessionFromUrl(t.url||'');return p?.provider===provider&&p?.conversation_id===id});
    if (!tab) throw Error('Conversation tab is no longer open.');
    await chrome.tabs.update(tab.id,{active:true});
    await chrome.windows.update(tab.windowId,{focused:true});
    return {focused:true};
  }
  throw Error('Unknown preview action.');
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case 'list-sessions':
      case 'open-provider':
      case 'deliver-session':
      case 'symbol-settings':
      case 'set-symbol-compression':
      case 'commit-symbol-registry': return dashboardRequest(message, sender);
      case 'get-session-preview':
      case 'mark-manual-sent':
      case 'mark-manual-responded':
      case 'focus-preview-chat': return manualPreviewMessage(message,sender);
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
      case 'get-open-sessions': return requireExtensionUI(sender).then(async () => ({ sessions: await sessionStatuses(await listBrowserSessions()), config: await settings() }));
      case 'open-session-preview': return requireExtensionUI(sender).then(() => openSessionPreview(message.provider,message.conversation_id,message.tab_id));
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
  const sessions = openConversations(windows,tabs);
  // Titles are read only from Chrome's tab metadata, not the provider page DOM.
  return sessions;
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
// Dashboard preparation creates an extension-owned preview window. It NEVER
// inserts text, presses Send, scrapes response content, downloads, or applies patches.
const deliveriesInFlight = new Set();
async function deliverToConversation(payload) {
  if (!(await settings()).enabled) throw Error('prompt-helper is turned off.');
  const {delivery_id,tab_id,diff_tokens,original_tokens,estimator,repo_path,compressed_diff,symbol_registry,compression_enabled}=payload||{};
  if(typeof delivery_id!=='string'||!/^[a-f0-9]{32}$/.test(delivery_id)) throw Error('Invalid prepared delivery ID.');
  if(!Number.isInteger(tab_id)||!Number.isSafeInteger(diff_tokens)||diff_tokens<0||!Number.isSafeInteger(original_tokens)||original_tokens<0||
    typeof estimator!=='string'||!estimator||estimator.length>120) throw Error('Token estimate must be saved before preparing a handoff.');
  if(typeof repo_path!=='string'||!repo_path.startsWith('/')||repo_path.length>4096||repo_path.includes('\0')) throw Error('An absolute local repository path is required.');
  if(deliveriesInFlight.has(delivery_id)) throw Error('Preparation is already in progress.');
  deliveriesInFlight.add(delivery_id);
  try {
    const staged=await api('/api/v1/chat-sessions/delivery?'+new URLSearchParams({delivery_id}));
    if(!['prepared','sent'].includes(staged.status)) throw Error('Delivery is not prepared.');
    if(staged.diff_tokens!==diff_tokens||staged.original_tokens!==original_tokens||staged.estimator!==estimator) throw Error('Saved token estimates do not match.');
    if(!staged.files.some(f=>f.status!=='unchanged')) throw Error('There are no changed files.');
    if(!staged.user_prompt?.trim()) throw Error('A user instruction is required.');
    const tab=await chrome.tabs.get(tab_id), identity=sessionFromUrl(tab.url||'');
    if(identity?.provider!==staged.provider||identity?.conversation_id!==staged.conversation_id)throw Error('Conversation identity changed.');
    const config=await settings();
    if(Boolean(compression_enabled)!==Boolean(config.symbolCompression))throw Error('Compression setting changed. Prepare again.');
    if(compression_enabled){
      if(typeof compressed_diff!=='string'||!compressed_diff||!symbol_registry||typeof symbol_registry!=='object'||!staged.git_diff)throw Error('Compressed diff and symbol registry required.');
      const registryKey=`symbol-registry:${staged.provider}:${staged.conversation_id}`;
      const prior=(await chrome.storage.local.get(registryKey))[registryKey]||{};
      for(const [path,names] of Object.entries(prior))for(const [word,alias] of Object.entries(names||{})){
        if(symbol_registry[path]?.[word]!==alias)throw Error('A persistent symbol alias changed.');
      }
      const original=normalizeGitDiffPaths(staged.git_diff,staged.files,repo_path);
      if(expandGitDiff(compressed_diff,symbol_registry)!==original)throw Error('Compressed diff does not reconstruct source.');
      await chrome.storage.session?.set({[`preview-compression:${delivery_id}`]:{diff:compressed_diff,registry:symbol_registry}});
    }
    const key=previewKey(staged.provider,staged.conversation_id);
    await chrome.storage.local.set({[key]:{delivery_id,tab_id,repo_path,diff_tokens,original_tokens,estimator,
      compression_enabled:Boolean(compression_enabled),status:staged.status==='sent'?'sent':'ready',patch_url:''}});
    badge(tab_id,'!',staged.status==='sent'?'#b88631':'#5985c8');
    const win=await openSessionPreview(staged.provider,staged.conversation_id,tab_id);
    return {status:'unconfirmed',manual:true,window_id:win.window_id,
      reason:'Prepared for manual copy and manual sending. Nothing was submitted to ChatGPT.'};
  } finally {deliveriesInFlight.delete(delivery_id);}
}

async function dashboardRequest(message, sender) {
  await fromDashboard(sender);
  if (message.type === 'list-sessions') return { sessions: await sessionStatuses(await listBrowserSessions()) };
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

// No provider content-script injection, response watching, download, automatic
// Git application, or corrective prompt generation is registered in this build.
watchBuilds();
