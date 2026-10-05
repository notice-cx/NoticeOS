import { Navigate, useLocation } from "react-router-dom";

/**
 * An address that moved: the old path answers with the new one, and the query
 * and the hash come along.
 *
 * `/properties` → `/assets` (D20) and `/work` → `/tasks` (D19) are aliases
 * forever, because notes, commit messages and Home tiles emitted before the
 * rename still carry them. What those links point at is usually more than the
 * page: the Tasks board keeps its filters in the query (`?status=blocked`) and
 * a deep link lands on a hash, so a redirect that dropped either would open a
 * different view than the one the link was written for (bead `ro-ujb9.198`).
 * `replace` keeps the alias out of history, so Back goes where the operator came
 * from rather than bouncing.
 */
export function AliasRedirect({ to }: { to: string }) {
  const { search, hash } = useLocation();
  return <Navigate to={`${to}${search}${hash}`} replace />;
}

export default AliasRedirect;
