const jwt = require('jsonwebtoken');
const { getDb } = require('../database');

const JWT_SECRET = process.env.JWT_SECRET || 'undangan-local-development-secret-only';
const JWT_EXPIRES_IN = '24h';

if (process.env.NODE_ENV === 'production' && (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)) {
    throw new Error('Production requires a JWT_SECRET of at least 32 characters.');
}

/**
 * Middleware: Authenticate admin via JWT Bearer token.
 */
function authAdmin(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: ['Unauthorized'] });
    }

    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.role && decoded.role !== 'admin') {
            return res.status(403).json({ error: ['Admin access required'] });
        }
        req.user = decoded;
        req.isAdmin = true;
        next();
    } catch {
        return res.status(401).json({ error: ['Token expired or invalid'] });
    }
}

/**
 * Middleware: Authenticate guest via x-access-key header or Bearer token.
 * If Bearer token → admin context.
 * If x-access-key → guest context.
 */
async function authGuestOrAdmin(req, res, next) {
    const authHeader = req.headers['authorization'];
    const accessKey = req.headers['x-access-key'];

    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.split(' ')[1];
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            if (decoded.role === 'checkin_staff') {
                return res.status(403).json({ error: ['Admin access required'] });
            }
            req.user = decoded;
            req.isAdmin = true;
            return next();
        } catch {
            return res.status(401).json({ error: ['Token expired or invalid'] });
        }
    }

    if (accessKey) {
        try {
            const db = getDb();
            const user = await db.prepare('SELECT id, uuid FROM users WHERE access_key = ?').get(accessKey);
            if (!user) {
                return res.status(401).json({ error: ['Invalid access key'] });
            }
            req.user = { id: user.id, uuid: user.uuid };
            req.isAdmin = false;
            return next();
        } catch (err) {
            console.error('Middleware DB Error:', err);
            return res.status(500).json({ error: ['Internal server error'] });
        }
    }

    return res.status(401).json({ error: ['Unauthorized'] });
}

/**
 * Generate JWT token for admin user.
 * @param {object} user
 * @returns {string}
 */
function generateToken(user) {
    return jwt.sign(
        { id: user.id, uuid: user.uuid, email: user.email, role: 'admin' },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES_IN }
    );
}

function authCheckinStaff(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: ['Unauthorized'] });
    }

    try {
        const decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
        if (decoded.role !== 'checkin_staff') {
            return res.status(403).json({ error: ['Check-in staff access required'] });
        }
        req.staff = decoded;
        return next();
    } catch {
        return res.status(401).json({ error: ['Token expired or invalid'] });
    }
}

function generateCheckinToken(username) {
    return jwt.sign(
        { role: 'checkin_staff', username },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES_IN }
    );
}

module.exports = {
    authAdmin,
    authGuestOrAdmin,
    authCheckinStaff,
    generateToken,
    generateCheckinToken,
};
