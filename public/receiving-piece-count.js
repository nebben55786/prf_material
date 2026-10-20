(function () {
  const selector = 'input[name="qty_received"], input[name^="qty_received_"]';
  function update(form) {
    const output = form.querySelector('[data-receiving-piece-total]');
    if (!output) return;
    let total = 0;
    form.querySelectorAll(selector).forEach(function (input) {
      if (input.disabled) return;
      const value = Number(String(input.value || '').replace(/,/g, '').trim());
      if (Number.isFinite(value) && value > 0) total += value;
    });
    output.textContent = new Intl.NumberFormat('en-US', {maximumFractionDigits: 4}).format(total);
  }
  function updateAll() {
    document.querySelectorAll('form[data-receiving-piece-count]').forEach(update);
  }
  ['input', 'change'].forEach(function (type) {
    document.addEventListener(type, function (event) {
      const form = event.target.closest('form[data-receiving-piece-count]');
      if (form) update(form);
    });
  });
  window.addEventListener('pageshow', updateAll);
  updateAll();
}());
