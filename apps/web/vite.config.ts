import { readFileSync } from "node:fs";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { PAGE_POLICY } from "./src/csp.ts";

// What `pi web` may serve, by extension. A file of any other kind stops the build, so the server
// never guesses a content type.
const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  woff2: "font/woff2",
  svg: "image/svg+xml",
  png: "image/png",
  webmanifest: "application/manifest+json",
};

// The kinds of file worth compressing: text. A font or an image is compressed already.
const COMPRESSIBLE = new Set(["html", "js", "css", "svg", "webmanifest"]);

// The served files the server reads once at start: { index, assets: { "<url path>": { file, type,
// br?, gzip? } } }, every file the build wrote but this one and the compressed copies. Each text
// file is also written compressed, brotli at its best and gzip at its best, as `<file>.br` and
// `<file>.gz`, named in its entry only where smaller, so the server sends the best the browser
// accepts and compresses nothing itself. Run last, after Vite's own plugins have finished each
// file's code.
function servedManifest(): Plugin {
  return {
    name: "pi-web-manifest",
    enforce: "post",
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        const assets: Record<string, { file: string; type: string; br?: string; gzip?: string }> = {};
        for (const file of Object.keys(bundle).sort()) {
          const extension = file.split(".").pop() ?? "";
          const type = CONTENT_TYPES[extension];
          if (type === undefined) throw new Error(`the build wrote ${file}, a kind of file pi web does not serve`);
          const entry: (typeof assets)[string] = { file, type };
          assets[`/${file}`] = entry;
          if (!COMPRESSIBLE.has(extension)) continue;
          const output = bundle[file];
          const body = Buffer.from(output?.type === "chunk" ? output.code : (output?.source ?? ""));
          const br = brotliCompressSync(body, {
            params: {
              [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
              [constants.BROTLI_PARAM_SIZE_HINT]: body.length,
            },
          });
          const gzip = gzipSync(body, { level: constants.Z_BEST_COMPRESSION });
          for (const [name, packed] of [
            ["br", br],
            ["gzip", gzip],
          ] as const) {
            if (packed.length >= body.length) continue;
            const fileName = `${file}.${name === "br" ? "br" : "gz"}`;
            this.emitFile({ type: "asset", fileName, source: packed });
            entry[name] = fileName;
          }
        }
        if (assets["/index.html"] === undefined) throw new Error("the build wrote no index.html");
        this.emitFile({
          type: "asset",
          fileName: "manifest.json",
          source: `${JSON.stringify({ index: "index.html", assets }, null, 2)}\n`,
        });
      },
    },
  };
}

// The policy goes first into the built page only: the development server's reload script is inline.
function pagePolicy(): Plugin {
  return {
    name: "pi-web-policy",
    apply: "build",
    transformIndexHtml: () => [
      {
        tag: "meta",
        attrs: { "http-equiv": "Content-Security-Policy", content: PAGE_POLICY },
        injectTo: "head-prepend",
      },
    ],
  };
}

// Add to Home Screen on the phone: the web app manifest and its icons from `home-screen/`, at fixed
// paths the manifest names, the browser tab's icons (a tighter crop), and the page's links to them;
// the home-screen app's own head: it opens full screen, under a status bar the page colours with the
// sky (shell.tsx). No service worker.
const HOME_SCREEN = ["manifest.webmanifest", "icon-180.png", "icon-512.png", "icon-32.png", "icon-64.png"];
function homeScreen(): Plugin {
  return {
    name: "pi-web-home-screen",
    apply: "build",
    buildStart() {
      for (const fileName of HOME_SCREEN)
        this.emitFile({
          type: "asset",
          fileName,
          source: readFileSync(new URL(`./home-screen/${fileName}`, import.meta.url)),
        });
    },
    transformIndexHtml: () => [
      { tag: "link", attrs: { rel: "manifest", href: "/manifest.webmanifest" }, injectTo: "head" },
      { tag: "link", attrs: { rel: "apple-touch-icon", href: "/icon-180.png" }, injectTo: "head" },
      {
        tag: "link",
        attrs: { rel: "icon", type: "image/png", sizes: "32x32", href: "/icon-32.png" },
        injectTo: "head",
      },
      {
        tag: "link",
        attrs: { rel: "icon", type: "image/png", sizes: "64x64", href: "/icon-64.png" },
        injectTo: "head",
      },
      { tag: "meta", attrs: { name: "apple-mobile-web-app-capable", content: "yes" }, injectTo: "head" },
      { tag: "meta", attrs: { name: "mobile-web-app-capable", content: "yes" }, injectTo: "head" },
      { tag: "meta", attrs: { name: "apple-mobile-web-app-title", content: "Intelligence" }, injectTo: "head" },
      { tag: "meta", attrs: { name: "apple-mobile-web-app-status-bar-style", content: "default" }, injectTo: "head" },
      { tag: "meta", attrs: { name: "theme-color", content: "#c5d3e2" }, injectTo: "head" },
    ],
  };
}

// The design's two typefaces are the page's own files (public/fonts/, the policy's font-src
// 'self'): src/styles.css names them by relative path, so Vite writes each under /assets/ with a
// hash of its content, as it does the code, and the server may let the browser keep them.

export default defineConfig({
  plugins: [react(), pagePolicy(), homeScreen(), servedManifest()],
  publicDir: false,
  // Every room but Today is its own file, loaded when the owner first opens it (shell.tsx); browsers the
  // page supports preload modules themselves, so no polyfill. Nothing is inlined as a data URL.
  build: { modulePreload: { polyfill: false }, assetsInlineLimit: 0 },
});
