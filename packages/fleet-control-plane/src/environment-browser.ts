/** Ephemeral modal state only. Never persist a secret or replay a mutation. */
export const environmentBrowserScript = `
(() => {
  const dialog=document.getElementById("connection-dialog");
  if(!dialog)return;
  const content=document.getElementById("connection-content");
  const feedback=document.getElementById("connection-feedback");
  const list=document.getElementById("environment-list");
  const status=document.getElementById("environment-status");
  const retries=[...document.querySelectorAll("[data-retry]")];
  let active,opener,epoch=0,busy=false,polling=false,openedAt=Date.now();
  const announce=(message,error=false)=>{
    const target=dialog.open?feedback:status;
    target.setAttribute("role",error?"alert":"status");target.textContent=message;
    retries.forEach(el=>el.hidden=!error||(dialog.open&&!active));
  };
  const controls=()=>[...dialog.querySelectorAll('a[href],button,input,select,summary,textarea,[tabindex]')].filter(el=>!el.disabled&&el.tabIndex>=0&&el.getClientRects().length);
  function close(){
    epoch++;active=undefined;busy=false;content.replaceChildren();feedback.textContent="";
    dialog.close();(document.getElementById(opener?.id)||document.getElementById("add-environment"))?.focus();
    refreshList();
  }
  dialog.addEventListener("close",()=>{(document.getElementById(opener?.id)||document.getElementById("add-environment"))?.focus();});
  async function request(path,body){
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),10000);
    try{
      const response=await fetch(path,{method:body?"POST":"GET",cache:"no-store",credentials:"same-origin",signal:controller.signal,
        headers:body?{"Content-Type":"application/json","X-CSRF-Token":dialog.dataset.csrf}:{},
        ...(body?{body:JSON.stringify(body)}:{})});
      const data=await response.json();
      if(!response.ok)throw new Error(data.error||"Unable to load environments. Try again.");
      return data;
    }finally{clearTimeout(timeout);}
  }
  function updateRows(html){
    // Do not detach the focused row link during background refresh.
    const focused=document.activeElement?.id;
    list.innerHTML=html;
    if(focused?.startsWith("environment-")&&!dialog.open)document.getElementById(focused)?.focus();
  }
  async function refreshList(){try{const data=await request("/environments/state");updateRows(data.rows);}catch{if(!dialog.open)announce("Environments unavailable. Try again.",true);}}
  function install(data){
    active=data.environmentId;content.innerHTML=data.connection;updateRows(data.rows);
    content.querySelector("#connection-title")?.focus();feedback.textContent="";retries.forEach(el=>el.hidden=true);
  }
  document.addEventListener("click",async event=>{
    const target=event.target.closest("[data-add],[data-connect],[data-close],[data-copy],[data-retry]");
    if(!target)return;event.preventDefault();
    if(target.matches("[data-close]")){close();return;}
    if(target.matches("[data-retry]")){if(dialog.open)poll();else refreshList();return;}
    if(target.dataset.copy){
      const source=document.getElementById(target.dataset.copy);if(!source)return;
      const version=epoch;
      try{await navigator.clipboard.writeText(source.value??source.textContent);if(version===epoch)announce(target.dataset.copy==="enrollment-token"?"Enrollment token copied. Paste into the hidden terminal prompt.":"Setup command copied. Paste into the host terminal.");}
      catch{if(version!==epoch)return;if(source instanceof HTMLTextAreaElement){source.focus();source.select();}else{const selection=getSelection();const range=document.createRange();range.selectNodeContents(source);selection.removeAllRanges();selection.addRange(range);source.setAttribute("tabindex","0");source.focus();}announce("Could not copy. Select and copy the highlighted text manually.",true);}
      return;
    }
    opener=target;epoch++;openedAt=Date.now();active=undefined;busy=false;feedback.textContent="";
    const version=epoch;
    if(target.matches("[data-add]")){
      content.replaceChildren(document.getElementById("create-environment").content.cloneNode(true));dialog.showModal();content.querySelector("input")?.focus();return;
    }
    content.innerHTML='<section><h2 id="connection-title">Loading connection…</h2><button type="button" data-close>Close and keep environment</button></section>';
    dialog.showModal();content.querySelector("button")?.focus();
    active=target.dataset.connect;
    try{const data=await request("/environments/"+active+"/connection");if(epoch===version)install(data);}
    catch{if(epoch===version)announce("Connection unavailable. Try again. The environment is preserved.",true);}
  });
  dialog.addEventListener("change",event=>{
    if(!event.target.matches("[data-host-os]"))return;
    const help=content.querySelector("[data-os-help]");
    help.textContent=event.target.value==="linux"?"Linux: current-user systemd. Boot/logout operation requires linger and may need local authorization. Install the CLI first; setup checks prerequisites.":"macOS: current-user LaunchAgent starts at login. No pre-login boot or logout survival. Install the CLI first; setup checks prerequisites.";
  });
  dialog.addEventListener("cancel",event=>{event.preventDefault();close();});
  dialog.addEventListener("keydown",event=>{
    if(event.key!=="Tab")return;
    const items=controls(),first=items[0],last=items[items.length-1];
    if(!first){event.preventDefault();return;}
    if(event.shiftKey&&(document.activeElement===first||!items.includes(document.activeElement))){event.preventDefault();last.focus();}
    else if(!event.shiftKey&&(document.activeElement===last||!items.includes(document.activeElement))){event.preventDefault();first.focus();}
  });
  dialog.addEventListener("submit",async event=>{
    event.preventDefault();const form=event.target;if(busy)return;
    const action=form.dataset.action;if(!action)return;
    const name=form.querySelector("[name=name]");
    if(name&&!name.value.trim()){name.setAttribute("aria-invalid","true");name.focus();announce("Enter an environment name.",true);return;}
    const version=++epoch;busy=true;form.setAttribute("aria-busy","true");
    const buttons=[...form.querySelectorAll("button")];buttons.forEach(b=>b.disabled=true);
    announce("Saving environment…");
    try{
      const path=action==="create"?"/environments":"/environments/"+active+"/"+action;
      const body=action==="create"?{name:name.value.trim()}:action==="revoke"?{acknowledged:form.querySelector("[name=acknowledged]").checked}:{};
      const data=await request(path,body);
      if(version===epoch)install(data);else refreshList();
    }catch{if(version===epoch)announce("Unable to save. Try again. If a create response was lost, close and reopen the saved environment instead of creating a duplicate.",true);}
    finally{if(version===epoch){busy=false;form.removeAttribute("aria-busy");buttons.forEach(b=>b.disabled=false);}}
  });
  async function poll(){
    if(!active||!dialog.open||busy||polling)return;
    const elapsed=content.querySelector("[data-wait-elapsed]");
    if(elapsed)elapsed.textContent="Waiting "+Math.floor((Date.now()-openedAt)/1000)+"s for the host";
    const tokenExpiry=content.querySelector("[data-expiry]")?.dataset.expiry;
    if(tokenExpiry&&Date.parse(tokenExpiry)<=Date.now()){
      const token=document.getElementById("enrollment-token");if(token){token.value="";token.textContent="";}
      const copy=content.querySelector('[data-copy="enrollment-token"]');if(copy)copy.disabled=true;
    }
    polling=true;const version=epoch,id=active;
    try{
      const data=await request("/environments/"+id+"/connection");if(version!==epoch)return;
      updateRows(data.rows);
      if(feedback.getAttribute("role")==="alert")announce("Connection checks resumed.");
      const current=content.querySelector("[data-stage]")?.dataset.stage;
      const expiry=content.querySelector("[data-expiry]")?.dataset.expiry;
      if(data.stage!==current&&!(current==="token-expired"&&data.stage==="pending")&&!(current==="token-ready"&&data.stage==="pending"&&Date.parse(expiry)>Date.now())){
        install(data);
        if(current==="token-ready"&&data.stage==="pending"){
          content.querySelector("[data-stage]").dataset.stage="token-expired";
          content.querySelector(".notice strong").textContent="Token expired";
        }
        announce(data.stage==="online"?"Connection successful.":data.stage==="pending"?"Token expired. Generate a new token.":"Connection status updated.");
      }
    }catch{if(version===epoch)announce("Unable to check connection. Try again; saved environment is preserved.",true);}
    finally{polling=false;}
  }
  setInterval(()=>{if(document.visibilityState!=="hidden"){if(dialog.open)poll();else refreshList();}},2000);
  window.addEventListener("pagehide",()=>{epoch++;content.replaceChildren();active=undefined;});
})();
`;
