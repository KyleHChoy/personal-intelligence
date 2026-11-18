import type { AdminContext, TxAt } from "../core/admin-context.ts";
import type { Query } from "../core/db.ts";

// Binds a group's functions to the Admin's context, so a group states no parameter list of its own
// and a function's signature changes in one place. What a method decides, checks or refuses is in
// the function, where a direct call cannot miss it.
type Bound<First, F> = {
  [K in keyof F]: F[K] extends (first: First, ...args: infer A) => infer R ? (...args: A) => R : never;
};
type Rows<First> = Record<string, (first: First, ...args: never[]) => unknown>;

// Functions that take the context first.
export function bound<F extends Rows<AdminContext>>(context: AdminContext, functions: F): Bound<AdminContext, F> {
  return Object.fromEntries(
    Object.entries(functions).map(([name, run]) => [name, (...args: never[]) => run(context, ...args)]),
  ) as Bound<AdminContext, F>;
}

// Functions that run in one transaction of their own, taking its statements first.
export function boundQuery<F extends Rows<Query>>(context: AdminContext, functions: F): Bound<Query, F> {
  return Object.fromEntries(
    Object.entries(functions).map(([name, run]) => [
      name,
      (...args: never[]) => context.transaction((query) => Promise.resolve(run(query, ...args))),
    ]),
  ) as Bound<Query, F>;
}

// The same, taking the statements with the key file and the clock.
export function boundTx<F extends Rows<TxAt>>(context: AdminContext, functions: F): Bound<TxAt, F> {
  return Object.fromEntries(
    Object.entries(functions).map(([name, run]) => [
      name,
      (...args: never[]) =>
        context.transaction((query) =>
          Promise.resolve(run({ query, keys: context.keys, now: context.now() }, ...args)),
        ),
    ]),
  ) as Bound<TxAt, F>;
}

// Functions that run in one transaction of their own, taking its statements first and the clock last.
type BoundNow<F> = {
  [K in keyof F]: F[K] extends (query: Query, ...args: [...infer A, Date]) => infer R ? (...args: A) => R : never;
};
export function boundNow<F extends Record<string, (query: Query, ...args: never[]) => unknown>>(
  context: AdminContext,
  functions: F,
): BoundNow<F> {
  return Object.fromEntries(
    Object.entries(functions).map(([name, run]) => [
      name,
      (...args: never[]) =>
        context.transaction((query) => Promise.resolve(run(query, ...args, context.now() as never))),
    ]),
  ) as BoundNow<F>;
}

// Functions that take the context first and may erase: the Admin's in-memory indexes go when each ends.
export function boundDropping<F extends Rows<AdminContext>>(
  context: AdminContext,
  dropNames: <T>(erasure: Promise<T>) => Promise<T>,
  functions: F,
): Bound<AdminContext, F> {
  return Object.fromEntries(
    Object.entries(functions).map(([name, run]) => [
      name,
      (...args: never[]) => dropNames(run(context, ...args) as Promise<unknown>),
    ]),
  ) as Bound<AdminContext, F>;
}
