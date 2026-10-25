ALTER TABLE customers ADD COLUMN IF NOT EXISTS balance NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS cpf_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS customers_cpf_hash_idx ON customers(cpf_hash) WHERE cpf_hash IS NOT NULL;

ALTER TABLE sales ALTER COLUMN status SET DEFAULT 'pending';
ALTER TABLE sales ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE sales ADD COLUMN IF NOT EXISTS payment_intent_id TEXT;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS payment_provider TEXT;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS sales_payment_intent_idx ON sales(payment_intent_id) WHERE payment_intent_id IS NOT NULL;
