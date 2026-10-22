/** Whitespace separates literal terms; every term must occur in the title or
 * id. Punctuation stays literal, and matching never reads task descriptions. */
export function taskSearch(query: string): (task: { title: string; id: string }) => boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return (task) => {
    const title = task.title.toLowerCase();
    const id = task.id.toLowerCase();
    return terms.every(term => title.includes(term) || id.includes(term));
  };
}
