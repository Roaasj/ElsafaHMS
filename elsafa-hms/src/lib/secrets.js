// تشفير الأسرار المخزنة (مفتاح الربط بين المنشآت وأي أسرار بعدها). المفتاح بيتولد مرة واحدة في data/instance.key ومبيتخزنش في القاعدة
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';

let KEY = null;
function key() {
  if (KEY) return KEY;
  const dir = path.join(ROOT, 'data');
  const file = process.env.INSTANCE_KEY_FILE || path.join(dir, 'instance.key');
  if (existsSync(file)) KEY = Buffer.from(readFileSync(file, 'utf8').trim(), 'hex');
  else {
    mkdirSync(path.dirname(file), { recursive: true });
    KEY = randomBytes(32);
    writeFileSync(file, KEY.toString('hex'), { mode: 0o600 });
  }
  return KEY;
}
export function encrypt(text) {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return 'enc1:' + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
export function decrypt(blob) {
  if (!blob || !String(blob).startsWith('enc1:')) return null;
  const b = Buffer.from(String(blob).slice(5), 'base64');
  const d = createDecipheriv('aes-256-gcm', key(), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}
