(function () {
  const form=document.querySelector('form[data-location-inventory-draft]');
  if(!form) return;
  const key='location-inventory:'+form.dataset.locationInventoryDraft,version=form.dataset.draftVersion;
  const fields=Array.from(form.querySelectorAll('input:not([type="hidden"]),select,input[data-location-item-queue]'));
  try {
    if(form.dataset.draftSaved==='1') sessionStorage.removeItem(key);
    const draft=JSON.parse(sessionStorage.getItem(key)||'null');
    if(draft && draft.version===version) fields.forEach(field=>{if(Object.hasOwn(draft.values,field.name)) field.value=draft.values[field.name];});
    else sessionStorage.removeItem(key);
  } catch (_) {}
  function save() {
    try {sessionStorage.setItem(key,JSON.stringify({version,values:Object.fromEntries(fields.map(f=>[f.name,f.value]))}));} catch (_) {}
  }
  form.addEventListener('input',save);
  form.addEventListener('change',save);
  form.addEventListener('submit',save);
}());
