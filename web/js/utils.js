// Pure helper functions. No DOM, no API, no state.

export const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );

export function initials(...sources) {
  const src = sources.find((x) => x && String(x).trim().length > 0);
  if (!src) return '?';
  const trimmed = String(src).trim();
  if (trimmed.includes('@')) return trimmed.slice(0, 2).toUpperCase();
  const cleaned = trimmed.replace(/^\+?\d[\d\s().-]*$/, (m) => m.replace(/\D/g, '').slice(-2));
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return cleaned.slice(0, 2).toUpperCase() || '?';
}

export function avatarClass(seed) {
  const s = String(seed ?? '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return 'g' + ((h % 4) + 1);
}

export function relTime(ms) {
  if (!ms) return '';
  const diff = (Date.now() - ms) / 1000;
  if (diff < 60) return 'now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function fmtBytes(n) {
  if (!n || n < 1024) return n ? `${n} B` : '';
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Format a unix-ms timestamp for the Scheduled view "send at" display. */
export function fmtSendAt(ts) {
  const d = new Date(ts);
  const now = Date.now();
  const diff = ts - now;
  const opts = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  const abs = d.toLocaleString(undefined, opts);
  if (diff < 0) return `${abs} (overdue)`;
  if (diff < 60_000) return `${abs} (in <1 min)`;
  if (diff < 3_600_000) return `${abs} (in ${Math.round(diff / 60_000)} min)`;
  if (diff < 86_400_000) return `${abs} (in ${Math.round(diff / 3_600_000)} hr)`;
  return abs;
}

/** Format a calendar event's start/end for the Calendar view. */
export function fmtCalEventTime(startMs, endMs) {
  if (!startMs) return '(no time)';
  const start = new Date(startMs);
  const end = endMs ? new Date(endMs) : null;
  const opts = { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  let s = start.toLocaleString(undefined, opts);
  if (end) {
    const sameDay = start.toDateString() === end.toDateString();
    const endOpts = sameDay ? { hour: 'numeric', minute: '2-digit' } : opts;
    s += ' – ' + end.toLocaleString(undefined, endOpts);
  }
  return s;
}
