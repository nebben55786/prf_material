(function () {
  function update(form) {
    const output = form.querySelector('[data-request-piece-total]');
    if (!output) return;
    const quantities = new Map();
    if (form.getAttribute('data-request-piece-count') === 'builder') {
      try {
        const staged = JSON.parse(form.querySelector('input[name="staged_selection"]')?.value || '{}');
        Object.entries(staged).forEach(([id, qty]) => quantities.set(id, qty));
      } catch (_) {}
    }
    form.querySelectorAll('input[name^="request_qty_"], input[name^="qty_requested_"]').forEach(input => {
      const id = input.name.replace(/^(request_qty_|qty_requested_)/, '');
      const selected = form.querySelector('input[name="selected_line_ids"][value="' + id + '"]');
      quantities.delete(id);
      if (!input.disabled && (!selected || selected.type !== 'checkbox' || selected.checked)) quantities.set(id, input.value);
    });
    let total = 0;
    quantities.forEach(qty => {
      const n = Number(String(qty || '').replace(/,/g, '').trim());
      if (Number.isFinite(n) && n > 0) total += n;
    });
    output.textContent = new Intl.NumberFormat('en-US', {maximumFractionDigits:4}).format(total);
  }
  function updateAll() { document.querySelectorAll('form[data-request-piece-count]').forEach(update); }
  ['input', 'change'].forEach(type => document.addEventListener(type, event => {
    const form = event.target.closest('form[data-request-piece-count]');
    if (form) update(form);
  }));
  window.addEventListener('pageshow', updateAll);
  updateAll();
}());
