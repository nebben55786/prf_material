const initializedSections = new WeakSet();

function safeSegment(value, fallback = "photo") {
  const base = String(value || fallback).replace(/\.[^.]*$/, "");
  return base
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .trim()
    .replace(/[. ]+$/g, "")
    .slice(0, 100) || fallback;
}

function supportedPhoto(file) {
  const type = String(file?.type || "").toLowerCase();
  const name = String(file?.name || "").toLowerCase();
  return type.startsWith("image/")
    || /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(name);
}

async function convertToJpeg(file) {
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("This photo could not be converted to JPG on this device."));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth || image.width;
    canvas.height = image.naturalHeight || image.height;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((result) => result ? resolve(result) : reject(new Error("This photo could not be converted to JPG.")), "image/jpeg", 0.88);
    });
    const stem = safeSegment(file.name || "photo");
    return new File([blob], stem + ".jpg", { type: "image/jpeg", lastModified: Date.now() });
  } finally {
    URL.revokeObjectURL(url);
  }
}

document.querySelectorAll("[data-photo-section]").forEach((section) => {
  if (initializedSections.has(section)) return;
  initializedSections.add(section);
  const form = section.querySelector("[data-photo-upload-form]");
  const input = section.querySelector("[data-photo-input]");
  const status = section.querySelector("[data-photo-status]");
  const item = section.querySelector("[data-photo-item]");
  const caption = section.querySelector("[data-photo-caption]");
  if (!form || !input || !status) return;

  let busy = false;
  const setStatus = (message) => { status.textContent = message || ""; };
  const uploadFiles = async (files) => {
    if (busy) return;
    const selected = Array.from(files || []);
    if (!selected.length) {
      setStatus("Choose a photo first.");
      return;
    }
    const invalid = selected.find((file) => !supportedPhoto(file) || !file.size || file.size > 25 * 1024 * 1024);
    if (invalid) {
      setStatus("Photos must be JPG, PNG, WebP, GIF, HEIC, or HEIF and 25 MB or less.");
      return;
    }

    busy = true;
    input.disabled = true;
    form.querySelectorAll("button").forEach((button) => { button.disabled = true; });
    try {
      const { upload } = await import(section.dataset.clientModuleUrl);
      const baseUrl = "/photos/" + section.dataset.scope + "/" + section.dataset.targetId;
      for (let index = 0; index < selected.length; index += 1) {
        setStatus("Converting " + (index + 1) + " of " + selected.length + " to JPG...");
        const file = await convertToJpeg(selected[index]);
        if (file.size > 25 * 1024 * 1024) throw new Error("Converted JPG is larger than 25 MB.");
        const filename = safeSegment(file.name || "photo") + ".jpg";
        const pathname = section.dataset.uploadPrefix + crypto.randomUUID() + "/" + filename;
        setStatus("Uploading " + (index + 1) + " of " + selected.length + "...");
        const blob = await upload(pathname, file, {
          access: "private",
          contentType: "image/jpeg",
          handleUploadUrl: baseUrl + "/client-upload",
          onUploadProgress: ({ percentage }) => {
            setStatus("Uploading " + (index + 1) + " of " + selected.length + "... " + Math.round(percentage) + "%");
          }
        });
        setStatus("Saving photo...");
        const response = await fetch(baseUrl + "/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            pathname: blob.pathname,
            source_filename: file.name || filename,
            content_type: file.type || "",
            size_bytes: file.size || 0,
            caption: caption ? caption.value : "",
            material_item_id: item ? item.value : ""
          })
        });
        if (response.redirected) throw new Error("Your session changed. Sign in and upload again.");
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Unable to save photo.");
      }
      setStatus("Photo saved. Refreshing...");
      window.location.reload();
    } catch (error) {
      setStatus(error?.message || "Upload failed. Please try again.");
    } finally {
      busy = false;
      input.disabled = false;
      form.querySelectorAll("button").forEach((button) => { button.disabled = false; });
      input.value = "";
    }
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    uploadFiles(input.files);
  });
});
