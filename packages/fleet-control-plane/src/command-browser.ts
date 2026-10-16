/** Progressive enhancement: native modal focus isolation, validation and no replay. */
export const commandBrowserScript = `
const dialog=document.querySelector("dialog.command-dialog");
if(dialog && typeof dialog.showModal==="function"){
  dialog.removeAttribute("open");
  dialog.showModal();
  const cancel=dialog.querySelector("a[data-cancel]");
  cancel?.focus();
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
