import { useNavigate } from "react-router-dom";
import { AddSiteSheet } from "@/components/AddSite";
import { AssetsRoute } from "@/routes/AssetsRoute";

/**
 * `/assets/new` — Add a site, as an address (bead `ro-qsoo`; one screen since
 * `ro-ujb9.96.7.5`).
 *
 * Adding a site is a question asked over the page, not a page: Home's first
 * run and the Assets header open it in place (`AddSiteButton`). This address
 * keeps every link that ever pointed at the old five-step wizard working — the
 * sidebar entry, the command palette, notes and docs — by drawing the Assets
 * page with Add a site already open over it. Closing it leaves the operator on
 * Assets; adding lands on the new asset's Data sources.
 */
export function AssetNewRoute() {
  const navigate = useNavigate();
  return (
    <>
      <AssetsRoute />
      <AddSiteSheet onClose={() => navigate("/assets", { replace: true })} />
    </>
  );
}

export default AssetNewRoute;
