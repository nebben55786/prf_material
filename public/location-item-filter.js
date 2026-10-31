(function () {
  const picker=document.querySelector('[data-existing-item-picker]');
  if(!picker) return;
  const form=picker.closest('form'),filters=Array.from(form.querySelectorAll('[data-item-filter]'));
  const clear=form.querySelector('[data-clear-item-filters]'),status=form.querySelector('[data-item-match-count]');
  const options=Array.from(picker.options),placeholder=options[0],items=options.slice(1);
  const normalize=value=>String(value||'').toLowerCase().replace(/\s+/g,' ').trim();
  function update() {
    const selected=picker.value;
    const matches=items.filter(option=>filters.every(input=>normalize(option.dataset[input.dataset.itemFilter]).includes(normalize(input.value))));
    picker.replaceChildren(placeholder,...matches);
    const retained=!selected || matches.some(option=>option.value===selected);
    picker.value=retained?selected:'';
    status.textContent=matches.length+' matching item(s)'+(!retained?' — previous selection cleared; choose a matching item.':matches.length?'':'. Change or clear the filters to find an existing item.');
    if(!retained) picker.dispatchEvent(new Event('change',{bubbles:true}));
  }
  filters.forEach(input=>input.addEventListener('input',update));
  clear.addEventListener('click',()=>{
    filters.forEach(input=>input.value='');update();
    form.dispatchEvent(new Event('input',{bubbles:true}));
  });
  update();
}());
