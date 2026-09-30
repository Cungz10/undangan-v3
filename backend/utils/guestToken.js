const crypto = require('crypto');

const TOKEN_RE = /^[a-f0-9]{64}$/i;
const DEV_SECRET = 'undangan-local-development-qr-secret-only';

/**
 * QR tokens are derived, not random:  token = HMAC-SHA256(QR_TOKEN_SECRET, uuid:version).
 * That lets the admin re-copy a guest's link at any time without storing the token itself.
 * The DB still stores only sha256(token), so scans keep working through token_hash.
 *
 * WARNING: changing or losing QR_TOKEN_SECRET invalidates every derived link/QR at once.
 */
function getSecret() {
    const secret = process.env.QR_TOKEN_SECRET || '';
    if (process.env.NODE_ENV === 'production') {
        return secret.length >= 32 ? secret : null;
    }
    return secret || DEV_SECRET;
}

if (process.env.NODE_ENV === 'production' && getSecret() === null) {
    console.error('QR_TOKEN_SECRET (min. 32 chars) is not set: creating/re-issuing guest QR codes is disabled.');
}

function isConfigured() {
    return getSecret() !== null;
}

/**
 * @param {string} uuid guest uuid
 * @param {number} version guest token_version (bumped on every "QR baru")
 * @returns {string} 64 hex chars
 */
function deriveToken(uuid, version) {
    const secret = getSecret();
    if (secret === null) {
        throw new Error('QR_TOKEN_SECRET is not configured');
    }
    return crypto.createHmac('sha256', secret).update(`guest-qr:v1:${uuid}:${version}`).digest('hex');
}

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

module.exports = { TOKEN_RE, isConfigured, deriveToken, hashToken };
