(function () {
  const toggle = document.querySelector('[data-move-select-all]');
  if (!toggle) return;
  const boxes = Array.from(toggle.form.querySelectorAll('input[name^="selected_"]'));
  toggle.addEventListener('change', () => boxes.forEach(box => { box.checked = toggle.checked; }));
  boxes.forEach(box => box.addEventListener('change', () => {
    toggle.checked = boxes.length > 0 && boxes.every(item => item.checked);
    toggle.indeterminate = boxes.some(item => item.checked) && !toggle.checked;
  }));
}());
