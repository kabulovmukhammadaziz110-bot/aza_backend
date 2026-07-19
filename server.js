/**
 * AZA — backend with a shared skin market (managed from your Telegram bot AND
 * from the site's admin panel) plus the order-confirmation flow.
 *
 * ── Setup ────────────────────────────────────────────────────────────────────
 * 1. A .env file with your BOT_TOKEN, ADMIN_CHAT_ID, ADMIN_TOKEN and PORT should
 *    sit next to this file (already created for you — never share it, add it to
 *    .gitignore, and don't paste real tokens in chat again — rotate any token
 *    that's ever been shared this way via @BotFather > your bot > API Token >
 *    Revoke current token).
 * 2. Deploy this file somewhere with HTTPS (Render, Railway, Fly.io, a VPS...).
 * 3. Set the webhook once:
 *    https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://your-domain.com/webhook
 * 4. In java.js set: const API_BASE = "https://your-domain.com";
 * 5. In @BotFather: /mybots -> your bot -> Bot Settings -> Menu Button -> set your
 *    site's HTTPS URL, so tapping "Start" opens the site as a Telegram Mini App.
 *
 * Install: npm install express node-fetch dotenv
 * Run:     node server.js   (reads BOT_TOKEN / ADMIN_CHAT_ID / ADMIN_TOKEN / PORT from .env)
 *
 * Bot commands (only work when sent from ADMIN_CHAT_ID — everyone else is ignored):
 *   /qoshish    — add a new skin, step by step
 *   /bekor      — cancel the add flow currently in progress
 *   /royxat     — list current skins with their position number
 *   /ochirish N — delete the Nth skin from the last /royxat you sent
 */

require("dotenv").config();
const fs = require("fs");
const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

// Allow the site to call this API from any origin (needed since index.html is
// served separately, e.g. from Live Server on 127.0.0.1:5500 or from Netlify/Vercel).
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, x-admin-token, ngrok-skip-browser-warning");
  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  if(req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const ADMIN_CHAT_ID = String(process.env.ADMIN_CHAT_ID || "");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const DB_FILE = "./aza-data.json";
const CATEGORIES = ["rifle","sniper","pistol","smg","shotgun","knife"];

// ---------- Tiny JSON-file database ----------
function loadDB(){
  try{ return JSON.parse(fs.readFileSync(DB_FILE, "utf8")); }
  catch(e){
    return {
      nextSkinId: 4,
      skins: [
        {id:"1", weapon:"AK-47", name:"Redline", rarity:"classified", wear:"Field-Tested", price:"$42.30", category:"rifle"},
        {id:"2", weapon:"AWP", name:"Asiimov", rarity:"covert", wear:"Battle-Scarred", price:"$118.00", category:"sniper"},
        {id:"3", weapon:"Karambit", name:"Doppler", rarity:"gold", wear:"Factory New", price:"$620.00", category:"knife"},
      ],
    };
  }
}
function saveDB(db){ fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
let db = loadDB();

// ---------- Admin auth for the site's admin panel ----------
function requireAdmin(req, res, next){
  if(!ADMIN_TOKEN || req.get("x-admin-token") !== ADMIN_TOKEN){
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

// ---------- Skin market endpoints ----------
app.get("/api/skins", (req, res) => res.json(db.skins));

app.post("/api/skins", requireAdmin, (req, res) => {
  const { weapon, name, rarity, wear, price, category } = req.body || {};
  if(!weapon || !name || !price) return res.status(400).json({ error: "weapon, name, price shart" });
  const skin = {
    id: String(db.nextSkinId++), weapon, name,
    rarity: rarity || "consumer", wear: wear || "Field-Tested", price,
    category: CATEGORIES.includes(category) ? category : "rifle",
  };
  db.skins.push(skin);
  saveDB(db);
  res.json(skin);
});

app.delete("/api/skins/:id", requireAdmin, (req, res) => {
  db.skins = db.skins.filter(s => s.id !== req.params.id);
  saveDB(db);
  res.json({ ok: true });
});

// ---------- Orders (checkout -> Telegram approval) ----------
const orders = new Map();
let nextOrderId = 1;

async function tg(method, payload){
  return fetch(`${TG_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).then(r => r.json());
}

app.post("/api/order", async (req, res) => {
  const { product, price } = req.body || {};
  if(!product || !price) return res.status(400).json({ error: "product va price shart" });

  const id = String(nextOrderId++);
  orders.set(id, { id, product, price, status: "pending" });

  await tg("sendMessage", {
    chat_id: ADMIN_CHAT_ID,
    text: `🆕 Yangi buyurtma #${id}\nMahsulot: ${product}\nNarxi: ${price}\n\nXaridor to'lov qilganini tasdiqladi. Kartani tekshirib javob bering.`,
    reply_markup: { inline_keyboard: [[
      { text: "✅ Tasdiqlash", callback_data: `confirm:${id}` },
      { text: "❌ Bekor qilish", callback_data: `reject:${id}` },
    ]] },
  });

  res.json({ id });
});

app.get("/api/order/:id", (req, res) => {
  const order = orders.get(req.params.id);
  if(!order) return res.status(404).json({ error: "topilmadi" });
  res.json(order);
});

// ---------- Telegram webhook: order buttons + admin bot commands ----------
const RARITIES = ["consumer","milspec","restricted","classified","covert","gold"];
const WEARS = ["Factory New","Minimal Wear","Field-Tested","Well-Worn","Battle-Scarred"];
let addFlow = null;   // { step, weapon, name, rarity, wear, price, category }
let lastList = [];    // ids in the order they were last shown by /royxat

app.post("/webhook", async (req, res) => {
  const body = req.body || {};

  if(body.callback_query){
    const cb = body.callback_query;
    const [action, id] = (cb.data || "").split(":");
    const order = orders.get(id);
    if(order) order.status = action === "confirm" ? "confirmed" : "rejected";
    await tg("answerCallbackQuery", {
      callback_query_id: cb.id,
      text: action === "confirm" ? "Tasdiqlandi" : "Bekor qilindi",
    });
    return res.sendStatus(200);
  }

  const msg = body.message;
  if(!msg || String(msg.chat.id) !== ADMIN_CHAT_ID) return res.sendStatus(200);
  const text = (msg.text || "").trim();
  async function send(t){ await tg("sendMessage", { chat_id: ADMIN_CHAT_ID, text: t }); }

  if(text === "/start"){
    await send("Salom! Bu AZA admin boti.\n/qoshish — yangi skin qo'shish\n/royxat — joriy skinlar\n/ochirish N — o'chirish");
  } else if(text === "/qoshish"){
    addFlow = { step: "weapon" };
    await send("Yangi skin qo'shamiz.\nQurol nomini yozing (masalan: AK-47):");
  } else if(text === "/bekor"){
    addFlow = null;
    await send("Bekor qilindi.");
  } else if(text === "/royxat"){
    lastList = db.skins.map(s => s.id);
    if(!db.skins.length){ await send("Market bo'sh."); }
    else{
      const lines = db.skins.map((s,i) => `${i+1}. ${s.weapon} | ${s.name} — ${s.price} [${s.rarity}]`);
      await send(lines.join("\n") + "\n\nO'chirish uchun: /ochirish <raqam>");
    }
  } else if(text.startsWith("/ochirish")){
    const n = parseInt(text.split(" ")[1], 10);
    const id = lastList[n - 1];
    if(!id){ await send("Avval /royxat yuboring, keyin shu ro'yxatdagi raqamni yozing."); }
    else{
      db.skins = db.skins.filter(s => s.id !== id);
      saveDB(db);
      await send(`O'chirildi: #${n}`);
    }
  } else if(addFlow){
    const f = addFlow;
    if(f.step === "weapon"){ f.weapon = text; f.step = "name"; await send("Skin nomini yozing (masalan: Redline):"); }
    else if(f.step === "name"){ f.name = text; f.step = "rarity"; await send(`Rarity darajasini yozing (${RARITIES.join(", ")}):`); }
    else if(f.step === "rarity"){
      if(!RARITIES.includes(text)){ await send(`Noto'g'ri. Quyidagilardan birini yozing: ${RARITIES.join(", ")}`); }
      else{ f.rarity = text; f.step = "wear"; await send(`Wear holatini yozing (${WEARS.join(", ")}):`); }
    }
    else if(f.step === "wear"){
      if(!WEARS.includes(text)){ await send(`Noto'g'ri. Quyidagilardan birini yozing: ${WEARS.join(", ")}`); }
      else{ f.wear = text; f.step = "price"; await send("Narxini yozing (masalan: $42.30):"); }
    }
    else if(f.step === "price"){ f.price = text; f.step = "category"; await send(`Turkumini yozing (${CATEGORIES.join(", ")}):`); }
    else if(f.step === "category"){
      if(!CATEGORIES.includes(text)){ await send(`Noto'g'ri. Quyidagilardan birini yozing: ${CATEGORIES.join(", ")}`); }
      else{
        const skin = { id: String(db.nextSkinId++), weapon: f.weapon, name: f.name, rarity: f.rarity, wear: f.wear, price: f.price, category: text };
        db.skins.push(skin);
        saveDB(db);
        addFlow = null;
        await send(`Qo'shildi ✅\n${skin.weapon} | ${skin.name} — ${skin.price}`);
      }
    }
  }

  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AZA backend ${PORT}-portda ishlamoqda`));