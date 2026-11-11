# Local task connections

The [task project guide](../docs/guides/connect-a-task-project.md) describes how a task project maps to its Ntasks project.

`installation/task-host.json` is the host's explicit project inventory. `config/task-host.json` is the product's empty default. Node services read it; it is never seeded into `config_documents`, exported from the store or compiled into the deployed Tower.

Each entry in `repositories` contains `asset`, `prefix` and `database`. The saved `config/beads.json` document controls logical project membership; a saved project with no matching host entry is listed as unavailable on this host. The optional legacy `repo` field is metadata only. Saved repository and hub fields grant no filesystem or service access.

An unavailable configuration store stops task reads explicitly; it never substitutes the exported roster.
