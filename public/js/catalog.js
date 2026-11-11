// =====================================================================
// MENU, PRICES AND ORDERING RULES
// This one file is used by both the website (cart totals) and the
// checkout server (the price customers actually pay). Prices are in
// CENTS: 700 = $7.00. After changing anything here, the visible prices
// in index.html should be updated to match.
// =====================================================================

export const ITEMS = {
  "strawberry-tres-leches": { name: "Strawberry Tres Leches", price: 700 },
  "biscoff-tres-leches": { name: "Biscoff Tres Leches", price: 700 },
  "oreo-tres-leches": { name: "Chocolate Oreo Tres Leches", price: 700 },
  "dubai-tres-leches": { name: "Dubai Chocolate Tres Leches", price: 700 },
  "chocolate-flan": { name: "Chocolate Flan", price: 700 },
  "churro-cheesecake": { name: "Churro Cheesecake", price: 700 },
  "churro-bites": {
    name: "Churro Cheesecake Bites",
    sizes: {
      regular: { label: "Regular", price: 900 },
      family: { label: "Family Size", price: 1500 },
    },
  },
  "gelatina-pina-colada": { name: "Gelatina Piña Colada", price: 700 },
};

export const CAKE = {
  name: "Custom Cake",
  sizes: {
    "8x8": { label: "8×8″", price: 4200 },
    "8x16": { label: "8×16″", price: 5600 },
  },
  flavors: [
    "Vanilla", "Chocolate", "Mocha", "Strawberry", "Oreo",
    "Dubai Chocolate", "Dubai Pistachio", "Ferrero Rocher",
  ],
  fillings: [
    "Dulce de Leche", "Dulce de Leche with Pecans", "Nutella",
    "Nutella with Strawberries", "Oreo Cream", "Strawberries & Cream",
    "Pineapple Coconut Cream", "Peach",
  ],
  fillingPrice: 900,
  maxFillings: 2,
  addons: {
    "fresh-strawberries": { label: "Fresh Strawberries", price: 500 },
    "mixed-fruit": { label: "Mixed Fresh Fruit", price: 700 },
    "ganache": { label: "Chocolate Ganache", price: 600 },
    "drizzle": { label: "Chocolate Drizzle", price: 300 },
    "cookie-topping": { label: "Oreo / Cookie Toppings", price: 300 },
    "pecans": { label: "Pecans / Nuts", price: 400 },
    "custom-colors": { label: "Custom Color Decorations", price: 500 },
  },
  maxWritingLength: 60,
};

export const RULES = {
  timeZone: "America/Denver", // Casper, WY
  leadHours: 24,              // regular desserts: order at least 24 hours ahead
  cakeLeadHours: 72,          // custom cakes: at least 3 days ahead
  openHour: 9,                // first pickup time: 9 AM
  closeHour: 19,              // last pickup time: 7 PM
  maxDaysAhead: 60,           // how far ahead customers can book
  maxQtyPerLine: 20,
  maxLines: 30,
  maxNoteLength: 500,
};

// ---------- shared helpers ----------

export function money(cents) {
  return "$" + (cents / 100).toFixed(cents % 100 ? 2 : 0);
}

// Price of one cart line (before quantity). Returns null if invalid.
export function linePrice(line) {
  if (line.type === "item") {
    const item = ITEMS[line.id];
    if (!item) return null;
    if (item.sizes) {
      const size = item.sizes[line.size];
      return size ? size.price : null;
    }
    return item.price;
  }
  if (line.type === "cake") {
    const size = CAKE.sizes[line.size];
    if (!size) return null;
    let total = size.price;
    total += (line.fillings || []).length * CAKE.fillingPrice;
    for (const id of line.addons || []) {
      if (!CAKE.addons[id]) return null;
      total += CAKE.addons[id].price;
    }
    return total;
  }
  return null;
}

export function lineTitle(line) {
  if (line.type === "item") {
    const item = ITEMS[line.id];
    if (!item) return "";
    return item.sizes ? `${item.name} (${item.sizes[line.size]?.label})` : item.name;
  }
  return `${CAKE.name} ${CAKE.sizes[line.size]?.label} – ${line.flavor}`;
}

export function lineDetails(line) {
  if (line.type !== "cake") return [];
  const out = [];
  for (const f of line.fillings || []) out.push(`Filling: ${f}`);
  for (const id of line.addons || []) out.push(CAKE.addons[id]?.label);
  if (line.writing) out.push(`Writing: “${line.writing}”`);
  return out.filter(Boolean);
}

export const hasCake = (lines) => lines.some((l) => l.type === "cake");

// Pickup times offered each day, as "HH:MM" (24h).
export function pickupTimes() {
  const out = [];
  for (let h = RULES.openHour; h <= RULES.closeHour; h++) out.push(String(h).padStart(2, "0") + ":00");
  return out;
}

export function timeLabel(hhmm) {
  const h = +hhmm.slice(0, 2);
  const suffix = h >= 12 ? "PM" : "AM";
  return `${((h + 11) % 12) + 1}:${hhmm.slice(3)} ${suffix}`;
}

// ---------- Casper (Mountain) time helpers ----------

function tzOffsetMinutes(ts, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ts));
  const get = (t) => +parts.find((p) => p.type === t).value;
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return (asUtc - ts) / 60000;
}

// "2026-11-20" + "14:00" in Casper time -> UTC milliseconds
export function pickupInstant(date, time, timeZone = RULES.timeZone) {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  let ts = wall - tzOffsetMinutes(wall, timeZone) * 60000;
  ts = wall - tzOffsetMinutes(ts, timeZone) * 60000; // second pass handles DST edges
  return ts;
}

// UTC milliseconds -> "YYYY-MM-DD" in Casper time
export function localDate(ts, timeZone = RULES.timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ts));
}
