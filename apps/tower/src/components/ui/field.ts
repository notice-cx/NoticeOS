/**
 * The box every desk `<input>`, `<select>` and `<textarea>` wears, including the
 * phone thumb floor and the disabled dim. A string rather than a component:
 * the call sites are three elements with different props. Vary it with
 * `cn(fieldClass, …)`; tailwind-merge drops the conflicting class.
 * `test/field-chrome.test.ts` fails if the literal reappears in src/.
 */
export const fieldClass =
  "rounded-md border border-input bg-background px-2 py-1 text-sm outline-none max-sm:min-h-11 focus-visible:ring-[3px] focus-visible:ring-ring disabled:opacity-60";
