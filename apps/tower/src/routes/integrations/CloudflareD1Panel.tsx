import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, Loader2, TriangleAlert } from 'lucide-react';
import { D1_FAILURE_LABELS, type D1Database, type D1Receipt } from '@noticeos/contract/cloudflare-d1';
import { useTowerApi, useBrowserRuntime } from '@/lib/browser-context';
import { Button } from '@/components/ui/button';
import { fieldClass } from '@/components/ui/field';
import { StateChip } from '@/components/StateChip';

/** Route composition: the existing connection panel owns navigation and custody. */
export function CloudflareD1Panel({ inventory, names, canSave, onChanged }: {
  inventory?: { accountId: string; databases: D1Database[] }; names: ReadonlyMap<string, string>;
  canSave: boolean; onChanged: () => Promise<void>;
}) {
  const api = useTowerApi();
  const nightly = useBrowserRuntime().owner.mode === 'standalone';
  const [session] = useState(() => crypto.randomUUID());
  const status = useQuery({ queryKey: ['cloudflare-d1', session], queryFn: async () => {
    const saved = await api.fetchD1Status(!inventory);
    return inventory && inventory.accountId !== saved.accountId ? api.fetchD1Status(true) : saved;
  },
    staleTime: Infinity, retry: 0, refetchOnWindowFocus: false });
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [draftAccount, setDraftAccount] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [receipts, setReceipts] = useState<Record<string, D1Receipt>>({});
  const databases = inventory?.accountId === status.data?.accountId ? inventory!.databases : status.data?.databases ?? [];
  useEffect(() => {
    if (!status.data || draftAccount === status.data.accountId) return;
    const held = status.data;
    setPicked(held.accountMismatch ? {} : Object.fromEntries(held.selection?.targets.map(target => [target.databaseId, target.asset]) ?? []));
    setReceipts(Object.fromEntries(held.receipts.flatMap(row => row.latest ? [[row.databaseId, row.latest]] : [])));
    setDraftAccount(held.accountId);
  }, [status.data, draftAccount]);
  const targets = Object.entries(picked).filter(([, asset]) => asset !== '').map(([databaseId, asset]) => ({ databaseId, asset }));
  async function run() {
    if (!status.data || busy || !canSave) return;
    setBusy(true); setFailure(null);
    try {
      await api.saveD1Selection({ version: 1, accountId: status.data.accountId, targets });
      for (const target of targets) {
        setRunning(target.databaseId);
        const saved = await api.exportD1Database(status.data.accountId, target.databaseId);
        setReceipts(current => ({ ...current, [target.databaseId]: saved }));
      }
      await onChanged();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'Backup not started · try again');
      await status.refetch();
    }
    finally { setRunning(null); setBusy(false); }
  }
  if (status.isPending) return <span className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin motion-reduce:animate-none" />Loading databases</span>;
  if (status.isError) return <Button variant="outline" onClick={() => void status.refetch()}>Retry databases</Button>;
  return <div className="flex flex-1 flex-col gap-4" data-d1-picker>
    {status.data.accountMismatch ? <span className="text-sm text-warn">Account changed · choose databases again</span> : null}
    {databases.length === 0 ? <span className="text-sm text-muted-foreground">No D1 databases</span> : <fieldset disabled={busy || !canSave} className="flex min-w-0 flex-col gap-3">
      <legend className="mb-3 text-sm font-medium">{nightly ? 'Nightly D1 backups' : 'D1 databases'}</legend>
      {databases.map(database => {
        const saved = receipts[database.id]; const active = running === database.id;
        return <div key={database.id} className="flex min-w-0 flex-col gap-2 rounded-md border p-3" data-subject={`database:${database.id}`}>
          <label className="flex min-w-0 items-center gap-2 text-sm font-medium">
            <input type="checkbox" checked={Object.hasOwn(picked, database.id)} onChange={event => setPicked(current => {
              const next = { ...current }; if (event.target.checked) next[database.id] = ''; else delete next[database.id]; return next;
            })} />
            <span className="truncate">{database.name}</span>
          </label>
          {Object.hasOwn(picked, database.id) ? <select className={fieldClass} aria-label={`Asset for ${database.name}`} value={picked[database.id]}
            onChange={event => setPicked(current => ({ ...current, [database.id]: event.target.value }))}>
            <option value="">Choose asset</option>
            {[...names].map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select> : null}
          {active || saved ? <StateChip subject={`database:${database.id}`} tone={active || saved?.state === 'running' ? 'neutral' : saved?.state === 'complete' ? 'affirmative' : 'critical'}
            label={active || saved?.state === 'running' ? 'Exporting' : saved?.state === 'complete' ? 'Export stored' : saved?.failure ? D1_FAILURE_LABELS[saved.failure] : 'Export failed'}
            glyph={active ? <Loader2 className="size-3 animate-spin motion-reduce:animate-none" /> : saved?.state === 'complete' ? <Check className="size-3" /> : <TriangleAlert className="size-3" />} /> : null}
        </div>;
      })}
    </fieldset>}
    {nightly ? <span className="text-sm text-muted-foreground">Selected databases join nightly backups.</span> : null}
    <span className="text-sm text-muted-foreground">Export temporarily blocks database queries.</span>
    {failure ? <span role="alert" className="text-sm text-error">{failure}</span> : null}
    <Button className="mt-auto w-full" onClick={() => void run()} disabled={busy || !canSave || draftAccount !== status.data.accountId || Object.values(picked).some(value => !value)}>
      {busy ? 'Backing up' : targets.length ? 'Back up selected' : 'Clear selection'}
    </Button>
  </div>;
}
