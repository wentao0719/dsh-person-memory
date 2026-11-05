// Lightweight process metrics. No text, no person ids in events.
let sink = null;
const recent = [];
const totals = new Map();

export function configureMetrics(nextSink) {
  sink = typeof nextSink === 'function' ? nextSink : null;
}

export function recordMetric(name, fields = {}) {
  const event = { ts: Date.now(), name: String(name), ...fields };
  totals.set(event.name, (totals.get(event.name) ?? 0) + 1);
  recent.push(event);
  if (recent.length > 500) recent.splice(0, recent.length - 500);
  if (sink) {
    try { sink(event); } catch {}
  }
  return event;
}

export function metricsSnapshot() {
  return { totals: Object.fromEntries(totals), recent: [...recent] };
}

export function resetMetrics() {
  recent.length = 0;
  totals.clear();
}
