import DOMMatrixFallback from "@thednp/dommatrix";

const unsupported = () => new Error("This PDF does not contain a readable purchase order in the supported layout.");
const decimal = /^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,4})?$/;

function textRows(items) {
  const positions = items.filter(item => item.str?.trim()).map(item => ({
    text: item.str.trim(), x: item.transform[4], y: item.transform[5]
  })).sort((a, b) => b.y - a.y);
  const rows = [];
  for (const position of positions) {
    if (!rows.length || rows.at(-1).y - position.y > 2) rows.push({ y: position.y, cells: [] });
    rows.at(-1).cells.push(position);
  }
  return rows.map(({ cells }) => cells.sort((a, b) => a.x - b.x));
}

const join = cells => cells.map(cell => cell.text).join(" ");

export function formatPoRequestor(value) {
  const comma = value.indexOf(",");
  return comma < 0 ? value.trim() : [value.slice(comma + 1).trim(), value.slice(0, comma).trim()].filter(Boolean).join(" ");
}

export async function extractPoPdf(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw unsupported();
  // PDF.js constructs a matrix at module load even for text extraction.
  globalThis.DOMMatrix ??= DOMMatrixFallback;
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // Keep the worker visible to Vercel's dependency tracing.
  await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  const task = getDocument({
    data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: true,
    isOffscreenCanvasSupported: false, isImageDecoderSupported: false, stopAtErrors: true
  });
  try {
    const document = await task.promise;
    if (document.numPages > 25) throw new Error("Purchase order PDFs may have up to 25 pages.");
    const lines = [];
    let poNumber, requestor, vendorName;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const rows = textRows((await page.getTextContent()).items);
      if (pageNumber === 1) {
        const field = label => {
          const row = rows.find(cells => cells.some(cell => cell.text.toLowerCase() === label));
          if (!row) throw unsupported();
          return join(row.slice(row.findIndex(cell => cell.text.toLowerCase() === label) + 1));
        };
        poNumber = field("po number");
        requestor = formatPoRequestor(field("po creator"));
        const vendorIndex = rows.findIndex(cells => cells.some(cell => cell.text === "Vendor"));
        const vendorX = rows[vendorIndex]?.find(cell => cell.text === "Vendor").x;
        const shipIndex = rows.findIndex((cells, index) => index > vendorIndex && cells.some(cell => cell.text === "Ship to" && Math.abs(cell.x - vendorX) < 5));
        if (vendorIndex < 0 || shipIndex < 0) throw unsupported();
        vendorName = rows.slice(vendorIndex + 1, shipIndex).flatMap(cells => cells.filter(cell => cell.x >= vendorX - 2 && cell.x < vendorX + 135)).map(cell => cell.text).join(" ");
        if (!poNumber || !requestor || !vendorName) throw unsupported();
      }

      const header = rows.findIndex(cells => /^Line Item number Description Quantity Unit Unit price Line total$/i.test(join(cells)));
      if (header < 0) continue;
      const [quantityColumn, unitColumn, priceColumn, totalColumn] = rows[header].slice(-4);
      if (!quantityColumn || quantityColumn.text !== "Quantity" || priceColumn.text.toLowerCase() !== "unit price") throw unsupported();
      // Some PDF text streams combine "Line" and "Item number" into one header span.
      const lineX = rows[header][0].x;
      const itemStart = lineX + 15;
      for (const cells of rows.slice(header + 1)) {
        if (/^(?:PURCHASE ORDER TERMS|Page\b|PO Number\b)/i.test(join(cells))) break;
        const lineNumber = join(cells.filter(cell => cell.x >= lineX - 3 && cell.x < itemStart));
        if (!/^\d+$/.test(lineNumber)) continue;
        const [itemNumber, ...description] = join(cells.filter(cell => cell.x >= itemStart && cell.x < quantityColumn.x - 10)).split(/\s+/);
        const quantity = join(cells.filter(cell => cell.x >= quantityColumn.x - 10 && cell.x < unitColumn.x - 3));
        const unit = join(cells.filter(cell => cell.x >= unitColumn.x - 3 && cell.x < priceColumn.x - 4));
        const unitPrice = join(cells.filter(cell => cell.x >= priceColumn.x - 4 && cell.x < totalColumn.x - 6)).replace(/^\$\s*/, "");
        if (!itemNumber || !description.length || !unit || !decimal.test(quantity) || !decimal.test(unitPrice) || Number(quantity.replaceAll(",", "")) <= 0) {
          throw new Error(`Could not read purchase order line ${lineNumber} on page ${pageNumber}.`);
        }
        lines.push({ lineNumber, itemNumber, description: description.join(" "), unit, quantity: quantity.replaceAll(",", ""), unitPrice: unitPrice.replaceAll(",", "") });
      }
    }
    if (!lines.length || lines.length > 500 || lines.some((line, index) => Number(line.lineNumber) !== index + 1)) throw unsupported();
    return { poNumber, requestor, vendorName, lines };
  } finally {
    await task.destroy();
  }
}
