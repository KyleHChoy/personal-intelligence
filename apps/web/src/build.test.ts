import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CONTENT_SECURITY_POLICY, PAGE_POLICY } from "./csp.ts";

// The rules on the owner's dashboard client that are checks on the source and on the build, not on
// a page, under the dashboard's own policy.

const root = join(import.meta.dirname, "..");
// The repository's root, the folder that holds pnpm-workspace.yaml, found by walking up: the
// public copy moves the client, so no path to it is counted. The client's source may import no
// Node module, so this is not a shared helper under src/.
const repoRoot = (): string => {
  for (let dir = import.meta.dirname; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    if (dirname(dir) === dir) throw new Error("no pnpm-workspace.yaml above the client");
  }
};
const repository = repoRoot();

// The files the client is built from: everything under src that is not a test.
const sources = readdirSync(join(root, "src"), { recursive: true, encoding: "utf8" })
  // The page's own source: tests and their bench (test-support/) are not built into it.
  .filter((file) => /\.(ts|tsx|css)$/.test(file) && !/\.test\.tsx?$/.test(file) && !file.startsWith("test-support/"))
  .map((file) => ({ file: `src/${file}`, text: readFileSync(join(root, "src", file), "utf8") }));
const html = { file: "index.html", text: readFileSync(join(root, "index.html"), "utf8") };
// The design's sans typeface (public/fonts/, SIL OFL 1.1), each file written by the build under
// /assets/: two files at most, so a slow first load fetches little.
const FONT_FILES = ["HankenGrotesk-400.woff2", "HankenGrotesk-600.woff2"];

// Where a pattern is found, as "file: line", comments included: a word that is forbidden in the
// code is kept out of the comments too, so the check needs no parser.
const found = (pattern: RegExp, files = [...sources, html]): string[] =>
  files.flatMap(({ file, text }) =>
    text.split("\n").flatMap((line, index) => (pattern.test(line) ? [`${file}: ${index + 1}`] : [])),
  );

describe("the source", () => {
  it("has files to check", () => {
    expect(sources.map(({ file }) => file)).toEqual(
      expect.arrayContaining(["src/main.tsx", "src/shell.tsx", "src/rooms.ts", "src/csp.ts", "src/styles.css"]),
    );
  });

  it("W2: no source makes markup from a value, runs text as code or opens a window", () => {
    expect(
      found(
        /dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\b|new Function|DOMParser|createContextualFragment/,
      ),
    ).toEqual([]);
    expect(found(/window\.open|(?<![.\w])open\(|\blocation\b|\bassign\(/)).toEqual([]);
  });

  it("W2: no link, image, frame or address is made in the source, so none is built from data, but by safeLink", () => {
    // One exception, safe-link.ts, whose one link takes its address from safeLink's
    // host check. Every other source makes no link, by markup or by createElement.
    const MAKES =
      /<a\b|<img\b|<iframe\b|<object\b|<embed\b|<form\b|\bhref\b|\bsrc=|\bsrcSet\b|\baction=|\bformAction\b/;
    const SAFE_LINK = "src/safe-link.ts";
    const others = sources.filter(({ file }) => file !== SAFE_LINK);
    expect(found(MAKES, others)).toEqual([]);
    expect(found(/createElement\(\s*["'`](?:a|img|iframe|object|embed|form)["'`]/, others)).toEqual([]);
    const safe = sources.find(({ file }) => file === SAFE_LINK);
    expect(safe).toBeDefined();
    const lines = (safe?.text ?? "").split("\n");
    expect(lines.filter((line) => MAKES.test(line))).toEqual([
      '    { href: link, target: "_blank", rel: "noopener noreferrer", className },',
    ]);
    expect(lines.filter((line) => /\blink\s*=(?!=)/.test(line))).toEqual(["  const link = safeLink(url);"]);
    expect([...html.text.matchAll(/\b(?:src|href)="([^"]*)"/g)].map((match) => match[1])).toEqual([
      "/src/styles.css",
      "/src/main.tsx",
    ]);
  });

  it("the owner's ruling: every font size in the stylesheets is one of the six tokens", () => {
    const css = sources.filter(({ file }) => file.endsWith(".css"));
    expect(css.length).toBeGreaterThan(0);
    const sizes = css.flatMap(({ file, text }) =>
      [...text.matchAll(/font-size\s*:\s*([^;}]+)/g)].map((match) => `${file}: ${match[1]?.trim()}`),
    );
    expect(sizes.filter((one) => !/: (var\(--t[1-6]\)|inherit)$/.test(one))).toEqual([]);
    expect(found(/--t[1-6]\s*:/, css).length).toBeGreaterThan(0);
    // The six, and nothing else, are what the tokens hold.
    const root = css.find(({ file }) => file === "src/styles.css")?.text ?? "";
    expect([...root.matchAll(/--t([1-6]):\s*([\d.]+)px/g)].map((match) => [match[1], match[2]])).toEqual([
      ["1", "12"],
      ["2", "13.5"],
      ["3", "15"],
      ["4", "18"],
      ["5", "28"],
      ["6", "40"],
    ]);
  });

  it("the owner's ruling: nothing slides over the page; no source opens a modal dialog or a shade but search", () => {
    expect(found(/showModal|className="scrim/)).toEqual([]);
    expect(found(/aria-modal/)).toEqual(found(/aria-modal/).filter((at) => at.startsWith("src/search.tsx")));
  });

  it("W9: no source names a storage API, a cookie or a service worker", () => {
    expect(found(/localStorage|sessionStorage|indexedDB|\.cookie\b|serviceWorker|\bcaches\b|CacheStorage/)).toEqual([]);
  });

  it("no source reads the environment", () => {
    expect(found(/import\.meta\.env|process\.env/)).toEqual([]);
  });

  it("no source or page names an external address, or loads a style or font from anywhere but its own fonts", () => {
    expect(found(/https?:\/\/|\/\/[a-z0-9-]+\.[a-z]/i)).toEqual([]);
    expect(found(/@import/)).toEqual([]);
    // A url( is only one of the page's own font files, by its path in the package, which the
    // build writes under /assets/ named by its content.
    const urls = sources.flatMap(({ text }) => [...text.matchAll(/url\(([^)]*)\)/g)].map((match) => match[1]));
    expect(urls.filter((url) => !/^"\.\.\/public\/fonts\/[A-Za-z0-9]+-\d00\.woff2"$/.test(url ?? ""))).toEqual([]);
    expect(urls.map((url) => url?.slice(17, -1)).sort()).toEqual(FONT_FILES);
  });

  it("the source imports only React, react-dom and the personal contracts; the package lists no other run-time package", () => {
    // react-dom: its portal, which draws the toast inside an open sheet.
    // The kind registry's zod-free subpath: the cards' questions read it.
    const allowed = [
      "react",
      "react-dom",
      "react-dom/client",
      "@intelligence/contracts/personal",
      "@intelligence/contracts/personal/kinds",
    ];
    const imported = new Set(
      sources.flatMap(({ text }) =>
        [...text.matchAll(/\b(?:import|export)\b[^;"]*?\bfrom "([^".][^"]*)"/g)].map((match) => match[1]),
      ),
    );
    expect([...imported].filter((name) => !allowed.includes(name ?? ""))).toEqual([]);

    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies).sort()).toEqual(["@intelligence/contracts", "react", "react-dom"]);
    // The build tools, the test page and React's type packages, which ship nothing.
    expect(Object.keys(manifest.devDependencies).sort()).toEqual([
      "@types/react",
      "@types/react-dom",
      "@vitejs/plugin-react",
      "jsdom",
      "vite",
    ]);
  });
});

describe("the type check", () => {
  const read = <T>(file: string): T => JSON.parse(readFileSync(join(repository, file), "utf8")) as T;
  type Project = { compilerOptions: { lib?: string[] }; exclude?: string[] };

  it("the client has its own project with the DOM library, kept out of the root project's", () => {
    expect(read<Project>("tsconfig.json").exclude).toContain("apps/web");
    expect(read<Project>("apps/web/tsconfig.json").compilerOptions.lib).toEqual(["ES2023", "DOM", "DOM.Iterable"]);
  });

  it("pnpm typecheck checks the client's project", () => {
    const { scripts } = read<{ scripts: Record<string, string> }>("package.json");
    expect(scripts.typecheck).toContain("-p apps/web/tsconfig.json");
  });
});

describe("the content security policy", () => {
  const directives = (policy: string) =>
    Object.fromEntries(policy.split("; ").map((directive) => [directive.split(" ")[0], directive.split(" ").slice(1)]));

  it("is the dashboard's fixed policy, with connect-src 'self'", () => {
    expect(directives(CONTENT_SECURITY_POLICY)).toEqual({
      "default-src": ["'none'"],
      "script-src": ["'self'"],
      "style-src": ["'self'"],
      "connect-src": ["'self'"],
      "img-src": ["'self'", "data:"],
      "font-src": ["'self'"],
      "manifest-src": ["'self'"],
      "form-action": ["'self'"],
      "frame-ancestors": ["'none'"],
      "base-uri": ["'none'"],
      "require-trusted-types-for": ["'script'"],
    });
  });

  it("the page's copy is the same less frame-ancestors, which a meta element cannot carry", () => {
    const { "frame-ancestors": _dropped, ...rest } = directives(CONTENT_SECURITY_POLICY);
    expect(directives(PAGE_POLICY)).toEqual(rest);
  });
});

describe("the build", () => {
  // What a careless deployment might have in the environment of the build. None of it may be in
  // what the build writes.
  const SECRETS = {
    DATABASE_URL: "postgres://pi_admin:local-only@127.0.0.1:54329/pi",
    VITE_PI_KEY: "pi-key-sentinel-4f1d",
    PI_WEB_TOKEN: "web-token-sentinel-9c2e",
  };
  // Each file the build wrote; for a chunk of code, the modules in it, the chunks it imports and
  // those it loads only when asked.
  type Built = {
    fileName: string;
    text: string;
    bytes: Buffer;
    modules: string[];
    imports: string[];
    dynamicImports: string[];
    isEntry: boolean;
  };
  let files: Built[] = [];

  beforeAll(async () => {
    vi.stubEnv("NODE_ENV", "production");
    for (const [name, value] of Object.entries(SECRETS)) vi.stubEnv(name, value);
    const built = await build({
      root,
      configFile: join(root, "vite.config.ts"),
      logLevel: "silent",
      build: { write: false },
    });
    const outputs = Array.isArray(built) ? built : [built];
    files = outputs
      .flatMap((output) => ("output" in output ? output.output : []))
      .map((file) =>
        file.type === "chunk"
          ? {
              fileName: file.fileName,
              text: file.code,
              bytes: Buffer.from(file.code),
              modules: file.moduleIds,
              imports: file.imports,
              dynamicImports: file.dynamicImports,
              isEntry: file.isEntry,
            }
          : {
              fileName: file.fileName,
              text: String(file.source),
              bytes: Buffer.from(file.source),
              modules: [],
              imports: [],
              dynamicImports: [],
              isEntry: false,
            },
      );
  }, 60_000);
  afterAll(() => vi.unstubAllEnvs());

  const page = (): string => files.find((file) => file.fileName === "index.html")?.text ?? "";
  // A file's name without the hash the build gives what it writes under assets/ (eight letters,
  // digits, `_` or `-`, before the extension).
  const plain = (name: string): string =>
    name.startsWith("assets/") ? name.replace(/-[\w-]{8}(\.[a-z0-9]+)$/, "$1") : name;
  // The build's compressed copies, `<file>.br` and `<file>.gz`, each named in its file's entry.
  const copy = (name: string): boolean => /\.(br|gz)$/.test(name);
  const ROOM_FILES = ["work", "people", "self", "map", "ledger", "settings"];

  it("the built page carries the policy, before anything it loads", () => {
    const policy = `<meta http-equiv="Content-Security-Policy" content="${PAGE_POLICY.replaceAll("'", "&#39;")}">`;
    expect(page()).toContain(policy);
    const first = /<(script|link|style)\b/.exec(page());
    expect(first).not.toBeNull();
    expect(page().indexOf(policy)).toBeLessThan(first?.index ?? 0);
  });

  it("the built page loads one script, and preloads only its own code and styles, links its Home Screen manifest and icon, and holds no inline script or style", () => {
    const scripts = [...page().matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.[1]).toMatch(/\bsrc="\/assets\/[^"]+\.js"/);
    expect(scripts[0]?.[2]).toBe("");
    const links = [...page().matchAll(/<link\b[^>]*>/g)].map((link) => [
      /rel="([^"]+)"/.exec(link[0])?.[1],
      /href="([^"]+)"/.exec(link[0])?.[1],
    ]);
    const own = links.filter(([rel]) => rel === "stylesheet" || rel === "modulepreload");
    expect(own).toContainEqual(["stylesheet", expect.stringMatching(/^\/assets\/index-[\w-]{8}\.css$/)]);
    for (const [rel, href] of own)
      expect(href, rel).toMatch(rel === "stylesheet" ? /^\/assets\/[\w-]+\.css$/ : /^\/assets\/[\w-]+\.js$/);
    expect(links.filter(([rel]) => rel !== "stylesheet" && rel !== "modulepreload")).toEqual([
      ["manifest", "/manifest.webmanifest"],
      ["apple-touch-icon", "/icon-180.png"],
      ["icon", "/icon-32.png"],
      ["icon", "/icon-64.png"],
    ]);
    expect(page()).not.toMatch(/<style\b|\sstyle=|\son[a-z]+=/);
    expect(page()).not.toMatch(/https?:\/\//);
  });

  it("the first load carries the shell and Today; each other room is its own file, loaded only when opened", () => {
    const chunks = files.filter((file) => file.fileName.endsWith(".js"));
    const entry = chunks.filter((file) => file.isEntry);
    expect(entry).toHaveLength(1);
    // Every chunk the first load fetches: the entry and what it imports, at any depth.
    const first = new Set<string>();
    const visit = (name: string): void => {
      if (first.has(name)) return;
      first.add(name);
      for (const next of chunks.find((file) => file.fileName === name)?.imports ?? []) visit(next);
    };
    visit(entry[0]?.fileName ?? "");
    const loaded = chunks.filter((file) => first.has(file.fileName)).flatMap((file) => file.modules);
    expect(loaded.some((id) => id.endsWith("/src/today.tsx"))).toBe(true);
    expect(loaded.some((id) => id.endsWith("/src/shell.tsx"))).toBe(true);
    // The reader a row opens (opened.tsx) loads the first time one opens, never with the first
    // load, so the page does not preload it.
    for (const sheet of ["opened"]) {
      expect(
        loaded.filter((id) => id.endsWith(`/src/${sheet}.tsx`)),
        sheet,
      ).toEqual([]);
      const own = chunks.find((file) => file.modules.some((id) => id.endsWith(`/src/${sheet}.tsx`)));
      expect(page(), sheet).not.toContain(own?.fileName ?? "missing");
    }
    for (const room of ROOM_FILES) {
      expect(
        loaded.filter((id) => id.endsWith(`/src/rooms/${room}.tsx`)),
        room,
      ).toEqual([]);
      const own = chunks.find((file) => file.modules.some((id) => id.endsWith(`/src/rooms/${room}.tsx`)));
      expect(own?.fileName, room).toMatch(/^assets\/[\w-]+\.js$/);
      expect(entry[0]?.dynamicImports, room).toContain(own?.fileName);
    }
  });

  it("the first load fetches at most two font files, and the page shows its frame before its script runs", () => {
    expect(FONT_FILES.length).toBeLessThanOrEqual(2);
    expect(
      files
        .filter((file) => file.fileName.endsWith(".woff2"))
        .map((file) => plain(file.fileName).slice("assets/".length))
        .sort(),
    ).toEqual(FONT_FILES);
    expect(page()).toMatch(/<div id="root"><div class="boot" aria-hidden="true">/);
  });

  it("the build writes the page, its code, styles and fonts under assets/, the Home Screen files and the manifest, and nothing of the environment", () => {
    const names = files.map((file) => plain(file.fileName));
    expect(names).toEqual(
      expect.arrayContaining([
        "assets/index.css",
        "assets/index.js",
        ...ROOM_FILES.map((room) => `assets/${room}.js`),
        ...FONT_FILES.map((name) => `assets/${name}`),
        "icon-180.png",
        "icon-32.png",
        "icon-512.png",
        "icon-64.png",
        "index.html",
        "manifest.json",
        "manifest.webmanifest",
      ]),
    );
    // Nothing else but more of the page's own code and styles, and compressed copies.
    expect(names.filter((name) => !name.startsWith("assets/") && !copy(name)).sort()).toEqual([
      "icon-180.png",
      "icon-32.png",
      "icon-512.png",
      "icon-64.png",
      "index.html",
      "manifest.json",
      "manifest.webmanifest",
    ]);
    expect(
      names.filter((name) => name.startsWith("assets/") && !copy(name) && !/\.(js|css|woff2)$/.test(name)),
    ).toEqual([]);
    // pi web lets the browser keep anything under /assets/ a year, so each such file is named by a
    // hash of its content: a new build's changed file has a new name.
    const kept = files.map((file) => file.fileName).filter((name) => name.startsWith("assets/") && !copy(name));
    expect(kept.filter((name) => !/-[\w-]{8}\.(js|css|woff2)$/.test(name))).toEqual([]);
    for (const { fileName, text } of files) {
      for (const value of Object.values(SECRETS))
        expect(text.includes(value), `${fileName} holds a value of the environment`).toBe(false);
      for (const name of Object.keys(SECRETS)) expect(text.includes(name), `${fileName} names ${name}`).toBe(false);
      expect(text, fileName).not.toMatch(/postgres(ql)?:\/\/|-----BEGIN|local-only|PRIVATE KEY/);
    }
  });

  it("the manifest lists every other file the build wrote, by its url path, with its content type and its compressed copies", () => {
    const manifest = JSON.parse(files.find((file) => file.fileName === "manifest.json")?.text ?? "null") as {
      index: string;
      assets: Record<string, { file: string; type: string; br?: string; gzip?: string }>;
    };
    expect(manifest.index).toBe("index.html");
    const others = files.map((file) => file.fileName).filter((name) => name !== "manifest.json" && !copy(name));
    expect(Object.keys(manifest.assets).sort()).toEqual(others.map((name) => `/${name}`).sort());
    const types = Object.fromEntries(Object.values(manifest.assets).map(({ file, type }) => [plain(file), type]));
    expect(types).toMatchObject({
      "index.html": "text/html; charset=utf-8",
      "assets/index.js": "text/javascript; charset=utf-8",
      "assets/index.css": "text/css; charset=utf-8",
      "manifest.webmanifest": "application/manifest+json",
      "icon-180.png": "image/png",
      "icon-512.png": "image/png",
      "icon-32.png": "image/png",
      "icon-64.png": "image/png",
      ...Object.fromEntries(FONT_FILES.map((name) => [`assets/${name}`, "font/woff2"])),
    });
    for (const [path, { file }] of Object.entries(manifest.assets)) expect(path).toBe(`/${file}`);
    // Every copy is named by its file's entry and opens to exactly that file. A text file has each
    // copy that came out smaller than it (the page's own bundle, styles and html always do); a font
    // or an image, compressed already, has neither.
    const bytes = (name: string): Buffer => files.find((file) => file.fileName === name)?.bytes ?? Buffer.alloc(0);
    const named = Object.values(manifest.assets)
      .flatMap(({ br, gzip }) => [br, gzip])
      .filter((name): name is string => name !== undefined);
    expect(named.sort()).toEqual(
      files
        .map((file) => file.fileName)
        .filter(copy)
        .sort(),
    );
    for (const { file, br, gzip } of Object.values(manifest.assets)) {
      const text = /\.(html|js|css|webmanifest)$/.test(file);
      if (!text) expect([br, gzip], file).toEqual([undefined, undefined]);
      for (const [copy, ending] of [
        [br, ".br"],
        [gzip, ".gz"],
      ] as const)
        if (copy !== undefined) expect(copy, file).toBe(`${file}${ending}`);
      if (/^(index\.html|assets\/index\.(js|css))$/.test(file))
        expect([br, gzip], file).toEqual([`${file}.br`, `${file}.gz`]);
      if (br !== undefined) expect(brotliDecompressSync(bytes(br)).equals(bytes(file)), br).toBe(true);
      if (gzip !== undefined) expect(gunzipSync(bytes(gzip)).equals(bytes(file)), gzip).toBe(true);
    }
  });

  it("the Home Screen manifest opens the page standalone, names only icons the build wrote, and no service worker", () => {
    const home = JSON.parse(files.find((file) => file.fileName === "manifest.webmanifest")?.text ?? "null") as Record<
      string,
      unknown
    > & { icons: { src: string }[] };
    expect(home).toMatchObject({ start_url: "/", scope: "/", display: "standalone" });
    expect(home.icons.map((icon) => icon.src).sort()).toEqual(["/icon-180.png", "/icon-512.png"]);
    expect(Object.keys(home).filter((key) => /serviceworker|related_applications|shortcuts/i.test(key))).toEqual([]);
  });
});
