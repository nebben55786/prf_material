(() => {
  const options = document.getElementById("po-ident-options");
  if (!options) return;

  let request;
  async function search(input, showStatus = false) {
    request?.abort();
    const controller = new AbortController();
    request = controller;
    options.replaceChildren();
    const term = input.value.trim();
    if (!term) return;
    const status = input.parentElement.querySelector("[data-po-ident-status]");
    try {
      const response = await fetch(`/rfq/new/po-pdf/idents?q=${encodeURIComponent(term)}`, { signal: controller.signal });
      if (!response.ok) throw new Error();
      const items = await response.json();
      if (controller.signal.aborted || input.value.trim() !== term) return;
      if (document.activeElement === input) {
        options.replaceChildren(...items.map(item => {
          const option = document.createElement("option");
          option.value = item.item_code;
          option.label = `${item.description || ""}${item.uom ? ` (${item.uom})` : ""}`;
          return option;
        }));
      }
      if (!showStatus) return;
      const matches = items.filter(item => item.item_code.toLowerCase() === term.toLowerCase());
      const item = matches.length === 1 ? matches[0] : null;
      const mismatch = item && (item.uom || "").trim().toLowerCase() !== input.dataset.poUnit.trim().toLowerCase();
      status.textContent = item ? item.description || "" : "Choose an existing ident or skip this line.";
      if (mismatch) {
        const warning = document.createElement("strong");
        warning.style.color = "#b42318";
        warning.textContent = ` Item Master unit: ${item.uom || "(blank)"}`;
        status.append(warning);
      }
    } catch (error) {
      if (error.name !== "AbortError" && showStatus) status.textContent = "Could not look up this ident. It will be checked when you save.";
    }
  }

  let pending;
  for (const input of document.querySelectorAll("[data-po-ident]")) {
    input.addEventListener("input", () => {
      clearTimeout(pending);
      request?.abort();
      options.replaceChildren();
      input.parentElement.querySelector("[data-po-ident-status]").textContent = "Select an ident from the suggestions.";
      pending = setTimeout(() => search(input), 150);
    });
    input.addEventListener("focus", () => {
      clearTimeout(pending);
      search(input);
    });
    input.addEventListener("change", () => {
      clearTimeout(pending);
      search(input, true);
    });
  }
})();
