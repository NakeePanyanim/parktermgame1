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
// ส่วนลดของยศ Reseller (เปอร์เซ็นต์) ปรับได้ด้วยตัวแปร RESELLER_DISCOUNT ใน Render
const DISCOUNT_PCT = Math.min(90, Math.max(0, Number(process.env.RESELLER_DISCOUNT ?? 10) || 0));
const AUTH_ON = !!(DISCORD_CLIENT_ID && DISCORD_CLIENT_SECRET && SESSION_SECRET && BASE_URL);
const REDIRECT_URI = BASE_URL + '/auth/discord/callback';
const IS_HTTPS = BASE_URL.startsWith('https://');
// ---- โอนผ่านธนาคาร: บัญชีของร้านที่ให้ลูกค้าโอนเข้า (ไม่ตั้งค่า 3 ตัวนี้ = ปิดตัวเลือกโอนธนาคาร) ----
const BANK_NAME = (process.env.BANK_NAME || '').trim();
const BANK_ACCOUNT_NO = (process.env.BANK_ACCOUNT_NO || '').trim();
const BANK_ACCOUNT_NAME = (process.env.BANK_ACCOUNT_NAME || '').trim();
const BANK_ON = !!(BANK_NAME && BANK_ACCOUNT_NO && BANK_ACCOUNT_NAME);
// รายชื่อธนาคารที่ให้ลูกค้าเลือก (ธนาคารที่ลูกค้าใช้โอนมา)
const BANKS = ['กสิกรไทย (KBank)', 'ไทยพาณิชย์ (SCB)', 'กรุงเทพ (BBL)', 'กรุงไทย (KTB)', 'กรุงศรีอยุธยา (BAY)', 'ทหารไทยธนชาต (ttb)',
    'ออมสิน (GSB)', 'ธ.ก.ส. (BAAC)', 'ซีไอเอ็มบีไทย (CIMB)', 'ยูโอบี (UOB)', 'เกียรตินาคินภัทร (KKP)', 'ทิสโก้ (TISCO)',
    'แลนด์ แอนด์ เฮ้าส์ (LH Bank)', 'ไอซีบีซี (ไทย)', 'อาคารสงเคราะห์ (GHB)', 'อิสลามแห่งประเทศไทย (iBank)', 'อื่นๆ'];
const BANK_ACC_RE = /^\d{10,15}$/;

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

// ---------- แพ็กเกจ: ตารางใน GAMES.*.packages ด้านบนใช้เป็นค่าตั้งต้นครั้งแรกเท่านั้น หลังจากนั้นแก้ได้จากหน้า Admin ----------
const SEED_META = {
    '210 คูปอง (105*2)': { note: '105 × 2' },
    '700 คูปอง': { tag: 'ราคาต่อคูปองต่ำสุด' },
    '5000 Robux': { tag: 'ถูกที่สุดต่อ Robux' }
};
function seedList() {
    const out = [];
    for (const [gk, g] of Object.entries(GAMES)) {
        Object.entries(g.packages).forEach(([name, price], i) => {
            out.push({ game: gk, name, qty: parseInt(name, 10) || 1, price, sort: i, ...(SEED_META[name] || {}) });
        });
    }
    return out;
}
let PKG = {}; // { opm: [แพ็กเกจที่เปิดขาย...], roblox: [...] }
async function loadPackages() {
    const all = await db.listPackages();
    const next = {};
    for (const p of all) if (p.active) (next[p.game] = next[p.game] || []).push(p);
    PKG = next;
}
const findPackage = (gameKey, name) => (PKG[gameKey] || []).find(p => p.name === name) || null;

// ราคาตามยศ: Reseller ลด DISCOUNT_PCT% (ปัดเป็นบาทเต็ม) ใช้กับแพ็กเกจเกมเท่านั้น ไม่ใช้กับการเติมเงินเข้าบัญชี
const priceFor = (user, base) => (user && user.role === 'reseller' && DISCOUNT_PCT > 0)
    ? Math.max(1, Math.round(base * (100 - DISCOUNT_PCT) / 100)) : base;

// ---------- โค้ดส่วนลด: คำนวณจากราคา "หลังลดยศแล้ว" (ซ้อนกันได้) ราคาสุทธิไม่ต่ำกว่า 1 บาท ----------
const codeLabel = (c) => c.type === 'percent' ? `${c.value}%` : `${c.value.toLocaleString('en-US')} บาท`;
function evalCode(c, price) {
    if (!c || !c.active) return { error: 'โค้ดไม่ถูกต้อง หรือใช้ไม่ได้แล้ว' };
    if (c.maxUses > 0 && c.used >= c.maxUses) return { error: 'โค้ดนี้ถูกใช้ครบจำนวนแล้ว' };
    const discount = c.type === 'percent' ? Math.round(price * c.value / 100) : c.value;
    const after = Math.max(1, price - discount);
    if (after >= price) return { error: 'โค้ดนี้ใช้กับแพ็กเกจนี้ไม่ได้ (ราคาต่ำเกินกว่าจะลด)' };
    return { after, discount: price - after };
}
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
    if (o.payMethod === 'bank') return '🏦 **โอนผ่านธนาคาร** (ตรวจยอดเข้าบัญชีร้านก่อนกด "รับเงิน")';
    if (o.payMethod !== 'balance') return '🎟️ ลิงก์ซองอั่งเปา TrueMoney';
    if (o.refunded) return '👛 เงินในบัญชี (คืนเงินแล้ว ↩️)';
    if (o.paid) return '👛 เงินในบัญชี (หักเงินแล้ว ✅)';
    return '👛 **เงินในบัญชี** (ยังไม่หักเงิน จะหักเมื่อกด "รับเงิน")';
}

// ข้อความแจ้งการใช้โค้ดส่วนลดในออเดอร์ (แสดงใน Discord)
function codeText(o) {
    const lbl = o.codeType === 'percent' ? `${o.codeValue}%` : `${o.codeValue.toLocaleString('en-US')} บาท`;
    const left = o.codeMax > 0
        ? `ใช้ไปแล้ว ${o.codeUsed}/${o.codeMax} คน (เหลือ ${Math.max(0, o.codeMax - o.codeUsed)})`
        : `ใช้ไปแล้ว ${o.codeUsed} ครั้ง (ไม่จำกัดจำนวน)`;
    return `โค้ด ${code(o.code)} ลด **${lbl}** (−${o.codeDiscount.toLocaleString('en-US')} บาท)\n` +
        `จาก ${o.priceBeforeCode.toLocaleString('en-US')} → เหลือ **${o.price.toLocaleString('en-US')} บาท**\n${left}` +
        (o.codeReleased ? '\n↩️ ออเดอร์ถูกยกเลิก คืนสิทธิ์โค้ดแล้ว' : '');
}

function buildMessage(o) {
    const s = STATUS[o.status];
    const statusTxt = o.payMethod === 'bank'
        ? ({ checking: '🕑 รอตรวจสอบยอดโอน', done: '✅ รับเงินแล้ว เติม Point เข้าบัญชีลูกค้าแล้ว', insufficient: '⚠️ เงินไม่พอ / ไม่พบยอดโอน' }[o.status] || s.text)
        : s.text;
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
            { name: '📌 สถานะ', value: statusTxt, inline: false },
            { name: '🕹️ เกม', value: `**${GAMES[gameKey].name}**`, inline: false },
            ...accountFields,
            ...(o.userId && gameKey !== 'points' ? [{ name: '🔗 บัญชีเว็บ', value: `<@${o.userId}>`, inline: true }] : []),
            { name: '📘 Facebook', value: o.facebook || '-', inline: false },
            { name: '📦 แพ็กเกจ', value: o.packageName, inline: true },
            { name: '💰 ยอดที่ต้องได้รับ', value: `**${o.price.toLocaleString('en-US')} บาท**` + (o.basePrice && o.basePrice !== (o.priceBeforeCode || o.price) ? `\n🏷️ ส่วนลด Reseller ${o.discountPct}% (ราคาปกติ ${o.basePrice.toLocaleString('en-US')})` : ''), inline: true },
            { name: '💳 ชำระเงินด้วย', value: payText(o), inline: false },
            ...(o.payMethod === 'bank' ? [
                { name: '🏦 ธนาคารของลูกค้า', value: code(o.bankName), inline: true },
                { name: '🔢 เลขบัญชีลูกค้า', value: code(o.bankAccount), inline: true }
            ] : []),
            ...(o.code ? [{ name: '🎟️ โค้ดส่วนลด', value: codeText(o), inline: false }] : [])
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

    const row = new ActionRowBuilder();
    if (o.payMethod === 'bank') {
        // โอนธนาคาร: มีแค่ 2 ปุ่ม กด "รับเงิน" = เติม Point เข้าบัญชีลูกค้าทันทีตามยอดที่ลูกค้ากรอก (เติมได้ครั้งเดียวต่อออเดอร์)
        row.addComponents(
            new ButtonBuilder().setCustomId(`order:${o.id}:received`).setLabel('รับเงิน')
                .setStyle(ButtonStyle.Success).setDisabled(isFinal(o.status)),
            new ButtonBuilder().setCustomId(`order:${o.id}:insufficient`).setLabel('เงินไม่พอ')
                .setStyle(ButtonStyle.Danger).setDisabled(isFinal(o.status))
        );
    } else {
        row.addComponents(
            new ButtonBuilder().setCustomId(`order:${o.id}:received`).setLabel('รับเงิน')
                .setStyle(ButtonStyle.Primary).setDisabled(o.status !== 'checking'),
            new ButtonBuilder().setCustomId(`order:${o.id}:done`).setLabel('เสร็จสิ้น')
                .setStyle(ButtonStyle.Success).setDisabled(isFinal(o.status)),
            new ButtonBuilder().setCustomId(`order:${o.id}:insufficient`).setLabel('ยอดไม่ครบ')
                .setStyle(ButtonStyle.Danger).setDisabled(isFinal(o.status))
        );
    }
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
            const du = await db.getUser(interaction.user.id).catch(() => null); // แอดมินที่ตั้งยศในหน้าเว็บ กดปุ่มได้ด้วย
            if (!du || du.role !== 'admin') {
                return interaction.reply({ content: 'คุณไม่มีสิทธิ์กดปุ่มนี้', flags: MessageFlags.Ephemeral });
            }
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
                if (action === 'insufficient' && order.codeId && !order.codeReleased) {
                    await db.releaseCodeUse(order.id); // ออเดอร์ถูกยกเลิก คืนสิทธิ์โค้ดให้
                    order.codeReleased = true;
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

        if (action === 'insufficient' && order.codeId && !order.codeReleased) {
            await interaction.deferUpdate();
            try {
                await db.releaseCodeUse(order.id); // ออเดอร์ถูกยกเลิก คืนสิทธิ์โค้ดให้
                order.codeReleased = true;
            } catch (e) {
                console.error('คืนสิทธิ์โค้ดไม่สำเร็จ:', e.message);
                return interaction.followUp({ content: 'คืนสิทธิ์โค้ดไม่สำเร็จ (สถานะไม่เปลี่ยน) กรุณากดใหม่อีกครั้ง', flags: MessageFlags.Ephemeral });
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
    const payRaw = clean(req.body.payMethod, 10);
    const payMethod = payRaw === 'balance' ? 'balance' : payRaw === 'bank' ? 'bank' : 'voucher';
    if (payMethod === 'balance') {
        if (!user) return res.status(401).json({ success: false, needLogin: true, message: 'กรุณาเข้าสู่ระบบก่อนชำระด้วยเงินในบัญชี' });
        if (gameKey === 'points') return res.status(400).json({ success: false, message: 'การเติมเงินเข้าบัญชีต้องชำระด้วยซองอั่งเปาหรือโอนธนาคารเท่านั้น' });
    }
    // โอนธนาคาร: ใช้เติม Point เท่านั้น ลูกค้าบอกธนาคารและเลขบัญชีที่ใช้โอน แอดมินตรวจยอดเข้าบัญชีร้านเอง
    let bankName = '', bankAccount = '';
    if (payMethod === 'bank') {
        if (!BANK_ON) return res.status(400).json({ success: false, message: 'ระบบโอนผ่านธนาคารยังไม่เปิดใช้งาน' });
        if (!user) return res.status(401).json({ success: false, needLogin: true, message: 'กรุณาเข้าสู่ระบบก่อนเติมเงินผ่านธนาคาร' });
        if (gameKey !== 'points') return res.status(400).json({ success: false, message: 'การโอนผ่านธนาคารใช้เติม Point เข้าบัญชีเท่านั้น' });
        bankName = clean(req.body.bankName, 60);
        bankAccount = clean(req.body.bankAccount, 30).replace(/[\s-]/g, '');
        if (!BANKS.includes(bankName)) return res.status(400).json({ success: false, message: 'กรุณาเลือกธนาคารของคุณ' });
        if (!BANK_ACC_RE.test(bankAccount)) return res.status(400).json({ success: false, message: 'เลขบัญชีไม่ถูกต้อง (ตัวเลข 10-15 หลัก)' });
    }

    // ราคามาจากฝั่งเซิร์ฟเวอร์เท่านั้น ไม่เชื่อค่า expectedPrice ที่ลูกค้าส่งมา
    let packageName = '';
    let price = 0;
    let basePrice = 0;
    if (game.custom) {
        const amount = Number(req.body.amount);
        if (!Number.isInteger(amount) || amount < game.custom.min || amount > game.custom.max) {
            return res.status(400).json({ success: false, message: `กรุณากรอกจำนวนเงินเป็นจำนวนเต็ม ${game.custom.min} - ${game.custom.max.toLocaleString('en-US')} บาท` });
        }
        price = amount;
        basePrice = amount;
        packageName = game.custom.label(amount);
    } else {
        packageName = clean(req.body.packageName, 100);
        if (packageName) {
            const pkg = findPackage(gameKey, packageName);
            if (!pkg) {
                return res.status(400).json({ success: false, message: 'แพ็กเกจไม่ถูกต้อง หรือถูกปิดขายแล้ว กรุณารีเฟรชหน้าเว็บ' });
            }
            basePrice = pkg.price;
            price = priceFor(user, pkg.price);
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

    // โค้ดส่วนลด (ไม่บังคับ) ใช้กับแพ็กเกจเกมเท่านั้น
    const priceBeforeCode = price;
    let codeUse = null;
    const codeStr = clean(req.body.code, 40).toUpperCase();
    if (codeStr) {
        if (game.custom) return res.status(400).json({ success: false, message: 'โค้ดส่วนลดใช้กับแพ็กเกจเกมเท่านั้น (ไม่ใช้กับการเติมเงินเข้าบัญชี)' });
        const c = await db.getCodeByCode(codeStr);
        const ev = evalCode(c, price);
        if (ev.error) return res.status(400).json({ success: false, message: ev.error });
        if (user && await db.userUsedCode(c.id, user.id)) return res.status(400).json({ success: false, message: 'คุณเคยใช้โค้ดนี้แล้ว' });
        codeUse = { c, discount: ev.discount };
        price = ev.after;
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
    } else if (payMethod === 'bank') {
        // กันสแปม: รายการโอนที่แอดมินยังไม่ตรวจ มีได้ไม่เกิน 3 รายการต่อบัญชี
        const pendingBank = Object.values(orders).filter(o => o.userId === user.id && o.payMethod === 'bank' && !isFinal(o.status)).length;
        if (pendingBank >= 3) {
            return res.status(400).json({ success: false, message: 'คุณมีรายการโอนที่รอแอดมินตรวจสอบอยู่ 3 รายการแล้ว กรุณารอให้แอดมินตรวจสอบก่อน' });
        }
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

    // จองสิทธิ์โค้ดแบบ atomic (กันหลายคนกดพร้อมกันจนเกินจำนวน) ถ้าขั้นตอนหลังจากนี้พัง จะคืนสิทธิ์ให้
    let codeFields = {};
    if (codeUse) {
        try {
            const rr = await db.redeemCode(codeUse.c.id, user ? user.id : null, id);
            if (rr.error) {
                return res.status(400).json({ success: false, message: rr.error === 'full' ? 'โค้ดนี้ถูกใช้ครบจำนวนแล้ว' : rr.error === 'already' ? 'คุณเคยใช้โค้ดนี้แล้ว' : 'โค้ดไม่ถูกต้อง หรือใช้ไม่ได้แล้ว' });
            }
            codeFields = { codeId: codeUse.c.id, code: codeUse.c.code, codeType: codeUse.c.type, codeValue: codeUse.c.value, codeDiscount: codeUse.discount, priceBeforeCode, codeUsed: rr.used, codeMax: codeUse.c.maxUses };
        } catch (e) {
            console.error('จองสิทธิ์โค้ดไม่สำเร็จ:', e.message);
            return res.status(503).json({ success: false, message: 'ระบบโค้ดส่วนลดขัดข้อง กรุณาลองใหม่อีกครั้ง' });
        }
    }
    const order = { id, game: gameKey, ...(user ? { userId: user.id, userName: user.name } : {}), ...data, facebook, packageName, price, ...(basePrice !== priceBeforeCode ? { basePrice, discountPct: DISCOUNT_PCT } : {}), payMethod, ...(voucherCode ? { voucherCode } : {}), ...(payMethod === 'bank' ? { bankName, bankAccount } : {}), ...codeFields, status: 'checking', createdAt: now, updatedAt: now };
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
        if (codeUse) db.releaseCodeUse(id).catch(() => {});
        console.error('ส่งออเดอร์เข้า Discord ไม่สำเร็จ:', e.message);
        return res.status(502).json({ success: false, message: payMethod === 'bank' ? 'ระบบแจ้งเตือนแอดมินขัดข้อง กรุณาลองใหม่อีกครั้ง (หากโอนเงินไปแล้ว ให้เก็บสลิปไว้และติดต่อแอดมินทาง Facebook)' : payMethod === 'balance' ? 'ระบบแจ้งเตือนแอดมินขัดข้อง กรุณาลองใหม่อีกครั้ง (ยังไม่มีการหักเงินในบัญชี)' : 'ระบบแจ้งเตือนแอดมินขัดข้อง กรุณาลองใหม่อีกครั้ง (ซองของคุณยังไม่ถูกใช้)' });
    }

    return res.json({
        success: true,
        orderId: id,
        price,
        message: payMethod === 'bank' ? 'ส่งรายการแล้ว รอแอดมินตรวจสอบยอดโอน' : payMethod === 'balance' ? 'ส่งออเดอร์แล้ว รอแอดมินตรวจสอบ' : 'ส่งออเดอร์แล้ว กำลังตรวจสอบลิงก์ซอง'
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
    if (!s) return null;
    const u = await db.getUser(s.id);
    if (u && ADMIN_IDS.includes(u.id)) u.role = 'admin'; // คนที่อยู่ใน ADMIN_USER_IDS เป็นแอดมินเสมอ (กันล็อกตัวเองออก)
    return u;
}
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
        return res.json({ success: true, authEnabled: AUTH_ON, user: { id: u.id, name: u.name, avatarUrl: avatarUrl(u), points: u.points, role: u.role, isAdmin: u.role === 'admin', discountPct: u.role === 'reseller' ? DISCOUNT_PCT : 0 } });
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

// ข้อมูลบัญชีร้านสำหรับโอนเงิน (ให้เฉพาะคนที่ล็อกอินแล้ว)
app.get('/api/bank', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    let user = null;
    try { user = await getSessionUser(req); } catch (e) { /* ถือว่าไม่ได้ล็อกอิน */ }
    if (!BANK_ON || !user) return res.json({ success: true, enabled: false });
    return res.json({ success: true, enabled: true, banks: BANKS, bankName: BANK_NAME, accountNo: BANK_ACCOUNT_NO, accountName: BANK_ACCOUNT_NAME });
});

// รายการแพ็กเกจที่เปิดขาย (ราคาตามยศของคนที่ล็อกอินอยู่)
app.get('/api/packages', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    let user = null;
    try { user = await getSessionUser(req); } catch (e) { /* ถือว่าไม่ได้ล็อกอิน */ }
    const out = {};
    for (const gk of Object.keys(GAMES)) {
        if (GAMES[gk].custom) continue; // เติม Point กรอกจำนวนเอง ไม่มีแพ็กเกจ
        out[gk] = (PKG[gk] || []).map(p => ({ name: p.name, qty: p.qty, price: priceFor(user, p.price), basePrice: p.price, note: p.note, tag: p.tag }));
    }
    res.json({ success: true, packages: out, discountPct: user && user.role === 'reseller' ? DISCOUNT_PCT : 0 });
});

// ตรวจโค้ดส่วนลดก่อนกดซื้อ (ใช้แสดงราคาใหม่ในหน้าเว็บ ยังไม่ใช้สิทธิ์จริง)
const codeLimiter = rateLimit({
    windowMs: 10 * 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false,
    message: { success: false, message: 'ตรวจโค้ดบ่อยเกินไป กรุณารอสักครู่' }
});
app.post('/api/discount/check', codeLimiter, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const user = await getSessionUser(req);
        const gameKey = clean(req.body.game, 20), packageName = clean(req.body.packageName, 100), codeStr = clean(req.body.code, 40).toUpperCase();
        if (!hasOwn(GAMES, gameKey) || GAMES[gameKey].custom) return res.status(400).json({ success: false, message: 'โค้ดส่วนลดใช้กับแพ็กเกจเกมเท่านั้น' });
        const pkg = findPackage(gameKey, packageName);
        if (!pkg) return res.status(400).json({ success: false, message: 'กรุณาเลือกแพ็กเกจก่อน' });
        if (!codeStr) return res.status(400).json({ success: false, message: 'กรุณากรอกโค้ด' });
        const price = priceFor(user, pkg.price);
        const c = await db.getCodeByCode(codeStr);
        const ev = evalCode(c, price);
        if (ev.error) return res.status(400).json({ success: false, message: ev.error });
        if (user && await db.userUsedCode(c.id, user.id)) return res.status(400).json({ success: false, message: 'คุณเคยใช้โค้ดนี้แล้ว' });
        return res.json({ success: true, code: c.code, label: codeLabel(c), before: price, after: ev.after, discount: ev.discount });
    } catch (e) {
        console.error('/api/discount/check ผิดพลาด:', e.message);
        return res.status(500).json({ success: false, message: 'ตรวจโค้ดไม่สำเร็จ กรุณาลองใหม่' });
    }
});

// ---------- API หลังบ้านสำหรับแอดมิน (ต้องมียศ admin) ----------
const adminLimiter = rateLimit({
    windowMs: 10 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false,
    message: { success: false, message: 'ส่งคำขอบ่อยเกินไป กรุณารอสักครู่' }
});
const admin = express.Router();
admin.use(adminLimiter, async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    try {
        const u = await getSessionUser(req);
        if (!u) return res.status(401).json({ success: false, message: 'กรุณาเข้าสู่ระบบ' });
        if (u.role !== 'admin') return res.status(403).json({ success: false, message: 'ไม่มีสิทธิ์เข้าถึง' });
        req.admin = u;
        next();
    } catch (e) {
        console.error('ตรวจสิทธิ์แอดมินไม่สำเร็จ:', e.message);
        res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
    }
});
const USER_ID_RE = /^\d{5,25}$/;
const fail = (res, msg, code = 400) => res.status(code).json({ success: false, message: msg });
const wrap = (fn) => (req, res) => fn(req, res).catch(e => { console.error('admin api:', e.message); fail(res, 'เกิดข้อผิดพลาดในระบบ', 500); });

admin.get('/me', (req, res) => res.json({ success: true, name: req.admin.name, id: req.admin.id, discountPct: DISCOUNT_PCT }));

admin.get('/users', wrap(async (req, res) => {
    const users = await db.listUsers(clean(req.query.q, 60), 50);
    res.json({ success: true, users: users.map(u => ({ ...u, role: ADMIN_IDS.includes(u.id) ? 'admin' : u.role, avatarUrl: avatarUrl(u), locked: ADMIN_IDS.includes(u.id) })) });
}));

admin.get('/users/:id', wrap(async (req, res) => {
    if (!USER_ID_RE.test(req.params.id)) return fail(res, 'Discord ID ไม่ถูกต้อง');
    const u = await db.getUser(req.params.id);
    if (!u) return fail(res, 'ไม่พบผู้ใช้ (ต้องเคยล็อกอินเข้าเว็บอย่างน้อย 1 ครั้ง)', 404);
    const mine = Object.values(orders).filter(o => o.userId === u.id).sort((a, b) => b.createdAt - a.createdAt).slice(0, 20)
        .map(o => ({ id: o.id, game: o.game || 'opm', packageName: o.packageName, price: o.price, payMethod: o.payMethod || 'voucher', status: o.status, createdAt: o.createdAt }));
    res.json({ success: true, user: { ...u, role: ADMIN_IDS.includes(u.id) ? 'admin' : u.role, avatarUrl: avatarUrl(u), locked: ADMIN_IDS.includes(u.id) }, ledger: await db.getLedger(u.id, 30), orders: mine });
}));

// เพิ่ม/หัก Point (delta บวก = เพิ่ม, ลบ = หัก) ต้องใส่เหตุผลเสมอ และบันทึกลง ledger
admin.post('/users/:id/points', wrap(async (req, res) => {
    if (!USER_ID_RE.test(req.params.id)) return fail(res, 'Discord ID ไม่ถูกต้อง');
    const delta = Number(req.body.delta);
    const reason = clean(req.body.reason, 200);
    if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 10000000) return fail(res, 'จำนวนต้องเป็นจำนวนเต็มที่ไม่ใช่ 0 (ไม่เกิน 10,000,000)');
    if (!reason) return fail(res, 'กรุณาใส่เหตุผล');
    if (!(await db.getUser(req.params.id))) return fail(res, 'ไม่พบผู้ใช้', 404);
    const r = await db.adjustPoints(req.params.id, delta, 'admin', null, reason, req.admin.name);
    if (r.insufficient) return fail(res, 'ยอดในบัญชีไม่พอให้หัก');
    await db.logAdmin(`${req.admin.name} (${req.admin.id})`, delta > 0 ? 'เพิ่มเงิน' : 'หักเงิน', `ผู้ใช้ ${req.params.id}: ${delta > 0 ? '+' : ''}${delta} บาท เหตุผล: ${reason} (คงเหลือ ${r.balance})`);
    res.json({ success: true, balance: r.balance });
}));

admin.post('/users/:id/role', wrap(async (req, res) => {
    const id = req.params.id, role = clean(req.body.role, 20);
    if (!USER_ID_RE.test(id)) return fail(res, 'Discord ID ไม่ถูกต้อง');
    if (!db.ROLES.includes(role)) return fail(res, 'ยศไม่ถูกต้อง');
    if (id === req.admin.id) return fail(res, 'ไม่สามารถเปลี่ยนยศของตัวเองได้');
    if (ADMIN_IDS.includes(id)) return fail(res, 'บัญชีนี้ถูกล็อกเป็นแอดมินใน ADMIN_USER_IDS แก้ได้ที่ Render เท่านั้น');
    if (!(await db.setRole(id, role))) return fail(res, 'ไม่พบผู้ใช้', 404);
    await db.logAdmin(`${req.admin.name} (${req.admin.id})`, 'เปลี่ยนยศ', `ผู้ใช้ ${id} -> ${role}`);
    res.json({ success: true });
}));

admin.get('/orders', wrap(async (req, res) => {
    const status = clean(req.query.status, 20), q = clean(req.query.q, 60).toLowerCase();
    const list = Object.values(orders)
        .filter(o => !status || o.status === status)
        .filter(o => !q || [o.id.slice(-6), o.userName, o.userId, o.packageName, o.uid, o.username, o.ign, o.displayName].some(v => v && String(v).toLowerCase().includes(q)))
        .sort((a, b) => b.createdAt - a.createdAt).slice(0, 100)
        .map(o => ({ id: o.id, game: o.game || 'opm', userName: o.userName || '', userId: o.userId || '', packageName: o.packageName, price: o.price, basePrice: o.basePrice || 0, payMethod: o.payMethod || 'voucher', status: o.status, paid: !!o.paid, handledBy: o.handledBy || '', createdAt: o.createdAt }));
    res.json({ success: true, orders: list });
}));

// แพ็กเกจ (รวมที่ปิดขายอยู่) แก้ราคา/เพิ่ม/ลบได้ ราคาในตารางคือราคาปกติ ก่อนลด Reseller
admin.get('/packages', wrap(async (req, res) => {
    res.json({ success: true, packages: await db.listPackages(), discountPct: DISCOUNT_PCT });
}));

function readPackage(body) {
    const game = clean(body.game, 20);
    if (!hasOwn(GAMES, game) || GAMES[game].custom) return { error: 'เกมไม่ถูกต้อง' };
    const name = clean(body.name, 100);
    const qty = Number(body.qty), price = Number(body.price), sort = Number(body.sort ?? 0);
    if (!name) return { error: 'กรุณาใส่ชื่อแพ็กเกจ' };
    if (!Number.isInteger(qty) || qty < 1 || qty > 10000000) return { error: 'จำนวน (qty) ต้องเป็นจำนวนเต็ม 1 ขึ้นไป' };
    if (!Number.isInteger(price) || price < 1 || price > 1000000) return { error: 'ราคาต้องเป็นจำนวนเต็ม 1 - 1,000,000 บาท' };
    if (!Number.isInteger(sort)) return { error: 'ลำดับไม่ถูกต้อง' };
    return { pkg: { game, name, qty, price, sort, note: clean(body.note, 40), tag: clean(body.tag, 40), active: body.active !== false } };
}
async function savePackageAs(req, res, id) {
    const r = readPackage(req.body);
    if (r.error) return fail(res, r.error);
    try {
        await db.savePackage({ ...r.pkg, id });
    } catch (e) {
        if (/unique/i.test(String(e.message))) return fail(res, 'มีแพ็กเกจชื่อนี้ในเกมนี้อยู่แล้ว');
        throw e;
    }
    await loadPackages();
    await db.logAdmin(`${req.admin.name} (${req.admin.id})`, id ? 'แก้แพ็กเกจ' : 'เพิ่มแพ็กเกจ', `${r.pkg.game} / ${r.pkg.name} / ราคา ${r.pkg.price} / ${r.pkg.active ? 'เปิดขาย' : 'ปิดขาย'}`);
    res.json({ success: true });
}
admin.post('/packages', wrap((req, res) => savePackageAs(req, res, null)));
admin.post('/packages/:id', wrap((req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return fail(res, 'ไม่พบแพ็กเกจ');
    return savePackageAs(req, res, id);
}));
admin.post('/packages/:id/delete', wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return fail(res, 'ไม่พบแพ็กเกจ');
    const before = (await db.listPackages()).find(p => p.id === id);
    if (!before) return fail(res, 'ไม่พบแพ็กเกจ', 404);
    await db.deletePackage(id);
    await loadPackages();
    await db.logAdmin(`${req.admin.name} (${req.admin.id})`, 'ลบแพ็กเกจ', `${before.game} / ${before.name} / ราคา ${before.price}`);
    res.json({ success: true });
}));

// โค้ดส่วนลด: ลดเป็น % (1-99) หรือเป็นบาท, จำกัดจำนวนครั้งที่ใช้ได้ (0 = ไม่จำกัด)
function readCode(body, creating) {
    const type = clean(body.type, 10);
    if (!['percent', 'fixed'].includes(type)) return { error: 'ประเภทโค้ดไม่ถูกต้อง' };
    const value = Number(body.value), maxUses = Number(body.maxUses ?? 0);
    if (!Number.isInteger(value) || value < 1 || value > (type === 'percent' ? 99 : 100000)) {
        return { error: type === 'percent' ? 'ลดเป็น % ต้องเป็นจำนวนเต็ม 1 - 99' : 'ลดเป็นบาท ต้องเป็นจำนวนเต็ม 1 - 100,000' };
    }
    if (!Number.isInteger(maxUses) || maxUses < 0 || maxUses > 1000000) return { error: 'จำนวนผู้ใช้ต้องเป็นจำนวนเต็ม 0 ขึ้นไป (0 = ไม่จำกัด)' };
    const c = { type, value, maxUses, active: body.active !== false, note: clean(body.note, 80) };
    if (creating) {
        const code = clean(body.code, 40).toUpperCase();
        if (!/^[A-Z0-9_-]{3,32}$/.test(code)) return { error: 'ชื่อโค้ดใช้ได้เฉพาะ A-Z ตัวเลข _ - ความยาว 3-32 ตัว' };
        c.code = code;
    }
    return { c };
}
const codeDesc = (c) => `${c.code || ''} ${c.type === 'percent' ? c.value + '%' : c.value + ' บาท'} / ${c.maxUses ? c.maxUses + ' คน' : 'ไม่จำกัด'} / ${c.active ? 'เปิด' : 'ปิด'}`.trim();

admin.get('/codes', wrap(async (req, res) => {
    res.json({ success: true, codes: await db.listCodes() });
}));
admin.post('/codes', wrap(async (req, res) => {
    const r = readCode(req.body, true);
    if (r.error) return fail(res, r.error);
    try {
        await db.createCode(r.c);
    } catch (e) {
        if (/unique/i.test(String(e.message))) return fail(res, 'มีโค้ดนี้อยู่แล้ว');
        throw e;
    }
    await db.logAdmin(`${req.admin.name} (${req.admin.id})`, 'สร้างโค้ดส่วนลด', codeDesc(r.c));
    res.json({ success: true });
}));
admin.post('/codes/:id', wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return fail(res, 'ไม่พบโค้ด');
    const r = readCode(req.body, false);
    if (r.error) return fail(res, r.error);
    const before = (await db.listCodes()).find(c => c.id === id);
    if (!before) return fail(res, 'ไม่พบโค้ด', 404);
    await db.updateCode(id, r.c);
    await db.logAdmin(`${req.admin.name} (${req.admin.id})`, 'แก้โค้ดส่วนลด', codeDesc({ ...r.c, code: before.code }));
    res.json({ success: true });
}));
admin.post('/codes/:id/delete', wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return fail(res, 'ไม่พบโค้ด');
    const before = (await db.listCodes()).find(c => c.id === id);
    if (!before) return fail(res, 'ไม่พบโค้ด', 404);
    await db.deleteCode(id);
    await db.logAdmin(`${req.admin.name} (${req.admin.id})`, 'ลบโค้ดส่วนลด', codeDesc(before));
    res.json({ success: true });
}));
admin.get('/codes/:id/uses', wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return fail(res, 'ไม่พบโค้ด');
    res.json({ success: true, uses: await db.listCodeUses(id, 30) });
}));

// ---------- สถิติยอดขาย / ยอดเติมเงิน (ตัดรอบตามเวลาไทย UTC+7 ไม่มีเวลาออมแสง) ----------
// ยอดขาย = ออเดอร์แพ็กเกจเกมที่แอดมินกด "รับเงิน" หรือ "เสร็จสิ้น" แล้ว
// ยอดเติมเงิน = ออเดอร์เติม Point ที่แอดมินรับเงินแล้ว (Point เข้าบัญชีลูกค้าแล้ว)
// เวลาที่ใช้ = เวลาที่แอดมินกดปุ่มล่าสุดของออเดอร์นั้น (updatedAt) ไม่นับออเดอร์ที่ยกเลิกและที่ยังรอตรวจ
const TH_OFFSET = 7 * 3600 * 1000, DAY_MS = 86400000, DAILY_DAYS = 14;
admin.get('/stats', wrap(async (req, res) => {
    const now = Date.now(), nowTh = now + TH_OFFSET, dTh = new Date(nowTh);
    const dayStart = Math.floor(nowTh / DAY_MS) * DAY_MS - TH_OFFSET; // 00:00 วันนี้ (เวลาไทย)
    const starts = {
        day: dayStart,
        week: dayStart - ((dTh.getUTCDay() + 6) % 7) * DAY_MS, // สัปดาห์เริ่มวันจันทร์
        month: Date.UTC(dTh.getUTCFullYear(), dTh.getUTCMonth(), 1) - TH_OFFSET,
        year: Date.UTC(dTh.getUTCFullYear(), 0, 1) - TH_OFFSET,
        all: 0
    };
    const blank = () => ({ sales: 0, salesCount: 0, salesVoucher: 0, salesBalance: 0, byGame: {}, topup: 0, topupCount: 0, topupVoucher: 0, topupBank: 0 });
    const periods = {};
    for (const k of Object.keys(starts)) periods[k] = blank();
    const firstDay = dayStart - (DAILY_DAYS - 1) * DAY_MS;
    const daily = Array.from({ length: DAILY_DAYS }, (_, i) => ({ date: new Date(firstDay + i * DAY_MS + TH_OFFSET).toISOString().slice(0, 10), sales: 0, topup: 0 }));
    const pending = { sales: 0, topup: 0 };
    for (const o of Object.values(orders)) {
        const game = o.game || 'opm', isTopup = game === 'points';
        if (o.status === 'checking') { pending[isTopup ? 'topup' : 'sales']++; continue; }
        const counted = isTopup ? o.status === 'done' : (o.status === 'received' || o.status === 'done');
        if (!counted) continue;
        const t = Number(o.updatedAt || o.createdAt) || 0, price = Number(o.price) || 0;
        const viaBalance = o.payMethod === 'balance', viaBank = o.payMethod === 'bank';
        for (const k of Object.keys(starts)) {
            if (t < starts[k]) continue;
            const p = periods[k];
            if (isTopup) {
                p.topup += price; p.topupCount++;
                if (viaBank) p.topupBank += price; else p.topupVoucher += price;
            } else {
                p.sales += price; p.salesCount++;
                if (viaBalance) p.salesBalance += price; else p.salesVoucher += price;
                const g = (p.byGame[game] = p.byGame[game] || { sales: 0, count: 0 });
                g.sales += price; g.count++;
            }
        }
        const i = Math.floor((t - firstDay) / DAY_MS);
        if (i >= 0 && i < DAILY_DAYS) daily[i][isTopup ? 'topup' : 'sales'] += price;
    }
    res.json({ success: true, periods, daily, pending, generatedAt: now });
}));

admin.get('/log', wrap(async (req, res) => {
    res.json({ success: true, log: await db.getAdminLog(80) });
}));
app.use('/api/admin', admin);

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
        const seeded = await db.seedPackages(seedList());
        if (seeded) console.log(`ใส่แพ็กเกจตั้งต้นลงฐานข้อมูล ${seeded} รายการ`);
        await loadPackages();
        await importLegacyOrders();
        console.log(`โหลดออเดอร์จากฐานข้อมูล ${Object.keys(orders).length} รายการ | ล็อกอิน Discord: ${AUTH_ON ? 'เปิด' : 'ปิด (ยังไม่ตั้งค่า)'} | โอนธนาคาร: ${BANK_ON ? 'เปิด' : 'ปิด (ยังไม่ตั้งค่า BANK_*)'}`);
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
