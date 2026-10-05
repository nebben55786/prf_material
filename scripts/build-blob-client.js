import { build } from "esbuild";

// Serve a browser-only client from our own origin instead of a runtime CDN.
await build({
  stdin: {
    contents: 'export { upload } from "@vercel/blob/client";',
    resolveDir: process.cwd(),
    sourcefile: "blob-browser-client.js"
  },
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2020",
  minify: true,
  legalComments: "linked",
  outfile: "public/vendor/vercel-blob-client.js"
});
