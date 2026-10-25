import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import pg from 'pg';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizeCpf, hashCpf, verifyWebhookSignature } from './payments.js';

const app = express();
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined
});
const port = Number(process.env.PORT || 4173);
const adminToken = process.env.ADMIN_TOKEN || 'troque-esta-chave-em-producao';
const webhookSecret = process.env.PAYMENT_WEBHOOK_SECRET || '';
const paymentProviderUrl = process.env.PAYMENT_PROVIDER_URL || '';
const paymentProviderToken = process.env.PAYMENT_PROVIDER_TOKEN || '';

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false, crossOriginOpenerPolicy: false }));
app.use('/api/payments/webhook', express.raw({ type: 'application/json', limit: '128kb' }));
app.use(express.json({ limit: '128kb' }));
app.use(cors({ origin: process.env.ALLOWED_ORIGIN ? process.env.ALLOWED_ORIGIN.split(',') : true }));
app.use('/api', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false }));

app.use((req, res, next) => {
  if (req.path === '/manifest.json') res.setHeader('Cache-Control', 'no-cache');
  if (req.path === '/sw.js') res.setHeader('Cache-Control', 'no-cache');
  if (/^\/api\//.test(req.path)) res.setHeader('Cache-Control', 'no-store');
  next();
});

function recordName(product) {
  return product.name || product.code;
}

function requireAdmin(req, res, next) {
  const token = req.get('x-admin-token');
  const valid = token && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(adminToken));
  if (!valid) return res.status(401).json({ error: 'Credencial administrativa inválida.' });
  next();
}

async function migrate() {
  await pool.query(`CREATE TABLE IF NOT EXISTS migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const dir = path.join(process.cwd(), 'migrations');
  const files = (await fs.readdir(dir)).filter(file => file.endsWith('.sql')).sort();
  for (const file of files) {
    const applied = await pool.query('SELECT 1 FROM migrations WHERE name = $1', [file]);
    if (applied.rowCount) continue;
    const sql = await fs.readFile(path.join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO migrations(name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`Migration applied: ${file}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

async function seedProducts() {
  const catalog = JSON.parse(await fs.readFile(path.join(process.cwd(), 'produtos.json'), 'utf8'));
  await pool.query('BEGIN');
  try {
    for (const product of catalog) {
      await pool.query(`INSERT INTO products(code, name, price, category, expiry_date, emoji, stock)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (code) DO UPDATE SET
          name=EXCLUDED.name, price=EXCLUDED.price, category=EXCLUDED.category,
          expiry_date=EXCLUDED.expiry_date, emoji=EXCLUDED.emoji, updated_at=now()`,
      [product.codigo, product.nome, product.preco, product.categoria, product.dataValidade, product.imagem, product.estoque ?? 20]);
    }
    await pool.query('COMMIT');
  } catch (error) {
    await pool.query('ROLLBACK');
    throw error;
  }
}

app.get('/api/health', async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/products', async (_req, res, next) => {
  try {
    const result = await pool.query(`SELECT code AS codigo, name AS nome, price::float AS preco,
      category AS categoria, expiry_date::text AS "dataValidade", emoji AS imagem,
      stock AS estoque, source AS origem, updated_at AS atualizado
      FROM products WHERE active = TRUE AND stock > 0 ORDER BY category, name`);
    res.json(result.rows);
  } catch (error) { next(error); }
});

app.post('/api/payments/intents', async (req, res, next) => {
  if (!paymentProviderUrl || !paymentProviderToken) {
    return res.status(503).json({ error: 'Gateway de pagamento não configurado.' });
  }
  const client = await pool.connect();
  try {
    const cpf = normalizeCpf(req.body.cpf);
    if (!cpf) return res.status(400).json({ error: 'CPF inválido.' });
    const saleId = String(req.body.saleId || '');
    if (!/^\w{8,16}$/.test(saleId)) return res.status(400).json({ error: 'Identificador da compra inválido.' });
    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100000) {
      return res.status(400).json({ error: 'Valor inválido.' });
    }

    await client.query('BEGIN');
    const sale = await client.query('SELECT id, total, status, payment_intent_id FROM sales WHERE id=$1', [saleId]);
    if (!sale.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Venda não encontrada.' });
    }
    if (sale.rows[0].status === 'confirmed') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Venda já paga.' });
    }
    if (sale.rows[0].payment_intent_id) {
      await client.query('ROLLBACK');
      return res.json({ id: sale.rows[0].payment_intent_id, status: 'pending' });
    }

    const cpfHash = hashCpf(cpf);
    const idempotencyKey = crypto.createHash('sha256').update(`campelo:${saleId}:${amount}`).digest('hex');
    const providerResponse = await fetch(paymentProviderUrl, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${paymentProviderToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ saleId, amount: Math.round(amount * 100), currency: 'BRL', cpfHash, notificationUrl: process.env.PAYMENT_NOTIFY_URL || undefined }),
      signal: AbortSignal.timeout(15_000)
    });
    const payload = await providerResponse.json().catch(() => ({}));
    if (!providerResponse.ok || !payload.id) throw Object.assign(new Error(payload.message || 'Gateway recusou a cobrança.'), { status: 502 });
    await client.query('UPDATE sales SET payment_intent_id=$1, payment_provider=$2 WHERE id=$3', [payload.id, 'configured', saleId]);
    await client.query('COMMIT');
    res.status(201).json({ id: payload.id, status: payload.status || 'pending', payload });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.status) return res.status(error.status).json({ error: error.message });
    next(error);
  } finally { client.release(); }
});

app.post('/api/payments/webhook', async (req, res, next) => {
  try {
    const signature = req.get('x-campelo-signature');
    if (!verifyWebhookSignature(req.body, signature, webhookSecret)) return res.status(401).json({ error: 'Assinatura inválida.' });
    const event = JSON.parse(req.body.toString('utf8'));
    const intentId = event.paymentIntentId || event.id;
    const approved = ['paid', 'approved', 'succeeded'].includes(event.status);
    if (!intentId) return res.status(400).json({ error: 'Evento sem intenção.' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query('SELECT id, status, total, points, customer_identifier FROM sales WHERE payment_intent_id=$1 FOR UPDATE', [intentId]);
      if (!result.rowCount) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Intenção de pagamento não encontrada.' });
      }
      const sale = result.rows[0];
      if (approved && sale.status !== 'confirmed') {
        await client.query("UPDATE sales SET status='confirmed', confirmed_at=now() WHERE id=$1", [sale.id]);
        await client.query(`UPDATE customers SET balance=balance+$1, points=points+$2, purchases=purchases+1,
          lifetime_value=lifetime_value+$3, updated_at=now() WHERE identifier=$4`, [sale.total, sale.points, sale.total, sale.customer_identifier]);
      }
      await client.query('COMMIT');
      res.json({ received: true, status: approved ? 'confirmed' : 'ignored' });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  } catch (error) { next(error); }
});

app.post('/api/sales', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { id, customer, method, items } = req.body;
    if (!/^\w{8,16}$/.test(id || '') || !/^\d{8,14}$/.test(customer || '') || !['PIX', 'Crédito', 'Débito', 'Saída'].includes(method)) {
      return res.status(400).json({ error: 'Dados da venda inválidos.' });
    }
    if (!Array.isArray(items) || !items.length || items.length > 100) {
      return res.status(400).json({ error: 'Carrinho inválido.' });
    }

    await client.query('BEGIN');
    const duplicate = await client.query('SELECT id FROM sales WHERE id = $1', [id]);
    if (duplicate.rowCount) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Venda já registrada.' });
    }

    const normalized = [];
    for (const item of items) {
      if (!item.codigo || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 99) {
        throw Object.assign(new Error('Item inválido.'), { status: 400 });
      }
      const product = await client.query(`SELECT code,name,price::float AS price,stock
        FROM products WHERE code=$1 AND active=true FOR UPDATE`, [item.codigo]);
      if (!product.rowCount) throw Object.assign(new Error(`Produto ${item.codigo} indisponível.`), { status: 400 });
      if (product.rows[0].stock < item.quantity) throw Object.assign(new Error(`Estoque insuficiente para ${recordName(product.rows[0])}.`), { status: 409 });
      const record = product.rows[0];
      await client.query('UPDATE products SET stock=stock-$1, updated_at=now() WHERE code=$2', [item.quantity, record.code]);
      const finalPrice = Math.round(record.price * (1 - (Number(item.discountPercent) || 0) / 100) * 100) / 100;
      normalized.push({ code: record.code, name: record.name, unitPrice: record.price, finalPrice, quantity: item.quantity });
    }

    const total = normalized.reduce((sum, item) => sum + item.finalPrice * item.quantity, 0);
    const original = normalized.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
    const savings = Math.round((original - total) * 100) / 100;
    const points = Math.floor(total);

    await client.query(`INSERT INTO customers(identifier) VALUES ($1) ON CONFLICT (identifier) DO NOTHING`, [customer]);
    await client.query(`INSERT INTO sales(id, customer_identifier, method, total, savings, points)
      VALUES ($1,$2,$3,$4,$5,$6)`, [id, customer, method, total, savings, points]);
    for (const item of normalized) {
      await client.query(`INSERT INTO sale_items(sale_id, product_code, product_name, unit_price, final_price, quantity)
        VALUES ($1,$2,$3,$4,$5,$6)`, [id, item.code, item.name, item.unitPrice, item.finalPrice, item.quantity]);
    }
    await client.query('COMMIT');
    const customerRecord = await pool.query('SELECT points, purchases, lifetime_value::float AS lifetime_value FROM customers WHERE identifier=$1', [customer]);
    res.status(201).json({ id, total, savings, points, status: 'pending', customer: customerRecord.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.status) return res.status(error.status).json({ error: error.message });
    next(error);
  } finally { client.release(); }
});

app.get('/api/admin/summary', requireAdmin, async (_req, res, next) => {
  try {
    const summary = await pool.query(`SELECT
      (SELECT COUNT(*)::int FROM sales) AS sales,
      (SELECT COALESCE(SUM(total),0)::float FROM sales) AS revenue,
      (SELECT COUNT(*)::int FROM products WHERE active=TRUE) AS products,
      (SELECT COUNT(*)::int FROM customers) AS customers`);
    const recent = await pool.query('SELECT id, method, total::float AS total, created_at FROM sales ORDER BY created_at DESC LIMIT 10');
    res.json({ metrics: summary.rows[0], recent: recent.rows });
  } catch (error) { next(error); }
});

app.post('/api/admin/catalog/sync', requireAdmin, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const source = String(req.body.source || 'admin').slice(0, 80);
    const products = req.body.products;
    if (!Array.isArray(products) || products.length > 5000) {
      return res.status(400).json({ error: 'Catálogo inválido: envie até 5000 produtos.' });
    }
    await client.query('BEGIN');
    let imported = 0;
    for (const product of products) {
      const code = String(product.code || product.codigo || '').replace(/[^a-zA-Z0-9_-]/g, '').toUpperCase();
      const name = String(product.name || product.nome || '').trim().slice(0, 180);
      const price = Number(product.price ?? product.preco);
      const stock = Number(product.stock ?? product.estoque ?? 0);
      if (!code || !name || !Number.isFinite(price) || price < 0 || !Number.isInteger(stock) || stock < 0) {
        throw Object.assign(new Error(`Produto inválido no catálogo: ${code || 'sem código'}`), { status: 400 });
      }
      await client.query(`INSERT INTO products(code,name,price,category,expiry_date,emoji,stock,source,source_updated_at,active)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),true)
        ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name, price=EXCLUDED.price,
          category=EXCLUDED.category, expiry_date=EXCLUDED.expiry_date, emoji=EXCLUDED.emoji,
          stock=EXCLUDED.stock, source=EXCLUDED.source, source_updated_at=now(), active=true, updated_at=now()`,
      [code, name, price, String(product.category || product.categoria || 'Geral').slice(0, 80), product.expiryDate || product.dataValidade || null,
       String(product.emoji || product.imagem || '🛒').slice(0, 12), stock, source]);
      imported += 1;
    }
    const activeCodes = products.map(product => String(product.code || product.codigo).replace(/[^a-zA-Z0-9_-]/g, '').toUpperCase()).filter(Boolean);
    let deactivated = 0;
    if (activeCodes.length) {
      const result = await client.query(`UPDATE products SET active=false, updated_at=now()
        WHERE source=$1 AND active=true AND code <> ALL($2::text[])`, [source, activeCodes]);
      deactivated = result.rowCount;
    }
    await client.query(`INSERT INTO catalog_syncs(source,status,received,imported,deactivated)
      VALUES ($1,'completed',$2,$3,$4)`, [source, products.length, imported, deactivated]);
    await client.query('COMMIT');
    res.status(201).json({ source, received: products.length, imported, deactivated });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.status) return res.status(error.status).json({ error: error.message });
    next(error);
  } finally { client.release(); }
});

app.post('/api/sales/:id/cancel', requireAdmin, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sale = await client.query(`SELECT id,status FROM sales WHERE id=$1 FOR UPDATE`, [req.params.id]);
    if (!sale.rowCount) return res.status(404).json({ error: 'Venda não encontrada.' });
    if (sale.rows[0].status !== 'pending') return res.status(409).json({ error: 'Somente venda pendente pode ser cancelada.' });
    await client.query(`UPDATE products p SET stock=p.stock+i.quantity, updated_at=now()
      FROM sale_items i WHERE i.sale_id=$1 AND p.code=i.product_code`, [req.params.id]);
    await client.query("UPDATE sales SET status='cancelled', cancelled_at=now() WHERE id=$1", [req.params.id]);
    await client.query('COMMIT');
    res.json({ id: req.params.id, status: 'cancelled' });
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); next(error); }
  finally { client.release(); }
});

app.get('/api/admin/catalog/sync', requireAdmin, async (_req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM catalog_syncs ORDER BY created_at DESC LIMIT 20');
    res.json(result.rows);
  } catch (error) { next(error); }
});

app.put('/api/admin/products/:code', requireAdmin, async (req, res, next) => {
  try {
    const { price, expiryDate, active = true } = req.body;
    if (!Number.isFinite(Number(price)) || Number(price) < 0 || active !== true && active !== false) {
      return res.status(400).json({ error: 'Dados do produto inválidos.' });
    }
    const result = await pool.query(`UPDATE products SET price=$1, expiry_date=$2, active=$3, updated_at=now()
      WHERE code=$4 RETURNING code, name, price::float AS price, expiry_date::text AS "expiryDate", active`,
    [price, expiryDate || null, active, req.params.code]);
    if (!result.rowCount) return res.status(404).json({ error: 'Produto não encontrado.' });
    res.json(result.rows[0]);
  } catch (error) { next(error); }
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'Endpoint não encontrado.' }));
app.get('/download', (_req, res) => res.redirect(302, '/download.html'));
const publicFiles = new Set([
  'index.html', 'download.html', 'manifest.json', 'sw.js',
  'ia-assistant.js', 'database.js', 'scanner.js', 'produtos.json',
  'icons/icon-192.svg', 'icons/icon-512.svg'
]);
app.use((req, res, next) => {
  if (req.method !== 'GET' || !publicFiles.has(req.path.replace(/^\//, ''))) return next();
  res.sendFile(path.join(process.cwd(), req.path.replace(/^\//, '')));
});
app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'Falha interna do servidor.' });
});

async function start() {
  await migrate();
  await seedProducts();
  app.listen(port, '0.0.0.0', () => console.log(`Campelo Smart API ouvindo em http://0.0.0.0:${port}`));
}

start().catch(error => {
  console.error(error);
  process.exit(1);
});
