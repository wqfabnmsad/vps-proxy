// Messaging Proxy — runs on a VPS with a routable/static IP.
// Lovable's server functions call THIS service when a provider blocks direct
// outbound connections from the published app runtime.
//
// Environment variables:
//   PROXY_SECRET    (required)  shared secret. Caller must send X-Proxy-Secret.
//   PORT            (optional)  default 3000
//   ALLOWED_HOSTS   (optional)  comma-separated upstream hosts. default: api.taqnyat.sa,smtp.hostinger.com
//
// Endpoints:
//   GET  /health        → { ok: true } (no auth, for Coolify health checks)
//   POST /sms/send      → forwards to https://api.taqnyat.sa/v1/messages
//                         body: { to: string[], body: string, sender: string, authToken: string }
//   GET  /sms/balance   → forwards to https://api.taqnyat.sa/account/balance
//                         header: X-Auth-Token: <bearer>
//   POST /smtp/send     → sends email through an allowed SMTP host

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import nodemailer from "nodemailer";

const PROXY_SECRET = process.env.PROXY_SECRET;
const PORT = Number(process.env.PORT || 3000);
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || "api.taqnyat.sa,smtp.hostinger.com")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!PROXY_SECRET || PROXY_SECRET.length < 16) {
  console.error("[fatal] PROXY_SECRET env var is required and must be >= 16 chars.");
  process.exit(1);
}

const TAQNYAT_BASE = "https://api.taqnyat.sa";
if (!ALLOWED_HOSTS.includes(new URL(TAQNYAT_BASE).host)) {
  console.error(`[fatal] ALLOWED_HOSTS must include ${new URL(TAQNYAT_BASE).host}`);
  process.exit(1);
}

const app = new Hono();

// ---- middleware: auth (skips /health) ----
app.use("*", async (c, next) => {
  if (c.req.path === "/health") return next();
  const provided = c.req.header("x-proxy-secret") || "";
  // constant-time-ish compare
  if (provided.length !== PROXY_SECRET.length) {
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }
  let diff = 0;
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ PROXY_SECRET.charCodeAt(i);
  }
  if (diff !== 0) return c.json({ ok: false, error: "unauthorized" }, 401);
  return next();
});

app.get("/health", (c) => c.json({ ok: true, service: "messaging-proxy", time: new Date().toISOString() }));

app.post("/sms/send", async (c) => {
  let payload;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "invalid_json" }, 400);
  }
  const { to, body, sender, authToken } = payload || {};
  if (!authToken || typeof authToken !== "string") return c.json({ ok: false, error: "authToken required" }, 400);
  if (!sender || typeof sender !== "string") return c.json({ ok: false, error: "sender required" }, 400);
  if (!body || typeof body !== "string") return c.json({ ok: false, error: "body required" }, 400);
  if (!Array.isArray(to) || to.length === 0) return c.json({ ok: false, error: "to[] required" }, 400);

  const started = Date.now();
  const res = await fetch(`${TAQNYAT_BASE}/v1/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${authToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ recipients: to, body, sender }),
  });
  const text = await res.text();
  console.log(`[sms/send] recipients=${to.length} status=${res.status} ${Date.now() - started}ms`);
  return new Response(text, {
    status: res.status,
    headers: { "Content-Type": res.headers.get("content-type") || "application/json" },
  });
});

app.get("/sms/balance", async (c) => {
  const authToken = c.req.header("x-auth-token");
  if (!authToken) return c.json({ ok: false, error: "X-Auth-Token required" }, 400);
  const res = await fetch(`${TAQNYAT_BASE}/account/balance`, {
    headers: { Authorization: `Bearer ${authToken}`, Accept: "application/json" },
  });
  const text = await res.text();
  console.log(`[sms/balance] status=${res.status}`);
  return new Response(text, {
    status: res.status,
    headers: { "Content-Type": res.headers.get("content-type") || "application/json" },
  });
});

// Forwards OTP verify.php calls (used by requestOtp / verifyOtp).
// Body is forwarded verbatim; Authorization Bearer is built from { authToken }.
app.post("/sms/verify", async (c) => {
  let payload;
  try { payload = await c.req.json(); } catch { return c.json({ ok: false, error: "invalid_json" }, 400); }
  const { authToken, body } = payload || {};
  if (!authToken || typeof authToken !== "string") return c.json({ ok: false, error: "authToken required" }, 400);
  if (body === undefined) return c.json({ ok: false, error: "body required" }, 400);
  const started = Date.now();
  const res = await fetch(`${TAQNYAT_BASE}/verify.php`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${authToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  console.log(`[sms/verify] status=${res.status} ${Date.now() - started}ms`);
  return new Response(text, {
    status: res.status,
    headers: { "Content-Type": res.headers.get("content-type") || "application/json" },
  });
});

app.post("/smtp/send", async (c) => {
  let payload;
  try { payload = await c.req.json(); } catch { return c.json({ ok: false, error: "invalid_json" }, 400); }
  const smtp = payload?.smtp || {};
  const message = payload?.message || {};
  const host = String(smtp.host || "").trim().replace(/^smtp:\/\//i, "").replace(/^smtps:\/\//i, "").replace(/:\d+\/?$/, "").replace(/\/+$/, "");
  const port = Number(smtp.port || 465) || 465;
  const secure = typeof smtp.secure === "boolean" ? smtp.secure : port === 465;
  const user = String(smtp.user || "").trim();
  const password = String(smtp.password || "");
  if (!host) return c.json({ ok: false, error: "smtp.host required" }, 400);
  if (!ALLOWED_HOSTS.includes(host)) return c.json({ ok: false, error: `smtp host not allowed: ${host}` }, 400);
  if (!user || !password) return c.json({ ok: false, error: "smtp credentials required" }, 400);
  if (!message.to || !message.subject || (!message.html && !message.text)) {
    return c.json({ ok: false, error: "message.to, subject and html/text required" }, 400);
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    ...(smtp.family ? { family: Number(smtp.family) } : {}),
    auth: { user, pass: password },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
    requireTLS: port === 587,
    tls: { servername: host, minVersion: "TLSv1.2" },
  });

  try {
    const started = Date.now();
    const info = await transporter.sendMail({
      from: message.from,
      to: Array.isArray(message.to) ? message.to.join(", ") : message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
      replyTo: message.replyTo,
    });
    console.log(`[smtp/send] host=${host} status=sent accepted=${info.accepted?.length || 0} rejected=${info.rejected?.length || 0} ${Date.now() - started}ms`);
    return c.json({ ok: true, messageId: info.messageId, accepted: info.accepted || [], rejected: info.rejected || [] });
  } catch (err) {
    const message = err?.message || "smtp_send_failed";
    console.error(`[smtp/send] host=${host} error=${message}`);
    return c.json({ ok: false, error: message }, 502);
  }
});



app.notFound((c) => c.json({ ok: false, error: "not_found" }, 404));
app.onError((err, c) => {
  console.error("[error]", err);
  return c.json({ ok: false, error: err?.message || "internal_error" }, 500);
});

serve({ fetch: app.fetch, port: PORT, hostname: "0.0.0.0" });
console.log(`[sms-proxy] listening on :${PORT} | allowed_hosts=${ALLOWED_HOSTS.join(",")}`);
