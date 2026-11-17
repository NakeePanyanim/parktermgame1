// db.js - ฐานข้อมูล Turso (libSQL = SQLite บนคลาวด์)
// ถ้าไม่ได้ตั้ง TURSO_DATABASE_URL จะใช้ไฟล์ local.db ในเครื่อง (สำหรับทดสอบบนคอมตัวเอง)
const { createClient } = require('@libsql/client');
const crypto = require('crypto');

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
        // โค้ดส่วนลด: type = percent (ลดเป็น %) | fixed (ลดเป็นบาท), max_uses = จำนวนครั้งที่ใช้ได้ทั้งหมด (0 = ไม่จำกัด)
        `CREATE TABLE IF NOT EXISTS discount_codes (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            code       TEXT NOT NULL UNIQUE,
            type       TEXT NOT NULL CHECK (type IN ('percent', 'fixed')),
            value      INTEGER NOT NULL CHECK (value > 0),
            max_uses   INTEGER NOT NULL DEFAULT 0 CHECK (max_uses >= 0),
            active     INTEGER NOT NULL DEFAULT 1,
            note       TEXT,
            created_at INTEGER NOT NULL
        )`,
        // การใช้โค้ด 1 แถว = 1 ออเดอร์ (released = 1 เมื่อออเดอร์ถูกยกเลิก สิทธิ์จะคืนให้)
        `CREATE TABLE IF NOT EXISTS code_uses (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            code_id    INTEGER NOT NULL,
            user_id    TEXT,
            order_id   TEXT NOT NULL UNIQUE,
            created_at INTEGER NOT NULL,
            released   INTEGER NOT NULL DEFAULT 0
        )`,
        `CREATE INDEX IF NOT EXISTS idx_code_uses_code ON code_uses (code_id, released)`,
        // บันทึกการกระทำของแอดมินในหน้าเว็บ
        // ตั้งค่าที่แอดมินแก้ได้จากหน้าเว็บ (เช่น ส่วนลด Reseller %)
        `CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )`,
        // ใบสมัคร Partner/Reseller: status = pending | accepted | rejected
        `CREATE TABLE IF NOT EXISTS partner_applications (
            id            TEXT PRIMARY KEY,
            user_id       TEXT NOT NULL,
            shop_name     TEXT NOT NULL,
            shop_type     TEXT NOT NULL,
            shop_link     TEXT NOT NULL,
            monthly_sales INTEGER NOT NULL,
            contact       TEXT NOT NULL,
            status        TEXT NOT NULL DEFAULT 'pending',
            handled_by    TEXT,
            message_id    TEXT,
            created_at    INTEGER NOT NULL,
            updated_at    INTEGER NOT NULL
        )`,
        `CREATE INDEX IF NOT EXISTS idx_partner_user ON partner_applications (user_id, created_at DESC)`,
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_partner_one_pending ON partner_applications (user_id) WHERE status = 'pending'`,
        // บันทึก EXP ทุกครั้ง (ref ซ้ำไม่ได้ = ออเดอร์เดียวให้ EXP ได้ครั้งเดียว)
        `CREATE TABLE IF NOT EXISTS exp_log (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id   TEXT NOT NULL,
            delta     INTEGER NOT NULL,
            exp_after INTEGER NOT NULL,
            ref       TEXT UNIQUE,
            note      TEXT,
            actor     TEXT,
            created_at INTEGER NOT NULL
        )`,
        // รางวัลเลเวลที่รับไปแล้ว: seq = รางวัลลำดับที่ (1 = ครั้งแรก) UNIQUE กันรับซ้ำ, code_id = โค้ดส่วนลดที่สร้างให้
        `CREATE TABLE IF NOT EXISTS level_rewards (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id    TEXT NOT NULL,
            seq        INTEGER NOT NULL,
            code_id    INTEGER NOT NULL,
            code       TEXT NOT NULL,
            value      INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE (user_id, seq)
        )`,
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
    // EXP สะสมของผู้ใช้ (เลเวลคำนวณจาก EXP ตามค่าที่แอดมินตั้ง ไม่เก็บเลเวลตรงๆ)
    try {
        await db.execute('ALTER TABLE users ADD COLUMN exp INTEGER NOT NULL DEFAULT 0');
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
    const r = await db.execute({ sql: 'SELECT discord_id, name, avatar, points, role, exp FROM users WHERE discord_id = ?', args: [id] });
    if (!r.rows.length) return null;
    const u = r.rows[0];
    return { id: String(u.discord_id), name: String(u.name), avatar: u.avatar ? String(u.avatar) : null, points: Number(u.points), role: u.role ? String(u.role) : 'member', exp: Number(u.exp || 0) };
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
        sql: `SELECT discord_id, name, avatar, points, role, exp, last_login FROM users
              WHERE name LIKE ? ESCAPE '\\' OR discord_id LIKE ? ESCAPE '\\'
              ORDER BY last_login DESC LIMIT ?`,
        args: [like, like, limit]
    });
    return r.rows.map(u => ({ id: String(u.discord_id), name: String(u.name), avatar: u.avatar ? String(u.avatar) : null, points: Number(u.points), role: u.role ? String(u.role) : 'member', exp: Number(u.exp || 0), lastLogin: Number(u.last_login) }));
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

// ---------- โค้ดส่วนลด ----------
const codeRow = (x) => ({ id: Number(x.id), code: String(x.code), type: String(x.type), value: Number(x.value), maxUses: Number(x.max_uses), active: Number(x.active) === 1, note: x.note ? String(x.note) : '', createdAt: Number(x.created_at), used: Number(x.used || 0) });
const CODE_SELECT = `SELECT c.*, (SELECT COUNT(*) FROM code_uses u WHERE u.code_id = c.id AND u.released = 0) AS used FROM discount_codes c`;

async function listCodes() {
    const r = await db.execute(CODE_SELECT + ' WHERE c.id NOT IN (SELECT code_id FROM level_rewards) ORDER BY c.id DESC');
    return r.rows.map(codeRow);
}

async function getCodeByCode(code) {
    const r = await db.execute({ sql: CODE_SELECT + ' WHERE c.code = ?', args: [code] });
    return r.rows.length ? codeRow(r.rows[0]) : null;
}

// เคยใช้โค้ดนี้แล้วหรือยัง (นับเฉพาะที่ยังไม่ถูกคืนสิทธิ์)
async function userUsedCode(codeId, userId) {
    if (!userId) return false;
    const r = await db.execute({ sql: 'SELECT 1 FROM code_uses WHERE code_id = ? AND user_id = ? AND released = 0 LIMIT 1', args: [codeId, userId] });
    return r.rows.length > 0;
}

async function createCode(c) {
    await db.execute({
        sql: 'INSERT INTO discount_codes (code, type, value, max_uses, active, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        args: [c.code, c.type, c.value, c.maxUses, c.active ? 1 : 0, c.note || null, Date.now()]
    });
}

async function updateCode(id, c) {
    await db.execute({
        sql: 'UPDATE discount_codes SET type = ?, value = ?, max_uses = ?, active = ?, note = ? WHERE id = ?',
        args: [c.type, c.value, c.maxUses, c.active ? 1 : 0, c.note || null, id]
    });
}

async function deleteCode(id) {
    await db.batch([
        { sql: 'DELETE FROM code_uses WHERE code_id = ?', args: [id] },
        { sql: 'DELETE FROM discount_codes WHERE id = ?', args: [id] }
    ], 'write');
}

// จองสิทธิ์ใช้โค้ดแบบ atomic (กันคนกดพร้อมกันจนเกินจำนวน)
// คืนค่า { ok: true, used } | { error: 'inactive' | 'full' | 'already' }
async function redeemCode(codeId, userId, orderId) {
    const tx = await db.transaction('write');
    try {
        const c = await tx.execute({ sql: 'SELECT max_uses, active FROM discount_codes WHERE id = ?', args: [codeId] });
        if (!c.rows.length || Number(c.rows[0].active) !== 1) { await tx.rollback(); return { error: 'inactive' }; }
        const used = Number((await tx.execute({ sql: 'SELECT COUNT(*) AS n FROM code_uses WHERE code_id = ? AND released = 0', args: [codeId] })).rows[0].n);
        const max = Number(c.rows[0].max_uses);
        if (max > 0 && used >= max) { await tx.rollback(); return { error: 'full' }; }
        if (userId) {
            const mine = await tx.execute({ sql: 'SELECT 1 FROM code_uses WHERE code_id = ? AND user_id = ? AND released = 0 LIMIT 1', args: [codeId, userId] });
            if (mine.rows.length) { await tx.rollback(); return { error: 'already' }; }
        }
        await tx.execute({ sql: 'INSERT INTO code_uses (code_id, user_id, order_id, created_at) VALUES (?, ?, ?, ?)', args: [codeId, userId || null, orderId, Date.now()] });
        await tx.commit();
        return { ok: true, used: used + 1 };
    } catch (e) {
        try { await tx.rollback(); } catch (_) { /* ปิดไปแล้ว */ }
        throw e;
    } finally {
        tx.close();
    }
}

// คืนสิทธิ์ (ออเดอร์ถูกยกเลิก หรือส่งเข้า Discord ไม่สำเร็จ)
async function releaseCodeUse(orderId) {
    const r = await db.execute({ sql: 'UPDATE code_uses SET released = 1 WHERE order_id = ? AND released = 0', args: [orderId] });
    return r.rowsAffected > 0;
}

async function listCodeUses(codeId, limit = 30) {
    const r = await db.execute({
        sql: `SELECT u.order_id, u.user_id, u.created_at, u.released, s.name FROM code_uses u
              LEFT JOIN users s ON s.discord_id = u.user_id WHERE u.code_id = ? ORDER BY u.id DESC LIMIT ?`,
        args: [codeId, limit]
    });
    return r.rows.map(x => ({ orderId: String(x.order_id), userId: x.user_id ? String(x.user_id) : '', userName: x.name ? String(x.name) : '', createdAt: Number(x.created_at), released: Number(x.released) === 1 }));
}

// ---------- EXP / Level ----------
// บวก/ลบ EXP ใน transaction เดียว (EXP ไม่ติดลบ) ref ซ้ำ = เคยให้แล้ว
// คืนค่า { exp, delta } | { duplicate: true } | { notFound: true }
async function addExp(userId, delta, ref, note, actor) {
    if (!Number.isInteger(delta) || delta === 0) throw new Error('delta ต้องเป็นจำนวนเต็มที่ไม่ใช่ 0');
    const tx = await db.transaction('write');
    try {
        if (ref) {
            const dup = await tx.execute({ sql: 'SELECT 1 FROM exp_log WHERE ref = ?', args: [ref] });
            if (dup.rows.length) { await tx.rollback(); return { duplicate: true }; }
        }
        const r = await tx.execute({ sql: 'SELECT exp FROM users WHERE discord_id = ?', args: [userId] });
        if (!r.rows.length) { await tx.rollback(); return { notFound: true }; }
        const cur = Number(r.rows[0].exp || 0);
        const next = Math.max(0, cur + delta);
        const real = next - cur;
        await tx.execute({ sql: 'UPDATE users SET exp = ? WHERE discord_id = ?', args: [next, userId] });
        await tx.execute({
            sql: 'INSERT INTO exp_log (user_id, delta, exp_after, ref, note, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            args: [userId, real, next, ref || null, note || null, actor || null, Date.now()]
        });
        await tx.commit();
        return { exp: next, delta: real };
    } catch (e) {
        try { await tx.rollback(); } catch (_) { /* ปิดไปแล้ว */ }
        throw e;
    } finally {
        tx.close();
    }
}

// ยกเลิก EXP ที่เคยให้จากออเดอร์ (เช่น แอดมินกด "ยอดไม่ครบ" หลังรับเงิน) ทำได้ครั้งเดียวต่อออเดอร์
async function revokeExp(userId, ref) {
    const tx = await db.transaction('write');
    try {
        const orig = await tx.execute({ sql: 'SELECT delta FROM exp_log WHERE ref = ?', args: [ref] });
        if (!orig.rows.length) { await tx.rollback(); return { none: true }; }
        const dup = await tx.execute({ sql: 'SELECT 1 FROM exp_log WHERE ref = ?', args: [ref + ':revoke'] });
        if (dup.rows.length) { await tx.rollback(); return { duplicate: true }; }
        const r = await tx.execute({ sql: 'SELECT exp FROM users WHERE discord_id = ?', args: [userId] });
        if (!r.rows.length) { await tx.rollback(); return { none: true }; }
        const cur = Number(r.rows[0].exp || 0);
        const next = Math.max(0, cur - Number(orig.rows[0].delta));
        await tx.execute({ sql: 'UPDATE users SET exp = ? WHERE discord_id = ?', args: [next, userId] });
        await tx.execute({
            sql: 'INSERT INTO exp_log (user_id, delta, exp_after, ref, note, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            args: [userId, next - cur, next, ref + ':revoke', 'ยกเลิก EXP (ออเดอร์ถูกยกเลิก)', null, Date.now()]
        });
        await tx.commit();
        return { exp: next };
    } catch (e) {
        try { await tx.rollback(); } catch (_) { /* ปิดไปแล้ว */ }
        throw e;
    } finally {
        tx.close();
    }
}

// โค้ด 6 หลัก A-Z/0-9 (ตัดตัวที่ดูคล้ายกัน 0 O 1 I L ออก)
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const genCode6 = () => Array.from({ length: 6 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');

async function countRewards(userId) {
    const r = await db.execute({ sql: 'SELECT COUNT(*) AS n FROM level_rewards WHERE user_id = ?', args: [userId] });
    return Number(r.rows[0].n);
}

async function listLevelRewards(userId, limit = 20) {
    const r = await db.execute({
        sql: `SELECT r.seq, r.code, r.value, r.created_at,
                     (SELECT COUNT(*) FROM code_uses u WHERE u.code_id = r.code_id AND u.released = 0) AS used
              FROM level_rewards r WHERE r.user_id = ? ORDER BY r.seq DESC LIMIT ?`,
        args: [userId, limit]
    });
    return r.rows.map(x => ({ seq: Number(x.seq), code: String(x.code), value: Number(x.value), createdAt: Number(x.created_at), used: Number(x.used) > 0 }));
}

// รับรางวัลเลเวล: ถ้ามีรางวัลที่ถึงเกณฑ์แต่ยังไม่ได้รับ -> สร้างโค้ดลด (fixed) ใช้ได้ 1 ครั้ง แล้วบันทึกว่ารับแล้ว (ทั้งหมดใน transaction เดียว กันกดซ้ำ/กดพร้อมกัน)
// cfg = { levelOf(exp), every, value } คืนค่า { ok, code, value, rewardLevel, remaining } | { none: true }
async function claimLevelReward(userId, cfg) {
    const tx = await db.transaction('write');
    try {
        const u = await tx.execute({ sql: 'SELECT exp FROM users WHERE discord_id = ?', args: [userId] });
        if (!u.rows.length) { await tx.rollback(); return { notFound: true }; }
        const level = cfg.levelOf(Number(u.rows[0].exp || 0));
        const earned = Math.floor(level / cfg.every);
        const claimed = Number((await tx.execute({ sql: 'SELECT COUNT(*) AS n FROM level_rewards WHERE user_id = ?', args: [userId] })).rows[0].n);
        if (earned <= claimed) { await tx.rollback(); return { none: true }; }
        let code = null;
        for (let i = 0; i < 30 && !code; i++) {
            const c = genCode6();
            const ex = await tx.execute({ sql: 'SELECT 1 FROM discount_codes WHERE code = ?', args: [c] });
            if (!ex.rows.length) code = c;
        }
        if (!code) throw new Error('สร้างโค้ดไม่สำเร็จ');
        const seq = claimed + 1, rewardLevel = seq * cfg.every, now = Date.now();
        const ins = await tx.execute({
            sql: "INSERT INTO discount_codes (code, type, value, max_uses, active, note, created_at) VALUES (?, 'fixed', ?, 1, 1, ?, ?)",
            args: [code, cfg.value, `Level Reward Lv.${rewardLevel} (${userId})`, now]
        });
        await tx.execute({
            sql: 'INSERT INTO level_rewards (user_id, seq, code_id, code, value, created_at) VALUES (?, ?, ?, ?, ?, ?)',
            args: [userId, seq, Number(ins.lastInsertRowid), code, cfg.value, now]
        });
        await tx.commit();
        return { ok: true, code, value: cfg.value, rewardLevel, remaining: earned - seq };
    } catch (e) {
        try { await tx.rollback(); } catch (_) { /* ปิดไปแล้ว */ }
        throw e;
    } finally {
        tx.close();
    }
}

// ---------- อันดับ (Leaderboard) ----------
async function getUsersByIds(ids) {
    if (!ids.length) return [];
    const r = await db.execute({ sql: `SELECT discord_id, name, avatar, role, exp FROM users WHERE discord_id IN (${ids.map(() => '?').join(',')})`, args: ids });
    return r.rows.map(u => ({ id: String(u.discord_id), name: String(u.name), avatar: u.avatar ? String(u.avatar) : null, role: u.role ? String(u.role) : 'member', exp: Number(u.exp || 0) }));
}

// อันดับ EXP: since = 0 -> EXP สะสมทั้งหมด | since > 0 -> EXP ที่ได้ตั้งแต่เวลานั้น (รวมบวก/ลบจากสมุด exp_log)
async function topExp(since, limit) {
    const r = since
        ? await db.execute({
            sql: `SELECT u.discord_id, u.name, u.avatar, u.role, u.exp, SUM(l.delta) AS gained
                  FROM exp_log l JOIN users u ON u.discord_id = l.user_id
                  WHERE l.created_at >= ? GROUP BY l.user_id HAVING gained > 0 ORDER BY gained DESC LIMIT ?`,
            args: [since, limit]
        })
        : await db.execute({ sql: 'SELECT discord_id, name, avatar, role, exp, exp AS gained FROM users WHERE exp > 0 ORDER BY exp DESC LIMIT ?', args: [limit] });
    return r.rows.map(u => ({ id: String(u.discord_id), name: String(u.name), avatar: u.avatar ? String(u.avatar) : null, role: u.role ? String(u.role) : 'member', exp: Number(u.exp || 0), gained: Number(u.gained || 0) }));
}

// ---------- ตั้งค่า (settings) ----------
async function getSetting(key) {
    const r = await db.execute({ sql: 'SELECT value FROM settings WHERE key = ?', args: [key] });
    return r.rows.length ? String(r.rows[0].value) : null;
}

async function setSetting(key, value) {
    await db.execute({
        sql: 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        args: [key, String(value)]
    });
}

// ---------- ใบสมัคร Partner/Reseller ----------
const appRow = (x) => ({
    id: String(x.id), userId: String(x.user_id), shopName: String(x.shop_name), shopType: String(x.shop_type),
    shopLink: String(x.shop_link), monthlySales: Number(x.monthly_sales), contact: String(x.contact),
    status: String(x.status), handledBy: x.handled_by ? String(x.handled_by) : '', messageId: x.message_id ? String(x.message_id) : '',
    createdAt: Number(x.created_at), updatedAt: Number(x.updated_at)
});

async function createPartnerApp(a) {
    const now = Date.now();
    await db.execute({
        sql: `INSERT INTO partner_applications (id, user_id, shop_name, shop_type, shop_link, monthly_sales, contact, status, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        args: [a.id, a.userId, a.shopName, a.shopType, a.shopLink, a.monthlySales, a.contact, now, now]
    });
}

async function getPartnerApp(id) {
    const r = await db.execute({ sql: 'SELECT * FROM partner_applications WHERE id = ?', args: [id] });
    return r.rows.length ? appRow(r.rows[0]) : null;
}

// ใบสมัครล่าสุดของผู้ใช้ (ใช้โชว์สถานะให้ลูกค้า + กันสมัครซ้อน)
async function getLatestPartnerApp(userId) {
    const r = await db.execute({ sql: 'SELECT * FROM partner_applications WHERE user_id = ? ORDER BY created_at DESC LIMIT 1', args: [userId] });
    return r.rows.length ? appRow(r.rows[0]) : null;
}

async function setPartnerAppMessage(id, messageId) {
    await db.execute({ sql: 'UPDATE partner_applications SET message_id = ? WHERE id = ?', args: [messageId, id] });
}

async function deletePartnerApp(id) {
    await db.execute({ sql: 'DELETE FROM partner_applications WHERE id = ?', args: [id] });
}

// ตัดสินใบสมัครแบบ atomic: เปลี่ยนสถานะได้เฉพาะใบที่ยัง pending (กันสองคนกดพร้อมกัน)
// ถ้ารับ (accepted) จะตั้งยศ reseller ให้ทันที (เฉพาะคนที่ยังเป็น member ไม่ลดยศแอดมิน)
// คืนค่า { ok: true } | { already: true } ถ้าใบนี้ถูกตัดสินไปแล้ว | { notFound: true }
async function decidePartnerApp(id, status, handler) {
    if (!['accepted', 'rejected'].includes(status)) throw new Error('สถานะไม่ถูกต้อง');
    const tx = await db.transaction('write');
    try {
        const r = await tx.execute({ sql: 'SELECT user_id, status FROM partner_applications WHERE id = ?', args: [id] });
        if (!r.rows.length) { await tx.rollback(); return { notFound: true }; }
        if (String(r.rows[0].status) !== 'pending') { await tx.rollback(); return { already: true }; }
        await tx.execute({ sql: 'UPDATE partner_applications SET status = ?, handled_by = ?, updated_at = ? WHERE id = ?', args: [status, handler || null, Date.now(), id] });
        if (status === 'accepted') {
            await tx.execute({ sql: "UPDATE users SET role = 'reseller' WHERE discord_id = ? AND role = 'member'", args: [String(r.rows[0].user_id)] });
        }
        await tx.commit();
        return { ok: true };
    } catch (e) {
        try { await tx.rollback(); } catch (_) { /* ปิดไปแล้ว */ }
        throw e;
    } finally {
        tx.close();
    }
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
    listCodes, getCodeByCode, userUsedCode, createCode, updateCode, deleteCode, redeemCode, releaseCodeUse, listCodeUses,
    getUsersByIds, topExp,
    addExp, revokeExp, countRewards, listLevelRewards, claimLevelReward,
    getSetting, setSetting, createPartnerApp, getPartnerApp, getLatestPartnerApp, setPartnerAppMessage, deletePartnerApp, decidePartnerApp,
    ROLES, listUsers, setRole, listPackages, seedPackages, savePackage, deletePackage, logAdmin, getAdminLog, initDb, upsertUser, getUser, adjustPoints, getLedger, loadOrders, saveOrder, deleteOrder };
