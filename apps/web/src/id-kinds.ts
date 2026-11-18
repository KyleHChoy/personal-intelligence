// Whether a value is an id of a kind, by the contract's own schema, not by a copy of its format.
type Parses<T> = { safeParse(value: unknown): { success: true; data: T } | { success: false } };
export const isOf = <T>(schema: Parses<T>, value: unknown): value is T => schema.safeParse(value).success;
