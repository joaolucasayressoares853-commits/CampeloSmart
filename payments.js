import crypto from 'node:crypto';

export function normalizeCpf(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!/^\d{11}$/.test(digits) || /^([\d])\1{10}$/.test(digits)) return null;

  const calculate = (length) => {
    let sum = 0;
    for (let index = 0; index < length - 1; index += 1) {
      sum += Number(digits[index]) * (length - index);
    }
    const remainder = (sum * 10) % 11;
    return remainder === 10 ? 0 : remainder;
  };
  if (calculate(10) !== Number(digits[9]) || calculate(11) !== Number(digits[10])) return null;
  return digits;
}

export function hashCpf(cpf) {
  return crypto.createHash('sha256').update(String(cpf)).digest('hex');
}

export function verifyWebhookSignature(rawBody, signature, secret) {
  if (!signature || !secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const provided = String(signature).replace(/^sha256=/, '');
  const providedBuffer = Buffer.from(provided, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  return providedBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}
