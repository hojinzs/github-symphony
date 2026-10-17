/** Progressive enhancement: explicit modal focus containment, validation and no replay. */
export const commandBrowserScript = `
const dialog=document.querySelector("dialog.command-dialog");
if(dialog && typeof dialog.showModal==="function"){
  dialog.removeAttribute("open");
  dialog.showModal();
  const cancel=dialog.querySelector("a[data-cancel]");
  cancel?.focus();
  dialog.addEventListener("keydown",event=>{
    if(event.key!=="Tab")return;
    const controls=[...dialog.querySelectorAll('a[href],button,input,select,textarea,[tabindex]')].filter(el=>!el.disabled && el.tabIndex>=0 && el.getClientRects().length);
    const first=controls[0],last=controls[controls.length-1];
    if(!first){event.preventDefault();dialog.focus();return;}
    if(event.shiftKey && document.activeElement===first){event.preventDefault();last.focus();}
    else if(!event.shiftKey && document.activeElement===last){event.preventDefault();first.focus();}
  });
  dialog.addEventListener("cancel",event=>{event.preventDefault();if(cancel)location.assign(cancel.href);});
}
document.addEventListener("submit",event=>{
  const form=event.target;
  if(!(form instanceof HTMLFormElement)||!form.matches("[data-command-form]"))return;
  const reason=form.querySelector("textarea[name=reason]");
  const error=form.querySelector("[data-reason-error]");
  if(reason && !reason.value.trim()){
    event.preventDefault();event.stopImmediatePropagation();
    if(error){error.hidden=false;error.textContent="Enter a resolution reason before continuing.";}
    reason.setAttribute("aria-invalid","true");reason.focus();return;
  }
  if(form.dataset.submitting){event.preventDefault();return;}
  form.dataset.submitting="true";
  form.setAttribute("aria-busy","true");
  const status=document.querySelector("[data-command-announcement]");
  if(status)status.textContent="Submitting intent. Process state has not been changed by this view.";
},{capture:true});
window.addEventListener("pageshow",()=>{
  document.querySelectorAll("[data-command-form]").forEach(form=>{delete form.dataset.submitting;form.removeAttribute("aria-busy");});
  if(location.hash){const target=document.getElementById(location.hash.slice(1));target?.focus();}
});
`;
