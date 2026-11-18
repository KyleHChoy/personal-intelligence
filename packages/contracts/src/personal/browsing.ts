import { z } from "zod";
import { Timestamp } from "../ids.ts";
import { deepFreeze } from "./capture-forms.ts";
import { PersonalCompartment } from "./compartments.ts";
import { CaptureAccountId, CaptureExcludeId, ClientName } from "./ids.ts";

// Browsing on a deny-list. A device's mode, the owner's exclude list and the owner's account map live on
// the box alone, which decides; Lens sends its blocks unchanged, and its scope helper reads the mode,
// never a value. Only personal code imports these.

// `allow`, the default, admits a block only by a scope rule; `deny` also admits one by default.
export const LensBrowsingMode = z.enum(["allow", "deny"]);
export type LensBrowsingMode = z.infer<typeof LensBrowsingMode>;

// Lens holds the same list; the box keeps its own copy, since the box alone applies the default and
// Lens reads none of this. Products, not data; extended by a commit.
export const SIGN_IN_WORDS: readonly string[] = deepFreeze([
  "login",
  "log-in",
  "signin",
  "sign-in",
  "sign_in",
  "oauth",
  "oauth2",
  "callback",
  "token",
  "auth",
  "authorize",
  "sso",
  "reset",
  "reset-password",
  "password-reset",
  "invite",
  "invitation",
  "verify",
  "magic-link",
  "unsubscribe",
]);

// The `capture_scope` normal form (packages/store/src/core/keys.ts): case-folded, any trailing dot dropped.
const normal = (value: string): string => value.toLowerCase().replace(/\.+$/, "");

export const SIGN_IN_HOST_WORDS: readonly string[] = deepFreeze([
  "accounts",
  "account",
  "id",
  "identity",
  "signup",
  "sign-up",
  "appleid",
  "passport",
]);

export const isSignInHost = (host: string): boolean => {
  const first = normal(host).split(".")[0] ?? "";
  return SIGN_IN_WORDS.includes(first) || SIGN_IN_HOST_WORDS.includes(first);
};

// A URL that does not parse counts as one, on purpose: the default fails closed (Lens's function
// answers false there, and leaves the page to the box).
export const isSignInUrl = (url: string): boolean => {
  const parsed = URL.parse(url);
  if (parsed === null) return true;
  return (
    isSignInHost(parsed.hostname) ||
    parsed.pathname.split("/").some((segment) => SIGN_IN_WORDS.includes(segment.toLowerCase()))
  );
};

// The default never admits a block or a page on one, or on a host under one: an agent's
// conversation titles are agent output, which an agent-app rule admits on the owner's word alone.
// An agent site not on the list is admitted as a plain block, as the scope helper's time-only rules
// admit it: a known limit. Products, not data; extended by a commit.
export const AGENT_HOSTS: readonly string[] = deepFreeze([
  "claude.ai",
  "chatgpt.com",
  "chat.openai.com",
  "gemini.google.com",
  "perplexity.ai",
  "copilot.microsoft.com",
  "grok.com",
  "chat.mistral.ai",
  "chat.deepseek.com",
  "poe.com",
]);

export const excludeSuffixes = (host: string): string[] => {
  const labels = normal(host).split(".");
  const out: string[] = [];
  for (let i = 0; i < labels.length - 1; i++) out.push(labels.slice(i).join("."));
  return out;
};

export const isExcluded = (host: string, excludes: readonly string[]): boolean =>
  excludeSuffixes(host).some((suffix) => excludes.includes(suffix));

export const isAgentHost = (host: string): boolean => isExcluded(host, AGENT_HOSTS);

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
export const ExcludeHost = z
  .string()
  .max(253)
  .regex(new RegExp(`^${LABEL}(?:\\.${LABEL})+$`));
export type ExcludeHost = z.infer<typeof ExcludeHost>;

const CONTROL = /\p{Cc}/u;
export const MappedAccount = z
  .string()
  .min(1)
  .max(320)
  .refine((value) => !CONTROL.test(value), { message: "a control character" })
  .refine((value) => normal(value) === value, { message: "not in the normal form" });
export type MappedAccount = z.infer<typeof MappedAccount>;

export const MappedCompartment = PersonalCompartment.refine(
  (value) => value === "own" || (value.startsWith("employer:") && !value.endsWith("-released")),
  {
    message: "own or an employer's compartment",
  },
);
export type MappedCompartment = z.infer<typeof MappedCompartment>;

// No value. Lens's scope helper reads `mode` from it.
export const LensBrowsingView = z.strictObject({
  device: ClientName,
  mode: LensBrowsingMode,
  excludes: z.number().int().min(0),
  accounts: z.number().int().min(0),
});
export type LensBrowsingView = z.infer<typeof LensBrowsingView>;

// The value is sealed and not in the view; `--show` prints it beside, to a terminal only.
export const CaptureExcludeView = z.strictObject({ id: CaptureExcludeId, createdAt: Timestamp });
export type CaptureExcludeView = z.infer<typeof CaptureExcludeView>;
export const CaptureAccountView = z.strictObject({
  id: CaptureAccountId,
  compartment: MappedCompartment,
  createdAt: Timestamp,
});
export type CaptureAccountView = z.infer<typeof CaptureAccountView>;
