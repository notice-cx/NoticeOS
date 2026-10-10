import { Navigate, useLocation, useParams } from "react-router-dom";

/**
 * `/properties/:id` → `/assets/:id`. The index one level up is a plain
 * `AliasRedirect`. `/properties` is an older spelling kept as an alias, because
 * a 404 on a path that used to answer is worse than two paths for one page.
 * The hash and the tab come along, so a deep link still lands on its section;
 * `replace` keeps the alias out of history.
 */
export function PropertyRedirect() {
  const { id = "", tab } = useParams();
  const { search, hash } = useLocation();
  const suffix = tab ? `/${encodeURIComponent(tab)}` : "";
  return (
    <Navigate
      to={`/assets/${encodeURIComponent(id)}${suffix}${search}${hash}`}
      replace
    />
  );
}

export default PropertyRedirect;
