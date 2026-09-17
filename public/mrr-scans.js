const moduleUrl = document.querySelector('script[src="/public/mrr-scans.js"]').dataset.clientModuleUrl;

document.querySelectorAll("[data-mrr-scan-row]").forEach((row) => {
  const input = row.querySelector("[data-scan-input]");
  const button = row.querySelector("[data-scan-upload]");
  const open = row.querySelector("[data-scan-open]");
  const status = row.querySelector("[data-scan-status]");
  if (!input || !button) return;
  let busy = false;
  const uploadScan = async (files) => {
    if (busy || !files?.length) return;
    if (files.length !== 1) {
      status.textContent = "Choose one PDF for this MRR.";
      return;
    }
    const file = files[0];
    if (!/\.pdf$/i.test(file.name) || !file.size || file.size > 100 * 1024 * 1024) {
      status.textContent = "Choose a PDF no larger than 100 MB.";
      return;
    }
    if (row.dataset.hasScan === "true" && !window.confirm("Replace the saved scan for " + row.dataset.filename + "?")) return;
    busy = true;
    button.disabled = input.disabled = true;
    status.textContent = "Starting upload...";
    try {
      if (await file.slice(0, 5).text() !== "%PDF-") throw new Error("The selected file is not a PDF.");
      const { upload } = await import(moduleUrl);
      const pathname = row.dataset.uploadPrefix + crypto.randomUUID() + "/" + row.dataset.filename;
      const baseUrl = "/material-logs/mrr/" + row.dataset.mrrId + "/scanned-pdf";
      const blob = await upload(pathname, file, {
        access: "private",
        contentType: "application/pdf",
        handleUploadUrl: baseUrl + "/client-upload",
        onUploadProgress: ({ percentage }) => { status.textContent = "Uploading... " + Math.round(percentage) + "%"; }
      });
      status.textContent = "Saving scan...";
      const response = await fetch(baseUrl + "/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ pathname: blob.pathname })
      });
      if (response.redirected) throw new Error("Your session changed. Sign in and upload again.");
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Unable to save scan.");
      open.href = result.openUrl;
      open.removeAttribute("aria-disabled");
      open.removeAttribute("tabindex");
      row.dataset.hasScan = "true";
      status.textContent = "Scan saved.";
    } catch (error) {
      status.textContent = error.message || "Upload failed. Please try again.";
    } finally {
      busy = false;
      button.disabled = input.disabled = false;
      input.value = "";
    }
  };
  button.addEventListener("click", () => input.click());
  input.addEventListener("change", () => uploadScan(input.files));
  row.addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = busy ? "none" : "copy";
    if (!busy) row.classList.add("scan-drag-over");
  });
  row.addEventListener("dragleave", (event) => {
    if (!row.contains(event.relatedTarget)) row.classList.remove("scan-drag-over");
  });
  row.addEventListener("drop", (event) => {
    event.preventDefault();
    row.classList.remove("scan-drag-over");
    uploadScan(event.dataTransfer?.files);
  });
});
