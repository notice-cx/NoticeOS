import { useEffect, useId, useRef, useState } from 'react';
import { PORTFOLIO_REVIEW_FILE, PORTFOLIO_REVIEW_POINTER } from '@noticeos/contract/configuration';
import type { SettingsPayload } from '@shared/settings';
import { InlineSaveState, type InlineSave } from '@/components/InlineSaveState';
import { Button } from '@/components/ui/button';
import { useConfigWritable } from '@/hooks/useConfigWritable';
import { useFieldConfigSave, type FieldUndoOutcome } from '@/hooks/useConfigSave';
import { PanelLock, SettingsPanel } from './SettingsPanel';

type Selection = string[] | null;
const same = (left: Selection, right: Selection) => JSON.stringify(left) === JSON.stringify(right);
export function PortfolioReviewPanel({ settings }: { settings: SettingsPayload['portfolioReview'] }) {
  const { writable } = useConfigWritable();
  const saveField = useFieldConfigSave();
  const name = useId();
  const [saved, setSaved] = useState<Selection>(settings.assetIds);
  const [draft, setDraft] = useState<Selection>(settings.assetIds);
  const lastSaved = useRef(settings.assetIds);
  const incoming = JSON.stringify(settings.assetIds);
  useEffect(() => {
    const previous = lastSaved.current;
    setDraft(current => same(current, previous) ? settings.assetIds : current);
    setSaved(settings.assetIds);
    lastSaved.current = settings.assetIds;
  }, [incoming]);
  const [pending, setPending] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [outcome, setOutcome] = useState<{ kind: 'saved'; undo: () => Promise<FieldUndoOutcome>; before: Selection } | { kind: 'refused'; refusal: string } | null>(null);
  const assets = [...settings.assets, ...(draft ?? []).filter(id => !settings.assets.some(asset => asset.id === id)).map(id => ({ id, displayName: id }))];
  const disabled = !writable || pending || undoing;
  async function save() {
    if (disabled || same(saved, draft)) return;
    setPending(true); setOutcome(null);
    const before = saved;
    try {
      const result = await saveField({ slug: 'portfolio-review-assets', label: 'AI portfolio review', ops: [{
        kind: 'file-json-set', file: PORTFOLIO_REVIEW_FILE, pointer: PORTFOLIO_REVIEW_POINTER, expect: saved, value: draft,
      }] });
      if (result.saved) { setSaved(draft); lastSaved.current = draft; setOutcome({ kind: 'saved', undo: result.undo, before }); }
      else setOutcome({ kind: 'refused', refusal: result.refusal });
    } finally { setPending(false); }
  }
  async function undo() {
    if (outcome?.kind !== 'saved') return;
    setUndoing(true);
    try {
      const result = await outcome.undo();
      if (result.undone) { setDraft(outcome.before); setSaved(outcome.before); lastSaved.current = outcome.before; setOutcome(null); }
      else setOutcome({ kind: 'refused', refusal: result.refusal });
    } finally { setUndoing(false); }
  }
  const state: InlineSave = pending ? { state: 'saving' } : outcome?.kind === 'saved' ? { state: 'saved', undoing, onUndo: () => void undo() }
    : outcome?.kind === 'refused' ? { state: 'refused', refusal: outcome.refusal } : { state: 'idle' };
  return <SettingsPanel id="portfolio-review" title="AI portfolio review" aside={!writable ? <PanelLock /> : undefined}>
    <fieldset disabled={disabled} className="space-y-3">
      <legend className="sr-only">Assets included in portfolio review</legend>
      <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm"><input type="radio" name={name} checked={draft === null} onChange={() => { setDraft(null); setOutcome(null); }} className="size-4 accent-primary" />All assets</label>
      {draft === null ? <p className="text-xs text-muted-foreground">Includes new assets automatically.</p> : null}
      <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm"><input type="radio" name={name} checked={draft !== null} onChange={() => { setDraft(settings.assets.map(asset => asset.id)); setOutcome(null); }} className="size-4 accent-primary" />Choose assets</label>
      {draft !== null ? <div className="divide-y divide-border rounded-lg border border-border">
        {assets.map(asset => <label key={asset.id} className="flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2 text-sm">
          <input type="checkbox" checked={draft.includes(asset.id)} className="size-4 shrink-0 accent-primary" onChange={event => {
            setDraft(current => event.target.checked ? [...(current ?? []), asset.id] : (current ?? []).filter(id => id !== asset.id)); setOutcome(null);
          }} />
          <span className="min-w-0"><span className="block break-words font-medium">{asset.displayName}</span>{asset.displayName !== asset.id ? <span className="block break-all text-xs text-muted-foreground">{asset.id}</span> : null}</span>
        </label>)}
        {assets.length === 0 ? <p className="p-3 text-sm text-muted-foreground">No assets available.</p> : null}
      </div> : null}
    </fieldset>
    {draft?.length === 0 ? <p className="text-sm text-muted-foreground">No assets selected. Portfolio review will not run.</p> : null}
    <div className="flex flex-wrap items-center gap-3"><Button type="button" disabled={disabled || same(saved, draft)} onClick={() => void save()}>Save asset selection</Button><InlineSaveState save={state} subject="field:AI portfolio review" /></div>
  </SettingsPanel>;
}
