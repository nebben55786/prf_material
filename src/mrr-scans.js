export const mrrScanMaxBytes = 100 * 1024 * 1024;

export function mrrScanFilename(mrrNumber) {
  const name = String(mrrNumber || "MRR")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .trim().replace(/[. ]+$/g, "").slice(0, 120);
  return `${name || "MRR"}.pdf`;
}

export function mrrScanPrefix(jobId, mrrId) {
  return `mrr-scans/job-${Number(jobId)}/mrr-${Number(mrrId)}/`;
}

export function isMrrScanPath(pathname, jobId, mrrId, mrrNumber) {
  const prefix = mrrScanPrefix(jobId, mrrId);
  if (typeof pathname !== "string" || !pathname.startsWith(prefix)) return false;
  const [uploadId, filename, ...extra] = pathname.slice(prefix.length).split("/");
  return /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(uploadId)
    && filename === mrrScanFilename(mrrNumber) && extra.length === 0;
}

export async function verifyMrrScan(blob) {
  if (!blob?.stream) throw new Error("Uploaded PDF is not available. Please retry the upload.");
  const reader = blob.stream.getReader();
  try {
    if (blob.blob.contentType !== "application/pdf" || !blob.blob.size || blob.blob.size > mrrScanMaxBytes) {
      throw new Error("Upload a PDF no larger than 100 MB.");
    }
    let header = Buffer.alloc(0);
    while (header.length < 5) {
      const { value, done } = await reader.read();
      if (done) break;
      header = Buffer.concat([header, Buffer.from(value).subarray(0, 5 - header.length)]);
    }
    if (header.toString("ascii") !== "%PDF-") throw new Error("The uploaded file is not a PDF.");
  } finally {
    await reader.cancel();
  }
}
