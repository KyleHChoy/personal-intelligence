# apps/web

The owner's dashboard: the page `pi web` serves to the owner's Mac and phone. Static assets built with Vite and React.

- **May import:** `react`, `react-dom` and `@intelligence/contracts/personal` (shapes). Development only: `vite`, `@vitejs/plugin-react`, `jsdom` and React's type packages. `src/build.test.ts` fails on any other package or import.
- **Credentials:** none. It holds nothing beyond the tab's memory (W9).
- **Type check:** its own project, `tsconfig.json`, adds JSX and the DOM library. The root project excludes this folder; `pnpm typecheck` checks both.
- **Rooms:** Today, Work, People, Self, Map, Ledger, Projects, System and Settings across the top on the desk; five tabs on the phone (Today, Work, People, Self, More, which lists the rest). Each room is one file under `src/rooms/` (Today is `src/today.tsx`), with its parts beside it; `src/shell.tsx` loads each room's code when it is first opened. The search box is on every room (`src/search.tsx`).
- **Routes:** every read and write a room makes is a route of `pi web`'s registry, `apps/pi/src/web/web-routes.ts`, which is the inventory: this README does not repeat it. Names and answers are typed by the contract's table, `packages/contracts/src/personal/web-routes.ts`, which the registry serves from. A read the server refuses shows the refusal in words in its place (`src/api.ts`, the only file that calls `/api/`); what is kept of a read is `src/kept-store.ts`; a write with a toast is `src/write.ts`.
- **Shared parts:** `src/parts.tsx` (the building blocks every room uses), `src/commitments.tsx` (one commitment row everywhere), `src/opened.tsx` (a message, fact or draft opened in a sheet), `src/toast.tsx` (a done action with Undo), `src/card-kinds.ts` (one row per card kind), `src/cards.ts` and `src/card-*.ts` (the review cards' lines and order), `src/words.ts` and the `*-words.ts` files (every label shown).

- **The way in:** `src/access.tsx` shows the shell when `GET /api/session` answers, else the sign-in screen (the living sky, the app's icon and name, one glass card, `src/access.css`): "Sign in with passkey", and "Set up a passkey", where the owner pastes the link `pia web link --register` printed; every outcome (cancelled, not accepted, no passkey yet, link used or old, the box not answering, signed out after a while) is said in plain words (`src/passkey.ts` runs both ceremonies against `/passkey/*`). On the Mac the link `pia web link` prints logs in by itself.
- **Add to Home Screen:** `home-screen/` holds the web app manifest, its two icons and the browser tab's two (a tighter crop), which the build writes at `/manifest.webmanifest`, `/icon-180.png`, `/icon-512.png`, `/icon-32.png` and `/icon-64.png` and links from the page, with the home-screen app's head tags (`vite.config.ts`). No service worker. The phone's layout is `src/phone.ts` and the narrow-width rules in `src/styles.css`.

## Build

The build writes `dist/`: `index.html`, the shell and Today's script and styles, each other room's in files of its own (loaded when first opened, `src/shell.tsx`), the fonts, the Home Screen files, a brotli (`.br`) and a gzip (`.gz`) copy of each text file, and the manifest, which `pi web` reads once at start:

```json
{ "index": "index.html", "assets": { "/assets/index-<hash>.js": { "file": "assets/index-<hash>.js", "type": "text/javascript; charset=utf-8", "br": "assets/index-<hash>.js.br", "gzip": "assets/index-<hash>.js.gz" } } }
```

`assets` lists every file the build wrote but the manifest itself and the compressed copies, by URL path, with its content type and, for text, its copies; `pi web` sends the best one the browser accepts, and lets the browser keep a file under `/assets/` (named by its content) a year. A file of a kind the config does not name stops the build. It is written by the config's own plugin, not Vite's manifest, whose shape is keyed by source file.

The built page carries its content security policy first, in a `meta` element, less `frame-ancestors`, which a `meta` element cannot carry; `pi web` sends the whole policy as a header (`src/csp.ts`).

## Fonts

The design names Hanken Grotesk, Latin subset, SIL Open Font License 1.1 (`public/fonts/OFL.txt`), in two files: 400, which also draws 300, and 600, which also draws 500 to 700; titles take the system's serif. The `.woff2` files are in `public/fonts/`; `src/styles.css` names each by its path there in `@font-face` rules with system fonts after them, so the build writes it under `/assets/` named by its content (which the browser keeps, as it does the code) and lists it in the manifest as `font/woff2`. The build test allows a `url(` only for those files. Vite's own public folder is off, so nothing is copied outside the manifest.

## Design

The visual design is not in this repository: it was drawn as a mockup over the owner's real data, so it stays outside. The code is its implementation: `src/styles.css` holds the shared stylesheet, `src/parts.tsx` the building blocks, each room's stylesheet only what that room adds, and `src/sky.ts` the sky that follows the hour.
