import {
  BrowserMultiFormatReader,
  DecodeHintType,
  BarcodeFormat,
  BinaryBitmap,
  HTMLCanvasElementLuminanceSource,
  HybridBinarizer
} from '@zxing/library/esm/index.js';

const hints = new Map([
  [DecodeHintType.POSSIBLE_FORMATS, [
    BarcodeFormat.EAN_13,
    BarcodeFormat.EAN_8,
    BarcodeFormat.UPC_A,
    BarcodeFormat.UPC_E,
    BarcodeFormat.CODE_128
  ]],
  [DecodeHintType.TRY_HARDER, true]
]);

function validEAN(code) {
  if (!/^\d{8}$|^\d{12}$|^\d{13}$/.test(code)) return false;
  const digits = code.split('').map(Number);
  const check = digits.pop();
  const sum = digits.reverse().reduce((total, digit, index) => total + digit * (index % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

function decode(canvas) {
  const source = new HTMLCanvasElementLuminanceSource(canvas);
  const bitmap = new BinaryBitmap(new HybridBinarizer(source));
  return new BrowserMultiFormatReader(hints).decodeBitmap(bitmap);
}

async function decodeImage(file) {
  const bitmap = await createImageBitmap(file);
  const sourceWidth = bitmap.width;
  const sourceHeight = bitmap.height;
  const attempts = [];
  const targetSizes = [1400, 2200];

  for (const maxSize of targetSizes) {
    const scale = Math.min(1, maxSize / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.filter = 'contrast(1.35) saturate(0)';
    context.drawImage(bitmap, 0, 0, width, height);
    attempts.push(canvas);

    const crop = document.createElement('canvas');
    const cropWidth = Math.round(width * 0.92);
    const cropHeight = Math.round(height * 0.72);
    crop.width = cropWidth;
    crop.height = cropHeight;
    crop.getContext('2d').filter = 'contrast(1.8) saturate(0)';
    crop.getContext('2d').drawImage(canvas, (width - cropWidth) / 2, (height - cropHeight) * 0.58, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
    attempts.push(crop);

    const rotated = document.createElement('canvas');
    rotated.width = height;
    rotated.height = width;
    const rotatedContext = rotated.getContext('2d');
    rotatedContext.filter = 'contrast(1.5) saturate(0)';
    rotatedContext.translate(height / 2, width / 2);
    rotatedContext.rotate(Math.PI / 2);
    rotatedContext.drawImage(canvas, -width / 2, -height / 2);
    attempts.push(rotated);
  }

  let lastError;
  const candidates = [];
  for (const canvas of attempts) {
    try {
      const result = decode(canvas);
      const text = result?.text;
      if (text && validEAN(text)) candidates.push(text);
    } catch (error) { lastError = error; }
  }
  const consistent = candidates.find(text => candidates.filter(candidate => candidate === text).length >= 2);
  if (consistent) return consistent;
  if (candidates.length === 1) return candidates[0];
  bitmap.close();
  throw lastError || new Error('Código não identificado');
}

window.CampeloScanner = { decodeImage };
