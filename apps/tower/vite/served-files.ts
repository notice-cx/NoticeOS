// The files the Tower's dev server never sends, whatever path asks for them.
//
// Vite serves files under the checkout through /@fs/, and the app image links
// the installation's state into the checkout (.local, .wrangler and
// workers/ingest/.dev.secrets.json point into /state), so a path inside the
// checkout can reach the bootstrap secrets, the runner's logs and records and
// the local stores. Each name below is refused at any depth. Vite's own
// defaults stay on the list, because a list given here replaces them. The one
// part of .local that is served is the dependency cache the container keeps
// there (NOTICEOS_VITE_CACHE_DIR).

/** Vite's default `server.fs.deny`. */
export const VITE_DEFAULT_DENY = [".env", ".env.*", "*.{crt,pem,key,p12,pfx,cer,der}", ".npmrc", ".yarnrc.yml", "**/.git/**"];

/** `server.fs.deny` for the Tower's dev server. */
export const TOWER_DENY = [
  ...VITE_DEFAULT_DENY,
  ".dev.secrets.json",
  ".dev.vars",
  ".dev.vars.*",
  "**/.wrangler/**",
  "**/.local/*",
  "**/.local/!(vite-cache)/**",
  "**/.beads/**",
];
