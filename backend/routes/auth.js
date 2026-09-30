const express = require('express');
const bcrypt = require('bcryptjs');
const { getDb, generateAccessKey } = require('../database');
const { authAdmin, generateToken } = require('../middleware/auth');

const router = express.Router();

/**
 * POST /api/session
 * Admin login endpoint.
 */
router.post('/session', async (req, res) => {
    try {
        const { email, password } = req.body || {};

        if (!email || !password) {
            return res.status(400).json({ error: ['Email and password are required'] });
        }

        const db = getDb();
        const user = await db.prepare('SELECT * FROM users WHERE email = ?').get(email);

        if (!user) {
            return res.status(401).json({ error: ['Invalid email or password'] });
        }

        const isMatch = bcrypt.compareSync(password, user.password);
        if (!isMatch) {
            return res.status(401).json({ error: ['Invalid email or password'] });
        }

        const token = generateToken(user);
        return res.status(200).json({
            code: 200,
            data: { token },
            error: null,
        });
    } catch (err) {
        console.error('Session error:', err);
        return res.status(500).json({ error: ['Internal server error'] });
    }
});

/**
 * GET /api/user
 * Get current admin details and settings.
 */
router.get('/user', authAdmin, async (req, res) => {
    try {
        const db = getDb();
        const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

        if (!user) {
            return res.status(404).json({ error: ['User not found'] });
        }

        return res.status(200).json({
            code: 200,
            data: {
                name: user.name,
                email: user.email,
                access_key: user.access_key,
                tz: user.tz,
                is_filter: Boolean(user.is_filter),
                is_confetti_animation: Boolean(user.is_confetti_animation),
                can_reply: Boolean(user.can_reply),
                can_edit: Boolean(user.can_edit),
                can_delete: Boolean(user.can_delete),
                tenor_key: user.tenor_key || '',
            },
            error: null,
        });
    } catch (err) {
        console.error('Get user error:', err);
        return res.status(500).json({ error: ['Internal server error'] });
    }
});

/**
 * PATCH /api/user
 * Update admin settings or password.
 */
router.patch('/user', authAdmin, async (req, res) => {
    try {
        const db = getDb();
        const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

        if (!user) {
            return res.status(404).json({ error: ['User not found'] });
        }

        const body = req.body || {};

        // Change password
        if (body.old_password !== undefined && body.new_password !== undefined) {
            if (!body.old_password || !body.new_password) {
                return res.status(400).json({ error: ['Old password and new password are required'] });
            }

            if (body.new_password.length < 12) {
                return res.status(400).json({ error: ['New password must be at least 12 characters'] });
            }

            const isMatch = bcrypt.compareSync(body.old_password, user.password);
            if (!isMatch) {
                return res.status(400).json({ error: ['Old password incorrect'] });
            }

            const hashed = bcrypt.hashSync(body.new_password, 10);
            await db.prepare('UPDATE users SET password = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(hashed, user.id);

            return res.status(200).json({
                code: 200,
                data: { status: true },
                error: null,
            });
        }

        // Update single or multiple fields
        const updatable = [
            'name',
            'tz',
            'is_filter',
            'is_confetti_animation',
            'can_reply',
            'can_edit',
            'can_delete',
            'tenor_key',
        ];

        const updates = [];
        const values = [];

        for (const field of updatable) {
            if (body[field] !== undefined) {
                updates.push(`${field} = ?`);
                if (typeof body[field] === 'boolean') {
                    values.push(body[field] ? 1 : 0);
                } else {
                    values.push(body[field]);
                }
            }
        }

        if (updates.length > 0) {
            updates.push('updated_at = CURRENT_TIMESTAMP');
            values.push(user.id);

            const sql = `UPDATE users SET ${updates.join(', ')} WHERE id = ?`;
            await db.prepare(sql).run(...values);
        }

        return res.status(200).json({
            code: 200,
            data: { status: true },
            error: null,
        });
    } catch (err) {
        console.error('Update user error:', err);
        return res.status(500).json({ error: ['Internal server error'] });
    }
});

/**
 * PUT /api/key
 * Regenerate access key.
 */
router.put('/key', authAdmin, async (req, res) => {
    try {
        const db = getDb();
        const newKey = generateAccessKey();

        await db.prepare('UPDATE users SET access_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newKey, req.user.id);

        return res.status(200).json({
            code: 200,
            data: {
                status: true,
                access_key: newKey,
            },
            error: null,
        });
    } catch (err) {
        console.error('Regenerate key error:', err);
        return res.status(500).json({ error: ['Internal server error'] });
    }
});

/**
 * GET /api/stats
 * Admin dashboard statistics.
 */
router.get('/stats', authAdmin, async (req, res) => {
    try {
        const db = getDb();
        const userId = req.user.id;

        const commentsCount = Number((await db.prepare('SELECT COUNT(*) as count FROM comments WHERE user_id = ?').get(userId)).count);

        const likesCount = Number((await db.prepare(`
            SELECT COUNT(l.id) as count
            FROM likes l
            JOIN comments c ON l.comment_id = c.id
            WHERE c.user_id = ?
        `).get(userId)).count);

        const presentCount = Number((await db.prepare(`
            SELECT COUNT(*) as count
            FROM comments
            WHERE user_id = ? AND parent_id IS NULL AND presence = 1
        `).get(userId)).count);

        const absentCount = Number((await db.prepare(`
            SELECT COUNT(*) as count
            FROM comments
            WHERE user_id = ? AND parent_id IS NULL AND presence = 0
        `).get(userId)).count);

        return res.status(200).json({
            code: 200,
            data: {
                comments: commentsCount,
                likes: likesCount,
                present: presentCount,
                absent: absentCount,
            },
            error: null,
        });
    } catch (err) {
        console.error('Stats error:', err);
        return res.status(500).json({ error: ['Internal server error'] });
    }
});

/**
 * GET /api/download
 * Download CSV export of all comments.
 */
router.get('/download', authAdmin, async (req, res) => {
    try {
        const db = getDb();
        const userId = req.user.id;

        const rows = await db.prepare(`
            SELECT c.uuid, c.name, c.presence, c.comment, c.created_at, c.ip, c.user_agent,
                   CASE WHEN c.parent_id IS NULL THEN 'Parent' ELSE 'Reply' END as type
            FROM comments c
            WHERE c.user_id = ?
            ORDER BY c.created_at DESC
        `).all(userId);

        const escapeCsv = (val) => {
            if (val === null || val === undefined) return '""';
            const str = String(val).replace(/"/g, '""');
            return `"${str}"`;
        };

        const headers = ['UUID', 'Type', 'Name', 'Presence', 'Comment', 'Date', 'IP', 'User Agent'];
        const csvLines = [headers.join(',')];

        for (const row of rows) {
            csvLines.push([
                escapeCsv(row.uuid),
                escapeCsv(row.type),
                escapeCsv(row.name),
                escapeCsv(row.presence ? 'Hadir' : 'Tidak Hadir'),
                escapeCsv(row.comment),
                escapeCsv(row.created_at),
                escapeCsv(row.ip),
                escapeCsv(row.user_agent),
            ].join(','));
        }

        const csvContent = '\uFEFF' + csvLines.join('\r\n'); // Add UTF-8 BOM for Excel

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="comments.csv"');
        return res.status(200).send(csvContent);
    } catch (err) {
        console.error('Download error:', err);
        return res.status(500).json({ error: ['Internal server error'] });
    }
});

module.exports = router;
