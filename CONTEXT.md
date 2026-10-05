# NoticeOS

The language of the portfolio operating system and its evidence. This glossary is for operators and contributors; it changes when a domain term is resolved and is retired when the context it describes is retired.

## Language

### Workspaces and authority

**Workspace**:
The boundary that owns a portfolio's assets, evidence, integrations and work. A person may belong to several workspaces without sharing their data or authority between them.

**Tenant**:
A workspace considered as an isolation boundary. The product calls it a workspace; a deployment may serve one or many.

**Principal**:
The identity to which trusted admission assigns authority for an action, including an anonymous demo reader's limited access. A display name or a task's actor label is not proof of that authority.

**Membership**:
A person's current role in one workspace. Membership in one workspace does not grant access to another.

**Service principal**:
A service identity authorized for specific work in a workspace. A queued job retains its owner but must still be authorized when it runs.

**Deployment**:
A running installation of NoticeOS and its supporting services. Platform maintenance belongs to the deployment, not to a customer workspace.

**Demo workspace**:
A real workspace containing explicitly synthetic assets and evidence. Public visitors can explore it; a separate simulator supplies its ongoing activity.

### Assets and configuration

**Asset identifier**:
The stable identity that links an asset to its history. A website asset's identifier is derived from its domain when it is added through the Tower.

**Asset domain**:
The canonical hostname of an asset's website. An asset that is not a website may have an identifier without a domain.

**Configuration asset reference**:
A reference naming the asset that a setting belongs to. Declaring a reference does not create the asset or establish that it exists.

**Changeset**:
A set of requested configuration edits that states the values or absences the writer relied on.

**Confirmed asset operation**:
An asset operation whose write was acknowledged for the requested asset. A duplicate or missing response does not establish that this operation performed the write.

**Incomplete asset setup**:
An asset whose creation was confirmed but whose requested configuration has not been confirmed.

**Archived asset**:
An asset taken out of collection and off the desk, with its history and its domain kept. It is the one way out: an asset is never deleted, and restoring one returns it to the stage it left.

### Integration evidence

**Loaded evidence**:
Observations that were requested and read. An empty result means no matching observation was recorded; it differs from evidence that was not requested.

**Effective integration state**:
The current state supported by a lane's observations, within its declared applicability. Setup intent and observations are distinct facts.

**Connection revision**:
The version of a provider connection that a collection used. Reconnecting a provider does not change the connection revision of an attempt already underway.

**Collection attempt**:
One attempt to collect a report or signal for a target, bound to the connection captured before collection began.

**Monitoring availability**:
Whether evidence about collection could be recorded. Collection can succeed while its monitoring is unavailable.

### Work and task evidence

**Task**:
A piece of work coordinated by NoticeOS, whether it concerns the system itself or a managed project. Tasks share a model for status, ownership, dependencies, approval gates and completion evidence; completing a task does not establish a business outcome.
_Avoid_: External ticket as the universal work model

**Task hub**:
The central authority for all work coordinated by NoticeOS, including work originating in an external tool. Projects organize work within this authority.
_Avoid_: Optional task source

**External task integration**:
A connection that maps work between an external tool and the NoticeOS task model. The external tool's workflow does not replace the common model.

**Task handoff**:
The transfer of responsibility for a task between people or agents, including agents using different tools. The same task record preserves its identity, current state, dependencies and evidence across the handoff.
_Avoid_: Markdown handoff as the task register

**Live task read**:
A successful read directly from one project's task database, with every task in its stated scope and closed-history window. Its timestamp is when the database was read.

**Saved task sample**:
A saved selection of task rows accompanied by counts over the full snapshot. The listed rows do not establish complete history or permission to act on a task.

**Actionable task read**:
A successful local read for the task's own project while the local action capability is available. Another project's successful read does not make a saved sample actionable.

### Backup evidence

**Backup set**:
The local copies and restore instructions produced by one backup run, with the completeness of each store recorded. A set can be incomplete.

**Backup run**:
One attempt to produce a backup set and complete its configured offsite handoff. A complete run has completed every required copy, its restore instructions, and the handoff when configured.
_Avoid_: Verified backup

**Offsite handoff**:
A completed copy of the backup set into the configured synchronization destination. It does not establish that remote synchronization has finished.
_Avoid_: Offsite verified

**Restore verification**:
Evidence that a backup set was successfully restored and checked. Completing a backup run does not establish restore verification.
