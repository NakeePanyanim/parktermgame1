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
        `CREATE INDEX IF NOT EXISTS idx_orders_user ON orders (user_id, created_at DESC)`
    ], 'write');
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
    const r = await db.execute({ sql: 'SELECT discord_id, name, avatar, points FROM users WHERE discord_id = ?', args: [id] });
    if (!r.rows.length) return null;
    const u = r.rows[0];
    return { id: String(u.discord_id), name: String(u.name), avatar: u.avatar ? String(u.avatar) : null, points: Number(u.points) };
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

module.exports = { initDb, upsertUser, getUser, adjustPoints, getLedger, loadOrders, saveOrder, deleteOrder };
