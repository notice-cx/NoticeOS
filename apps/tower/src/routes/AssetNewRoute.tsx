import { useNavigate } from "react-router-dom";
import { AddSiteSheet } from "@/components/AddSite";
import { AssetsRoute } from "@/routes/AssetsRoute";

/**
 * `/assets/new`: Add a site, as an address. Adding a site is a question asked
 * over the page, not a page (`AddSiteButton`); this address draws the Assets
 * page with Add a site already open over it, so every link that points here
 * still works. Closing it leaves the operator on Assets; adding lands on the
 * new asset's Data sources.
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
