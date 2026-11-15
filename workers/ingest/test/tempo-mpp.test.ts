import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Attribution } from 'mppx/tempo';
import {
  TEMPO_MPP_MAINNET, TEMPO_MPP_POINTER, TEMPO_MPP_TESTNET, TOWER_CONFIG_FILES, type TempoMppSettings,
} from '@noticeos/contract/configuration';
import { TEMPO_MPP_SALE_PATH, TEMPO_NETWORKS } from '@noticeos/contract/tempo-mpp';
import { applyConfigOps, forgetConfigCache, getConfigDocument } from '../src/config-store.js';
import { runTempoMpp } from '../src/tempo-mpp.js';
import { call, emptyTables, forgetConfigDocuments, pgRows } from './helpers.js';
import { ASSET_TOKENS } from './fixtures.js';
import { handleTempoMppSetup } from '../../../apps/tower/worker/tempo-mpp-route';

const FIRST = 'meadow.example';
const SECOND = 'northwind.example';
const WALLET = '0x0101010101010101010101010101010101010101';
const PAYER = '0x0202020202020202020202020202020202020202';
const WRONG = '0x0303030303030303030303030303030303030303';
const PATH_USD = '0x20c0000000000000000000000000000000000000';
const BLOCK = 100;
const HASH = '0x7996cfae1c15e93798cb6aa3715a17a49eb1fb935d4276ea4612add664a9895a';
const TIMESTAMP = '2026-11-15T17:18:51.000Z';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const MEMO = '0x57bc7354aa85aed339e000bccffabbc529466af35f0772c8f8ee1145927de7f0';
const blockHex = (value: number) => `0x${value.toString(16)}`;
const word = (value: string) => value.replace(/^0x/, '').padStart(64, '0');
const assetSettings: TempoMppSettings = {
  chainId: TEMPO_MPP_TESTNET, wallet: WALLET, token: PATH_USD, startBlock: BLOCK, enabled: true,
  mappings: [{ realm: 'paid.example.com', asset: FIRST }, { realm: 'lookup.example.com', asset: SECOND }],
};

function logs({
  realm = 'paid.example.com', memoIndex = 14, amount = 500_000, token = PATH_USD, receiver = WALLET, deliveredTo = receiver, hash = HASH,
}: { realm?: string; memoIndex?: number; amount?: number; token?: string; receiver?: string; deliveredTo?: string; hash?: string } = {}) {
  const common = { address: token, transactionHash: hash, blockNumber: blockHex(BLOCK), data: `0x${word(amount.toString(16))}` };
  // The saved Moderato receipt emits the ordinary transfer at 13 and the memo at 14.
  // Use synthetic actors and realms in the replay.
  const delivery = { ...common, logIndex: blockHex(memoIndex - 1), topics: [TRANSFER, `0x${word(PAYER)}`, `0x${word(deliveredTo)}`] };
  const memo = { ...common, logIndex: blockHex(memoIndex), topics: [MEMO, `0x${word(PAYER)}`, `0x${word(receiver)}`,
    Attribution.encode({ challengeId: `fixture-${memoIndex}`, serverId: realm })] };
  return [delivery, memo];
}

function rpc(settings: TempoMppSettings, all = logs(), options: {
  fail?: boolean; chain?: number; beforeLogs?: () => Promise<void>; beforeReceipt?: (hash: string) => void;
} = {}) {
  const ranges: number[][] = [];
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    expect(url).toBe(TEMPO_NETWORKS[settings.chainId].rpc);
    const request = new Request(String(url), init);
    expect(request.redirect).toBe('manual');
    const { method, params } = JSON.parse(await request.text());
    if (options.fail && method === 'eth_getTransactionReceipt') return new Response(null, { status: 503 });
    let result: unknown;
    switch (method) {
      case 'eth_chainId': result = blockHex(options.chain ?? settings.chainId); break;
      case 'eth_getBlockByNumber': result = { number: blockHex(BLOCK), timestamp: blockHex(Date.parse(TIMESTAMP) / 1000) }; break;
      case 'eth_call': {
        expect(params[0].to).toBe(settings.token);
        result = params[0].data === '0x313ce567' ? `0x${word('6')}`
          : `0x${word('20')}${word('3')}${'555344'.padEnd(64, '0')}`;
        break;
      }
      case 'eth_getLogs':
        await options.beforeLogs?.();
        ranges.push([Number(params[0].fromBlock), Number(params[0].toBlock)]);
        expect(params[0].address).toBe(settings.token);
        expect(params[0].topics).toEqual([MEMO, null, `0x${word(settings.wallet)}`]);
        result = all.filter(log => log.topics[0] === MEMO);
        break;
      case 'eth_getTransactionReceipt':
        options.beforeReceipt?.(params[0]);
        request.signal.throwIfAborted();
        result = { status: '0x1', transactionHash: params[0], blockNumber: blockHex(BLOCK),
          logs: all.filter(log => log.transactionHash === params[0]) };
        break;
      default: throw new Error(`Unexpected RPC ${method}`);
    }
    return Response.json({ jsonrpc: '2.0', id: 1, result });
  });
  return { fetchImpl, ranges };
}

async function save(value: TempoMppSettings, expect?: TempoMppSettings) {
  return applyConfigOps(env, {
    actor: 'test',
    ops: [{ kind: 'file-json-set', file: TOWER_CONFIG_FILES.integrations, pointer: TEMPO_MPP_POINTER,
      ...(expect ? { expect } : { expectAbsent: true }), value }],
  });
}

function sale(settings: TempoMppSettings, changes: Record<string, unknown> = {}, token = ASSET_TOKENS[FIRST]) {
  return call(new Request(`https://ingest.example.com${TEMPO_MPP_SALE_PATH}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ asset: FIRST, chainId: settings.chainId, hash: HASH, logIndex: 14,
      baseUnits: '500000', product: 'Carrier batch', ...changes }),
  }));
}

async function money() {
  return pgRows(`SELECT asset_id AS asset, amount_minor::text AS cents, period_month::text AS month
       FROM noticeos.financial_ledger WHERE source = 'tempo-mpp' ORDER BY asset`);
}

beforeEach(async () => {
  await emptyTables(['revenue_observations', 'tempo_mpp_scans', 'tempo_mpp_payments', 'tempo_mpp_sale_records']);
  await forgetConfigDocuments([TOWER_CONFIG_FILES.integrations]);
  forgetConfigCache();
});

describe('Tempo MPP reconciliation', () => {
  it('saves the shared wallet and uses the receipt memo index for a test payment', async () => {
    const rawMemo = '0xef1ed71201b02ae77fd9fbc934b641000000000000000000006fe50d7fa3b99a';
    expect(Attribution.decode(rawMemo)?.serverFingerprint).toBe('0xb02ae77fd9fbc934b641');
    expect(await save(assetSettings)).toMatchObject({ ok: true });
    expect((await getConfigDocument(env, TOWER_CONFIG_FILES.integrations)).body).toMatchObject({ tempoMpp: assetSettings });
    expect((await sale(assetSettings)).status).toBe(201);
    expect((await sale(assetSettings)).status).toBe(200);
    const provider = rpc(assetSettings);
    expect(await runTempoMpp(env, provider)).toMatchObject({ outcome: 'ran', matched: 1, recorded: 0 });
    expect(await pgRows(`SELECT asset_id AS asset, log_index AS "logIndex", amount_base_units::text AS amount
      FROM noticeos.tempo_mpp_payments`)).toEqual([{ asset: FIRST, logIndex: 14, amount: '500000' }]);
    expect(await money()).toEqual([]);
    const history = await handleTempoMppSetup(new Request('https://tower.example.com/api/integrations/tempo-mpp'), env.STORE);
    expect(await history.json()).toMatchObject({ settings: assetSettings, payments: [
      { hash: HASH, asset: FIRST, logIndex: 14, baseUnits: '500000', product: 'Carrier batch', state: 'test-payment' },
    ] });
  });

  it('books both assets’ verified sales once, even when one transaction carries both payments', async () => {
    // This fixture uses a synthetic response for the live-network branch. The transport never opens a network connection.
    const settings: TempoMppSettings = { ...assetSettings, chainId: TEMPO_MPP_MAINNET };
    expect(await save(settings)).toMatchObject({ ok: true });
    let release = () => {};
    const fetching = new Promise<void>(resolve => { release = resolve; });
    let concurrent = 0;
    const provider = rpc(settings, [...logs(), ...logs({ realm: 'lookup.example.com', memoIndex: 16, amount: 10_000 })],
      { beforeLogs: async () => { concurrent++; await fetching; } });
    expect((await sale(settings, { asset: SECOND, logIndex: 16, baseUnits: '10000', product: null })).status).toBe(401);
    expect((await sale(settings)).status).toBe(201);
    const running = Promise.all([runTempoMpp(env, provider), runTempoMpp(env, provider)]);
    let runs: Awaited<typeof running>;
    try {
      await vi.waitFor(() => expect(concurrent).toBe(2));
    } finally {
      release();
      runs = await running;
    }
    expect(runs.reduce((count, run) => count + ('recorded' in run ? run.recorded ?? 0 : 0), 0)).toBe(1);
    expect(await money()).toEqual([{ asset: FIRST, cents: '50', month: '2026-11-01' }]);
    expect((await sale(settings, { asset: SECOND, logIndex: 16, baseUnits: '10000', product: null }, ASSET_TOKENS[SECOND])).status).toBe(201);
    await runTempoMpp(env, provider);
    expect(await money()).toEqual([{ asset: FIRST, cents: '50', month: '2026-11-01' }, { asset: SECOND, cents: '1', month: '2026-11-01' }]);
  });

  it('rejects ambiguous mappings and honors a saved pause and a later wallet change', async () => {
    const ambiguous = { ...assetSettings, mappings: [...assetSettings.mappings, { ...assetSettings.mappings[0]!, asset: SECOND }] };
    expect(await save(ambiguous)).toMatchObject({ ok: false, error: 'invalid_changeset' });
    expect(await save({ ...assetSettings, mappings: [{ realm: 'absent.example.com', asset: 'absent.example' }] }))
      .toMatchObject({ ok: false, error: 'invalid_changeset' });
    expect(await save(assetSettings)).toMatchObject({ ok: true });
    const paused = { ...assetSettings, enabled: false };
    expect(await save(paused, assetSettings)).toMatchObject({ ok: true });
    const provider = rpc(paused);
    expect(await runTempoMpp(env, provider)).toMatchObject({ outcome: 'skipped' });
    expect(provider.fetchImpl).not.toHaveBeenCalled();
    const moved = { ...assetSettings, wallet: WRONG };
    expect(await save(moved, paused)).toMatchObject({ ok: true });
    expect(await runTempoMpp(env, rpc(moved, logs({ receiver: WRONG })))).toMatchObject({ outcome: 'ran', matched: 1 });
  });

  it('validates the mapped assets of an inserted settings document', async () => {
    const insert = (value: TempoMppSettings) => applyConfigOps(env, {
      actor: 'test', ops: [{ kind: 'file-json-insert', file: TOWER_CONFIG_FILES.integrations,
        pointer: TEMPO_MPP_POINTER, value }],
    });
    const missing = { ...assetSettings, mappings: [{ realm: 'absent.example.com', asset: 'absent.example' }] };
    expect(await insert(missing)).toMatchObject({ ok: false, error: 'invalid_changeset',
      detail: 'Select an available asset for each Tempo MPP realm.' });
    expect(await insert(assetSettings)).toMatchObject({ ok: true });
  });

  it('rescans from the starting block when a realm is added', async () => {
    const initial = { ...assetSettings, mappings: assetSettings.mappings.slice(0, 1) };
    const provider = rpc(assetSettings, [...logs(), ...logs({ realm: 'lookup.example.com', memoIndex: 16 })]);
    expect(await save(initial)).toMatchObject({ ok: true });
    expect(await runTempoMpp(env, provider)).toMatchObject({ matched: 1 });
    expect(await save(assetSettings, initial)).toMatchObject({ ok: true });
    expect(await runTempoMpp(env, provider)).toMatchObject({ matched: 2 });
    expect(provider.ranges).toEqual([[BLOCK, BLOCK], [BLOCK, BLOCK]]);
    expect(await pgRows('SELECT asset_id AS asset FROM noticeos.tempo_mpp_payments ORDER BY asset_id'))
      .toEqual([{ asset: FIRST }, { asset: SECOND }]);
  });

  it('resumes inside a dense block and advances once all its matching memos have been processed', async () => {
    const relevant = Array.from({ length: 22 }, (_, i) => logs({ memoIndex: 14 + i * 2 })).flat();
    const unrelated = Array.from({ length: 151 }, (_, i) =>
      logs({ realm: 'unrelated.example.com', memoIndex: 100 + i * 2 })).flat();
    const provider = rpc(assetSettings, [...unrelated, ...relevant].reverse());
    expect(await save(assetSettings)).toMatchObject({ ok: true });
    expect(await runTempoMpp(env, provider)).toMatchObject({ outcome: 'ran', matched: 20 });
    const position = 'SELECT next_block::int AS block, next_log_index AS log FROM noticeos.tempo_mpp_scans';
    expect(await pgRows(position)).toEqual([{ block: BLOCK, log: 54 }]);
    expect(await runTempoMpp(env, provider)).toMatchObject({ outcome: 'ran', matched: 2 });
    expect(await pgRows(position)).toEqual([{ block: BLOCK + 1, log: 0 }]);
    const rows = await pgRows('SELECT log_index AS log FROM noticeos.tempo_mpp_payments ORDER BY log_index');
    expect(rows.map(row => row.log)).toEqual(Array.from({ length: 22 }, (_, i) => 14 + i * 2));
  });

  it('saves the completed part of a scan when its deadline interrupts a receipt', async () => {
    const nextHash = `0x${'21'.repeat(32)}`;
    const incoming = [...logs(), ...logs({ memoIndex: 16, hash: nextHash })];
    const deadline = new AbortController();
    const slow = rpc(assetSettings, incoming, {
      beforeReceipt: hash => { if (hash === nextHash) deadline.abort(); },
    });
    expect(await save(assetSettings)).toMatchObject({ ok: true });
    expect(await runTempoMpp(env, { ...slow, deadline: deadline.signal })).toMatchObject({ outcome: 'ran', matched: 1 });
    const position = 'SELECT next_block::int AS block, next_log_index AS log FROM noticeos.tempo_mpp_scans';
    expect(await pgRows(position)).toEqual([{ block: BLOCK, log: 16 }]);
    expect(await runTempoMpp(env, rpc(assetSettings, incoming))).toMatchObject({ outcome: 'ran', matched: 1 });
    expect(await pgRows(position)).toEqual([{ block: BLOCK + 1, log: 0 }]);
    expect(await pgRows('SELECT log_index AS log FROM noticeos.tempo_mpp_payments ORDER BY log_index')).toEqual([{ log: 14 }, { log: 16 }]);
  });

  it('books a late sale record against its observed wallet after a wallet change', async () => {
    const original: TempoMppSettings = { ...assetSettings, chainId: TEMPO_MPP_MAINNET };
    expect(await save(original)).toMatchObject({ ok: true });
    expect(await runTempoMpp(env, rpc(original))).toMatchObject({ outcome: 'ran', matched: 1, recorded: 0 });
    const moved = { ...original, wallet: WRONG };
    expect(await save(moved, original)).toMatchObject({ ok: true });
    expect((await sale(moved)).status).toBe(201);
    expect(await runTempoMpp(env, rpc(moved, []))).toMatchObject({ outcome: 'ran', matched: 0, recorded: 1 });
    expect(await pgRows("SELECT account_ref AS wallet FROM noticeos.current_revenue WHERE source = 'tempo-mpp'"))
      .toEqual([{ wallet: WALLET }]);
  });

  it('keeps a failed scan retryable and completes a scan with no qualifying payments', async () => {
    expect(await save(assetSettings)).toMatchObject({ ok: true });
    const broken = rpc(assetSettings, logs(), { fail: true });
    expect(await runTempoMpp(env, broken)).toMatchObject({ outcome: 'failed' });
    expect(await pgRows('SELECT next_block::int AS next, failed, completed_at AS complete FROM noticeos.tempo_mpp_scans'))
      .toEqual([{ next: BLOCK, failed: true, complete: null }]);
    const wrongChain = rpc(assetSettings, logs(), { chain: TEMPO_MPP_MAINNET });
    expect(await runTempoMpp(env, wrongChain)).toMatchObject({ outcome: 'failed' });
    const retried = rpc(assetSettings, [
      ...logs({ realm: 'wrong.example.com' }),
      ...logs({ receiver: WRONG, memoIndex: 16 }),
      ...logs({ token: WRONG, memoIndex: 18 }),
      ...logs({ deliveredTo: WRONG, memoIndex: 20 }),
    ]);
    expect(await runTempoMpp(env, retried)).toMatchObject({ outcome: 'ran', matched: 0, recorded: 0 });
    expect(retried.ranges).toEqual([[BLOCK, BLOCK]]);
    expect(await pgRows('SELECT next_block::int AS next, failed FROM noticeos.tempo_mpp_scans')).toEqual([{ next: BLOCK + 1, failed: false }]);
    expect(await pgRows('SELECT 1 FROM noticeos.tempo_mpp_payments')).toEqual([]);
  });
});
