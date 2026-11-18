// orderFault: whether a reader statement has a total order.

// A statement that names the knowledge schema, quoted or not.
export const NAMES_KNOWLEDGE = /"?knowledge"?\s*\./i;
// The schemas whose statements the order-by judge reads: knowledge, the ledger and the
// projections, which the agent records and the read tools read.
const NAMES_JUDGED = /"?(?:knowledge|ledger|projections)"?\s*\./i;

// The columns that name one row of each knowledge table.
const ROW_KEY: Readonly<Record<string, readonly string[]>> = {
  // One build row per audience.
  warmth_builds: ["audience"],
  // One day row per label, person and day; one build row per label.
  warmth_days: ["compartments", "entity_id", "day"],
  warmth_day_builds: ["compartments"],
  entities: ["id"],
  accounts: ["id"],
  domains: ["id"],
  aliases: ["id"],
  messages: ["id"],
  interaction_log: ["id"],
  events: ["id"],
  event_details: ["event_id"],
  event_participants: ["event_id", "entity_id"],
  sessions: ["id"],
  read_log: ["id"],
  agent_writes: ["id"],
  context_packs: ["id"],
  // agent_bootstrap@10's unreported section reads a
  // move joined to its opportunity by the opportunity's key.
  moves: ["id"],
  opportunities: ["id"],
  identity_rulings: ["a_fp", "b_fp"],
};

// A statement as nested parentheses: `own` is the text at this level, with each parenthesis
// replaced by "(#n)", the nth of `inner`.
type Nest = { own: string; inner: Nest[] };

function nested(text: string): Nest | null {
  const stack: Nest[] = [{ own: "", inner: [] }];
  for (const char of text) {
    const top = stack[stack.length - 1];
    if (top === undefined) return null;
    if (char === "(") {
      const child: Nest = { own: "", inner: [] };
      top.own += `(#${top.inner.length})`;
      top.inner.push(child);
      stack.push(child);
    } else if (char === ")") {
      if (stack.length === 1) return null;
      stack.pop();
    } else {
      top.own += char;
    }
  }
  const [root] = stack;
  if (stack.length !== 1 || root === undefined) return null;
  const tidy = (nest: Nest): void => {
    nest.own = nest.own.replaceAll(/\s+/g, " ").trim();
    nest.inner.forEach(tidy);
  };
  tidy(root);
  return root;
}

const SET_OPERATION = /\b(union|intersect|except)\b/;
const ORDERED_AGGREGATE = /\b(array_agg|string_agg|json_agg|jsonb_agg|json_object_agg|jsonb_object_agg) ?\(#(\d+)\)/g;
const AGGREGATE =
  /\b(count|min|max|sum|avg|bool_or|bool_and|every|array_agg|string_agg|json_agg|jsonb_agg|json_object_agg|jsonb_object_agg) ?\(#\d+\)(?! ?over\b)/;
const NOT_AN_ALIAS = new Set([
  "on",
  "join",
  "left",
  "right",
  "inner",
  "outer",
  "cross",
  "full",
  "natural",
  "where",
  "using",
  "lateral",
  "group",
  "order",
  "limit",
]);

const isSelect = (nest: Nest): boolean =>
  /^(select|with)\b/.test(nest.own) || (SET_OPERATION.test(nest.own) && /\(#\d+\)|\bselect\b/.test(nest.own));

// The terms of an `order by`, each without its direction, its nulls rule, its collation and its cast.
const orderTerms = (clause: string): string[] =>
  clause.split(",").map((term) =>
    term
      .trim()
      .replace(/ nulls (first|last)$/, "")
      .replace(/ (asc|desc)$/, "")
      .replace(/ collate \S+$/, "")
      .replace(/::\w+$/, "")
      .trim(),
  );

// The clauses of one select at its own level.
function clauses(own: string): Record<string, string> {
  const found: Record<string, string> = {};
  const marks = [...` ${own} `.matchAll(/ (from|where|group by|having|window|order by|limit|offset|fetch) /g)];
  const padded = ` ${own} `;
  found.select = padded.slice(0, marks[0]?.index ?? padded.length).trim();
  marks.forEach((mark, index) => {
    const name = mark[1] ?? "";
    const start = (mark.index ?? 0) + mark[0].length;
    if (found[name] === undefined) found[name] = padded.slice(start, marks[index + 1]?.index ?? padded.length).trim();
  });
  return found;
}

type Relation = { alias: string; key: readonly string[] | null };

// The relations a `from` clause reads: a knowledge table with its key, or anything else (a CTE,
// a derived table, a function), whose key the text does not show.
function relations(from: string): Relation[] {
  const found: Relation[] = [];
  for (const match of from.matchAll(
    /(?:^|\bjoin |, ?)(?:lateral )?((?:knowledge|ledger|projections)\.(\w+)|\w+(?:\.\w+)?(?: ?\(#\d+\))?|\(#\d+\))(?: (?:as )?(\w+))?/g,
  )) {
    const alias = match[3] !== undefined && !NOT_AN_ALIAS.has(match[3]) ? match[3] : (match[2] ?? match[1] ?? "");
    found.push({
      alias,
      key: match[2] === undefined ? (CTE_KEY.get(match[1] ?? "") ?? null) : (ROW_KEY[match[2]] ?? null),
    });
  }
  return found;
}

// The relations whose rows a select's result has one of per row of the others: those whose whole
// key the conditions set equal to a parameter or to another relation's column. What is left
// are the relations whose keys name a row of the result.
function unpinned(all: Relation[], conditions: string): { rows: Relation[]; equal: Map<string, Set<string>> } {
  const equal = new Map<string, Set<string>>();
  if (/ or /.test(` ${conditions} `)) return { rows: all, equal };
  const note = (column: string, other: string): void => {
    const set = equal.get(column) ?? new Set<string>();
    set.add(other);
    equal.set(column, set);
  };
  for (const match of conditions.matchAll(/((?:\w+\.)?\w+)(?:::\w+)? ?= ?(\$\d+|(?:\w+\.)?\w+)(?:::\w+)?(?! ?\(#)/g)) {
    const [left, right] = [match[1] ?? "", match[2] ?? ""];
    if (/^(any|all|some)$/.test(right)) continue;
    note(left, right);
    if (!right.startsWith("$")) note(right, left);
  }
  const single = all.length === 1;
  const pinnedBy = new Map<string, Set<string>>();
  const left = [...all];
  let moved = true;
  while (moved) {
    moved = false;
    for (const one of left) {
      if (one.key === null) continue;
      const by = new Set<string>();
      const whole = one.key.every((column) => {
        const others = [...(equal.get(`${one.alias}.${column}`) ?? []), ...(single ? (equal.get(column) ?? []) : [])];
        const usable = others.find(
          (other) =>
            other.startsWith("$") ||
            (other.includes(".") &&
              !other.startsWith(`${one.alias}.`) &&
              !pinnedBy.get(other.split(".")[0] ?? "")?.has(one.alias)),
        );
        if (usable === undefined) return false;
        if (!usable.startsWith("$")) by.add(usable.split(".")[0] ?? "");
        return true;
      });
      if (!whole) continue;
      pinnedBy.set(one.alias, by);
      left.splice(left.indexOf(one), 1);
      moved = true;
      break;
    }
  }
  return { rows: left, equal };
}

// Whether the terms name the key of every relation in `rows`, by its own name: a position or an
// output alias is not accepted, since the text alone does not show what it stands for. A
// relation whose key is unknown needs a term of its own called `id` or ending `_id`.
// A column the conditions set equal to the key column stands for it.
function keyed(terms: string[], rows: Relation[], single: boolean, equal: Map<string, Set<string>>): boolean {
  const has = (alias: string, column: string): boolean =>
    terms.includes(`${alias}.${column}`) ||
    ["knowledge", "ledger", "projections"].some((schema) => terms.includes(`${schema}.${alias}.${column}`)) ||
    (single && terms.includes(column)) ||
    [...(equal.get(`${alias}.${column}`) ?? [])].some((other) => terms.includes(other));
  return rows.every((one) =>
    one.key === null
      ? terms.some((term) => new RegExp(`^(${one.alias}\\.)${single ? "?" : ""}(\\w+_)?id$`).test(term))
      : one.key.every((column) => has(one.alias, column)),
  );
}

// `watched` is whether the order of this select's rows can be seen: it is the statement itself,
// it is cut by a `limit`, or it fills an array.
function judge(nest: Nest, watched: boolean, faults: string[]): void {
  const own = nest.own;
  const select = isSelect(nest);

  nest.inner.forEach((child, index) => {
    const before = own.slice(0, own.indexOf(`(#${index})`));
    judge(child, select && /\barray ?$/.test(before), faults);
  });
  if (!select) return;

  if (SET_OPERATION.test(own)) {
    const tail = own.slice(
      Math.max(own.lastIndexOf(" union "), own.lastIndexOf(" intersect "), own.lastIndexOf(" except ")),
    );
    const cut = / (limit|offset|fetch) /.test(`${tail} `);
    if (!watched && !cut) return;
    const order = clauses(tail)["order by"];
    if (order === undefined) faults.push("a set operation with no order by");
    else if (!orderTerms(order).some((term) => /^(\w+_)?id$/.test(term)))
      faults.push("a set operation ordered by no id");
    return;
  }

  const main = own.slice(own.search(/\bselect\b/));
  const part = clauses(main);
  const all = part.from === undefined ? [] : relations(part.from);
  const { rows, equal } = unpinned(all, `${part.from ?? ""} and ${part.where ?? ""}`);
  const single = all.length === 1;

  // An aggregate that keeps the order of its input needs an order of its own, by a key.
  for (const match of main.matchAll(ORDERED_AGGREGATE)) {
    const inside = nest.inner[Number(match[2])]?.own ?? "";
    const at = inside.lastIndexOf(" order by ");
    // A distinct aggregate ordered by its one argument alone: its values are unique, so that order is total.
    const distinct = /^\s*distinct ([\w.]+) order by ([\w.]+)\s*$/.exec(inside);
    if (distinct !== null && distinct[1] === distinct[2]) continue;
    if (at < 0 || !keyed(orderTerms(inside.slice(at + " order by ".length)), rows, single, equal))
      faults.push(`${match[1]} with no order by a key`);
  }

  const cut = part.limit !== undefined || part.offset !== undefined || part.fetch !== undefined;
  if (!watched && !cut) return;
  // At most one row: nothing read, every relation named by its key, or one aggregate over all.
  if (part.from === undefined || rows.length === 0) return;
  if (part["group by"] === undefined && AGGREGATE.test(part.select ?? "")) return;

  if (part["order by"] === undefined) {
    faults.push("no order by");
    return;
  }
  const terms = orderTerms(part["order by"]);
  if (part["group by"] !== undefined) {
    if (!orderTerms(part["group by"]).every((term) => terms.includes(term)))
      faults.push("an order by that leaves out a group by term");
  } else if (/^select distinct(?! on\b)/.test(part.select ?? "")) {
    const listed = (part.select ?? "")
      .replace(/^select distinct /, "")
      .split(",")
      .map((item) => item.trim().replace(/ as \w+$/, ""));
    if (!listed.every((item) => terms.includes(item))) faults.push("a distinct select ordered by less than its list");
  } else if (!keyed(terms, rows, single, equal)) {
    faults.push("an order by that names no unique key");
  }
}

// Only a statement that names the knowledge, ledger or projections schema is judged; such a
// statement must be a select.
//
// A select whose row order can be seen (the statement itself, a select cut by `limit`, `offset`
// or `fetch` at any depth, a select that fills an `array(...)`) must end in an `order by` that
// names, by its own name, the key of every relation whose rows it returns several of: `id`,
// `event_id` for event_details, `event_id` and `entity_id` for event_participants. A relation
// is left out when the conditions set its whole key equal to a parameter or to a column of
// another relation (a join to at most one row). With `group by`, the order must name every
// grouping term; a set operation must end in an `order by` that names an id. A `distinct on`
// is held to the rule of any select: its `order by` also decides which row of each group is
// kept, so it must name the key of the rows it returns. It returns at most
// one row, and needs no order, when it reads from nothing, when every relation is named by its
// key, or when it is aggregates alone with no `group by`. An aggregate that keeps its input's
// order (array_agg and its like) needs an `order by` of its own, by a key, wherever it stands.
//
// What the text cannot show: whether a CTE's or a derived table's `id` is unique, and what a
// position or an output alias in an `order by` stands for. The first passes on an `id` term,
// the second is refused. The store with its rows written against id order (seedPublic,
// `reversed`) holds the rule by behaviour, without reading any SQL.
export function orderFault(text: string): string | null {
  const bare = text
    .replaceAll(/\/\*[\s\S]*?\*\//g, " ")
    .replaceAll(/--[^\n]*/g, " ")
    .replace(/;\s*$/, "");
  if (!NAMES_JUDGED.test(bare)) return null;
  const plain = bare
    .replaceAll(/'(?:[^']|'')*'/g, "''")
    .replaceAll(/"(\w+)"/g, "$1")
    .toLowerCase()
    .replaceAll(/\s*\.\s*/g, ".");
  const root = nested(plain);
  if (root === null) return "its parentheses do not balance";
  if (!isSelect(root)) return "a statement that names a judged schema and is no select";
  const faults: string[] = [];
  cteKeys(root);
  try {
    judge(root, true, faults);
  } finally {
    CTE_KEY.clear();
  }
  return faults[0] ?? null;
}

// The key of a statement's `with` query, where its text shows one: a grouped read is keyed by what
// it is grouped by, a distinct read by its columns, and a plain read of one table that selects that
// table's key keeps it. Any other has none.
const CTE_KEY = new Map<string, readonly string[]>();
function cteKeys(root: Nest): void {
  for (const match of root.own.matchAll(/(?:\bwith |, ?)(\w+) as (?:(?:not )?materialized )?\(#(\d+)\)/g)) {
    const body = root.inner[Number(match[2])]?.own ?? "";
    if (/\b(union|intersect|except)\b/.test(body)) continue;
    const grouped = /\bgroup by ([\w., ]+?)$/.exec(body);
    if (grouped !== null) {
      CTE_KEY.set(
        match[1] ?? "",
        (grouped[1] ?? "").split(/, ?/).map((term) => term.split(".").at(-1) ?? ""),
      );
      continue;
    }
    if (/\b(join|distinct on)\b|, ?(knowledge|ledger|projections)\./.test(body)) continue;
    const table =
      /^select (distinct )?([\w., ]+) from (?:knowledge|ledger|projections)\.(\w+)(?: (?:as )?\w+)?(?: where .*)?$/.exec(
        body,
      );
    if (table === null) continue;
    const columns = (table[2] ?? "").split(/, ?/).map((term) => term.split(".").at(-1) ?? "");
    const key = table[1] !== undefined ? columns : ROW_KEY[table[3] ?? ""];
    if (key?.every((column) => columns.includes(column))) CTE_KEY.set(match[1] ?? "", key);
  }
}
