(function(){
  'use strict';
  const el=(tag,props={})=>Object.assign(document.createElement(tag),props);
  const stateElement=document.getElementById('tracker-state'),contactElement=document.getElementById('tracker-contact-state');
  if(!stateElement&&!contactElement)return;
  const state=JSON.parse((stateElement||contactElement).textContent),status=document.getElementById('tracker-status');
  let pending=0,failed=false,queue=Promise.resolve();const failures=new Map();
  function report(message,type='saved'){status.textContent=message;status.dataset.state=type;}
  async function api(path,body){
    const response=await fetch(path,{method:body===undefined?'GET':'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-Tracker-Token':state.token},body:body===undefined?undefined:JSON.stringify(body)});
    if(response.redirected)throw new Error('Your session changed. Reload before continuing.');
    const data=await response.json().catch(()=>{throw new Error('Unable to save. Reload after checking your connection.');});
    if(!response.ok)throw new Error(data.error||'Unable to save.');return data;
  }
  function enqueue(fn,key='global'){
    pending++;report('Saving…','saving');
    const result=queue.then(fn).then(value=>{failures.delete(key);failed=failures.size>0;return value;});
    queue=result.catch(e=>{failures.set(key,e.message);failed=true;report(e.message,'error');}).finally(()=>{pending--;if(!pending)report(failed?[...failures.values()][0]:'Saved',failed?'error':'saved');});
    return result;
  }
  window.addEventListener('beforeunload',e=>{if(pending||failed){e.preventDefault();e.returnValue='Changes are still saving or need attention.';}});
  if(contactElement){
    const tbody=document.querySelector('#tracker-contacts tbody');
    function contactRow(c){
      const tr=el('tr'),inputs={};
      for(const key of ['day_contact','night_contact_1','night_contact_2']){const td=el('td'),i=el('input',{value:c[key]||'',disabled:!state.edit});i.setAttribute('aria-label',key.replaceAll('_',' '));td.append(i);tr.append(td);inputs[key]=i;}
      const td=el('td'),active=el('input',{type:'checkbox',checked:c.active!==false,disabled:!state.edit});td.append(active);tr.append(td);
      const action=el('td');if(state.edit){const save=el('button',{type:'button',textContent:'Save'});save.onclick=()=>{save.disabled=true;enqueue(async()=>{Object.assign(c,await api('/tracker/contacts/save',{id:c.id,version:c.version,...Object.fromEntries(Object.entries(inputs).map(([k,i])=>[k,i.value])),active:active.checked}));failed=false;}).catch(()=>{}).finally(()=>save.disabled=false);};action.append(save);}tr.append(action);tbody.append(tr);
    }
    state.contacts.forEach(contactRow);document.getElementById('tracker-contact-add')?.addEventListener('click',()=>contactRow({}));return;
  }
  const k=state.kind,receiving=k==='receiving',base='/tracker/'+k,doc=state.selected,editable=doc&&state.edit&&!doc.cancelled;
  const header=document.getElementById('tracker-header'),tbody=document.querySelector('#tracker-grid tbody'),thead=document.querySelector('#tracker-grid thead');
  const documentFields=receiving?[
    ['number','GRR Number'],['vendor_id','Responsible Party (Vendor)','vendor'],['po_number','PO #'],['received_date','Date Received','date'],['received_by','Received By (Materials)','received_by'],['area','Area','area']
  ]:[['external_reference','3 Part Number'],['requestor','Requestor','contact'],['usage','Needs / Usage'],['requested_date','Date Requested','date'],['date_required','Date Required','date'],['issued_to','Issued To','contact'],['shift','Shift','shift'],['destination','Deliver To','destination'],['delivery_instructions','Delivery Instructions'],['notes','Notes']];
  const columns=receiving?[
    ['number','GRR'],['job','Job Number'],['vendor','Responsible Party (Vendor)'],['po_number','PO #'],['received_date','Date Received'],['received_by','Received By (Materials)'],['category','Category','text'],['subcategory','Subcategory','text'],['size','Size'],['length','Length (FT)','text'],['item_code','Part Ident','item'],['description','UID Description','description'],['uom','UOM'],['quantity','Qty / LF Received','quantity'],['area','Area','text'],['priority','Priority','text'],['receipt_issued','Total Issued'],['remaining','Remaining Row Stock'],['warehouse','Location (Warehouse)','warehouse'],['location','Grid (Storage Location)','location'],['osd','OS&D','checkbox'],['notes','Comments','text'],['tickets','Picking Tickets'],['status','Status']
  ]:[['number','PT Number'],['job','Job Number'],['external_reference','3 Part Number','text'],['line','Line Item'],['requestor','Requestor'],['item_code','Ident','item'],['description','Description','description'],['usage','Needs / Usage','text'],['quantity','Qty Req','quantity'],['issued_quantity','Qty Issued'],['balance','Balance to Be Issued'],['reserved_quantity','Reserved'],['shortage','Shortage'],['requested_date','Date Requested'],['issued_date','Date Issued'],['issued_to','Issued To'],['notes','Notes','text'],['shift','Shift (Issued)'],['ticket','PT Link']];
  function options(type,row){
    if(type==='vendor')return state.lists.vendors.map(v=>[String(v.id),v.name]);
    if(type==='contact')return [...new Set(state.lists.contacts.filter(c=>c.active).flatMap(c=>[c.day_contact,c.night_contact_1,c.night_contact_2]).filter(Boolean))].map(v=>[v,v]);
    if(type==='warehouse')return [...new Set(state.lists.locations.map(l=>l.warehouse))].map(v=>[v,v]);
    if(type==='location')return state.lists.locations.filter(l=>l.warehouse.toLowerCase()===String(row?.warehouse||'').toLowerCase()).map(l=>[l.location,l.location]);
    if(type==='shift')return [['Day','Day'],['Night','Night']];
    if(type==='destination')return state.lists.destinations.map(v=>[v.name,v.name]);
    if(type==='received_by'||type==='area')return state.lists.lookups.filter(v=>v.kind===type).map(v=>[v.value,v.value]);
    return [];
  }
  function control(type,value,row){
    if(['vendor','contact','warehouse','location','shift','destination'].includes(type)){
      const s=el('select');s.append(el('option',{value:'',textContent:'Select…'}));const opts=options(type,row);if(value&&!opts.some(o=>String(o[0])===String(value)))opts.push([value,value]);for(const [v,label] of opts)s.append(el('option',{value:v,textContent:label}));s.value=value||'';return s;
    }
    const i=el('input',{type:type==='date'?'date':type==='checkbox'?'checkbox':'text'});
    if(type==='checkbox')i.checked=!!value;else i.value=value??'';
    if(type==='quantity')i.inputMode='decimal';
    if(['item','description'].includes(type))i.setAttribute('list',type==='item'?'tracker-idents':'tracker-descriptions');
    if(['received_by','area'].includes(type)){const id='tracker-options-'+type;let list=document.getElementById(id);if(!list){list=el('datalist',{id});for(const [v] of options(type))list.append(el('option',{value:v}));document.body.append(list);}i.setAttribute('list',id);}
    return i;
  }
  for(const type of ['item','description']){const list=el('datalist',{id:type==='item'?'tracker-idents':'tracker-descriptions'});for(const item of state.lists.items)list.append(el('option',{value:type==='item'?item.item_code:item.description+' ['+item.item_code+']',label:type==='item'?item.description:item.item_code}));document.body.append(list);}
  function rowValue(r,key){
    const data=doc?.data||r.document_data||{};
    if(key==='number')return doc?.number||r.number;
    if(key==='job')return state.job.job_number;
    if(key==='vendor')return state.lists.vendors.find(v=>String(v.id)===String(data.vendor_id))?.name||'';
    if(key==='line')return state.rows.filter(a=>String(a.document_id)===String(r.document_id)).findIndex(a=>a.id===r.id)+1;
    if(key==='size')return [r.size_1,r.size_2].filter(Boolean).join(' × ');
    if(key==='remaining')return Math.round(Math.max(0,Number(r.posted_quantity)-Number(r.receipt_issued||0))*10000)/10000;
    if(key==='balance')return Math.round(Math.max(0,Number(r.quantity)-Number(r.issued_quantity||0))*10000)/10000;
    if(key==='shortage')return Math.round(Math.max(0,Number(r.quantity)-Number(r.issued_quantity||0)-Number(r.reserved_quantity||0))*10000)/10000;
    if(key==='status')return r.cancelled||doc?.cancelled?'Cancelled':Number(r.posted_quantity)>0?'Posted':'Pending — incomplete';
    if(key==='tickets')return (r.ticket_links||[]).map(l=>l.number).join(', ');
    if(key in r)return ['quantity','issued_quantity','receipt_issued','reserved_quantity'].includes(key)?Number(r[key]||0):r[key];
    return r.data?.[key]||data[key]||'';
  }
  function patchFor(field,type,value){
    if(type==='item'||type==='description'){
      const matches=state.lists.items.filter(i=>type==='item'?i.item_code.toLowerCase()===value.trim().toLowerCase():i.description+' ['+i.item_code+']'===value||i.description===value);
      if(matches.length!==1)throw new Error('Select one matching item from Item Master. Use the ident when descriptions are duplicated.');
      return {material_item_id:matches[0].id};
    }
    return field==='warehouse'?{warehouse:value,location:''}:{[field]:value};
  }
  function syncRow(r){
    const tr=tbody.querySelector('tr[data-id="'+r.id+'"]');if(!tr)return;
    for(const td of tr.cells){const key=td.dataset.field,type=columns.find(c=>c[0]===key)?.[2],input=td.querySelector('input,select');
      if(input&&!input.dataset.saveError&&(input!==document.activeElement||input.value==='')){const value=rowValue(r,key);if(type==='location'){const opts=options(type,r);if(value&&!opts.some(o=>o[0]===value))opts.push([value,value]);input.replaceChildren(el('option',{value:'',textContent:'Select…'}),...opts.map(([v,label])=>el('option',{value:v,textContent:label})));input.value=value||'';}else if(type==='checkbox')input.checked=!!value;else input.value=value??'';}
      if(!input&&key==='tickets'){td.replaceChildren();for(const l of r.ticket_links||[])td.append(el('a',{className:'tracker-readonly',textContent:l.number,href:l.url,target:'_blank',rel:'noopener'}));}
      else if(!input&&key!=='number'&&key!=='ticket')td.firstChild.textContent=String(rowValue(r,key));
    }
  }
  function bindRowChange(input,r,field,type){
    input.onchange=()=>{
      const raw=type==='checkbox'?input.checked:input.value;
      const failureKey='row:'+r.id+':'+field;
      let patch;try{patch=patchFor(field,type,raw);}catch(e){failed=true;failures.set(failureKey,e.message);input.dataset.saveError='1';report(e.message,'error');input.closest('tr').classList.add('tracker-error');return;}
      enqueue(async()=>{const saved=await api(base+'/documents/'+doc.id+'/rows/'+r.id,{version:r.version,patch});Object.assign(r,saved);doc.version=saved.document_version;delete input.dataset.saveError;if(!input.closest('tr')?.querySelector('[data-save-error]'))input.closest('tr')?.classList.remove('tracker-error');syncRow(r);},failureKey).catch(()=>{input.dataset.saveError='1';input.closest('tr')?.classList.add('tracker-error');});
    };
  }
  function renderHeader(){if(!doc)return;header.replaceChildren();for(const [key,label,type='text'] of documentFields){const labelEl=el('label',{textContent:label}),i=control(type,key==='number'?doc.number:doc.data[key]);i.disabled=!editable||(!receiving&&state.rows.some(r=>Number(r.issued_quantity)>0));i.dataset.header=key;
      i.onchange=()=>{const value=i.value;enqueue(async()=>{const saved=await api(base+'/documents/'+doc.id,{version:doc.version,patch:{[key]:value}});Object.assign(doc,saved);for(const r of state.rows)syncRow(r);if(receiving)await refreshRows();},'header:'+key).catch(()=>{});};labelEl.append(i);header.append(labelEl);}
  }
  let sortField='',sortDirection=1;
  function renderGrid(){
    tbody.replaceChildren();const filter=document.getElementById('tracker-filter').value.toLowerCase();
    const rows=state.rows.filter(r=>columns.some(c=>String(rowValue(r,c[0])).toLowerCase().includes(filter)));
    if(sortField)rows.sort((a,b)=>String(rowValue(a,sortField)).localeCompare(String(rowValue(b,sortField)),undefined,{numeric:true})*sortDirection);
    for(const r of rows){const tr=el('tr');tr.dataset.id=r.id;
      for(const [field,label,type] of columns){const td=el('td');td.dataset.field=field;
        if(type&&editable){const i=control(type,rowValue(r,field),r);i.disabled=!receiving&&Number(r.issued_quantity)>0;i.setAttribute('aria-label',label+' for row '+r.id);i.dataset.field=field;bindRowChange(i,r,field,type);td.append(i);}
        else if(field==='tickets'){for(const l of r.ticket_links||[])td.append(el('a',{className:'tracker-readonly',textContent:l.number,href:l.url,target:'_blank',rel:'noopener'}));}
        else if(field==='number'||field==='ticket'){td.append(el('a',{className:'tracker-readonly',href:field==='ticket'?'/tracker/issuing/documents/'+r.document_id+'/pick-ticket.pdf':base+'?document='+r.document_id,textContent:field==='ticket'?'Pick Ticket':String(rowValue(r,field))}));}
        else td.append(el('span',{className:'tracker-readonly',textContent:String(rowValue(r,field))}));tr.append(td);
      }tbody.append(tr);
    }
  }
  const hr=el('tr');for(const [field,label] of columns){const th=el('th',{textContent:label,tabIndex:0});th.dataset.field=field;th.setAttribute('scope','col');th.title='Click to sort; drag right edge to resize';const sort=()=>{sortDirection=sortField===field?-sortDirection:1;sortField=field;renderGrid();};th.onclick=e=>{if(e.offsetX<th.clientWidth-12)sort();};th.onkeydown=e=>{if(e.key==='Enter')sort();};hr.append(th);}thead.append(hr);
  new ResizeObserver(()=>document.querySelector('.tracker-scroll').style.setProperty('--tracker-first-width',hr.firstChild.getBoundingClientRect().width+'px')).observe(hr.firstChild);
  async function refreshRows(){
    // Reload data without navigating or disturbing the active cell.
    const response=await fetch(location.href,{credentials:'same-origin'});if(!response.ok||response.redirected)return;
    const html=new DOMParser().parseFromString(await response.text(),'text/html'),node=html.getElementById('tracker-state');if(!node)return;
    const fresh=JSON.parse(node.textContent);for(const incoming of fresh.rows){const r=state.rows.find(r=>r.id===incoming.id);if(r){Object.assign(r,incoming);syncRow(r);}}
  }
  renderHeader();renderGrid();document.getElementById('tracker-filter').oninput=renderGrid;
  document.getElementById('tracker-document').onchange=async e=>{await queue;if(!failed)location.href=base+(e.target.value?'?document='+e.target.value:'');};
  document.getElementById('tracker-new')?.addEventListener('click',()=>enqueue(async()=>{const d=await api(base+'/documents',{});location.href=base+'?document='+d.id;}).catch(()=>{}));
  document.getElementById('tracker-import')?.addEventListener('click',()=>enqueue(async()=>{await api('/tracker/reference/import',{});location.reload();}).catch(()=>{}));
  document.getElementById('tracker-add-row')?.addEventListener('click',()=>enqueue(async()=>{const r=await api(base+'/documents/'+doc.id+'/rows',{});doc.version=r.document_version;state.rows.push(r);renderGrid();}).catch(()=>{}));
  document.getElementById('tracker-cancel')?.addEventListener('click',()=>{if(confirm('Cancel this document and release its remaining stock holds?'))enqueue(async()=>{await api(base+'/documents/'+doc.id+'/cancel',{});location.reload();}).catch(()=>{});});
  tbody.addEventListener('keydown',e=>{if(!['ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Enter'].includes(e.key)||!e.target.matches('input,select'))return;if(e.target.tagName==='SELECT'&&e.key!=='Enter')return;const tr=e.target.closest('tr'),td=e.target.closest('td'),index=[...tr.cells].indexOf(td);let target;
    if(e.key==='ArrowLeft'||e.key==='ArrowRight'){if(e.target.selectionStart!==e.target.selectionEnd)return;if(e.key==='ArrowLeft'&&e.target.selectionStart!==0)return;if(e.key==='ArrowRight'&&e.target.selectionEnd!==e.target.value.length)return;let cell=e.key==='ArrowLeft'?td.previousElementSibling:td.nextElementSibling;while(cell&&!target){target=cell.querySelector('input:not(:disabled),select:not(:disabled)');cell=e.key==='ArrowLeft'?cell.previousElementSibling:cell.nextElementSibling;}}
    else{const next=e.key==='ArrowUp'||(e.key==='Enter'&&e.shiftKey)?tr.previousElementSibling:tr.nextElementSibling;target=next?.cells[index]?.querySelector('input:not(:disabled),select:not(:disabled)');}if(target){e.preventDefault();e.target.blur();target.focus();}});
  tbody.addEventListener('paste',e=>{
    if(!editable||!e.target.matches('input'))return;const value=e.clipboardData.getData('text/plain');if(!/[\t\n]/.test(value))return;e.preventDefault();
    const cells=value.replace(/\r/g,'').replace(/\n$/,'').split('\n').map(l=>l.split('\t')),startRow=state.rows.findIndex(r=>String(r.id)===e.target.closest('tr').dataset.id),startColumn=columns.findIndex(c=>c[0]===e.target.dataset.field);
    if(sortField||document.getElementById('tracker-filter').value){report('Clear sorting and filtering before pasting multiple rows.','error');return;}
    enqueue(async()=>{
      // Validate pasted item/quantity cells before any row posts.
      const patches=cells.map(values=>{const p={};values.forEach((v,j)=>{const c=columns[startColumn+j];if(!c?.[2]||!v.trim())return;const val=c[2]==='checkbox'?/^(yes|y|true|1)$/i.test(v):v;const part=patchFor(c[0],c[2],val);if(p.material_item_id&&part.material_item_id&&p.material_item_id!==part.material_item_id)throw new Error('Pasted ident and description refer to different items.');Object.assign(p,part);});return p;});
      for(let i=0;i<patches.length;i++){let r=state.rows[startRow+i];if(!r){r=await api(base+'/documents/'+doc.id+'/rows',{});state.rows.push(r);}if(Object.keys(patches[i]).length)Object.assign(r,await api(base+'/documents/'+doc.id+'/rows/'+r.id,{version:r.version,patch:patches[i]}));doc.version=r.document_version;}failed=false;renderGrid();
    }).catch(()=>{});
  });
  const dialog=document.getElementById('tracker-issue-dialog');let postingState=null,requestKey=null;
  document.getElementById('tracker-allocate')?.addEventListener('click',async()=>{
    await queue;if(failed)return;
    try{
      await api('/tracker/issuing/documents/'+doc.id+'/reserve',{});
      postingState=await api('/tracker/issuing/documents/'+doc.id+'/allocations');requestKey=crypto.randomUUID();
      const container=document.getElementById('tracker-allocations');container.replaceChildren();
      document.getElementById('tracker-issued-date').value=new Date().toLocaleDateString('en-CA');
      for(const r of postingState.rows){let left=Math.min(Number(r.quantity)-Number(r.issued_quantity),Number(r.reserved_quantity));const section=el('section',{className:'tracker-allocation-line'});section.append(el('strong',{textContent:r.item_code+' — '+r.description}),el('p',{textContent:'Requested '+r.quantity+' | Issued '+r.issued_quantity+' | Reserved '+r.reserved_quantity}));
        const table=el('table'),head=el('tr');for(const title of ['Receipt','Warehouse','Storage Location','Available','Issue Now'])head.append(el('th',{textContent:title}));table.append(head);
        for(const s of r.sources){const tr=el('tr');for(const v of [s.label,s.warehouse,s.location,s.quantity])tr.append(el('td',{textContent:String(v)}));const td=el('td'),input=el('input',{value:String(Math.min(left,Number(s.quantity))),inputMode:'decimal'});left=Math.max(0,left-Number(input.value));input.dataset.allocation=JSON.stringify({row_id:r.id,receipt_row_id:s.receipt_row_id,warehouse:s.warehouse,location:s.location,source_key:s.source_key});input.setAttribute('aria-label','Issue '+r.item_code+' from '+s.label+' '+s.warehouse+' '+s.location);td.append(input);tr.append(td);table.append(tr);}section.append(table);if(!r.sources.length)section.append(el('p',{textContent:'No available stock.'}));container.append(section);
      }
      const postings=document.getElementById('tracker-postings');postings.replaceChildren();for(const p of postingState.postings){const line=el('p',{textContent:'Issue #'+p.id+' — '+p.created_at+(p.reversed?' — Reversed':' ')});if(!p.reversed){const button=el('button',{type:'button',className:'btn btn-secondary',textContent:'Reverse Issue'});button.onclick=async()=>{if(confirm('Reverse this issue and restore stock?'))try{await api('/tracker/issuing/documents/'+doc.id+'/reverse/'+p.id,{});location.reload();}catch(e){document.getElementById('tracker-issue-error').textContent=e.message;}};line.append(button);}postings.append(line);}
      document.getElementById('tracker-issue-error').textContent='';dialog.showModal();
    }catch(e){report(e.message,'error');}
  });
  document.getElementById('tracker-close-dialog').onclick=()=>dialog.close();
  document.getElementById('tracker-post-issue').onclick=async e=>{
    if(!postingState)return;e.target.disabled=true;
    try{const allocations=[...document.querySelectorAll('[data-allocation]')].filter(i=>i.value.trim()&&Number(i.value)!==0).map(i=>({...JSON.parse(i.dataset.allocation),quantity:i.value}));await api('/tracker/issuing/documents/'+doc.id+'/issue',{version:postingState.document.version,request_key:requestKey,issued_date:document.getElementById('tracker-issued-date').value,allocations});location.reload();}catch(error){document.getElementById('tracker-issue-error').textContent=error.message;e.target.disabled=false;}
  };
}());
