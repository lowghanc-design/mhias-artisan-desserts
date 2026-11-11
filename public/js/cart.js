// Shopping cart, cake builder and checkout for Mhia's Artisan Desserts.
import {
  ITEMS, CAKE, RULES, money, linePrice, lineTitle, lineDetails, hasCake,
  pickupTimes, timeLabel, pickupInstant, localDate,
} from "./catalog.js";

const STORAGE_KEY = "mhia-cart-v1";
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------
// Cart state (saved in this browser only)
// ---------------------------------------------------------------------

let cart = load();

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(raw) ? raw.filter((l) => linePrice(l) != null && l.qty >= 1) : [];
  } catch {
    return [];
  }
}

function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cart)); } catch { /* private mode etc. */ }
}

const keyOf = (line) => JSON.stringify({ ...line, qty: 0 });

function addLine(line) {
  const existing = cart.find((l) => keyOf(l) === keyOf(line));
  if (existing) existing.qty = Math.min(RULES.maxQtyPerLine, existing.qty + line.qty);
  else cart.push(line);
  save();
  render();
}

function setQty(index, qty) {
  if (qty <= 0) cart.splice(index, 1);
  else cart[index].qty = Math.min(RULES.maxQtyPerLine, qty);
  save();
  render();
}

const subtotal = () => cart.reduce((sum, l) => sum + linePrice(l) * l.qty, 0);
const itemCount = () => cart.reduce((n, l) => n + l.qty, 0);

// ---------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------

function render() {
  const count = itemCount();
  $("cart-count").textContent = count;
  $("cart-count").hidden = count === 0;
  $("cart-open").setAttribute("aria-label", `Open cart, ${count} item${count === 1 ? "" : "s"}`);

  const list = $("cart-lines");
  list.replaceChildren();
  cart.forEach((line, i) => {
    const li = document.createElement("li");
    li.className = "cart-line";

    const info = document.createElement("div");
    info.className = "cart-line-info";
    const title = document.createElement("p");
    title.className = "cart-line-title";
    title.textContent = lineTitle(line);
    info.append(title);
    const details = lineDetails(line);
    if (details.length) {
      const d = document.createElement("p");
      d.className = "cart-line-details";
      d.textContent = details.join(" · ");
      info.append(d);
    }

    const qty = document.createElement("div");
    qty.className = "qty";
    const minus = button("−", `Remove one ${lineTitle(line)}`, () => setQty(i, line.qty - 1));
    const num = document.createElement("span");
    num.textContent = line.qty;
    const plus = button("+", `Add one more ${lineTitle(line)}`, () => setQty(i, line.qty + 1));
    plus.disabled = line.qty >= RULES.maxQtyPerLine;
    qty.append(minus, num, plus);

    const price = document.createElement("p");
    price.className = "cart-line-price";
    price.textContent = money(linePrice(line) * line.qty);

    li.append(info, qty, price);
    list.append(li);
  });

  const empty = cart.length === 0;
  $("cart-empty").hidden = !empty;
  $("cart-subtotal-row").hidden = empty;
  $("checkout-form").hidden = empty;
  $("cart-subtotal").textContent = money(subtotal());
  if (!empty) updatePickupLimits();
}

function button(text, label, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = text;
  b.setAttribute("aria-label", label);
  b.addEventListener("click", onClick);
  return b;
}

let toastTimer;
function toast(message) {
  const t = $("toast");
  t.replaceChildren();
  const span = document.createElement("span");
  span.textContent = message;
  const view = button("View cart", "View cart", openCart);
  view.className = "toast-action";
  t.append(span, view);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
}

// ---------------------------------------------------------------------
// Cart dialog
// ---------------------------------------------------------------------

const dialog = $("cart");

function openCart() {
  $("toast").hidden = true;
  render();
  if (!dialog.open) dialog.showModal();
  loadAvailability();
}

$("cart-open").addEventListener("click", openCart);
$("cart-close").addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); });
dialog.querySelectorAll("[data-close-cart]").forEach((a) => a.addEventListener("click", () => dialog.close()));

// ---------------------------------------------------------------------
// "Add to Cart" buttons on dessert cards
// ---------------------------------------------------------------------

document.querySelectorAll("[data-add]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const id = btn.dataset.add;
    const item = ITEMS[id];
    if (!item) return;
    const line = { type: "item", id, qty: 1 };
    if (item.sizes) {
      const checked = document.querySelector(`input[name="${btn.dataset.sizeGroup}"]:checked`);
      line.size = checked ? checked.value : Object.keys(item.sizes)[0];
    }
    addLine(line);
    toast(`Added ${lineTitle(line)}`);
  });
});

// ---------------------------------------------------------------------
// Cake builder
// ---------------------------------------------------------------------

const cakeForm = $("cake-form");

function readCake() {
  const fd = new FormData(cakeForm);
  return {
    type: "cake",
    size: fd.get("size") || "",
    flavor: fd.get("flavor") || "",
    fillings: fd.getAll("fillings"),
    addons: fd.getAll("addons"),
    writing: String(fd.get("writing") || "").trim().slice(0, CAKE.maxWritingLength),
    qty: 1,
  };
}

function setHint(row, text) {
  const hint = cakeForm.querySelector(`[data-row="${row}"] .row-hint`);
  hint.textContent = text || hint.dataset.default;
  hint.classList.toggle("chosen", Boolean(text));
}

function updateCake() {
  const cake = readCake();

  // Max two fillings: disable the rest once two are picked
  const boxes = cakeForm.querySelectorAll('input[name="fillings"]');
  const full = cake.fillings.length >= CAKE.maxFillings;
  boxes.forEach((b) => { b.disabled = full && !b.checked; });

  setHint("size", cake.size ? CAKE.sizes[cake.size].label : "");
  setHint("flavor", cake.flavor);
  setHint("fillings", cake.fillings.length ? `${cake.fillings.length} selected (+${money(cake.fillings.length * CAKE.fillingPrice)})` : "");
  const addonTotal = cake.addons.reduce((s, a) => s + CAKE.addons[a].price, 0);
  setHint("addons", cake.addons.length ? `${cake.addons.length} selected (+${money(addonTotal)})` : "");
  setHint("writing", cake.writing ? "added" : "");

  $("cake-total").textContent = cake.size ? money(linePrice(cake)) : "choose a size";
  $("cake-error").hidden = true;
}

cakeForm.addEventListener("change", updateCake);
cakeForm.addEventListener("input", updateCake);

cakeForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const cake = readCake();
  const missing = !cake.size ? "size" : !cake.flavor ? "flavor" : null;
  if (missing) {
    const err = $("cake-error");
    err.textContent = `Please choose a cake ${missing}.`;
    err.hidden = false;
    cakeForm.querySelector(`[data-row="${missing}"]`).open = true;
    return;
  }
  addLine(cake);
  cakeForm.reset();
  cakeForm.querySelectorAll("details").forEach((d) => { d.open = false; });
  updateCake();
  toast("Added your custom cake");
});

updateCake();

// ---------------------------------------------------------------------
// Pickup date & time
// ---------------------------------------------------------------------

let availability = { full: [], cakeFull: [], enabled: true };
let availabilityLoaded = 0;

async function loadAvailability() {
  if (Date.now() - availabilityLoaded < 60_000) return;
  try {
    const res = await fetch("/api/availability", { cache: "no-store" });
    if (res.ok) {
      availability = await res.json();
      availabilityLoaded = Date.now();
      updatePickupLimits();
    }
  } catch { /* offline: the server still checks at checkout */ }
}

function leadMs() {
  return (hasCake(cart) ? RULES.cakeLeadHours : RULES.leadHours) * 3600_000;
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function updatePickupLimits() {
  const dateInput = $("pickup-date");
  const earliestTs = Date.now() + leadMs();
  let min = localDate(earliestTs);
  // If no pickup time is left on the earliest day, start the next day
  if (!pickupTimes().some((t) => pickupInstant(min, t) >= earliestTs)) min = addDays(min, 1);
  dateInput.min = min;
  dateInput.max = addDays(localDate(Date.now()), RULES.maxDaysAhead);
  if (dateInput.value && dateInput.value < min) dateInput.value = "";

  $("pickup-hint").textContent = hasCake(cart)
    ? "Custom cakes need at least 3 days' notice. Pickup at 4030 Gannett St., Casper, WY."
    : "Order at least 24 hours ahead. Pickup at 4030 Gannett St., Casper, WY.";
  updateTimes();
}

function updateTimes() {
  const date = $("pickup-date").value;
  const select = $("pickup-time");
  const note = $("date-note");
  const previous = select.value;
  select.replaceChildren();
  note.hidden = true;

  if (!date) {
    select.append(new Option("Pick a date first", ""));
    select.disabled = true;
    return;
  }

  let blocked = "";
  if (availability.full.includes(date)) blocked = "That day is fully booked. Please choose another day.";
  else if (hasCake(cart) && availability.cakeFull.includes(date)) blocked = "We're fully booked for custom cakes that day. Please choose another day.";

  const earliestTs = Date.now() + leadMs();
  const times = pickupTimes().filter((t) => pickupInstant(date, t) >= earliestTs);
  if (!blocked && !times.length) blocked = "No pickup times are left that day. Please choose a later date.";

  if (blocked) {
    note.textContent = blocked;
    note.hidden = false;
    select.append(new Option("Not available", ""));
    select.disabled = true;
    return;
  }
  select.disabled = false;
  select.append(new Option("Choose a time", ""));
  for (const t of times) select.append(new Option(timeLabel(t), t));
  if (times.includes(previous)) select.value = previous;
}

$("pickup-date").addEventListener("change", updateTimes);

// ---------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------

const checkoutForm = $("checkout-form");

function showCheckoutError(message) {
  const err = $("checkout-error");
  err.textContent = message;
  err.hidden = false;
  err.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

checkoutForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  $("checkout-error").hidden = true;
  const fd = new FormData(checkoutForm);
  const data = {
    cart,
    pickupDate: fd.get("pickupDate"),
    pickupTime: fd.get("pickupTime"),
    name: String(fd.get("name") || "").trim(),
    phone: String(fd.get("phone") || "").trim(),
    email: String(fd.get("email") || "").trim(),
    note: String(fd.get("note") || "").trim(),
    agree: $("c-agree").checked,
  };

  if (!data.pickupDate || !data.pickupTime) return showCheckoutError("Please choose a pickup date and time.");
  if (!data.name) return showCheckoutError("Please enter your name.");
  if (data.phone.replace(/\D/g, "").length < 10) return showCheckoutError("Please enter a 10-digit phone number.");
  if (!data.agree) return showCheckoutError("Please agree to the cancellation policy.");

  const submit = $("checkout-submit");
  submit.disabled = true;
  submit.textContent = "Starting secure checkout…";
  try {
    const res = await fetch("/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    const out = await res.json().catch(() => ({}));
    if (res.ok && out.url) {
      window.location.href = out.url;
      return;
    }
    if (res.status === 409) { availabilityLoaded = 0; loadAvailability(); }
    showCheckoutError(out.error || "We couldn't start checkout. Please try again.");
  } catch {
    showCheckoutError("Couldn't connect. Please check your internet and try again.");
  }
  submit.disabled = false;
  submit.textContent = "Continue to Payment";
});

render();
