(function () {
  const button = document.querySelector('[data-audit-toggle-zero]');
  if (!button) return;
  const rows = Array.from(document.querySelectorAll('[data-audit-stock-row]'));
  const storageKey = 'inventory-audit-show-zero';
  let showZero = false;
  try { showZero = sessionStorage.getItem(storageKey) === '1'; } catch (_) {}
  function render() {
    rows.forEach(row => { row.hidden = !showZero && row.dataset.zeroQty === '1'; });
    button.textContent = showZero ? 'Hide Zero Qty' : 'Show Zero Qty';
    button.setAttribute('aria-pressed', String(showZero));
  }
  button.addEventListener('click', function () {
    showZero = !showZero;
    try { sessionStorage.setItem(storageKey, showZero ? '1' : '0'); } catch (_) {}
    render();
  });
  render();
}());
