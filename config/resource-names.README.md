# The names an older installation's store was made under

`installation/resource-names.json` exists only in an installation whose
R2 bucket was created under a name other than the one the
checked-in Worker configs carry (`workers/ingest/wrangler.jsonc`,
`apps/tower/wrangler.jsonc`). A new installation has no such file and needs
none: it is born with the NoticeOS names
([`scripts/resource-names.mts`](../scripts/resource-names.mts)).

```json
{ "rawSignalsBucket": "example-raw-signals" }
```

- **`rawSignalsBucket`** — the R2 bucket bound as `RAW_SIGNALS`. miniflare keeps
  local objects under the bucket's name, so this is what keeps the archives
  collected before a rename in view.
- A missing `rawSignalsBucket` keeps the checked-in name. Historical files may
  still contain `database`; it is accepted as inert metadata and changes no
  binding. The operational store is Postgres.

Read by Node only — the Tower's dev server applies it over both Worker configs
(`apps/tower/vite.config.ts`, through `scripts/resource-names.mts`
`readResourceNames`), and `pnpm signals:download` asks for that bucket — never
seeded into settings or exported from the store. A file that is not
valid JSON, or names another key, stops the Tower from starting rather than
opening an empty bucket beside the archives. Changing it moves nothing: renaming
a live resource is the operator's (docs/06-operations.md § Legacy names).
