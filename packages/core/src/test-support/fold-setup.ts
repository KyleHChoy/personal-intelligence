import { useDocumentationFold } from "./domains.ts";

// Loaded for every Personal Intelligence test file, through the root test configs' setup file
// (tests/setup.ts) or as a config's own setup file. The synthetic world names its organizations
// under the documentation domains, `quarry.example.org` beside `harbor.example.org`, and the
// public-suffix rules would read both as the one organization `example.org`. This setup makes the
// process fold each name under a documentation domain to its own organization instead
// (`documentationFold` in test-support/domains.ts); production never does. No shared library's test
// loads it. A test of the vendored list alone calls `useRegistrableDomain()` and puts this back
// after it.
useDocumentationFold();
