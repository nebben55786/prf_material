(function () {
  document.querySelectorAll('[data-phone-request-table]').forEach(table=>{
    const header=table.querySelector('tr');
    if(!header) return;
    const labels=Array.from(header.querySelectorAll('th')).map(th=>th.textContent.trim());
    const primary=new Set(['Item','Description','Request Qty','New Qty','Qty Requested','Qty Issued','Available','Available Qty','UOM','Pick','Remove','Current Qty','Reserved Qty (Job)','Actual Qty','Actual Qty at Location','Current','Actual','Adjustment','Action','Photos','Add']);
    header.classList.add('phone-request-header');
    table.parentElement.classList.add('phone-request-container');
    function decorateRows() {
    const rows=Array.from(table.querySelectorAll('tr')).filter(row=>row!==header && !row.querySelector('th'));
    rows.forEach(row=>{
      if(row.classList.contains('phone-request-row')) return;
      const cells=Array.from(row.children);
      if(cells.length!==labels.length) return;
      row.classList.add('phone-request-row');
      cells.forEach((cell,index)=>{
        const label=labels[index];cell.dataset.phoneLabel=label;
        cell.classList.add('phone-request-cell');
        if(!primary.has(label)) cell.classList.add('phone-request-secondary');
        if(label==='Item') cell.classList.add('phone-request-item');
        if(label==='Description') cell.classList.add('phone-request-description');
        if(['Request Qty','New Qty','Qty Issued','Actual Qty','Actual Qty at Location'].includes(label)&&cell.querySelector('input:not([type="hidden"])')) cell.classList.add('phone-request-quantity');
        if(label==='Pick') cell.classList.add('phone-request-pick');
      });
      const itemIndex=labels.indexOf('Item'),itemName=itemIndex>=0?cells[itemIndex].textContent.trim():'';
      cells.forEach((cell,index)=>cell.querySelectorAll('input:not([type="hidden"]),select,textarea').forEach(control=>{
        if(!control.getAttribute('aria-label')) control.setAttribute('aria-label',labels[index]+(itemName?' for '+itemName:''));
      }));
      const detailCell=document.createElement('td'),toggle=document.createElement('button');
      detailCell.className='phone-request-detail-toggle';toggle.type='button';toggle.className='btn btn-secondary';toggle.textContent='Show Details';toggle.setAttribute('aria-expanded','false');
      toggle.addEventListener('click',()=>{
        const expanded=toggle.getAttribute('aria-expanded')!=='true';
        toggle.setAttribute('aria-expanded',String(expanded));toggle.textContent=expanded?'Hide Details':'Show Details';
        row.classList.toggle('phone-request-expanded',expanded);
      });
      detailCell.appendChild(toggle);row.appendChild(detailCell);
    });
    }
    decorateRows();
    table.addEventListener('request-rows-updated',decorateRows);
    const selectAll=header.querySelector('#requisition-select-all-visible');
    if(selectAll) {
      const toolbar=document.createElement('div'),button=document.createElement('button');toolbar.className='phone-request-toolbar';
      button.type='button';button.className='btn btn-secondary';
      function sync(){button.textContent=selectAll.checked?'Deselect All Displayed':'Select All Displayed';button.setAttribute('aria-pressed',String(selectAll.checked));}
      button.addEventListener('click',()=>{selectAll.click();sync();});
      table.addEventListener('change',sync);table.addEventListener('input',sync);sync();toolbar.appendChild(button);table.before(toolbar);
    }
  });
}());
