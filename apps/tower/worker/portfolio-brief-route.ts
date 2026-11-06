import type { PortfolioBriefEvidence, PortfolioBriefRead, PortfolioBriefRefreshRead } from '@noticeos/contract/portfolio-brief';
import { JSON_HEADERS } from './http';

export interface PortfolioBriefIngest {
  portfolioBrief?(): Promise<PortfolioBriefRead>;
  refreshPortfolioBrief?(evidence: PortfolioBriefEvidence, cadenceMs: number): Promise<PortfolioBriefRefreshRead>;
}

export async function handlePortfolioBriefRequest(request: Request, ingest: PortfolioBriefIngest): Promise<Response> {
  if (request.method !== 'GET') return new Response(null, { status: 405, headers: { Allow: 'GET' } });
  try {
    if (!ingest.portfolioBrief) throw new Error('unavailable');
    return Response.json(await ingest.portfolioBrief(), { headers: { ...JSON_HEADERS, 'cache-control': 'no-store' } });
  } catch {
    return Response.json({ error: 'portfolio_brief_unavailable' }, { status: 503, headers: JSON_HEADERS });
  }
}
