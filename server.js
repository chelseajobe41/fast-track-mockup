import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import multer from 'multer';
import Anthropic from '@anthropic-ai/sdk';
import Stripe from 'stripe';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, copyFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

// ---------- Boot ----------
const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE_URL = 'https://fasttrackschoolsupplies.com';
const KIT_DISCOUNT = 0.10;  // 10% bundle discount vs buying items individually

// Live mutable data (products, inventory, orders, settings, uploaded images) lives in DATA_DIR so
// it survives Render deploys — a git checkout would otherwise revert repo-tracked data files, wiping
// admin edits and order history. Locally DATA_DIR defaults to the repo dir (today's behavior);
// production sets DATA_DIR=/var/data (a mounted Render persistent disk). On first boot we seed
// DATA_DIR from the repo's bundled copies, so a fresh disk starts with the current catalog.
const DATA_DIR = resolve(process.env.DATA_DIR || __dirname);  // absolute (res.sendFile needs it)
const IMAGES_DIR = join(DATA_DIR, 'product-images');
const PRODUCTS_PATH = join(DATA_DIR, 'products.json');
const INVENTORY_PATH = join(DATA_DIR, 'inventory.json');
const ORDERS_PATH = join(DATA_DIR, 'orders.json');
const SETTINGS_PATH = join(DATA_DIR, 'settings.json');

function seedDataFile(name, fallback) {
  const target = join(DATA_DIR, name);
  if (existsSync(target)) return;
  const seed = join(__dirname, name);
  if (existsSync(seed)) copyFileSync(seed, target);
  else if (fallback !== undefined) writeFileSync(target, JSON.stringify(fallback, null, 2));
}
if (DATA_DIR !== __dirname) {
  mkdirSync(DATA_DIR, { recursive: true });
  seedDataFile('products.json');
  seedDataFile('inventory.json', {});
  seedDataFile('orders.json', []);
}
if (!existsSync(IMAGES_DIR)) mkdirSync(IMAGES_DIR, { recursive: true });

// Atomic JSON write: write to a temp file then rename, so a crash mid-write can't corrupt data.
function writeJsonAtomic(path, data) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

// Templates for server-side-rendered pages (read once at boot; Render restarts on every deploy).
const KIT_TEMPLATE = readFileSync(join(__dirname, 'kit.html'), 'utf8');
const STORE_TEMPLATE = readFileSync(join(__dirname, 'store.html'), 'utf8');

// Escape text for safe injection into HTML attributes/text nodes.
function htmlEscape(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Kits reference products by id but are not editable in the admin, so they stay a boot constant.
const KITS = JSON.parse(readFileSync(join(__dirname, 'kits.json'), 'utf8'));

// ---------- Mutable catalog (editable via admin; refreshed in-memory on every write) ----------
// PRODUCTS/PRODUCT_BY_ID/SYSTEM_PROMPT are `let` so admin edits take effect immediately without a
// restart. Every product write calls reloadCatalog(), so checkout/kits/store/AI all read fresh data.
let PRODUCTS, PRODUCT_BY_ID, SYSTEM_PROMPT;
function readProducts() { return JSON.parse(readFileSync(PRODUCTS_PATH, 'utf8')); }
function writeProducts(list) { writeJsonAtomic(PRODUCTS_PATH, list); }
function reloadCatalog() {
  PRODUCTS = readProducts();
  PRODUCT_BY_ID = Object.fromEntries(PRODUCTS.map(p => [p.id, p]));
  SYSTEM_PROMPT = buildSystemPrompt();
}
reloadCatalog();  // initialize PRODUCTS / PRODUCT_BY_ID / SYSTEM_PROMPT

const FLAT_SHIPPING_CENTS = 995;  // Flat $9.95 shipping on every order
const SUBSCRIPTION_DISCOUNT = 0.10;  // 10% off subscribed items

// Map customer-facing interval choice → Stripe recurring config
const SUBSCRIPTION_INTERVALS = {
  monthly:    { interval: 'month', interval_count: 1, label: 'Every month' },
  bimonthly:  { interval: 'month', interval_count: 2, label: 'Every 2 months' },
  quarterly:  { interval: 'month', interval_count: 3, label: 'Every 3 months' },
  semiannual: { interval: 'month', interval_count: 6, label: 'Every 6 months' }
};

const anthropic = new Anthropic();
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

// Customer-facing emails (receipts, renewals, failed payments, cancellations) are handled
// automatically by Stripe. Owner notifications come through the Stripe Dashboard + mobile app.
const BASE_URL = process.env.BASE_URL || 'http://localhost:3001';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me';

// ---------- Persistence helpers (JSON file based) ----------
// NOTE: For higher volume, swap to SQLite or Postgres. JSON files are fine for v1.
function readInventory() { return JSON.parse(readFileSync(INVENTORY_PATH, 'utf8')); }
function writeInventory(inv) { writeJsonAtomic(INVENTORY_PATH, inv); }
function readOrders() { return JSON.parse(readFileSync(ORDERS_PATH, 'utf8')); }
function writeOrders(orders) { writeJsonAtomic(ORDERS_PATH, orders); }

// Store settings (shipping config). Defaults to the prior flat $9.95 if no settings file exists yet.
const DEFAULT_SETTINGS = {
  shipping: {
    mode: 'flat',            // 'flat' | 'tiers'
    flat_cents: 995,         // used when mode === 'flat'
    // used when mode === 'tiers': ordered ascending; up_to_cents null = "and above" (top tier)
    tiers: [
      { up_to_cents: 3000, ship_cents: 995 },
      { up_to_cents: 6000, ship_cents: 1495 },
      { up_to_cents: null, ship_cents: 1995 }
    ]
  }
};
function readSettings() {
  if (!existsSync(SETTINGS_PATH)) return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  try {
    const s = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
    return { shipping: { ...DEFAULT_SETTINGS.shipping, ...(s.shipping || {}) } };
  } catch { return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)); }
}
function writeSettings(s) { writeJsonAtomic(SETTINGS_PATH, s); }

// Compute shipping (in cents) for a given order subtotal (in cents) from the current settings.
function shippingCentsFor(subtotalCents) {
  const cfg = readSettings().shipping;
  if (cfg.mode === 'tiers' && Array.isArray(cfg.tiers) && cfg.tiers.length) {
    for (const t of cfg.tiers) {
      if (t.up_to_cents === null || t.up_to_cents === undefined) return t.ship_cents;
      if (subtotalCents <= t.up_to_cents) return t.ship_cents;
    }
    return cfg.tiers[cfg.tiers.length - 1].ship_cents;
  }
  return cfg.flat_cents ?? 995;
}

function decrementInventory(items) {
  const inv = readInventory();
  for (const { sku_id, quantity } of items) {
    if (inv[sku_id]) {
      inv[sku_id].stock = Math.max(0, (inv[sku_id].stock || 0) - quantity);
    }
  }
  writeInventory(inv);
}

function logOrder(order) {
  const orders = readOrders();
  orders.unshift(order);
  writeOrders(orders);
}

// ---------- AI prompt ----------
// Built from the current catalog; rebuilt by reloadCatalog() whenever products change so the AI
// always matches against the live product list. (Hoisted function — callable from reloadCatalog above.)
function buildSystemPrompt() {
  return `You are the AI assistant for Fast Track School Supplies, a service that takes school supply lists from parents and turns them into ordered kits.

Your job: given an image of a school supply list, extract every line item, then match each one to a SKU in the catalog below.

Rules:
1. Read every line item from the supply list, including ones with checkmarks or bullets.
2. Detect the quantity for each item. Look for "x2", "2 packs", "two", "(2)", or just a leading number. Default to 1 if no quantity is given.
3. Match each list item to the best SKU in the catalog using the "keywords" field as your guide. Examples: "#2 pencils" matches "pencils-12". "Loose leaf paper" matches "filler-paper". "Kleenex" matches "tissues".
4. If a list item is ambiguous (e.g. "notebook" without specifying type), pick the most common variant for the apparent grade level and note your assumption in "note".
5. If a list item has no good match in the catalog, put it in "unmatched" with a clear reason. Do not invent SKUs.
6. Confidence: "high" = clear keyword match, "medium" = inferred from context, "low" = best guess.
7. Ignore section headers like "Required:" or "For class:".

CATALOG (JSON):
${JSON.stringify(PRODUCTS.map(p => ({ id: p.id, name: p.name, unit: p.unit, keywords: p.keywords })), null, 2)}`;
}

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    matched_items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          sku_id: { type: "string" },
          quantity: { type: "integer" },
          original_text: { type: "string" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          note: { type: "string" }
        },
        required: ["sku_id", "quantity", "original_text", "confidence", "note"],
        additionalProperties: false
      }
    },
    unmatched: {
      type: "array",
      items: {
        type: "object",
        properties: {
          original_text: { type: "string" },
          quantity: { type: "integer" },
          reason: { type: "string" }
        },
        required: ["original_text", "quantity", "reason"],
        additionalProperties: false
      }
    }
  },
  required: ["matched_items", "unmatched"],
  additionalProperties: false
};

// ---------- Admin auth (HTTP Basic) ----------
function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  const [scheme, encoded] = auth.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString();
    const [user, pass] = decoded.split(':');
    if (user === ADMIN_USERNAME && pass === ADMIN_PASSWORD) return next();
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="Fast Track Admin", charset="UTF-8"');
  res.status(401).send('Authentication required.');
}

// ---------- App ----------
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Security headers (Helmet) — sane defaults with CSP relaxed for our specific needs
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // Inline styles + scripts used in HTML pages. unsafe-inline is a tradeoff for static HTML simplicity.
      scriptSrc: ["'self'", "'unsafe-inline'", "https://js.stripe.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "blob:", "https://images.pexels.com", "https://images.unsplash.com", "https://irp.cdn-website.com"],
      connectSrc: ["'self'", "https://api.stripe.com"],
      frameSrc: ["https://js.stripe.com", "https://hooks.stripe.com", "https://checkout.stripe.com"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"]
    }
  },
  crossOriginEmbedderPolicy: false,  // allow external images (Pexels CDN)
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' }  // allow Stripe popup
}));

// Stripe webhook needs raw body BEFORE express.json
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(500).send('Stripe not configured');
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook error: ${err.message}`);
  }
  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const lineItems = await stripe.checkout.sessions.listLineItems(session.id, { limit: 100, expand: ['data.price.product'] });
      const items = lineItems.data.map(li => {
        // Strip the "(Every month)" suffix we add on subscriptions
        const productName = (li.description || '').replace(/\s*\([^)]+\)$/, '');
        const match = PRODUCTS.find(p => p.name === productName);
        return {
          sku_id: match?.id || null,
          name: productName,
          quantity: li.quantity,
          unit_price_cents: li.price.unit_amount,
          line_total_cents: li.amount_total
        };
      });
      const isSub = session.mode === 'subscription';
      const order = {
        id: session.id,
        short_id: session.id.slice(-10).toUpperCase(),
        created_at: new Date(session.created * 1000).toISOString(),
        amount_total_cents: session.amount_total,
        currency: session.currency,
        customer_id: session.customer || null,
        customer_email: session.customer_details?.email || null,
        customer_name: session.customer_details?.name || null,
        customer_phone: session.customer_details?.phone || null,
        shipping_address: session.shipping_details?.address || null,
        source: session.metadata?.source || null,
        order_type: isSub ? 'subscription' : 'one-time',
        subscription_id: session.subscription || null,
        subscription_interval: session.metadata?.subscription_interval || null,
        status: 'paid',
        fulfillment: 'pending',
        items
      };
      logOrder(order);
      decrementInventory(items.filter(i => i.sku_id));
      // Stripe sends the customer receipt automatically. Owner is notified via Stripe Dashboard + mobile app.
    } else if (event.type === 'invoice.paid') {
      // Recurring subscription charge succeeded. Log a new order so fulfillment can ship the refill.
      const invoice = event.data.object;
      if (invoice.billing_reason === 'subscription_cycle' || invoice.billing_reason === 'subscription_create') {
        const items = invoice.lines.data
          .filter(l => l.type === 'subscription')
          .map(l => {
            const productName = (l.description || '').replace(/\s*\([^)]+\)$/, '');
            const match = PRODUCTS.find(p => p.name === productName);
            return {
              sku_id: match?.id || null,
              name: productName,
              quantity: l.quantity,
              unit_price_cents: l.price?.unit_amount || 0,
              line_total_cents: l.amount
            };
          });
        const order = {
          id: invoice.id,
          short_id: invoice.id.slice(-10).toUpperCase(),
          created_at: new Date(invoice.created * 1000).toISOString(),
          amount_total_cents: invoice.amount_paid,
          currency: invoice.currency,
          customer_id: invoice.customer,
          customer_email: invoice.customer_email,
          customer_name: invoice.customer_name,
          customer_phone: null,
          shipping_address: invoice.customer_shipping?.address || null,
          source: 'subscription-renewal',
          order_type: 'subscription-renewal',
          subscription_id: invoice.subscription,
          status: 'paid',
          fulfillment: 'pending',
          items
        };
        // Don't double-log the first invoice (already covered by checkout.session.completed)
        if (invoice.billing_reason !== 'subscription_create') {
          logOrder(order);
          decrementInventory(items.filter(i => i.sku_id));
          // Stripe sends the renewal receipt to the customer automatically.
        }
      }
    } else if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      // Stripe emails the customer a cancellation confirmation automatically.
      console.log('Subscription canceled:', sub.id);
    } else if (event.type === 'invoice.payment_failed') {
      const invoice = event.data.object;
      // Stripe Smart Retries handles the dunning email + retry schedule automatically.
      console.log('Payment failed for invoice:', invoice.id);
    }
  } catch (e) {
    console.error('Webhook handler failed:', e);
  }
  res.json({ received: true });
});

app.use(express.json());

// Lock down direct file access. express.static below would otherwise serve
// anything in __dirname, including order data, inventory, source code, and
// node_modules. Anything intentionally public (motion.js, motion.css,
// /assets/*, products.json, robots.txt, sitemap.xml, llms.txt) is not in
// the deny list and still gets served normally.
const DENY_PATHS = new Set([
  '/orders.json',         // PII: customer names, emails, addresses
  '/inventory.json',      // business info — use /api/inventory-public for public view
  '/kits.json',           // use /api/kits for public view
  '/server.js',
  '/package.json',
  '/package-lock.json',
  '/.gitignore',
  '/.env',
  '/.env.example',
  '/README.md',
  '/kit.html',            // SSR template — served only via /kits/:id with tokens filled
  '/store.html',          // SSR template — served only via /store with schema injected
  '/settings.json'        // store settings (shipping config) — admin-only
]);
const DENY_PREFIXES = ['/node_modules', '/.git', '/.claude'];
app.use((req, res, next) => {
  if (DENY_PATHS.has(req.path)) return res.status(404).end();
  for (const prefix of DENY_PREFIXES) {
    if (req.path === prefix || req.path.startsWith(prefix + '/')) {
      return res.status(404).end();
    }
  }
  next();
});

// Serve the public product catalog from memory (the store page fetches /products.json). Served
// from the in-memory PRODUCTS so it's always fresh AND works when the file lives off the web root
// (DATA_DIR on prod). Registered before express.static so it wins over any repo copy.
app.get('/products.json', (_req, res) => res.json(PRODUCTS));

// Serve admin-uploaded product images from IMAGES_DIR. Filename is sanitized to a bare basename to
// block path traversal (e.g. /uploads/../server.js). Product image URLs are /uploads/<id>.<ext>.
app.get('/uploads/:file', (req, res) => {
  const safe = req.params.file.replace(/[^a-zA-Z0-9._-]/g, '');
  if (!safe || safe.includes('..')) return res.status(404).end();
  const full = join(IMAGES_DIR, safe);
  if (!full.startsWith(IMAGES_DIR) || !existsSync(full)) return res.status(404).end();
  res.sendFile(full);
});

app.use(express.static(__dirname));

// Page routes
app.get('/upload', (_req, res) => res.sendFile(join(__dirname, 'upload.html')));
app.get('/store', (_req, res) => res.type('html').send(renderStorePage()));
app.get('/kits', (_req, res) => res.sendFile(join(__dirname, 'kits.html')));
// Old query-param kit URLs 301 to clean paths (preserves any existing inbound links/shares).
app.get('/kit', (req, res) => res.redirect(301, KITS[req.query.id] ? `/kits/${req.query.id}` : '/kits'));
// Server-side-rendered kit detail page (clean URL). Fills SEO tokens + valid Product JSON-LD.
app.get('/kits/:kitId', (req, res) => {
  const detail = buildKitDetail(req.params.kitId);
  if (!detail.found) return res.redirect(302, '/kits');
  res.type('html').send(renderKitPage(detail));
});
app.get('/gift', (_req, res) => res.sendFile(join(__dirname, 'gift.html')));
app.get('/success', (_req, res) => res.sendFile(join(__dirname, 'success.html')));
app.get('/cancel', (_req, res) => res.sendFile(join(__dirname, 'cancel.html')));
app.get('/terms', (_req, res) => res.sendFile(join(__dirname, 'terms.html')));
app.get('/privacy', (_req, res) => res.sendFile(join(__dirname, 'privacy.html')));
app.get('/shipping', (_req, res) => res.sendFile(join(__dirname, 'shipping.html')));
app.get('/returns', (_req, res) => res.sendFile(join(__dirname, 'returns.html')));
app.get('/faq', (_req, res) => res.sendFile(join(__dirname, 'faq.html')));
app.get('/help', (_req, res) => res.redirect(301, '/faq'));
app.get('/admin', requireAdmin, (_req, res) => res.sendFile(join(__dirname, 'admin.html')));

// Manage subscription: redirect to Stripe's hosted customer-portal login page.
// Client configures this once in Stripe Dashboard -> Settings -> Billing -> Customer portal
// -> "Login link" -> copy URL into STRIPE_PORTAL_URL env var.
app.get('/manage', (_req, res) => {
  const portalUrl = process.env.STRIPE_PORTAL_URL;
  if (portalUrl) return res.redirect(302, portalUrl);
  // Fallback if not yet configured: a friendly page explaining where to find the portal link.
  res.status(200).type('html').send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Manage your subscription | Fast Track School Supplies</title>
<link href="https://fonts.googleapis.com/css2?family=Parkinsans:wght@400;500;600;700&family=Barlow:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="icon" type="image/x-icon" href="/assets/favicon.ico" />
<style>
  body { font-family: 'Barlow', system-ui, sans-serif; background: #FAF6EF; color: #223A3F; min-height: 100vh; margin: 0; display: grid; place-items: center; padding: 40px 24px; line-height: 1.6; }
  .card { background: #fff; border-radius: 22px; padding: 48px 40px; max-width: 520px; box-shadow: 0 20px 60px rgba(34,58,63,0.08); text-align: center; }
  h1 { font-family: 'Parkinsans', sans-serif; font-size: 28px; margin: 0 0 12px; }
  p { color: #6A6F71; margin: 0 0 18px; font-size: 16px; }
  a { color: #DC3D2D; font-weight: 600; }
  .btn { display: inline-block; margin-top: 12px; background: #223A3F; color: #fff; padding: 14px 26px; border-radius: 999px; font-family: 'Parkinsans', sans-serif; font-weight: 600; text-decoration: none; }
</style></head>
<body><div class="card">
  <h1>Manage your subscription</h1>
  <p>To update your card, change your delivery schedule, or cancel, open the most recent Fast Track email from Stripe. The portal link is in the receipt.</p>
  <p>Don't have it handy? Email us and we'll send a fresh link.</p>
  <a class="btn" href="/">Back to home</a>
</div></body></html>`);
});

// ---------- Rate limiter for the AI endpoint ----------
// Each IP can call /api/parse-list up to 8 times per rolling hour.
const PARSE_RATE_LIMIT = 8;
const PARSE_WINDOW_MS = 60 * 60 * 1000;
const parseHits = new Map();  // ip -> [timestamp, timestamp, ...]

function rateLimitParse(req, res, next) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const recent = (parseHits.get(ip) || []).filter(t => now - t < PARSE_WINDOW_MS);
  if (recent.length >= PARSE_RATE_LIMIT) {
    const oldest = recent[0];
    const retryAfterSec = Math.ceil((PARSE_WINDOW_MS - (now - oldest)) / 1000);
    res.setHeader('Retry-After', retryAfterSec);
    return res.status(429).json({
      error: `Too many uploads. Try again in ${Math.ceil(retryAfterSec / 60)} minutes.`,
      retry_after_seconds: retryAfterSec
    });
  }
  recent.push(now);
  parseHits.set(ip, recent);
  next();
}

// ---------- AI list parsing ----------
app.post('/api/parse-list', rateLimitParse, upload.single('list'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    const mediaType = req.file.mimetype;
    if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mediaType)) {
      return res.status(400).json({ error: `Unsupported file type: ${mediaType}.` });
    }
    const base64 = req.file.buffer.toString('base64');

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 8192,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high', format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          { type: 'text', text: 'Extract every supply list item from this image and match each to a SKU from the catalog. Return only the JSON object matching the schema.' }
        ]
      }]
    });

    const textBlock = response.content.find(b => b.type === 'text');
    const parsed = JSON.parse(textBlock.text);

    const inventory = readInventory();
    const matched = parsed.matched_items.map(item => {
      const product = PRODUCT_BY_ID[item.sku_id];
      if (!product) return { ...item, error: `Unknown SKU: ${item.sku_id}` };
      return {
        ...item,
        name: product.name,
        unit: product.unit,
        price: product.price,
        image: product.image,
        line_total: +(product.price * item.quantity).toFixed(2),
        in_stock: (inventory[item.sku_id]?.stock || 0) >= item.quantity
      };
    });

    const subtotal = +matched.reduce((s, i) => s + (i.line_total || 0), 0).toFixed(2);

    res.json({
      matched_items: matched,
      unmatched: parsed.unmatched,
      subtotal,
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        cache_read_input_tokens: response.usage.cache_read_input_tokens,
        cache_creation_input_tokens: response.usage.cache_creation_input_tokens
      }
    });
  } catch (err) {
    console.error('Parse error:', err);
    res.status(err.status || 500).json({ error: err.message || 'Unknown error.' });
  }
});

// ---------- Public inventory snapshot (stock-only, no admin data) ----------
app.get('/api/inventory-public', (_req, res) => {
  const inv = readInventory();
  // Only return stock + threshold so the store can flag out/low items.
  const slim = {};
  for (const [id, v] of Object.entries(inv)) {
    slim[id] = { stock: v.stock, low_stock_threshold: v.low_stock_threshold };
  }
  res.json(slim);
});

// ---------- Kits API ----------
app.get('/api/kits', (_req, res) => {
  const inventory = readInventory();
  const list = Object.entries(KITS).map(([kit_id, kit]) => {
    const items = kit.items.map(({ id, quantity }) => {
      const p = PRODUCT_BY_ID[id];
      if (!p) return null;
      return { sku_id: id, name: p.name, price: p.price, image: p.image, quantity };
    }).filter(Boolean);
    const rawSubtotal = items.reduce((s, i) => s + i.price * i.quantity, 0);
    const bundlePrice = +(rawSubtotal * (1 - KIT_DISCOUNT)).toFixed(2);
    const previewImages = items.slice(0, 4).map(i => i.image);
    const allInStock = items.every(i => (inventory[i.sku_id]?.stock || 0) >= i.quantity);
    return {
      kit_id,
      name: kit.name,
      grade_label: kit.grade_label,
      age_range: kit.age_range,
      tagline: kit.tagline,
      hero_color: kit.hero_color,
      item_count: items.length,
      raw_subtotal: +rawSubtotal.toFixed(2),
      price: bundlePrice,
      preview_images: previewImages,
      in_stock: allInStock
    };
  });
  res.json({ kits: list, discount_percent: Math.round(KIT_DISCOUNT * 100) });
});

// Shared kit-detail computation. Single source of truth for the /api/kits/:id
// JSON response AND the server-side-rendered /kits/:id HTML page.
function buildKitDetail(kitId) {
  const kit = KITS[kitId];
  if (!kit) return { found: false };
  const inventory = readInventory();
  const items = kit.items
    .map(({ id, quantity }) => {
      const p = PRODUCT_BY_ID[id];
      if (!p) return null;
      const stock = inventory[id]?.stock ?? 0;
      const discountedPrice = +(p.price * (1 - KIT_DISCOUNT)).toFixed(2);
      return {
        sku_id: id,
        name: p.name,
        unit: p.unit,
        original_price: p.price,
        price: discountedPrice,
        image: p.image,
        quantity,
        line_total: +(discountedPrice * quantity).toFixed(2),
        stock,
        in_stock: stock >= quantity,
        low_stock: stock > 0 && stock < (inventory[id]?.low_stock_threshold || 10)
      };
    })
    .filter(Boolean);
  const subtotal = +items.reduce((s, i) => s + i.line_total, 0).toFixed(2);
  const raw_subtotal = +items.reduce((s, i) => s + i.original_price * i.quantity, 0).toFixed(2);
  return {
    found: true,
    kit_id: kitId,
    name: kit.name,
    grade_label: kit.grade_label,
    age_range: kit.age_range,
    tagline: kit.tagline,
    hero_color: kit.hero_color,
    items,
    subtotal,
    raw_subtotal,
    savings: +(raw_subtotal - subtotal).toFixed(2),
    all_in_stock: items.every(i => i.in_stock)
  };
}

app.get('/api/kits/:kitId', (req, res) => {
  const detail = buildKitDetail(req.params.kitId);
  if (!detail.found) return res.status(404).json({ error: 'Kit not found.' });
  const { found, all_in_stock, ...payload } = detail;
  res.json(payload);
});

// Server-side render of a kit detail page: fills SEO placeholder tokens in KIT_TEMPLATE
// with per-kit values and injects a VALID Product JSON-LD (real price/availability).
function renderKitPage(detail) {
  const url = `${SITE_URL}/kits/${detail.kit_id}`;
  const title = `${detail.name} | Fast Track School Supplies`;
  const description = `${detail.tagline} Ages ${detail.age_range}. ${detail.items.length} items, bundled at ${Math.round(KIT_DISCOUNT * 100)}% off and shipped to your door.`;
  const productSchema = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: detail.name,
    description: detail.tagline,
    category: 'School Supply Kit',
    brand: { '@type': 'Brand', name: 'Fast Track School Supplies' },
    audience: { '@type': 'EducationalAudience', audienceType: detail.age_range, educationalRole: 'Student' },
    offers: {
      '@type': 'Offer',
      price: detail.subtotal.toFixed(2),
      priceCurrency: 'USD',
      availability: detail.all_in_stock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
      url,
      seller: { '@type': 'Organization', name: 'Fast Track School Supplies' }
    },
    url,
    isRelatedTo: detail.items.slice(0, 8).map(i => ({ '@type': 'Product', name: i.name }))
  };
  const jsonLd = `<script type="application/ld+json">\n${JSON.stringify(productSchema, null, 2)}\n</script>`;
  return KIT_TEMPLATE
    .split('{{KIT_TITLE}}').join(htmlEscape(title))
    .split('{{KIT_OG_TITLE}}').join(htmlEscape(title))
    .split('{{KIT_DESCRIPTION}}').join(htmlEscape(description))
    .split('{{KIT_CANONICAL}}').join(url)
    .split('{{KIT_H1}}').join(htmlEscape(detail.name))
    .split('<!--KIT_JSONLD-->').join(jsonLd);
}

// Server-side render of /store: injects an ItemList of Products (with offers) so the
// collection page exposes price/availability schema in the initial HTML.
function renderStorePage() {
  const inventory = readInventory();
  const elements = PRODUCTS.map((p, i) => {
    const stock = inventory[p.id]?.stock ?? 0;
    return {
      '@type': 'ListItem',
      position: i + 1,
      item: {
        '@type': 'Product',
        name: p.name,
        category: 'School Supplies',
        ...(p.image && /^https:\/\//i.test(p.image) ? { image: p.image } : {}),
        brand: { '@type': 'Brand', name: 'Fast Track School Supplies' },
        offers: {
          '@type': 'Offer',
          price: p.price.toFixed(2),
          priceCurrency: 'USD',
          availability: stock > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
          url: `${SITE_URL}/store`,
          seller: { '@type': 'Organization', name: 'Fast Track School Supplies' }
        }
      }
    };
  });
  const itemList = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: 'Fast Track School Supplies — Full Catalog',
    numberOfItems: elements.length,
    itemListElement: elements
  };
  const jsonLd = `<script type="application/ld+json">\n${JSON.stringify(itemList, null, 2)}\n</script>\n</head>`;
  return STORE_TEMPLATE.replace('</head>', jsonLd);
}

// ---------- Stripe checkout (handles one-time AND subscription) ----------
app.post('/api/checkout', async (req, res) => {
  if (!stripe) return res.status(500).json({ error: 'Stripe is not configured. Set STRIPE_SECRET_KEY.' });
  try {
    const cart = normalizeCart(req.body);
    if (!cart.length) return res.status(400).json({ error: 'Cart is empty.' });

    const isSubscription = req.body.mode === 'subscription';
    const intervalKey = isSubscription ? (req.body.interval || 'monthly') : null;
    const recurring = isSubscription ? SUBSCRIPTION_INTERVALS[intervalKey] : null;
    if (isSubscription && !recurring) {
      return res.status(400).json({ error: `Unknown subscription interval: ${intervalKey}` });
    }

    // Stock check (subscriptions still need stock for the first shipment)
    const inventory = readInventory();
    const oos = cart.filter(item => {
      const product = PRODUCTS.find(p => p.name === item.name);
      if (!product) return false;
      return (inventory[product.id]?.stock || 0) < item.quantity;
    });
    if (oos.length) {
      return res.status(400).json({
        error: 'Some items are out of stock.',
        out_of_stock: oos.map(i => i.name)
      });
    }

    // Build line items. Apply subscription discount to unit price.
    const line_items = cart.map(item => {
      const effectivePrice = isSubscription ? item.price * (1 - SUBSCRIPTION_DISCOUNT) : item.price;
      // Stripe requires absolute HTTPS URLs for product images. Relative URLs (like
      // placeholder /assets/photo-coming.svg) cause "Not a valid URL" errors.
      const isAbsoluteHttps = item.image && /^https:\/\//i.test(item.image);
      const priceData = {
        currency: 'usd',
        product_data: {
          name: item.name + (isSubscription ? ` (${recurring.label})` : ''),
          description: item.unit || undefined,
          images: isAbsoluteHttps ? [item.image] : []
        },
        unit_amount: Math.round(effectivePrice * 100)
      };
      if (isSubscription) {
        priceData.recurring = { interval: recurring.interval, interval_count: recurring.interval_count };
      }
      return { price_data: priceData, quantity: item.quantity };
    });

    const shipping_options = [{
      shipping_rate_data: {
        type: 'fixed_amount',
        display_name: 'Standard shipping',
        fixed_amount: {
          amount: FLAT_SHIPPING_CENTS,
          currency: 'usd'
        },
        delivery_estimate: {
          minimum: { unit: 'business_day', value: 3 },
          maximum: { unit: 'business_day', value: 7 }
        }
      }
    }];

    const sessionParams = {
      mode: isSubscription ? 'subscription' : 'payment',
      line_items,
      shipping_address_collection: { allowed_countries: ['US'] },
      automatic_tax: { enabled: true },
      phone_number_collection: { enabled: true },
      // Lets customers enter promo codes at checkout. Codes are created in
      // Stripe Dashboard -> Products -> Coupons -> Create promotion code.
      allow_promotion_codes: true,
      success_url: `${BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/cancel`,
      metadata: {
        source: sanitizeText(req.body.source, 50) || 'cart',
        subscription_interval: sanitizeText(intervalKey, 50) || '',
        kit_id: sanitizeText(req.body.kit_id, 50) || '',
        gift_note: sanitizeText(req.body.gift_note, 500),
        sender_name: sanitizeText(req.body.sender_name, 100)
      }
    };

    // shipping_options and customer_creation are only valid in 'payment' mode.
    // In 'subscription' mode, shipping is baked into the recurring price and
    // Stripe creates the customer automatically (required for recurring billing).
    if (isSubscription) {
      sessionParams.subscription_data = {
        description: `Fast Track recurring kit · ${recurring.label}`,
        metadata: {
          interval: intervalKey,
          source: req.body.source || 'cart'
        }
      };
    } else {
      sessionParams.shipping_options = shipping_options;
      sessionParams.customer_creation = 'if_required';
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    res.json({ url: session.url });
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Customer portal (manage / cancel subscriptions) ----------
app.post('/api/customer-portal', async (req, res) => {
  if (!stripe) return res.status(500).json({ error: 'Stripe is not configured.' });
  try {
    const { customer_id } = req.body;
    if (!customer_id) return res.status(400).json({ error: 'customer_id required' });
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: customer_id,
      return_url: `${BASE_URL}/`
    });
    res.json({ url: portalSession.url });
  } catch (err) {
    console.error('Portal error:', err);
    res.status(500).json({ error: err.message });
  }
});

const MAX_QTY_PER_ITEM = 50;
const MAX_ITEMS_IN_CART = 100;

function normalizeCart(body) {
  if (!Array.isArray(body.items) || body.items.length === 0) return [];
  if (body.items.length > MAX_ITEMS_IN_CART) return [];  // reject absurdly long carts

  const isKit = !!body.kit_id && !!KITS[body.kit_id];
  return body.items
    .map(item => {
      // Look up the product server-side — never trust prices/names from the client
      const p = item.sku_id ? PRODUCT_BY_ID[item.sku_id] : null;
      if (!p) return null;
      // Clamp quantity to a sane range
      let qty = parseInt(item.quantity, 10);
      if (!Number.isFinite(qty) || qty < 1) qty = 1;
      if (qty > MAX_QTY_PER_ITEM) qty = MAX_QTY_PER_ITEM;
      const price = isKit ? +(p.price * (1 - KIT_DISCOUNT)).toFixed(2) : p.price;
      return { name: p.name, unit: p.unit, price, image: p.image, quantity: qty };
    })
    .filter(Boolean);
}

// Sanitize free-text input: strip control characters, cap length
function sanitizeText(s, maxLen = 500) {
  if (typeof s !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, maxLen);
}

// ---------- Admin APIs ----------
app.get('/api/admin/overview', requireAdmin, (_req, res) => {
  const orders = readOrders();
  const inventory = readInventory();
  const now = Date.now();
  const oneWeek = 7 * 24 * 60 * 60 * 1000;
  const weekOrders = orders.filter(o => now - new Date(o.created_at).getTime() < oneWeek);

  const lowStock = Object.entries(inventory)
    .filter(([_id, v]) => v.stock <= (v.low_stock_threshold || 10))
    .map(([id, v]) => ({ sku_id: id, name: PRODUCT_BY_ID[id]?.name || id, stock: v.stock, threshold: v.low_stock_threshold }));

  const skuCounts = {};
  for (const o of orders) for (const i of o.items) if (i.sku_id) {
    skuCounts[i.sku_id] = (skuCounts[i.sku_id] || 0) + i.quantity;
  }
  const topProducts = Object.entries(skuCounts)
    .map(([id, count]) => ({ sku_id: id, name: PRODUCT_BY_ID[id]?.name || id, units_sold: count }))
    .sort((a, b) => b.units_sold - a.units_sold)
    .slice(0, 10);

  res.json({
    totals: {
      orders_all_time: orders.length,
      revenue_all_time_cents: orders.reduce((s, o) => s + (o.amount_total_cents || 0), 0),
      orders_this_week: weekOrders.length,
      revenue_this_week_cents: weekOrders.reduce((s, o) => s + (o.amount_total_cents || 0), 0),
      pending_fulfillment: orders.filter(o => o.fulfillment === 'pending').length
    },
    low_stock: lowStock,
    top_products: topProducts
  });
});

app.get('/api/admin/orders', requireAdmin, (_req, res) => {
  res.json({ orders: readOrders() });
});

app.post('/api/admin/orders/:id/fulfillment', requireAdmin, (req, res) => {
  const orders = readOrders();
  const order = orders.find(o => o.id === req.params.id || o.short_id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  order.fulfillment = req.body.status || order.fulfillment;
  writeOrders(orders);
  res.json({ order });
});

app.get('/api/admin/inventory', requireAdmin, (_req, res) => {
  const inv = readInventory();
  const rows = PRODUCTS.map(p => ({
    sku_id: p.id,
    name: p.name,
    unit: p.unit,
    price: p.price,
    image: p.image,
    stock: inv[p.id]?.stock ?? 0,
    low_stock_threshold: inv[p.id]?.low_stock_threshold ?? 10
  }));
  res.json({ inventory: rows });
});

app.post('/api/admin/inventory/:skuId', requireAdmin, (req, res) => {
  const inv = readInventory();
  if (!inv[req.params.skuId]) inv[req.params.skuId] = { stock: 0, low_stock_threshold: 10 };
  if (typeof req.body.stock === 'number') inv[req.params.skuId].stock = req.body.stock;
  if (typeof req.body.adjust === 'number') inv[req.params.skuId].stock = Math.max(0, (inv[req.params.skuId].stock || 0) + req.body.adjust);
  if (typeof req.body.low_stock_threshold === 'number') inv[req.params.skuId].low_stock_threshold = req.body.low_stock_threshold;
  writeInventory(inv);
  res.json({ sku_id: req.params.skuId, ...inv[req.params.skuId] });
});

// ---------- Admin: Products CRUD (the "Product Manager") ----------
// Generate a URL-safe unique id from a name. Ids are immutable once created (kits + order logs
// reference them), so this only runs on create.
function slugifyId(name, existingIds) {
  const base = String(name).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'product';
  let id = base, n = 2;
  while (existingIds.has(id)) id = `${base}-${n++}`;
  return id;
}

// Validate + normalize an incoming product body. partial=true skips required-field checks (updates).
function validateProductBody(body, { partial } = {}) {
  const out = {};
  if (body.name !== undefined || !partial) {
    const name = sanitizeText(body.name, 120);
    if (!name) return { ok: false, error: 'Name is required.' };
    out.name = name;
  }
  if (body.price !== undefined || !partial) {
    const price = Number(body.price);
    if (!Number.isFinite(price) || price <= 0 || price > 100000) {
      return { ok: false, error: 'Price must be a positive number.' };
    }
    out.price = +price.toFixed(2);
  }
  if (body.unit !== undefined) out.unit = sanitizeText(body.unit, 120);
  if (body.keywords !== undefined) {
    let kw = body.keywords;
    if (typeof kw === 'string') kw = kw.split(',');
    out.keywords = (Array.isArray(kw) ? kw : []).map(k => sanitizeText(k, 60)).filter(Boolean).slice(0, 30);
  }
  return { ok: true, value: out };
}

// List products with live stock joined in.
app.get('/api/admin/products', requireAdmin, (_req, res) => {
  const inv = readInventory();
  res.json({
    products: PRODUCTS.map(p => ({
      ...p,
      stock: inv[p.id]?.stock ?? 0,
      low_stock_threshold: inv[p.id]?.low_stock_threshold ?? 10
    }))
  });
});

// Create a product (photo uploaded separately after).
app.post('/api/admin/products', requireAdmin, (req, res) => {
  const v = validateProductBody(req.body, { partial: false });
  if (!v.ok) return res.status(400).json({ error: v.error });
  const products = readProducts();
  const id = slugifyId(v.value.name, new Set(products.map(p => p.id)));
  const product = {
    id, name: v.value.name, price: v.value.price,
    unit: v.value.unit || '', image: '/assets/photo-coming.svg', keywords: v.value.keywords || []
  };
  products.push(product);
  products.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  writeProducts(products);
  const inv = readInventory();
  if (!inv[id]) { inv[id] = { stock: 0, low_stock_threshold: 10 }; writeInventory(inv); }
  reloadCatalog();
  res.json({ product });
});

// Update a product (id immutable; only name/price/unit/keywords editable).
app.post('/api/admin/products/:id', requireAdmin, (req, res) => {
  const products = readProducts();
  const product = products.find(p => p.id === req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found.' });
  const v = validateProductBody(req.body, { partial: true });
  if (!v.ok) return res.status(400).json({ error: v.error });
  Object.assign(product, v.value);
  products.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  writeProducts(products);
  reloadCatalog();
  res.json({ product });
});

// Delete a product — blocked (409) if any kit references it, so a kit can't silently lose an item.
app.delete('/api/admin/products/:id', requireAdmin, (req, res) => {
  const id = req.params.id;
  const usedBy = Object.values(KITS).filter(kit => kit.items.some(i => i.id === id)).map(kit => kit.name);
  if (usedBy.length) return res.status(409).json({ error: 'in_kit', kits: usedBy });
  const products = readProducts();
  if (!products.some(p => p.id === id)) return res.status(404).json({ error: 'Product not found.' });
  writeProducts(products.filter(p => p.id !== id));
  const inv = readInventory();
  if (inv[id]) { delete inv[id]; writeInventory(inv); }
  reloadCatalog();
  res.json({ ok: true });
});

// Upload/replace a product photo. Stored on the persistent disk, served via /uploads/<id>.<ext>,
// saved as an absolute https URL (Stripe Checkout requires absolute image URLs).
app.post('/api/admin/products/:id/image', requireAdmin, upload.single('image'), (req, res) => {
  const products = readProducts();
  const product = products.find(p => p.id === req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found.' });
  if (!req.file) return res.status(400).json({ error: 'No image uploaded.' });
  const extByType = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
  const ext = extByType[req.file.mimetype];
  if (!ext) return res.status(400).json({ error: 'Image must be JPG, PNG, WebP, or GIF.' });
  const filename = `${product.id}.${ext}`;
  writeFileSync(join(IMAGES_DIR, filename), req.file.buffer);
  product.image = `${SITE_URL}/uploads/${filename}`;
  writeProducts(products);
  reloadCatalog();
  res.json({ image: product.image });
});

// ---------- Boot ----------
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Fast Track running at ${BASE_URL}`);
  console.log(`Stripe:    ${stripe ? 'configured' : 'NOT configured'}`);
  console.log(`Admin:     ${ADMIN_USERNAME} / ${ADMIN_PASSWORD === 'change-me' ? '⚠️  default password (set ADMIN_PASSWORD!)' : '✓ set'}`);
});
