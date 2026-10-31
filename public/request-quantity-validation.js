(function () {
  document.querySelectorAll('#requisition-create-form input[data-available-qty]').forEach(function (input) {
    function validate(showPopup) {
      const qty = Number(String(input.value || '').replace(/,/g, '').trim());
      const available = Number(input.dataset.availableQty);
      const message = Number.isFinite(qty) && qty > available
        ? 'Request quantity for ' + input.dataset.itemCode + ' cannot exceed the available quantity (' + new Intl.NumberFormat('en-US', {maximumFractionDigits:4}).format(available) + ').'
        : '';
      input.setCustomValidity(message);
      input.setAttribute('aria-invalid', message ? 'true' : 'false');
      if (message && showPopup) input.reportValidity();
    }
    input.addEventListener('input', function () { validate(true); });
    input.addEventListener('change', function () { validate(true); });
    validate(false);
  });
}());
