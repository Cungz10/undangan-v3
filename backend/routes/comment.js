const express = require('express');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const { getDb } = require('../database');
const { authGuestOrAdmin } = require('../middleware/auth');
const { filterBadWords } = require('../utils/filter');
const { formatCommentDate } = require('../utils/date');
const { isValidGifInput, resolveGifUrl } = require('../utils/gif');

const router = express.Router();

function validateCommentPayload(body, isCreate) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return 'A JSON object is required';
    }
    if (isCreate && (typeof body.name !== 'string' || body.name.trim().length === 0)) {
        return 'Name is required';
    }
    if (body.name !== undefined && (typeof body.name !== 'string' || body.name.trim().length > 100)) {
        return 'Name must be a string of at most 100 characters';
    }
    if (body.comment !== undefined && body.comment !== null && (typeof body.comment !== 'string' || body.comment.length > 5000)) {
        return 'Comment must be a string of at most 5000 characters';
    }
    if (body.presence !== undefined && body.presence !== null && typeof body.presence !== 'boolean') {
        return 'Presence must be a boolean';
    }
    if (body.gif_id !== undefined && body.gif_id !== null && body.gif_id !== '' && !isValidGifInput(body.gif_id)) {
        return 'GIF id is invalid';
    }
    if (body.id !== undefined && body.id !== null && (typeof body.id !== 'string' || body.id.length > 64)) {
        return 'Parent id is invalid';
    }
    return null;
}

/**
 * GET /api/v2/config
 * Return guest configuration for the active invitation.
 */
router.get('/v2/config', authGuestOrAdmin, async (req, res) => {
    try {
        const db = getDb();
        const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

        if (!user) {
            return res.status(404).json({ error: ['Invitation not found'] });
        }

        return res.status(200).json({
            code: 200,
            data: {
                tz: user.tz,
                is_filter: Boolean(user.is_filter),
                is_confetti_animation: Boolean(user.is_confetti_animation),
                can_reply: Boolean(user.can_reply),
                can_edit: Boolean(user.can_edit),
                can_delete: Boolean(user.can_delete),
                tenor_key: user.tenor_key || null,
            },
            error: null,
        });
    } catch (err) {
        console.error('Get config error:', err);
        return res.status(500).json({ error: ['Internal server error'] });
    }
});

/**
 * GET /api/v2/comment
 * Get paginated comments with replies and likes count.
 */
router.get('/v2/comment', authGuestOrAdmin, async (req, res) => {
    try {
        const db = getDb();
        const userId = req.user.id;
        const user = await db.prepare('SELECT tz FROM users WHERE id = ?').get(userId);
        const timeZone = user?.tz || 'Asia/Jakarta';

        const per = Math.min(100, Math.max(1, parseInt(req.query.per, 10) || 10));
        const next = Math.max(0, parseInt(req.query.next, 10) || 0);

        // Count total parent comments
        const totalParents = Number((await db.prepare(`
            SELECT COUNT(*) as count
            FROM comments
            WHERE user_id = ? AND parent_id IS NULL
        `).get(userId)).count);

        // Fetch parent comments
        const parents = await db.prepare(`
            SELECT c.*,
                   (SELECT COUNT(*) FROM likes l WHERE l.comment_id = c.id) as like_count
            FROM comments c
            WHERE c.user_id = ? AND c.parent_id IS NULL
            ORDER BY c.id DESC
            LIMIT ? OFFSET ?
        `).all(userId, per, next);

        // Fetch all replies for these parent comments
        const parentIds = parents.map((p) => p.id);
        let allReplies = [];
        if (parentIds.length > 0) {
            const placeholders = parentIds.map(() => '?').join(',');
            allReplies = await db.prepare(`
                SELECT c.*,
                       (SELECT COUNT(*) FROM likes l WHERE l.comment_id = c.id) as like_count
                FROM comments c
                WHERE c.user_id = ? AND c.parent_id IN (${placeholders})
                ORDER BY c.id ASC
            `).all(userId, ...parentIds);
        }

        // Group replies by parent_id
        const repliesByParent = {};
        for (const reply of allReplies) {
            if (!repliesByParent[reply.parent_id]) {
                repliesByParent[reply.parent_id] = [];
            }
            repliesByParent[reply.parent_id].push({
                uuid: reply.uuid,
                own: req.isAdmin ? reply.own : '',
                name: reply.name,
                presence: Boolean(reply.presence),
                comment: reply.comment,
                created_at: formatCommentDate(reply.created_at, timeZone),
                is_admin: Boolean(reply.is_admin),
                is_parent: false,
                gif_url: reply.gif_url,
                ip: req.isAdmin ? reply.ip : null,
                user_agent: req.isAdmin ? reply.user_agent : null,
                comments: [],
                like_count: reply.like_count || 0,
            });
        }

        const lists = parents.map((p) => ({
            uuid: p.uuid,
            own: req.isAdmin ? p.own : '',
            name: p.name,
            presence: Boolean(p.presence),
            comment: p.comment,
            created_at: formatCommentDate(p.created_at, timeZone),
            is_admin: Boolean(p.is_admin),
            is_parent: true,
            gif_url: p.gif_url,
            ip: req.isAdmin ? p.ip : null,
            user_agent: req.isAdmin ? p.user_agent : null,
            comments: repliesByParent[p.id] || [],
            like_count: p.like_count || 0,
        }));

        return res.status(200).json({
            code: 200,
            data: {
                count: totalParents,
                lists,
            },
            error: null,
        });
    } catch (err) {
        console.error('Get comments error:', err);
        return res.status(500).json({ error: ['Internal server error'] });
    }
});

/**
 * POST /api/comment
 * Create parent comment or reply.
 */
router.post('/comment', authGuestOrAdmin, async (req, res) => {
    try {
        const db = getDb();
        const userId = req.user.id;
        const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(userId);

        if (!user) {
            return res.status(404).json({ error: ['Invitation not found'] });
        }

        let { id, name, presence, comment, gif_id } = req.body || {};

        const validationError = validateCommentPayload(req.body, true);
        if (validationError) {
            return res.status(400).json({ error: [validationError] });
        }

        let parentId = null;
        const isParent = !id;

        if (id) {
            if (!req.isAdmin && !user.can_reply) {
                return res.status(403).json({ error: ['Replies are disabled by host'] });
            }

            const parent = await db.prepare('SELECT id FROM comments WHERE uuid = ? AND user_id = ?').get(id, userId);
            if (!parent) {
                return res.status(404).json({ error: ['Parent comment not found'] });
            }
            parentId = parent.id;
        }

        // Apply bad words filter if configured
        if (user.is_filter && comment) {
            comment = filterBadWords(comment);
        }

        const gifUrl = await resolveGifUrl(gif_id, user.tenor_key);
        if (gif_id && !gifUrl) {
            return res.status(422).json({ error: ['GIF could not be resolved'] });
        }
        const commentUuid = uuidv4();
        const commentOwn = crypto.randomBytes(16).toString('hex');
        const isAdminVal = req.isAdmin ? 1 : 0;
        const presenceVal = presence ? 1 : 0;
        const ip = req.ip || req.socket.remoteAddress || '127.0.0.1';
        const userAgent = req.headers['user-agent'] || null;

        await db.prepare(`
            INSERT INTO comments (uuid, own, user_id, parent_id, name, presence, comment, gif_url, is_admin, ip, user_agent)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(commentUuid, commentOwn, userId, parentId, name.trim(), presenceVal, comment || null, gifUrl || null, isAdminVal, ip, userAgent);

        const newComment = {
            uuid: commentUuid,
            own: commentOwn,
            name: name.trim(),
            presence: Boolean(presenceVal),
            comment: comment || null,
            created_at: formatCommentDate(new Date(), user.tz),
            is_admin: Boolean(isAdminVal),
            is_parent: isParent,
            gif_url: gifUrl || null,
            ip: req.isAdmin ? ip : null,
            user_agent: req.isAdmin ? userAgent : null,
            comments: [],
            like_count: 0,
        };

        return res.status(201).json({
            code: 201,
            data: newComment,
            error: null,
        });
    } catch (err) {
        console.error('Create comment error:', err);
        return res.status(500).json({ error: ['Internal server error'] });
    }
});

/**
 * PUT /api/comment/:id
 * Update comment content/presence.
 */
router.put('/comment/:id', authGuestOrAdmin, async (req, res) => {
    try {
        const db = getDb();
        const userId = req.user.id;
        const idParam = req.params.id;
        const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(userId);

        if (!user) {
            return res.status(404).json({ error: ['Invitation not found'] });
        }

        if (!req.isAdmin && !user.can_edit) {
            return res.status(403).json({ error: ['Editing is disabled by host'] });
        }

        // Find comment by own (for guest) or own/uuid (for admin)
        let commentRow;
        if (req.isAdmin) {
            commentRow = await db.prepare('SELECT * FROM comments WHERE (own = ? OR uuid = ?) AND user_id = ?').get(idParam, idParam, userId);
        } else {
            commentRow = await db.prepare('SELECT * FROM comments WHERE own = ? AND user_id = ?').get(idParam, userId);
        }

        if (!commentRow) {
            return res.status(404).json({ error: ['Comment not found'] });
        }

        const validationError = validateCommentPayload(req.body, false);
        if (validationError) {
            return res.status(400).json({ error: [validationError] });
        }

        let { presence, comment, gif_id } = req.body;

        if (user.is_filter && comment) {
            comment = filterBadWords(comment);
        }

        let gifUrl = commentRow.gif_url;
        if (gif_id !== undefined) {
            gifUrl = await resolveGifUrl(gif_id, user.tenor_key);
            if (gif_id && !gifUrl) {
                return res.status(422).json({ error: ['GIF could not be resolved'] });
            }
        }

        const presenceVal = presence !== null && presence !== undefined ? (presence ? 1 : 0) : commentRow.presence;
        const commentVal = comment !== undefined ? (comment || null) : commentRow.comment;

        await db.prepare(`
            UPDATE comments
            SET presence = ?, comment = ?, gif_url = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(presenceVal, commentVal, gifUrl, commentRow.id);

        return res.status(200).json({
            code: 200,
            data: { status: true },
            error: null,
        });
    } catch (err) {
        console.error('Update comment error:', err);
        return res.status(500).json({ error: ['Internal server error'] });
    }
});

/**
 * DELETE /api/comment/:id
 * Delete comment (and cascaded replies/likes).
 */
router.delete('/comment/:id', authGuestOrAdmin, async (req, res) => {
    try {
        const db = getDb();
        const userId = req.user.id;
        const idParam = req.params.id;
        const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(userId);

        if (!user) {
            return res.status(404).json({ error: ['Invitation not found'] });
        }

        if (!req.isAdmin && !user.can_delete) {
            return res.status(403).json({ error: ['Deleting is disabled by host'] });
        }

        let commentRow;
        if (req.isAdmin) {
            commentRow = await db.prepare('SELECT * FROM comments WHERE (own = ? OR uuid = ?) AND user_id = ?').get(idParam, idParam, userId);
        } else {
            commentRow = await db.prepare('SELECT * FROM comments WHERE own = ? AND user_id = ?').get(idParam, userId);
        }

        if (!commentRow) {
            return res.status(404).json({ error: ['Comment not found'] });
        }

        await db.prepare('DELETE FROM comments WHERE id = ?').run(commentRow.id);

        return res.status(200).json({
            code: 200,
            data: { status: true },
            error: null,
        });
    } catch (err) {
        console.error('Delete comment error:', err);
        return res.status(500).json({ error: ['Internal server error'] });
    }
});

/**
 * POST /api/comment/:id
 * Like a comment.
 */
router.post('/comment/:id', authGuestOrAdmin, async (req, res) => {
    try {
        const db = getDb();
        const commentUuid = req.params.id;

        const commentRow = await db.prepare('SELECT id FROM comments WHERE uuid = ?').get(commentUuid);
        if (!commentRow) {
            return res.status(404).json({ error: ['Comment not found'] });
        }

        const likeUuid = uuidv4();
        const ip = req.ip || req.socket.remoteAddress || '127.0.0.1';

        const existingLike = await db.prepare('SELECT id FROM likes WHERE comment_id = ? AND ip = ?').get(commentRow.id, ip);
        if (existingLike) {
            return res.status(409).json({ error: ['Already liked'] });
        }

        await db.prepare(`
            INSERT INTO likes (uuid, comment_id, ip)
            VALUES (?, ?, ?)
        `).run(likeUuid, commentRow.id, ip);

        return res.status(201).json({
            code: 201,
            data: { uuid: likeUuid },
            error: null,
        });
    } catch (err) {
        console.error('Like comment error:', err);
        return res.status(500).json({ error: ['Internal server error'] });
    }
});

/**
 * PATCH /api/comment/:id
 * Unlike a comment.
 */
router.patch('/comment/:id', authGuestOrAdmin, async (req, res) => {
    try {
        const db = getDb();
        const likeUuid = req.params.id;

        const info = await db.prepare('DELETE FROM likes WHERE uuid = ?').run(likeUuid);

        return res.status(200).json({
            code: 200,
            data: { status: info.changes > 0 },
            error: null,
        });
    } catch (err) {
        console.error('Unlike comment error:', err);
        return res.status(500).json({ error: ['Internal server error'] });
    }
});

module.exports = router;
