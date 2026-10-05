# Freeze register

Surfaces inside a measurement window are immutable: rendered output is the
test, even when a proposed change looks structural. Consult this register before
changing measured copy, layout, or internal links, and include every overlapping
entry in implementation briefs. An approved exception restarts the measurement
window.

The canonical method is
[`docs/playbooks/freeze-register.md`](playbooks/freeze-register.md). A change
that starts a measurement window must create its readback bead first and add the
entry here in the same change.

## Active freezes

None registered as of 2026-08-05. A repository-wide search found no existing
freeze or readback record to migrate. This means there is no *auditable active
measurement window*; it does not retroactively claim that earlier changes were
controlled experiments.

Every active entry must record:

- the exact routes, source files, and rendered elements that are frozen;
- the change under measurement and the metric being read;
- the window's start and calendar end date; and
- an existing `ro-*` readback bead that receives evidence and owns the final
  reading.

## Closed windows

None yet. Preserve expired entries here with their readback result before
releasing the surfaces.
