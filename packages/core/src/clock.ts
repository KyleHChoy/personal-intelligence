// The clock a module is handed: it reads the time only through `now`, so a test can fix it.
export type Now = () => Date;

// The one real clock, the default wherever a caller gives none.
export const systemNow: Now = () => new Date();
