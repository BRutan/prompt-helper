// Path: plugins/chrome/session-preview.js
// Extension-owned window. It intentionally has NO access to provider page DOM.
(() => {
  const $=id=>document.getElementById(id);
  const params=new URLSearchParams(location.search);
  const provider=params.get('provider')||'';
  const conversation_id=params.get('conversation_id')||'';
  $('identity').textContent=`${provider==='chatgpt'?'ChatGPT':provider==='claude'?'Claude':'Unknown'} · ${conversation_id}`;
  let state='none';
  function request(type,more={}) {
    return new Promise((resolve,reject)=>chrome.runtime.sendMessage({type,provider,conversation_id,...more},r=>{
      if(chrome.runtime.lastError)reject(Error(chrome.runtime.lastError.message));
      else if(!r?.ok)reject(Error(r?.error||'Extension request failed'));
      else resolve(r.result);
    }));
  }
  function status(message){$('message').textContent=message;$('error').textContent='';}
  function fail(error){$('error').textContent=String(error?.message||error);}
  function update(data){
    state=data.status||'none';
    $('badge').textContent=state==='ready'?'! Prompt ready':state==='sent'?'! Awaiting response':state==='responded'?'! Responded':'No prompt';
    $('prompt').value=data.prompt||'';
    $('copy').disabled=!data.prompt||data.requires_reprepare;
    $('confirm').disabled=state!=='ready'||Boolean(data.requires_reprepare);
    $('responded').disabled=!['sent','responded'].includes(state);
    $('patch-url').disabled=!['sent','responded'].includes(state);
    if(data.patch_url)$('patch-url').value=data.patch_url;
    const a=$('download');
    a.style.display=(data.patch_url&&/^https:\/\//.test(data.patch_url))?'block':'none';
    if(a.style.display==='block')a.href=data.patch_url;
    else a.removeAttribute('href');
    if(data.requires_reprepare)status('Compressed prompt was lost when the browser restarted. Reprepare it in the dashboard; no prompt was sent.');
    else if(state==='none')status('No prompt prepared yet. Open the local dashboard to stage a source diff.');
    else if(state==='ready')status('Prompt is ready. Copy it and send it manually in your conversation.');
    else if(state==='sent')status('Manual send confirmed. Mark response received after reading the answer yourself.');
    else status('Response manually confirmed. You can open the link you supplied.');
  }
  async function refresh(){try{update(await request('get-session-preview'));}catch(error){fail(error);}}
  $('copy').addEventListener('click',async()=>{
    try{await navigator.clipboard.writeText($('prompt').value);status('Copied. Paste and send it yourself in ChatGPT/Claude.');}
    catch(error){$('prompt').select();fail('Clipboard unavailable. Text selected for manual copying: '+String(error));}
  });
  $('chat').addEventListener('click',()=>request('focus-preview-chat').catch(fail));
  $('confirm').addEventListener('click',async()=>{
    if(!confirm('Confirm that YOU have already pasted and sent the prepared prompt?'))return;
    try{await request('mark-manual-sent');await refresh();}catch(error){fail(error);}
  });
  $('responded').addEventListener('click',async()=>{
    if(!confirm('Confirm that YOU have read the assistant response? Nothing will be read from the chat automatically.'))return;
    try{await request('mark-manual-responded',{patch_url:$('patch-url').value.trim()});await refresh();}catch(error){fail(error);}
  });
  void refresh();
})();
