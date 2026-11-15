// db.js - ฐานข้อมูล Turso (libSQL = SQLite บนคลาวด์)
// ถ้าไม่ได้ตั้ง TURSO_DATABASE_URL จะใช้ไฟล์ local.db ในเครื่อง (สำหรับทดสอบบนคอมตัวเอง)
const { createClient } = require('@libsql/client');

// .trim() กันช่องว่าง/ขึ้นบรรทัดใหม่ที่ติดมาตอนก๊อปวางค่าใน Render (สาเหตุ "invalid header value")
const url = (process.env.TURSO_DATABASE_URL || '').trim() || 'file:local.db';
const authToken = (process.env.TURSO_AUTH_TOKEN || '').trim() || undefined;
const db = createClient({ url, authToken });

async function initDb() {
    await db.batch([
        `CREATE TABLE IF NOT EXISTS users (
            discord_id TEXT PRIMARY KEY,
            name       TEXT NOT NULL,
            avatar     TEXT,
            points     INTEGER NOT NULL DEFAULT 0 CHECK (points >= 0),
            created_at INTEGER NOT NULL,
            last_login INTEGER NOT NULL
        )`,
        // สมุดบัญชี: ทุกการเปลี่ยนแปลงของ Point ต้องมีแถวที่นี่ (ref ซ้ำไม่ได้ กันเพิ่มเงินซ้ำ)
        `CREATE TABLE IF NOT EXISTS ledger (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id       TEXT NOT NULL,
            delta         INTEGER NOT NULL,
            balance_after INTEGER NOT NULL,
            type          TEXT NOT NULL,
            ref           TEXT UNIQUE,
            note          TEXT,
            actor         TEXT,
            created_at    INTEGER NOT NULL
        )`,
        `CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger (user_id, id DESC)`,
        `CREATE TABLE IF NOT EXISTS orders (
            id         TEXT PRIMARY KEY,
            user_id    TEXT,
            data       TEXT NOT NULL,
            created_at INTEGER NOT NULL
        )`,
        `CREATE INDEX IF NOT EXISTS idx_orders_user ON orders (user_id, created_at DESC)`,
        // แพ็กเกจและราคา (แก้ได้จากหน้า Admin) ราคาในตารางนี้คือ "ราคาปกติ" ก่อนลด Reseller
        `CREATE TABLE IF NOT EXISTS packages (
            id     INTEGER PRIMARY KEY AUTOINCREMENT,
            game   TEXT NOT NULL,
            name   TEXT NOT NULL,
            qty    INTEGER NOT NULL CHECK (qty > 0),
            price  INTEGER NOT NULL CHECK (price > 0),
            note   TEXT,
            tag    TEXT,
            sort   INTEGER NOT NULL DEFAULT 0,
            active INTEGER NOT NULL DEFAULT 1,
            UNIQUE (game, name)
        )`,
        // บันทึกการกระทำของแอดมินในหน้าเว็บ
        `CREATE TABLE IF NOT EXISTS admin_log (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            actor      TEXT NOT NULL,
            action     TEXT NOT NULL,
            detail     TEXT,
            created_at INTEGER NOT NULL
        )`
    ], 'write');
    // ยศผู้ใช้: member | reseller | admin (ตารางเดิมที่สร้างไว้ก่อนหน้าไม่มีคอลัมน์นี้ จึงเพิ่มให้)
    try {
        await db.execute("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member'");
    } catch (e) {
        if (!/duplicate column/i.test(String(e.message))) throw e;
    }
}

// ---------- users ----------
async function upsertUser({ id, name, avatar }) {
    const now = Date.now();
    await db.execute({
        sql: `INSERT INTO users (discord_id, name, avatar, points, created_at, last_login)
              VALUES (?, ?, ?, 0, ?, ?)
              ON CONFLICT(discord_id) DO UPDATE SET name = excluded.name, avatar = excluded.avatar, last_login = excluded.last_login`,
        args: [id, name, avatar || null, now, now]
    });
    return getUser(id);
}

async function getUser(id) {
    const r = await db.execute({ sql: 'SELECT discord_id, name, avatar, points, role FROM users WHERE discord_id = ?', args: [id] });
    if (!r.rows.length) return null;
    const u = r.rows[0];
    return { id: String(u.discord_id), name: String(u.name), avatar: u.avatar ? String(u.avatar) : null, points: Number(u.points), role: u.role ? String(u.role) : 'member' };
}

// ---------- points (ทำใน transaction เดียว: เช็กซ้ำ -> ปรับยอด -> บันทึก ledger) ----------
// คืนค่า { balance } เมื่อสำเร็จ | { duplicate: true } ถ้า ref นี้เคยทำแล้ว | { insufficient: true } ถ้ายอดไม่พอ
async function adjustPoints(userId, delta, type, ref, note, actor) {
    if (!Number.isInteger(delta) || delta === 0) throw new Error('delta ต้องเป็นจำนวนเต็มที่ไม่ใช่ 0');
    const tx = await db.transaction('write');
    try {
        if (ref) {
            const dup = await tx.execute({ sql: 'SELECT 1 FROM ledger WHERE ref = ?', args: [ref] });
            if (dup.rows.length) { await tx.rollback(); return { duplicate: true }; }
        }
        const r = await tx.execute({ sql: 'SELECT points FROM users WHERE discord_id = ?', args: [userId] });
        if (!r.rows.length) throw new Error('ไม่พบผู้ใช้ ' + userId);
        const balance = Number(r.rows[0].points) + delta;
        if (balance < 0) { await tx.rollback(); return { insufficient: true }; }
        await tx.execute({ sql: 'UPDATE users SET points = ? WHERE discord_id = ?', args: [balance, userId] });
        await tx.execute({
            sql: 'INSERT INTO ledger (user_id, delta, balance_after, type, ref, note, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            args: [userId, delta, balance, type, ref || null, note || null, actor || null, Date.now()]
        });
        await tx.commit();
        return { balance };
    } catch (e) {
        try { await tx.rollback(); } catch (_) { /* ปิดไปแล้ว */ }
        throw e;
    } finally {
        tx.close();
    }
}

async function getLedger(userId, limit = 50) {
    const r = await db.execute({
        sql: 'SELECT delta, balance_after, type, note, created_at FROM ledger WHERE user_id = ? ORDER BY id DESC LIMIT ?',
        args: [userId, limit]
    });
    return r.rows.map(x => ({ delta: Number(x.delta), balanceAfter: Number(x.balance_after), type: String(x.type), note: x.note ? String(x.note) : '', createdAt: Number(x.created_at) }));
}

// ---------- orders (เก็บเป็น JSON ทั้งก้อน; เซิร์ฟเวอร์โหลดเข้าหน่วยความจำตอนเริ่ม) ----------
async function loadOrders() {
    const r = await db.execute('SELECT id, data FROM orders');
    const out = {};
    for (const row of r.rows) {
        try { out[String(row.id)] = JSON.parse(String(row.data)); } catch (e) { console.error('อ่านออเดอร์เสียหาย', row.id); }
    }
    return out;
}

async function saveOrder(o) {
    await db.execute({
        sql: `INSERT INTO orders (id, user_id, data, created_at) VALUES (?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET data = excluded.data, user_id = excluded.user_id`,
        args: [o.id, o.userId || null, JSON.stringify(o), o.createdAt]
    });
}

async function deleteOrder(id) {
    await db.execute({ sql: 'DELETE FROM orders WHERE id = ?', args: [id] });
}

// ---------- ผู้ใช้ (หน้า Admin) ----------
const ROLES = ['member', 'reseller', 'admin'];

async function listUsers(q, limit = 50) {
    const like = '%' + String(q || '').replace(/[\\%_]/g, m => '\\' + m) + '%';
    const r = await db.execute({
        sql: `SELECT discord_id, name, avatar, points, role, last_login FROM users
              WHERE name LIKE ? ESCAPE '\\' OR discord_id LIKE ? ESCAPE '\\'
              ORDER BY last_login DESC LIMIT ?`,
        args: [like, like, limit]
    });
    return r.rows.map(u => ({ id: String(u.discord_id), name: String(u.name), avatar: u.avatar ? String(u.avatar) : null, points: Number(u.points), role: u.role ? String(u.role) : 'member', lastLogin: Number(u.last_login) }));
}

async function setRole(id, role) {
    if (!ROLES.includes(role)) throw new Error('ยศไม่ถูกต้อง');
    const r = await db.execute({ sql: 'UPDATE users SET role = ? WHERE discord_id = ?', args: [role, id] });
    return r.rowsAffected > 0;
}

// ---------- แพ็กเกจ ----------
const pkgRow = (x) => ({ id: Number(x.id), game: String(x.game), name: String(x.name), qty: Number(x.qty), price: Number(x.price), note: x.note ? String(x.note) : '', tag: x.tag ? String(x.tag) : '', sort: Number(x.sort), active: Number(x.active) === 1 });

async function listPackages() {
    const r = await db.execute('SELECT id, game, name, qty, price, note, tag, sort, active FROM packages ORDER BY game, sort, id');
    return r.rows.map(pkgRow);
}

// ใส่แพ็กเกจตั้งต้นเฉพาะตอนตารางยังว่าง (ครั้งแรกที่รัน)
async function seedPackages(list) {
    const c = await db.execute('SELECT COUNT(*) AS n FROM packages');
    if (Number(c.rows[0].n) > 0) return 0;
    await db.batch(list.map(p => ({
        sql: 'INSERT INTO packages (game, name, qty, price, note, tag, sort, active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
        args: [p.game, p.name, p.qty, p.price, p.note || null, p.tag || null, p.sort]
    })), 'write');
    return list.length;
}

async function savePackage(p) {
    const args = [p.game, p.name, p.qty, p.price, p.note || null, p.tag || null, p.sort, p.active ? 1 : 0];
    if (p.id) {
        await db.execute({ sql: 'UPDATE packages SET game=?, name=?, qty=?, price=?, note=?, tag=?, sort=?, active=? WHERE id=?', args: [...args, p.id] });
    } else {
        await db.execute({ sql: 'INSERT INTO packages (game, name, qty, price, note, tag, sort, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', args });
    }
}

async function deletePackage(id) {
    await db.execute({ sql: 'DELETE FROM packages WHERE id = ?', args: [id] });
}

// ---------- บันทึกแอดมิน ----------
async function logAdmin(actor, action, detail) {
    await db.execute({ sql: 'INSERT INTO admin_log (actor, action, detail, created_at) VALUES (?, ?, ?, ?)', args: [String(actor), action, detail || null, Date.now()] });
}

async function getAdminLog(limit = 50) {
    const r = await db.execute({ sql: 'SELECT actor, action, detail, created_at FROM admin_log ORDER BY id DESC LIMIT ?', args: [limit] });
    return r.rows.map(x => ({ actor: String(x.actor), action: String(x.action), detail: x.detail ? String(x.detail) : '', createdAt: Number(x.created_at) }));
}

module.exports = {
    ROLES, listUsers, setRole, listPackages, seedPackages, savePackage, deletePackage, logAdmin, getAdminLog, initDb, upsertUser, getUser, adjustPoints, getLedger, loadOrders, saveOrder, deleteOrder };
