// Path: plugins/chrome/response-monitor.js
// Watch the assistant's post-submission message for completion, without
// treating an idle text-only response or ongoing stream as a patch file.
(() => {
  if (globalThis.__promptHelperMonitorActive) return;
  globalThis.__promptHelperMonitorActive = true;
  const assistantSelectors = {
    chatgpt: '[data-message-author-role="assistant"]',
    claude: '[data-testid="assistant-message"], [data-testid="message-content"].font-claude-message, .font-claude-message'
  };
  const stopped = {
    chatgpt: 'button[data-testid="stop-button"],button[aria-label*="Stop generating"],button[aria-label="Stop streaming"]',
    claude: 'button[aria-label*="Stop response"],button[aria-label*="Stop generating"],button[data-testid="stop-button"]'
  };
  let watch = null;
  let interval = null;
  function matches(provider,id) {
    try {
      const host = location.hostname;
      return (provider === 'chatgpt' && ['chatgpt.com','chat.openai.com'].includes(host) || provider === 'claude' && host === 'claude.ai') &&
        location.pathname.split('/').includes(id);
    } catch { return false; }
  }
  function nodes(provider) { return [...document.querySelectorAll(assistantSelectors[provider] || 'never')]; }
  function attachments(node) {
    return [...node.querySelectorAll('a[href]')].map(a=>({url:a.href, label:(a.innerText||a.getAttribute('download')||'').trim().slice(0,160)}))
      .filter(a=> /\.(?:zip|patch|diff)(?:$|[?#])/i.test(a.url)|| /\b(download|patch|\.zip|\.diff)\b/i.test(a.label))
      .filter(a=> /^(https?:|sandbox:)/.test(a.url)).slice(0,8);
  }
  function stop() { if(interval)clearInterval(interval);interval=null;watch=null; }
  async function tick() {
    const w=watch;if(!w)return;
    if(!matches(w.provider,w.conversation_id)){stop();return;}
    if(Date.now()-w.started_at>30*60*1000){
      stop();chrome.runtime.sendMessage({type:'assistant-response-timeout',delivery_id:w.delivery_id});return;
    }
    const candidates=nodes(w.provider);
    const latest=candidates.at(-1);
    const output=(latest?.innerText||'').trim();
    if(!latest || (candidates.length<=w.before_count && output===w.before_text) || !output) return;
    const signature=output.length+':'+output.slice(-500);
    if(signature!==w.last_signature){w.last_signature=signature;w.last_change=Date.now();return;}
    if(document.querySelector(stopped[w.provider]))return;
    if(Date.now()-w.last_change<5000 || Date.now()-w.started_at<5500)return;
    const completed=Date.now();
    const files=attachments(latest);
    const ms=completed-w.started_at;
    stop();
    chrome.runtime.sendMessage({type:'assistant-response-complete',payload:{delivery_id:w.delivery_id,
      response_ms:ms,files}});
  }
  function start(payload) {
    stop();
    if(!matches(payload.provider,payload.conversation_id))throw Error('Response monitor conversation changed');
    const existing=nodes(payload.provider);
    watch={...payload,before_count:Number.isInteger(payload.before_count)?payload.before_count:existing.length,before_text:typeof payload.before_text==='string'?payload.before_text:(existing.at(-1)?.innerText||''),
      last_signature:'',last_change:Date.now()};
    interval=setInterval(()=>void tick(),900);
    return {watching:true};
  }
  document.addEventListener('prompt-helper:start-response-monitor',event=>{
    const data=event.detail;
    if(data?.delivery_id)try{start(data)}catch{}
  });
  chrome.runtime.onMessage.addListener((msg,_sender,respond)=>{
    if(msg?.type==='click-assistant-patch') {
      const url=msg.url;
      const provider=location.hostname==='claude.ai'?'claude':'chatgpt';
      const latest=nodes(provider).at(-1);
      const link=latest && [...latest.querySelectorAll('a[href]')].find(a=>a.href===url);
      if(!link)return respond({ok:false,error:'Patch link no longer exists in the latest assistant reply'});
      link.click();respond({ok:true});return;
    }
    if(msg?.type!=='monitor-assistant')return;
    try{respond({ok:true,result:start(msg.payload)});}catch(error){respond({ok:false,error:String(error)});}
  });
})();
