import { useRegistrableDomain } from "../domains.ts";
import { registrableDomain } from "../public-suffix.ts";

// The fold the repository's tests run with. The synthetic data names its organizations under IANA's
// documentation domains (RFC 2606, RFC 6761), which no real organization holds:
// `quarry.example.org` beside `harbor.example.org`. Under the vendored list alone both fold to
// `example.org`, one organization, which would change what those tests prove. Here a name under a
// documentation domain folds to one label below it, as a name under a public suffix does, and the
// domain itself stays one; every other host takes the vendored list. It lives in test code alone:
// production folds by the list and never by a domain's name.
const DOCUMENTATION_DOMAINS: readonly string[] = ["example.com", "example.net", "example.org"];

export function documentationFold(host: string): string | null {
  const documentation = DOCUMENTATION_DOMAINS.find((one) => host.toLowerCase().endsWith(`.${one}`));
  if (documentation === undefined) return registrableDomain(host);
  const labels = host.split(".");
  return labels.some((label) => label === "")
    ? null
    : labels
        .slice(-(documentation.split(".").length + 1))
        .join(".")
        .toLowerCase();
}

// Installs it in this process: the test runner's setup file (`fold-setup.ts`) and the preload of
// a spawned `pi` call it.
export function useDocumentationFold(): void {
  useRegistrableDomain(documentationFold);
}

// The setup file's URL, for a spawned process: `node --import FOLD_SETUP main.ts ...` folds as the
// test that spawned it does.
export const FOLD_SETUP = new URL("./fold-setup.ts", import.meta.url).href;
