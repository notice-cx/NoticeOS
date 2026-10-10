// A link-outreach campaign's targets: the touch log of a dead resource's
// inbound links being reclaimed, imported from the operator's target list and
// read back open. Idempotent by construction: a page is inserted once (site,
// domain and page are the key), a status only moves forward from one strictly
// earlier in the funnel, so a row a person moved on is never dragged back and
// won, skip and dead are never overwritten, and a verification stamp only
// moves forward. The whole import is one transaction.

/** The funnel, earliest first; `won` is terminal and set by a person. */
export const RECLAMATION_FUNNEL = ['queued', 'sent', 'opened', 'clicked', 'replied', 'won'] as const;

/** Every status a target can hold: the funnel and its two exits. */
export const RECLAMATION_STATUSES = [...RECLAMATION_FUNNEL, 'skip', 'dead'] as const;
export type ReclamationStatus = (typeof RECLAMATION_STATUSES)[number];

/** One target as the import sends it. Instants are ISO-8601 UTC. */
export type ReclamationTargetInput = {
  tier: number | null;
  segment: string | null;
  domain: string;
  /** '' is "no specific page", never NULL: it is part of the key. */
  referringPage: string;
  linksToDead: string | null;
  replaceWith: string | null;
  contact: string | null;
  notes: string | null;
  status: ReclamationStatus;
  statusAt: string | null;
  lastVerifiedAt: string | null;
  outcomeNote: string | null;
};

export interface ReclamationImportResult {
  /** Targets in the list. */
  targets: number;
  /** Pages the store did not hold before. */
  inserted: number;
  /** Stored pages whose status moved forward. */
  moved: number;
  /** Stored pages whose verification stamp moved forward. */
  verified: number;
}

/** One open target, in the names the reclamation-match rule reads
 * (scripts/signal-insights.mjs `reclamationTargetList`). */
export interface OpenReclamationTarget {
  domain: string;
  /** '' is "no specific page". */
  referringPage: string;
  replaceWith: string | null;
  status: ReclamationStatus;
}

/**
 * A site's open targets, at most `limit`: every target not won, skipped or
 * dead, in the order they were stored, which is the list's own order.
 */
export async function readOpenReclamationTargets(
  env: IngestEnv,
  asset: string,
  limit: number,
): Promise<OpenReclamationTarget[]> {
  const rows = await env.STORE.read((tx) =>
    tx.query<{ domain: string; referring_page: string; replace_with: string | null; status: ReclamationStatus }>(
      `SELECT domain, referring_page, replace_with, status
         FROM noticeos.reclamation_targets
        WHERE asset_id = $1 AND status NOT IN ('won', 'skip', 'dead')
        ORDER BY target_number
        LIMIT $2`,
      [asset, limit],
    ),
  );
  return rows.map((row) => ({
    domain: row.domain,
    referringPage: row.referring_page,
    replaceWith: row.replace_with,
    status: row.status,
  }));
}

/** The statuses a stored row may hold and still be moved to `status`. */
export function earlierThan(status: ReclamationStatus): ReclamationStatus[] {
  const rank = (RECLAMATION_FUNNEL as readonly string[]).indexOf(status);
  return rank < 1 ? [] : RECLAMATION_FUNNEL.slice(0, rank);
}

/** Store one site's target list: new pages, then status moves, then stamps. */
export async function importReclamationTargets(
  env: IngestEnv,
  asset: string,
  targets: readonly ReclamationTargetInput[],
): Promise<ReclamationImportResult> {
  return env.STORE.write(async (tx) => {
    const inserted = await tx.execute(
      `INSERT INTO noticeos.reclamation_targets
         (workspace_id, asset_id, tier, segment, domain, referring_page, links_to_dead, replace_with,
          contact, notes, status, status_at, last_verified_at, outcome_note)
       SELECT $1::uuid, $2, t.tier, t.segment, t.domain, t.referring_page, t.links_to_dead, t.replace_with,
              t.contact, t.notes, t.status, t.status_at, t.last_verified_at, t.outcome_note
         FROM unnest($3::int4[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[],
                     $10::text[], $11::text[], $12::timestamptz[], $13::timestamptz[], $14::text[])
           WITH ORDINALITY AS t(tier, segment, domain, referring_page, links_to_dead, replace_with, contact,
                                notes, status, status_at, last_verified_at, outcome_note, listed)
        ORDER BY t.listed
       ON CONFLICT (workspace_id, asset_id, domain, referring_page) DO NOTHING`,
      [
        tx.workspaceId,
        asset,
        targets.map((t) => t.tier),
        targets.map((t) => t.segment),
        targets.map((t) => t.domain),
        targets.map((t) => t.referringPage),
        targets.map((t) => t.linksToDead),
        targets.map((t) => t.replaceWith),
        targets.map((t) => t.contact),
        targets.map((t) => t.notes),
        targets.map((t) => t.status),
        targets.map((t) => t.statusAt),
        targets.map((t) => t.lastVerifiedAt),
        targets.map((t) => t.outcomeNote),
      ],
    );

    // A page stored before this list carried its state catches up too.
    let moved = 0;
    for (const target of targets) {
      const guard = earlierThan(target.status);
      if (guard.length === 0) continue;
      moved += await tx.execute(
        `UPDATE noticeos.reclamation_targets
            SET status = $4, status_at = $5::timestamptz, outcome_note = $6, updated_at = now()
          WHERE asset_id = $1 AND domain = $2 AND referring_page = $3 AND status = ANY($7::text[])`,
        [asset, target.domain, target.referringPage, target.status, target.statusAt, target.outcomeNote, guard],
      );
    }

    // Verification is not a funnel position: a row further along still needs
    // to know how old its evidence is, and the stamp only moves forward.
    let verified = 0;
    for (const target of targets) {
      if (target.lastVerifiedAt === null) continue;
      verified += await tx.execute(
        `UPDATE noticeos.reclamation_targets
            SET last_verified_at = $4::timestamptz, updated_at = now()
          WHERE asset_id = $1 AND domain = $2 AND referring_page = $3
            AND (last_verified_at IS NULL OR last_verified_at < $4::timestamptz)`,
        [asset, target.domain, target.referringPage, target.lastVerifiedAt],
      );
    }
    return { targets: targets.length, inserted, moved, verified };
  });
}
