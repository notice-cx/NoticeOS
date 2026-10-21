# Local task connections

The [task project guide](../docs/guides/connect-a-task-project.md) describes the canonical connection shared by MCP, native Tasks, snapshots and review filing.

`installation/task-host.json` is the host's explicit database inventory. `config/task-host.json` is the product's empty default. Node services read it; it is never seeded into `config_documents`, exported from the store or compiled into the deployed Tower.

Each entry in `repositories` contains `asset`, `prefix` and `database`. The saved `config/beads.json` document controls logical project membership. All three names must match a host entry before execution. The optional legacy `repo` field is metadata only: task clients run in installation-owned folders, never in project checkouts. Saved repository and hub fields grant no filesystem or service access.

The shared resolver generates private `.beads/config.yaml` and `metadata.json` under the installation's `task-projects/` folder, using the canonical database and prefix and the declared client connection. Different bindings have immutable directories. Configuration contains no credentials, enables server mode and disables automatic imports, exports and Git operations. Resolution never initializes or migrates a database.

A missing or mismatched connection leaves that project unavailable while other projects run. An unavailable configuration store stops execution explicitly; it never substitutes the exported roster. Host administrators provision databases separately and record matching inventory entries. No checkout path is required.

Backups read physical database names from this inventory independently of the workspace store. Removing a project from Settings does not remove its backup coverage. Keep retired databases in the inventory until an explicit retention decision authorizes removal. Malformed SQL identifiers remain excluded by the existing backup parser.
