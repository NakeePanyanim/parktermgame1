require('dotenv').config();
const express = require('express');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const {
    Client, GatewayIntentBits, Events, MessageFlags,
    ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder
} = require('discord.js');

// ================= ตั้งค่า (อ่านจากไฟล์ .env) =================
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
// (ไม่บังคับ) ไอดี Discord ของคนที่กดปุ่มได้ คั่นด้วยคอมมา ถ้าไม่ใส่ = ใครเห็นช่องก็กดได้
const ADMIN_IDS = (process.env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const PORT = process.env.PORT || 3000;
// ---- ระบบล็อกอิน Discord (ไม่ตั้งค่า = ปิดระบบล็อกอิน เว็บยังเติมผ่านซองได้ตามปกติ) ----
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const SESSION_SECRET = process.env.SESSION_SECRET;
const BASE_URL = (process.env.BASE_URL || '').replace(/\/+$/, ''); // เช่น https://ชื่อเว็บ.onrender.com
const AUTH_ON = !!(DISCORD_CLIENT_ID && DISCORD_CLIENT_SECRET && SESSION_SECRET && BASE_URL);
const REDIRECT_URI = BASE_URL + '/auth/discord/callback';
const IS_HTTPS = BASE_URL.startsWith('https://');

if (!BOT_TOKEN || !CHANNEL_ID) {
    console.error('ไม่พบ DISCORD_BOT_TOKEN หรือ DISCORD_CHANNEL_ID ในไฟล์ .env');
    process.exit(1);
}

// ราคาแพ็กเกจและฟิลด์ของแต่ละเกมอยู่ฝั่งเซิร์ฟเวอร์เท่านั้น (ชื่อแพ็กเกจต้องตรงกับที่หน้าเว็บส่งมา)
// จะเพิ่มเกมใหม่ แค่เพิ่ม block ในนี้ + เพิ่มในหน้าเว็บ (GAMES ใน index.html)
const ROBLOX_USER_RE = /^[A-Za-z0-9_]{3,20}$/;
const GAMES = {
    opm: {
        name: 'One Punch Man',
        fields: [
            { key: 'uid', max: 50 },
            { key: 'sid', max: 20 },
            { key: 'ign', max: 100 }
        ],
        packages: {
            '1 คูปอง': 10,
            '6 คูปอง': 22,
            '14 คูปอง': 49,
            '35 คูปอง': 110,
            '70 คูปอง': 220,
            '105 คูปอง': 322,
            '210 คูปอง (105*2)': 642,
            '350 คูปอง': 1102,
            '560 คูปอง': 1711,
            '700 คูปอง': 2030
        }
    },
    roblox: {
        name: 'Roblox',
        fields: [
            { key: 'username', max: 30, norm: (v) => v.replace(/^@/, ''), test: (v) => ROBLOX_USER_RE.test(v), error: 'Username ไม่ถูกต้อง (ใช้ได้เฉพาะ A-Z ตัวเลข และ _ ความยาว 3-20 ตัว)' },
            { key: 'displayName', max: 50 }
        ],
        packages: {
            '100 Robux': 40,
            '200 Robux': 75,
            '300 Robux': 99,
            '400 Robux': 135,
            '500 Robux': 169,
            '600 Robux': 199,
            '700 Robux': 235,
            '800 Robux': 269,
            '900 Robux': 299,
            '1000 Robux': 339,
            '1500 Robux': 459,
            '2000 Robux': 669,
            '5000 Robux': 1690
        }
    },
    // เติม Point เข้าบัญชี (1 Point = 1 บาท) ต้องล็อกอินก่อน
    points: {
        name: 'เติม Point',
        requireLogin: true,
        fields: [],
        packages: {},
        // กรอกจำนวนเองได้ (1 Point = 1 บาท) ราคา = จำนวนที่กรอก
        custom: { min: 10, max: 20000, label: (n) => `${n} Point` }
    }
};
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
// ================================================================

// ---------- ออเดอร์: เก็บใน Turso (โหลดเข้าหน่วยความจำตอนเริ่มเซิร์ฟเวอร์) ----------
const ORDERS_FILE = path.join(__dirname, 'orders.json'); // ไฟล์เก่า ใช้นำเข้าครั้งเดียว
let orders = {};
const saveOrder = (o) => db.saveOrder(o).catch(e => console.error('บันทึกออเดอร์ไม่สำเร็จ:', o.id, e.message));

async function importLegacyOrders() {
    if (!fs.existsSync(ORDERS_FILE)) return;
    try {
        const old = JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8'));
        let n = 0;
        for (const o of Object.values(old)) {
            if (o && o.id && !orders[o.id]) { orders[o.id] = o; await db.saveOrder(o); n++; }
        }
        fs.renameSync(ORDERS_FILE, ORDERS_FILE + '.imported');
        console.log(`นำเข้าออเดอร์จาก orders.json แล้ว ${n} รายการ`);
    } catch (e) {
        console.error('นำเข้า orders.json ไม่สำเร็จ (ข้ามไป):', e.message);
    }
}

const VOUCHER_RE = /^[A-Za-z0-9]{8,64}$/;
const ID_RE = /^[a-f0-9]{24}$/;
const voucherUrl = (code) => `https://gift.truemoney.com/campaign/?v=${code}`;

// รับเฉพาะลิงก์ gift.truemoney.com ที่มีรหัส v=...
function parseVoucher(link) {
    try {
        const u = new URL(link);
        if (u.hostname !== 'gift.truemoney.com') return null;
        const code = (u.searchParams.get('v') || '').trim();
        return VOUCHER_RE.test(code) ? code : null;
    } catch (e) {
        return null;
    }
}

const clean = (v, max) => String(v ?? '').trim().slice(0, max);
const code = (v) => '`' + String(v || '-').replace(/`/g, "'") + '`';
const isFinal = (s) => s === 'done' || s === 'insufficient';

// ---------- Discord bot ----------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const STATUS = {
    checking:     { color: 0xF59E0B, text: '🕑 รอตรวจสอบซอง' },
    received:     { color: 0x3B82F6, text: '💰 รับเงินแล้ว รอเติมตามคิว' },
    done:         { color: 0x57F287, text: '✅ เติมเสร็จสิ้น' },
    insufficient: { color: 0xED4245, text: '⚠️ ยอดเงินไม่เพียงพอ' }
};

function payText(o) {
    if (o.payMethod !== 'balance') return '🎟️ ลิงก์ซองอั่งเปา TrueMoney';
    if (o.refunded) return '👛 เงินในบัญชี (คืนเงินแล้ว ↩️)';
    if (o.paid) return '👛 เงินในบัญชี (หักเงินแล้ว ✅)';
    return '👛 **เงินในบัญชี** (ยังไม่หักเงิน จะหักเมื่อกด "รับเงิน")';
}

function buildMessage(o) {
    const s = STATUS[o.status];
    const gameKey = GAMES[o.game] ? o.game : 'opm'; // ออเดอร์เก่าที่ไม่มี game = One Punch Man
    const accountFields = gameKey === 'points'
        ? [{ name: '👤 บัญชีเว็บ (Discord)', value: `${code(o.userName)} ${code(o.userId)}`, inline: false }]
        : gameKey === 'roblox'
        ? [
            { name: '👤 Username', value: code(o.username), inline: true },
            { name: '🏷️ Display Name', value: code(o.displayName), inline: true }
        ]
        : [
            { name: '🎮 UID', value: code(o.uid), inline: true },
            { name: '🌐 Server ID', value: code(o.sid), inline: true },
            { name: '🧑 ชื่อในเกม', value: code(o.ign), inline: true }
        ];
    const embed = new EmbedBuilder()
        .setTitle(`🧾 ออเดอร์ #${o.id.slice(-6).toUpperCase()}`)
        .setColor(s.color)
        .addFields(
            { name: '📌 สถานะ', value: s.text, inline: false },
            { name: '🕹️ เกม', value: `**${GAMES[gameKey].name}**`, inline: false },
            ...accountFields,
            ...(o.userId && gameKey !== 'points' ? [{ name: '🔗 บัญชีเว็บ', value: `<@${o.userId}>`, inline: true }] : []),
            { name: '📘 Facebook', value: o.facebook || '-', inline: false },
            { name: '📦 แพ็กเกจ', value: o.packageName, inline: true },
            { name: '💰 ยอดที่ต้องได้รับ', value: `**${o.price.toLocaleString('en-US')} บาท**`, inline: true },
            { name: '💳 ชำระเงินด้วย', value: payText(o), inline: false }
        )
        .setFooter({ text: o.handledBy ? `ล่าสุดโดย ${o.handledBy}` : 'รอแอดมินดำเนินการ' })
        .setTimestamp(new Date(o.updatedAt));

    if (o.dupOf) {
        embed.addFields({ name: '⚠️ ลิงก์ซองซ้ำ', value: `ลิงก์นี้เคยถูกส่งมาแล้วในออเดอร์ #${o.dupOf.slice(-6).toUpperCase()} (ซองรับได้ครั้งเดียว)`, inline: false });
    }

    // แสดงลิงก์ซองเฉพาะตอนยังรอตรวจสอบ (หลังรับซองแล้วลิงก์ใช้ไม่ได้อยู่แล้ว)
    if (o.status === 'checking' && o.voucherCode) {
        embed.addFields({ name: '🎟️ ลิงก์ซอง', value: voucherUrl(o.voucherCode), inline: false });
    }

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`order:${o.id}:received`).setLabel('รับเงิน')
            .setStyle(ButtonStyle.Primary).setDisabled(o.status !== 'checking'),
        new ButtonBuilder().setCustomId(`order:${o.id}:done`).setLabel('เสร็จสิ้น')
            .setStyle(ButtonStyle.Success).setDisabled(isFinal(o.status)),
        new ButtonBuilder().setCustomId(`order:${o.id}:insufficient`).setLabel('ยอดไม่ครบ')
            .setStyle(ButtonStyle.Danger).setDisabled(isFinal(o.status))
    );
    if (o.status === 'checking' && o.voucherCode) {
        row.addComponents(
            new ButtonBuilder().setLabel('เปิดซอง').setStyle(ButtonStyle.Link).setURL(voucherUrl(o.voucherCode))
        );
    }

    return { embeds: [embed], components: [row], allowedMentions: { parse: [] } };
}

client.on(Events.InteractionCreate, async (interaction) => {
    try {
        if (!interaction.isButton()) return;
        const [prefix, id, action] = interaction.customId.split(':');
        if (prefix !== 'order') return;

        if (ADMIN_IDS.length && !ADMIN_IDS.includes(interaction.user.id)) {
            return interaction.reply({ content: 'คุณไม่มีสิทธิ์กดปุ่มนี้', flags: MessageFlags.Ephemeral });
        }

        const order = orders[id];
        if (!order) {
            return interaction.reply({ content: 'ไม่พบออเดอร์นี้ในระบบ', flags: MessageFlags.Ephemeral });
        }
        if (!['received', 'done', 'insufficient'].includes(action)) return;

        // ออเดอร์จบแล้ว หรือกด "รับเงิน" ซ้ำ -> แค่รีเฟรชข้อความ ไม่เปลี่ยนสถานะ
        if (isFinal(order.status) || (action === 'received' && order.status !== 'checking')) {
            return interaction.update(buildMessage(order));
        }

        const handler = interaction.user.globalName || interaction.user.username;

        // ออเดอร์เติม Point: "รับเงิน"/"เสร็จสิ้น" = บวก Point เข้าบัญชีลูกค้า (บวกได้ครั้งเดียวต่อออเดอร์)
        if (order.game === 'points' && action !== 'insufficient') {
            await interaction.deferUpdate();
            try {
                await db.adjustPoints(order.userId, order.price, 'topup', 'order:' + order.id,
                    `เติม Point ออเดอร์ #${order.id.slice(-6).toUpperCase()}`, handler);
            } catch (e) {
                console.error('บวก Point ไม่สำเร็จ:', e.message);
                return interaction.followUp({ content: 'เพิ่ม Point ไม่สำเร็จ (ยังไม่มีอะไรเปลี่ยน) กรุณากดใหม่อีกครั้ง', flags: MessageFlags.Ephemeral });
            }
            order.status = 'done';
            order.updatedAt = Date.now();
            order.handledBy = handler;
            await db.saveOrder(order).catch(e => console.error('บันทึกออเดอร์ไม่สำเร็จ:', e.message));
            return interaction.editReply(buildMessage(order));
        }

        // ออเดอร์จ่ายด้วยเงินในบัญชี: หักเงินตอนแอดมินกด "รับเงิน" (หรือ "เสร็จสิ้น" ถ้าข้ามขั้น) หักได้ครั้งเดียวต่อออเดอร์
        // กด "ยอดไม่ครบ" = ไม่หัก (ถ้าเคยหักไปแล้วจะคืนให้)
        if (order.payMethod === 'balance') {
            await interaction.deferUpdate();
            const tag = `#${order.id.slice(-6).toUpperCase()}`;
            try {
                if (action !== 'insufficient' && !order.paid) {
                    const r = await db.adjustPoints(order.userId, -order.price, 'purchase', `order:${order.id}:pay`,
                        `ซื้อ ${order.packageName} (${GAMES[order.game] ? GAMES[order.game].name : order.game}) ออเดอร์ ${tag}`, handler);
                    if (r.insufficient) {
                        return interaction.followUp({ content: `ยอดเงินในบัญชีลูกค้าไม่พอสำหรับออเดอร์ ${tag} (ยังไม่หักเงิน สถานะไม่เปลี่ยน) กด "ยอดไม่ครบ" เพื่อปิดออเดอร์ได้`, flags: MessageFlags.Ephemeral });
                    }
                    order.paid = true;
                } else if (action === 'insufficient' && order.paid && !order.refunded) {
                    await db.adjustPoints(order.userId, order.price, 'refund', `order:${order.id}:refund`,
                        `คืนเงินออเดอร์ ${tag} (ยกเลิกโดยแอดมิน)`, handler);
                    order.refunded = true;
                }
            } catch (e) {
                console.error('ปรับยอดเงินในบัญชีไม่สำเร็จ:', e.message);
                return interaction.followUp({ content: 'ปรับยอดเงินในบัญชีไม่สำเร็จ (สถานะไม่เปลี่ยน) กรุณากดใหม่อีกครั้ง', flags: MessageFlags.Ephemeral });
            }
            order.status = action;
            order.updatedAt = Date.now();
            order.handledBy = handler;
            await db.saveOrder(order).catch(e => console.error('บันทึกออเดอร์ไม่สำเร็จ:', e.message));
            return interaction.editReply(buildMessage(order));
        }

        order.status = action;
        order.updatedAt = Date.now();
        order.handledBy = handler;
        saveOrder(order);
        await interaction.update(buildMessage(order));
    } catch (e) {
        console.error('จัดการปุ่ม Discord ไม่สำเร็จ:', e.message);
    }
});
client.on(Events.Error, (e) => console.error('Discord error:', e.message));

// ---------- เว็บเซิร์ฟเวอร์ ----------
const app = express();
// ถ้าอยู่หลัง proxy (Cloudflare, nginx ฯลฯ) ให้เปิดบรรทัดนี้ เพื่อให้ rate limit เห็น IP จริง
// app.set('trust proxy', 1);
app.use(express.json({ limit: '10kb' }));
app.use(express.static('public'));

const topupLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 15,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'ส่งคำขอบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่' }
});
const statusLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'ตรวจสอบสถานะบ่อยเกินไป กรุณารอสักครู่' }
});

// ลูกค้าส่งออเดอร์ -> สร้างออเดอร์ + ส่งเข้า Discord พร้อมปุ่ม
app.post('/api/topup', topupLimiter, async (req, res) => {
    let user = null;
    try { user = await getSessionUser(req); } catch (e) { console.error('อ่านเซสชันไม่สำเร็จ:', e.message); }
    // ไม่ส่ง game มา = One Punch Man (รองรับหน้าเว็บเวอร์ชันเก่าที่ยังแคชอยู่)
    const gameKey = clean(req.body.game, 20) || 'opm';
    if (!hasOwn(GAMES, gameKey)) {
        return res.status(400).json({ success: false, message: 'เกมไม่ถูกต้อง' });
    }
    const game = GAMES[gameKey];
    if (game.requireLogin && !user) {
        return res.status(401).json({ success: false, needLogin: true, message: 'กรุณาเข้าสู่ระบบด้วย Discord ก่อนเติม Point' });
    }

    const data = {};
    for (const f of game.fields) {
        let v = clean(req.body[f.key], f.max);
        if (f.norm) v = f.norm(v);
        data[f.key] = v;
    }
    const facebook = clean(req.body.facebook, 200);
    const voucherLink = clean(req.body.voucherLink, 300);
    // วิธีชำระเงิน: voucher = ลิงก์ซองอั่งเปา | balance = เงินในบัญชีเว็บ (ไม่หักตอนสั่ง จะหักตอนแอดมินกด "รับเงิน")
    const payMethod = clean(req.body.payMethod, 10) === 'balance' ? 'balance' : 'voucher';
    if (payMethod === 'balance') {
        if (!user) return res.status(401).json({ success: false, needLogin: true, message: 'กรุณาเข้าสู่ระบบก่อนชำระด้วยเงินในบัญชี' });
        if (gameKey === 'points') return res.status(400).json({ success: false, message: 'การเติมเงินเข้าบัญชีต้องชำระด้วยซองอั่งเปาเท่านั้น' });
    }

    // ราคามาจากฝั่งเซิร์ฟเวอร์เท่านั้น ไม่เชื่อค่า expectedPrice ที่ลูกค้าส่งมา
    let packageName = '';
    let price = 0;
    if (game.custom) {
        const amount = Number(req.body.amount);
        if (!Number.isInteger(amount) || amount < game.custom.min || amount > game.custom.max) {
            return res.status(400).json({ success: false, message: `กรุณากรอกจำนวนเงินเป็นจำนวนเต็ม ${game.custom.min} - ${game.custom.max.toLocaleString('en-US')} บาท` });
        }
        price = amount;
        packageName = game.custom.label(amount);
    } else {
        packageName = clean(req.body.packageName, 100);
        if (packageName) {
            if (!hasOwn(game.packages, packageName)) {
                return res.status(400).json({ success: false, message: 'แพ็กเกจไม่ถูกต้อง' });
            }
            price = game.packages[packageName];
        }
    }

    if (game.fields.some(f => !data[f.key]) || !facebook || !packageName || (payMethod === 'voucher' && !voucherLink)) {
        return res.status(400).json({ success: false, message: payMethod === 'voucher'
            ? 'กรุณากรอกข้อมูลบัญชีเกม, Facebook, แพ็กเกจ และลิงก์ซอง ให้ครบถ้วน'
            : 'กรุณากรอกข้อมูลบัญชีเกม, Facebook และแพ็กเกจ ให้ครบถ้วน' });
    }
    const badField = game.fields.find(f => f.test && !f.test(data[f.key]));
    if (badField) {
        return res.status(400).json({ success: false, message: badField.error });
    }

    let voucherCode = null;
    let dupOf = null;
    if (payMethod === 'voucher') {
        voucherCode = parseVoucher(voucherLink);
        if (!voucherCode) {
            return res.status(400).json({ success: false, message: 'ลิงก์ซองไม่ถูกต้อง ต้องเป็นลิงก์จาก gift.truemoney.com' });
        }
        // ส่งลิงก์ซองเดิมซ้ำได้ ไม่ปฏิเสธ แต่จะมีคำเตือนในข้อความ Discord ให้แอดมินเห็น
        dupOf = Object.values(orders).find(o => o.voucherCode === voucherCode) || null;
    } else {
        // ยังไม่หักเงิน แต่กันสั่งเกินยอด: ยอดที่ใช้ได้ = ยอดคงเหลือ - ออเดอร์เงินในบัญชีอื่นที่ยังรอแอดมิน
        const pending = Object.values(orders)
            .filter(o => o.userId === user.id && o.payMethod === 'balance' && !o.paid && !isFinal(o.status))
            .reduce((sum, o) => sum + o.price, 0);
        if (price > user.points - pending) {
            return res.status(400).json({ success: false, message: `ยอดเงินในบัญชีไม่พอ (คงเหลือ ${user.points.toLocaleString('en-US')} บาท${pending ? `, มีออเดอร์รอดำเนินการ ${pending.toLocaleString('en-US')} บาท` : ''})` });
        }
    }

    const id = crypto.randomBytes(12).toString('hex');
    const now = Date.now();
    const order = { id, game: gameKey, ...(user ? { userId: user.id, userName: user.name } : {}), ...data, facebook, packageName, price, payMethod, ...(voucherCode ? { voucherCode } : {}), status: 'checking', createdAt: now, updatedAt: now };
    if (dupOf) order.dupOf = dupOf.id;

    // เก็บก่อนส่ง Discord ถ้าส่งไม่ผ่านค่อยลบทิ้ง
    orders[id] = order;
    try {
        await db.saveOrder(order);
        const channel = await client.channels.fetch(CHANNEL_ID);
        const msg = await channel.send(buildMessage(order));
        order.messageId = msg.id;
        saveOrder(order);
    } catch (e) {
        delete orders[id];
        db.deleteOrder(id).catch(() => {});
        console.error('ส่งออเดอร์เข้า Discord ไม่สำเร็จ:', e.message);
        return res.status(502).json({ success: false, message: payMethod === 'balance' ? 'ระบบแจ้งเตือนแอดมินขัดข้อง กรุณาลองใหม่อีกครั้ง (ยังไม่มีการหักเงินในบัญชี)' : 'ระบบแจ้งเตือนแอดมินขัดข้อง กรุณาลองใหม่อีกครั้ง (ซองของคุณยังไม่ถูกใช้)' });
    }

    return res.json({
        success: true,
        orderId: id,
        message: payMethod === 'balance' ? 'ส่งออเดอร์แล้ว รอแอดมินตรวจสอบ' : 'ส่งออเดอร์แล้ว กำลังตรวจสอบลิงก์ซอง'
    });
});

// ---------- ล็อกอินด้วย Discord (OAuth2) + เซสชันแบบคุกกี้เซ็นลายเซ็น ----------
const authLimiter = rateLimit({
    windowMs: 10 * 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false,
    message: { success: false, message: 'พยายามล็อกอินบ่อยเกินไป กรุณารอสักครู่' }
});
const SESSION_DAYS = 30;

function signToken(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
    return body + '.' + sig;
}
function readToken(token) {
    if (!AUTH_ON || typeof token !== 'string') return null;
    const [body, sig] = token.split('.');
    if (!body || !sig) return null;
    const expect = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
    const a = Buffer.from(sig), b = Buffer.from(expect);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
        const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        return p && p.exp > Date.now() ? p : null;
    } catch (e) { return null; }
}
function parseCookies(req) {
    const out = {};
    (req.headers.cookie || '').split(';').forEach(part => {
        const i = part.indexOf('=');
        if (i > 0) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch (e) { /* ข้าม */ } }
    });
    return out;
}
function setCookie(res, name, value, maxAgeSec) {
    res.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${IS_HTTPS ? '; Secure' : ''}`);
}
async function getSessionUser(req) {
    const s = readToken(parseCookies(req).session);
    return s ? db.getUser(s.id) : null;
}
const isAdminId = (id) => ADMIN_IDS.includes(id);
const avatarUrl = (u) => (u.avatar && /^[a-z0-9_]+$/i.test(u.avatar))
    ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64` : null;

app.get('/auth/discord', authLimiter, (req, res) => {
    if (!AUTH_ON) return res.status(503).send('ระบบล็อกอินยังไม่เปิดใช้งาน');
    const state = crypto.randomBytes(16).toString('hex');
    setCookie(res, 'oauth_state', state, 600);
    const q = new URLSearchParams({ client_id: DISCORD_CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: 'code', scope: 'identify', state, prompt: 'none' });
    res.redirect('https://discord.com/oauth2/authorize?' + q);
});

app.get('/auth/discord/callback', authLimiter, async (req, res) => {
    if (!AUTH_ON) return res.status(503).send('ระบบล็อกอินยังไม่เปิดใช้งาน');
    const { code, state } = req.query;
    const saved = parseCookies(req).oauth_state;
    setCookie(res, 'oauth_state', '', 0);
    if (typeof code !== 'string' || typeof state !== 'string' || !saved || state !== saved) return res.redirect('/?login=failed');
    try {
        const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ client_id: DISCORD_CLIENT_ID, client_secret: DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI })
        });
        if (!tokenRes.ok) throw new Error('แลก token ไม่สำเร็จ: HTTP ' + tokenRes.status);
        const tok = await tokenRes.json();
        const meRes = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: 'Bearer ' + tok.access_token } });
        if (!meRes.ok) throw new Error('ดึงโปรไฟล์ไม่สำเร็จ: HTTP ' + meRes.status);
        const du = await meRes.json();
        if (!/^\d{5,25}$/.test(String(du.id))) throw new Error('Discord ID ไม่ถูกต้อง');
        const user = await db.upsertUser({ id: String(du.id), name: clean(du.global_name || du.username, 60) || 'ผู้ใช้', avatar: du.avatar });
        setCookie(res, 'session', signToken({ id: user.id, exp: Date.now() + SESSION_DAYS * 86400000 }), SESSION_DAYS * 86400);
        res.redirect('/');
    } catch (e) {
        console.error('ล็อกอิน Discord ไม่สำเร็จ:', e.message);
        res.redirect('/?login=failed');
    }
});

app.post('/auth/logout', (req, res) => {
    setCookie(res, 'session', '', 0);
    res.json({ success: true });
});

app.get('/api/me', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const u = await getSessionUser(req);
        if (!u) return res.json({ success: true, authEnabled: AUTH_ON, user: null });
        return res.json({ success: true, authEnabled: AUTH_ON, user: { id: u.id, name: u.name, avatarUrl: avatarUrl(u), points: u.points, isAdmin: isAdminId(u.id) } });
    } catch (e) {
        console.error('/api/me ผิดพลาด:', e.message);
        return res.json({ success: true, authEnabled: AUTH_ON, user: null });
    }
});

// ประวัติของผู้ใช้ที่ล็อกอินอยู่: เติมเกม / เติมเงิน (ออเดอร์ Point) / ความเคลื่อนไหว Point
app.get('/api/me/history', statusLimiter, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const u = await getSessionUser(req);
        if (!u) return res.status(401).json({ success: false, message: 'กรุณาเข้าสู่ระบบ' });
        const mine = Object.values(orders).filter(o => o.userId === u.id).sort((a, b) => b.createdAt - a.createdAt);
        const view = (o) => ({ id: o.id, game: o.game || 'opm', payMethod: o.payMethod || 'voucher', packageName: o.packageName, price: o.price, status: o.status, createdAt: o.createdAt });
        return res.json({
            success: true,
            points: u.points,
            gameOrders: mine.filter(o => o.game !== 'points').slice(0, 50).map(view),
            topupOrders: mine.filter(o => o.game === 'points').slice(0, 50).map(view),
            ledger: await db.getLedger(u.id, 50)
        });
    } catch (e) {
        console.error('/api/me/history ผิดพลาด:', e.message);
        return res.status(500).json({ success: false, message: 'โหลดประวัติไม่สำเร็จ' });
    }
});

// หน้าเว็บเช็กสถานะออเดอร์ (ส่งกลับเฉพาะข้อมูลที่ลูกค้าควรเห็น ไม่ส่งลิงก์ซอง)
app.get('/api/order/:id', statusLimiter, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const order = ID_RE.test(req.params.id) ? orders[req.params.id] : null;
    if (!order) return res.status(404).json({ success: false, message: 'ไม่พบออเดอร์' });
    return res.json({
        success: true,
        status: order.status,
        game: order.game || 'opm',
        payMethod: order.payMethod || 'voucher',
        packageName: order.packageName,
        price: order.price,
        updatedAt: order.updatedAt
    });
});

(async () => {
    try {
        await db.initDb();
        orders = await db.loadOrders();
        await importLegacyOrders();
        console.log(`โหลดออเดอร์จากฐานข้อมูล ${Object.keys(orders).length} รายการ | ล็อกอิน Discord: ${AUTH_ON ? 'เปิด' : 'ปิด (ยังไม่ตั้งค่า)'}`);
    } catch (e) {
        const tok = (process.env.TURSO_AUTH_TOKEN || '').trim();
        const msg = tok ? String(e.message).split(tok).join('***') : e.message; // ไม่พิมพ์ Token ลง Logs
        console.error('เชื่อมต่อฐานข้อมูลไม่สำเร็จ (ตรวจ TURSO_DATABASE_URL / TURSO_AUTH_TOKEN):', msg);
        process.exit(1);
    }
    client.login(BOT_TOKEN)
        .then(() => {
            app.listen(PORT, () => console.log(`Server is running at http://localhost:${PORT}`));
        })
        .catch((e) => {
            console.error('เข้าสู่ระบบ Discord bot ไม่สำเร็จ (ตรวจ DISCORD_BOT_TOKEN):', e.message);
            process.exit(1);
        });
})();
