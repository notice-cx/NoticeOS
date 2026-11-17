/** A daily report can cover dates for which GA4 returned no row. The run ID
 * records the current property date only when GA4 explicitly reported it. */
export const GA4_REPORTED_DAY_SUFFIX = ':ga4-day-v1:';
export const GA4_REPORTED_DAY_PATTERN = `${GA4_REPORTED_DAY_SUFFIX}([0-9]{4}-[0-9]{2}-[0-9]{2})$`;
