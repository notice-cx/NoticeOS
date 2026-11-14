import { type FormEvent, useId, useState } from "react";
import type { IntegrationProviderStatus } from "@noticeos/contract";
import { STRIPE_PRODUCTS_POINTER, TOWER_CONFIG_FILES, type StripeProductMapping } from "@noticeos/contract/configuration";
import { Button } from "@/components/ui/button";
import { fieldClass } from "@/components/ui/field";
import { useAccountSites } from "@/hooks/useAccountSites";
import { useConfigSave } from "@/hooks/useConfigSave";
import { CONFIG_READ_ONLY_FALLBACK, useConfigWritable } from "@/hooks/useConfigWritable";
import { cn } from "@/lib/utils";

export function StripeProductAssignments({ status, onClose }: {
  status: IntegrationProviderStatus;
  onClose: () => void;
}) {
  const query = useAccountSites("stripe", true, { refetchOnMount: "always" });
  const data = query.data;
  const discovery = data?.discovery;
  if (query.isPending || (query.isFetching && !query.isFetchedAfterMount)) return <p role="status" className="text-sm text-muted-foreground">Loading Stripe products…</p>;
  if (!data || !discovery?.ok || !discovery.stripeAccountId) {
    return (
      <div className="grid gap-3">
        <p role="alert" className="text-sm text-error">
          {discovery?.ok === false && discovery.reason === "test-mode" ? "Connect a live Stripe key to map products for revenue."
            : discovery?.ok === false && discovery.reason === "refused" ? "Stripe refused access. Check the key’s read permissions."
            : "Stripe products could not be loaded."}
        </p>
        <div><Button type="button" variant="outline" size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}>Retry</Button></div>
      </div>
    );
  }
  const accountId = discovery.stripeAccountId;
  const saved = status.stripeProducts ?? null;
  const current = saved?.accountId === accountId ? saved.products : {};
  const listed = new Map(discovery.sites.map((site) => [site.ref, { label: site.label, archived: !site.ready }]));
  for (const id of Object.keys(current)) {
    if (!listed.has(id)) listed.set(id, { label: id, archived: true });
  }
  const products = [...listed].map(([id, product]) => ({ id, ...product }))
    .sort((a, b) => Number(a.archived) - Number(b.archived) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id));

  return <ProductForm key={accountId} accountId={accountId} saved={saved} assets={data.assets} products={products}
    legacy={saved === null && status.assets.length > 0} onClose={onClose} />;
}

function ProductForm({ accountId, saved, assets, products, legacy, onClose }: {
  accountId: string;
  saved: StripeProductMapping | null;
  assets: readonly { id: string; label: string }[];
  products: readonly { id: string; label: string; archived: boolean }[];
  legacy: boolean;
  onClose: () => void;
}) {
  const { writable, reason } = useConfigWritable();
  const save = useConfigSave();
  const id = useId();
  const [baseline] = useState(saved);
  const [initial] = useState<Record<string, string>>(() => baseline?.accountId === accountId ? baseline.products : {});
  const [mappings, setMappings] = useState(initial);
  const [saving, setSaving] = useState(false);
  const changed = new Set([...Object.keys(initial), ...Object.keys(mappings)]);
  const dirty = [...changed].some((product) => initial[product] !== mappings[product]);
  const assetIds = new Set(assets.map((asset) => asset.id));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!dirty || !writable || saving) return;
    setSaving(true);
    try {
      if (await save({
        ops: [{
          kind: "file-json-set", file: TOWER_CONFIG_FILES.integrations, pointer: STRIPE_PRODUCTS_POINTER,
          ...(baseline === null ? { expectAbsent: true } : { expect: baseline }),
          value: { accountId, products: mappings },
        }],
        label: "Stripe product mappings",
        slug: "stripe-product-mappings",
      })) onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      {products.length === 0 ? <p className="text-sm text-muted-foreground">There are no products in this Stripe account.</p> : <>
        <div className="grid gap-1">
          <h3 className="text-sm font-medium">Products</h3>
          <p className="text-sm text-muted-foreground">Choose which asset earns revenue from each Stripe product.</p>
        </div>
        {legacy ? <p className="text-sm text-muted-foreground">Saving switches this account to product mapping. Previously recorded revenue stays with its asset.</p> : null}
        {saved && saved.accountId !== accountId ? <p className="text-sm text-muted-foreground">The key is for a different Stripe account. Saving replaces the previous account’s mappings.</p> : null}
        {assets.length === 0 ? <p className="text-sm text-muted-foreground">Add an asset to map a product.</p> : null}
        <fieldset disabled={!writable || saving} className="grid gap-3">
          {products.map((product, index) => {
            const mapped = mappings[product.id] ?? "";
            return (
              <div key={product.id} className="grid min-w-0 items-center gap-1.5 border-b border-border pb-3 sm:grid-cols-2 sm:gap-3">
                <label htmlFor={`${id}-${index}`} className="min-w-0 break-words text-sm" title={product.id}>
                  {product.label}
                  {product.archived ? <> <span className="ml-1 text-xs text-muted-foreground">Archived</span></> : null}
                </label>
                <select id={`${id}-${index}`} value={mapped} className={cn(fieldClass, "h-9 min-w-0 w-full px-2")}
                  onChange={(event) => {
                    const next = event.target.value;
                    setMappings((current) => {
                      const updated = { ...current };
                      if (next) updated[product.id] = next;
                      else delete updated[product.id];
                      return updated;
                    });
                  }}>
                  <option value="">Unassigned</option>
                  {mapped && !assetIds.has(mapped) ? <option value={mapped} disabled>{mapped} (unavailable)</option> : null}
                  {assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.label}</option>)}
                </select>
              </div>
            );
          })}
        </fieldset>
      </>}
      {!writable ? <p className="text-sm text-muted-foreground">{reason ?? CONFIG_READ_ONLY_FALLBACK}</p> : null}
      <div className="flex flex-wrap gap-2">
        {products.length > 0 && writable ? <Button type="submit" disabled={!dirty || saving}>{saving ? "Saving…" : "Save mappings"}</Button> : null}
        <Button type="button" variant="outline" onClick={onClose} disabled={saving}>{dirty ? "Cancel" : "Done"}</Button>
      </div>
    </form>
  );
}
