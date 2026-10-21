// Path: frontend/src/session-dashboard.ts
// The large source is streamed to the local upload writer; only the prepared
// diff is forwarded to the selected Chrome conversation. Session baselines
// advance only after verified submission or explicit user acknowledgement.
import { getEncoding } from 'js-tiktoken';
import { countTokens as countClaudeLegacy } from '@anthropic-ai/tokenizer';
import { apiFetchJSON } from './api.js';
import { compressGitDiff, normalizeGitDiffPaths } from './symbol-compression.js';

type Provider = 'chatgpt' | 'claude';
type Session = { provider: Provider; conversation_id: string; tab_id: number; title: string };
type FileStatus = { path:string; version:number; status:string; sha256:string };
type Preview = { changed:number; total:number; llm_diff:string; unified_diff:string; files:FileStatus[] };
type Prepared = { delivery_id:string; provider:Provider; conversation_id:string; preview:Preview };
const el = <T extends HTMLElement>(id:string) => document.getElementById(id) as T;
const provider = el<HTMLSelectElement>('session-provider');
const chooser = el<HTMLSelectElement>('session-existing');
const source = el<HTMLTextAreaElement>('source');
const upload = el<HTMLInputElement>('source-file');
const prepare = el<HTMLButtonElement>('submit');
const dispatch = el<HTMLButtonElement>('send-session');
const manuallyConfirm = el<HTMLButtonElement>('confirm-session');
const message = el<HTMLElement>('session-message');
const tokenInfo = el<HTMLElement>('token-estimate');
const browserInfo = el<HTMLElement>('browser-status');
const filesInfo = el<HTMLElement>('session-files');
const userPrompt=el<HTMLTextAreaElement>('user-prompt');
const targetRepo=el<HTMLInputElement>('target-repo');
const metrics=el<HTMLElement>('response-metrics');
const symbolToggle=el<HTMLInputElement>('symbol-compression');
const symbolInfo=el<HTMLElement>('symbol-compression-info');
let compressedGitDiff='';
let symbolRegistry:Record<string,Record<string,string>>={};
targetRepo.value=localStorage.getItem('prompt-helper-target-repo')||'';
targetRepo.addEventListener('change',()=>localStorage.setItem('prompt-helper-target-repo',targetRepo.value.trim()));
let sessions:Session[] = [];
let staged:Prepared | null = null;
let estimate: { diff_tokens:number; original_tokens:number; estimator:string } | null = null;
const pending = new Map<string,{resolve:(r:any)=>void;reject:(e:Error)=>void}>();

window.addEventListener('message',event=>{
  if (event.source !== window || event.origin !== location.origin || event.data?.channel !== 'prompt-helper-extension') return;
  const waiter = pending.get(event.data.id);
  if (!waiter) return;
  pending.delete(event.data.id);
  if (event.data.ok) waiter.resolve(event.data.result);
  else waiter.reject(Error(event.data.error || 'Chrome extension operation failed'));
});
function bridge(type:string, payload:Record<string,unknown>={}):Promise<any>{
  const id=crypto.randomUUID();
  return new Promise((resolve,reject)=>{
    pending.set(id,{resolve,reject});
    window.postMessage({channel:'prompt-helper-dashboard',id,type,payload},location.origin);
    setTimeout(()=>{if(pending.delete(id)) reject(Error('Chrome extension did not respond. Load the unpacked extension from plugins/chrome.'));},type==='deliver-session'?150000:10000);
  });
}
function show(text:string, error=false){message.textContent=text;message.style.color=error?'#ff9797':'';}
function selected():Session | undefined {return sessions.find(s=>String(s.tab_id)===chooser.value && s.provider===provider.value);}
function invalidate(){staged=null;estimate=null;compressedGitDiff='';symbolRegistry={};dispatch.disabled=true;manuallyConfirm.hidden=true;tokenInfo.textContent='Prepare a file to calculate estimated input tokens before sending.';}
function options() {
  const previous=chooser.value;
  chooser.replaceChildren();
  const filtered=sessions.filter(s=>s.provider===provider.value);
  if(!filtered.length){const option=new Option('No open saved conversations — open one first','');chooser.add(option);}
  for(const s of filtered)chooser.add(new Option(`${s.title||s.provider} · ${s.conversation_id.slice(0,16)} · tab ${s.tab_id}`,String(s.tab_id)));
  if(filtered.some(s=>String(s.tab_id)===previous))chooser.value=previous;
  invalidate();
  void loadHistory();
  void refreshSymbolSettings();
}
async function refresh(){
  try{
    const out=await bridge('list-sessions');sessions=out.sessions||[];
    browserInfo.textContent=`${sessions.length} open saved conversation tab(s) detected in Chrome`;
    options();
  }catch(error){browserInfo.textContent='Chrome extension unavailable';show(String(error),true);}
}
provider.addEventListener('change',options);
chooser.addEventListener('change',()=>{invalidate();void loadHistory();});
source.addEventListener('input',invalidate);
userPrompt.addEventListener('input',invalidate);
targetRepo.addEventListener('input',invalidate);
symbolToggle.addEventListener('change',async()=>{
  const wanted=symbolToggle.checked;invalidate();
  try { await bridge('set-symbol-compression',{enabled:wanted});
    symbolInfo.textContent=wanted?'Enabled: compress supported identifiers in Git diffs; reverse aliases before applying patches.':'Disabled: original Git diffs are sent.';
  } catch(error){symbolToggle.checked=!wanted;show(String(error),true);}
});
async function refreshSymbolSettings(){
  const s=selected();if(!s)return;
  try {const result=await bridge('symbol-settings',{provider:s.provider,conversation_id:s.conversation_id});
    symbolToggle.checked=Boolean(result.enabled);symbolInfo.textContent=result.enabled?'Enabled: dialect-aware aliases persist per conversation and file.':'Disabled: send original code without symbol aliases.';
  }catch(error){symbolInfo.textContent='Extension compression state unavailable: '+String(error);}
}
upload.addEventListener('change',()=>{invalidate();show(upload.files?.[0]?`Selected ${upload.files[0].name} (${upload.files[0].size.toLocaleString()} bytes)`:'');});
el<HTMLButtonElement>('refresh-sessions').addEventListener('click',()=>void refresh());
el<HTMLButtonElement>('open-session').addEventListener('click',async()=>{
  try{const out=await bridge('open-provider',{provider:provider.value});show(out.note);}
  catch(error){show(String(error),true);}
});

let tokenizer:ReturnType<typeof getEncoding> | undefined;
function tokenCount(text:string,p:Provider):number{
  if(p==='chatgpt') { tokenizer ||= getEncoding('o200k_base');return tokenizer.encode(text).length; }
  return countClaudeLegacy(text); // Anthropic's public legacy tokenizer is NOT accurate for modern Claude.
}
async function loadHistory(){
  const s=selected();filesInfo.replaceChildren();
  if(!s){filesInfo.textContent='Select an open saved conversation to view its sent files.';return;}
  try{
    const data:any=await apiFetchJSON('/api/v1/chat-sessions/sent-files?'+new URLSearchParams({provider:s.provider,conversation_id:s.conversation_id}));
    if(!data.sent_files.length){filesInfo.textContent='No confirmed source-file deliveries recorded for this conversation.';return;}
    const latest=data.sent_files[0];
    if(latest)metrics.textContent=`Response time: ${latest.response_ms==null?'pending':(latest.response_ms/1000).toFixed(2)+'s'} · Patch: ${latest.patch_status||'pending'}${latest.patch_details?' · '+latest.patch_details.slice(0,600):''}`;
    const summary=document.createElement('p');
    summary.textContent=`${data.usage?.deliveries ?? 0} confirmed deliveries · ${(data.usage?.estimated_diff_tokens ?? 0).toLocaleString()} estimated tokens sent · ${(data.usage?.estimated_original_tokens ?? 0).toLocaleString()} estimated tokens without diffing`;
    filesInfo.append(summary);
    const list=document.createElement('ul');
    for(const file of data.sent_files.slice(0,100)){
      const li=document.createElement('li');
      li.textContent=`${file.path} · v${file.version} · ${file.sha256.slice(0,10)} · ${file.diff_tokens ?? '?'} estimated diff tokens · response ${file.response_ms==null?'pending':(file.response_ms/1000).toFixed(2)+'s'} · patch ${file.patch_status||'pending'} · ${new Date(file.sent_at).toLocaleString()}`;
      list.append(li);
    }
    filesInfo.append(list);
  }catch(error){filesInfo.textContent=`Could not load sent files: ${error}`;}
}

async function stage(){
  if(!userPrompt.value.trim()){show('The user instruction prompt is required before preparing or sending a diff.',true);userPrompt.focus();return;}
  if(!targetRepo.value.trim().startsWith('/')){show('Enter the absolute root path of the local target Git repository.',true);targetRepo.focus();return;}
  const target=selected();if(!target){show('Select a saved conversation tab. Open Session creates a browser tab; start a conversation there first.',true);return;}
  const file=upload.files?.[0];
  if(!file && !source.value.trim()){show('Select a UTF-8 source dump or paste one into the file input.',true);return;}
  prepare.disabled=true;dispatch.disabled=true;invalidate();
  try{
    show('Uploading local source and preparing a session-specific diff…');
    const body:BodyInit=file||source.value;
    const uploadResponse=await fetch('/upload/file',{method:'POST',headers:{'Content-Type':'text/plain; charset=utf-8'},body});
    const uploaded=await uploadResponse.json();
    if(!uploadResponse.ok)throw Error(uploaded.error||`Upload HTTP ${uploadResponse.status}`);
    const prepared:any=await apiFetchJSON('/api/v1/chat-sessions/prepare',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({provider:target.provider,conversation_id:target.conversation_id,filename:uploaded.filename,user_prompt:userPrompt.value.trim()})});
    staged=prepared as Prepared;
    el<HTMLElement>('result-status').textContent=`Prepared for ${target.provider}`;
    el<HTMLElement>('result-version').textContent=`${prepared.preview.total} files`;
    el<HTMLElement>('result-count').textContent=`${prepared.preview.changed} changed`;
    el<HTMLElement>('result-path').textContent=`${target.conversation_id} · ${prepared.preview.files.map((f:FileStatus)=>f.path).join(', ')}`;
    const diff=el<HTMLElement>('diff');diff.style.whiteSpace='pre-wrap';
    // Local preflight: the full file is only used in-memory for estimating
    // savings, not posted to the LLM or embedded in an external message.
    show('Calculating local tokenizer estimates before sending…');
    const original=file?await file.text():source.value;
    const active=Boolean(symbolToggle.checked);
    const state=active?await bridge('symbol-settings',{provider:target.provider,conversation_id:target.conversation_id}):null;
    if(active&&!state.enabled)throw Error('Extension compression setting changed; refresh and prepare again.');
    const gitDiff=active?normalizeGitDiffPaths(prepared.preview.unified_diff||'',prepared.preview.files,targetRepo.value.trim()):'';
    if(active&&!gitDiff)throw Error('No Git diff is available to compress.');
    const packed=active?compressGitDiff(gitDiff,state.registry||{},s=>tokenCount(s,target.provider),original):null;
    symbolRegistry=packed?.registry||{};
    compressedGitDiff=packed?.diff||'';
    diff.textContent=active?compressedGitDiff:prepared.preview.llm_diff;
    if(active)symbolInfo.textContent=`${packed!.aliases} stored symbol mappings · ${packed!.savedTokens} estimated Git-diff tokens saved · ${packed!.active?'compressed':'no eligible token savings; sending original Git diff'}`;
    const instructions=active?'The diff uses temporary local aliases for eligible private symbols. Preserve aliases when editing; the local patch runner restores their original names before git apply. Never rename external APIs, exports or public symbols.\n\n':'';
    const postscript=`\n\n${instructions}Return an applicable Git patch as one downloadable .patch or .zip file, and give the git apply command. Do not require any other shell commands to apply it.`;
    const composed=`USER REQUEST\n${userPrompt.value.trim()}\n\n${active?'SYMBOL-COMPRESSED GIT DIFF':'SOURCE CHANGES'}\n${active?compressedGitDiff:prepared.preview.llm_diff}${postscript}`;
    const diff_tokens=tokenCount(composed,target.provider);
    const original_tokens=tokenCount(`USER REQUEST\n${userPrompt.value.trim()}\n\nSOURCE CHANGES\n${original}${postscript}`,target.provider);
    const estimator=target.provider==='chatgpt'?'js-tiktoken/o200k_base (estimated)':'@anthropic-ai/tokenizer/legacy (rough; modern Claude differs)';
    estimate={diff_tokens,original_tokens,estimator};
    // Store the estimate while still in the prepared (unsent) state.
    await apiFetchJSON('/api/v1/chat-sessions/delivery/estimate',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({delivery_id:staged.delivery_id,...estimate})});
    const savings=original_tokens?Math.max(-999,Math.min(100,(1-diff_tokens/original_tokens)*100)):0;
    tokenInfo.textContent=`${diff_tokens.toLocaleString()} estimated diff tokens · ${original_tokens.toLocaleString()} estimated original tokens · ${savings.toFixed(1)}% token savings · ${estimator}`;
    dispatch.disabled=prepared.preview.changed===0;
    show(prepared.preview.changed?`Ready: ${prepared.preview.changed} changed file(s). Review tokens, then Send to session.`:'Unchanged: nothing to send to this session.');
  }catch(error){invalidate();show(String(error),true);}finally{prepare.disabled=false;}
}
prepare.addEventListener('click',event=>{event.preventDefault();event.stopImmediatePropagation();void stage();},true);
source.addEventListener('keydown',event=>{if((event.metaKey||event.ctrlKey)&&event.key==='Enter'){event.preventDefault();event.stopImmediatePropagation();void stage();}},true);
async function confirm(){
  if(!staged||!estimate)return;
  const data:any=await apiFetchJSON('/api/v1/chat-sessions/delivery',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({delivery_id:staged.delivery_id,...estimate})});
  show(`Confirmed: ${data.changed??staged.preview.changed} file(s) recorded as sent · ${estimate.diff_tokens} estimated input tokens.`);
  manuallyConfirm.hidden=true;dispatch.disabled=true;
  userPrompt.value='';
  try{await bridge('commit-symbol-registry',{delivery_id:staged.delivery_id});}catch(error){show('Sent, but could not save compression aliases: '+String(error),true);}
  void loadHistory();
}
dispatch.addEventListener('click',async()=>{
  if(!staged||!estimate)return;
  const target=selected();
  if(!target||target.provider!==staged.provider||target.conversation_id!==staged.conversation_id){show('Session changed. Prepare the diff again.',true);invalidate();return;}
  if(!userPrompt.value.trim()){show('A user instruction prompt is required.',true);return;}
  dispatch.disabled=true;show('Sending user instructions plus prepared diff to the selected browser conversation…');
  try{
    const response=await bridge('deliver-session',{delivery_id:staged.delivery_id,tab_id:target.tab_id,repo_path:targetRepo.value.trim(),...estimate, compression_enabled:symbolToggle.checked, compressed_diff:compressedGitDiff, symbol_registry:symbolRegistry});
    if(response.status==='sent'){
      show(`Submitted: ${staged.preview.changed} changed files · ${estimate.diff_tokens} estimated input tokens. Tracking chatbot response and patch application.`);
      userPrompt.value=''; // Clear ONLY after verified submission.
      metrics.textContent='Response in progress · Patch pending';
      void loadHistory();
    }
    else{show(response.reason+' If you verify that the diff appears as a sent user message, use Confirm sent.',true);manuallyConfirm.hidden=false;}
  }catch(error){show(String(error)+' Do not retry if the message may have been submitted.',true);manuallyConfirm.hidden=false;}
});
manuallyConfirm.addEventListener('click',async()=>{
  if(!window.confirm('Have you verified that this exact diff was submitted in the selected conversation? This advances its file baseline.'))return;
  try{await confirm();}catch(error){show(String(error),true);}
});
void refresh();

// Refresh response time and apply errors as the Chrome watcher records them.
setInterval(()=>{if(selected())void loadHistory()},8000);
