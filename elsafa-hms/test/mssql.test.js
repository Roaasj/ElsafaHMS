// اختبار محوّل SQL Server من غير سيرفر: تحويل الباراميترز وأنواعها و TOP
import { test } from 'node:test';
import assert from 'node:assert/strict';
import sql from 'mssql';
import { bind, topSql } from '../src/db/mssql.js';

test('mssql: ? بتتحول لـ @p0.. والأنواع صح', () => {
  const req = new sql.Request();
  const q = bind(req, 'SELECT * FROM T WHERE a = ? AND b = ? AND c = ? AND d = ? AND e = ?', [5, 12.5, 'نص', new Date(0), null]);
  assert.equal(q, 'SELECT * FROM T WHERE a = @p0 AND b = @p1 AND c = @p2 AND d = @p3 AND e = @p4');
  assert.equal(req.parameters.p0.type, sql.Int);
  assert.equal(req.parameters.p1.type.declaration, 'decimal');
  assert.equal(req.parameters.p2.type, sql.NVarChar);
  assert.equal(req.parameters.p3.type.declaration, 'datetime2');
  assert.equal(req.parameters.p4.value, null);
  assert.throws(() => bind(new sql.Request(), 'SELECT ?', [1, 2]));
});

test('mssql: TOP', () => {
  assert.equal(topSql('SELECT Id FROM T ORDER BY Id DESC', 5), 'SELECT TOP (5) Id FROM T ORDER BY Id DESC');
  assert.equal(topSql('  SELECT DISTINCT a FROM T', 3), 'SELECT DISTINCT TOP (3) a FROM T');
});

test('mssql: تحديثات القاعدة بتتقسم صح (GO)', async () => {
  const { migrations, splitSql, LATEST } = await import('../src/db/migrate.js');
  const { readFileSync } = await import('node:fs');
  assert.equal(LATEST(), 26);
  const m4 = splitSql(readFileSync(migrations().find((m) => m.version === 4).path, 'utf8'));
  assert.ok(m4.some((p) => p.startsWith('ALTER TABLE Users DROP CONSTRAINT CK_Users_Role')) && m4.some((p) => p.startsWith('CREATE TABLE PayOrders')));
  const m2 = migrations().find((m) => m.version === 2);
  const parts = splitSql(readFileSync(m2.path, 'utf8'));
  assert.ok(parts.every((p) => !/^\s*GO\s*$/im.test(p)));
  const dyn = parts.find((p) => p.includes('@fk sysname'));
  assert.ok(dyn.includes('EXEC') && dyn.includes('SELECT @fk'));
  assert.ok(parts.some((p) => p.startsWith('ALTER TABLE Receipts ALTER COLUMN VisitId INT NULL')));
});
