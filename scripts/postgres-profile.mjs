// THE MARK A DEVELOPMENT DATABASE CARRIES (beads ro-ujb9.76.3, ro-ujb9.76.57).
//
// A database made for development says so itself: `ALTER DATABASE … SET
// noticeos.profile = 'development'`. The development profile's tools use only
// such a database, the operator's `pnpm postgres:migrate` refuses one, and the dev seed writes invented rows
// into nothing else. The mark is named here alone, apart from the profile's
// runner, so a tool that only reads the mark (the dev seed) need not load the
// runner, which nothing but its own commands may load (the runner's guard
// test, "nothing at runtime … can reach the runner").

/** The per-database setting that carries the mark. */
export const PROFILE_SETTING = 'noticeos.profile';
/** Its value on a development database. */
export const DEVELOPMENT = 'development';
