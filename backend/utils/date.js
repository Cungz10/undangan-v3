/**
 * Parse a DB timestamp into a Date.
 * `pg` returns TIMESTAMP/TIMESTAMPTZ columns as Date objects, but older code
 * paths (and SQLite-style strings) may still hand us 'YYYY-MM-DD HH:MM:SS'
 * in UTC. Accept both.
 * @param {Date|string|null|undefined} value
 * @returns {Date|null}
 */
function toDate(value) {
    if (value === null || value === undefined || value === '') return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

    const s = String(value).trim().replace(' ', 'T');
    const hasZone = /(Z|[+-]\d{2}:?\d{2})$/i.test(s);
    const d = new Date(hasZone ? s : `${s}Z`);
    return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Format a DB timestamp as a localized string, e.g. "28 Sep 2026 10:54".
 * @param {Date|string|null|undefined} value
 * @param {string} [timeZone]
 * @returns {string}
 */
function formatCommentDate(value, timeZone = 'Asia/Jakarta') {
    const d = toDate(value);
    if (!d) return '';

    const options = {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    };

    let formatted;
    try {
        formatted = new Intl.DateTimeFormat('id-ID', { ...options, timeZone: timeZone || 'Asia/Jakarta' }).format(d);
    } catch {
        // Invalid IANA zone stored in users.tz -> fall back instead of leaking raw value.
        formatted = new Intl.DateTimeFormat('id-ID', { ...options, timeZone: 'Asia/Jakarta' }).format(d);
    }
    return formatted.replace(/\./g, ':');
}

module.exports = { toDate, formatCommentDate };
