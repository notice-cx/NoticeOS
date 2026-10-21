import { z } from 'zod';
import { COUNT_FORECAST_MODEL, COUNT_HISTORY_PERIODS } from './count-forecast.js';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const probability = z.number().gt(0).lt(1);
const commonCountInputs = z.object({ metric: z.string(), baselinePerDay: z.number().nonnegative(), alpha: probability,
  windowHours: z.number().int().positive().multipleOf(24) }).passthrough();
/** Only supported, structurally complete evidence may be retired by a refresh. */
export const StoredCountWarningInputs = z.union([
  commonCountInputs.extend({ observed: count, prediction: z.object({ model: z.literal(COUNT_FORECAST_MODEL),
    comparisonCounts: z.array(count).length(COUNT_HISTORY_PERIODS), historicalMean: z.number().nonnegative(),
    typical: z.number().nonnegative(), logTypical: z.number(), slope: z.number(), scale: z.number().positive(),
    degreesOfFreedom: z.number().positive(), alpha: probability, lower: count, upper: count, pooledVariance: z.number().nonnegative(),
  }).passthrough().refine((value) => value.lower <= value.upper && value.degreesOfFreedom === value.comparisonCounts.length - 2),
    predictiveScore: z.number().min(0).max(1), windowDays: z.number().int().positive(), windowObserved: count })
    .refine((value) => value.windowDays * 24 === value.windowHours && value.windowObserved === value.observed),
  commonCountInputs.extend({ prediction: z.never().optional(), observed: count,
    lambda: z.number().nonnegative(), pLowerTail: z.number().min(0).max(1) }).refine((value) => value.windowHours === 24),
  commonCountInputs.extend({ prediction: z.never().optional(), windowObserved: count,
    windowDays: z.number().int().positive(), lambda: z.number().nonnegative(), pLowerTail: z.number().min(0).max(1) })
    .refine((value) => value.windowDays * 24 === value.windowHours),
]);

const changeSchema = z.object({ flag: z.string(), metric: z.string(), reason: z.string() });
const planSchema = z.object({
  asset: z.string(), reportDate: z.string(), reportGeneratedAt: z.string(), model: z.string(),
  preparedAt: z.string(), expiresAt: z.string(), applyToken: z.string(),
  retire: z.array(changeSchema), preserve: z.array(changeSchema),
  create: z.array(z.object({ metric: z.string(), rule: z.string(), inputs: z.record(z.string(), z.unknown()) })),
  evaluations: z.array(z.object({ metric: z.string(), outcome: z.string(), reason: z.string().nullable(), windowHours: z.number().nullable() })),
});
export const StoredAnomalyRefreshReceipt = planSchema.extend({ mode: z.enum(['preview', 'applied']), appliedAt: z.string().optional(), replayed: z.boolean() });
export type StoredAnomalyRefreshPlan = z.infer<typeof planSchema>;
export type StoredAnomalyRefreshResult = z.infer<typeof StoredAnomalyRefreshReceipt>;
