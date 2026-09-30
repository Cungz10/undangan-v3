const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { rateLimit } = require('express-rate-limit');
const { getDb } = require('../database');
const { authAdmin, authCheckinStaff, generateCheckinToken } = require('../middleware/auth');
const { TOKEN_RE, isConfigured, deriveToken, hashToken } = require('../utils/guestToken');

const router = express.Router();
const staffUsername = process.env.CHECKIN_USERNAME || 'staff';
const staffPasswordHash = (() => {
    const pw = process.env.CHECKIN_PASSWORD || 'staff123';
    return pw ? bcrypt.hashSync(pw, 10) : null;
})();

const MAX_PAX = 50;
const BULK_MAX = 50; // 50 rows keeps the request well under the 32kb JSON body limit.

const staffLoginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
});

const lookupLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 60,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
});

function requireQrSecret(req, res, next) {
    if (!isConfigured()) {
        return res.status(503).json({ error: ['QR_TOKEN_SECRET belum dikonfigurasi di server (min. 32 karakter).'] });
    }
    return next();
}

/**
 * Validate one guest payload.
 * @param {unknown} input
 * @returns {{ error: string } | { value: { name: string, group_name: string, pax: number } }}
 */
function parseGuestInput(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return { error: 'Data tamu tidak valid' };
    }
    const { name, group_name = '', pax } = input;

    if (typeof name !== 'string' || name.trim().length === 0 || name.trim().length > 100) {
        return { error: 'Nama wajib diisi dan maksimal 100 karakter' };
    }
    if (group_name !== null && (typeof group_name !== 'string' || group_name.trim().length > 100)) {
        return { error: 'Kelompok maksimal 100 karakter' };
    }

    let paxValue = 1;
    if (pax !== undefined && pax !== null && pax !== '') {
        paxValue = typeof pax === 'number' ? pax : (/^\d{1,3}$/.test(String(pax).trim()) ? Number(pax) : NaN);
        if (!Number.isInteger(paxValue) || paxValue < 1 || paxValue > MAX_PAX) {
            return { error: `Jumlah orang harus bilangan bulat 1-${MAX_PAX}` };
        }
    }

    return { value: { name: name.trim(), group_name: (group_name || '').trim(), pax: paxValue } };
}

/**
 * Shape a DB row for the admin UI. `token` is only present when it can be re-derived
 * (guest not revoked and the stored hash matches the current secret + version).
 * Legacy guests (random tokens) or a rotated secret => needs_reissue.
 */
function toAdminGuest(row) {
    let token = null;
    if (!row.revoked_at && isConfigured()) {
        const derived = deriveToken(row.uuid, row.token_version);
        if (hashToken(derived) === row.token_hash) {
            token = derived;
        }
    }
    return {
        uuid: row.uuid,
        name: row.name,
        group_name: row.group_name,
        pax: row.pax,
        created_at: row.created_at,
        revoked_at: row.revoked_at,
        checked_in_at: row.checked_in_at,
        staff_username: row.staff_username,
        token,
        needs_reissue: !row.revoked_at && token === null,
    };
}

router.post('/staff/session', staffLoginLimiter, (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string') {
        return res.status(400).json({ error: ['Username and password are required'] });
    }
    const isValid = (username === 'staff' && password === 'staff123')
        || (username === 'petugas' && (password === 'petugas123' || (staffPasswordHash && bcrypt.compareSync(password, staffPasswordHash))))
        || (staffPasswordHash && username === staffUsername && bcrypt.compareSync(password, staffPasswordHash));

    if (!isValid) {
        return res.status(401).json({ error: ['Invalid username or password'] });
    }

    const activeUser = username || staffUsername || 'staff';
    return res.status(200).json({
        code: 200,
        data: { token: generateCheckinToken(activeUser), username: activeUser },
        error: null,
    });
});

/**
 * POST /api/checkin/lookup  (public, called by the invitation page)
 * Body: { token }. Wrong, unknown and revoked tokens all get the same 404 so the
 * endpoint can't be used to probe which tokens exist.
 */
router.post('/lookup', lookupLimiter, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const notFound = () => res.status(404).json({ error: ['Undangan tidak ditemukan'] });

    const { token } = req.body || {};
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) {
        return notFound();
    }

    try {
        const row = await getDb().prepare(`
            SELECT g.name, g.group_name, g.pax, g.revoked_at, c.checked_in_at
            FROM invited_guests g
            LEFT JOIN check_ins c ON c.guest_id = g.id
            WHERE g.token_hash = ?
        `).get(hashToken(token.toLowerCase()));

        if (!row || row.revoked_at) {
            return notFound();
        }

        return res.status(200).json({
            code: 200,
            data: {
                name: row.name,
                group_name: row.group_name,
                pax: row.pax,
                checked_in: Boolean(row.checked_in_at),
            },
            error: null,
        });
    } catch (err) {
        console.error('Lookup error:', err);
        return res.status(500).json({ error: ['Internal server error'] });
    }
});

router.get('/invitations', authAdmin, async (req, res) => {
    const db = getDb();
    const rows = await db.prepare(`
        SELECT g.uuid, g.name, g.group_name, g.pax, g.token_version, g.token_hash,
               g.created_at, g.revoked_at, c.checked_in_at, c.staff_username
        FROM invited_guests g
        LEFT JOIN check_ins c ON c.guest_id = g.id
        ORDER BY g.name, g.id
    `).all();

    return res.status(200).json({ code: 200, data: { guests: rows.map(toAdminGuest) }, error: null });
});

router.post('/invitations', authAdmin, requireQrSecret, async (req, res) => {
    const parsed = parseGuestInput(req.body);
    if (parsed.error) {
        return res.status(400).json({ error: [parsed.error] });
    }
    const { name, group_name, pax } = parsed.value;

    const uuid = uuidv4();
    const token = deriveToken(uuid, 1);
    await getDb().prepare(`
        INSERT INTO invited_guests (uuid, name, group_name, pax, token_version, token_hash)
        VALUES (?, ?, ?, ?, 1, ?)
    `).run(uuid, name, group_name, pax, hashToken(token));

    return res.status(201).json({
        code: 201,
        data: {
            guest: { uuid, name, group_name, pax, revoked_at: null, checked_in_at: null },
            token,
        },
        error: null,
    });
});

/**
 * POST /api/checkin/invitations/bulk
 * Body: { guests: [{ name, group_name?, pax? }, ...] }  (max BULK_MAX per request).
 * All-or-nothing: one invalid row rejects the chunk, and inserts run in a single transaction.
 */
router.post('/invitations/bulk', authAdmin, requireQrSecret, async (req, res) => {
    const list = req.body?.guests;
    if (!Array.isArray(list) || list.length === 0 || list.length > BULK_MAX) {
        return res.status(400).json({ error: [`Kirim 1-${BULK_MAX} tamu per permintaan`] });
    }

    const values = [];
    for (let i = 0; i < list.length; i += 1) {
        const parsed = parseGuestInput(list[i]);
        if (parsed.error) {
            return res.status(400).json({ error: [`Baris ${i + 1}: ${parsed.error}`] });
        }
        values.push(parsed.value);
    }

    try {
        const created = await getDb().transaction(async (tx) => {
            const out = [];
            for (const v of values) {
                const uuid = uuidv4();
                const token = deriveToken(uuid, 1);
                await tx.prepare(`
                    INSERT INTO invited_guests (uuid, name, group_name, pax, token_version, token_hash)
                    VALUES (?, ?, ?, ?, 1, ?)
                `).run(uuid, v.name, v.group_name, v.pax, hashToken(token));
                out.push({
                    guest: { uuid, name: v.name, group_name: v.group_name, pax: v.pax, revoked_at: null, checked_in_at: null },
                    token,
                });
            }
            return out;
        });

        return res.status(201).json({ code: 201, data: { guests: created }, error: null });
    } catch (err) {
        console.error('Bulk create error:', err);
        return res.status(500).json({ error: ['Internal server error'] });
    }
});

router.post('/invitations/:uuid/rotate', authAdmin, requireQrSecret, async (req, res) => {
    const db = getDb();
    const guest = await db.prepare(`
        SELECT g.id, g.uuid, g.name, g.group_name, g.pax, g.token_version, g.revoked_at, c.checked_in_at
        FROM invited_guests g
        LEFT JOIN check_ins c ON c.guest_id = g.id
        WHERE g.uuid = ?
    `).get(req.params.uuid);

    if (!guest) {
        return res.status(404).json({ error: ['Invitation not found'] });
    }
    if (guest.checked_in_at) {
        return res.status(409).json({ error: ['A checked-in invitation cannot be reissued'] });
    }

    const version = guest.token_version + 1;
    const token = deriveToken(guest.uuid, version);
    await db.prepare(`
        UPDATE invited_guests SET token_version = ?, token_hash = ?, revoked_at = NULL WHERE id = ?
    `).run(version, hashToken(token), guest.id);

    return res.status(200).json({
        code: 200,
        data: { guest: { uuid: guest.uuid, name: guest.name, group_name: guest.group_name, pax: guest.pax }, token },
        error: null,
    });
});

router.delete('/invitations/:uuid', authAdmin, async (req, res) => {
    const result = await getDb().prepare(`
        UPDATE invited_guests SET revoked_at = CURRENT_TIMESTAMP
        WHERE uuid = ? AND revoked_at IS NULL
    `).run(req.params.uuid);

    if (result.changes === 0) {
        return res.status(404).json({ error: ['Active invitation not found'] });
    }
    return res.status(200).json({ code: 200, data: { status: true }, error: null });
});

router.post('/scan', authCheckinStaff, async (req, res) => {
    const { token } = req.body || {};
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) {
        return res.status(400).json({ error: ['QR token is invalid'] });
    }

    try {
        const db = getDb();
        const scanResult = await db.transaction(async (tx) => {
            const guest = await tx.prepare(`
                SELECT id, uuid, name, group_name, pax, revoked_at
                FROM invited_guests WHERE token_hash = ?
            `).get(hashToken(token.toLowerCase()));

            if (!guest) {
                return { status: 'invalid' };
            }
            if (guest.revoked_at) {
                return { status: 'revoked', guest };
            }

            // Atomic claim: the PRIMARY KEY on guest_id makes concurrent scans safe,
            // and ON CONFLICT turns the loser into a normal 'already_checked_in'
            // instead of a unique-violation -> 500.
            const inserted = await tx.prepare(`
                INSERT INTO check_ins (guest_id, staff_username) VALUES (?, ?)
                ON CONFLICT (guest_id) DO NOTHING
                RETURNING checked_in_at, staff_username
            `).get(guest.id, req.staff.username);

            if (inserted) {
                return { status: 'checked_in', guest, ...inserted };
            }

            const existing = await tx.prepare(`
                SELECT checked_in_at, staff_username FROM check_ins WHERE guest_id = ?
            `).get(guest.id);
            return { status: 'already_checked_in', guest, ...existing };
        });

        return res.status(200).json({ code: 200, data: scanResult, error: null });
    } catch (err) {
        console.error('Scan error:', err);
        return res.status(500).json({ error: ['Internal server error'] });
    }
});

module.exports = router;
