require('dotenv').config();
const express = require('express');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
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

if (!BOT_TOKEN || !CHANNEL_ID) {
    console.error('ไม่พบ DISCORD_BOT_TOKEN หรือ DISCORD_CHANNEL_ID ในไฟล์ .env');
    process.exit(1);
}

// ราคาแพ็กเกจอยู่ฝั่งเซิร์ฟเวอร์เท่านั้น (ชื่อต้องตรงกับที่หน้าเว็บส่งมา)
const PACKAGES = {
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
};
// ================================================================

// ---------- เก็บออเดอร์ลงไฟล์ orders.json ----------
const ORDERS_FILE = path.join(__dirname, 'orders.json');
let orders = {};
try {
    if (fs.existsSync(ORDERS_FILE)) orders = JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8'));
} catch (e) {
    console.error('อ่าน orders.json ไม่สำเร็จ เริ่มด้วยรายการว่าง:', e.message);
    orders = {};
}
function saveOrders() {
    try {
        const tmp = ORDERS_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(orders, null, 2));
        fs.renameSync(tmp, ORDERS_FILE);
    } catch (e) {
        console.error('บันทึก orders.json ไม่สำเร็จ:', e.message);
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
const isFinal = (s) => s === 'done' || s === 'insufficient';

// ---------- Discord bot ----------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const STATUS = {
    checking:     { color: 0xF59E0B, text: '🕑 รอตรวจสอบซอง' },
    received:     { color: 0x3B82F6, text: '💰 รับเงินแล้ว รอเติมตามคิว' },
    done:         { color: 0x57F287, text: '✅ เติมเสร็จสิ้น' },
    insufficient: { color: 0xED4245, text: '⚠️ ยอดเงินไม่เพียงพอ' }
};

function buildMessage(o) {
    const s = STATUS[o.status];
    const embed = new EmbedBuilder()
        .setTitle(`🧾 ออเดอร์ #${o.id.slice(-6).toUpperCase()}`)
        .setColor(s.color)
        .addFields(
            { name: '📌 สถานะ', value: s.text, inline: false },
            { name: '🎮 UID', value: `\`${o.uid}\``, inline: true },
            { name: '🌐 Server ID', value: `\`${o.sid || '-'}\``, inline: true },
            { name: '📘 Facebook', value: o.facebook || '-', inline: false },
            { name: '📦 แพ็กเกจ', value: o.packageName, inline: true },
            { name: '💰 ยอดที่ต้องได้รับ', value: `**${o.price.toLocaleString('en-US')} บาท**`, inline: true }
        )
        .setFooter({ text: o.handledBy ? `ล่าสุดโดย ${o.handledBy}` : 'รอแอดมินดำเนินการ' })
        .setTimestamp(new Date(o.updatedAt));

    if (o.dupOf) {
        embed.addFields({ name: '⚠️ ลิงก์ซองซ้ำ', value: `ลิงก์นี้เคยถูกส่งมาแล้วในออเดอร์ #${o.dupOf.slice(-6).toUpperCase()} (ซองรับได้ครั้งเดียว)`, inline: false });
    }

    // แสดงลิงก์ซองเฉพาะตอนยังรอตรวจสอบ (หลังรับซองแล้วลิงก์ใช้ไม่ได้อยู่แล้ว)
    if (o.status === 'checking') {
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
    if (o.status === 'checking') {
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

        order.status = action;
        order.updatedAt = Date.now();
        order.handledBy = interaction.user.globalName || interaction.user.username;
        saveOrders();
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
    const uid = clean(req.body.uid, 50);
    const sid = clean(req.body.sid, 20);
    const facebook = clean(req.body.facebook, 200);
    const packageName = clean(req.body.packageName, 100);
    const voucherLink = clean(req.body.voucherLink, 300);

    if (!uid || !facebook || !packageName || !voucherLink) {
        return res.status(400).json({ success: false, message: 'กรุณากรอกข้อมูล (UID, Facebook, แพ็กเกจ และลิงก์ซอง) ให้ครบถ้วน' });
    }

    // ราคามาจากตารางฝั่งเซิร์ฟเวอร์ ไม่เชื่อค่า expectedPrice ที่ลูกค้าส่งมา
    if (!Object.prototype.hasOwnProperty.call(PACKAGES, packageName)) {
        return res.status(400).json({ success: false, message: 'แพ็กเกจไม่ถูกต้อง' });
    }
    const price = PACKAGES[packageName];

    const voucherCode = parseVoucher(voucherLink);
    if (!voucherCode) {
        return res.status(400).json({ success: false, message: 'ลิงก์ซองไม่ถูกต้อง ต้องเป็นลิงก์จาก gift.truemoney.com' });
    }

    // ส่งลิงก์ซองเดิมซ้ำได้ ไม่ปฏิเสธ แต่จะมีคำเตือนในข้อความ Discord ให้แอดมินเห็น
    const dupOf = Object.values(orders).find(o => o.voucherCode === voucherCode);

    const id = crypto.randomBytes(12).toString('hex');
    const now = Date.now();
    const order = { id, uid, sid, facebook, packageName, price, voucherCode, status: 'checking', createdAt: now, updatedAt: now };
    if (dupOf) order.dupOf = dupOf.id;

    // เก็บก่อนส่ง Discord ถ้าส่งไม่ผ่านค่อยลบทิ้ง
    orders[id] = order;
    try {
        const channel = await client.channels.fetch(CHANNEL_ID);
        const msg = await channel.send(buildMessage(order));
        order.messageId = msg.id;
        saveOrders();
    } catch (e) {
        delete orders[id];
        console.error('ส่งออเดอร์เข้า Discord ไม่สำเร็จ:', e.message);
        return res.status(502).json({ success: false, message: 'ระบบแจ้งเตือนแอดมินขัดข้อง กรุณาลองใหม่อีกครั้ง (ซองของคุณยังไม่ถูกใช้)' });
    }

    return res.json({
        success: true,
        orderId: id,
        message: 'ส่งออเดอร์แล้ว กำลังตรวจสอบลิงก์ซอง'
    });
});

// หน้าเว็บเช็กสถานะออเดอร์ (ส่งกลับเฉพาะข้อมูลที่ลูกค้าควรเห็น ไม่ส่งลิงก์ซอง)
app.get('/api/order/:id', statusLimiter, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const order = ID_RE.test(req.params.id) ? orders[req.params.id] : null;
    if (!order) return res.status(404).json({ success: false, message: 'ไม่พบออเดอร์' });
    return res.json({
        success: true,
        status: order.status,
        packageName: order.packageName,
        price: order.price,
        updatedAt: order.updatedAt
    });
});

client.login(BOT_TOKEN)
    .then(() => {
        app.listen(PORT, () => console.log(`Server is running at http://localhost:${PORT}`));
    })
    .catch((e) => {
        console.error('เข้าสู่ระบบ Discord bot ไม่สำเร็จ (ตรวจ DISCORD_BOT_TOKEN):', e.message);
        process.exit(1);
    });
