/** Formats bytes with binary units, localized. */
export function bytes(n: number, locale: string): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Math.abs(n);
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  const digits = u === 0 || v >= 100 ? 0 : 1;
  return `${n < 0 ? '−' : ''}${v.toLocaleString(locale, { maximumFractionDigits: digits, minimumFractionDigits: digits })} ${units[u]}`;
}

/** Formats seconds as m:ss or h:mm:ss. */
export function duration(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return '—';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

/** Formats a percentage with one decimal. */
export function percent(fraction: number, locale: string): string {
  return (fraction * 100).toLocaleString(locale, { maximumFractionDigits: 1 }) + ' %';
}
