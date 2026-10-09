import { Navigate, useLocation, useParams } from "react-router-dom";

/**
 * `/properties/:id` → `/assets/:id`. The index one level up, `/properties` →
 * `/assets`, is a plain `AliasRedirect`.
 *
 * `/assets` is the canonical address and the UI now says Assets too (D20, bead
 * `ro-pbzu.6`). `/properties` is the spelling doc 14 asked for between
 * 2026-07-06 and the decision, and it stays an alias forever: the Tower has
 * emitted `/properties` links into notes, bookmarks and commit messages, and a
 * 404 on a path that used to answer is worse than two paths for one page.
 *
 * The hash comes along: the Tower's deep links are the whole point — an alert's
 * change chip lands on `#timeline`, a matrix cell on `#integrations` — and a
 * redirect that dropped it would land the operator at the top of a very long
 * page with no idea what they were sent to see. `replace` keeps the alias out of
 * history, so Back goes where the operator came from rather than bouncing.
 */
export function PropertyRedirect() {
  const { id = "", tab } = useParams();
  const { search, hash } = useLocation();
  // The tab comes along too (bead `ro-pbzu.4`): `/properties/:id/sources` is a
  // link the Tower can emit, and dropping the segment would land the operator
  // on Overview wondering what they were sent to see.
  const suffix = tab ? `/${encodeURIComponent(tab)}` : "";
  return (
    <Navigate
      to={`/assets/${encodeURIComponent(id)}${suffix}${search}${hash}`}
      replace
    />
  );
}

export default PropertyRedirect;
