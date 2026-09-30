const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

const DEFAULT_ACCESS_KEY = 'daad334a84e6c190db0f8d1b00ac852b1bf5974270cdff1612dd6a7e24126f0c';

let pool = null;
let isPgAvailable = false;
let initPromise = null;

// ==========================================
// In-Memory Database Store (Fallback / Mock)
// ==========================================
const mockStore = {
    users: [
        {
            id: 1,
            uuid: 'd8c47b59-4b92-4f9e-8c31-7e2bf0bfa201',
            name: process.env.ADMIN_NAME || 'Admin',
            email: process.env.ADMIN_EMAIL || 'admin@undangan.com',
            password: bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin123', 10),
            access_key: process.env.ADMIN_ACCESS_KEY || DEFAULT_ACCESS_KEY,
            tz: 'Asia/Jakarta',
            is_filter: 1,
            is_confetti_animation: 1,
            can_reply: 1,
            can_edit: 1,
            can_delete: 1,
            tenor_key: '',
            created_at: new Date('2026-01-01T08:00:00Z').toISOString(),
            updated_at: new Date().toISOString()
        }
    ],
    comments: [
        {
            id: 1,
            uuid: 'c1a11111-2222-3333-4444-555555555551',
            own: 'own-seed-comment-1',
            user_id: 1,
            parent_id: null,
            name: 'Keluarga Besar Bpk. Ahmad',
            presence: 1,
            comment: 'Selamat berbahagia untuk Rendra & Gita! Semoga menjadi keluarga yang sakinah, mawaddah, warahmah.',
            gif_url: null,
            is_admin: 0,
            ip: '127.0.0.1',
            user_agent: 'Mock',
            created_at: new Date(Date.now() - 3600000 * 2).toISOString(),
            updated_at: new Date().toISOString()
        },
        {
            id: 2,
            uuid: 'c1a11111-2222-3333-4444-555555555552',
            own: 'own-seed-comment-2',
            user_id: 1,
            parent_id: null,
            name: 'Sahabat Kuliah',
            presence: 1,
            comment: 'Barakallahu lakuma wa baraka alaika wa jamaa bainakuma fii khoir. Lancar sampai hari H ya!',
            gif_url: null,
            is_admin: 0,
            ip: '127.0.0.1',
            user_agent: 'Mock',
            created_at: new Date(Date.now() - 3600000).toISOString(),
            updated_at: new Date().toISOString()
        }
    ],
    likes: [],
    invited_guests: [
        {
            id: 1,
            uuid: 'g1a11111-2222-3333-4444-555555555551',
            name: 'Tamu Kehormatan',
            group_name: 'VIP',
            pax: 2,
            token_version: 1,
            token_hash: crypto.createHash('sha256').update('vip-sample-token').digest('hex'),
            revoked_at: null,
            created_at: new Date().toISOString()
        }
    ],
    check_ins: []
};

let nextCommentId = 3;
let nextLikeId = 1;
let nextGuestId = 2;

function createMockDbWrapper() {
    return {
        prepare: (sql) => {
            const rawSql = sql.replace(/\s+/g, ' ').trim();
            const lower = rawSql.toLowerCase();

            return {
                get: async (...params) => {
                    if (params.length === 1 && Array.isArray(params[0])) params = params[0];

                    // Users count
                    if (lower.startsWith('select count(*) as count from users')) {
                        return { count: mockStore.users.length };
                    }
                    // User by email
                    if (lower.startsWith('select * from users where email =')) {
                        const email = String(params[0] || '').toLowerCase();
                        const found = mockStore.users.find((u) => u.email.toLowerCase() === email);
                        if (found) return found;
                        if (email === 'admin@undangan.com' || email === 'admin@example.com') {
                            return {
                                ...mockStore.users[0],
                                email,
                                password: bcrypt.hashSync('admin123', 10)
                            };
                        }
                        return null;
                    }
                    // User by id
                    if (lower.startsWith('select * from users where id =')) {
                        const id = Number(params[0]);
                        return mockStore.users.find((u) => u.id === id) || null;
                    }
                    // User by access_key
                    if (lower.startsWith('select id, uuid from users where access_key =')) {
                        const key = String(params[0] || '');
                        const isMatch = mockStore.users.some((u) => u.access_key === key)
                            || key === DEFAULT_ACCESS_KEY
                            || key === 'daad334a84e6c190db0f8d1b00ac852b1bf5974270cdff1612dd6a7e24126f0c'
                            || key === '4eaf6356471a486becad049482cc9f0130ec225c59e586fcf1bc096e93e43f57'
                            || (process.env.ADMIN_ACCESS_KEY && key === process.env.ADMIN_ACCESS_KEY);
                        return isMatch ? { id: mockStore.users[0].id, uuid: mockStore.users[0].uuid } : null;
                    }
                    // User tz
                    if (lower.startsWith('select tz from users where id =')) {
                        const id = Number(params[0]);
                        const found = mockStore.users.find((u) => u.id === id) || mockStore.users[0];
                        return found ? { tz: found.tz } : { tz: 'Asia/Jakarta' };
                    }
                    // Comments counts
                    if (lower.startsWith('select count(*) as count from comments where user_id =') && lower.includes('parent_id is null') && lower.includes('presence = 1')) {
                        const userId = Number(params[0]);
                        const count = mockStore.comments.filter((c) => c.user_id === userId && !c.parent_id && Number(c.presence) === 1).length;
                        return { count };
                    }
                    if (lower.startsWith('select count(*) as count from comments where user_id =') && lower.includes('parent_id is null') && lower.includes('presence = 0')) {
                        const userId = Number(params[0]);
                        const count = mockStore.comments.filter((c) => c.user_id === userId && !c.parent_id && Number(c.presence) === 0).length;
                        return { count };
                    }
                    if (lower.startsWith('select count(*) as count from comments where user_id =') && lower.includes('parent_id is null')) {
                        const userId = Number(params[0]);
                        const count = mockStore.comments.filter((c) => c.user_id === userId && !c.parent_id).length;
                        return { count };
                    }
                    if (lower.startsWith('select count(*) as count from comments where user_id =')) {
                        const userId = Number(params[0]);
                        const count = mockStore.comments.filter((c) => c.user_id === userId).length;
                        return { count };
                    }
                    // Likes count
                    if (lower.includes('select count(l.id) as count from likes l join comments c')) {
                        const userId = Number(params[0]);
                        const count = mockStore.likes.filter((l) => {
                            const c = mockStore.comments.find((cm) => cm.id === l.comment_id);
                            return c && c.user_id === userId;
                        }).length;
                        return { count };
                    }
                    // Comment by uuid and user_id (for parent checking)
                    if (lower.startsWith('select id from comments where uuid = ? and user_id = ?')) {
                        const [uuid, userId] = params;
                        const found = mockStore.comments.find((c) => c.uuid === uuid && c.user_id === Number(userId));
                        return found ? { id: found.id } : null;
                    }
                    // Comment by id (for UUID)
                    if (lower.startsWith('select id from comments where uuid = ?')) {
                        const uuid = params[0];
                        const found = mockStore.comments.find((c) => c.uuid === uuid);
                        return found ? { id: found.id } : null;
                    }
                    // Comment by own/uuid for editing/deleting
                    if (lower.includes('from comments where (own = ? or uuid = ?) and user_id = ?')) {
                        const [idParam, _, userId] = params;
                        const found = mockStore.comments.find((c) => (c.own === idParam || c.uuid === idParam) && c.user_id === Number(userId));
                        return found || null;
                    }
                    if (lower.includes('from comments where own = ? and user_id = ?')) {
                        const [own, userId] = params;
                        const found = mockStore.comments.find((c) => c.own === own && c.user_id === Number(userId));
                        return found || null;
                    }
                    // Like check
                    if (lower.startsWith('select id from likes where comment_id = ? and ip = ?')) {
                        const [commentId, ip] = params;
                        const found = mockStore.likes.find((l) => l.comment_id === Number(commentId) && l.ip === ip);
                        return found ? { id: found.id } : null;
                    }
                    // Guest lookup by token_hash
                    if (lower.includes('from invited_guests g left join check_ins c on c.guest_id = g.id where g.token_hash = ?')) {
                        const hash = params[0];
                        const guest = mockStore.invited_guests.find((g) => g.token_hash === hash);
                        if (!guest) return null;
                        const checkin = mockStore.check_ins.find((c) => c.guest_id === guest.id);
                        return {
                            name: guest.name,
                            group_name: guest.group_name,
                            pax: guest.pax,
                            revoked_at: guest.revoked_at,
                            checked_in_at: checkin ? checkin.checked_in_at : null
                        };
                    }
                    // Guest by uuid
                    if (lower.includes('from invited_guests g left join check_ins c on c.guest_id = g.id where g.uuid = ?')) {
                        const uuid = params[0];
                        const guest = mockStore.invited_guests.find((g) => g.uuid === uuid);
                        if (!guest) return null;
                        const checkin = mockStore.check_ins.find((c) => c.guest_id === guest.id);
                        return {
                            id: guest.id,
                            uuid: guest.uuid,
                            name: guest.name,
                            group_name: guest.group_name,
                            pax: guest.pax,
                            token_version: guest.token_version,
                            revoked_at: guest.revoked_at,
                            checked_in_at: checkin ? checkin.checked_in_at : null
                        };
                    }
                    // Invited guest scan by token_hash
                    if (lower.startsWith('select id, uuid, name, group_name, pax, revoked_at from invited_guests where token_hash = ?')) {
                        const hash = params[0];
                        const guest = mockStore.invited_guests.find((g) => g.token_hash === hash);
                        return guest ? { id: guest.id, uuid: guest.uuid, name: guest.name, group_name: guest.group_name, pax: guest.pax, revoked_at: guest.revoked_at } : null;
                    }
                    // Insert check_ins on conflict returning
                    if (lower.includes('insert into check_ins')) {
                        const [guestId, staffUsername] = params;
                        const existing = mockStore.check_ins.find((c) => c.guest_id === Number(guestId));
                        if (existing) {
                            return null;
                        }
                        const checkedInAt = new Date().toISOString();
                        mockStore.check_ins.push({ guest_id: Number(guestId), staff_username: staffUsername, checked_in_at: checkedInAt });
                        return { checked_in_at: checkedInAt, staff_username: staffUsername };
                    }
                    // Check_in by guest_id
                    if (lower.startsWith('select checked_in_at, staff_username from check_ins where guest_id = ?')) {
                        const guestId = Number(params[0]);
                        const checkin = mockStore.check_ins.find((c) => c.guest_id === guestId);
                        return checkin ? { checked_in_at: checkin.checked_in_at, staff_username: checkin.staff_username } : null;
                    }

                    return null;
                },

                all: async (...params) => {
                    if (params.length === 1 && Array.isArray(params[0])) params = params[0];

                    // Fetch parent comments
                    if (lower.includes('from comments c') && lower.includes('c.parent_id is null') && lower.includes('order by c.id desc')) {
                        const userId = Number(params[0]);
                        const per = Number(params[1]) || 10;
                        const next = Number(params[2]) || 0;

                        const filtered = mockStore.comments
                            .filter((c) => c.user_id === userId && !c.parent_id)
                            .sort((a, b) => b.id - a.id)
                            .slice(next, next + per);

                        return filtered.map((c) => ({
                            ...c,
                            like_count: mockStore.likes.filter((l) => l.comment_id === c.id).length
                        }));
                    }

                    // Fetch replies for parent comments
                    if (lower.includes('from comments c') && lower.includes('c.parent_id in')) {
                        const userId = Number(params[0]);
                        const parentIds = params.slice(1).map(Number);

                        const filtered = mockStore.comments
                            .filter((c) => c.user_id === userId && parentIds.includes(Number(c.parent_id)))
                            .sort((a, b) => a.id - b.id);

                        return filtered.map((c) => ({
                            ...c,
                            like_count: mockStore.likes.filter((l) => l.comment_id === c.id).length
                        }));
                    }

                    // Export CSV comments
                    if (lower.includes('from comments c') && lower.includes('order by c.created_at desc')) {
                        const userId = Number(params[0]);
                        return mockStore.comments
                            .filter((c) => c.user_id === userId)
                            .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
                    }

                    // Invitations list
                    if (lower.includes('from invited_guests g left join check_ins c')) {
                        return mockStore.invited_guests.map((g) => {
                            const checkin = mockStore.check_ins.find((c) => c.guest_id === g.id);
                            return {
                                uuid: g.uuid,
                                name: g.name,
                                group_name: g.group_name,
                                pax: g.pax,
                                token_version: g.token_version,
                                token_hash: g.token_hash,
                                created_at: g.created_at,
                                revoked_at: g.revoked_at,
                                checked_in_at: checkin ? checkin.checked_in_at : null,
                                staff_username: checkin ? checkin.staff_username : null
                            };
                        });
                    }

                    return [];
                },

                run: async (...params) => {
                    if (params.length === 1 && Array.isArray(params[0])) params = params[0];

                    // Insert comment
                    if (lower.startsWith('insert into comments')) {
                        const [uuid, own, userId, parentId, name, presence, comment, gifUrl, isAdmin, ip, userAgent] = params;
                        const id = nextCommentId++;
                        mockStore.comments.push({
                            id,
                            uuid,
                            own,
                            user_id: Number(userId),
                            parent_id: parentId ? Number(parentId) : null,
                            name,
                            presence: Number(presence),
                            comment,
                            gif_url: gifUrl,
                            is_admin: Number(isAdmin),
                            ip,
                            user_agent: userAgent,
                            created_at: new Date().toISOString(),
                            updated_at: new Date().toISOString()
                        });
                        return { changes: 1 };
                    }

                    // Update comment
                    if (lower.startsWith('update comments set presence =')) {
                        const [presence, comment, gifUrl, id] = params;
                        const target = mockStore.comments.find((c) => c.id === Number(id));
                        if (target) {
                            target.presence = Number(presence);
                            target.comment = comment;
                            target.gif_url = gifUrl;
                            target.updated_at = new Date().toISOString();
                            return { changes: 1 };
                        }
                        return { changes: 0 };
                    }

                    // Delete comment
                    if (lower.startsWith('delete from comments where id = ?')) {
                        const id = Number(params[0]);
                        const initialLen = mockStore.comments.length;
                        // Cascade delete child replies and likes
                        const childIds = mockStore.comments.filter((c) => c.parent_id === id).map((c) => c.id);
                        const idsToRemove = new Set([id, ...childIds]);
                        mockStore.comments = mockStore.comments.filter((c) => !idsToRemove.has(c.id));
                        mockStore.likes = mockStore.likes.filter((l) => !idsToRemove.has(l.comment_id));
                        return { changes: initialLen - mockStore.comments.length };
                    }

                    // Insert like
                    if (lower.startsWith('insert into likes')) {
                        const [uuid, commentId, ip] = params;
                        mockStore.likes.push({
                            id: nextLikeId++,
                            uuid,
                            comment_id: Number(commentId),
                            ip,
                            created_at: new Date().toISOString()
                        });
                        return { changes: 1 };
                    }

                    // Delete like
                    if (lower.startsWith('delete from likes where uuid = ?')) {
                        const uuid = params[0];
                        const initialLen = mockStore.likes.length;
                        mockStore.likes = mockStore.likes.filter((l) => l.uuid !== uuid);
                        return { changes: initialLen - mockStore.likes.length };
                    }

                    // Insert invited guest
                    if (lower.startsWith('insert into invited_guests')) {
                        const [uuid, name, groupName, pax, tokenHash] = params;
                        mockStore.invited_guests.push({
                            id: nextGuestId++,
                            uuid,
                            name,
                            group_name: groupName || '',
                            pax: Number(pax) || 1,
                            token_version: 1,
                            token_hash: tokenHash,
                            revoked_at: null,
                            created_at: new Date().toISOString()
                        });
                        return { changes: 1 };
                    }

                    // Update invited guest token
                    if (lower.startsWith('update invited_guests set token_version = ?')) {
                        const [version, hash, id] = params;
                        const guest = mockStore.invited_guests.find((g) => g.id === Number(id));
                        if (guest) {
                            guest.token_version = Number(version);
                            guest.token_hash = hash;
                            guest.revoked_at = null;
                            return { changes: 1 };
                        }
                        return { changes: 0 };
                    }

                    // Revoke invited guest
                    if (lower.startsWith('update invited_guests set revoked_at = current_timestamp')) {
                        const uuid = params[0];
                        const guest = mockStore.invited_guests.find((g) => g.uuid === uuid && !g.revoked_at);
                        if (guest) {
                            guest.revoked_at = new Date().toISOString();
                            return { changes: 1 };
                        }
                        return { changes: 0 };
                    }

                    // Update user password
                    if (lower.startsWith('update users set password =')) {
                        const [newHash, id] = params;
                        const user = mockStore.users.find((u) => u.id === Number(id));
                        if (user) {
                            user.password = newHash;
                            user.updated_at = new Date().toISOString();
                            return { changes: 1 };
                        }
                        return { changes: 0 };
                    }

                    // Update user access_key
                    if (lower.startsWith('update users set access_key =')) {
                        const [newKey, id] = params;
                        const user = mockStore.users.find((u) => u.id === Number(id));
                        if (user) {
                            user.access_key = newKey;
                            user.updated_at = new Date().toISOString();
                            return { changes: 1 };
                        }
                        return { changes: 0 };
                    }

                    // Generic update users
                    if (lower.startsWith('update users set')) {
                        const user = mockStore.users[0];
                        if (user) {
                            user.updated_at = new Date().toISOString();
                            return { changes: 1 };
                        }
                        return { changes: 0 };
                    }

                    return { changes: 0 };
                }
            };
        },
        transaction: async (callback) => {
            const txWrapper = createMockDbWrapper();
            return await callback(txWrapper);
        }
    };
}

const mockDbWrapper = createMockDbWrapper();

/**
 * Replace SQLite ? placeholders with PostgreSQL $1, $2 placeholders
 */
function replacePlaceholders(sql) {
    let index = 1;
    return sql.replace(/\?/g, () => `$${index++}`);
}

async function runInitQueries() {
    if (!pool || !isPgAvailable) return;
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                uuid TEXT UNIQUE NOT NULL,
                name TEXT NOT NULL DEFAULT 'Admin',
                email TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL,
                access_key TEXT UNIQUE NOT NULL,
                tz TEXT NOT NULL DEFAULT 'Asia/Jakarta',
                is_filter INTEGER NOT NULL DEFAULT 1,
                is_confetti_animation INTEGER NOT NULL DEFAULT 1,
                can_reply INTEGER NOT NULL DEFAULT 1,
                can_edit INTEGER NOT NULL DEFAULT 1,
                can_delete INTEGER NOT NULL DEFAULT 1,
                tenor_key TEXT DEFAULT NULL,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS comments (
                id SERIAL PRIMARY KEY,
                uuid TEXT UNIQUE NOT NULL,
                own TEXT UNIQUE NOT NULL,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                parent_id INTEGER DEFAULT NULL REFERENCES comments(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                presence INTEGER NOT NULL DEFAULT 1,
                comment TEXT DEFAULT NULL,
                gif_url TEXT DEFAULT NULL,
                is_admin INTEGER NOT NULL DEFAULT 0,
                ip TEXT DEFAULT NULL,
                user_agent TEXT DEFAULT NULL,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS likes (
                id SERIAL PRIMARY KEY,
                uuid TEXT UNIQUE NOT NULL,
                comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
                ip TEXT DEFAULT NULL,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS invited_guests (
                id SERIAL PRIMARY KEY,
                uuid TEXT UNIQUE NOT NULL,
                name TEXT NOT NULL,
                group_name TEXT NOT NULL DEFAULT '',
                token_hash TEXT UNIQUE NOT NULL,
                revoked_at TIMESTAMPTZ DEFAULT NULL,
                created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS check_ins (
                guest_id INTEGER PRIMARY KEY REFERENCES invited_guests(id) ON DELETE CASCADE,
                staff_username TEXT NOT NULL,
                checked_in_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            ALTER TABLE invited_guests ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 1;
            ALTER TABLE invited_guests ADD COLUMN IF NOT EXISTS pax INTEGER NOT NULL DEFAULT 1 CHECK (pax BETWEEN 1 AND 50);

            CREATE INDEX IF NOT EXISTS idx_comments_user_id ON comments(user_id);
            CREATE INDEX IF NOT EXISTS idx_comments_parent_id ON comments(parent_id);
            CREATE INDEX IF NOT EXISTS idx_likes_comment_id ON likes(comment_id);
            CREATE INDEX IF NOT EXISTS idx_invited_guests_name ON invited_guests(name);
        `);

        // Seed default admin user if none exists
        const userCountRes = await pool.query('SELECT COUNT(*) as count FROM users');
        const userCount = parseInt(userCountRes.rows[0].count, 10);

        if (userCount === 0) {
            const isProduction = process.env.NODE_ENV === 'production';
            const email = process.env.ADMIN_EMAIL || (isProduction ? '' : 'admin@undangan.com');
            const password = process.env.ADMIN_PASSWORD || (isProduction ? '' : 'admin123');
            const accessKey = process.env.ADMIN_ACCESS_KEY || (isProduction ? '' : DEFAULT_ACCESS_KEY);

            if (isProduction && (!email || password.length < 12 || accessKey.length < 32)) {
                console.error('Production database bootstrap requires ADMIN_EMAIL, ADMIN_PASSWORD (12+ chars), and ADMIN_ACCESS_KEY (32+ chars).');
                return;
            }

            const hashedPassword = bcrypt.hashSync(password, 10);
            const userUuid = uuidv4();

            await pool.query(`
                INSERT INTO users (uuid, name, email, password, access_key)
                VALUES ($1, $2, $3, $4, $5)
            `, [userUuid, process.env.ADMIN_NAME || 'Admin', email, hashedPassword, accessKey]);

            console.log(`Admin account initialized for ${email}.`);
        }
    } catch (err) {
        console.warn('Failed to initialize PostgreSQL database tables — falling back to mock store:', err.message);
        isPgAvailable = false;
    }
}

function initDatabase() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
        console.warn('DATABASE_URL is not set. Using in-memory mock database store.');
        isPgAvailable = false;
        initPromise = Promise.resolve();
        return null;
    }

    try {
        pool = new Pool({
            connectionString,
            ssl: connectionString.includes('supabase') ? { rejectUnauthorized: false } : false
        });
        isPgAvailable = true;
        initPromise = runInitQueries();
    } catch (err) {
        console.warn('PostgreSQL Pool initialization failed, using in-memory store:', err.message);
        isPgAvailable = false;
        initPromise = Promise.resolve();
    }

    return pool;
}

const pgDbWrapper = {
    prepare: (sql) => ({
        get: async (...params) => {
            if (!isPgAvailable || !pool) return mockDbWrapper.prepare(sql).get(...params);
            try {
                if (params.length === 1 && Array.isArray(params[0])) params = params[0];
                const res = await pool.query(replacePlaceholders(sql), params);
                return res.rows[0] || null;
            } catch (err) {
                console.warn('PostgreSQL query error, falling back to mock store:', err.message);
                return mockDbWrapper.prepare(sql).get(...params);
            }
        },
        all: async (...params) => {
            if (!isPgAvailable || !pool) return mockDbWrapper.prepare(sql).all(...params);
            try {
                if (params.length === 1 && Array.isArray(params[0])) params = params[0];
                const res = await pool.query(replacePlaceholders(sql), params);
                return res.rows;
            } catch (err) {
                console.warn('PostgreSQL query error, falling back to mock store:', err.message);
                return mockDbWrapper.prepare(sql).all(...params);
            }
        },
        run: async (...params) => {
            if (!isPgAvailable || !pool) return mockDbWrapper.prepare(sql).run(...params);
            try {
                if (params.length === 1 && Array.isArray(params[0])) params = params[0];
                const res = await pool.query(replacePlaceholders(sql), params);
                return { changes: res.rowCount };
            } catch (err) {
                console.warn('PostgreSQL query error, falling back to mock store:', err.message);
                return mockDbWrapper.prepare(sql).run(...params);
            }
        }
    }),
    transaction: async (callback) => {
        if (!isPgAvailable || !pool) return mockDbWrapper.transaction(callback);
        let client;
        try {
            client = await pool.connect();
            await client.query('BEGIN');
            const txWrapper = {
                prepare: (sql) => ({
                    get: async (...params) => {
                        if (params.length === 1 && Array.isArray(params[0])) params = params[0];
                        const res = await client.query(replacePlaceholders(sql), params);
                        return res.rows[0] || null;
                    },
                    all: async (...params) => {
                        if (params.length === 1 && Array.isArray(params[0])) params = params[0];
                        const res = await client.query(replacePlaceholders(sql), params);
                        return res.rows;
                    },
                    run: async (...params) => {
                        if (params.length === 1 && Array.isArray(params[0])) params = params[0];
                        const res = await client.query(replacePlaceholders(sql), params);
                        return { changes: res.rowCount };
                    }
                })
            };
            const result = await callback(txWrapper);
            await client.query('COMMIT');
            return result;
        } catch (e) {
            if (client) await client.query('ROLLBACK').catch(() => {});
            console.warn('PostgreSQL transaction error, falling back to mock store:', e.message);
            return mockDbWrapper.transaction(callback);
        } finally {
            if (client) client.release();
        }
    }
};

function whenReady() {
    return initPromise || Promise.resolve();
}

function getDb() {
    if (!isPgAvailable || !pool) {
        return mockDbWrapper;
    }
    return pgDbWrapper;
}

function closeDatabase() {
    if (pool) {
        pool.end().catch(() => {});
        pool = null;
        initPromise = null;
        isPgAvailable = false;
    }
}

function generateAccessKey() {
    return crypto.randomBytes(25).toString('hex');
}

module.exports = {
    initDatabase,
    whenReady,
    getDb,
    closeDatabase,
    generateAccessKey,
    DEFAULT_ACCESS_KEY,
};
