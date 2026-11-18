import { FetchTemplateArgs, type TemplateView } from "@intelligence/contracts/personal";
import { maskedField, maskedInUnits } from "@intelligence/personal-core";
import { placeholdersOf } from "@intelligence/personal-core/views";
import type { Ctx, Found } from "../core/read-ctx.ts";
import { parsed, type ReadTool } from "../core/read-tool.ts";
import { bodyOf, documentRow, maskedSummaryOf, windowOf } from "./read-documents.ts";

// fetch_template: a reference document of kind `doc`, read by get_document's one statement under the caller's
// token, so a hidden, held and absent id answer the same not_found. A visible document that is not a reference
// document, or not a doc, is invalid_request, decided before anything of it is opened. The text is sliced as
// get_document slices it; the placeholders are of the whole text. Its `chars` counts the slice and every
// placeholder's name and kind, as each is text served. It reads nothing else and calls no Google endpoint.
async function fetchTemplate(
  ctx: Ctx,
  args: FetchTemplateArgs,
): Promise<Found<TemplateView> | "invalid_request" | null> {
  const row = await documentRow(ctx, args.document);
  if (row === null) return null;
  if (!row.reference || row.kind !== "doc") return "invalid_request";
  const { summary: document, masked: titled } = maskedSummaryOf(ctx, row);
  const masked = bodyOf(ctx, row);
  const body = masked?.text;
  const read = { bound: [row.evidence_id], shown: [], factKeyFps: [] };
  if (body === undefined || masked === undefined)
    return {
      value: { document, text: null, offset: args.offset ?? 0, more: false, placeholders: [], ...maskedField(titled) },
      rows: 1,
      read,
      chars: 0,
    };
  const placeholders = placeholdersOf(body).map(({ ordinal, name, kind }) => ({
    ordinal,
    name: { untrusted: name },
    kind: { untrusted: kind },
  }));
  const named = placeholders.reduce(
    (sum, one) => sum + [...one.name.untrusted].length + [...one.kind.untrusted].length,
    0,
  );
  const { view, chars } = windowOf(body, args, (offset, end) => ({
    document,
    text: { untrusted: body.slice(offset, end) },
    offset,
    more: end < body.length,
    placeholders,
    ...maskedField(titled + maskedInUnits(masked.spans, offset, end)),
  }));
  return { value: view, rows: 1, read, chars: chars + named };
}

// A reference document and its placeholders, view `work`: a text
// tool, budgeted by items and code points.
export const FETCH_TEMPLATE_TOOL: ReadTool<FetchTemplateArgs, TemplateView> = {
  tool: "fetch_template",
  parse: (args) => parsed(FetchTemplateArgs.safeParse(args)),
  work: (ctx, valid) => fetchTemplate(ctx, valid),
};
