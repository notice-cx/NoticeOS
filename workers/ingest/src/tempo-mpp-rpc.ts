import { Attribution } from 'mppx/tempo';
import { TEMPO_ADDRESS, TEMPO_HASH, type TempoMppSettings } from '@noticeos/contract/configuration';
import { TEMPO_NETWORKS } from '@noticeos/contract/tempo-mpp';

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const TRANSFER_WITH_MEMO = '0x57bc7354aa85aed339e000bccffabbc529466af35f0772c8f8ee1145927de7f0';
const BLOCKS_PER_SCAN = 20_000;
const MAX_PAYMENTS_PER_SCAN = 20;

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : null;
const word = (value: unknown): value is `0x${string}` => typeof value === 'string' && TEMPO_HASH.test(value);
const address = (value: unknown): value is string => typeof value === 'string' && TEMPO_ADDRESS.test(value);
const invalid = () => new Error('Tempo returned an incomplete or invalid result.');
const hex = (value: number) => `0x${value.toString(16)}`;

function quantity(value: unknown): number {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) throw invalid();
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw invalid();
  return result;
}

interface Tip20Log {
  address: string;
  hash: string;
  block: number;
  index: number;
  from: `0x${string}`;
  to: `0x${string}`;
  amount: bigint;
  memo: `0x${string}` | null;
}

function transfer(value: unknown, signature: string): Tip20Log | null {
  const log = object(value);
  const topics: unknown[] = Array.isArray(log?.topics) ? log.topics : [];
  if (topics[0] !== signature) return null;
  const [, from, to, memo] = topics;
  const withMemo = signature === TRANSFER_WITH_MEMO;
  if (!log || log.removed === true || !address(log.address) || !word(log.transactionHash) || !word(log.data) ||
      !word(from) || !word(to) || (withMemo ? topics.length !== 4 || !word(memo) : topics.length !== 3)) throw invalid();
  return {
    address: log.address.toLowerCase(), hash: log.transactionHash.toLowerCase(), block: quantity(log.blockNumber),
    index: quantity(log.logIndex), from: `0x${from.slice(-40).toLowerCase()}`, to: `0x${to.slice(-40).toLowerCase()}`,
    amount: BigInt(log.data), memo: word(memo) ? `0x${memo.slice(2).toLowerCase()}` : null,
  };
}

export interface TempoDelivery {
  hash: string;
  logIndex: number;
  asset: string;
  memo: string;
  baseUnits: string;
  settledAt: string;
}

class RangeTooLarge extends Error {}

export interface TempoScanCursor {
  block: number;
  logIndex: number;
}

export async function readTempoRange(
  settings: TempoMppSettings, cursor: TempoScanCursor, fetchImpl: typeof fetch, deadline = AbortSignal.timeout(55_000),
) {
  const from = cursor.block;
  const rpc = async (method: string, params: unknown[]): Promise<unknown> => {
    const response = await fetchImpl(TEMPO_NETWORKS[settings.chainId].rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      redirect: 'manual',
      signal: AbortSignal.any([deadline, AbortSignal.timeout(8_000)]),
    });
    const body = response.ok ? object(await response.json()) : null;
    if (method === 'eth_getLogs' && (response.status === 413 || object(body?.error)?.code === -32005 ||
        /block range|too many (logs|results)|range (is )?too (large|wide)|query exceeds/i.test(String(object(body?.error)?.message ?? '')))) {
      throw new RangeTooLarge();
    }
    if (!body || body.error || !Object.hasOwn(body, 'result')) throw invalid();
    return body.result;
  };
  const wallet = settings.wallet.toLowerCase();
  const token = settings.token.toLowerCase();
  if (quantity(await rpc('eth_chainId', [])) !== settings.chainId) throw new Error('Tempo returned the wrong network.');
  const finalized = object(await rpc('eth_getBlockByNumber', ['finalized', false]));
  const head = quantity(finalized?.number);
  const payments: TempoDelivery[] = [];
  if (from > head) return { cursor, complete: from === head + 1 && cursor.logIndex === 0, payments };

  // TIP-20 has six decimals. Check the configured contract and denomination before booking cents.
  const [decimals, currency] = await Promise.all([
    rpc('eth_call', [{ to: token, data: '0x313ce567' }, hex(head)]),
    rpc('eth_call', [{ to: token, data: '0xe5a6b10f' }, hex(head)]),
  ]);
  const usd = /^0x0{62}20[0]{62}03555344[0]{58}$/i;
  if (quantity(decimals) !== 6 || typeof currency !== 'string' || !usd.test(currency)) {
    throw new Error('The configured token must be a six-decimal USD token.');
  }

  let through = Math.min(head, from + BLOCKS_PER_SCAN - 1);
  let logs: unknown[];
  for (;;) {
    try {
      const result = await rpc('eth_getLogs', [{
        address: token, fromBlock: hex(from), toBlock: hex(through),
        topics: [TRANSFER_WITH_MEMO, null, `0x${wallet.slice(2).padStart(64, '0')}`],
      }]);
      if (!Array.isArray(result)) throw invalid();
      logs = result;
      break;
    } catch (error) {
      if (!(error instanceof RangeTooLarge) || from === through) throw error;
      through = from + Math.floor((through - from) / 2);
    }
  }

  type MatchedMemo = { candidate: Tip20Log; memo: `0x${string}`; asset: string };
  const matched = new Map<string, MatchedMemo>();
  for (const rawLog of logs) {
    const candidate = transfer(rawLog, TRANSFER_WITH_MEMO);
    if (!candidate?.memo || candidate.address !== token || candidate.to !== wallet || candidate.from === wallet ||
        candidate.amount === 0n || candidate.block < from || candidate.block > through ||
        (candidate.block === from && candidate.index < cursor.logIndex)) continue;
    const memo = candidate.memo;
    const mappings = settings.mappings.filter(({ realm }) => Attribution.verifyServer(memo, realm));
    if (mappings.length === 1) {
      matched.set(`${candidate.block}:${candidate.index}`, { candidate, memo, asset: mappings[0]!.asset });
    }
  }
  // Apply the limit after realm filtering. The first unprocessed memo is an inclusive checkpoint.
  const ordered = [...matched.values()].sort((a, b) => a.candidate.block - b.candidate.block || a.candidate.index - b.candidate.index);
  const remaining = ordered[MAX_PAYMENTS_PER_SCAN]?.candidate;
  const receipts = new Map<string, { logs: unknown[]; success: boolean }>();
  const blockTimes = new Map<number, string>();
  async function readDelivery({ candidate, memo, asset }: MatchedMemo): Promise<TempoDelivery | null> {
    deadline.throwIfAborted();
    let receipt = receipts.get(candidate.hash);
    if (!receipt) {
      const result = object(await rpc('eth_getTransactionReceipt', [candidate.hash]));
      if (!result || result.transactionHash !== candidate.hash || quantity(result.blockNumber) !== candidate.block ||
          !Array.isArray(result.logs) || (result.status !== '0x1' && result.status !== '0x0')) throw invalid();
      receipt = { logs: result.logs, success: result.status === '0x1' };
      receipts.set(candidate.hash, receipt);
    }
    if (!receipt.success) return null;

    const sameTransfer = (log: Tip20Log | null) => log && log.address === token && log.hash === candidate.hash &&
      log.block === candidate.block && log.from === candidate.from && log.to === wallet && log.amount === candidate.amount;
    const memoConfirmed = receipt.logs.some((raw) => {
      const log = transfer(raw, TRANSFER_WITH_MEMO);
      return sameTransfer(log) && log?.index === candidate.index && log.memo === memo;
    });
    if (!memoConfirmed) throw invalid();
    // TIP-20 emits the delivery directly before its memo. A held payment's Transfer goes to the guard.
    const delivered = receipt.logs.some((raw) => {
      const log = transfer(raw, TRANSFER);
      return sameTransfer(log) && log?.index === candidate.index - 1;
    });
    if (!delivered) return null;

    let settledAt = blockTimes.get(candidate.block);
    if (settledAt === undefined) {
      const block = object(await rpc('eth_getBlockByNumber', [hex(candidate.block), false]));
      if (quantity(block?.number) !== candidate.block) throw invalid();
      settledAt = new Date(quantity(block?.timestamp) * 1000).toISOString();
      blockTimes.set(candidate.block, settledAt);
    }
    return { hash: candidate.hash, logIndex: candidate.index, asset, memo, baseUnits: String(candidate.amount), settledAt };
  }
  for (const match of ordered.slice(0, MAX_PAYMENTS_PER_SCAN)) {
    try {
      const payment = await readDelivery(match);
      if (payment) payments.push(payment);
    } catch (error) {
      if (!deadline.aborted) throw error;
      const { block, index } = match.candidate;
      return { cursor: { block, logIndex: index }, complete: false, payments };
    }
  }
  return {
    cursor: remaining ? { block: remaining.block, logIndex: remaining.index } : { block: through + 1, logIndex: 0 },
    complete: !remaining && through === head,
    payments,
  };
}
