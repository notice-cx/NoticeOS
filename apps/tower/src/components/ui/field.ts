/**
 * The box every desk `<input>`, `<select>` and `<textarea>` wears: Precise's
 * field, 30px with a Border ring that turns to the accent with an Accent soft
 * halo on focus, plus the phone thumb floor and the disabled dim. An invalid
 * field (`aria-invalid`, or a call site's `ring-error`) has an Error ring,
 * which it keeps under keyboard focus beside an accent outline.
 * A string rather than a component: the call sites are three elements with
 * different props. Vary it with
 * `cn(fieldClass, …)`; tailwind-merge drops the conflicting class.
 * `test/field-chrome.test.ts` fails if the literal reappears in src/.
 * A `<select>` keeps its end padding whatever padding a call site adds: it is
 * the room the chevron (index.css) sits in.
 */
export const fieldClass =
  "h-7.5 rounded-md bg-background px-2.25 text-label text-foreground outline-none ring-1 ring-inset ring-border transition-[box-shadow] duration-[var(--brand-fast)] placeholder:text-muted-foreground max-sm:min-h-11 focus-visible:ring-primary focus-visible:shadow-[0_0_0_3px_var(--color-accent-soft)] aria-[invalid=true]:ring-error aria-[invalid=true]:focus-visible:outline-solid aria-[invalid=true]:focus-visible:outline-2 aria-[invalid=true]:focus-visible:outline-offset-2 aria-[invalid=true]:focus-visible:outline-ring disabled:opacity-45 [&:is(textarea)]:h-auto [&:is(textarea)]:py-1.5 [&:is(select)]:pe-9";

export const fieldIconClass =
  "pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground";
