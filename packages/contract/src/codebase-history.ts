import { z } from 'zod';
import { CodebasePath, CodebaseReport, utf8Bytes } from './codebase.js';

export const CODEBASE_IMPORT_MAX_BYTES = 1024 * 1024;
export const ReleaseRecord = z.strictObject({
  source: CodebasePath,
  sequence: z.number().int().nonnegative(),
  id: z.string().regex(/^[a-f0-9]{64}$/u),
  commit: z.string().regex(/^[a-f0-9]{40}$/u),
  recordedAt: z.iso.datetime({ offset: true }),
  deployedAt: z.iso.datetime({ offset: true }).optional(),
  branch: z.string().min(1).max(255).optional(),
  counts: z.strictObject({ added: z.number().int().nonnegative(), changed: z.number().int().nonnegative(), removed: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).optional(),
  supersedes: z.array(z.string().regex(/^[a-f0-9]{40}$/u)).max(100),
});
export type ReleaseRecord = z.infer<typeof ReleaseRecord>;

export const CodebaseHistoryImport = z.strictObject({
  version: z.literal(1),
  asset: z.string().min(1).max(253),
  reports: z.array(CodebaseReport).max(100),
  releases: z.array(ReleaseRecord).max(500),
}).superRefine((bundle, ctx) => {
  if (utf8Bytes(JSON.stringify(bundle)) > CODEBASE_IMPORT_MAX_BYTES) ctx.addIssue({ code: 'custom', message: 'import batch exceeds 1 MiB' });
  for (const report of bundle.reports) {
    if (report.asset !== bundle.asset || !report.history || !report.tools.profile || !/@sha256:[a-f0-9]{64}$/u.test(report.tools.image ?? '')) {
      ctx.addIssue({ code: 'custom', message: 'history requires the same asset, a snapshot cutoff, pinned image and measurement profile' });
    }
  }
});
export type CodebaseHistoryImport = z.infer<typeof CodebaseHistoryImport>;
