import { type FormEvent, useId, useState } from "react";
import type { IntegrationProviderStatus } from "@noticeos/contract";
import { STRIPE_REVENUE_LANE, TOWER_CONFIG_FILES } from "@noticeos/contract/configuration";
import { changesetSlug, type FileOp } from "@shared/changeset";
import { fieldOf, fieldRefusal } from "@shared/config-registers";
import { LANE_REGISTER, laneFieldOp, laneFieldUnsetOp } from "@shared/lane-mapping-ops";
import { Button } from "@/components/ui/button";
import { fieldClass } from "@/components/ui/field";
import { useStructuralSave } from "@/hooks/useConfigSave";
import { CONFIG_READ_ONLY_FALLBACK, useConfigWritable } from "@/hooks/useConfigWritable";
import { useWall } from "@/hooks/useWall";
import { cn } from "@/lib/utils";

const ACCOUNT_FIELD = "stripeAccountId";
const accountField = fieldOf(LANE_REGISTER, ACCOUNT_FIELD)!;
const LANE = STRIPE_REVENUE_LANE;

export function StripeRevenueAssignment({ status, preselect, names, onClose }: {
  status: IntegrationProviderStatus;
  preselect: string | null;
  names: ReadonlyMap<string, string>;
  onClose: () => void;
}) {
  const { writable, reason } = useConfigWritable();
  const save = useStructuralSave();
  const [editing, setEditing] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  if (status.assets.length === 0) {
    return <AssignmentForm sources={status.stripeAssetSources} preselect={preselect} onSaved={onClose} />;
  }
  const accountId = editing === null ? null : status.stripeAssetSources?.[editing]?.accountId ?? null;
  if (editing !== null && accountId !== null) {
    return <AssignmentForm key={editing} sources={status.stripeAssetSources} preselect={editing}
      assigned={{ id: editing, name: names.get(editing) ?? editing, accountId }}
      onCancel={() => setEditing(null)} onSaved={onClose} />;
  }

  async function remove(asset: string, account: string) {
    setRemoving(true);
    try {
      if (await save({
        ops: [laneFieldUnsetOp(asset, LANE, ACCOUNT_FIELD, account)],
        undo: [laneFieldOp(asset, LANE, ACCOUNT_FIELD, null, account)],
        label: "Stripe revenue assignment removed",
        slug: changesetSlug(asset, LANE, ACCOUNT_FIELD),
      })) onClose();
    } finally {
      setRemoving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="text-muted-foreground">Stripe revenue includes one-time payments and subscriptions from the whole account.</p>
      {status.assets.length > 1 ? (
        <p className="text-error">Stripe revenue can go to one asset. Remove the extra assignments to resume collection.</p>
      ) : null}
      <ul className="m-0 grid list-none gap-2 p-0">
        {status.assets.map(({ id }) => {
          const account = status.stripeAssetSources?.[id]?.accountId;
          const name = names.get(id) ?? id;
          return (
            <li key={id} className="flex flex-wrap items-center justify-between gap-2">
              <div className="grid gap-1">
                <span className="font-medium">{name}</span>
                <span className="font-mono text-xs text-muted-foreground">{account}</span>
              </div>
              {account && writable ? (
                <div className="flex flex-wrap gap-2">
                  {status.assets.length === 1 ? (
                    <Button type="button" variant="outline" size="sm" disabled={removing} onClick={() => setEditing(id)}>Edit account ID</Button>
                  ) : null}
                  <Button type="button" variant="ghost" size="sm" disabled={removing}
                    aria-label={`Remove Stripe assignment for ${name}`}
                    onClick={() => void remove(id, account)}>Remove</Button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {!writable ? <p className="text-muted-foreground">{reason ?? CONFIG_READ_ONLY_FALLBACK}</p> : null}
      {writable ? <p className="text-xs text-muted-foreground">Receipts already collected stay with their asset if you remove or change the assignment.</p> : null}
    </div>
  );
}

function AssignmentForm({ sources, preselect, assigned, onCancel, onSaved }: {
  sources: IntegrationProviderStatus["stripeAssetSources"];
  preselect: string | null;
  assigned?: { id: string; name: string; accountId: string };
  onCancel?: () => void;
  onSaved: () => void;
}) {
  const wall = useWall();
  const { writable, reason } = useConfigWritable();
  const save = useStructuralSave();
  const id = useId();
  const [selection, setSelection] = useState<string | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const assets = (wall.data?.assets ?? []).filter((asset) => asset.status !== "retired");
  const selected = assigned ?? assets.find((asset) => asset.id === (selection ?? preselect));
  const saved = selected ? sources?.[selected.id] : undefined;
  const enteredAccount = account ?? assigned?.accountId ?? saved?.accountId ?? "";
  const accountId = enteredAccount.trim();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!selected || !writable || sources === undefined || saving) return;
    const refusal = fieldRefusal(accountField, accountId);
    setError(refusal);
    if (refusal !== null || accountId === "") return;
    const asset = selected.id;
    const { ops, undo } = assignmentOps(asset, accountId, saved);
    if (ops.length === 0) return;
    setSaving(true);
    try {
      if (await save({ ops, undo, label: "Stripe revenue assignment", slug: changesetSlug(asset, STRIPE_REVENUE_LANE, ACCOUNT_FIELD) })) {
        onSaved();
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      {assigned ? <p className="text-sm font-medium">{assigned.name}</p> : <p className="text-sm text-muted-foreground">
        Choose the asset that earned this account’s revenue. NoticeOS imports the whole account, including one-time payments.
      </p>}
      {!assigned && wall.isError && !wall.data ? (
        <Button variant="outline" type="button" onClick={() => void wall.refetch()}>Retry loading assets</Button>
      ) : !assigned && wall.data && assets.length === 0 ? (
        <p className="text-sm text-muted-foreground">Add an asset before assigning Stripe revenue.</p>
      ) : (
        <>
          {assigned ? null : <div className="grid gap-1.5">
            <label htmlFor={`${id}-asset`} className="text-sm font-medium">Asset *</label>
            <select id={`${id}-asset`} required value={selected?.id ?? ""}
              disabled={!writable || saving || !wall.data || sources === undefined}
              className={cn(fieldClass, "h-10 w-full px-3")}
              onChange={(event) => {
                setSelection(event.target.value);
                setAccount(null);
                setError(null);
              }}>
              <option value="">{wall.data ? "Choose an asset" : "Loading assets…"}</option>
              {assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.displayName}</option>)}
            </select>
          </div>}
          <div className="grid gap-1.5">
            <label htmlFor={`${id}-account`} className="text-sm font-medium">Stripe account ID *</label>
            <input id={`${id}-account`} type="text" required value={enteredAccount} placeholder="acct_…"
              autoComplete="off" spellCheck={false} disabled={!writable || saving || !selected || sources === undefined}
              aria-invalid={error !== null} aria-describedby={error === null ? undefined : `${id}-error`}
              className={cn(fieldClass, "h-10 w-full px-3 font-mono")}
              onChange={(event) => {
                setAccount(event.target.value);
                setError(null);
              }} />
            {error ? <p id={`${id}-error`} role="alert" className="text-sm text-error">{error}</p> : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={!selected || !accountId || accountId === assigned?.accountId || !writable || sources === undefined || saving}>
              {saving ? "Saving…" : assigned ? "Save account ID" : "Assign revenue"}
            </Button>
            {onCancel ? <Button type="button" variant="outline" disabled={saving} onClick={onCancel}>Cancel</Button> : null}
          </div>
        </>
      )}
      {!writable ? <p className="text-sm text-muted-foreground">{reason ?? CONFIG_READ_ONLY_FALLBACK}</p> : null}
      {sources === undefined ? <p className="text-sm text-muted-foreground">Stripe assignment settings are unavailable.</p> : null}
    </form>
  );
}

function assignmentOps(
  asset: string,
  account: string,
  saved: NonNullable<IntegrationProviderStatus["stripeAssetSources"]>[string] | undefined,
): { ops: FileOp[]; undo: FileOp[] } {
  const lane = STRIPE_REVENUE_LANE;
  if (!saved) {
    const cell = { status: "needs-setup", since: new Date().toISOString().slice(0, 10), [ACCOUNT_FIELD]: account };
    const assetEntry = saved === undefined;
    const pointer = assetEntry ? `/assets/${asset}` : `/assets/${asset}/${lane}`;
    const value = assetEntry ? { [lane]: cell } : cell;
    const file = TOWER_CONFIG_FILES.integrations;
    return {
      ops: [{ kind: "file-json-insert", file, pointer, value }],
      undo: [{ kind: "file-json-delete", file, pointer, expect: value }],
    };
  }
  const ops: FileOp[] = [];
  const undo: FileOp[] = [];
  if (saved.status === "skipped" || saved.status === "not-applicable") {
    ops.push(laneFieldOp(asset, lane, "status", saved.status, "needs-setup"));
    undo.push(laneFieldOp(asset, lane, "status", "needs-setup", saved.status));
  }
  if (account !== saved.accountId) {
    ops.push(laneFieldOp(asset, lane, ACCOUNT_FIELD, saved.accountId, account));
    undo.push(saved.accountId === null
      ? laneFieldUnsetOp(asset, lane, ACCOUNT_FIELD, account)
      : laneFieldOp(asset, lane, ACCOUNT_FIELD, account, saved.accountId));
  }
  return { ops, undo };
}
