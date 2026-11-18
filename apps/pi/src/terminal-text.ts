// Every code point a terminal could obey, or that prints nothing, written
// visibly: general categories Cc, Cf, Zl, Zp and Co, but line feed and tab, and every unpaired
// surrogate.
const OBEYED = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}]|[\uD800-\uDFFF]/gu;
export function escapeForTerminal(text: string): string {
  return text.replace(OBEYED, (one) =>
    one === "\n" || one === "\t" ? one : `<U+${(one.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}>`,
  );
}
