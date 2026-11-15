import type { TempoMppChain, TempoMppSettings } from './configuration.mjs';

export const TEMPO_MPP_SETTINGS_PATH = '/api/integrations/tempo-mpp';
export const TEMPO_MPP_SALE_PATH = '/api/tempo-mpp/sales';
export const TEMPO_MPP_SOURCE = 'tempo-mpp';

export const TEMPO_NETWORKS = {
  4217: { label: 'Tempo mainnet', rpc: 'https://rpc.tempo.xyz', explorer: 'https://explore.tempo.xyz' },
  42431: { label: 'Tempo testnet', rpc: 'https://rpc.moderato.tempo.xyz', explorer: 'https://explore.testnet.tempo.xyz' },
} satisfies Record<TempoMppChain, { label: string; rpc: string; explorer: string }>;

export function tempoMppScope(settings: TempoMppSettings): string {
  return [settings.chainId, settings.wallet.toLowerCase(), settings.token.toLowerCase(), settings.startBlock].join(':');
}

export type TempoMppPayment = {
  chainId: TempoMppChain;
  hash: string;
  logIndex: number;
  asset: string;
  baseUnits: string;
  settledAt: string;
  product: string | null;
  state: 'unmatched' | 'pending' | 'recorded' | 'test-payment' | 'amount-not-supported';
};

export interface TempoMppSetup {
  settings: TempoMppSettings | null;
  assets: { id: string; name: string }[];
  scan: { lastAttemptAt: string; completedAt: string | null; failed: boolean; nextBlock: number } | null;
  payments: TempoMppPayment[];
  hasMore: boolean;
}
