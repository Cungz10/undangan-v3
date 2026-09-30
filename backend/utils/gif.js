const ALLOWED_HOSTS = new Set(['tenor.com', 'media.tenor.com', 'media1.tenor.com', 'c.tenor.com']);
const GIF_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * @param {string} value
 * @returns {boolean}
 */
function isAllowedGifUrl(value) {
    try {
        const u = new URL(value);
        return u.protocol === 'https:' && !u.username && !u.password && ALLOWED_HOSTS.has(u.hostname);
    } catch {
        return false;
    }
}

/**
 * A gif_id is either a Tenor id or an https URL on a Tenor host. Nothing else.
 * @param {unknown} value
 * @returns {boolean}
 */
function isValidGifInput(value) {
    if (typeof value !== 'string') return false;
    return GIF_ID_RE.test(value) || isAllowedGifUrl(value);
}

/**
 * Resolve a validated gif_id to a Tenor media URL.
 * Returns null when it cannot be resolved; NEVER echoes the raw input back.
 * @param {string|null|undefined} gifId
 * @param {string|null|undefined} tenorKey
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<string|null>}
 */
async function resolveGifUrl(gifId, tenorKey, fetchImpl = fetch) {
    if (!gifId) return null;
    if (isAllowedGifUrl(gifId)) return gifId;
    if (!GIF_ID_RE.test(gifId) || !tenorKey) return null;

    try {
        const url = `https://tenor.googleapis.com/v2/posts?ids=${encodeURIComponent(gifId)}&key=${encodeURIComponent(tenorKey)}&media_filter=tinygif`;
        const resp = await fetchImpl(url);
        if (!resp.ok) return null;
        const json = await resp.json();
        const tinyUrl = json?.results?.[0]?.media_formats?.tinygif?.url;
        return tinyUrl && isAllowedGifUrl(tinyUrl) ? tinyUrl : null;
    } catch (err) {
        console.warn('Tenor resolve failed:', err.message);
        return null;
    }
}

module.exports = { isValidGifInput, isAllowedGifUrl, resolveGifUrl };
