import { z } from "zod";
import { CaptureKey } from "./ids.ts";

// The field forms the capture shapes share (capture.ts and its siblings): bounded text, a host, a
// revision, a key of one kind, a URL, a document path, a repository and minutes. Not on the package
// root; HOST_FORM is, through the index.

export const codePoints = (text: string): number => [...text].length;
// A control character other than tab and line feed. NUL is one.
const CONTROL = /[^\P{Cc}\t\n]/u;

// Bounded(n): 1 to n code points, no NUL and no control character but tab and line feed. Zod's
// string min and max count code points.
export const bounded = (most: number) =>
  z
    .string()
    .min(1)
    .max(most)
    .refine((value) => !CONTROL.test(value), { message: "a control character" });

// A host name of at most 253 characters: dot-separated labels of letters, digits and hyphens.
const LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";
export const HOST_FORM = new RegExp(`^${LABEL}(?:\\.${LABEL})*\\.?$`);
export const host = z.string().max(253).regex(HOST_FORM);

export const revision = z.number().int().min(0).max(1000);
export const keyOf = (kind: "meeting" | "moment" | "block" | "task" | "forget") =>
  CaptureKey.refine((key) => key.startsWith(`${kind}:`), { message: `a ${kind} key` });

export const utf8Bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;
export const span = (from: string, to: string): number => Date.parse(to) - Date.parse(from);
export const ordered = { message: "an end not before its start", path: ["end"] };

// Even an empty query or fragment is refused. Its bound is 2048 UTF-16 code units, the one bound
// here not in code points: zod's max counts code points.
export const momentUrl = z
  .string()
  .refine((text) => text.length <= 2048, { message: "at most 2048 UTF-16 code units" })
  .refine(
    (text) => {
      if (/[\s?#]/.test(text) || CONTROL.test(text)) return false;
      const url = URL.parse(text);
      return (
        url !== null &&
        (url.protocol === "https:" || url.protocol === "http:") &&
        url.hostname !== "" &&
        url.username === "" &&
        url.password === ""
      );
    },
    { message: "an http or https URL with no user, password, query or fragment" },
  );

export const documentPath = z
  .string()
  .refine((path) => codePoints(path) <= 1024, { message: "at most 1024 characters" })
  .refine((path) => (path.startsWith("~/") || path.startsWith("/")) && !CONTROL.test(path), {
    message: "a path from ~/ or /",
  })
  .refine((path) => path.split("/").every((segment) => segment !== "." && segment !== ".."), {
    message: "no . or .. segment",
  });

export const repository = z.string().regex(/^[a-z0-9.-]+\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/);

// Minutes from 0 to 1440, with at most one decimal.
export const minutes = z
  .number()
  .min(0)
  .max(1440)
  .refine((value) => Math.abs(value * 10 - Math.round(value * 10)) < 1e-9, { message: "at most one decimal" });
