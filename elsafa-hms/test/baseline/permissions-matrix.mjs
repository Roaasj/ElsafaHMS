// مصفوفة الصلاحيات: كل دور × كل صلاحية مذكورة في الكود. بتتسجّل قبل نقل الأدوار لقاعدة البيانات، وبتتقارن بعده (لازم تتطابق بالظبط)
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export function allPermNames(root) {
  const found = new Set();
  const walk = (d) => { for (const f of readdirSync(d)) { const p = path.join(d, f); if (statSync(p).isDirectory()) { if (!/node_modules|\.git|data|test/.test(f)) walk(p); } else if (f.endsWith('.js')) {
    const s = readFileSync(p, 'utf8');
    for (const m of s.matchAll(/\b(?:need|can|anyOf)\(\s*(?:[a-zA-Z.]+,\s*)?\[?\s*'([a-zA-Z]+\.[a-zA-Z]+)'/g)) found.add(m[1]);
    for (const m of s.matchAll(/\b(?:need|can)\(\s*(?:[a-zA-Z.]+,\s*)?'([a-zA-Z]+\.[a-zA-Z]+)'/g)) found.add(m[1]);
    for (const m of s.matchAll(/anyOf\([^,]+,\s*\[([^\]]*)\]/g)) for (const x of m[1].matchAll(/'([a-zA-Z]+\.[a-zA-Z]+)'/g)) found.add(x[1]);
  } } };
  walk(path.join(root, 'src')); walk(path.join(root, 'public'));
  return found;
}
export function matrix(can, roles, perms) {
  const out = {};
  for (const r of roles) out[r] = [...perms].sort().filter((p) => can({ role: r, grants: [] }, p));
  return out;
}
