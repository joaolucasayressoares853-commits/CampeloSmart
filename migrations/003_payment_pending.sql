ALTER TABLE sales ALTER COLUMN status SET DEFAULT 'pending';
UPDATE sales SET status='pending' WHERE status IS NULL;
