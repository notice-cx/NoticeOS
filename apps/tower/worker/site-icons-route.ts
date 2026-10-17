// A site's Settings tab, Read again:
//
//   POST /api/assets/:id/icons — read this site's icons now, through the
//                                ingest's daily read (`readSiteIcons`)
//
// The Tower never fetches a site's page itself: the ingest's read is the one
// that goes through the egress gate and stores what it found.

import type { SiteIconsReadInput, SiteIconsReadResult } from "@noticeos/contract/site-icons";
import { siteIconsReadInput } from "../../../scripts/workspace-operations.mjs";
import { JSON_HEADERS, crossOrigin, isJsonRequest, jsonError } from "./http";

export interface SiteIconsReader {
  readSiteIcons(input: SiteIconsReadInput, originalProof?: Request): Promise<SiteIconsReadResult>;
}

export const SITE_ICONS_PATH = /^\/api\/assets\/([^/]+)\/icons$/;

/** The body is an empty JSON object; the site is the one the path names. A
 * refusal (paused, no such site) is an answer the card draws, not a fault. */
export async function handleSiteIconsReadRequest(request: Request, url: URL,
  ingest: SiteIconsReader, asset: string): Promise<Response> {
  if (request.method !== "POST") return jsonError("method_not_allowed", 405);
  if (crossOrigin(request, url)) return jsonError("forbidden", 403);
  if (!isJsonRequest(request)) return jsonError("unsupported_media_type", 415);
  try {
    if ((await siteIconsReadInput(request)).asset !== asset) return jsonError("invalid_icons_read", 422);
  } catch { return jsonError("invalid_icons_read", 422); }
  let result: SiteIconsReadResult;
  try { result = await ingest.readSiteIcons({ asset }); }
  catch { return jsonError("icons_read_failed", 500); }
  return Response.json(result, { headers: JSON_HEADERS });
}
