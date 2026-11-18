import { type ReactNode, useEffect, useState } from "react";
import "./access.css";
import { onSignedOut, readSession, said } from "./api.ts";
import { registerPasskey, signInWithPasskey } from "./passkey.ts";
import { usePhone } from "./phone.ts";
import { Shell, useMinute, useStatusBar } from "./shell.tsx";
import { skyStyle } from "./sky.ts";

// The way in: with a session, the shell; without one, the sign-in screen, which a session ending (a
// 401 on any read or write) also brings back. On the phone, sign in with its passkey, or set one up
// with the link `pia web link --register` printed, pasted here inside the Home Screen app, which
// keeps its own cookies. On the Mac, the link `pia web link` printed logs in by itself. The screen
// is the app's: the living sky behind, the app's icon and name, one action, and every outcome in
// plain words.

// Why the sign-in screen shows, where it says more than "sign in": a session that ended while the owner
// was in, or a link login the server refused (wrong, used or old: it does not say which), which it
// marks on the page it answers with (pi's web-client.ts, LINK_REFUSED).
type Why = "ended" | "link" | null;
type State = { at: "checking" } | { at: "in" } | { at: "out"; why: Why } | { at: "failed"; code: string };
const linkRefused = (): boolean => document.querySelector('meta[name="pi-link"][content="refused"]') !== null;

export function Access() {
  const [state, setState] = useState<State>({ at: "checking" });
  const [tries, setTries] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: tries is not read inside; bumping it is how a retry runs the session check again
  useEffect(() => {
    let live = true;
    // A session that ends while the owner is in; the first look's own 401 is said as no session at all.
    onSignedOut(() => {
      if (live) setState((now) => (now.at === "in" ? { at: "out", why: "ended" } : now));
    });
    void readSession().then((answer) => {
      if (!live) return;
      if (answer.state === "ready") setState({ at: "in" });
      else if (answer.state === "failed" && answer.code !== "signed_out") setState({ at: "failed", code: answer.code });
      else setState({ at: "out", why: linkRefused() ? "link" : null });
    });
    return () => {
      live = false;
    };
  }, [tries]);
  if (state.at === "in") return <Shell />;
  if (state.at === "checking") return <Gate lede="One moment." />;
  if (state.at === "failed")
    return (
      <Gate lede="The page could not open.">
        <Note kind="trouble">{outcome(SIGN_IN, state.code).text}</Note>
        <button
          type="button"
          className="signin-go"
          onClick={() => {
            setState({ at: "checking" });
            setTries((n) => n + 1);
          }}
        >
          Try again
        </button>
      </Gate>
    );
  return <SignIn why={state.why} done={() => setState({ at: "in" })} />;
}

// What each outcome says, by what the owner was doing. A code not named here is said by `said`.
type Said = { kind: "quiet" | "trouble"; text: ReactNode };
const cmd = (text: string): ReactNode => <code className="cmdline">{text}</code>;
const SIGN_IN: Record<string, Said> = {
  // The browser's own refusal: the owner cancelled, or this device holds no passkey for the page.
  passkey_cancelled: { kind: "quiet", text: "No passkey was used. Try again, or set one up if this device has none." },
  passkey_refused: { kind: "trouble", text: "That passkey was not accepted. Try again, or set this device up again." },
  unreachable: {
    kind: "trouble",
    text: "Your box is not answering. Check this device is connected to Tailscale, then try again.",
  },
};
const SET_UP: Record<string, Said> = {
  passkey_cancelled: { kind: "quiet", text: "Setup was cancelled. The same link works until it is 5 minutes old." },
  passkey_refused: {
    kind: "trouble",
    text: "The new passkey was not accepted. Run the command again for a new link, and try once more.",
  },
  bad_code: { kind: "trouble", text: "That is not a whole setup link. Paste everything the command printed." },
  code_refused: {
    kind: "trouble",
    text: "That link has been used, or is more than 5 minutes old. Run the command again for a new one.",
  },
  no_public_key: {
    kind: "trouble",
    text: "This browser cannot make a passkey for this page. On iPhone it needs iOS 16.4 or newer.",
  },
  unreachable: SIGN_IN.unreachable as Said,
};
const ELSE: Said = {
  kind: "trouble",
  text: "Your box could not answer just now. It may be starting up: try again in a moment.",
};
const outcome = (table: Record<string, Said>, code: string): Said =>
  table[code] ?? (/^http_/.test(code) ? ELSE : { kind: "trouble", text: said(code) });

const WHY: Record<Exclude<Why, null>, Said> = {
  ended: { kind: "quiet", text: "You were signed out. Sign in again to carry on." },
  link: {
    kind: "trouble",
    text: (
      <>
        This sign-in link has been used or has expired. Run {cmd("pia web link")} for a new one, or sign in with your
        passkey.
      </>
    ),
  },
};

function SignIn({ done, why = null }: { done: () => void; why?: Why }) {
  const phone = usePhone();
  const [mode, setMode] = useState<"sign-in" | "set-up">("sign-in");
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Said | null>(why === null ? null : WHY[why]);
  const run = async (
    step: () => Promise<{ ok: true } | { ok: false; code: string }>,
    table: Record<string, Said>,
  ): Promise<void> => {
    setBusy(true);
    setNote(null);
    const answer = await step();
    setBusy(false);
    if (answer.ok) return done();
    // No passkey on the box yet, at sign-in: the way to set one up, said as the next step, not as a fault.
    if (answer.code === "no_passkey" && table === SIGN_IN) {
      setMode("set-up");
      return setNote({
        kind: "quiet",
        text: "There is no passkey yet. Set one up once, and from then on you sign in with one tap.",
      });
    }
    setNote(outcome(table, answer.code));
  };
  const turn = (to: "sign-in" | "set-up"): void => {
    setMode(to);
    setNote(null);
  };
  const setUp = (): void => {
    if (!busy && link.trim() !== "") void run(() => registerPasskey(link), SET_UP);
  };
  const device = phone ? "this phone" : "this device";

  if (mode === "set-up")
    return (
      <Gate lede={`Set up ${device}`}>
        {note === null ? null : <Note kind={note.kind}>{note.text}</Note>}
        <ol className="signin-steps">
          <li>
            <span>In your box's terminal, run {cmd("pia web link --register")}</span>
          </li>
          <li>
            <span>Paste the link it prints here.</span>
          </li>
        </ol>
        <div className="signin-form">
          <label className="signin-field">
            <span className="sr-only">Setup link</span>
            <input
              type="text"
              inputMode="url"
              placeholder="Paste the setup link"
              value={link}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="go"
              onChange={(event) => setLink(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && !event.nativeEvent.isComposing && setUp()}
            />
          </label>
          <button
            type="button"
            className="signin-go"
            disabled={busy || link.trim() === ""}
            aria-busy={busy}
            onClick={setUp}
          >
            {busy ? <Busy>Setting up</Busy> : "Set up passkey"}
          </button>
        </div>
        <button type="button" className="signin-aside" disabled={busy} onClick={() => turn("sign-in")}>
          Back to sign in
        </button>
      </Gate>
    );

  return (
    <Gate lede="Sign in to see your day.">
      {note === null ? null : <Note kind={note.kind}>{note.text}</Note>}
      <button
        type="button"
        className="signin-go"
        disabled={busy}
        aria-busy={busy}
        onClick={() => void run(signInWithPasskey, SIGN_IN)}
      >
        {busy ? <Busy>Signing in</Busy> : "Sign in with passkey"}
      </button>
      {phone || why === "link" ? null : (
        <p className="signin-also">
          On a Mac, you can also run {cmd("pia web link")} in your box's terminal and open the link it prints.
        </p>
      )}
      <button type="button" className="signin-aside" disabled={busy} onClick={() => turn("set-up")}>
        {phone ? "New phone? Set up a passkey" : "Set up a passkey on this device"}
      </button>
    </Gate>
  );
}

// The frame every state shares: the sky of this minute, the app's icon and name, a line under
// them, and the card that holds what the owner can do. A state with nothing to do shows no card.
function Gate({ lede, children }: { lede: string; children?: ReactNode }) {
  const phone = usePhone();
  const now = useMinute();
  useStatusBar(now, phone);
  return (
    <div className="app gate" style={skyStyle(now)}>
      <main className="signin" aria-labelledby="signin-title">
        <header className="signin-mark">
          <AppIcon />
          <h1 id="signin-title">Personal Intelligence</h1>
          <p>{lede}</p>
        </header>
        {children === undefined ? null : <div className="signin-card">{children}</div>}
      </main>
    </div>
  );
}

// The app's icon, as the Home Screen shows it (home-screen/icon-512.png): a dot over two arcs on a
// dawn sky, the sky in the stylesheet. Drawn here, as the page makes no image from an address.
function AppIcon() {
  return (
    <svg className="signin-icon" viewBox="0 0 512 512" aria-hidden="true">
      <g fill="#183d6e" stroke="#183d6e" strokeWidth="4" strokeLinejoin="round">
        <circle cx="256" cy="196" r="36" stroke="none" />
        <path d="M155 285 Q256 205 357 285 Q256 240 155 285 Z" />
        <path d="M119 344 Q256 218 393 344 Q256 270 119 344 Z" />
      </g>
    </svg>
  );
}

// An outcome: a quiet one (cancelled, signed out, none yet) as a status; trouble as an alert.
function Note({ kind, children }: { kind: "quiet" | "trouble"; children: ReactNode }) {
  return (
    <p className={`signin-note ${kind}`} role={kind === "trouble" ? "alert" : "status"}>
      <span>{children}</span>
    </p>
  );
}

function Busy({ children }: { children: string }) {
  return (
    <>
      <span className="signin-spin" aria-hidden="true" />
      {children}
    </>
  );
}
