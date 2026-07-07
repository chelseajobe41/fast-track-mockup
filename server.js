import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import multer from 'multer';
import Anthropic from '@anthropic-ai/sdk';
import Stripe from 'stripe';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, copyFileSync, unlinkSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { randomBytes } from 'crypto';

// ---------- Boot ----------
const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE_URL = 'https://fasttrackschoolsupplies.com';
const KIT_DISCOUNT = 0.10;  // 10% bundle discount vs buying items individually

// Product images are stored as site-relative paths: uploaded photos live at /uploads/<file>,
// placeholders/bundled art at /assets/... . Relative paths let the storefront <img> tags resolve
// correctly whether we're on localhost (local review) or the live domain. Stripe and schema.org,
// however, require absolute https URLs — absolutize() upgrades a leading-slash path to the public
// domain at those points of use. Already-absolute URLs (e.g. external CDN photos) pass through.
function absolutize(url) {
  if (!url) return url;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('/')) return SITE_URL + url;
  return url;
}

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

// ---------- Draft catalog (edit -> preview -> publish) ----------
// Admin catalog edits are held in a DRAFT file customers never see. The storefront serves the
// published catalog; the owner previews the draft with a token, then publishes (draft becomes
// the live catalog in one step). The draft file existing == "you have unpublished changes".
// Stock and shipping stay instant — they're operational, not presentational.
const DRAFT_PATH = join(DATA_DIR, 'products-draft.json');
function readDraft() { return existsSync(DRAFT_PATH) ? JSON.parse(readFileSync(DRAFT_PATH, 'utf8')) : null; }
function discardDraftFile() { if (existsSync(DRAFT_PATH)) unlinkSync(DRAFT_PATH); }
// What the admin edits: the draft if one exists, else a working copy of the published catalog.
function workingProducts() { return readDraft() ?? readProducts(); }
// Persist an edited working copy. If it's identical to what's already published (e.g. the owner
// undid their edit), drop the draft instead so the admin doesn't show a phantom "unpublished" state.
function saveWorking(list) {
  if (JSON.stringify(list) === JSON.stringify(readProducts())) { discardDraftFile(); return false; }
  writeJsonAtomic(DRAFT_PATH, list);
  return true;
}
// Summary of draft vs published, for the admin's "unpublished changes" bar.
function draftSummary() {
  const draft = readDraft();
  const contentChanged = contentHasDraft();
  if (!draft && !contentChanged) return { unpublished: false, added: 0, changed: 0, removed: 0, content_changed: false };
  let added = 0, changed = 0, removed = 0;
  if (draft) {
    const pub = readProducts();
    const pubById = new Map(pub.map(p => [p.id, p]));
    const draftIds = new Set(draft.map(p => p.id));
    for (const p of draft) {
      const q = pubById.get(p.id);
      if (!q) added++;
      else if (JSON.stringify(p) !== JSON.stringify(q)) changed++;
    }
    removed = pub.filter(p => !draftIds.has(p.id)).length;
  }
  return { unpublished: true, added, changed, removed, content_changed: contentChanged };
}

// ---------- Store preview sessions ----------
// Short-lived tokens minted by the admin. A preview request (?preview=<token>, then a cookie so
// navigation keeps working) makes the storefront render the DRAFT catalog with a banner. Tokens
// expire after 30 minutes; checkout is blocked in preview so draft prices can never be charged.
const PREVIEW_TOKENS = new Map(); // token -> expiry epoch ms
const PREVIEW_TTL_MS = 30 * 60 * 1000;
function getCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}
function validPreviewToken(req) {
  const tok = req.query?.preview || getCookie(req, 'ft_preview');
  if (!tok || tok === 'off') return null;
  const exp = PREVIEW_TOKENS.get(tok);
  if (!exp || exp < Date.now()) { PREVIEW_TOKENS.delete(tok); return null; }
  return tok;
}
// The catalog a given request should see: draft in a valid preview session, published otherwise.
function catalogFor(req) {
  if (validPreviewToken(req)) {
    const draft = readDraft();
    if (draft) return { list: draft, byId: Object.fromEntries(draft.map(p => [p.id, p])), preview: true };
  }
  return { list: PRODUCTS, byId: PRODUCT_BY_ID, preview: false };
}
// Fixed banner injected into previewed storefront pages so preview is unmistakable.
function injectPreviewBanner(html) {
  const banner = `
<div style="position:fixed;left:0;right:0;bottom:0;z-index:9999;background:#223A3F;color:#FAF6EF;font-family:'Parkinsans',system-ui,sans-serif;font-size:14px;font-weight:600;padding:13px 20px;display:flex;align-items:center;justify-content:center;gap:14px;box-shadow:0 -8px 30px rgba(21,37,40,0.25);flex-wrap:wrap;">
  <span style="display:inline-flex;align-items:center;gap:8px;"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#FDCA06" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>Store preview — these changes are not live yet. Customers can't see this.</span>
  <span style="display:inline-flex;gap:10px;">
    <a href="/admin" style="color:#FDCA06;text-decoration:underline;">Back to admin</a>
    <a href="/store?preview=off" style="color:#FAF6EF;opacity:0.8;text-decoration:underline;">Exit preview</a>
  </span>
</div>`;
  return html.includes('</body>') ? html.replace('</body>', banner + '\n</body>') : html + banner;
}
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
  },
  // Storefront content the owner edits in the Storefront customizer (Draft -> Preview -> Publish).
  content: {
    announcement: { enabled: false, text: '', link: '' },
    hero_title: 'Shop the store',
    hero_subtitle: 'Build your own kit or pick up something for next semester.',
    featured_ids: []
  }
};
function normContent(c = {}) {
  const d = DEFAULT_SETTINGS.content;
  return {
    announcement: { ...d.announcement, ...(c.announcement || {}) },
    hero_title: typeof c.hero_title === 'string' ? c.hero_title : d.hero_title,
    hero_subtitle: typeof c.hero_subtitle === 'string' ? c.hero_subtitle : d.hero_subtitle,
    featured_ids: Array.isArray(c.featured_ids) ? c.featured_ids : []
  };
}
function readSettings() {
  if (!existsSync(SETTINGS_PATH)) return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  try {
    const s = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
    return {
      shipping: { ...DEFAULT_SETTINGS.shipping, ...(s.shipping || {}) },
      content: normContent(s.content),
      // content_draft is only present while there are unpublished storefront edits
      ...(s.content_draft ? { content_draft: normContent(s.content_draft) } : {})
    };
  } catch { return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)); }
}
function writeSettings(s) { writeJsonAtomic(SETTINGS_PATH, s); }

// ----- Storefront content: published vs draft -----
function readContent() { return readSettings().content; }
function readContentDraft() { const s = readSettings(); return s.content_draft || null; }
function workingContent() { return readContentDraft() ?? readContent(); }
function contentHasDraft() {
  const s = readSettings();
  return !!(s.content_draft && JSON.stringify(s.content_draft) !== JSON.stringify(s.content));
}
// Save edited content to the draft. If it matches what's published, clear the draft (no phantom state).
function saveContentDraft(next) {
  const s = readSettings();
  const norm = normContent(next);
  if (JSON.stringify(norm) === JSON.stringify(s.content)) { delete s.content_draft; writeSettings(s); return false; }
  s.content_draft = norm; writeSettings(s); return true;
}
function publishContent() { const s = readSettings(); if (!s.content_draft) return false; s.content = s.content_draft; delete s.content_draft; writeSettings(s); return true; }
function discardContentDraft() { const s = readSettings(); if (!s.content_draft) return false; delete s.content_draft; writeSettings(s); return true; }
// The content a given request should see: draft in a valid preview session, else published.
function contentFor(req) { return validPreviewToken(req) && readContentDraft() ? readContentDraft() : readContent(); }

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
      const orgCode = (session.custom_fields || []).find(f => f.key === 'organization_code')?.text?.value || null;
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
        organization_code: orgCode,
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
  '/settings.json',       // store settings (shipping config) — admin-only
  '/products-draft.json'  // unpublished draft catalog — visible only via preview sessions
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
// Preview sessions get the draft catalog so the owner sees unpublished changes.
app.get('/products.json', (req, res) => res.json(catalogFor(req).list));

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
app.get('/store', (req, res) => {
  // Leaving preview: clear the cookie and land on the live store.
  if (req.query.preview === 'off') {
    res.setHeader('Set-Cookie', 'ft_preview=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly');
    return res.redirect(302, '/store');
  }
  const tok = validPreviewToken(req);
  // Entering preview via a fresh token link: set the session cookie so /products.json and kit
  // pages opened from here stay in preview without carrying the query param around.
  if (tok && req.query.preview) {
    res.setHeader('Set-Cookie', `ft_preview=${tok}; Path=/; Max-Age=${PREVIEW_TTL_MS / 1000}; SameSite=Lax; HttpOnly`);
  }
  const { list } = catalogFor(req);
  let html = renderStorePage(list, contentFor(req));
  // Banner shows for ANY valid preview session (catalog draft, content draft, or just previewing).
  if (validPreviewToken(req)) html = injectPreviewBanner(html);
  res.type('html').send(html);
});
app.get('/kits', (_req, res) => res.sendFile(join(__dirname, 'kits.html')));
// Old query-param kit URLs 301 to clean paths (preserves any existing inbound links/shares).
app.get('/kit', (req, res) => res.redirect(301, KITS[req.query.id] ? `/kits/${req.query.id}` : '/kits'));
// Server-side-rendered kit detail page (clean URL). Fills SEO tokens + valid Product JSON-LD.
app.get('/kits/:kitId', (req, res) => {
  const { byId } = catalogFor(req);
  const detail = buildKitDetail(req.params.kitId, byId);
  if (!detail.found) return res.redirect(302, '/kits');
  let html = renderKitPage(detail);
  if (validPreviewToken(req)) html = injectPreviewBanner(html);
  res.type('html').send(html);
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
app.get('/api/kits', (req, res) => {
  const { byId } = catalogFor(req);
  const inventory = readInventory();
  const list = Object.entries(KITS).map(([kit_id, kit]) => {
    const items = kit.items.map(({ id, quantity }) => {
      const p = byId[id];
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
function buildKitDetail(kitId, byId = PRODUCT_BY_ID) {
  const kit = KITS[kitId];
  if (!kit) return { found: false };
  const inventory = readInventory();
  const items = kit.items
    .map(({ id, quantity }) => {
      const p = byId[id];
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
  const detail = buildKitDetail(req.params.kitId, catalogFor(req).byId);
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
function renderStorePage(products = PRODUCTS, content = readContent()) {
  const inventory = readInventory();
  const elements = products.map((p, i) => {
    const stock = inventory[p.id]?.stock ?? 0;
    return {
      '@type': 'ListItem',
      position: i + 1,
      item: {
        '@type': 'Product',
        name: p.name,
        category: 'School Supplies',
        ...(absolutize(p.image) && /^https:\/\//i.test(absolutize(p.image)) ? { image: absolutize(p.image) } : {}),
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
  // Storefront content injection: featured ids for the client, hero copy, and the announcement bar.
  const featured = (content.featured_ids || []).filter(id => products.some(p => p.id === id));
  const contentScript = `<script>window.__STORE_CONTENT__=${JSON.stringify({ featured_ids: featured })};</script>`;
  const jsonLd = `<script type="application/ld+json">\n${JSON.stringify(itemList, null, 2)}\n</script>\n${contentScript}\n</head>`;
  const announce = content.announcement;
  const announceHtml = (announce && announce.enabled && announce.text)
    ? `<div class="announce-bar">${announce.link ? `<a href="${htmlEscape(announce.link)}">${htmlEscape(announce.text)}</a>` : htmlEscape(announce.text)}</div>`
    : '';
  return STORE_TEMPLATE
    .replace('</head>', jsonLd)
    .replace('<!--ANNOUNCEMENT_BAR-->', announceHtml)
    .replace('{{HERO_TITLE}}', htmlEscape(content.hero_title || 'Shop the store'))
    .replace('{{HERO_SUBTITLE}}', htmlEscape(content.hero_subtitle || ''));
}

// ---------- Stripe checkout (handles one-time AND subscription) ----------
app.post('/api/checkout', async (req, res) => {
  // Never charge against a draft: preview sessions see draft prices, but checkout always uses the
  // published catalog — so block it entirely in preview to avoid "the price I saw" confusion.
  // Checked before anything else so the preview message always wins.
  if (validPreviewToken(req)) {
    return res.status(400).json({ error: "You're viewing a store preview. Publish your changes in the admin, then order from the live store." });
  }
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
      // Stripe requires absolute HTTPS URLs for product images. Site-relative paths (uploaded
      // photos at /uploads/..., placeholder /assets/photo-coming.svg) are upgraded to the public
      // domain; anything still not https (shouldn't happen) is dropped to avoid "Not a valid URL".
      const absImage = absolutize(item.image);
      const isAbsoluteHttps = absImage && /^https:\/\//i.test(absImage);
      const priceData = {
        currency: 'usd',
        product_data: {
          name: item.name + (isSubscription ? ` (${recurring.label})` : ''),
          description: item.unit || undefined,
          images: isAbsoluteHttps ? [absImage] : []
        },
        unit_amount: Math.round(effectivePrice * 100)
      };
      if (isSubscription) {
        priceData.recurring = { interval: recurring.interval, interval_count: recurring.interval_count };
      }
      return { price_data: priceData, quantity: item.quantity };
    });

    // Shipping is computed from the store's shipping settings (flat rate, or order-total tiers
    // the owner sets in the admin). Basis is the cart subtotal in cents.
    const subtotalCents = line_items.reduce((s, li) => s + li.price_data.unit_amount * li.quantity, 0);
    const shipping_options = [{
      shipping_rate_data: {
        type: 'fixed_amount',
        display_name: 'Standard shipping',
        fixed_amount: {
          amount: shippingCentsFor(subtotalCents),
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
      // Optional organization/fundraiser code — captured on the order so the owner can rebate the
      // group. Tracking only (no customer discount). Read back from the session in the webhook.
      custom_fields: [{
        key: 'organization_code',
        label: { type: 'custom', custom: 'Organization or fundraiser code (optional)' },
        type: 'text',
        optional: true,
        text: { maximum_length: 50 }
      }],
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
// Set of product ids that any grade kit depends on — used to flag "critical" stock problems
// (a kit can't ship if one of its items is out).
function kitItemIds() {
  const s = new Set();
  for (const kit of Object.values(KITS)) for (const i of kit.items) s.add(i.id);
  return s;
}
function kitsUsing(id) {
  return Object.values(KITS).filter(kit => kit.items.some(i => i.id === id)).map(k => k.name);
}
const PLACEHOLDER_IMAGE = '/assets/photo-coming.svg';

app.get('/api/admin/overview', requireAdmin, (_req, res) => {
  const orders = readOrders();
  const inventory = readInventory();
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const weekOrders = orders.filter(o => now - new Date(o.created_at).getTime() < 7 * DAY);
  const prevWeekOrders = orders.filter(o => {
    const age = now - new Date(o.created_at).getTime();
    return age >= 7 * DAY && age < 14 * DAY;
  });
  const sumCents = list => list.reduce((s, o) => s + (o.amount_total_cents || 0), 0);

  // 14-day revenue series (oldest -> newest) for the dashboard sparkline. Bucket by UTC date.
  const days = [];
  for (let d = 13; d >= 0; d--) {
    const dayStart = new Date(now - d * DAY);
    const key = dayStart.toISOString().slice(0, 10);
    const dayOrders = orders.filter(o => (o.created_at || '').slice(0, 10) === key);
    days.push({ date: key, cents: sumCents(dayOrders), orders: dayOrders.length });
  }

  // Best sellers by units AND revenue
  const skuUnits = {}, skuRev = {};
  for (const o of orders) for (const i of o.items || []) if (i.sku_id) {
    skuUnits[i.sku_id] = (skuUnits[i.sku_id] || 0) + i.quantity;
    skuRev[i.sku_id] = (skuRev[i.sku_id] || 0) + (i.line_total_cents || 0);
  }
  const topProducts = Object.keys(skuUnits)
    .map(id => ({ sku_id: id, name: PRODUCT_BY_ID[id]?.name || id, image: PRODUCT_BY_ID[id]?.image || PLACEHOLDER_IMAGE, units_sold: skuUnits[id], revenue_cents: skuRev[id] || 0 }))
    .sort((a, b) => b.units_sold - a.units_sold)
    .slice(0, 5);

  // Low stock (all) + "needs attention" feed prioritizing kit-critical shortages
  const kitIds = kitItemIds();
  const lowStock = Object.entries(inventory)
    .filter(([_id, v]) => v.stock <= (v.low_stock_threshold || 10))
    .map(([id, v]) => ({ sku_id: id, name: PRODUCT_BY_ID[id]?.name || id, stock: v.stock, threshold: v.low_stock_threshold, in_kit: kitIds.has(id) }));

  const attention = [];
  for (const [id, v] of Object.entries(inventory)) {
    if (!PRODUCT_BY_ID[id]) continue;
    const inKit = kitIds.has(id);
    if (v.stock === 0) attention.push({ sku_id: id, name: PRODUCT_BY_ID[id].name, kind: 'out', in_kit: inKit, kits: inKit ? kitsUsing(id) : [], severity: inKit ? 3 : 2 });
    else if (v.stock <= (v.low_stock_threshold || 10)) attention.push({ sku_id: id, name: PRODUCT_BY_ID[id].name, kind: 'low', stock: v.stock, in_kit: inKit, kits: inKit ? kitsUsing(id) : [], severity: inKit ? 2 : 1 });
  }
  // Products missing a photo (still on the placeholder) are worth flagging too
  for (const p of PRODUCTS) {
    if (!p.image || p.image === PLACEHOLDER_IMAGE) attention.push({ sku_id: p.id, name: p.name, kind: 'no_photo', in_kit: kitIds.has(p.id), severity: 1 });
  }
  attention.sort((a, b) => b.severity - a.severity);

  // Back-to-school readiness: share of the catalog that's actually sellable right now
  // (in stock + has a real photo + has a description/keywords), plus the gaps behind the score.
  let ready = 0, missingPhoto = 0, missingDesc = 0, outCount = 0;
  for (const p of PRODUCTS) {
    const stock = inventory[p.id]?.stock ?? 0;
    const hasPhoto = p.image && p.image !== PLACEHOLDER_IMAGE;
    const hasDesc = !!(p.unit || (p.keywords || []).length);
    if (stock === 0) outCount++;
    if (!hasPhoto) missingPhoto++;
    if (!hasDesc) missingDesc++;
    if (stock > 0 && hasPhoto && hasDesc) ready++;
  }
  const total = PRODUCTS.length || 1;
  const kitsReady = Object.values(KITS).filter(kit => kit.items.every(i => (inventory[i.id]?.stock || 0) >= i.quantity)).length;

  res.json({
    totals: {
      orders_all_time: orders.length,
      revenue_all_time_cents: sumCents(orders),
      orders_this_week: weekOrders.length,
      revenue_this_week_cents: sumCents(weekOrders),
      revenue_prev_week_cents: sumCents(prevWeekOrders),
      orders_prev_week: prevWeekOrders.length,
      pending_fulfillment: orders.filter(o => o.fulfillment === 'pending').length,
      aov_cents: orders.length ? Math.round(sumCents(orders) / orders.length) : 0
    },
    revenue_series: days,
    low_stock: lowStock,
    attention: attention.slice(0, 8),
    attention_total: attention.length,
    top_products: topProducts,
    readiness: {
      pct: Math.round((ready / total) * 100),
      ready, total,
      out_of_stock: outCount,
      missing_photo: missingPhoto,
      missing_desc: missingDesc,
      kits_ready: kitsReady,
      kits_total: Object.keys(KITS).length
    }
  });
});

app.get('/api/admin/orders', requireAdmin, (_req, res) => {
  res.json({ orders: readOrders() });
});

const FULFILLMENT_STATES = ['pending', 'packed', 'shipped'];
app.post('/api/admin/orders/:id/fulfillment', requireAdmin, (req, res) => {
  const status = req.body.status;
  if (!FULFILLMENT_STATES.includes(status)) {
    return res.status(400).json({ error: `Status must be one of: ${FULFILLMENT_STATES.join(', ')}.` });
  }
  const orders = readOrders();
  const order = orders.find(o => o.id === req.params.id || o.short_id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  order.fulfillment = status;
  const nowIso = new Date().toISOString();
  if (status === 'packed') order.packed_at = order.packed_at || nowIso;
  if (status === 'shipped') { order.packed_at = order.packed_at || nowIso; order.shipped_at = nowIso; }
  writeOrders(orders);
  res.json({ order });
});

// Printable packing slip / pick list for an order. Opened in a new tab and printed to fill the box.
app.get('/api/admin/orders/:id/packing-slip', requireAdmin, (req, res) => {
  const order = readOrders().find(o => o.id === req.params.id || o.short_id === req.params.id);
  if (!order) return res.status(404).type('html').send('<h1>Order not found</h1>');
  const money = c => `$${((c || 0) / 100).toFixed(2)}`;
  const addr = order.shipping_address;
  const shipTo = addr
    ? [order.customer_name, addr.line1, addr.line2, `${addr.city || ''}, ${addr.state || ''} ${addr.postal_code || ''}`.trim(), addr.country]
        .filter(Boolean).map(htmlEscape).join('<br>')
    : htmlEscape(order.customer_name || order.customer_email || 'Customer');
  const rows = (order.items || []).map(i => `
    <tr>
      <td class="qty">${i.quantity}</td>
      <td>${htmlEscape(i.name)}${i.sku_id ? `<div class="sku">${htmlEscape(i.sku_id)}</div>` : ''}</td>
      <td class="chk"></td>
    </tr>`).join('');
  const orderDate = order.created_at ? new Date(order.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '';
  const totalUnits = (order.items || []).reduce((s, i) => s + i.quantity, 0);
  const orgLine = order.organization_code ? `<div class="org">Organization / fundraiser code: <strong>${htmlEscape(order.organization_code)}</strong></div>` : '';
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Packing slip ${htmlEscape(order.short_id || '')}</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; color: #1a2b2e; margin: 0; padding: 40px; }
    .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #223A3F; padding-bottom: 16px; margin-bottom: 24px; }
    .brand { font-size: 22px; font-weight: 800; color: #223A3F; }
    .brand span { color: #DC3D2D; }
    .brand small { display:block; font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: #6A6F71; font-weight: 700; margin-top: 2px; }
    .doc { text-align: right; }
    .doc h1 { font-size: 16px; margin: 0 0 4px; letter-spacing: 0.04em; text-transform: uppercase; color: #6A6F71; }
    .doc .no { font-size: 20px; font-weight: 800; }
    .doc .date { font-size: 12px; color: #6A6F71; }
    .meta { display: flex; gap: 48px; margin-bottom: 22px; }
    .meta h2 { font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: #6A6F71; margin: 0 0 6px; }
    .meta div { font-size: 14px; line-height: 1.5; }
    .org { background: #FFF9E8; border: 1px solid #FDCA06; border-radius: 8px; padding: 10px 14px; font-size: 13px; margin-bottom: 20px; }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: #6A6F71; border-bottom: 2px solid #223A3F; padding: 8px 10px; }
    td { padding: 11px 10px; border-bottom: 1px solid #E8E4DC; font-size: 14px; vertical-align: top; }
    td.qty { font-weight: 800; font-size: 16px; width: 56px; }
    td.chk { width: 48px; }
    td.chk::before { content: ''; display: inline-block; width: 20px; height: 20px; border: 2px solid #223A3F; border-radius: 5px; }
    th.chk { text-align: center; }
    .sku { font-size: 11px; color: #9aa0a2; margin-top: 2px; }
    .foot { margin-top: 24px; display: flex; justify-content: space-between; font-size: 13px; color: #6A6F71; }
    .foot strong { color: #223A3F; font-size: 15px; }
    .print-btn { position: fixed; top: 16px; right: 16px; background: #223A3F; color: #fff; border: none; padding: 10px 18px; border-radius: 999px; font-weight: 700; cursor: pointer; font-family: inherit; }
    @media print { .print-btn { display: none; } body { padding: 24px; } }
  </style></head>
  <body>
    <button class="print-btn" onclick="window.print()">Print</button>
    <div class="head">
      <div class="brand">Fast Track <span>School Supplies</span><small>Packing Slip</small></div>
      <div class="doc"><h1>Order</h1><div class="no">#${htmlEscape(order.short_id || '')}</div><div class="date">${htmlEscape(orderDate)}</div></div>
    </div>
    <div class="meta">
      <div><h2>Ship to</h2><div>${shipTo}</div></div>
      <div><h2>Contact</h2><div>${htmlEscape(order.customer_email || '')}${order.customer_phone ? '<br>' + htmlEscape(order.customer_phone) : ''}</div></div>
      <div><h2>Type</h2><div>${order.order_type === 'subscription' ? 'Subscription refill' : 'One-time order'}</div></div>
    </div>
    ${orgLine}
    <table>
      <thead><tr><th>Qty</th><th>Item</th><th class="chk">Pack</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="foot"><div>${totalUnits} item${totalUnits === 1 ? '' : 's'} to pack</div><div>Order total <strong>${money(order.amount_total_cents)}</strong></div></div>
  </body></html>`;
  res.type('html').send(html);
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

// List products with live stock joined in. The admin edits the WORKING catalog (draft if one
// exists), and the response carries the unpublished-changes summary for the publish bar.
app.get('/api/admin/products', requireAdmin, (_req, res) => {
  const inv = readInventory();
  res.json({
    products: workingProducts().map(p => ({
      ...p,
      stock: inv[p.id]?.stock ?? 0,
      low_stock_threshold: inv[p.id]?.low_stock_threshold ?? 10
    })),
    ...draftSummary()
  });
});

// Create a product (photo uploaded separately after). Lands in the draft — not live until publish.
app.post('/api/admin/products', requireAdmin, (req, res) => {
  const v = validateProductBody(req.body, { partial: false });
  if (!v.ok) return res.status(400).json({ error: v.error });
  const products = workingProducts();
  const id = slugifyId(v.value.name, new Set([...products.map(p => p.id), ...PRODUCTS.map(p => p.id)]));
  const product = {
    id, name: v.value.name, price: v.value.price,
    unit: v.value.unit || '', image: '/assets/photo-coming.svg', keywords: v.value.keywords || []
  };
  products.push(product);
  products.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  saveWorking(products);
  // Seed stock right away — the editor saves stock in the same action, and stock is live-instant.
  const inv = readInventory();
  if (!inv[id]) { inv[id] = { stock: 0, low_stock_threshold: 10 }; writeInventory(inv); }
  res.json({ product, ...draftSummary() });
});

// Update a product (id immutable; only name/price/unit/keywords editable). Draft-only until publish.
app.post('/api/admin/products/:id', requireAdmin, (req, res) => {
  const products = workingProducts();
  const product = products.find(p => p.id === req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found.' });
  const v = validateProductBody(req.body, { partial: true });
  if (!v.ok) return res.status(400).json({ error: v.error });
  Object.assign(product, v.value);
  products.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  saveWorking(products);
  res.json({ product, ...draftSummary() });
});

// Delete a product — blocked (409) if any kit references it, so a kit can't silently lose an item.
// Removal is a draft change; its inventory row is pruned when the removal is published.
app.delete('/api/admin/products/:id', requireAdmin, (req, res) => {
  const id = req.params.id;
  const usedBy = Object.values(KITS).filter(kit => kit.items.some(i => i.id === id)).map(kit => kit.name);
  if (usedBy.length) return res.status(409).json({ error: 'in_kit', kits: usedBy });
  const products = workingProducts();
  if (!products.some(p => p.id === id)) return res.status(404).json({ error: 'Product not found.' });
  saveWorking(products.filter(p => p.id !== id));
  res.json({ ok: true, ...draftSummary() });
});

// Upload/replace a product photo. Stored on the persistent disk under a unique filename per upload
// so the published catalog keeps pointing at the OLD file until the change is published (and the
// new URL busts browser caches). Served via /uploads/<file>; stored relative, absolutized only
// where Stripe/schema.org need a full https URL.
app.post('/api/admin/products/:id/image', requireAdmin, upload.single('image'), (req, res) => {
  const products = workingProducts();
  const product = products.find(p => p.id === req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found.' });
  if (!req.file) return res.status(400).json({ error: 'No image uploaded.' });
  const extByType = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
  const ext = extByType[req.file.mimetype];
  if (!ext) return res.status(400).json({ error: 'Image must be JPG, PNG, WebP, or GIF.' });
  const filename = `${product.id}-${Date.now()}.${ext}`;
  writeFileSync(join(IMAGES_DIR, filename), req.file.buffer);
  product.image = `/uploads/${filename}`;
  saveWorking(products);
  res.json({ image: product.image, ...draftSummary() });
});

// Duplicate a product into the draft (new id, "(copy)" name, stock reset to 0). Fast way to add a
// near-identical item (e.g. another marker color).
app.post('/api/admin/products/:id/duplicate', requireAdmin, (req, res) => {
  const products = workingProducts();
  const src = products.find(p => p.id === req.params.id);
  if (!src) return res.status(404).json({ error: 'Product not found.' });
  const name = `${src.name} (copy)`;
  const id = slugifyId(name, new Set([...products.map(p => p.id), ...PRODUCTS.map(p => p.id)]));
  const product = { id, name, price: src.price, unit: src.unit || '', image: src.image || PLACEHOLDER_IMAGE, keywords: [...(src.keywords || [])] };
  products.push(product);
  products.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  saveWorking(products);
  const inv = readInventory();
  if (!inv[id]) { inv[id] = { stock: 0, low_stock_threshold: inv[src.id]?.low_stock_threshold ?? 10 }; writeInventory(inv); }
  res.json({ product, ...draftSummary() });
});

// Bulk price change across selected products (draft). mode: 'pct' (+/- %), 'add' (+/- $), 'set' ($).
// Path is /api/admin/bulk/* so it can't be swallowed by /api/admin/products/:id.
app.post('/api/admin/bulk/price', requireAdmin, (req, res) => {
  const { ids, mode, value } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'Select at least one product.' });
  if (!['pct', 'add', 'set'].includes(mode)) return res.status(400).json({ error: 'Invalid price change type.' });
  const num = Number(value);
  if (!isFinite(num)) return res.status(400).json({ error: 'Enter a valid number.' });
  if (mode === 'set' && num < 0) return res.status(400).json({ error: 'Price cannot be negative.' });
  const idSet = new Set(ids);
  const products = workingProducts();
  let changed = 0;
  for (const p of products) {
    if (!idSet.has(p.id)) continue;
    let np = mode === 'pct' ? p.price * (1 + num / 100) : mode === 'add' ? p.price + num : num;
    np = Math.max(0, Math.round(np * 100) / 100);
    if (np !== p.price) { p.price = np; changed++; }
  }
  saveWorking(products);
  // Note: `updated` (not `changed`) — draftSummary() also has a `changed` key; spread order matters.
  res.json({ ...draftSummary(), updated: changed });
});

// Bulk stock update (instant — inventory is operational, not draft). Each item: {id, stock} or {id, adjust}.
// Path is /api/admin/bulk/* so it can't be swallowed by /api/admin/inventory/:skuId.
app.post('/api/admin/bulk/inventory', requireAdmin, (req, res) => {
  const items = req.body.items;
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'No items to update.' });
  const inv = readInventory();
  // Accept any product in the working catalog (draft ∪ published) — stock is operational and a
  // brand-new, not-yet-published product can still be stocked.
  const validIds = new Set(workingProducts().map(p => p.id));
  let updated = 0;
  for (const it of items) {
    if (!it || typeof it.id !== 'string' || !validIds.has(it.id)) continue;
    if (!inv[it.id]) inv[it.id] = { stock: 0, low_stock_threshold: 10 };
    if (typeof it.adjust === 'number') { inv[it.id].stock = Math.max(0, (inv[it.id].stock || 0) + it.adjust); updated++; }
    else if (typeof it.stock === 'number') { inv[it.id].stock = Math.max(0, Math.round(it.stock)); updated++; }
  }
  writeInventory(inv);
  res.json({ updated });
});

// ---------- Admin: publish / discard / preview ----------
// Publish: the draft becomes the live catalog in one atomic step, then the in-memory catalog
// (store SSR, checkout prices, AI prompt) reloads. Inventory rows for removed products are pruned.
app.post('/api/admin/publish', requireAdmin, (_req, res) => {
  const draft = readDraft();
  const hasContent = contentHasDraft();
  if (!draft && !hasContent) return res.status(400).json({ error: 'No unpublished changes to publish.' });
  const summary = draftSummary();
  // Catalog draft (if any): guard kits, promote, prune inventory, reload memory.
  if (draft) {
    const ids = new Set(draft.map(p => p.id));
    const brokenKits = Object.values(KITS).filter(kit => kit.items.some(i => !ids.has(i.id))).map(kit => kit.name);
    if (brokenKits.length) return res.status(409).json({ error: 'in_kit', kits: brokenKits });
    writeProducts(draft);
    discardDraftFile();
    const inv = readInventory();
    let pruned = false;
    for (const key of Object.keys(inv)) if (!ids.has(key)) { delete inv[key]; pruned = true; }
    if (pruned) writeInventory(inv);
    reloadCatalog();
  }
  // Storefront content draft (if any): promote.
  if (hasContent) publishContent();
  res.json({ ok: true, published: { added: summary.added, changed: summary.changed, removed: summary.removed, content_changed: summary.content_changed } });
});

// Discard: throw away all unpublished changes (catalog + storefront content); live is untouched.
// Also prune inventory rows for products that only existed in the discarded draft (never published),
// so a created-then-discarded product leaves nothing behind.
app.post('/api/admin/discard-draft', requireAdmin, (_req, res) => {
  discardDraftFile();
  discardContentDraft();
  const publishedIds = new Set(readProducts().map(p => p.id));
  const inv = readInventory();
  let pruned = false;
  for (const key of Object.keys(inv)) if (!publishedIds.has(key)) { delete inv[key]; pruned = true; }
  if (pruned) writeInventory(inv);
  res.json({ ok: true });
});

// Mint a 30-minute store-preview link (opened in a new tab by the admin's Preview button).
app.post('/api/admin/preview', requireAdmin, (_req, res) => {
  for (const [t, exp] of PREVIEW_TOKENS) if (exp < Date.now()) PREVIEW_TOKENS.delete(t);
  const token = randomBytes(16).toString('hex');
  PREVIEW_TOKENS.set(token, Date.now() + PREVIEW_TTL_MS);
  res.json({ url: `/store?preview=${token}`, expires_minutes: PREVIEW_TTL_MS / 60000 });
});

// ---------- Admin: Shipping settings ----------
app.get('/api/admin/shipping', requireAdmin, (_req, res) => {
  res.json(readSettings().shipping);
});
app.post('/api/admin/shipping', requireAdmin, (req, res) => {
  const body = req.body || {};
  const toCents = v => Math.max(0, Math.round(Number(v) || 0));
  const shipping = { mode: body.mode === 'tiers' ? 'tiers' : 'flat', flat_cents: toCents(body.flat_cents) };
  if (Array.isArray(body.tiers)) {
    shipping.tiers = body.tiers
      .map(t => ({
        up_to_cents: (t.up_to_cents === null || t.up_to_cents === '' || t.up_to_cents === undefined) ? null : toCents(t.up_to_cents),
        ship_cents: toCents(t.ship_cents)
      }))
      .sort((a, b) => (a.up_to_cents === null ? Infinity : a.up_to_cents) - (b.up_to_cents === null ? Infinity : b.up_to_cents));
  } else {
    shipping.tiers = DEFAULT_SETTINGS.shipping.tiers.map(t => ({ ...t }));
  }
  if (shipping.mode === 'tiers' && !shipping.tiers.length) {
    return res.status(400).json({ error: 'Add at least one shipping tier.' });
  }
  const settings = readSettings();
  settings.shipping = shipping;
  writeSettings(settings);
  res.json(shipping);
});

// Public shipping config so cart pages can show accurate shipping before checkout.
app.get('/api/shipping-config', (_req, res) => res.json(readSettings().shipping));

// ---------- Admin: Storefront content (announcement, hero, featured) ----------
// Only http(s) or root-relative links are allowed on the announcement bar (blocks javascript: URLs).
function safeLink(u) { u = String(u || '').trim(); return (/^https?:\/\//i.test(u) || u.startsWith('/')) ? u.slice(0, 300) : ''; }
app.get('/api/admin/content', requireAdmin, (_req, res) => res.json(workingContent()));
app.post('/api/admin/content', requireAdmin, (req, res) => {
  const b = req.body || {};
  const validIds = new Set(workingProducts().map(p => p.id));
  const next = {
    announcement: {
      enabled: !!(b.announcement && b.announcement.enabled),
      text: String(b.announcement?.text || '').slice(0, 160),
      link: safeLink(b.announcement?.link)
    },
    hero_title: (String(b.hero_title ?? '').trim().slice(0, 80)) || DEFAULT_SETTINGS.content.hero_title,
    hero_subtitle: String(b.hero_subtitle ?? '').trim().slice(0, 240),
    featured_ids: Array.isArray(b.featured_ids) ? [...new Set(b.featured_ids)].filter(id => validIds.has(id)).slice(0, 8) : []
  };
  saveContentDraft(next);
  res.json({ content: next, ...draftSummary() });
});
// Public storefront content (preview-aware) — the store JS reads this for featured badges.
app.get('/api/store-content', (req, res) => res.json(contentFor(req)));

// Lightweight unpublished-changes summary for the global publish bar (any admin panel).
app.get('/api/admin/pending', requireAdmin, (_req, res) => res.json(draftSummary()));

// ---------- Boot ----------
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Fast Track running at ${BASE_URL}`);
  console.log(`Stripe:    ${stripe ? 'configured' : 'NOT configured'}`);
  console.log(`Admin:     ${ADMIN_USERNAME} / ${ADMIN_PASSWORD === 'change-me' ? '⚠️  default password (set ADMIN_PASSWORD!)' : '✓ set'}`);
});
