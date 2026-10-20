import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "8836824957:AAEUErReukk759X0Jg9F--pNKMe66cMWU5E";
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const SYSTEM =
  process.env.SYSTEM_PROMPT ||
  "You are Astra, a precise, capable AI assistant. Be clear and direct. Use Markdown, and fenced code blocks with a language tag for code. You can read images, PDFs, audio, video and text files the user attaches.";
const DAY = 864e5;

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(express.json({ limit: "30mb" }));
app.use((_, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "frame-ancestors 'self' https://web.telegram.org https://*.telegram.org",
    "Referrer-Policy": "no-referrer",
  });
  next();
});
app.use(express.static(path.join(__dirname, "public")));
app.get("/healthz", (_, res) => res.json({ ok: true }));

/* ---------- sessions (signed cookie, no database) ---------- */
const mac = (s) => crypto.createHmac("sha256", SECRET).update(s).digest("base64url");
const mint = (u) => {
  const p = Buffer.from(JSON.stringify({ ...u, exp: Date.now() + 30 * DAY })).toString("base64url");
  return p + "." + mac(p);
};
function readUser(req) {
  const c = (req.headers.cookie || "").split(";").map((x) => x.trim()).find((x) => x.startsWith("astra="));
  const bearer = (req.headers.authorization || "").replace(/^Bearer /, "");
  const [p, m] = (c ? c.slice(6) : bearer).split(".");
  if (!p || !m) return null;
  const a = Buffer.from(m), b = Buffer.from(mac(p));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const u = JSON.parse(Buffer.from(p, "base64url").toString());
    return u.exp > Date.now() ? u : null;
  } catch { return null; }
}
const needAuth = (req, res, next) => {
  req.user = readUser(req);
  req.user ? next() : res.status(401).json({ error: "Please sign in." });
};

/* ---------- rate limiting ---------- */
const hits = new Map();
const limit = (max, tag, id) => (req, res, next) => {
  const k = `${tag}:${id(req)}`, t = Date.now(), h = hits.get(k);
  if (!h || t > h.reset) hits.set(k, { n: 1, reset: t + 60000 });
  else if (++h.n > max) return res.status(429).json({ error: "Too many requests. Wait a minute and try again." });
  next();
};
setInterval(() => hits.forEach((v, k) => Date.now() > v.reset && hits.delete(k)), 60000).unref();

function startSession(req, res, u) {
  const token = mint(u);
  // SameSite=None lets the cookie work inside Telegram's web frame; the bearer token covers blocked third-party cookies
  res.cookie("astra", token, { httpOnly: true, sameSite: req.secure ? "none" : "lax", secure: req.secure, maxAge: 30 * DAY });
  return { ...u, token };
}

/* ---------- auth routes ---------- */
app.get("/api/config", (_, res) => res.json({ clientId: CLIENT_ID, telegram: !!BOT_TOKEN }));
app.get("/api/me", (req, res) => {
  const u = readUser(req);
  u ? res.json({ sub: u.sub, name: u.name, given: u.given, email: u.email, picture: u.picture }) : res.status(401).json({});
});
app.post("/api/auth/google", limit(15, "auth", (r) => r.ip), async (req, res) => {
  if (!CLIENT_ID) return res.status(500).json({ error: "GOOGLE_CLIENT_ID is not set on the server." });
  const cred = String(req.body?.credential || "");
  if (!cred) return res.status(400).json({ error: "Missing credential." });
  try {
    const r = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(cred));
    const j = await r.json();
    const okIss = ["accounts.google.com", "https://accounts.google.com"].includes(j.iss);
    if (!r.ok || j.aud !== CLIENT_ID || !okIss || String(j.email_verified) !== "true")
      return res.status(401).json({ error: "Google sign-in could not be verified." });
    const u = { sub: j.sub, name: j.name || j.email, given: j.given_name || "", email: j.email, picture: j.picture || "" };
    res.json(startSession(req, res, u));
  } catch { res.status(502).json({ error: "Could not reach Google to verify sign-in." }); }
});
app.post("/api/auth/telegram", limit(15, "auth", (r) => r.ip), (req, res) => {
  if (!BOT_TOKEN) return res.status(500).json({ error: "TELEGRAM_BOT_TOKEN is not set on the server." });
  const p = new URLSearchParams(String(req.body?.initData || ""));
  const hash = p.get("hash");
  p.delete("hash");
  const check = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const key = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const calc = crypto.createHmac("sha256", key).update(check).digest("hex");
  const ok = hash && hash.length === calc.length && crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(calc));
  if (!ok || Date.now() / 1000 - Number(p.get("auth_date")) > 86400)
    return res.status(401).json({ error: "Telegram sign-in could not be verified." });
  let t;
  try { t = JSON.parse(p.get("user")); } catch { return res.status(400).json({ error: "Invalid Telegram user." }); }
  const u = {
    sub: "tg" + t.id,
    name: [t.first_name, t.last_name].filter(Boolean).join(" ") || "Telegram user",
    given: t.first_name || "",
    email: t.username ? "@" + t.username : "Telegram",
    picture: t.photo_url || "",
  };
  res.json(startSession(req, res, u));
});
app.post("/api/logout", (_, res) => { res.clearCookie("astra"); res.json({ ok: true }); });

/* ---------- chat ---------- */
app.post("/api/chat", needAuth, limit(30, "chat", (r) => r.user.sub), async (req, res) => {
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: "GEMINI_API_KEY is not set on the server." });

  const raw = Array.isArray(req.body?.messages) ? req.body.messages.slice(-40) : [];
  const contents = [];
  let budget = 18e6; // keeps inline data under Gemini's request limit; newest files win
  for (let i = raw.length - 1; i >= 0; i--) {
    const m = raw[i];
    if (!["user", "assistant"].includes(m?.role)) continue;
    const parts = [];
    if (m.role === "user")
      for (const f of Array.isArray(m.files) ? m.files.slice(0, 4) : []) {
        if (typeof f?.data !== "string") continue;
        const nm = String(f.name || "file").slice(0, 120), type = String(f.type || "");
        if (f.kind === "text") parts.push({ text: `File "${nm}":\n${f.data.slice(0, 200000)}` });
        else if (/^(image|audio|video)\/|^application\/pdf$/.test(type) && budget >= f.data.length) {
          budget -= f.data.length;
          parts.push({ inlineData: { mimeType: type, data: f.data } });
        }
      }
    if (typeof m.content === "string" && m.content.trim()) parts.push({ text: m.content.slice(0, 20000) });
    if (parts.length) contents.unshift({ role: m.role === "assistant" ? "model" : "user", parts });
  }
  while (contents[0]?.role === "model") contents.shift();
  if (!contents.length || contents.at(-1).role !== "user")
    return res.status(400).json({ error: "Send a message or attach a file." });

  const name = String(req.body?.name || "").replace(/[^\p{L}\p{N} .'-]/gu, "").slice(0, 40).trim();
  const system = SYSTEM + (name ? ` The user's name is "${name}". Address them by name occasionally and naturally.` : "");

  const ac = new AbortController();
  res.on("close", () => ac.abort());

  let up;
  try {
    up = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:streamGenerateContent?alt=sse`,
      {
        method: "POST",
        signal: ac.signal,
        headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents,
          generationConfig: { maxOutputTokens: 4096 },
        }),
      }
    );
  } catch {
    return res.status(502).json({ error: "Could not reach the Gemini API." });
  }
  if (!up.ok) {
    console.error("Upstream", up.status, await up.text());
    return res.status(502).json({ error: `Gemini API error (${up.status}). Check your API key, model name and file types.` });
  }

  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
  res.flushHeaders();

  const dec = new TextDecoder();
  let buf = "";
  try {
    for await (const chunk of up.body) {
      buf += dec.decode(chunk, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const l of lines) {
        if (!l.startsWith("data:")) continue;
        try {
          const j = JSON.parse(l.slice(5));
          const t = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
          if (t) res.write(`data: ${JSON.stringify({ t })}\n\n`);
        } catch {}
      }
    }
  } catch {}
  res.write("data: [DONE]\n\n");
  res.end();
});

app.listen(PORT, () => console.log(`Astra Chatbot running on :${PORT}`));
