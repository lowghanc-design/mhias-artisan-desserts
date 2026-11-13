// Checkout server for Mhia's Artisan Desserts.
// Serves the static site from public/ and handles:
//   GET  /api/availability  -> pickup days that are already full
//   POST /api/checkout      -> validates the cart and returns a Square checkout link
// Card details never touch this server: customers pay on Square's own page.

import {
  ITEMS, CAKE, RULES, linePrice, lineTitle, hasCake, fillingPrice,
  pickupTimes, pickupInstant, localDate,
} from "../public/js/catalog.js";

const SQUARE_VERSION = "2025-01-23";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/availability" && request.method === "GET") {
        return json(await availability(env));
      }
      if (url.pathname === "/api/checkout" && request.method === "POST") {
        return await checkout(request, env);
      }
      if (url.pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
    } catch (err) {
      console.error(err && err.stack ? err.stack : err);
      return json({ error: "Something went wrong. Please try again, or text us at 307-441-1419." }, 500);
    }
    return env.ASSETS.fetch(request);
  },
};

// ---------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------

async function checkout(request, env) {
  if (!env.SQUARE_ACCESS_TOKEN || !env.SQUARE_LOCATION_ID) {
    return json({ error: "Online ordering isn't available yet. Please text us at 307-441-1419 to order." }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request." }, 400);
  }

  // ---- customer ----
  const name = clean(body.name, 80);
  const email = clean(body.email, 120);
  const phone = normalizePhone(body.phone);
  const note = clean(body.note, RULES.maxNoteLength);
  if (!name) return json({ error: "Please enter your name." }, 400);
  if (!phone) return json({ error: "Please enter a valid 10-digit phone number." }, 400);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Please enter a valid email address." }, 400);
  if (body.agree !== true) return json({ error: "Please agree to the cancellation policy." }, 400);

  // ---- cart ----
  const lines = Array.isArray(body.cart) ? body.cart : [];
  if (!lines.length) return json({ error: "Your cart is empty." }, 400);
  if (lines.length > RULES.maxLines) return json({ error: "Too many items in one order. Please text us for large orders." }, 400);

  const validated = [];
  for (const raw of lines) {
    const line = validateLine(raw);
    if (!line) return json({ error: "Something in your cart is no longer available. Please remove it and try again." }, 400);
    validated.push(line);
  }
  const cakeOrder = hasCake(validated);

  // ---- pickup time ----
  const date = String(body.pickupDate || "");
  const time = String(body.pickupTime || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !pickupTimes().includes(time)) {
    return json({ error: "Please choose a pickup date and time." }, 400);
  }
  const pickupTs = pickupInstant(date, time);
  const now = Date.now();
  const leadHours = cakeOrder ? RULES.cakeLeadHours : RULES.leadHours;
  if (pickupTs < now + leadHours * 3600_000) {
    return json({
      error: cakeOrder
        ? "Custom cakes need at least 3 days' notice. Please choose a later pickup."
        : "Orders need at least 24 hours' notice. Please choose a later pickup.",
    }, 400);
  }
  if (pickupTs > now + RULES.maxDaysAhead * 86400_000) {
    return json({ error: `Please choose a pickup within the next ${RULES.maxDaysAhead} days.` }, 400);
  }

  // ---- daily cap ----
  const counts = await countPaidOrdersByDay(env);
  const day = counts.get(date) || { orders: 0, cakes: 0 };
  if (day.orders >= cap(env.DAILY_ORDER_CAP)) {
    return json({ error: "That pickup day is fully booked. Please choose another day." }, 409);
  }
  if (cakeOrder && day.cakes >= cap(env.DAILY_CAKE_CAP)) {
    return json({ error: "We're fully booked for custom cakes that day. Please choose another day." }, 409);
  }

  // ---- build the Square order ----
  const lineItems = validated.map(toSquareLineItem);
  const pickupNoteParts = [];
  if (note) pickupNoteParts.push(note);
  // After paying, send customers back to the same site they ordered from
  // (the live domain, or a preview link while testing).
  const returnBase = new URL(request.url).origin;

  const payload = {
    idempotency_key: crypto.randomUUID(),
    order: {
      location_id: env.SQUARE_LOCATION_ID,
      reference_id: `WEB-${date}`,
      line_items: lineItems,
      fulfillments: [{
        type: "PICKUP",
        state: "PROPOSED",
        pickup_details: {
          recipient: { display_name: name, phone_number: phone, ...(email ? { email_address: email } : {}) },
          schedule_type: "SCHEDULED",
          pickup_at: new Date(pickupTs).toISOString(),
          ...(pickupNoteParts.length ? { note: pickupNoteParts.join(" | ").slice(0, 500) } : {}),
        },
      }],
      metadata: { pickup_date: date, has_cake: cakeOrder ? "1" : "0", source: "website" },
    },
    checkout_options: {
      redirect_url: `${returnBase}/thanks.html`,
      ask_for_shipping_address: false,
      allow_tipping: false,
      accepted_payment_methods: { apple_pay: true, google_pay: true, cash_app_pay: true },
    },
    pre_populated_data: {
      buyer_phone_number: phone,
      ...(email ? { buyer_email: email } : {}),
    },
    payment_note: `Pickup ${date} ${time} – ${name}`.slice(0, 500),
  };

  const res = await square(env, "/v2/online-checkout/payment-links", payload);
  if (!res.ok) {
    console.error("Square payment link error", res.status, JSON.stringify(res.data));
    return json({ error: "We couldn't start checkout. Please try again, or text us at 307-441-1419." }, 502);
  }
  return json({ url: res.data.payment_link.url });
}

function validateLine(raw) {
  if (!raw || typeof raw !== "object") return null;
  const qty = Math.floor(Number(raw.qty));
  if (!(qty >= 1 && qty <= RULES.maxQtyPerLine)) return null;

  if (raw.type === "item") {
    const item = ITEMS[raw.id];
    if (!item) return null;
    const line = { type: "item", id: raw.id, qty };
    if (item.sizes) {
      if (!item.sizes[raw.size]) return null;
      line.size = raw.size;
    }
    return linePrice(line) == null ? null : line;
  }

  if (raw.type === "cake") {
    if (!CAKE.sizes[raw.size]) return null;
    if (!CAKE.flavors.includes(raw.flavor)) return null;
    const fillings = Array.isArray(raw.fillings) ? [...new Set(raw.fillings)] : [];
    if (fillings.length > CAKE.maxFillings || !fillings.every((f) => CAKE.fillings.includes(f))) return null;
    const addons = Array.isArray(raw.addons) ? [...new Set(raw.addons)] : [];
    if (!addons.every((a) => CAKE.addons[a])) return null;
    const writing = clean(raw.writing, CAKE.maxWritingLength);
    return { type: "cake", size: raw.size, flavor: raw.flavor, fillings, addons, writing, qty };
  }
  return null;
}

function toSquareLineItem(line) {
  const usd = (cents) => ({ amount: cents, currency: "USD" });
  if (line.type === "item") {
    const item = ITEMS[line.id];
    const price = item.sizes ? item.sizes[line.size].price : item.price;
    return {
      name: item.sizes ? `${item.name} (${item.sizes[line.size].label})` : item.name,
      quantity: String(line.qty),
      base_price_money: usd(price),
    };
  }
  const modifiers = [];
  for (const f of line.fillings) modifiers.push({ name: `Filling: ${f}`, base_price_money: usd(fillingPrice(line.size)) });
  for (const a of line.addons) modifiers.push({ name: CAKE.addons[a].label, base_price_money: usd(CAKE.addons[a].price) });
  if (line.writing) modifiers.push({ name: `Writing: "${line.writing}"`, base_price_money: usd(0) });
  return {
    name: lineTitle(line),
    quantity: String(line.qty),
    base_price_money: usd(CAKE.sizes[line.size].price),
    ...(modifiers.length ? { modifiers } : {}),
  };
}

// ---------------------------------------------------------------------
// Daily cap: count PAID pickup orders per Casper-time day
// ---------------------------------------------------------------------

async function availability(env) {
  if (!env.SQUARE_ACCESS_TOKEN || !env.SQUARE_LOCATION_ID) return { enabled: false, full: [], cakeFull: [] };
  const counts = await countPaidOrdersByDay(env);
  const full = [], cakeFull = [];
  for (const [day, c] of counts) {
    if (c.orders >= cap(env.DAILY_ORDER_CAP)) full.push(day);
    else if (c.cakes >= cap(env.DAILY_CAKE_CAP)) cakeFull.push(day);
  }
  return { enabled: true, full, cakeFull };
}

async function countPaidOrdersByDay(env) {
  const counts = new Map();
  const today = localDate(Date.now());
  const since = new Date(Date.now() - (RULES.maxDaysAhead + 10) * 86400_000).toISOString();
  let cursor;
  for (let page = 0; page < 10; page++) {
    const res = await square(env, "/v2/orders/search", {
      location_ids: [env.SQUARE_LOCATION_ID],
      limit: 500,
      ...(cursor ? { cursor } : {}),
      query: {
        filter: {
          state_filter: { states: ["OPEN", "COMPLETED"] },
          date_time_filter: { created_at: { start_at: since } },
          fulfillment_filter: { fulfillment_types: ["PICKUP"] },
        },
        sort: { sort_field: "CREATED_AT", sort_order: "DESC" },
      },
    });
    if (!res.ok) throw new Error("Square order search failed: " + JSON.stringify(res.data));

    for (const order of res.data.orders || []) {
      if (!order.tenders || !order.tenders.length) continue; // not paid
      const f = (order.fulfillments || []).find((x) => x.type === "PICKUP");
      if (!f || ["CANCELED", "FAILED"].includes(f.state)) continue;
      const day = order.metadata?.pickup_date
        || (f.pickup_details?.pickup_at ? localDate(Date.parse(f.pickup_details.pickup_at)) : null);
      if (!day || day < today) continue;
      const c = counts.get(day) || { orders: 0, cakes: 0 };
      c.orders += 1;
      const cake = order.metadata?.has_cake === "1"
        || (order.line_items || []).some((li) => (li.name || "").startsWith(CAKE.name));
      if (cake) c.cakes += 1;
      counts.set(day, c);
    }
    cursor = res.data.cursor;
    if (!cursor) break;
  }
  return counts;
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

async function square(env, path, body) {
  const base = env.SQUARE_ENV === "production"
    ? "https://connect.squareup.com"
    : "https://connect.squareupsandbox.com";
  const res = await fetch(base + path, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
      "Square-Version": SQUARE_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  return { ok: res.ok, status: res.status, data };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function clean(value, max) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function normalizePhone(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  return null;
}

function cap(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : Infinity;
}
