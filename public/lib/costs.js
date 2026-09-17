import { monthStart, PRICING_VERSION } from './domain.js';

const sydneyPeriod = (now) =>
  new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Sydney',
    month: 'long',
    year: 'numeric',
  }).format(new Date(now));

export function monthlyTotals(usage, settings, now = Date.now()) {
  const start = monthStart(now);
  const events = (usage || []).filter((e) => e.at >= start);
  const usd = events.reduce((sum, e) => sum + (Number(e.usd) || 0), 0);
  return {
    usd,
    aud: usd * settings.usdToAud,
    responses: events.length,
    incomplete: events.some((e) => e.incomplete),
  };
}

// Shapes the figures the dashboard and cost page render.
export function usageOverview({
  usage = [],
  lessons = [],
  settings,
  now = Date.now(),
  pending = [],
}) {
  const start = monthStart(now);
  const all = [...usage, ...pending.filter((p) => !usage.some((u) => u.id === p.id))];
  const totals = monthlyTotals(all, settings, now);
  const month = lessons.filter((l) => (l.ended || l.lastSeen || l.started) >= start && l.started);
  const minutes = month.reduce(
    (sum, l) => sum + Math.max(0, ((l.ended || l.lastSeen) - Math.max(l.started, start)) / 60000),
    0,
  );
  const sessions = [...lessons]
    .sort((a, b) => b.started - a.started)
    .slice(0, 30)
    .map((l) => ({
      id: l.id,
      status: l.status,
      model: l.model,
      started: l.started,
      ended: l.ended,
      last_seen: l.lastSeen,
      summary_status: l.summaryStatus,
      usage_incomplete: l.usageIncomplete,
      error: l.error,
      usd: l.usd,
      checkpoints: l.checkpoints,
    }));
  return {
    ...totals,
    minutes,
    lessons: month.length,
    incomplete: totals.incomplete || month.some((l) => l.usageIncomplete),
    sessions,
    settings,
    pricingVersion: PRICING_VERSION,
    period: sydneyPeriod(now),
  };
}
