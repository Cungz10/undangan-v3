const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { initDatabase, whenReady } = require('./database');
const authRoutes = require('./routes/auth');
const commentRoutes = require('./routes/comment');
const checkinRoutes = require('./routes/checkin');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
app.disable('x-powered-by');
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
}));

const allowedOrigins = new Set(
    (process.env.CORS_ORIGINS || '')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean)
);

if (process.env.TRUST_PROXY_HOPS) {
    const proxyHops = Number(process.env.TRUST_PROXY_HOPS);
    if (!Number.isInteger(proxyHops) || proxyHops < 1) {
        throw new Error('TRUST_PROXY_HOPS must be a positive integer.');
    }
    app.set('trust proxy', proxyHops);
} else {
    app.set('trust proxy', 1);
}

// Initialize database
initDatabase();

// CORS middleware
app.use(cors({
    origin: (origin, callback) => callback(null, !origin || allowedOrigins.size === 0 || allowedOrigins.has(origin) || allowedOrigins.has('*')),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-access-key', 'Accept'],
    exposedHeaders: ['Content-Disposition'],
}));

// Body parsers
app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: true, limit: '32kb' }));

const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
});

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
});

app.use('/api', apiLimiter);
app.use('/api/session', loginLimiter);

// Wait for DB tables/seed to be ready before handling any API request.
app.use('/api', (req, res, next) => {
    whenReady().then(() => next(), next);
});

// Request logger for development
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        if (req.path.startsWith('/api')) {
            console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} ${res.statusCode} - ${duration}ms`);
        }
    });
    next();
});

// API Routes
app.use('/api', authRoutes);
app.use('/api', commentRoutes);
app.use('/api/checkin', checkinRoutes);

// RSVP endpoint for the stitch invitation design with check-in QR token generation
app.post('/api/rsvp', async (req, res) => {
    try {
        const { n, a, p, w } = req.body || {};
        if (n && typeof n === 'string' && n.trim().length > 0) {
            const { getDb } = require('./database');
            const { v4: uuidv4 } = require('uuid');
            const crypto = require('crypto');
            const { deriveToken, hashToken, isConfigured } = require('./utils/guestToken');
            const db = getDb();
            const commentUuid = uuidv4();
            const own = crypto.randomBytes(16).toString('hex');
            const presence = (a === 'Hadir Bersama' || a === 'Hadir Virtual') ? 1 : 0;
            const guestPax = Math.min(50, Math.max(1, Number(p) || 1));
            const cleanName = String(n).trim();
            const commentText = w && String(w).trim().length > 0
                ? `${String(w).trim()} (${a || 'Hadir'} • ${guestPax} Pax)`
                : `Konfirmasi: ${a || 'Hadir'} • ${guestPax} Pax`;

            // 1. Insert into comments table for wish feed & stats
            await db.prepare(`
                INSERT INTO comments (uuid, own, user_id, parent_id, name, presence, comment, gif_url, is_admin, ip, user_agent)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(commentUuid, own, 1, null, cleanName, presence, commentText, null, 0, req.ip || '127.0.0.1', req.headers['user-agent'] || null);

            // 2. Generate check-in QR token using QR_TOKEN_SECRET
            const guestUuid = uuidv4();
            let token;
            if (isConfigured()) {
                token = deriveToken(guestUuid, 1);
            } else {
                token = crypto.randomBytes(32).toString('hex');
            }
            const tokenHash = hashToken(token);

            // 3. Register guest into invited_guests for venue check-in scanner
            await db.prepare(`
                INSERT INTO invited_guests (uuid, name, group_name, pax, token_version, token_hash)
                VALUES (?, ?, ?, ?, 1, ?)
            `).run(guestUuid, cleanName, a || 'RSVP Online', guestPax, tokenHash);

            return res.status(200).json({
                code: 200,
                status: true,
                data: {
                    token,
                    uuid: guestUuid,
                    name: cleanName,
                    group_name: a || 'RSVP Online',
                    pax: guestPax,
                    presence
                }
            });
        }
    } catch (e) {
        console.warn('RSVP DB save error:', e.message);
    }
    return res.status(200).json({ code: 200, status: true });
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.status(200).json({ status: 'ok', time: new Date().toISOString() });
});

// Serve built public directory and fallback to root static assets
const publicDir = path.join(__dirname, '..', 'public');
const rootDir = path.join(__dirname, '..');

if (fs.existsSync(publicDir)) {
    app.use(express.static(publicDir));
}
app.use(express.static(rootDir));

// Friendly route mappings
app.get('/dashboard', (req, res) => {
    const file = fs.existsSync(path.join(publicDir, 'dashboard.html'))
        ? path.join(publicDir, 'dashboard.html')
        : path.join(rootDir, 'dashboard.html');
    res.sendFile(file);
});

app.get('/guests', (req, res) => {
    const file = fs.existsSync(path.join(publicDir, 'guests.html'))
        ? path.join(publicDir, 'guests.html')
        : path.join(rootDir, 'guests.html');
    res.sendFile(file);
});

app.get('/checkin', (req, res) => {
    const file = fs.existsSync(path.join(publicDir, 'checkin.html'))
        ? path.join(publicDir, 'checkin.html')
        : path.join(rootDir, 'checkin.html');
    res.sendFile(file);
});

// Return explicit 404s for unknown API and static paths.
app.use((req, res) => {
    if (req.path.startsWith('/api')) {
        return res.status(404).json({ error: ['Endpoint not found'] });
    }
    const indexFile = fs.existsSync(path.join(publicDir, 'index.html'))
        ? path.join(publicDir, 'index.html')
        : path.join(rootDir, 'index.html');
    return res.status(404).sendFile(indexFile);
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Unhandled Server Error:', err);
    res.status(500).json({
        code: 500,
        error: ['Internal Server Error'],
    });
});

if (require.main === module) {
    app.listen(PORT, '0.0.0.0', () => {
        console.log('\n=======================================================');
        console.log(`🚀 Undangan Backend Server running on http://0.0.0.0:${PORT}`);
        console.log(`🌐 Frontend Invitation : http://localhost:${PORT}/`);
        console.log(`⚙️ Admin Dashboard     : http://localhost:${PORT}/dashboard.html`);
        console.log('=======================================================\n');
    });
}

module.exports = app;
