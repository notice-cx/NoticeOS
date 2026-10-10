import { Navigate, useLocation } from "react-router-dom";

/**
 * An address that moved: the old path answers with the new one, and the query
 * and the hash come along, because the Tasks board keeps its filters in the
 * query and a deep link lands on a hash. `replace` keeps the alias out of
 * history, so Back goes where the operator came from rather than bouncing.
 */
export function AliasRedirect({ to }: { to: string }) {
  const { search, hash } = useLocation();
  return <Navigate to={`${to}${search}${hash}`} replace />;
}

export default AliasRedirect;
