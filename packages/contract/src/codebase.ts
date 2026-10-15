// The codebase report: one measurement run over a site's repository, the
// envelope `POST /api/codebase-report` accepts and `noticeos.codebase_reports`
// stores verbatim. Strict at every level, bounded in every list, and carrying
// file paths only, never source text.

import { z } from 'zod';
import { CODEBASE_MEASURE_KEYS, type CodebaseMeasureKey, type CodebaseMeasureUnit, CODEBASE_MEASURES } from './codebase-measures.js';

export * from './codebase-measures.js';

/** The largest report body accepted, in bytes of UTF-8 JSON. */
export const CODEBASE_REPORT_MAX_BYTES = 256 * 1024;

export const CODEBASE_REPORT_LIMITS = Object.freeze({
  paths: 20,
  byLanguage: 12,
  duplicates: 20,
  duplicateFiles: 10,
  complexFunctions: 20,
  unused: 50,
  largestFiles: 10,
  pathLength: 512,
});

/** UTF-8 length of a string; the contract runs where no `TextEncoder` is typed. */
export function utf8Bytes(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

const isoDateTime = z.iso.datetime({ offset: true });
const count = z.number().int().nonnegative();
const line = z.number().int().min(1);
const name = z.string().min(1).max(256);
const version = z.string().min(1).max(64);

/**
 * A repository-relative path: no leading slash or drive, no `..` segment, no
 * backslash and no control character, so a stored path can never name a file
 * outside the repository it was measured in.
 */
export const CodebasePath = z
  .string()
  .min(1)
  .max(CODEBASE_REPORT_LIMITS.pathLength)
  .refine((p) => !p.startsWith('/') && !/^[A-Za-z]:/u.test(p), { message: 'path must be relative to the repository' })
  .refine((p) => !p.includes('\\'), { message: 'path separators are forward slashes' })
  .refine((p) => !p.split('/').includes('..'), { message: 'path must not contain ..' })
  .refine((p) => !/[\u0000-\u001f\u007f]/u.test(p), { message: 'path must not contain control characters' });

/** Host and path only: no scheme, no credentials, no `.git` suffix. */
const remote = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9.-]+(?::[0-9]+)?\/[A-Za-z0-9._~/-]+$/u, {
    message: 'remote is host/path with no scheme or credentials (github.com/example/site)',
  })
  .refine((r) => !r.endsWith('.git'), { message: 'remote has no .git suffix' });

export const CodebaseRepository = z.strictObject({
  remote: remote.optional(),
  ref: z.string().min(1).max(255),
  commit: z.string().regex(/^[0-9a-f]{40}$/u, { message: 'commit is 40 lowercase hex digits' }),
  committedAt: isoDateTime,
});

export const CodebaseTools = z.strictObject({
  image: z.string().min(1).max(512).optional(),
  scc: version,
  jscpd: version,
  lizard: version,
});

const measureSchema: Record<CodebaseMeasureUnit, z.ZodNumber> = {
  count,
  percent: z.number().min(0).max(100),
  ratio: z.number().nonnegative(),
  mean: z.number().nonnegative(),
};
const unitOf = new Map(CODEBASE_MEASURES.map((m) => [m.key, m.unit]));

/** Every measure optional: an absent key is unmeasured, never 0. */
export const CodebaseMeasuresSchema = z.strictObject(
  Object.fromEntries(
    CODEBASE_MEASURE_KEYS.map((key) => [key, measureSchema[unitOf.get(key)!].optional()]),
  ) as Record<CodebaseMeasureKey, z.ZodOptional<z.ZodNumber>>,
);

export const CodebaseLanguage = z.strictObject({
  language: z.string().min(1).max(64),
  files: count,
  code_lines: count,
});

export const CodebaseDuplicate = z.strictObject({
  lines: count,
  files: z
    .array(z.strictObject({ path: CodebasePath, startLine: line }))
    .min(2)
    .max(CODEBASE_REPORT_LIMITS.duplicateFiles),
});

export const CodebaseComplexFunction = z.strictObject({
  path: CodebasePath,
  name,
  line,
  complexity: count,
  length: count,
});

export const CodebaseUnusedItem = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('file'), path: CodebasePath }),
  z.strictObject({ kind: z.literal('export'), path: CodebasePath, name }),
  z.strictObject({ kind: z.literal('dependency'), name }),
]);

export const CodebaseLargestFile = z.strictObject({ path: CodebasePath, code_lines: count });

/** Each list optional: a tool that did not run leaves its list out. */
export const CodebaseFindings = z.strictObject({
  duplicates: z.array(CodebaseDuplicate).max(CODEBASE_REPORT_LIMITS.duplicates).optional(),
  complexFunctions: z.array(CodebaseComplexFunction).max(CODEBASE_REPORT_LIMITS.complexFunctions).optional(),
  unused: z.array(CodebaseUnusedItem).max(CODEBASE_REPORT_LIMITS.unused).optional(),
  largestFiles: z.array(CodebaseLargestFile).max(CODEBASE_REPORT_LIMITS.largestFiles).optional(),
});

export const CodebaseReport = z
  .strictObject({
    asset: z.string().min(1).max(253),
    generatedAt: isoDateTime,
    repository: CodebaseRepository,
    /** The subpaths measured; absent means the whole repository. */
    paths: z.array(CodebasePath).min(1).max(CODEBASE_REPORT_LIMITS.paths).optional(),
    tools: CodebaseTools,
    measures: CodebaseMeasuresSchema,
    /** Why a measure is absent, in the sentence the Tower shows beside "Not measured". */
    unmeasured: z.partialRecord(z.enum(CODEBASE_MEASURE_KEYS), z.string().min(1).max(200)).optional(),
    byLanguage: z.array(CodebaseLanguage).max(CODEBASE_REPORT_LIMITS.byLanguage).optional(),
    findings: CodebaseFindings.optional(),
  })
  .superRefine((report, ctx) => {
    if (utf8Bytes(JSON.stringify(report)) > CODEBASE_REPORT_MAX_BYTES) {
      ctx.addIssue({ code: 'custom', message: `report is larger than ${CODEBASE_REPORT_MAX_BYTES} bytes`, path: [] });
    }
  });
export type CodebaseReport = z.infer<typeof CodebaseReport>;
