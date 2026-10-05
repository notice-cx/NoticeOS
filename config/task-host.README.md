# Local task repository links

The complete [project setup guide](../docs/project-setup.md) explains this
host link alongside the saved asset/task mapping and agent CLI access.

`installation/task-host.json` is the local host's explicit checkout inventory;
`config/task-host.json` is the product's empty default, read only when the
installation has none. It is read by Node services only, never seeded into
`config_documents`, exported from the store, or compiled into the deployed Tower.

Each entry in `repositories` contains `asset`, `prefix`, `database`, and `repo`.
The repository path is absolute or relative to the NoticeOS checkout. The
saved `config/beads.json` document controls logical project membership. Its
asset, prefix and database must all match a host entry before the runner or
local task actions can execute commands in that checkout. Saved repository or
hub fields grant no local access.

A missing or mismatched link reports that the project needs local setup. Other
linked projects continue normally. An unavailable configuration store stops
project execution explicitly; it never substitutes the exported roster.

Host administrators provision the database and checkout, then add the matching
link. The local Settings setup checklist supplies an example. Saving workspace
settings does not create databases, initialize repositories, or change service
topology. Existing links reproduce the installation's previously configured
checkout paths.

Backups read physical database names from this host inventory independently of
the workspace store. Removing a project from Settings does not remove its
backup coverage. A broken checkout path does not suppress valid database names
from backups; malformed SQL identifiers are excluded by the existing backup
parser. Keep retired databases in the inventory until an explicit retention
decision authorizes their removal.
