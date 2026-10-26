import {
  POSTHOG_ROW_LIMITS, POSTHOG_WEB_VITALS_TOP_PATHS, POSTHOG_INTERACTION_TARGET_MAX,
  POSTHOG_MESSAGE_MAX, POSTHOG_ELEMENT_TEXT_MAX,
  type PosthogFamily, type PosthogFunnel,
} from '@noticeos/contract';
import { shiftCalendarDate } from './time-zone.js';
import type { PosthogWindow } from './posthog-dumps.js';

export interface PosthogQuery {
  text: string;
  columns: readonly string[];
}

/** A HogQL string literal. Values are already validated upstream; escaping is
 * the second lock. */
export function hogqlString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function timeBounds(window: PosthogWindow): string {
  const after = shiftCalendarDate(window.end, 1);
  return (
    `timestamp >= toDateTime(${hogqlString(`${window.start} 00:00:00`)}) ` +
    `AND timestamp < toDateTime(${hogqlString(`${after} 00:00:00`)})`
  );
}

// The producer contract uses integer inverse inclusion probabilities. Missing or
// malformed properties remain one observed event, never an invented multiplier.
export const POSTHOG_SAMPLE_WEIGHT_SQL =
  "if(match(coalesce(toString(properties.sample_weight), ''), '^[1-9][0-9]{0,5}$'), toFloatOrZero(toString(properties.sample_weight)), 1)";

export function posthogQuery(
  family: PosthogFamily,
  window: PosthogWindow,
  funnels: readonly PosthogFunnel[] = [],
): PosthogQuery {
  const bounds = timeBounds(window);
  const limit = POSTHOG_ROW_LIMITS[family] + 1;
  switch (family) {
    case 'web-daily':
      return {
        columns: ['date', 'pageviews', 'people', 'sessions', 'estimated_pageviews', 'sampled_events', 'estimated_sessions'],
        text: [
          'SELECT pv.date AS date, pv.pageviews AS pageviews, pv.people AS people, pv.sessions AS sessions,',
          '  pv.estimated_pageviews AS estimated_pageviews, pv.sampled_events AS sampled_events,',
          '  coalesce(s.estimated_sessions, 0) AS estimated_sessions',
          'FROM (',
          '  SELECT',
          '    toString(toDate(timestamp)) AS date,',
          '    count() AS pageviews,',
          '    uniq(person_id) AS people,',
          "    uniq(nullIf(toString(properties.$session_id), '')) AS sessions,",
          `    sum(${POSTHOG_SAMPLE_WEIGHT_SQL}) AS estimated_pageviews,`,
          `    countIf(${POSTHOG_SAMPLE_WEIGHT_SQL} > 1) AS sampled_events`,
          '  FROM events',
          `  PREWHERE event = '$pageview' AND ${bounds}`,
          '  GROUP BY date',
          ') AS pv',
          'LEFT JOIN (',
          '  SELECT date, sum(session_weight) AS estimated_sessions',
          '  FROM (',
          '    SELECT toString(toDate(timestamp)) AS date,',
          "      nullIf(toString(properties.$session_id), '') AS session_id,",
          `      min(${POSTHOG_SAMPLE_WEIGHT_SQL}) AS session_weight`,
          '    FROM events',
          `    PREWHERE event = '$pageview' AND ${bounds}`,
          '    GROUP BY date, session_id',
          "    HAVING session_id IS NOT NULL AND countIf(event = '$pageview') > 0",
          '  )',
          '  GROUP BY date',
          ') AS s ON pv.date = s.date',
          'ORDER BY date ASC',
          `LIMIT ${limit}`,
        ].join('\n'),
      };
    case 'events':
      return {
        columns: ['event', 'count', 'people', 'first_seen', 'last_seen', 'estimated_count', 'sampled_events'],
        text: [
          'SELECT',
          '  event,',
          '  count() AS count,',
          '  uniq(person_id) AS people,',
          '  toString(min(toDate(timestamp))) AS first_seen,',
          '  toString(max(toDate(timestamp))) AS last_seen,',
          `  sum(${POSTHOG_SAMPLE_WEIGHT_SQL}) AS estimated_count,`,
          `  countIf(${POSTHOG_SAMPLE_WEIGHT_SQL} > 1) AS sampled_events`,
          'FROM events',
          `PREWHERE ${bounds}`,
          'GROUP BY event',
          'ORDER BY count DESC, event ASC',
          `LIMIT ${limit}`,
        ].join('\n'),
      };
    case 'exceptions':
      return {
        columns: [
          'exception_type',
          'exception_message',
          'occurrences',
          'people',
          'sessions',
          'max_per_session',
          'has_source_file',
          'top_path',
          'top_browser',
        ],
        text: [
          'SELECT',
          '  exception_type,',
          '  exception_message,',
          '  count() AS occurrences,',
          '  uniq(person_id) AS people,',
          '  uniq(session_id) AS sessions,',
          '  max(session_occurrences) AS max_per_session,',
          '  max(source_file) AS has_source_file,',
          "  argMax(path, tuple(path_occurrences, coalesce(path, ''))) AS top_path,",
          "  argMax(browser, tuple(browser_occurrences, coalesce(browser, ''))) AS top_browser",
          'FROM (',
          '  SELECT',
          '    exception_type, exception_message, person_id, session_id, path, browser, source_file,',
          '    if(session_id IS NULL, 1, count() OVER (PARTITION BY exception_type, exception_message, session_id)) AS session_occurrences,',
          '    count() OVER (PARTITION BY exception_type, exception_message, path) AS path_occurrences,',
          '    count() OVER (PARTITION BY exception_type, exception_message, browser) AS browser_occurrences',
          '  FROM (',
          '    SELECT',
          "      nullIf(if(JSONExtractString(properties, '$exception_list', 1, 'type') != '', JSONExtractString(properties, '$exception_list', 1, 'type'), JSONExtractString(properties, '$exception_type')), '') AS exception_type,",
          `      nullIf(substring(if(JSONExtractString(properties, '$exception_list', 1, 'value') != '', JSONExtractString(properties, '$exception_list', 1, 'value'), JSONExtractString(properties, '$exception_message')), 1, ${POSTHOG_MESSAGE_MAX}), '') AS exception_message,`,
          '      person_id,',
          "      nullIf(toString(properties.$session_id), '') AS session_id,",
          "      nullIf(toString(properties.$pathname), '') AS path,",
          "      nullIf(toString(properties.$browser), '') AS browser,",
          `      if(match(JSONExtractRaw(properties, '$exception_list'), '"(filename|abs_path)": *"[^"]+"'), 1, 0) AS source_file`,
          '    FROM events',
          `    PREWHERE event = '$exception' AND ${bounds}`,
          '  )',
          ')',
          'GROUP BY exception_type, exception_message',
          'ORDER BY occurrences DESC, people DESC, exception_type ASC, exception_message ASC',
          `LIMIT ${limit}`,
        ].join('\n'),
      };
    case 'rageclicks':
      return {
        columns: [
          'path',
          'tag',
          'text',
          'attr',
          'clicks',
          'people',
          'desktop_clicks',
          'mobile_clicks',
          'tablet_clicks',
          'page_people',
          'estimated_clicks',
          'estimated_desktop_clicks',
          'estimated_mobile_clicks',
          'estimated_tablet_clicks',
          'sampled_events',
        ],
        text: [
          'SELECT',
          '  rc.path AS path, rc.tag AS tag, rc.text AS text, rc.attr AS attr,',
          '  rc.clicks AS clicks, rc.people AS people,',
          '  rc.desktop_clicks AS desktop_clicks, rc.mobile_clicks AS mobile_clicks, rc.tablet_clicks AS tablet_clicks,',
          '  coalesce(pv.page_people, 0) AS page_people,',
          '  rc.estimated_clicks AS estimated_clicks, rc.estimated_desktop_clicks AS estimated_desktop_clicks,',
          '  rc.estimated_mobile_clicks AS estimated_mobile_clicks, rc.estimated_tablet_clicks AS estimated_tablet_clicks,',
          '  rc.sampled_events AS sampled_events',
          'FROM (',
          '  SELECT',
          '    path, tag, text, attr,',
          '    count() AS clicks,',
          '    uniq(person_id) AS people,',
          "    countIf(device = 'Desktop') AS desktop_clicks,",
          "    countIf(device = 'Mobile') AS mobile_clicks,",
          "    countIf(device = 'Tablet') AS tablet_clicks,",
          "    sum(sample_weight) AS estimated_clicks,",
          "    sumIf(sample_weight, device = 'Desktop') AS estimated_desktop_clicks,",
          "    sumIf(sample_weight, device = 'Mobile') AS estimated_mobile_clicks,",
          "    sumIf(sample_weight, device = 'Tablet') AS estimated_tablet_clicks,",
          "    countIf(sample_weight > 1) AS sampled_events",
          '  FROM (',
          '    SELECT',
          '      path, person_id, device, sample_weight,',
          "      nullIf(extract(target, '^([A-Za-z0-9_-]+)'), '') AS tag,",
          `      nullIf(substring(extract(target, 'text="([^"]*)"'), 1, ${POSTHOG_ELEMENT_TEXT_MAX}), '') AS text,`,
          "      coalesce(nullIf(extract(target, 'attr__name=\"([^\"]*)\"'), ''), nullIf(extract(target, 'attr__id=\"([^\"]*)\"'), '')) AS attr",
          '    FROM (',
          '      SELECT',
          "        nullIf(toString(properties.$pathname), '') AS path,",
          '        person_id,',
          `        ${POSTHOG_SAMPLE_WEIGHT_SQL} AS sample_weight,`,
          "        nullIf(toString(properties.$device_type), '') AS device,",
          "        splitByChar(';', elements_chain)[1] AS target",
          '      FROM events',
          `      PREWHERE event = '$rageclick' AND ${bounds}`,
          '    )',
          '  )',
          '  GROUP BY path, tag, text, attr',
          ') AS rc',
          'LEFT JOIN (',
          "  SELECT nullIf(toString(properties.$pathname), '') AS path, uniq(person_id) AS page_people",
          '  FROM events',
          `  PREWHERE event = '$pageview' AND ${bounds}`,
          '  GROUP BY path',
          ') AS pv ON rc.path = pv.path',
          'ORDER BY people DESC, clicks DESC, path ASC, tag ASC, text ASC, attr ASC',
          `LIMIT ${limit}`,
        ].join('\n'),
      };
    case 'web-vitals':
      return {
        columns: ['path', 'device', 'os', 'lcp_p75', 'inp_p75', 'cls_p75', 'fcp_p75', 'measurements'],
        text: [
          'SELECT',
          "  nullIf(toString(properties.$pathname), '') AS path,",
          "  nullIf(toString(properties.$device_type), '') AS device,",
          "  nullIf(toString(properties.$os), '') AS os,",
          '  quantileExact(0.75)(toFloat(properties.$web_vitals_LCP_value)) AS lcp_p75,',
          '  quantileExact(0.75)(toFloat(properties.$web_vitals_INP_value)) AS inp_p75,',
          '  quantileExact(0.75)(toFloat(properties.$web_vitals_CLS_value)) AS cls_p75,',
          '  quantileExact(0.75)(toFloat(properties.$web_vitals_FCP_value)) AS fcp_p75,',
          '  count() AS measurements',
          'FROM events',
          `PREWHERE event = '$web_vitals' AND ${bounds}`,
          "WHERE nullIf(toString(properties.$pathname), '') IN (",
          "    SELECT nullIf(toString(properties.$pathname), '') AS top_path",
          '    FROM events',
          `    PREWHERE event = '$web_vitals' AND ${bounds}`,
          '    GROUP BY top_path',
          '    ORDER BY count() DESC, top_path ASC',
          `    LIMIT ${POSTHOG_WEB_VITALS_TOP_PATHS}`,
          '  )',
          'GROUP BY path, device, os',
          'ORDER BY measurements DESC, path ASC, device ASC, os ASC',
          `LIMIT ${limit}`,
        ].join('\n'),
      };
    case 'inp-targets': {
      // The library keeps an allowlist of the attribution's scalar fields under
      // $web_vitals_INP_event.attribution; an event without one has none.
      const attribution = (field: string) => `JSONExtractRaw(properties, '$web_vitals_INP_event', 'attribution', '${field}')`;
      // HogQL's toFloat is null-safe: a missing field is NULL, which quantiles skip.
      const milliseconds = (field: string) => `quantileExact(0.75)(toFloat(${attribution(field)}))`;
      return {
        columns: ['path', 'device', 'os', 'target', 'interaction_type', 'measurements', 'inp_p75',
          'input_delay_p75', 'processing_p75', 'presentation_delay_p75'],
        text: [
          'SELECT',
          "  nullIf(toString(properties.$pathname), '') AS path,",
          "  nullIf(toString(properties.$device_type), '') AS device,",
          "  nullIf(toString(properties.$os), '') AS os,",
          `  nullIf(substring(JSONExtractString(properties, '$web_vitals_INP_event', 'attribution', 'interactionTarget'), 1, ${POSTHOG_INTERACTION_TARGET_MAX}), '') AS target,`,
          "  nullIf(JSONExtractString(properties, '$web_vitals_INP_event', 'attribution', 'interactionType'), '') AS interaction_type,",
          '  count() AS measurements,',
          '  quantileExact(0.75)(toFloat(properties.$web_vitals_INP_value)) AS inp_p75,',
          `  ${milliseconds('inputDelay')} AS input_delay_p75,`,
          `  ${milliseconds('processingDuration')} AS processing_p75,`,
          `  ${milliseconds('presentationDelay')} AS presentation_delay_p75`,
          'FROM events',
          `PREWHERE event = '$web_vitals' AND ${bounds}`,
          'WHERE properties.$web_vitals_INP_value IS NOT NULL',
          "  AND nullIf(toString(properties.$pathname), '') IN (",
          "    SELECT nullIf(toString(properties.$pathname), '') AS top_path",
          '    FROM events',
          `    PREWHERE event = '$web_vitals' AND ${bounds}`,
          '    GROUP BY top_path',
          '    ORDER BY count() DESC, top_path ASC',
          `    LIMIT ${POSTHOG_WEB_VITALS_TOP_PATHS}`,
          '  )',
          'GROUP BY path, device, os, target, interaction_type',
          'ORDER BY measurements DESC, inp_p75 DESC, path ASC, device ASC, os ASC, target ASC, interaction_type ASC',
          `LIMIT ${limit}`,
        ].join('\n'),
      };
    }
    case 'funnels':
      return funnelQuery(window, funnels);
  }
}

/**
 * Every declared funnel in ONE query: per person, `windowFunnel` over the whole
 * window reports the furthest step reached IN ORDER; the outer select counts the
 * people at or past each step. One row comes back, one column per step.
 */
function funnelQuery(window: PosthogWindow, funnels: readonly PosthogFunnel[]): PosthogQuery {
  const days = Math.round(
    (Date.parse(`${window.end}T00:00:00Z`) - Date.parse(`${window.start}T00:00:00Z`)) / 86_400_000,
  ) + 1;
  const seconds = days * 86_400;
  const events = [...new Set(funnels.flatMap((funnel) => funnel.steps.map((step) => step.event)))].sort();
  const columns: string[] = [];
  const counts: string[] = [];
  const levels: string[] = [];
  funnels.forEach((funnel, f) => {
    const conditions = funnel.steps.map((step) =>
      step.path === undefined
        ? `event = ${hogqlString(step.event)}`
        : `event = ${hogqlString(step.event)} AND toString(properties.$pathname) = ${hogqlString(step.path)}`,
    );
    levels.push(`  windowFunnel(${seconds})(toDateTime(timestamp), ${conditions.join(', ')}) AS funnel_${f + 1}`);
    funnel.steps.forEach((_step, s) => {
      const column = `funnel_${f + 1}_step_${s + 1}`;
      columns.push(column);
      counts.push(`  countIf(funnel_${f + 1} >= ${s + 1}) AS ${column}`);
    });
  });
  columns.push('sampled_events');
  counts.push('  sum(sampled_events) AS sampled_events');
  return {
    columns,
    text: [
      'SELECT',
      counts.join(',\n'),
      'FROM (',
      '  SELECT',
      '  person_id,',
      levels.join(',\n') + ',',
      `  countIf(${POSTHOG_SAMPLE_WEIGHT_SQL} > 1) AS sampled_events`,
      '  FROM events',
      `  PREWHERE ${timeBounds(window)}`,
      `    AND event IN (${events.map(hogqlString).join(', ')})`,
      '  GROUP BY person_id',
      ')',
      'LIMIT 1',
    ].join('\n'),
  };
}

