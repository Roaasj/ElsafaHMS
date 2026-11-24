# أداة للمطوّر: بتعمل db/schema.sqlite.sql (للتجربة والاختبارات) من ملفات SQL Server
#   python3 scripts/gen-sqlite-schema.py
import re, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
base = (root / 'db/mssql/001_base.sql').read_text(encoding='utf8')
m2 = (root / 'db/mssql/002_inpatient.sql').read_text(encoding='utf8')
m2 = m2.split('-- @alters')[0]
m3 = (root / 'db/mssql/003_contracts.sql').read_text(encoding='utf8')  # بيشتغل زي ما هو على SQLite
m4 = (root / 'db/mssql/004_cashier.sql').read_text(encoding='utf8').split('-- @alters')[0]
m5 = (root / 'db/mssql/005_radiology.sql').read_text(encoding='utf8').split('-- @alters')[0]
m6 = (root / 'db/mssql/006_lab.sql').read_text(encoding='utf8').split('-- @alters')[0]
m7 = (root / 'db/mssql/007_tickets.sql').read_text(encoding='utf8').split('-- @alters')[0]
m8 = (root / 'db/mssql/008_floor_prices.sql').read_text(encoding='utf8')
m9 = (root / 'db/mssql/009_stores.sql').read_text(encoding='utf8').split('-- @alters')[0]
m10 = (root / 'db/mssql/010_dispense.sql').read_text(encoding='utf8').split('-- @alters')[0]
m11 = (root / 'db/mssql/011_claims.sql').read_text(encoding='utf8').split('-- @alters')[0]
m12 = (root / 'db/mssql/012_finance.sql').read_text(encoding='utf8').split('-- @alters')[0]
m13 = (root / 'db/mssql/013_lookups.sql').read_text(encoding='utf8').split('-- @alters')[0]
m14 = (root / 'db/mssql/014_diagnosis.sql').read_text(encoding='utf8').split('-- @alters')[0]
m15 = (root / 'db/mssql/015_item_default_units.sql').read_text(encoding='utf8').split('-- @alters')[0]
m16 = (root / 'db/mssql/016_clinics.sql').read_text(encoding='utf8').split('-- @alters')[0]
m17 = (root / 'db/mssql/017_stock_units.sql').read_text(encoding='utf8').split('-- @alters')[0]
m19 = (root / 'db/mssql/019_user_perm_exceptions.sql').read_text(encoding='utf8').split('-- @alters')[0]
m20 = (root / 'db/mssql/020_doctor_share_levels.sql').read_text(encoding='utf8').split('-- @alters')[0]
m21 = (root / 'db/mssql/021_price_lists.sql').read_text(encoding='utf8').split('-- @alters')[0]
m23 = (root / 'db/mssql/023_ledger.sql').read_text(encoding='utf8').split('-- @alters')[0]
m24 = (root / 'db/mssql/024_peer_link.sql').read_text(encoding='utf8').split('-- @alters')[0]
m25 = (root / 'db/mssql/025_peer_requests.sql').read_text(encoding='utf8').split('-- @alters')[0]
m26 = (root / 'db/mssql/026_eta_docs.sql').read_text(encoding='utf8').split('-- @alters')[0]
m22 = (root / 'db/mssql/022_payout_approval.sql').read_text(encoding='utf8').split('-- @alters')[0]
m18 = (root / 'db/mssql/018_roles.sql').read_text(encoding='utf8').split('-- @alters')[0]
m18 = re.sub(r'ALTER TABLE Users DROP CONSTRAINT CK_Users_Role;\s*GO', '', m18)

# التعديلات اللي في الجزء @alters بنطبقها على نص الجداول الأصلية
def sub(old, new, s):
    assert old in s, old
    return s.replace(old, new)
base = sub("  Active     BIT           NOT NULL DEFAULT 1,\n  CreatedAt  DATETIME2(0)  NOT NULL,\n  CONSTRAINT UQ_Services_Code",
           "  Active     BIT           NOT NULL DEFAULT 1,\n  CreatedAt  DATETIME2(0)  NOT NULL,\n  IncludedNights INT NULL,\n  CONSTRAINT UQ_Services_Code", base)
base = sub("  ServiceId      INT            NOT NULL REFERENCES Services(Id),\n  ServiceName", "  ServiceId      INT            NULL REFERENCES Services(Id),\n  ServiceName", base)
base = sub("CONSTRAINT CK_Visits_Type CHECK (Type IN ('clinic','emergency','lab','radiology')),", "CONSTRAINT CK_Visits_Type CHECK (Type IN ('clinic','emergency','lab','radiology','pharmacy')),", base)
base = sub("CONSTRAINT CK_Services_Dept CHECK (Dept IN ('clinic','emergency','lab','radiology')),",
           "CONSTRAINT CK_Services_Dept CHECK (Dept IN ('clinic','emergency','lab','radiology','ward','or')),", base)
base = sub("  VisitId             INT            NOT NULL REFERENCES Visits(Id),",
           "  VisitId             INT            NULL REFERENCES Visits(Id),\n  AdmissionId         INT            NULL REFERENCES Admissions(Id),\n  Note                NVARCHAR(300)  NULL,", base)
base = sub("CONSTRAINT CK_Receipts_Kind CHECK (Kind IN ('payment','refund')),",
           "CONSTRAINT CK_Receipts_Kind CHECK (Kind IN ('payment','refund','deposit','final','return')),\n  CONSTRAINT CK_Receipts_Target CHECK (VisitId IS NOT NULL OR AdmissionId IS NOT NULL),", base)
base = sub("CREATE INDEX IX_Receipts_Visit ON Receipts (VisitId);", "CREATE INDEX IX_Receipts_Visit ON Receipts (VisitId);\nCREATE INDEX IX_Receipts_Admission ON Receipts (AdmissionId);", base)
base = sub("CHECK (Role IN ('reception','supervisor','reviewer','manager'))", "CHECK (length(Role) > 0)", base)
base = sub("  VisitItemId  INT            NOT NULL REFERENCES VisitItems(Id),\n  DoctorId",
           "  VisitItemId  INT            NULL REFERENCES VisitItems(Id),\n  AdmissionItemId INT         NULL REFERENCES AdmissionItems(Id),\n  DoctorId", base)

s = base + '\n' + re.sub(r'^GO\s*$', '', m2, flags=re.M) + '\n' + re.sub(r'^GO\s*$', '', m3, flags=re.M) + '\n' + re.sub(r'^GO\s*$', '', m4, flags=re.M) + '\n' + re.sub(r'^GO\s*$', '', m5, flags=re.M) + '\n' + re.sub(r'^GO\s*$', '', m6, flags=re.M) + '\n' + re.sub(r'^GO\s*$', '', m7, flags=re.M) + '\n' + re.sub(r'^GO\s*$', '', m8, flags=re.M) + '\n' + re.sub(r'^GO\s*$', '', m9, flags=re.M) + '\n' + re.sub(r'^GO\s*$', '', m10, flags=re.M) + '\n' + re.sub(r'^GO\s*$', '', m11, flags=re.M) + '\n' + re.sub(r'^GO\s*$', '', m12, flags=re.M) + '\n' + re.sub(r'^GO\s*$', '', m13, flags=re.M) + '\n' + re.sub(r'^GO\s*$', '', m14, flags=re.M) + '\n' + re.sub(r'^GO\s*$', '', m15, flags=re.M) + '\n' + re.sub(r'^GO\s*$', '', m16, flags=re.M) + '\n' + re.sub(r'^GO\s*$', '', m17, flags=re.M) + '\n' + re.sub(r'^GO\s*$', '', m18, flags=re.M) + '\n' + re.sub(r'^GO\s*$', '', m19, flags=re.M) + '\n' + re.sub(r'^GO\s*$', '', m20, flags=re.M) + '\n' + re.sub(r'^GO\s*$', '', m21, flags=re.M) + '\n' + re.sub(r'^GO\s*$', '', m22, flags=re.M) + '\n' + re.sub(r'^GO\s*$', '', m23, flags=re.M) + '\n' + re.sub(r'^GO\s*$', '', m24, flags=re.M) + '\n' + re.sub(r'^GO\s*$', '', m25, flags=re.M) + '\n' + re.sub(r'^GO\s*$', '', m26, flags=re.M)
for ck in ('Services_Dept', 'Visits_Type', 'Admissions_Type', 'RoomClasses_Kind'):
    s, n = re.subn(r"\n\s*CONSTRAINT CK_" + ck + r" CHECK \(\w+ IN \([^)]*\)\),?", '', s)
    assert n >= 1, ck
s = re.sub(r",(\s*\n\))", r"\1", s)  # فاصلة زيادة قبل قفل الجدول بعد شيل آخر قيد
s = s.replace('INT IDENTITY(1,1) PRIMARY KEY', 'INTEGER PRIMARY KEY AUTOINCREMENT')
s = re.sub(r'NVARCHAR\((\d+|MAX)\)', 'TEXT', s)
s = re.sub(r'\bCHAR\(\d+\)', 'TEXT', s)
s = re.sub(r'DATETIME2\(0\)', 'TEXT', s)
s = re.sub(r'DECIMAL\(\d+,\d+\)', 'NUMERIC', s)
s = re.sub(r'\bTINYINT\b', 'INTEGER', s)
s = re.sub(r'\bBIT\b', 'INTEGER', s)
s = re.sub(r'(\s)DATE(\s)', r'\1TEXT\2', s)
s = s.replace("N'", "'")
s = '-- مولّد آليًا من db/mssql/*.sql بالأمر: python3 scripts/gen-sqlite-schema.py  (للتجربة والاختبارات فقط)\n' + s
(root / 'db/schema.sqlite.sql').write_text(s, encoding='utf8')
print('ok', s.count('CREATE TABLE'), 'tables')
