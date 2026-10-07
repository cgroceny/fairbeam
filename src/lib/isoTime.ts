// Date and time stamps in exported files and tables: ISO 8601 local time with the UTC offset
// ("2026-10-06T23:39:26+03:00"), the form a run's `created` stamp has. Locale-free (no i18n), so the
// Touchstone writer and the CSV tables can use it.

/** A run's `created` stamp ("2026-10-06T23:39:26+0300") as an ISO 8601 local date and time with its
 * offset ("2026-10-06T23:39:26+03:00"); text in another form is returned unchanged, null when there
 * is none. */
export function isoLocalStamp(created: string | null | undefined): string | null {
  const text = String(created ?? "").trim();
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.exec(text);
  if (!m) return text || null;
  const time = m[2].length === 5 ? `${m[2]}:00` : m[2];
  const zone = !m[3] ? "" : m[3] === "Z" ? "Z" : m[3].includes(":") ? m[3] : `${m[3].slice(0, 3)}:${m[3].slice(3)}`;
  return `${m[1]}T${time}${zone}`;
}

/** A moment as an ISO 8601 local date and time with the machine's offset: "2026-10-07T10:22:01+03:00". */
export function isoLocalNow(d: Date = new Date()): string {
  const p = (v: number) => String(Math.abs(Math.trunc(v))).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${off >= 0 ? "+" : "-"}${p(off / 60)}:${p(off % 60)}`;
}
