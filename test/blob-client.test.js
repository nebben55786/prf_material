import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("uploaders use the bundled Blob client without runtime module dependencies", async () => {
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  assert.match(server, /const vercelBlobClientModuleUrl = "\/public\/vendor\/vercel-blob-client\.js";/);
  const bundle = readFileSync(new URL("../public/vendor/vercel-blob-client.js", import.meta.url), "utf8");
  assert.doesNotMatch(bundle, /\bimport\s*(?:\(|["'{*])/);
  const client = await import("../public/vendor/vercel-blob-client.js");
  assert.equal(typeof client.upload, "function");
});
