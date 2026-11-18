// The content security policy of the owner's dashboard. `pi web` sends it as a header on every
// answer; the build also writes it first into the page, less frame-ancestors, which a policy in a
// meta element cannot carry.
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "manifest-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "require-trusted-types-for 'script'",
].join("; ");

export const PAGE_POLICY = CONTENT_SECURITY_POLICY.split("; ")
  .filter((directive) => !directive.startsWith("frame-ancestors "))
  .join("; ");
