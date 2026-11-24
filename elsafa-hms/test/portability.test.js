// حارس التوافق: أي استعلام خارج طبقة src/db لازم يشتغل على SQLite وSQL Server بنفس النص.
// الصيغ الخاصة بمحرك واحد ممنوعة هنا (لو محتاجها، مكانها src/db/ ورا واجهة مشتركة زي db.top).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../src');
function files(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) return p.endsWith(path.join('src', 'db')) ? [] : files(p);
    return p.endsWith('.js') ? [p] : [];
  });
}
// صيغ SQLite فقط / T-SQL فقط
const BANNED = [
  [/\bIFNULL\s*\(/i, 'IFNULL (استخدم COALESCE)'], [/\bGROUP_CONCAT\b/i, 'GROUP_CONCAT'], [/\bSTRING_AGG\b/i, 'STRING_AGG'],
  [/\bstrftime\s*\(/i, 'strftime'], [/\bjulianday\s*\(/i, 'julianday'], [/\bdatetime\s*\(\s*'/i, "datetime('...')"], [/\bdate\s*\(\s*'now'/i, "date('now')"],
  [/\bGETDATE\s*\(/i, 'GETDATE'], [/\bSYSDATETIME\s*\(/i, 'SYSDATETIME'], [/\bISNULL\s*\(/i, 'ISNULL (استخدم COALESCE)'],
  [/\bDATEADD\s*\(/i, 'DATEADD'], [/\bDATEDIFF\s*\(/i, 'DATEDIFF'], [/\bSELECT\s+(DISTINCT\s+)?TOP\b/i, 'TOP (استخدم db.top)'],
  [/\bINSERT\s+OR\s+(REPLACE|IGNORE)\b/i, 'INSERT OR ...'], [/\bON\s+CONFLICT\b/i, 'ON CONFLICT'], [/\bLIMIT\s+(\d+|\?)/i, 'LIMIT (استخدم db.top)'],
  [/\bAS\s+(INTEGER|TEXT)\s*\)/i, 'CAST AS INTEGER/TEXT'],
  // دمج نصوص جوه SQL: || (SQLite) أو + بين نصوص (T-SQL)
  [/(SELECT|WHERE|LIKE|AND|OR)\b[^`'"]*['"`][^'"`]*['"`]\s*\|\|\s*\?/i, "دمج بـ || جوه SQL"], [/\?\s*\|\|\s*['"]%/, "LIKE '...' || ? || '...'"], [/LIKE\s+'[^']*'\s*\|\|/i, 'LIKE ... ||'],
];
test('مفيش صيغ SQL خاصة بمحرك واحد خارج src/db', () => {
  const bad = [];
  for (const f of files(ROOT)) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      for (const [re, why] of BANNED) if (re.test(line)) bad.push(`${path.relative(ROOT, f)}:${i + 1}  ${why}`);
    });
  }
  assert.deepEqual(bad, [], 'صيغ غير محمولة:\n' + bad.join('\n'));
});
