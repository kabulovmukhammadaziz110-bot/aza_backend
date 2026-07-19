/**
 * AZA — backend with a shared skin market stored in Supabase (persists forever,
 * survives Render restarts/redeploys) managed from your Telegram bot AND from
 * the site's admin panel, plus the order-confirmation flow.
 *
 * ── Setup ────────────────────────────────────────────────────────────────────
 * 1. A .env file next to this file should contain:
 *      BOT_TOKEN=...
 *      ADMIN_CHAT_ID=...
 *      ADMIN_TOKEN=...
 *      SUPABASE_URL=https://xxxxxxxx.supabase.co
 *      SUPABASE_SERVICE_KEY=your service_role / secret key
 *    Never share this file or paste real keys in chat again.
 * 2. In Supabase, table "skins" (public schema), RLS disabled, columns:
 *    weapon text, name text, rarity text, wear text, price text,
 *    category text, image text (id/created_at are automatic).
 * 3. Deploy this file somewhere with HTTPS (Render, Railway, Fly.io...), with
 *    the same env vars set in that host's Environment Variables section.
 * 4. Set the webhook once:
 *    https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://your-domain.com/webhook
 * 5. In java.js set: const API_BASE = "https://your-domain.com";
 *
 * Install: npm install express node-fetch dotenv
 * Run:     node server.js
 *
 * Bot commands (only work when sent from ADMIN_CHAT_ID — everyone else is ignored):
 *   /qoshish    — add a new skin, step by step
 *   /bekor      — cancel the add flow currently in progress
 *   /royxat     — list current skins with their position number
 *   /ochirish N — delete the Nth skin from the last /royxat you sent
 *   /rasm N link — attach/replace the image on the Nth skin from the last /royxat
 */

require("dotenv").config();
const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, x-admin-token, ngrok-skip-browser-warning");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  if(req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const ADMIN_CHAT_ID = String(process.env.ADMIN_CHAT_ID || "");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const CATEGORIES = ["rifle","sniper","pistol","smg","shotgun","knife"];

// ---------- Supabase (Postgres via REST) helpers ----------
async function sb(path, options = {}){
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      "apikey": SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  try{ data = text ? JSON.parse(text) : null; }catch(e){ data = text; }
  if(!res.ok) throw new Error(typeof data === "object" ? JSON.stringify(data) : String(data));
  return data;
}

async function getSkins(){
  return sb("skins?select=*&order=id.asc");
}
async function addSkin(fields){
  const row = {
    weapon: fields.weapon, name: fields.name,
    rarity: fields.rarity || "consumer", wear: fields.wear || "Field-Tested",
    price: fields.price, category: CATEGORIES.includes(fields.category) ? fields.category : "rifle",
    image: fields.image || "",
  };
  const inserted = await sb("skins", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify([row]),
  });
  return inserted[0];
}
async function deleteSkinById(id){
  await sb(`skins?id=eq.${id}`, { method: "DELETE" });
}
async function updateSkinById(id, fields){
  const updated = await sb(`skins?id=eq.${id}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(fields),
  });
  return updated[0];
}

// ---------- Admin auth for the site's admin panel ----------
function requireAdmin(req, res, next){
  if(!ADMIN_TOKEN || req.get("x-admin-token") !== ADMIN_TOKEN){
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

// ---------- Skin market endpoints ----------
app.get("/api/skins", async (req, res) => {
  try{ res.json(await getSkins()); }
  catch(e){ res.status(500).json({ error: "supabase error", detail: String(e) }); }
});

app.post("/api/skins", requireAdmin, async (req, res) => {
  const { weapon, name, price } = req.body || {};
  if(!weapon || !name || !price) return res.status(400).json({ error: "weapon, name, price shart" });
  try{ res.json(await addSkin(req.body)); }
  catch(e){ res.status(500).json({ error: "supabase error", detail: String(e) }); }
});

app.delete("/api/skins/:id", requireAdmin, async (req, res) => {
  try{ await deleteSkinById(req.params.id); res.json({ ok: true }); }
  catch(e){ res.status(500).json({ error: "supabase error", detail: String(e) }); }
});

app.put("/api/skins/:id", requireAdmin, async (req, res) => {
  try{
    const updated = await updateSkinById(req.params.id, req.body || {});
    if(!updated) return res.status(404).json({ error: "topilmadi" });
    res.json(updated);
  }catch(e){ res.status(500).json({ error: "supabase error", detail: String(e) }); }
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
  const { product, price, tradeUrl, telegramUsername, telegramId } = req.body || {};
  if(!product || !price) return res.status(400).json({ error: "product va price shart" });

  const id = String(nextOrderId++);
  orders.set(id, { id, product, price, status: "pending" });

  let deliveryLines = "";
  if(tradeUrl) deliveryLines += `\nSteam Trade URL: ${tradeUrl}`;
  if(telegramUsername) deliveryLines += `\nTelegram (Premium): ${telegramUsername}`;
  if(telegramId) deliveryLines += `\nTelegram (Stars): ${telegramId}`;

  await tg("sendMessage", {
    chat_id: ADMIN_CHAT_ID,
    text: `🆕 Yangi buyurtma #${id}\nMahsulot: ${product}\nNarxi: ${price}${deliveryLines}\n\nXaridor to'lov qilganini tasdiqladi. Kartani tekshirib javob bering.`,
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

  try{
    if(text === "/start"){
      await send("Salom! Bu AZA admin boti.\n/qoshish — yangi skin qo'shish\n/royxat — joriy skinlar\n/ochirish N — o'chirish\n/rasm N <link> — N-skinga rasm qo'shish/almashtirish");
    } else if(text === "/qoshish"){
      addFlow = { step: "weapon" };
      await send("Yangi skin qo'shamiz.\nQurol nomini yozing (masalan: AK-47):");
    } else if(text === "/bekor"){
      addFlow = null;
      await send("Bekor qilindi.");
    } else if(text === "/royxat"){
      const skins = await getSkins();
      lastList = skins.map(s => s.id);
      if(!skins.length){ await send("Market bo'sh."); }
      else{
        const lines = skins.map((s,i) => `${i+1}. ${s.weapon} | ${s.name} — ${s.price} [${s.rarity}]`);
        await send(lines.join("\n") + "\n\nO'chirish: /ochirish <raqam>\nRasm qo'shish: /rasm <raqam> <link>");
      }
    } else if(text.startsWith("/ochirish")){
      const n = parseInt(text.split(" ")[1], 10);
      const id = lastList[n - 1];
      if(!id){ await send("Avval /royxat yuboring, keyin shu ro'yxatdagi raqamni yozing."); }
      else{ await deleteSkinById(id); await send(`O'chirildi: #${n}`); }
    } else if(text.startsWith("/rasm")){
      const parts = text.split(" ");
      const n = parseInt(parts[1], 10);
      const url = parts.slice(2).join(" ").trim();
      const id = lastList[n - 1];
      if(!id){ await send("Avval /royxat yuboring, keyin: /rasm <raqam> <rasm-link>"); }
      else if(!url){ await send("Rasm linkini ham yozing: /rasm <raqam> <rasm-link>"); }
      else{
        const updated = await updateSkinById(id, { image: url });
        await send(`Rasm qo'shildi: #${n} — ${updated.weapon} | ${updated.name}`);
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
        else{ f.category = text; f.step = "image"; await send("Rasm linkini yuboring (masalan https://...), yoki rasm bo'lmasa '-' deb yozing:"); }
      }
      else if(f.step === "image"){
        const skin = await addSkin({ ...f, image: text === "-" ? "" : text });
        addFlow = null;
        await send(`Qo'shildi ✅\n${skin.weapon} | ${skin.name} — ${skin.price}`);
      }
    }
  }catch(e){
    await send("Xatolik yuz berdi: " + String(e).slice(0, 300));
  }

  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AZA backend v4 (Supabase) ${PORT}-portda ishlamoqda`));
