import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import Anthropic from '@anthropic-ai/sdk';
import Stripe from 'stripe';
import { Resend } from 'resend';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// ---------- Boot ----------
const __dirname = dirname(fileURLToPath(import.meta.url));
const PRODUCTS = JSON.parse(readFileSync(join(__dirname, 'products.json'), 'utf8'));
const KITS = JSON.parse(readFileSync(join(__dirname, 'kits.json'), 'utf8'));
const KIT_DISCOUNT = 0.10;  // 10% bundle discount vs buying items individually
const PRODUCT_BY_ID = Object.fromEntries(PRODUCTS.map(p => [p.id, p]));

const INVENTORY_PATH = join(__dirname, 'inventory.json');
const ORDERS_PATH = join(__dirname, 'orders.json');

const FREE_SHIPPING_THRESHOLD = 35;
const STANDARD_SHIPPING_CENTS = 500;
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
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const OWNER_EMAIL = process.env.OWNER_EMAIL;
const FROM_EMAIL = process.env.FROM_EMAIL || 'orders@fasttrackschoolsupplies.com';
const BASE_URL = process.env.BASE_URL || 'http://localhost:3001';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me';

// ---------- Persistence helpers (JSON file based) ----------
// NOTE: For higher volume, swap to SQLite or Postgres. JSON files are fine for v1.
function readInventory() { return JSON.parse(readFileSync(INVENTORY_PATH, 'utf8')); }
function writeInventory(inv) { writeFileSync(INVENTORY_PATH, JSON.stringify(inv, null, 2)); }
function readOrders() { return JSON.parse(readFileSync(ORDERS_PATH, 'utf8')); }
function writeOrders(orders) { writeFileSync(ORDERS_PATH, JSON.stringify(orders, null, 2)); }

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
const SYSTEM_PROMPT = `You are the AI assistant for Fast Track School Supplies, a service that takes school supply lists from parents and turns them into ordered kits.

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
      await sendOrderEmails(session, lineItems);
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
          // Notify customer + owner of the renewal
          await sendRenewalEmails(invoice, order);
        }
      }
    } else if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      await sendCancellationEmails(sub);
      console.log('Subscription canceled:', sub.id);
    } else if (event.type === 'invoice.payment_failed') {
      const invoice = event.data.object;
      await sendPaymentFailedEmails(invoice);
      console.log('Payment failed for invoice:', invoice.id);
    }
  } catch (e) {
    console.error('Webhook handler failed:', e);
  }
  res.json({ received: true });
});

app.use(express.json());
app.use(express.static(__dirname));

// Page routes
app.get('/upload', (_req, res) => res.sendFile(join(__dirname, 'upload.html')));
app.get('/store', (_req, res) => res.sendFile(join(__dirname, 'store.html')));
app.get('/kits', (_req, res) => res.sendFile(join(__dirname, 'kits.html')));
app.get('/kit', (_req, res) => res.sendFile(join(__dirname, 'kit.html')));
app.get('/gift', (_req, res) => res.sendFile(join(__dirname, 'gift.html')));
app.get('/success', (_req, res) => res.sendFile(join(__dirname, 'success.html')));
app.get('/cancel', (_req, res) => res.sendFile(join(__dirname, 'cancel.html')));
app.get('/terms', (_req, res) => res.sendFile(join(__dirname, 'terms.html')));
app.get('/privacy', (_req, res) => res.sendFile(join(__dirname, 'privacy.html')));
app.get('/shipping', (_req, res) => res.sendFile(join(__dirname, 'shipping.html')));
app.get('/returns', (_req, res) => res.sendFile(join(__dirname, 'returns.html')));
app.get('/admin', requireAdmin, (_req, res) => res.sendFile(join(__dirname, 'admin.html')));

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

app.get('/api/kits/:kitId', (req, res) => {
  const kit = KITS[req.params.kitId];
  if (!kit) return res.status(404).json({ error: 'Kit not found.' });
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
  res.json({
    kit_id: req.params.kitId,
    name: kit.name,
    grade_label: kit.grade_label,
    age_range: kit.age_range,
    tagline: kit.tagline,
    hero_color: kit.hero_color,
    items,
    subtotal,
    raw_subtotal,
    savings: +(raw_subtotal - subtotal).toFixed(2)
  });
});

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
      const priceData = {
        currency: 'usd',
        product_data: {
          name: item.name + (isSubscription ? ` (${recurring.label})` : ''),
          description: item.unit || undefined,
          images: item.image ? [item.image] : []
        },
        unit_amount: Math.round(effectivePrice * 100)
      };
      if (isSubscription) {
        priceData.recurring = { interval: recurring.interval, interval_count: recurring.interval_count };
      }
      return { price_data: priceData, quantity: item.quantity };
    });

    const subtotal = line_items.reduce((s, li) => s + (li.price_data.unit_amount / 100) * li.quantity, 0);
    const shipping_options = [{
      shipping_rate_data: {
        type: 'fixed_amount',
        display_name: subtotal >= FREE_SHIPPING_THRESHOLD ? 'Free shipping' : 'Standard shipping',
        fixed_amount: {
          amount: subtotal >= FREE_SHIPPING_THRESHOLD ? 0 : STANDARD_SHIPPING_CENTS,
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
      shipping_options,
      automatic_tax: { enabled: false },
      phone_number_collection: { enabled: true },
      success_url: `${BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/cancel`,
      metadata: {
        source: req.body.source || 'cart',
        subscription_interval: intervalKey || '',
        kit_id: req.body.kit_id || '',
        gift_note: (req.body.gift_note || '').slice(0, 500),
        sender_name: (req.body.sender_name || '').slice(0, 100)
      }
    };

    // Subscriptions need a customer record so the user can manage it later.
    if (isSubscription) {
      sessionParams.customer_creation = 'always';  // disabled in 'payment' mode default
      sessionParams.subscription_data = {
        description: `Fast Track recurring kit · ${recurring.label}`,
        metadata: {
          interval: intervalKey,
          source: req.body.source || 'cart'
        }
      };
    } else {
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

function normalizeCart(body) {
  if (Array.isArray(body.items) && body.items.length) {
    const isKit = !!body.kit_id && !!KITS[body.kit_id];
    return body.items
      .map(item => {
        const p = item.sku_id ? PRODUCT_BY_ID[item.sku_id] : null;
        if (!p) return null;
        // Apply kit discount if this came from a pre-built kit
        const price = isKit ? +(p.price * (1 - KIT_DISCOUNT)).toFixed(2) : p.price;
        return { name: p.name, unit: p.unit, price, image: p.image, quantity: Math.max(1, item.quantity || 1) };
      })
      .filter(Boolean);
  }
  return [];
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

// ---------- Order confirmation emails ----------
async function sendOrderEmails(session, lineItemsParam) {
  if (!resend) {
    console.warn('Resend not configured; skipping order emails.');
    return;
  }

  const items = lineItemsParam || await stripe.checkout.sessions.listLineItems(session.id, { limit: 100 });
  const itemRows = items.data.map(i => `<tr>
    <td style="padding:8px 12px;border-bottom:1px solid #e8e4dc;">${i.description}</td>
    <td style="padding:8px 12px;border-bottom:1px solid #e8e4dc;text-align:center;">${i.quantity}</td>
    <td style="padding:8px 12px;border-bottom:1px solid #e8e4dc;text-align:right;">$${(i.amount_total / 100).toFixed(2)}</td>
  </tr>`).join('');

  const total = `$${(session.amount_total / 100).toFixed(2)}`;
  const customerEmail = session.customer_details?.email;
  const customerName = session.customer_details?.name || 'Customer';
  const shippingAddr = session.shipping_details?.address;
  const shippingBlock = shippingAddr ? `${session.shipping_details.name}<br/>${shippingAddr.line1}${shippingAddr.line2 ? '<br/>' + shippingAddr.line2 : ''}<br/>${shippingAddr.city}, ${shippingAddr.state} ${shippingAddr.postal_code}` : 'No address provided';

  const customerHtml = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px;color:#223A3F;">
      <h1 style="font-size:24px;margin:0 0 8px;">Thanks for your order, ${customerName}.</h1>
      <p style="font-size:15px;color:#6A6F71;">Order ${session.id.slice(-10).toUpperCase()} is confirmed. We'll have it on the way before the first bell.</p>
      <h2 style="font-size:16px;margin:24px 0 8px;">Your items</h2>
      <table style="width:100%;border-collapse:collapse;font-size:14px;"><thead><tr><th align="left" style="padding:8px 12px;border-bottom:2px solid #223A3F;">Item</th><th align="center" style="padding:8px 12px;border-bottom:2px solid #223A3F;">Qty</th><th align="right" style="padding:8px 12px;border-bottom:2px solid #223A3F;">Price</th></tr></thead><tbody>${itemRows}</tbody></table>
      <p style="font-size:18px;font-weight:700;margin:24px 0;text-align:right;">Total: ${total}</p>
      <p style="font-size:14px;color:#6A6F71;">Shipping to:<br/>${shippingBlock}</p>
      <p style="font-size:13px;color:#6A6F71;margin-top:32px;">Questions? Reply to this email anytime.</p>
    </div>`;

  const ownerHtml = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px;color:#223A3F;">
      <h1 style="font-size:22px;margin:0 0 8px;">New Fast Track order</h1>
      <p style="font-size:15px;color:#6A6F71;">Order ${session.id.slice(-10).toUpperCase()} for ${total}</p>
      <p style="font-size:14px;"><strong>Customer:</strong> ${customerName} (${customerEmail})<br/>
      <strong>Phone:</strong> ${session.customer_details?.phone || 'n/a'}<br/>
      <strong>Source:</strong> ${session.metadata?.source || 'Direct'}</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:16px;"><thead><tr><th align="left" style="padding:8px 12px;border-bottom:2px solid #223A3F;">Item</th><th align="center" style="padding:8px 12px;border-bottom:2px solid #223A3F;">Qty</th><th align="right" style="padding:8px 12px;border-bottom:2px solid #223A3F;">Subtotal</th></tr></thead><tbody>${itemRows}</tbody></table>
      <p style="font-size:14px;margin-top:24px;"><strong>Ship to:</strong><br/>${shippingBlock}</p>
      <p style="font-size:13px;color:#6A6F71;margin-top:24px;"><a href="${BASE_URL}/admin">Open admin dashboard</a> · <a href="https://dashboard.stripe.com/payments/${session.payment_intent}">View in Stripe</a></p>
    </div>`;

  const sends = [];
  if (customerEmail) {
    sends.push(resend.emails.send({
      from: `Fast Track School Supplies <${FROM_EMAIL}>`,
      to: customerEmail,
      subject: `Your Fast Track order is confirmed`,
      html: customerHtml
    }));
  }
  if (OWNER_EMAIL) {
    sends.push(resend.emails.send({
      from: `Fast Track Orders <${FROM_EMAIL}>`,
      to: OWNER_EMAIL,
      subject: `New order ${session.id.slice(-10).toUpperCase()} · ${total}`,
      html: ownerHtml
    }));
  }
  await Promise.all(sends);
}

// ---------- Subscription event emails ----------
async function sendRenewalEmails(invoice, order) {
  if (!resend) return;
  const total = `$${(invoice.amount_paid / 100).toFixed(2)}`;
  const itemRows = order.items.map(i => `<tr>
    <td style="padding:8px 12px;border-bottom:1px solid #e8e4dc;">${i.name}</td>
    <td style="padding:8px 12px;border-bottom:1px solid #e8e4dc;text-align:center;">${i.quantity}</td>
    <td style="padding:8px 12px;border-bottom:1px solid #e8e4dc;text-align:right;">$${(i.line_total_cents / 100).toFixed(2)}</td>
  </tr>`).join('');

  const sends = [];
  if (invoice.customer_email) {
    sends.push(resend.emails.send({
      from: `Fast Track School Supplies <${FROM_EMAIL}>`,
      to: invoice.customer_email,
      subject: `Your subscription refill is on the way`,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px;color:#223A3F;">
        <h1 style="font-size:24px;margin:0 0 8px;">Your refill is shipping.</h1>
        <p style="font-size:15px;color:#6A6F71;">Your Fast Track subscription charged ${total} today. Here's what's in this shipment.</p>
        <table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:16px;"><thead><tr><th align="left" style="padding:8px 12px;border-bottom:2px solid #223A3F;">Item</th><th align="center" style="padding:8px 12px;border-bottom:2px solid #223A3F;">Qty</th><th align="right" style="padding:8px 12px;border-bottom:2px solid #223A3F;">Price</th></tr></thead><tbody>${itemRows}</tbody></table>
        <p style="font-size:18px;font-weight:700;margin:24px 0;text-align:right;">Total: ${total}</p>
        <p style="font-size:14px;color:#6A6F71;">Skip a delivery, change your interval, or cancel anytime from your <a href="${BASE_URL}/" style="color:#DC3D2D;">customer portal link in your original confirmation email</a>.</p>
      </div>`
    }));
  }
  if (OWNER_EMAIL) {
    sends.push(resend.emails.send({
      from: `Fast Track Orders <${FROM_EMAIL}>`,
      to: OWNER_EMAIL,
      subject: `Subscription renewal · ${invoice.customer_email || 'customer'} · ${total}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px;color:#223A3F;">
        <h1 style="font-size:22px;margin:0 0 8px;">Subscription renewal — ship a refill</h1>
        <p style="font-size:15px;color:#6A6F71;">Order ${invoice.id.slice(-10).toUpperCase()} for ${total}</p>
        <p style="font-size:14px;"><strong>Customer:</strong> ${invoice.customer_name || ''} (${invoice.customer_email})<br/>
        <strong>Subscription ID:</strong> ${invoice.subscription}</p>
        <table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:16px;"><thead><tr><th align="left" style="padding:8px 12px;border-bottom:2px solid #223A3F;">Item</th><th align="center" style="padding:8px 12px;border-bottom:2px solid #223A3F;">Qty</th><th align="right" style="padding:8px 12px;border-bottom:2px solid #223A3F;">Subtotal</th></tr></thead><tbody>${itemRows}</tbody></table>
        <p style="font-size:13px;color:#6A6F71;margin-top:24px;"><a href="${BASE_URL}/admin">Open admin</a> · <a href="https://dashboard.stripe.com/subscriptions/${invoice.subscription}">View subscription in Stripe</a></p>
      </div>`
    }));
  }
  await Promise.all(sends);
}

async function sendCancellationEmails(sub) {
  if (!resend) return;
  const customerEmail = sub.customer_email || (await stripe.customers.retrieve(sub.customer).catch(() => null))?.email;
  const sends = [];
  if (customerEmail) {
    sends.push(resend.emails.send({
      from: `Fast Track School Supplies <${FROM_EMAIL}>`,
      to: customerEmail,
      subject: `Your subscription is canceled`,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px;color:#223A3F;">
        <h1 style="font-size:24px;">We're sorry to see you go.</h1>
        <p style="font-size:15px;color:#6A6F71;">Your Fast Track subscription is canceled. You won't be charged again. If this was a mistake or you want to come back, reply to this email anytime.</p>
      </div>`
    }));
  }
  if (OWNER_EMAIL) {
    sends.push(resend.emails.send({
      from: `Fast Track Orders <${FROM_EMAIL}>`,
      to: OWNER_EMAIL,
      subject: `Subscription canceled · ${customerEmail || sub.id}`,
      html: `<div style="font-family:Arial,sans-serif;padding:24px;color:#223A3F;">
        <h2>Subscription canceled</h2>
        <p>Customer: ${customerEmail || 'unknown'}<br/>Subscription: ${sub.id}</p>
        <p><a href="https://dashboard.stripe.com/subscriptions/${sub.id}">View in Stripe</a></p>
      </div>`
    }));
  }
  await Promise.all(sends);
}

async function sendPaymentFailedEmails(invoice) {
  if (!resend) return;
  const sends = [];
  if (invoice.customer_email) {
    sends.push(resend.emails.send({
      from: `Fast Track School Supplies <${FROM_EMAIL}>`,
      to: invoice.customer_email,
      subject: `Action needed — your payment didn't go through`,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px;color:#223A3F;">
        <h1 style="font-size:24px;color:#c03434;">Heads up — your payment didn't go through.</h1>
        <p style="font-size:15px;color:#6A6F71;">We tried to charge $${(invoice.amount_due / 100).toFixed(2)} for your Fast Track subscription and the card was declined. We'll retry automatically, but you can update your card now to keep your subscription active.</p>
        ${invoice.hosted_invoice_url ? `<p style="margin:24px 0;"><a href="${invoice.hosted_invoice_url}" style="background:#DC3D2D;color:#fff;padding:14px 26px;border-radius:999px;text-decoration:none;font-weight:600;">Update payment method</a></p>` : ''}
        <p style="font-size:13px;color:#6A6F71;">Questions? Reply to this email.</p>
      </div>`
    }));
  }
  if (OWNER_EMAIL) {
    sends.push(resend.emails.send({
      from: `Fast Track Orders <${FROM_EMAIL}>`,
      to: OWNER_EMAIL,
      subject: `⚠️ Payment failed · ${invoice.customer_email}`,
      html: `<div style="font-family:Arial,sans-serif;padding:24px;color:#223A3F;">
        <h2>Subscription payment failed</h2>
        <p>Customer: ${invoice.customer_email}<br/>Amount: $${(invoice.amount_due / 100).toFixed(2)}<br/>Subscription: ${invoice.subscription}</p>
        <p>Stripe will retry. You can follow up directly if it persists.</p>
      </div>`
    }));
  }
  await Promise.all(sends);
}

// ---------- Boot ----------
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Fast Track running at ${BASE_URL}`);
  console.log(`Stripe:    ${stripe ? 'configured' : 'NOT configured'}`);
  console.log(`Resend:    ${resend ? 'configured' : 'NOT configured'}`);
  console.log(`Owner:     ${OWNER_EMAIL || 'NOT set'}`);
  console.log(`Admin:     ${ADMIN_USERNAME} / ${ADMIN_PASSWORD === 'change-me' ? '⚠️  default password (set ADMIN_PASSWORD!)' : '✓ set'}`);
});
