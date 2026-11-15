import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import {
  readTempoMppSettings, TEMPO_MPP_POINTER, TOWER_CONFIG_FILES,
  type TempoMppChain, type TempoMppSettings,
} from '@noticeos/contract/configuration';
import { TEMPO_NETWORKS, type TempoMppPayment, type TempoMppSetup } from '@noticeos/contract/tempo-mpp';
import { Button } from '@/components/ui/button';
import { fieldClass } from '@/components/ui/field';
import { ReadFailed } from '@/components/ReadFailed';
import { useConfigSave } from '@/hooks/useConfigSave';
import { useConfigWritable } from '@/hooks/useConfigWritable';
import { useTowerApi } from '@/lib/browser-context';
import { ConnectionSchedule } from './ConnectionSchedule';

const setupKey = ['tempo-mpp-setup'] as const;

export function TempoMppIntegration() {
  const api = useTowerApi();
  const [page, setPage] = useState(1);
  const setup = useQuery({ queryKey: [...setupKey, page], queryFn: ({ signal }) => api.fetchTempoMppSetup(page, signal),
    placeholderData: keepPreviousData });
  if (setup.isError) return <ReadFailed title="Couldn't load Tempo MPP" subject="read:tempo-mpp"
    error={setup.error} retrying={setup.isFetching} onRetry={() => void setup.refetch()} />;
  if (!setup.data) return <p role="status" data-status-for="read:tempo-mpp" className="text-sm text-muted-foreground">Loading Tempo settings…</p>;
  return (
    <>
      <TempoMppForm key={JSON.stringify(setup.data.settings)} setup={setup.data} />
      {setup.data.settings ? <section aria-label="Tempo collection schedule" className="max-w-3xl">
        <ConnectionSchedule provider="tempo-mpp" />
      </section> : null}
      <PaymentHistory setup={setup.data} page={page} onPage={setPage} loading={setup.isPlaceholderData} />
    </>
  );
}

function TempoMppForm({ setup }: { setup: TempoMppSetup }) {
  const saved = setup.settings;
  const save = useConfigSave();
  const { writable, reason } = useConfigWritable();
  const queries = useQueryClient();
  const prefix = useId();
  const [chainId, setChain] = useState<TempoMppChain | ''>(saved?.chainId ?? '');
  const [wallet, setWallet] = useState(saved?.wallet ?? '');
  const [token, setToken] = useState(saved?.token ?? '');
  const [startBlock, setStartBlock] = useState(saved?.startBlock.toString() ?? '');
  const [enabled, setEnabled] = useState(saved?.enabled ?? false);
  const [mappings, setMappings] = useState((saved?.mappings ?? []).map((row, key) => ({ ...row, key })));
  const [nextKey, setNextKey] = useState(mappings.length);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const input = `${fieldClass} h-10 min-w-0 w-full px-3`;

  function editMapping(key: number, edit: Partial<TempoMppSettings['mappings'][number]>) {
    setMappings(rows => rows.map(row => row.key === key ? { ...row, ...edit } : row));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFormError('');
    if (!writable || saving) return;
    const savedMappings = mappings.map(({ realm, asset }) => ({ realm: realm.trim(), asset }));
    if (new Set(savedMappings.map(row => row.realm)).size !== savedMappings.length) {
      setFormError('Use each MPP realm once for this wallet.');
      return;
    }
    const settings = readTempoMppSettings({
      chainId, wallet: wallet.trim(), token: token.trim(), startBlock: Number(startBlock), enabled, mappings: savedMappings,
    });
    if (!settings || !/^\d+$/.test(startBlock)) {
      setFormError('Enter a valid wallet, token contract, and starting block. Add an asset mapping to turn on collection.');
      return;
    }
    setSaving(true);
    try {
      await save({
        ops: [{ kind: 'file-json-set', file: TOWER_CONFIG_FILES.integrations, pointer: TEMPO_MPP_POINTER,
          ...(saved ? { expect: saved } : { expectAbsent: true }), value: settings }],
        label: 'Tempo MPP settings',
        slug: 'tempo-mpp-settings',
      });
      await queries.invalidateQueries({ queryKey: setupKey });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={event => void submit(event)} className="grid max-w-3xl gap-4 rounded-xl border border-border bg-card p-4 sm:p-5">
      <fieldset disabled={!writable || saving} className="grid gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1.5 text-sm font-medium">Network *
            <select required value={chainId} className={input}
              onChange={event => setChain(event.target.value === '' ? '' : Number(event.target.value) as TempoMppChain)}>
              <option value="">Choose a network</option>
              {Object.entries(TEMPO_NETWORKS).map(([id, network]) => <option value={id} key={id}>{network.label}</option>)}
            </select>
          </label>
          <label className="grid gap-1.5 text-sm font-medium">Start at block *
            <input required value={startBlock} inputMode="numeric" pattern="[0-9]+" className={input}
              onChange={event => setStartBlock(event.target.value)} />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">Receiving wallet *
            <input required value={wallet} pattern="0[xX][0-9a-fA-F]{40}" autoComplete="off" spellCheck={false} className={input}
              onChange={event => setWallet(event.target.value)} />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">Token contract *
            <input required value={token} pattern="0[xX][0-9a-fA-F]{40}" autoComplete="off" spellCheck={false} className={input}
              onChange={event => setToken(event.target.value)} />
          </label>
        </div>
        <fieldset className="grid gap-3">
          <legend className="mb-2 text-sm font-medium">Asset mappings</legend>
          {mappings.map(({ key, realm, asset }, index) => (
            <div className="grid items-end gap-2 border-b border-border pb-3 sm:grid-cols-[1fr_1fr_auto]" key={key}>
              <label className="grid gap-1.5 text-sm" htmlFor={`${prefix}-realm-${key}`}>MPP realm *
                <input id={`${prefix}-realm-${key}`} required maxLength={255} value={realm} spellCheck={false} className={input}
                  onChange={event => editMapping(key, { realm: event.target.value })} />
              </label>
              <label className="grid gap-1.5 text-sm" htmlFor={`${prefix}-asset-${key}`}>Asset *
                <select id={`${prefix}-asset-${key}`} required value={asset} className={input}
                  onChange={event => editMapping(key, { asset: event.target.value })}>
                  <option value="">Choose an asset</option>
                  {asset && !setup.assets.some(row => row.id === asset) ? <option value={asset} disabled>{asset} (unavailable)</option> : null}
                  {setup.assets.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
                </select>
              </label>
              <Button type="button" variant="outline" aria-label={`Remove mapping ${index + 1}`}
                onClick={() => setMappings(rows => rows.filter(row => row.key !== key))}>Remove</Button>
            </div>
          ))}
          <div><Button type="button" variant="outline" disabled={mappings.length >= 100 || setup.assets.length === 0}
            onClick={() => {
              setMappings(rows => [...rows, { key: nextKey, realm: '', asset: '' }]);
              setNextKey(key => key + 1);
            }}>Add mapping</Button></div>
        </fieldset>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />
          Collect payments automatically
        </label>
      </fieldset>
      {formError ? <p role="alert" className="text-sm text-error">{formError}</p> : null}
      {writable ? <div><Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save settings'}</Button></div>
        : <p className="text-sm text-muted-foreground">{reason ?? 'Settings are read-only.'}</p>}
    </form>
  );
}

const paymentStates: Record<TempoMppPayment['state'], string> = {
  unmatched: 'Awaiting a sale record',
  pending: 'Awaiting collection',
  recorded: 'Recorded in Money',
  'test-payment': 'Verified test payment',
  'amount-not-supported': 'Amount cannot be recorded in USD cents',
};

function tokenAmount(baseUnits: string): string {
  const padded = baseUnits.padStart(7, '0');
  const fraction = padded.slice(-6).replace(/0+$/, '').padEnd(2, '0');
  return `${padded.slice(0, -6)}.${fraction} USD`;
}

function PaymentHistory({ setup, page, onPage, loading }: {
  setup: TempoMppSetup; page: number; onPage: (page: number) => void; loading: boolean;
}) {
  if (!setup.settings && setup.payments.length === 0) return null;
  const names = new Map(setup.assets.map(asset => [asset.id, asset.name]));
  const scan = setup.scan;
  const status = !setup.settings?.enabled ? 'Collection paused'
    : scan?.failed ? `Collection failed. Retry starts at block ${scan.nextBlock.toLocaleString()}.`
    : scan?.completedAt ? `Last complete scan ${new Date(scan.completedAt).toLocaleString()}`
    : scan ? `Collection will resume at block ${scan.nextBlock.toLocaleString()}.`
    : 'Awaiting the first scan';
  return (
    <section className="grid max-w-3xl gap-3" aria-label="Tempo payments">
      <div className="grid gap-1">
        <h2 className="text-base font-medium">Payments</h2>
        <p className="text-sm text-muted-foreground">{status}</p>
      </div>
      {setup.payments.length === 0 ? scan?.completedAt && !scan.failed ?
        <p className="text-sm text-muted-foreground">No matching transfers found.</p> : null : (
        <ul className="divide-y divide-border rounded-xl border border-border bg-card">
          {setup.payments.map(item => (
            <li key={`${item.chainId}:${item.hash}:${item.logIndex}`} className="grid gap-1 px-4 py-3 text-sm sm:grid-cols-[1fr_auto]">
              <div>
                <p className="font-medium">{names.get(item.asset) ?? item.asset} · {tokenAmount(item.baseUnits)}</p>
                <p className="text-muted-foreground"><time dateTime={item.settledAt}>{item.settledAt.slice(0, 10)} UTC</time> · {TEMPO_NETWORKS[item.chainId].label} · {item.product ?? 'Unknown product'} · {paymentStates[item.state]}</p>
              </div>
              <a className="self-center font-medium underline underline-offset-4"
                href={`${TEMPO_NETWORKS[item.chainId].explorer}/tx/${item.hash}`}
                target="_blank" rel="noopener noreferrer">View transaction</a>
            </li>
          ))}
        </ul>
      )}
      {page > 1 || setup.hasMore ? <div className="flex gap-2">
        <Button type="button" variant="outline" disabled={page === 1 || loading} onClick={() => onPage(page - 1)}>Previous payments</Button>
        <Button type="button" variant="outline" disabled={!setup.hasMore || loading} onClick={() => onPage(page + 1)}>More payments</Button>
      </div> : null}
    </section>
  );
}
