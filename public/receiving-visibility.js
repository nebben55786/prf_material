(function () {
  document.querySelectorAll('[data-toggle-received-items]').forEach(function (button) {
    const form = button.closest('form');
    if (!form) return;
    button.addEventListener('click', function () {
      const hide = button.getAttribute('aria-pressed') !== 'true';
      const rows = Array.from(form.querySelectorAll('[data-po-receive-line]'));
      rows.forEach(function (row) {
        row.hidden = hide && row.dataset.fullyReceived === 'true';
      });
      button.setAttribute('aria-pressed', String(hide));
      button.textContent = hide ? 'Show Fully Received Items' : 'Hide Fully Received Items';
      const count = form.querySelector('[data-receiving-line-count]');
      if (count) count.textContent = rows.filter(function (row) { return !row.hidden; }).length + ' line(s) shown';
      const url = new URL(window.location.href);
      if (hide) url.searchParams.set('hide_received', '1');
      else url.searchParams.delete('hide_received');
      window.history.replaceState(window.history.state, '', url.toString());
    });
  });
}());
