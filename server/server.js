const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const PORT = +process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.sqlite');
const NODE_ENV = process.env.NODE_ENV || 'production';
const TRUST_PROXY = process.env.TRUST_PROXY ? (+process.env.TRUST_PROXY || true) : false;
const CALC_HTML = process.env.CALC_HTML || path.join(__dirname, '..', 'raskroy.html');

// Database init
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at INTEGER NOT NULL,
    last_login INTEGER
);
CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    action TEXT NOT NULL,
    details TEXT,
    ip TEXT,
    user_agent TEXT,
    ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);
`);

// Seed admin if no users
if (db.prepare('SELECT COUNT(*) AS c FROM users').get().c === 0) {
    const u = process.env.ADMIN_USERNAME || 'admin';
    const p = process.env.ADMIN_PASSWORD || 'admin';
    const hash = bcrypt.hashSync(p, 10);
    db.prepare('INSERT INTO users (username, password_hash, is_admin, is_active, created_at) VALUES (?, ?, 1, 1, ?)')
      .run(u, hash, Date.now());
    console.log(`[seed] Created admin "${u}" with password "${p}". CHANGE IT IMMEDIATELY.`);
}

// App
const app = express();
if (TRUST_PROXY) app.set('trust proxy', TRUST_PROXY);
app.disable('x-powered-by');
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: '64kb' }));

app.use(session({
    store: new SQLiteStore({ db: 'sessions.sqlite', dir: __dirname, table: 'sessions' }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    name: 'kt.sid',
    cookie: {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 1000 * 60 * 60 * 24 * 14,
        secure: NODE_ENV === 'production' && !!TRUST_PROXY,
    },
}));

// Helpers
const logAction = (req, userId, action, details) => {
    try {
        db.prepare('INSERT INTO audit_log (user_id, action, details, ip, user_agent, ts) VALUES (?, ?, ?, ?, ?, ?)')
          .run(userId || null, action,
               details ? JSON.stringify(details) : null,
               req.ip || null,
               (req.get('user-agent') || '').slice(0, 200),
               Date.now());
    } catch (e) { console.error('logAction', e); }
};

const requireAuth = (req, res, next) => {
    if (!req.session.userId) return res.redirect('/login');
    const user = db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(req.session.userId);
    if (!user) {
        const uid = req.session.userId;
        req.session.destroy(() => {});
        logAction(req, uid, 'session_killed_inactive');
        return res.redirect('/login?msg=disabled');
    }
    req.user = user;
    next();
};

const requireAdmin = (req, res, next) => {
    if (!req.user || !req.user.is_admin) return res.status(403).send('Forbidden');
    next();
};

const renderTemplate = (file, vars) => {
    let html = fs.readFileSync(path.join(__dirname, 'views', file), 'utf8');
    for (const [k, v] of Object.entries(vars || {})) {
        html = html.replaceAll(`{{${k}}}`, String(v == null ? '' : v));
    }
    return html;
};

// Brute-force protection on /login
const loginLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: 'Забагато спроб входу. Спробуйте за кілька хвилин.',
});

// Routes — auth
app.get('/login', (req, res) => {
    if (req.session.userId) return res.redirect('/');
    const msg = req.query.msg === 'disabled' ? 'Доступ закрито адміністратором.'
              : req.query.msg === 'error'    ? 'Невірний логін або пароль.'
              : '';
    res.set('Content-Type', 'text/html; charset=utf-8')
       .send(renderTemplate('login.html', { MSG: msg }));
});

app.post('/login', loginLimiter, (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const user = db.prepare('SELECT * FROM users WHERE username = ? AND is_active = 1').get(username);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
        logAction(req, null, 'login_fail', { username });
        return setTimeout(() => res.redirect('/login?msg=error'), 800);
    }
    req.session.userId = user.id;
    db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(Date.now(), user.id);
    logAction(req, user.id, 'login_ok');
    res.redirect(user.is_admin ? '/admin' : '/');
});

app.post('/logout', (req, res) => {
    const uid = req.session.userId;
    req.session.destroy(() => {
        if (uid) logAction(req, uid, 'logout');
        res.redirect('/login');
    });
});

// Calculator (protected)
app.get('/', requireAuth, (req, res) => {
    logAction(req, req.user.id, 'view');
    res.sendFile(CALC_HTML);
});

// Optional API: front-end may push events
app.post('/api/log', requireAuth, (req, res) => {
    const action = String(req.body.action || '').slice(0, 50);
    if (!action) return res.status(400).end();
    logAction(req, req.user.id, action, req.body.details);
    res.json({ ok: true });
});

// Admin
app.get('/admin', requireAuth, requireAdmin, (req, res) => {
    res.set('Content-Type', 'text/html; charset=utf-8')
       .send(renderTemplate('admin.html', { ADMIN: req.user.username }));
});

app.get('/admin/api/me', requireAuth, requireAdmin, (req, res) => {
    res.json({ id: req.user.id, username: req.user.username, is_admin: !!req.user.is_admin });
});

app.get('/admin/api/users', requireAuth, requireAdmin, (req, res) => {
    res.json(db.prepare('SELECT id, username, is_admin, is_active, created_at, last_login FROM users ORDER BY username').all());
});

app.post('/admin/api/users', requireAuth, requireAdmin, (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    if (!username || !/^[A-Za-z0-9_.\-]{2,32}$/.test(username))
        return res.status(400).json({ error: 'Логін має бути 2–32 символи (літери/цифри/_-.)' });
    if (password.length < 6)
        return res.status(400).json({ error: 'Пароль має бути ≥6 символів.' });
    const hash = bcrypt.hashSync(password, 10);
    try {
        db.prepare('INSERT INTO users (username, password_hash, is_admin, is_active, created_at) VALUES (?, ?, ?, 1, ?)')
          .run(username, hash, req.body.is_admin ? 1 : 0, Date.now());
        logAction(req, req.user.id, 'create_user', { username });
        res.json({ ok: true });
    } catch (e) {
        res.status(400).json({ error: 'Користувач з таким логіном уже існує.' });
    }
});

app.post('/admin/api/users/:id/active', requireAuth, requireAdmin, (req, res) => {
    const id = +req.params.id;
    if (id === req.user.id) return res.status(400).json({ error: 'Не можна заблокувати самого себе.' });
    db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(req.body.active ? 1 : 0, id);
    logAction(req, req.user.id, req.body.active ? 'enable_user' : 'disable_user', { id });
    res.json({ ok: true });
});

app.post('/admin/api/users/:id/admin', requireAuth, requireAdmin, (req, res) => {
    const id = +req.params.id;
    if (id === req.user.id) return res.status(400).json({ error: 'Не можна змінювати свою роль.' });
    db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(req.body.is_admin ? 1 : 0, id);
    logAction(req, req.user.id, 'toggle_admin', { id, is_admin: !!req.body.is_admin });
    res.json({ ok: true });
});

app.post('/admin/api/users/:id/password', requireAuth, requireAdmin, (req, res) => {
    const id = +req.params.id;
    const password = String(req.body.password || '');
    if (password.length < 6) return res.status(400).json({ error: 'Пароль має бути ≥6 символів.' });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), id);
    logAction(req, req.user.id, 'reset_password', { id });
    res.json({ ok: true });
});

app.delete('/admin/api/users/:id', requireAuth, requireAdmin, (req, res) => {
    const id = +req.params.id;
    if (id === req.user.id) return res.status(400).json({ error: 'Не можна видалити самого себе.' });
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    logAction(req, req.user.id, 'delete_user', { id });
    res.json({ ok: true });
});

app.get('/admin/api/log', requireAuth, requireAdmin, (req, res) => {
    const limit = Math.min(+req.query.limit || 200, 1000);
    res.json(db.prepare(`
        SELECT al.id, al.action, al.details, al.ip, al.user_agent, al.ts, u.username
        FROM audit_log al LEFT JOIN users u ON u.id = al.user_id
        ORDER BY al.id DESC LIMIT ?
    `).all(limit));
});

app.get('/admin/api/sessions', requireAuth, requireAdmin, (req, res) => {
    try {
        const sdb = new Database(path.join(__dirname, 'sessions.sqlite'), { readonly: true, fileMustExist: true });
        const rows = sdb.prepare('SELECT sid, expired, sess FROM sessions WHERE expired > ?').all(Date.now() / 1000);
        sdb.close();
        const userById = (id) => db.prepare('SELECT username FROM users WHERE id = ?').get(id);
        res.json(rows.map(r => {
            try {
                const sess = JSON.parse(r.sess);
                if (!sess.userId) return null;
                const u = userById(sess.userId);
                return { sid: r.sid, expires: r.expired * 1000, userId: sess.userId, username: u ? u.username : null };
            } catch { return null; }
        }).filter(Boolean));
    } catch (e) {
        res.json([]);
    }
});

app.delete('/admin/api/sessions/:sid', requireAuth, requireAdmin, (req, res) => {
    try {
        const sdb = new Database(path.join(__dirname, 'sessions.sqlite'));
        sdb.prepare('DELETE FROM sessions WHERE sid = ?').run(req.params.sid);
        sdb.close();
        logAction(req, req.user.id, 'kill_session', { sid: req.params.sid });
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: 'Не вдалося завершити сесію.' });
    }
});

app.use((req, res) => res.status(404).send('Not found'));

app.listen(PORT, HOST, () => {
    console.log(`raskroy server listening on http://${HOST}:${PORT}`);
});
