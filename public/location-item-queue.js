(function () {
  const hidden=document.querySelector('[data-location-item-queue]');
  if(!hidden) return;
  const form=hidden.closest('form'),body=form.querySelector('[data-location-queue-rows]');
  const catalog=Array.from(form.querySelectorAll('[data-master-row]'));
  const filters=Array.from(form.querySelectorAll('[data-master-filter]'));
  const status=form.querySelector('[data-master-match-count]'),count=form.querySelector('[data-location-queue-count]');
  const byId=new Map(catalog.map(row=>[String(row.dataset.id),row]));
  let queue=[];
  try { const saved=JSON.parse(hidden.value||'[]');if(Array.isArray(saved)) queue=saved.filter(e=>byId.has(String(e.id))); } catch (_) {}
  const normalize=s=>String(s||'').toLowerCase().replace(/\s+/g,' ').trim();
  function save() { hidden.value=JSON.stringify(queue);hidden.dispatchEvent(new Event('input',{bubbles:true})); }
  function filter() {
    let matches=0;
    catalog.forEach(row=>{row.hidden=!filters.every(f=>normalize(row.dataset[f.dataset.masterFilter]).includes(normalize(f.value)));if(!row.hidden) matches++;});
    status.textContent=matches+' matching item(s)';
  }
  function cell(row,text) {const td=document.createElement('td');td.textContent=text||'';row.appendChild(td);return td;}
  function render() {
    body.replaceChildren();
    queue.forEach(entry=>{
      const source=byId.get(String(entry.id)).dataset,tr=document.createElement('tr');
      [source.code,source.description,source.size,source.uom].forEach(text=>cell(tr,text));
      const input=document.createElement('input');input.inputMode='decimal';input.value=entry.qty??'';input.setAttribute('aria-label','Actual quantity for '+source.code);
      input.addEventListener('input',()=>{entry.qty=input.value;save();});cell(tr,'').appendChild(input);
      const remove=document.createElement('button');remove.type='button';remove.className='btn btn-danger';remove.textContent='Remove';
      remove.addEventListener('click',()=>{queue=queue.filter(e=>e!==entry);render();save();});cell(tr,'').appendChild(remove);body.appendChild(tr);
    });
    if(!queue.length) {const tr=document.createElement('tr'),td=cell(tr,'No pending items. Click Show Items, then Add.');td.colSpan=6;body.appendChild(tr);}
    catalog.forEach(row=>{const button=row.querySelector('[data-queue-add]'),added=queue.some(e=>String(e.id)===String(row.dataset.id));button.disabled=added;button.textContent=added?'Added':'Add';});
    count.textContent=queue.length+' item(s) pending';
    body.closest?.('table')?.dispatchEvent(new Event('request-rows-updated'));
  }
  catalog.forEach(row=>row.querySelector('[data-queue-add]').addEventListener('click',()=>{
    if(queue.some(e=>String(e.id)===String(row.dataset.id))) return;
    queue.push({id:Number(row.dataset.id),qty:''});render();save();
    const inputs=body.querySelectorAll('input');inputs[inputs.length-1]?.focus();
  }));
  filters.forEach(f=>f.addEventListener('input',filter));
  form.querySelector('[data-clear-master-filters]').addEventListener('click',()=>{filters.forEach(f=>f.value='');filter();form.dispatchEvent(new Event('input',{bubbles:true}));});
  form.addEventListener('submit',event=>{
    if(event.submitter?.name==='photo_row') return;
    const invalid=queue.find(e=>{const raw=String(e.qty??'').trim(),n=Number(raw.replace(/,/g,''));return !raw||!Number.isFinite(n)||n<0||Math.abs(n*1e4-Math.round(n*1e4))>1e-5;});
    if(invalid) {event.preventDefault();window.alert('Enter an actual quantity of zero or greater for '+byId.get(String(invalid.id)).dataset.code+'.');return;}
    save();
  });
  render();filter();
}());
