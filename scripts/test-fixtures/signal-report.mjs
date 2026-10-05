// Synthetic archive tests exercise the same two steps as the runtime:
// publish a history generation, then read it through the sole report writer.
// This helper derives no rows, CSV, findings or report fields.
import { publishSignalHistory } from '../signal-history.mjs';
import { analyzeSignalHistory } from '../signal-history-analyze.mjs';

export async function analyzeArchiveFixture({ input, ...options }) {
  const history = `${options.output}.history`;
  const published = await publishSignalHistory({ asset: options.asset, input, output: history });
  const { report, cost, ...summary } = await analyzeSignalHistory({
    ...options,
    history,
    generation: published.generation,
    now: options.now ?? new Date().toISOString(),
  });
  return summary;
}
