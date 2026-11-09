(() => {
  const dialog = document.getElementById("po-ident-search");
  if (!dialog) return;
  const query = dialog.querySelector("#po-ident-query");
  const results = dialog.querySelector("[data-po-results]");
  const status = dialog.querySelector("[data-po-results-status]");
  const previous = dialog.querySelector("[data-po-previous]");
  const next = dialog.querySelector("[data-po-next]");
  let source, page, pending, request;

  function selectItem(item) {
    const cell = source.closest("[data-po-match]");
    const input = cell.querySelector("[data-po-ident]");
    input.value = item.item_code;
    const create = cell.querySelector('input[name^="new_"][type="checkbox"]');
    if (create) {
      create.checked = false;
      create.closest("details").open = false;
    }
    const detail = cell.querySelector("[data-po-ident-status]");
    detail.textContent = item.description || "";
    if ((item.uom || "").trim().toLowerCase() !== input.dataset.poUnit.trim().toLowerCase()) {
      const warning = document.createElement("strong");
      warning.style.color = "#b42318";
      warning.textContent = ` Item Master unit: ${item.uom || "(blank)"}`;
      detail.append(warning);
    }
    dialog.close();
    input.focus();
  }

  async function search() {
    clearTimeout(pending);
    request?.abort();
    results.replaceChildren();
    previous.disabled = true;
    next.disabled = true;
    const term = query.value.trim();
    if (!term) {
      status.textContent = "Enter an ident or a few description keywords.";
      return;
    }
    const controller = new AbortController();
    request = controller;
    status.textContent = "Searching Item Master…";
    try {
      const params = new URLSearchParams({ q: term, page });
      const response = await fetch(`/rfq/new/po-pdf/idents?${params}`, { signal: controller.signal });
      if (!response.ok) throw new Error();
      const { items, more } = await response.json();
      if (controller.signal.aborted) return;
      for (const item of items) {
        const row = results.insertRow();
        for (const value of [item.item_code, item.description, item.uom]) row.insertCell().textContent = value || "";
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = "Use Ident";
        button.setAttribute("aria-label", `Use ident ${item.item_code}`);
        button.addEventListener("click", () => selectItem(item));
        row.insertCell().append(button);
      }
      status.textContent = items.length
        ? `Showing matches ${page * 25 + 1}–${page * 25 + items.length}`
        : "No matches. Try fewer keywords or a different ident.";
      previous.disabled = page === 0;
      next.disabled = !more;
    } catch (error) {
      if (error.name !== "AbortError") status.textContent = "Search unavailable. Try again or enter the ident directly.";
    }
  }

  function setQuery(value) {
    query.value = value.slice(0, 120);
    page = 0;
    search();
    query.focus();
  }

  for (const button of document.querySelectorAll("[data-po-find]")) {
    button.addEventListener("click", () => {
      source = button;
      dialog.querySelector("[data-po-source]").textContent = `PO line ${button.dataset.poLine} · ${button.dataset.poNumber} · ${button.dataset.poDescription}`;
      dialog.showModal();
      setQuery(button.closest("[data-po-match]").querySelector("[data-po-ident]").value || button.dataset.poNumber);
    });
  }
  query.addEventListener("input", () => {
    clearTimeout(pending);
    request?.abort();
    results.replaceChildren();
    previous.disabled = true;
    next.disabled = true;
    page = 0;
    pending = setTimeout(search, 175);
  });
  dialog.querySelector("[data-po-use-number]").addEventListener("click", () => setQuery(source.dataset.poNumber));
  dialog.querySelector("[data-po-use-description]").addEventListener("click", () => setQuery(source.dataset.poDescription));
  previous.addEventListener("click", () => { page--; search(); });
  next.addEventListener("click", () => { page++; search(); });
  dialog.querySelector("[data-po-close]").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    clearTimeout(pending);
    request?.abort();
  });
  for (const input of document.querySelectorAll("[data-po-ident]")) {
    input.addEventListener("input", () => {
      input.closest("[data-po-match]").querySelector("[data-po-ident-status]").textContent = "This ident will be checked when you save.";
    });
  }
})();
