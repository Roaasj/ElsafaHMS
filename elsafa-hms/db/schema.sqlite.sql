-- مولّد آليًا من db/mssql/*.sql بالأمر: python3 scripts/gen-sqlite-schema.py  (للتجربة والاختبارات فقط)
-- =====================================================================
--  نظام إدارة مستشفى الصفا - قاعدة ElsafaHMS
--  المرحلة الأولى / الشريحة 1: المستخدمين، المرضى، الخدمات، الأطباء،
--  الزيارات الخارجية، الخزينة والإيصالات
--  يتشغل على قاعدة فاضية اسمها ElsafaHMS (npm run db:init بيعمل كده)
--  منفصلة تمامًا عن قاعدة البرنامج القديم
-- =====================================================================

CREATE TABLE Users (
  Id            INTEGER PRIMARY KEY AUTOINCREMENT,
  Username      TEXT  NOT NULL,
  FullName      TEXT NOT NULL,
  PasswordHash  TEXT NOT NULL,
  Role          TEXT  NOT NULL,      -- reception | supervisor | reviewer | manager
  Active        INTEGER           NOT NULL DEFAULT 1,
  CreatedAt     TEXT  NOT NULL,
  LastLoginAt   TEXT  NULL,
  CONSTRAINT UQ_Users_Username UNIQUE (Username),
  CONSTRAINT CK_Users_Role CHECK (length(Role) > 0)
);

CREATE TABLE Sessions (
  Id          INTEGER PRIMARY KEY AUTOINCREMENT,
  TokenHash   TEXT     NOT NULL,
  UserId      INT          NOT NULL REFERENCES Users(Id),
  CreatedAt   TEXT NOT NULL,
  ExpiresAt   TEXT NOT NULL,
  LastSeenAt  TEXT NOT NULL,
  CONSTRAINT UQ_Sessions_Token UNIQUE (TokenHash)
);

CREATE TABLE AuditLog (
  Id        INTEGER PRIMARY KEY AUTOINCREMENT,
  At        TEXT  NOT NULL,
  UserId    INT           NULL REFERENCES Users(Id),
  Action    TEXT  NOT NULL,
  Entity    TEXT  NOT NULL,
  EntityId  INT           NULL,
  OldValue  TEXT NULL,
  NewValue  TEXT NULL,
  Note      TEXT NULL
);
CREATE INDEX IX_AuditLog_Entity ON AuditLog (Entity, EntityId);
CREATE INDEX IX_AuditLog_At ON AuditLog (At);

-- عدادات الترقيم المتسلسل (رقم الملف، رقم الزيارة، رقم الإيصال)
CREATE TABLE Counters (
  Name   TEXT NOT NULL PRIMARY KEY,
  Value  INT          NOT NULL
);
INSERT INTO Counters (Name, Value) VALUES ('patient', 0), ('visit', 0), ('receipt', 0);

CREATE TABLE Patients (
  Id              INTEGER PRIMARY KEY AUTOINCREMENT,
  PatientNo       INT            NOT NULL,
  FullName        TEXT  NOT NULL,
  SearchKey       TEXT  NOT NULL,
  Phone           TEXT   NULL,
  BirthDate       TEXT           NULL,
  AgeYears        INT            NULL,
  AgeRecordedAt   TEXT   NULL,
  Sex             TEXT        NULL,
  NationalId      TEXT       NULL,
  Address         TEXT  NULL,
  EmergencyName   TEXT  NULL,
  EmergencyPhone  TEXT   NULL,
  Notes           TEXT  NULL,
  Incomplete      INTEGER            NOT NULL DEFAULT 0,   -- اتفتح بالاسم بس (طوارئ)
  CreatedAt       TEXT   NOT NULL,
  CreatedBy       INT            NOT NULL REFERENCES Users(Id),
  UpdatedAt       TEXT   NULL,
  UpdatedBy       INT            NULL REFERENCES Users(Id),
  CONSTRAINT UQ_Patients_No UNIQUE (PatientNo),
  CONSTRAINT CK_Patients_Sex CHECK (Sex IN ('M','F'))
);
CREATE INDEX IX_Patients_SearchKey ON Patients (SearchKey);
CREATE INDEX IX_Patients_Phone ON Patients (Phone);
CREATE UNIQUE INDEX UX_Patients_NationalId ON Patients (NationalId) WHERE NationalId IS NOT NULL;

CREATE TABLE PatientEdits (
  Id         INTEGER PRIMARY KEY AUTOINCREMENT,
  PatientId  INT           NOT NULL REFERENCES Patients(Id),
  At         TEXT  NOT NULL,
  UserId     INT           NOT NULL REFERENCES Users(Id),
  Field      TEXT  NOT NULL,
  OldValue   TEXT NULL,
  NewValue   TEXT NULL
);
CREATE INDEX IX_PatientEdits_Patient ON PatientEdits (PatientId);

CREATE TABLE Services (
  Id         INTEGER PRIMARY KEY AUTOINCREMENT,
  Code       TEXT  NOT NULL,
  Name       TEXT NOT NULL,
  SearchKey  TEXT NOT NULL,
  Dept       TEXT  NOT NULL,     -- clinic | emergency | lab | radiology
  PayTiming  TEXT  NOT NULL,     -- before | after
  HasDoctor  INTEGER           NOT NULL DEFAULT 0,
  Quick      INTEGER           NOT NULL DEFAULT 0,  -- يظهر كزرار سريع
  SortOrder  INT           NOT NULL DEFAULT 0,
  Active     INTEGER           NOT NULL DEFAULT 1,
  CreatedAt  TEXT  NOT NULL,
  IncludedNights INT NULL,
  CONSTRAINT UQ_Services_Code UNIQUE (Code),
  CONSTRAINT CK_Services_Pay CHECK (PayTiming IN ('before','after'))
);

-- الأسعار بالسريان: كل تغيير سعر سطر جديد بتاريخه
CREATE TABLE ServicePrices (
  Id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ServiceId      INT            NOT NULL REFERENCES Services(Id),
  Price          NUMERIC  NOT NULL,
  EffectiveFrom  TEXT   NOT NULL,
  ChangedBy      INT            NULL REFERENCES Users(Id),
  CONSTRAINT UQ_ServicePrices UNIQUE (ServiceId, EffectiveFrom),
  CONSTRAINT CK_ServicePrices_Price CHECK (Price >= 0)
);

-- الأطباء (مؤقتًا هنا، ولما نربط بجدول اليوم المصدر يتغير بس)
CREATE TABLE Doctors (
  Id         INTEGER PRIMARY KEY AUTOINCREMENT,
  Name       TEXT NOT NULL,
  Specialty  TEXT  NULL,
  ExternalRef TEXT NULL,          -- رقم الدكتور في جدول اليوم (للربط)
  Active     INTEGER           NOT NULL DEFAULT 1
);

CREATE TABLE DoctorSchedule (
  Id        INTEGER PRIMARY KEY AUTOINCREMENT,
  DoctorId  INT         NOT NULL REFERENCES Doctors(Id),
  Weekday   INTEGER     NOT NULL,          -- 0=السبت ... 6=الجمعة
  FromTime  TEXT     NOT NULL,          -- HH:MM
  ToTime    TEXT     NOT NULL
);
CREATE INDEX IX_DoctorSchedule ON DoctorSchedule (Weekday, DoctorId);

-- نسب الأطباء: خدمة محددة > قسم > نسبة عامة
CREATE TABLE DoctorShares (
  Id         INTEGER PRIMARY KEY AUTOINCREMENT,
  DoctorId   INT           NOT NULL REFERENCES Doctors(Id),
  ServiceId  INT           NULL REFERENCES Services(Id),
  Dept       TEXT  NULL,
  Pct        NUMERIC  NOT NULL,
  CONSTRAINT CK_DoctorShares_Pct CHECK (Pct >= 0 AND Pct <= 100)
);
CREATE INDEX IX_DoctorShares ON DoctorShares (DoctorId);

CREATE TABLE Shifts (
  Id        INTEGER PRIMARY KEY AUTOINCREMENT,
  UserId    INT          NOT NULL REFERENCES Users(Id),
  OpenedAt  TEXT NOT NULL,
  ClosedAt  TEXT NULL
);
CREATE INDEX IX_Shifts_User ON Shifts (UserId, ClosedAt);

CREATE TABLE Visits (
  Id         INTEGER PRIMARY KEY AUTOINCREMENT,
  VisitNo    INT           NOT NULL,
  PatientId  INT           NOT NULL REFERENCES Patients(Id),
  Type       TEXT  NOT NULL,       -- clinic | emergency | lab | radiology
  Status     TEXT  NOT NULL,       -- open | closed
  OpenedAt   TEXT  NOT NULL,
  OpenedBy   INT           NOT NULL REFERENCES Users(Id),
  ClosedAt   TEXT  NULL,
  ClosedBy   INT           NULL REFERENCES Users(Id),
  Notes      TEXT NULL,
  CONSTRAINT UQ_Visits_No UNIQUE (VisitNo),
  CONSTRAINT CK_Visits_Status CHECK (Status IN ('open','closed'))
);
CREATE INDEX IX_Visits_Patient ON Visits (PatientId);
CREATE INDEX IX_Visits_Status ON Visits (Status, OpenedAt);

CREATE TABLE Receipts (
  Id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  ReceiptNo           INT            NOT NULL,
  Kind                TEXT   NOT NULL,   -- payment | refund (المرتجع بالسالب)
  VisitId             INT            NULL REFERENCES Visits(Id),
  AdmissionId         INT            NULL REFERENCES Admissions(Id),
  Note                TEXT  NULL,
  PatientId           INT            NOT NULL REFERENCES Patients(Id),
  ShiftId             INT            NOT NULL REFERENCES Shifts(Id),
  Gross               NUMERIC  NOT NULL,
  Discount            NUMERIC  NOT NULL,
  Net                 NUMERIC  NOT NULL,
  Cash                NUMERIC  NOT NULL,
  Card                NUMERIC  NOT NULL,
  Credit              NUMERIC  NOT NULL,   -- آجل
  DiscountReason      TEXT  NULL,
  DiscountApprovedBy  INT            NULL REFERENCES Users(Id),
  CreditApprovedBy    INT            NULL REFERENCES Users(Id),
  ReversesReceiptId   INT            NULL REFERENCES Receipts(Id),
  ReversedByReceiptId INT            NULL REFERENCES Receipts(Id),
  Reason              TEXT  NULL,       -- سبب الإلغاء
  PrintCount          INT            NOT NULL DEFAULT 0,
  CreatedAt           TEXT   NOT NULL,
  CreatedBy           INT            NOT NULL REFERENCES Users(Id),
  CONSTRAINT UQ_Receipts_No UNIQUE (ReceiptNo),
  CONSTRAINT CK_Receipts_Kind CHECK (Kind IN ('payment','refund','deposit','final','return')),
  CONSTRAINT CK_Receipts_Target CHECK (VisitId IS NOT NULL OR AdmissionId IS NOT NULL),
  CONSTRAINT CK_Receipts_Balance CHECK (Cash + Card + Credit = Net AND Gross - Discount = Net)
);
CREATE INDEX IX_Receipts_Visit ON Receipts (VisitId);
CREATE INDEX IX_Receipts_Admission ON Receipts (AdmissionId);
CREATE INDEX IX_Receipts_Shift ON Receipts (ShiftId);
CREATE INDEX IX_Receipts_CreatedAt ON Receipts (CreatedAt);

CREATE TABLE VisitItems (
  Id             INTEGER PRIMARY KEY AUTOINCREMENT,
  VisitId        INT            NOT NULL REFERENCES Visits(Id),
  ServiceId      INT            NULL REFERENCES Services(Id),
  ServiceName    TEXT  NOT NULL,   -- نسخة وقت التسجيل
  Dept           TEXT   NOT NULL,
  DoctorId       INT            NULL REFERENCES Doctors(Id),
  Qty            INT            NOT NULL,
  UnitPrice      NUMERIC  NOT NULL,   -- السعر وقت التسجيل
  Amount         NUMERIC  NOT NULL,
  PayTiming      TEXT   NOT NULL,
  DoctorPct      NUMERIC   NOT NULL DEFAULT 0,  -- النسبة وقت التسجيل
  Status         TEXT   NOT NULL,   -- active | voided
  PaidReceiptId  INT            NULL REFERENCES Receipts(Id),
  AddedAt        TEXT   NOT NULL,
  AddedBy        INT            NOT NULL REFERENCES Users(Id),
  VoidedAt       TEXT   NULL,
  VoidedBy       INT            NULL REFERENCES Users(Id),
  VoidReason     TEXT  NULL,
  CONSTRAINT CK_VisitItems_Status CHECK (Status IN ('active','voided')),
  CONSTRAINT CK_VisitItems_Qty CHECK (Qty > 0)
);
CREATE INDEX IX_VisitItems_Visit ON VisitItems (VisitId);

CREATE TABLE ReceiptLines (
  Id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ReceiptId      INT            NOT NULL REFERENCES Receipts(Id),
  VisitItemId    INT            NOT NULL REFERENCES VisitItems(Id),
  Description    TEXT  NOT NULL,
  Qty            INT            NOT NULL,
  UnitPrice      NUMERIC  NOT NULL,
  Amount         NUMERIC  NOT NULL,
  DiscountShare  NUMERIC  NOT NULL
);
CREATE INDEX IX_ReceiptLines_Receipt ON ReceiptLines (ReceiptId);

-- مستحقات الأطباء: سطر لكل بند مدفوع، والإلغاء بسطر بالسالب
CREATE TABLE DoctorEarnings (
  Id           INTEGER PRIMARY KEY AUTOINCREMENT,
  VisitItemId  INT            NULL REFERENCES VisitItems(Id),
  AdmissionItemId INT         NULL REFERENCES AdmissionItems(Id),
  DoctorId     INT            NOT NULL REFERENCES Doctors(Id),
  ReceiptId    INT            NOT NULL REFERENCES Receipts(Id),
  BaseAmount   NUMERIC  NOT NULL,
  Pct          NUMERIC   NOT NULL,
  Amount       NUMERIC  NOT NULL,
  CreatedAt    TEXT   NOT NULL
);
CREATE INDEX IX_DoctorEarnings_Doctor ON DoctorEarnings (DoctorId, CreatedAt);

-- =====================================================================
--  تحديث 002: الدخول والإقامة ولوحة الأسرّة
--  بيتشغل لوحده من npm run db:init (على القاعدة الجديدة أو اللي اتعملت بنسخة 0.1/0.2)
--  الأوامر مفصولة بـ GO
-- =====================================================================

CREATE TABLE AppSettings (
  [Key]      TEXT  NOT NULL PRIMARY KEY,
  Value      TEXT NULL,
  UpdatedAt  TEXT  NULL,
  UpdatedBy  INT           NULL REFERENCES Users(Id)
);

CREATE TABLE Floors (
  Id         INTEGER PRIMARY KEY AUTOINCREMENT,
  Number     INT           NOT NULL,
  Name       TEXT  NOT NULL,
  Notes      TEXT NULL,
  Active     INTEGER           NOT NULL DEFAULT 1,
  CONSTRAINT UQ_Floors_Number UNIQUE (Number)
);

-- درجات الغرف: ward = إقامة عادية، icu = عناية، nursery = حضانة
CREATE TABLE RoomClasses (
  Id          INTEGER PRIMARY KEY AUTOINCREMENT,
  Name        TEXT   NOT NULL,
  Kind        TEXT   NOT NULL,
  NightPrice  NUMERIC  NULL,
  Deposit     NUMERIC  NULL,
  SortOrder   INT            NOT NULL DEFAULT 0,
  Active      INTEGER            NOT NULL DEFAULT 1,
  CONSTRAINT CK_RoomClasses_Price CHECK (NightPrice IS NULL OR NightPrice >= 0),
  CONSTRAINT CK_RoomClasses_Deposit CHECK (Deposit IS NULL OR Deposit >= 0)
);

CREATE TABLE Rooms (
  Id        INTEGER PRIMARY KEY AUTOINCREMENT,
  FloorId   INT           NOT NULL REFERENCES Floors(Id),
  Number    TEXT  NOT NULL,
  ClassId   INT           NOT NULL REFERENCES RoomClasses(Id),
  Notes     TEXT NULL,
  Active    INTEGER           NOT NULL DEFAULT 1,
  CONSTRAINT UQ_Rooms_Number UNIQUE (Number)
);

-- حالة السرير: free فاضي | occupied مشغول | cleaning تحت التنظيف | reserved محجوز
CREATE TABLE Beds (
  Id          INTEGER PRIMARY KEY AUTOINCREMENT,
  RoomId      INT           NOT NULL REFERENCES Rooms(Id),
  Label       TEXT  NOT NULL,
  Status      TEXT  NOT NULL DEFAULT 'free',
  StatusNote  TEXT NULL,
  StatusAt    TEXT  NULL,
  StatusBy    INT           NULL REFERENCES Users(Id),
  Active      INTEGER           NOT NULL DEFAULT 1,
  CONSTRAINT CK_Beds_Status CHECK (Status IN ('free','occupied','cleaning','reserved')),
  CONSTRAINT UQ_Beds_Label UNIQUE (RoomId, Label)
);

-- نوع الدخول: inpatient داخلي | icu عناية | nursery حضانة | surgery عمليات
CREATE TABLE Admissions (
  Id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  AdmissionNo        INT            NOT NULL,
  PatientId          INT            NOT NULL REFERENCES Patients(Id),
  Type               TEXT   NOT NULL,
  Status             TEXT   NOT NULL,
  DoctorId           INT            NULL REFERENCES Doctors(Id),
  ExpectedProcedure  TEXT  NULL,
  BedId              INT            NOT NULL REFERENCES Beds(Id),
  DepositRequired    NUMERIC  NOT NULL DEFAULT 0,
  FromVisitId        INT            NULL REFERENCES Visits(Id),
  Notes              TEXT  NULL,
  AdmittedAt         TEXT   NOT NULL,
  AdmittedBy         INT            NOT NULL REFERENCES Users(Id),
  DischargedAt       TEXT   NULL,
  DischargedBy       INT            NULL REFERENCES Users(Id),
  DischargeNote      TEXT  NULL,
  CONSTRAINT UQ_Admissions_No UNIQUE (AdmissionNo),
  CONSTRAINT CK_Admissions_Status CHECK (Status IN ('active','discharged'))
);

CREATE INDEX IX_Admissions_Patient ON Admissions (PatientId);

CREATE INDEX IX_Admissions_Status ON Admissions (Status);

-- مريض واحد مايدخلش مرتين في نفس الوقت، وسرير واحد لمريض واحد
CREATE UNIQUE INDEX UX_Admissions_ActivePatient ON Admissions (PatientId) WHERE Status = 'active';

CREATE UNIQUE INDEX UX_Admissions_ActiveBed ON Admissions (BedId) WHERE Status = 'active';

CREATE TABLE BedMoves (
  Id           INTEGER PRIMARY KEY AUTOINCREMENT,
  AdmissionId  INT           NOT NULL REFERENCES Admissions(Id),
  BedId        INT           NOT NULL REFERENCES Beds(Id),
  ClassId      INT           NOT NULL REFERENCES RoomClasses(Id),
  FromAt       TEXT  NOT NULL,
  ToAt         TEXT  NULL,
  MovedBy      INT           NOT NULL REFERENCES Users(Id),
  Reason       TEXT NULL
);

CREATE INDEX IX_BedMoves_Admission ON BedMoves (AdmissionId);

-- بنود حساب الإقامة: night = ليلة إقامة، service = خدمة
CREATE TABLE AdmissionItems (
  Id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  AdmissionId        INT            NOT NULL REFERENCES Admissions(Id),
  Kind               TEXT   NOT NULL,
  ServiceId          INT            NULL REFERENCES Services(Id),
  Name               TEXT  NOT NULL,
  Dept               TEXT   NOT NULL,
  DoctorId           INT            NULL REFERENCES Doctors(Id),
  Qty                INT            NOT NULL,
  UnitPrice          NUMERIC  NOT NULL,
  Amount             NUMERIC  NOT NULL,
  DoctorPct          NUMERIC   NOT NULL DEFAULT 0,
  ChargeDate         TEXT           NULL,
  ClassId            INT            NULL REFERENCES RoomClasses(Id),
  IncludedNights     INT            NULL,
  Note               TEXT  NULL,
  Status             TEXT   NOT NULL,
  SourceVisitItemId  INT            NULL REFERENCES VisitItems(Id),
  AddedAt            TEXT   NOT NULL,
  AddedBy            INT            NOT NULL REFERENCES Users(Id),
  VoidedAt           TEXT   NULL,
  VoidedBy           INT            NULL REFERENCES Users(Id),
  VoidReason         TEXT  NULL,
  CONSTRAINT CK_AdmissionItems_Kind CHECK (Kind IN ('night','service')),
  CONSTRAINT CK_AdmissionItems_Status CHECK (Status IN ('active','voided')),
  CONSTRAINT CK_AdmissionItems_Qty CHECK (Qty > 0)
);

CREATE INDEX IX_AdmissionItems_Admission ON AdmissionItems (AdmissionId);

INSERT INTO Counters (Name, Value) VALUES ('admission', 0);

INSERT INTO AppSettings ([Key], Value) VALUES ('checkoutTime', '12:00');

INSERT INTO Floors (Number, Name, Notes) VALUES
  (3, 'الدور الثالث', 'إقامة + حضانة'),
  (4, 'الدور الرابع', 'إقامة'),
  (6, 'الدور السادس', 'عناية + عمليات'),
  (7, 'الدور السابع', 'إقامة'),
  (8, 'الدور الثامن', 'إقامة');

INSERT INTO RoomClasses (Name, Kind, SortOrder) VALUES
  ('عادية', 'ward', 1), ('ممتازة', 'ward', 2), ('جناح', 'ward', 3), ('جناح ملكي', 'ward', 4),
  ('عناية مركزة', 'icu', 5), ('حضانة', 'nursery', 6);

-- =====================================================================
--  تحديث 003: التعاقدات ومستويات الكارنيه والموافقات وحساب الجهات
--  الأوامر مفصولة بـ GO. الأوامر دي بتشتغل زي ما هي على SQLite كمان (نسخة التجربة)
-- =====================================================================

-- جهة التعاقد. PriceMode: cash = أسعار المستشفى ، list = قايمة أسعار خاصة ، discount = خصم ثابت على أسعار المستشفى
CREATE TABLE Payers (
  Id            INTEGER PRIMARY KEY AUTOINCREMENT,
  Name          TEXT  NOT NULL,
  Kind          TEXT   NULL,
  ContactName   TEXT  NULL,
  ContactPhone  TEXT   NULL,
  ValidFrom     TEXT           NULL,
  ValidTo       TEXT           NULL,
  PriceMode     TEXT   NOT NULL DEFAULT 'cash',
  DiscountPct   NUMERIC   NULL,
  RequiredDocs  TEXT  NULL,
  VisitCap      NUMERIC  NULL,
  YearCap       NUMERIC  NULL,
  Notes         TEXT  NULL,
  Active        INTEGER            NOT NULL DEFAULT 1,
  CreatedAt     TEXT   NOT NULL,
  CONSTRAINT UQ_Payers_Name UNIQUE (Name),
  CONSTRAINT CK_Payers_PriceMode CHECK (PriceMode IN ('cash','list','discount')),
  CONSTRAINT CK_Payers_Discount CHECK (DiscountPct IS NULL OR (DiscountPct >= 0 AND DiscountPct <= 100))
);

-- مستويات الكارنيه
CREATE TABLE PayerTiers (
  Id         INTEGER PRIMARY KEY AUTOINCREMENT,
  PayerId    INT           NOT NULL REFERENCES Payers(Id),
  Name       TEXT  NOT NULL,
  SortOrder  INT           NOT NULL DEFAULT 0,
  Active     INTEGER           NOT NULL DEFAULT 1,
  CONSTRAINT UQ_PayerTiers UNIQUE (PayerId, Name)
);

-- نسبة تحمّل الشركة لكل قسم خدمات (clinic, emergency, lab, radiology, ward, or)
CREATE TABLE TierCoverage (
  Id      INTEGER PRIMARY KEY AUTOINCREMENT,
  TierId  INT           NOT NULL REFERENCES PayerTiers(Id),
  Dept    TEXT  NOT NULL,
  Pct     NUMERIC  NOT NULL,
  CONSTRAINT UQ_TierCoverage UNIQUE (TierId, Dept),
  CONSTRAINT CK_TierCoverage_Pct CHECK (Pct >= 0 AND Pct <= 100)
);

CREATE TABLE PayerPrices (
  Id         INTEGER PRIMARY KEY AUTOINCREMENT,
  PayerId    INT            NOT NULL REFERENCES Payers(Id),
  ServiceId  INT            NOT NULL REFERENCES Services(Id),
  Price      NUMERIC  NOT NULL,
  CONSTRAINT UQ_PayerPrices UNIQUE (PayerId, ServiceId),
  CONSTRAINT CK_PayerPrices CHECK (Price >= 0)
);

CREATE TABLE PayerClassPrices (
  Id          INTEGER PRIMARY KEY AUTOINCREMENT,
  PayerId     INT            NOT NULL REFERENCES Payers(Id),
  ClassId     INT            NOT NULL REFERENCES RoomClasses(Id),
  NightPrice  NUMERIC  NOT NULL,
  CONSTRAINT UQ_PayerClassPrices UNIQUE (PayerId, ClassId),
  CONSTRAINT CK_PayerClassPrices CHECK (NightPrice >= 0)
);

-- excluded = مش مغطاة ، approval = محتاجة موافقة مسبقة
CREATE TABLE PayerRules (
  Id         INTEGER PRIMARY KEY AUTOINCREMENT,
  PayerId    INT           NOT NULL REFERENCES Payers(Id),
  ServiceId  INT           NOT NULL REFERENCES Services(Id),
  [Rule]     TEXT  NOT NULL,
  CONSTRAINT UQ_PayerRules UNIQUE (PayerId, ServiceId),
  CONSTRAINT CK_PayerRules CHECK ([Rule] IN ('excluded','approval'))
);

-- الموافقات: pending مستنية المراجعة ، tempcash نقدي مؤقت (لسه مفيش موافقة) ، approved ، rejected ، cancelled
CREATE TABLE Approvals (
  Id               INTEGER PRIMARY KEY AUTOINCREMENT,
  Scope            TEXT   NOT NULL,
  PayerId          INT            NOT NULL REFERENCES Payers(Id),
  PatientId        INT            NOT NULL REFERENCES Patients(Id),
  VisitItemId      INT            NULL REFERENCES VisitItems(Id),
  AdmissionItemId  INT            NULL REFERENCES AdmissionItems(Id),
  AdmissionId      INT            NULL REFERENCES Admissions(Id),
  ApprovalNo       TEXT   NULL,
  ApprovalDate     TEXT           NULL,
  ImageFile        TEXT  NULL,
  Status           TEXT   NOT NULL,
  Amount           NUMERIC  NOT NULL DEFAULT 0,
  Note             TEXT  NULL,
  CreatedAt        TEXT   NOT NULL,
  CreatedBy        INT            NOT NULL REFERENCES Users(Id),
  ReviewedAt       TEXT   NULL,
  ReviewedBy       INT            NULL REFERENCES Users(Id),
  ReviewNote       TEXT  NULL,
  CONSTRAINT CK_Approvals_Scope CHECK (Scope IN ('item','admission')),
  CONSTRAINT CK_Approvals_Status CHECK (Status IN ('pending','tempcash','approved','rejected','cancelled'))
);

CREATE INDEX IX_Approvals_Status ON Approvals (Status, CreatedAt);

-- حساب الجهات: كل نصيب شركة اتأكد (charge بالموجب، والإلغاء بالسالب) = أساس المطالبة الشهرية
CREATE TABLE PayerLedger (
  Id               INTEGER PRIMARY KEY AUTOINCREMENT,
  PayerId          INT            NOT NULL REFERENCES Payers(Id),
  PatientId        INT            NOT NULL REFERENCES Patients(Id),
  VisitItemId      INT            NULL REFERENCES VisitItems(Id),
  AdmissionItemId  INT            NULL REFERENCES AdmissionItems(Id),
  ReceiptId        INT            NULL REFERENCES Receipts(Id),
  ApprovalId       INT            NULL REFERENCES Approvals(Id),
  Description      TEXT  NOT NULL,
  CardNo           TEXT   NULL,
  FullAmount       NUMERIC  NOT NULL,
  Amount           NUMERIC  NOT NULL,
  ReversesId       INT            NULL,
  At               TEXT   NOT NULL,
  CreatedBy        INT            NOT NULL REFERENCES Users(Id)
);

CREATE INDEX IX_PayerLedger ON PayerLedger (PayerId, At);

-- تعاقد المريض الافتراضي، وتعاقد كل زيارة ودخول
ALTER TABLE Patients ADD PayerId INT NULL REFERENCES Payers(Id);

ALTER TABLE Patients ADD TierId INT NULL REFERENCES PayerTiers(Id);

ALTER TABLE Patients ADD CardNo TEXT NULL;

ALTER TABLE Visits ADD PayerId INT NULL REFERENCES Payers(Id);

ALTER TABLE Visits ADD TierId INT NULL REFERENCES PayerTiers(Id);

ALTER TABLE Visits ADD CardNo TEXT NULL;

ALTER TABLE Admissions ADD PayerId INT NULL REFERENCES Payers(Id);

ALTER TABLE Admissions ADD TierId INT NULL REFERENCES PayerTiers(Id);

ALTER TABLE Admissions ADD CardNo TEXT NULL;

-- ok = التعاقد شغال ، rejected = موافقة الدخول اترفضت والحساب اتحول نقدي
ALTER TABLE Admissions ADD PayerStatus TEXT NULL;

-- نصيب الشركة ونصيب المريض لكل بند. CoverStatus: none ، covered ، excluded ، pending ، tempcash ، approved ، rejected
ALTER TABLE VisitItems ADD PayerPct NUMERIC NOT NULL DEFAULT 0;

ALTER TABLE VisitItems ADD PayerAmount NUMERIC NOT NULL DEFAULT 0;

ALTER TABLE VisitItems ADD PatientAmount NUMERIC NULL;

ALTER TABLE VisitItems ADD CoverStatus TEXT NOT NULL DEFAULT 'none';

ALTER TABLE VisitItems ADD RefundDue NUMERIC NOT NULL DEFAULT 0;

UPDATE VisitItems SET PatientAmount = Amount;

ALTER TABLE AdmissionItems ADD PayerPct NUMERIC NOT NULL DEFAULT 0;

ALTER TABLE AdmissionItems ADD PayerAmount NUMERIC NOT NULL DEFAULT 0;

ALTER TABLE AdmissionItems ADD PatientAmount NUMERIC NULL;

ALTER TABLE AdmissionItems ADD CoverStatus TEXT NOT NULL DEFAULT 'none';

UPDATE AdmissionItems SET PatientAmount = Amount;

ALTER TABLE ReceiptLines ADD PayerAmount NUMERIC NOT NULL DEFAULT 0;

ALTER TABLE DoctorEarnings ADD PayerPart NUMERIC NOT NULL DEFAULT 0;

-- =====================================================================
--  تحديث 004: الخزينة (أذونات الدفع) وتقفيل الورديات والتسليم
--  الأوامر مفصولة بـ GO. الجزء قبل «@alters» بيشتغل زي ما هو على SQLite كمان
-- =====================================================================

-- إذن دفع: الاستقبال بيجهّز الحساب، والخزينة بتحصّل وتطلع الإيصال
-- Kind: visit = خدمات زيارة ، adm_pay = دفعة دخول ، deposit = تأمين دخول ، discharge = سداد/مرتجع الخروج ، refund_due = مرتجع موافقة
CREATE TABLE PayOrders (
  Id            INTEGER PRIMARY KEY AUTOINCREMENT,
  OrderNo       INT            NOT NULL,
  Kind          TEXT   NOT NULL,
  VisitId       INT            NULL REFERENCES Visits(Id),
  AdmissionId   INT            NULL REFERENCES Admissions(Id),
  PatientId     INT            NOT NULL REFERENCES Patients(Id),
  Amount        NUMERIC  NOT NULL,             -- المطلوب تحصيله (سالب = صرف للمريض)
  Credit        NUMERIC  NOT NULL DEFAULT 0,   -- آجل متوافق عليه من الاستقبال
  Discount      NUMERIC  NOT NULL DEFAULT 0,
  Description   TEXT  NOT NULL,
  Payload       TEXT  NOT NULL,
  Status        TEXT   NOT NULL DEFAULT 'pending',
  CreatedAt     TEXT   NOT NULL,
  CreatedBy     INT            NOT NULL REFERENCES Users(Id),
  DoneAt        TEXT   NULL,
  DoneBy        INT            NULL REFERENCES Users(Id),
  ReceiptId     INT            NULL REFERENCES Receipts(Id),
  CancelReason  TEXT  NULL,
  CONSTRAINT UQ_PayOrders_No UNIQUE (OrderNo),
  CONSTRAINT CK_PayOrders_Kind CHECK (Kind IN ('visit','adm_pay','deposit','discharge','refund_due')),
  CONSTRAINT CK_PayOrders_Status CHECK (Status IN ('pending','done','cancelled'))
);

CREATE INDEX IX_PayOrders_Status ON PayOrders (Status, CreatedAt);

INSERT INTO Counters (Name, Value) VALUES ('order', 0);

-- البنود المحجوزة في إذن دفع لسه ما اتحصلش
ALTER TABLE VisitItems ADD PendingOrderId INT NULL;

ALTER TABLE Receipts ADD ManualNo TEXT NULL;

ALTER TABLE Receipts ADD OrderId INT NULL;

-- تقفيل الوردية والتسليم
ALTER TABLE Shifts ADD Label TEXT NULL;

ALTER TABLE Shifts ADD BusinessDate TEXT NULL;

ALTER TABLE Shifts ADD Explicit INTEGER NOT NULL DEFAULT 0;

ALTER TABLE Shifts ADD ExpectedCash NUMERIC NULL;

ALTER TABLE Shifts ADD CountedCash NUMERIC NULL;

ALTER TABLE Shifts ADD CardTotal NUMERIC NULL;

ALTER TABLE Shifts ADD DiffReason TEXT NULL;

ALTER TABLE Shifts ADD CloseNote TEXT NULL;

ALTER TABLE Shifts ADD HandedTo INT NULL REFERENCES Users(Id);

ALTER TABLE Shifts ADD ReceivedAt TEXT NULL;

ALTER TABLE Shifts ADD ReceivedBy INT NULL REFERENCES Users(Id);

ALTER TABLE Shifts ADD ReceivedShiftId INT NULL;

INSERT INTO AppSettings ([Key], Value) VALUES ('cashierMode', 'auto');

INSERT INTO AppSettings ([Key], Value) VALUES ('manualNoRequired', '0');

-- =====================================================================
--  تحديث 005: قسم الأشعة (قايمة الشغل، تقارير السونار بالقوالب، متابعة المقطعية، التسليم)
--  الأوامر مفصولة بـ GO. الجزء قبل «@alters» بيشتغل زي ما هو على SQLite كمان
-- =====================================================================

-- نوع الجهاز للخدمة: us سونار ، ct مقطعية ، mri رنين ، xray عادية ، mammo ماموجرام ، other
ALTER TABLE Services ADD Modality TEXT NULL;

-- قوالب تقارير الأشعة (المدير ودكتور الأشعة يعدّلوها)
CREATE TABLE RadTemplates (
  Id         INTEGER PRIMARY KEY AUTOINCREMENT,
  Name       TEXT  NOT NULL,
  Modality   TEXT   NOT NULL,
  Title      TEXT  NULL,             -- عنوان الفحص في التقرير
  Body       TEXT  NOT NULL,         -- HTML بسيط
  SortOrder  INT            NOT NULL DEFAULT 0,
  Active     INTEGER            NOT NULL DEFAULT 1,
  CreatedAt  TEXT   NOT NULL,
  UpdatedAt  TEXT   NULL,
  UpdatedBy  INT            NULL REFERENCES Users(Id)
);

-- فحص أشعة: سطر لكل خدمة أشعة (زيارة أو دخول) أول ما القسم يبدأ يشتغل عليها
-- Status: waiting مستني ، done اتعمل ، sent اتبعت للدكتور ، reported التقرير جاهز ، delivered اتسلّم ، cancelled
CREATE TABLE RadStudies (
  Id               INTEGER PRIMARY KEY AUTOINCREMENT,
  StudyNo          INT            NOT NULL,
  PatientId        INT            NOT NULL REFERENCES Patients(Id),
  VisitItemId      INT            NULL REFERENCES VisitItems(Id),
  AdmissionItemId  INT            NULL REFERENCES AdmissionItems(Id),
  ServiceName      TEXT  NOT NULL,
  Modality         TEXT   NOT NULL,
  Status           TEXT   NOT NULL DEFAULT 'waiting',
  ClinicalInfo     TEXT  NULL,
  DoneAt           TEXT   NULL,
  DoneBy           INT            NULL REFERENCES Users(Id),
  SentAt           TEXT   NULL,
  SentTo           TEXT  NULL,
  DueAt            TEXT   NULL,
  ReportTitle      TEXT  NULL,
  ReportHtml       TEXT  NULL,
  ReportFile       TEXT  NULL,
  ReportFileType   TEXT   NULL,
  ReportLink       TEXT  NULL,
  Radiologist      TEXT  NULL,
  ReportedAt       TEXT   NULL,
  ReportedBy       INT            NULL REFERENCES Users(Id),
  DeliveredAt      TEXT   NULL,
  DeliveredBy      INT            NULL REFERENCES Users(Id),
  DeliveredTo      TEXT  NULL,
  PrintCount       INT            NOT NULL DEFAULT 0,
  Notes            TEXT  NULL,
  CreatedAt        TEXT   NOT NULL,
  UpdatedAt        TEXT   NULL,
  CONSTRAINT UQ_RadStudies_No UNIQUE (StudyNo),
  CONSTRAINT CK_RadStudies_Status CHECK (Status IN ('waiting','done','sent','reported','delivered','cancelled')),
  CONSTRAINT CK_RadStudies_Src CHECK (VisitItemId IS NOT NULL OR AdmissionItemId IS NOT NULL)
);

CREATE INDEX IX_RadStudies_Status ON RadStudies (Status, CreatedAt);

CREATE INDEX IX_RadStudies_Patient ON RadStudies (PatientId);

CREATE INDEX IX_RadStudies_VisitItem ON RadStudies (VisitItemId);

CREATE INDEX IX_RadStudies_AdmItem ON RadStudies (AdmissionItemId);

INSERT INTO Counters (Name, Value) VALUES ('study', 0);

-- الوقت المتوقع للتقرير بالساعات لكل نوع
INSERT INTO AppSettings ([Key], Value) VALUES ('radDue', '{"us":2,"xray":1,"ct":24,"mri":48,"mammo":24,"other":24}');

-- =====================================================================
--  تحديث 006: المعمل (التحاليل وبنودها والمعدلات، العينات، النتايج، المعامل الخارجية)
--  الأوامر مفصولة بـ GO. الجزء قبل «@alters» بيشتغل زي ما هو على SQLite كمان
-- =====================================================================

-- تعريف التحليل (قالب النتيجة). ServiceId = الخدمة اللي بتتدفع في الاستقبال
CREATE TABLE LabTests (
  Id          INTEGER PRIMARY KEY AUTOINCREMENT,
  Code        TEXT   NOT NULL,
  Name        TEXT  NOT NULL,          -- الاسم في التقرير (إنجليزي غالبًا)
  ArName      TEXT  NULL,
  ServiceId   INT            NULL REFERENCES Services(Id),
  Keywords    TEXT  NULL,              -- كلمات لربط الخدمة بالتحليل لوحدها
  Section     TEXT   NOT NULL,          -- hematology | chemistry | hormones | serology | urine | stool | coagulation | other
  Sample      TEXT   NOT NULL,          -- blood | serum | urine | stool | swab | other
  Tube        TEXT   NULL,
  Hours       INT            NOT NULL DEFAULT 2,
  [External]  INTEGER            NOT NULL DEFAULT 0, -- كلمة محجوزة في T-SQL: لازم الأقواس دايمًا
  ExternalLab TEXT  NULL,
  Comment     TEXT  NULL,
  SortOrder   INT            NOT NULL DEFAULT 0,
  Active      INTEGER            NOT NULL DEFAULT 1,
  CreatedAt   TEXT   NOT NULL,
  UpdatedAt   TEXT   NULL,
  CONSTRAINT UQ_LabTests_Code UNIQUE (Code)
);

-- بنود التحليل. Kind: num رقم ، text نص ، select اختيار ، header عنوان. Ranges = JSON بالمعدلات حسب النوع والسن
CREATE TABLE LabParams (
  Id         INTEGER PRIMARY KEY AUTOINCREMENT,
  TestId     INT            NOT NULL REFERENCES LabTests(Id),
  Name       TEXT  NOT NULL,
  Unit       TEXT   NULL,
  Kind       TEXT   NOT NULL DEFAULT 'num',
  Options    TEXT  NULL,
  NormalText TEXT  NULL,
  Decimals   INT            NULL,
  Ranges     TEXT  NULL,
  RefText    TEXT  NULL,
  SortOrder  INT            NOT NULL DEFAULT 0,
  Active     INTEGER            NOT NULL DEFAULT 1
);

CREATE INDEX IX_LabParams_Test ON LabParams (TestId, SortOrder);

-- شغل المعمل: سطر لكل تحليل اتطلب (زيارة أو دخول) أول ما المعمل يلمسه
-- Status: waiting مستني السحب ، collected اتسحبت ، done النتيجة اتكتبت ، sent اتبعت بره ، verified جاهزة ، delivered اتسلّمت
CREATE TABLE LabWork (
  Id               INTEGER PRIMARY KEY AUTOINCREMENT,
  AccNo            INT            NULL,
  PatientId        INT            NOT NULL REFERENCES Patients(Id),
  VisitItemId      INT            NULL REFERENCES VisitItems(Id),
  AdmissionItemId  INT            NULL REFERENCES AdmissionItems(Id),
  TestId           INT            NULL REFERENCES LabTests(Id),
  ServiceName      TEXT  NOT NULL,
  Status           TEXT   NOT NULL DEFAULT 'waiting',
  CollectedAt      TEXT   NULL,
  CollectedBy      INT            NULL REFERENCES Users(Id),
  DueAt            TEXT   NULL,
  SentAt           TEXT   NULL,
  SentTo           TEXT  NULL,
  EnteredAt        TEXT   NULL,
  EnteredBy        INT            NULL REFERENCES Users(Id),
  VerifiedAt       TEXT   NULL,
  VerifiedBy       INT            NULL REFERENCES Users(Id),
  DeliveredAt      TEXT   NULL,
  DeliveredBy      INT            NULL REFERENCES Users(Id),
  DeliveredTo      TEXT  NULL,
  ExtFile          TEXT  NULL,
  ExtFileType      TEXT   NULL,
  Comment          TEXT  NULL,
  PrintCount       INT            NOT NULL DEFAULT 0,
  CreatedAt        TEXT   NOT NULL,
  UpdatedAt        TEXT   NULL,
  CONSTRAINT CK_LabWork_Status CHECK (Status IN ('waiting','collected','done','sent','verified','delivered','cancelled')),
  CONSTRAINT CK_LabWork_Src CHECK (VisitItemId IS NOT NULL OR AdmissionItemId IS NOT NULL)
);

CREATE INDEX IX_LabWork_Status ON LabWork (Status, CreatedAt);

CREATE INDEX IX_LabWork_VisitItem ON LabWork (VisitItemId);

CREATE INDEX IX_LabWork_AdmItem ON LabWork (AdmissionItemId);

CREATE INDEX IX_LabWork_Patient ON LabWork (PatientId);

-- القيم. Flag: H عالي ، L واطي ، A غير طبيعي (نص) ، فاضي = طبيعي
CREATE TABLE LabValues (
  Id         INTEGER PRIMARY KEY AUTOINCREMENT,
  WorkId     INT            NOT NULL REFERENCES LabWork(Id),
  ParamId    INT            NULL REFERENCES LabParams(Id),
  Name       TEXT  NOT NULL,
  Unit       TEXT   NULL,
  Value      TEXT  NULL,
  Flag       TEXT    NULL,
  RefText    TEXT  NULL,
  Kind       TEXT   NOT NULL DEFAULT 'num',
  SortOrder  INT            NOT NULL DEFAULT 0
);

CREATE INDEX IX_LabValues_Work ON LabValues (WorkId, SortOrder);

INSERT INTO Counters (Name, Value) VALUES ('lab', 100000);

INSERT INTO AppSettings ([Key], Value) VALUES ('labVerify', '0');

-- =====================================================================
--  تحديث 007: حسابات الإقامة (التذكرة اليومية، أصناف الأدوية والمستلزمات، قفل التذكرة، المستحقات اللاحقة)
--  الأوامر مفصولة بـ GO. الجزء قبل «@alters» بيشتغل زي ما هو على SQLite كمان
-- =====================================================================

-- أصناف الأدوية والمستلزمات بأسعارها (هتبقى أساس الصيدلية والمخازن بعدين)
-- Kind: drug دواء | supply مستلزم
CREATE TABLE StockItems (
  Id         INTEGER PRIMARY KEY AUTOINCREMENT,
  Code       TEXT   NOT NULL,
  Name       TEXT  NOT NULL,
  SearchKey  TEXT  NULL,
  Kind       TEXT   NOT NULL,
  Unit       TEXT   NULL,
  Price      NUMERIC  NOT NULL DEFAULT 0,
  Barcode    TEXT   NULL,
  Active     INTEGER            NOT NULL DEFAULT 1,
  CreatedAt  TEXT   NOT NULL,
  UpdatedAt  TEXT   NULL,
  UpdatedBy  INT            NULL REFERENCES Users(Id),
  CONSTRAINT UQ_StockItems_Code UNIQUE (Code),
  CONSTRAINT CK_StockItems_Kind CHECK (Kind IN ('drug','supply')),
  CONSTRAINT CK_StockItems_Price CHECK (Price >= 0)
);

CREATE INDEX IX_StockItems_Kind ON StockItems (Kind, Active);

-- دفعة تذكرة: كل مرة التذكرة الورق تنزل الحسابات (ممكن كذا مرة في اليوم)
CREATE TABLE Tickets (
  Id           INTEGER PRIMARY KEY AUTOINCREMENT,
  TicketNo     INT            NOT NULL,
  AdmissionId  INT            NOT NULL REFERENCES Admissions(Id),
  TicketDate   TEXT           NOT NULL,
  ShiftLabel   TEXT   NULL,
  PaperNo      TEXT   NULL,
  Note         TEXT  NULL,
  Lines        INT            NOT NULL DEFAULT 0,
  Total        NUMERIC  NOT NULL DEFAULT 0,
  CreatedAt    TEXT   NOT NULL,
  CreatedBy    INT            NOT NULL REFERENCES Users(Id),
  CONSTRAINT UQ_Tickets_No UNIQUE (TicketNo)
);

CREATE INDEX IX_Tickets_Admission ON Tickets (AdmissionId, TicketDate);

-- بند التذكرة على حساب الإقامة. Cat: service خدمة | drug دواء | supply مستلزم | fee أتعاب أطباء | visit زيارة
ALTER TABLE AdmissionItems ADD TicketId INT NULL REFERENCES Tickets(Id);

ALTER TABLE AdmissionItems ADD StockItemId INT NULL REFERENCES StockItems(Id);

ALTER TABLE AdmissionItems ADD Cat TEXT NULL;

-- قفل التذكرة: BillStatus = closed بعد ما آخر موظف حسابات يقفلها (الحساب بيتجمد على وقت القفل)
ALTER TABLE Admissions ADD BillStatus TEXT NULL;

ALTER TABLE Admissions ADD ClosedAt TEXT NULL;

ALTER TABLE Admissions ADD ClosedBy INT NULL REFERENCES Users(Id);

ALTER TABLE Admissions ADD ReopenCount INT NOT NULL DEFAULT 0;

-- تصنيف الخدمة في التذكرة (fee أتعاب أطباء | visit زيارة) ، والسعر المفتوح (الموظف يكتب المبلغ)
ALTER TABLE Services ADD TicketCat TEXT NULL;

ALTER TABLE Services ADD OpenPrice INTEGER NOT NULL DEFAULT 0;

-- حاجة اتنست بعد خروج المريض
-- Status: open مستني القرار | billed المريض هيدفعها | charged اتحمّلت على موظف أو قسم | cancelled اتلغت
CREATE TABLE LateCharges (
  Id               INTEGER PRIMARY KEY AUTOINCREMENT,
  LateNo           INT            NOT NULL,
  AdmissionId      INT            NOT NULL REFERENCES Admissions(Id),
  PatientId        INT            NOT NULL REFERENCES Patients(Id),
  Cat              TEXT   NOT NULL,
  ServiceId        INT            NULL REFERENCES Services(Id),
  StockItemId      INT            NULL REFERENCES StockItems(Id),
  DoctorId         INT            NULL REFERENCES Doctors(Id),
  Name             TEXT  NOT NULL,
  Qty              INT            NOT NULL DEFAULT 1,
  UnitPrice        NUMERIC  NOT NULL,
  Amount           NUMERIC  NOT NULL,
  Reason           TEXT  NOT NULL,
  Status           TEXT   NOT NULL DEFAULT 'open',
  ChargeTo         TEXT   NULL,
  ChargeName       TEXT  NULL,
  ChargeUserId     INT            NULL REFERENCES Users(Id),
  AdmissionItemId  INT            NULL REFERENCES AdmissionItems(Id),
  OrderId          INT            NULL,
  DecisionNote     TEXT  NULL,
  DecidedAt        TEXT   NULL,
  DecidedBy        INT            NULL REFERENCES Users(Id),
  CreatedAt        TEXT   NOT NULL,
  CreatedBy        INT            NOT NULL REFERENCES Users(Id),
  CONSTRAINT UQ_LateCharges_No UNIQUE (LateNo),
  CONSTRAINT CK_LateCharges_Status CHECK (Status IN ('open','billed','charged','cancelled')),
  CONSTRAINT CK_LateCharges_To CHECK (ChargeTo IS NULL OR ChargeTo IN ('employee','dept'))
);

CREATE INDEX IX_LateCharges_Status ON LateCharges (Status, CreatedAt);

INSERT INTO Counters (Name, Value) VALUES ('ticket', 0);

INSERT INTO Counters (Name, Value) VALUES ('late', 0);

-- on: البنود بتتكتب من الحسابات بس، والخروج محتاج قفل التذكرة. off: زي الأول (الاستقبال بيضيف ويخرّج)
INSERT INTO AppSettings ([Key], Value) VALUES ('ticketMode', 'on');

-- =====================================================================
--  تحديث 008: أسعار الأدوار (نفس الخدمة ونفس الدرجة، وسعر مختلف حسب الدور)
--  الأوامر مفصولة بـ GO، وبيشتغل زي ما هو على SQLite كمان
-- =====================================================================

-- سعر الخدمة في دور معين (للمقيمين بس). مفيش سطر = السعر الأساسي
CREATE TABLE FloorServicePrices (
  Id         INTEGER PRIMARY KEY AUTOINCREMENT,
  FloorId    INT            NOT NULL REFERENCES Floors(Id),
  ServiceId  INT            NOT NULL REFERENCES Services(Id),
  Price      NUMERIC  NOT NULL,
  UpdatedAt  TEXT   NOT NULL,
  UpdatedBy  INT            NULL REFERENCES Users(Id),
  CONSTRAINT UQ_FloorServicePrices UNIQUE (FloorId, ServiceId),
  CONSTRAINT CK_FloorServicePrices_Price CHECK (Price >= 0)
);

-- سعر ليلة الدرجة في دور معين. مفيش سطر = سعر الدرجة الأساسي
CREATE TABLE FloorClassPrices (
  Id          INTEGER PRIMARY KEY AUTOINCREMENT,
  FloorId     INT            NOT NULL REFERENCES Floors(Id),
  ClassId     INT            NOT NULL REFERENCES RoomClasses(Id),
  NightPrice  NUMERIC  NOT NULL,
  UpdatedAt   TEXT   NOT NULL,
  UpdatedBy   INT            NULL REFERENCES Users(Id),
  CONSTRAINT UQ_FloorClassPrices UNIQUE (FloorId, ClassId),
  CONSTRAINT CK_FloorClassPrices_Price CHECK (NightPrice >= 0)
);

-- الدور اللي اتسعّر عليه البند
ALTER TABLE AdmissionItems ADD FloorId INT NULL;

-- =====================================================================
--  تحديث 009: المخازن (الرئيسي، الصيدلية، مخازن الأدوار والأقسام)، الوحدات، التشغيلات والصلاحية،
--  الاستلام من الموردين، التحويلات، والخصم من مخزن الدور مع التذكرة
--  الأوامر مفصولة بـ GO. الجزء قبل «@alters» بيشتغل زي ما هو على SQLite كمان
-- =====================================================================

-- صلاحيات إضافية لكل مستخدم (JSON) ومخازنه
ALTER TABLE Users ADD Grants TEXT NULL;

ALTER TABLE Users ADD StoreIds TEXT NULL;

-- Kind: main رئيسي | pharmacy صيدلية | sub فرعي (دور/عيادة/قسم). Holds: drug | supply | all
CREATE TABLE Stores (
  Id         INTEGER PRIMARY KEY AUTOINCREMENT,
  Name       TEXT   NOT NULL,
  Kind       TEXT   NOT NULL,
  Holds      TEXT   NOT NULL DEFAULT 'all',
  FloorId    INT            NULL REFERENCES Floors(Id),
  Notes      TEXT  NULL,
  SortOrder  INT            NOT NULL DEFAULT 0,
  Active     INTEGER            NOT NULL DEFAULT 1,
  CreatedAt  TEXT   NOT NULL,
  CONSTRAINT CK_Stores_Kind CHECK (Kind IN ('main','pharmacy','sub')),
  CONSTRAINT CK_Stores_Holds CHECK (Holds IN ('drug','supply','all'))
);

-- الوحدات: Unit = أصغر وحدة (السعر عليها)، والوسطى والكبيرة بعددهم من الصغيرة
ALTER TABLE StockItems ADD MidUnit TEXT NULL;

ALTER TABLE StockItems ADD MidQty INT NULL;

ALTER TABLE StockItems ADD PackUnit TEXT NULL;

ALTER TABLE StockItems ADD PackQty INT NULL;

ALTER TABLE StockItems ADD MinQty NUMERIC NULL;

ALTER TABLE StockItems ADD LastCost NUMERIC NULL;

-- الرصيد بالتشغيلة والصلاحية (بأصغر وحدة). التشغيلة الفاضية = رصيد من غير تشغيلة (ومنها السالب)
CREATE TABLE StockBatches (
  Id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ItemId     INT            NOT NULL REFERENCES StockItems(Id),
  StoreId    INT            NOT NULL REFERENCES Stores(Id),
  BatchNo    TEXT   NULL,
  Expiry     TEXT           NULL,
  Qty        NUMERIC  NOT NULL DEFAULT 0,
  Cost       NUMERIC  NULL,
  CreatedAt  TEXT   NOT NULL
);

CREATE INDEX IX_StockBatches_StoreItem ON StockBatches (StoreId, ItemId);

-- كل حركة مخزن. Qty موجبة دخول وسالبة خروج
CREATE TABLE StockMoves (
  Id        INTEGER PRIMARY KEY AUTOINCREMENT,
  At        TEXT   NOT NULL,
  Kind      TEXT   NOT NULL,
  ItemId    INT            NOT NULL REFERENCES StockItems(Id),
  StoreId   INT            NOT NULL REFERENCES Stores(Id),
  BatchId   INT            NULL REFERENCES StockBatches(Id),
  Qty       NUMERIC  NOT NULL,
  Cost      NUMERIC  NULL,
  RefType   TEXT   NULL,
  RefId     INT            NULL,
  UserId    INT            NULL REFERENCES Users(Id),
  Note      TEXT  NULL
);

CREATE INDEX IX_StockMoves_ItemStore ON StockMoves (ItemId, StoreId, At);

CREATE INDEX IX_StockMoves_Ref ON StockMoves (RefType, RefId);

-- الاستلام من الموردين (ورصيد أول المدة)
CREATE TABLE Purchases (
  Id           INTEGER PRIMARY KEY AUTOINCREMENT,
  PurchaseNo   INT            NOT NULL,
  Kind         TEXT   NOT NULL DEFAULT 'supplier',
  StoreId      INT            NOT NULL REFERENCES Stores(Id),
  Supplier     TEXT  NULL,
  InvoiceNo    TEXT   NULL,
  InvoiceDate  TEXT           NULL,
  Total        NUMERIC  NOT NULL DEFAULT 0,
  Note         TEXT  NULL,
  CreatedAt    TEXT   NOT NULL,
  CreatedBy    INT            NOT NULL REFERENCES Users(Id),
  CONSTRAINT UQ_Purchases_No UNIQUE (PurchaseNo),
  CONSTRAINT CK_Purchases_Kind CHECK (Kind IN ('supplier','opening'))
);

CREATE TABLE PurchaseLines (
  Id          INTEGER PRIMARY KEY AUTOINCREMENT,
  PurchaseId  INT            NOT NULL REFERENCES Purchases(Id),
  ItemId      INT            NOT NULL REFERENCES StockItems(Id),
  UnitName    TEXT   NULL,
  UnitFactor  INT            NOT NULL DEFAULT 1,
  Qty         NUMERIC  NOT NULL,
  BaseQty     NUMERIC  NOT NULL,
  UnitCost    NUMERIC  NOT NULL DEFAULT 0,
  BatchNo     TEXT   NULL,
  Expiry      TEXT           NULL,
  LineTotal   NUMERIC  NOT NULL DEFAULT 0,
  BatchId     INT            NULL
);

CREATE INDEX IX_PurchaseLines_Purchase ON PurchaseLines (PurchaseId);

-- التحويلات: requested طلب ← issued اتصرف من المخزن ← received الفرعي استلم ← confirmed الرئيسي أكّد
CREATE TABLE Transfers (
  Id            INTEGER PRIMARY KEY AUTOINCREMENT,
  TransferNo    INT            NOT NULL,
  FromStoreId   INT            NOT NULL REFERENCES Stores(Id),
  ToStoreId     INT            NOT NULL REFERENCES Stores(Id),
  Status        TEXT   NOT NULL,
  Direct        INTEGER            NOT NULL DEFAULT 0,
  Note          TEXT  NULL,
  RequestedAt   TEXT   NULL,
  RequestedBy   INT            NULL REFERENCES Users(Id),
  IssuedAt      TEXT   NULL,
  IssuedBy      INT            NULL REFERENCES Users(Id),
  ReceivedAt    TEXT   NULL,
  ReceivedBy    INT            NULL REFERENCES Users(Id),
  ConfirmedAt   TEXT   NULL,
  ConfirmedBy   INT            NULL REFERENCES Users(Id),
  CancelledAt   TEXT   NULL,
  CancelledBy   INT            NULL REFERENCES Users(Id),
  CancelReason  TEXT  NULL,
  CreatedAt     TEXT   NOT NULL,
  CONSTRAINT UQ_Transfers_No UNIQUE (TransferNo),
  CONSTRAINT CK_Transfers_Status CHECK (Status IN ('requested','issued','received','confirmed','cancelled'))
);

CREATE INDEX IX_Transfers_Status ON Transfers (Status, CreatedAt);

CREATE TABLE TransferLines (
  Id           INTEGER PRIMARY KEY AUTOINCREMENT,
  TransferId   INT            NOT NULL REFERENCES Transfers(Id),
  ItemId       INT            NOT NULL REFERENCES StockItems(Id),
  ReqQty       NUMERIC  NOT NULL DEFAULT 0,
  IssuedQty    NUMERIC  NULL,
  Note         TEXT  NULL
);

CREATE INDEX IX_TransferLines_Transfer ON TransferLines (TransferId);

-- بند التذكرة: الوحدة اللي اتكتب بيها (عددها من أصغر وحدة) والمخزن اللي اتخصم منه
ALTER TABLE AdmissionItems ADD UnitFactor INT NULL;

ALTER TABLE AdmissionItems ADD StoreId INT NULL;

ALTER TABLE LateCharges ADD StoreId INT NULL;

INSERT INTO Counters (Name, Value) VALUES ('purchase', 0);

INSERT INTO Counters (Name, Value) VALUES ('transfer', 0);

-- on: الأدوية والمستلزمات في التذكرة بتتخصم من مخزن الدور
INSERT INTO AppSettings ([Key], Value) VALUES ('stockDeduct', 'on');

-- =====================================================================
--  تحديث 010: مخازن الأقسام، الصرف من مخزن تختاره في التذكرة، صرف الأدوية والمستلزمات في الزيارة،
--  بيع الصيدلية، المرتجعات، الجرد، والإعدام
--  الأوامر مفصولة بـ GO. الجزء قبل «@alters» بيشتغل زي ما هو على SQLite كمان
-- =====================================================================

-- القسم اللي المخزن تبعه (عشان البرنامج يختاره لوحده): or عمليات | icu عناية | nursery حضانة | emergency طوارئ | clinic عيادات | lab | radiology
ALTER TABLE Stores ADD Dept TEXT NULL;

-- الدفعة اتصرفت من أنهي مخزن
ALTER TABLE Tickets ADD StoreId INT NULL;

-- صرف صنف في الزيارة الخارجية (والصيدلية)
ALTER TABLE VisitItems ADD StockItemId INT NULL;

ALTER TABLE VisitItems ADD StoreId INT NULL;

ALTER TABLE VisitItems ADD UnitFactor INT NULL;

ALTER TABLE VisitItems ADD ReturnedQty INT NOT NULL DEFAULT 0;

-- الجرد: المخزن بيقف لحد ما الجرد يتعتمد أو يتلغي
-- Status: open بيتعد ← submitted اتسلّم للاعتماد ← approved اتعتمد والرصيد اتظبط | cancelled
CREATE TABLE StockCounts (
  Id           INTEGER PRIMARY KEY AUTOINCREMENT,
  CountNo      INT            NOT NULL,
  StoreId      INT            NOT NULL REFERENCES Stores(Id),
  Status       TEXT   NOT NULL,
  Note         TEXT  NULL,
  CreatedAt    TEXT   NOT NULL,
  CreatedBy    INT            NOT NULL REFERENCES Users(Id),
  SubmittedAt  TEXT   NULL,
  SubmittedBy  INT            NULL REFERENCES Users(Id),
  ApprovedAt   TEXT   NULL,
  ApprovedBy   INT            NULL REFERENCES Users(Id),
  CancelledAt  TEXT   NULL,
  CancelledBy  INT            NULL REFERENCES Users(Id),
  DiffValue    NUMERIC  NULL,
  CONSTRAINT UQ_StockCounts_No UNIQUE (CountNo),
  CONSTRAINT CK_StockCounts_Status CHECK (Status IN ('open','submitted','approved','cancelled'))
);

CREATE TABLE StockCountLines (
  Id          INTEGER PRIMARY KEY AUTOINCREMENT,
  CountId     INT            NOT NULL REFERENCES StockCounts(Id),
  ItemId      INT            NOT NULL REFERENCES StockItems(Id),
  BatchId     INT            NULL REFERENCES StockBatches(Id),
  BatchNo     TEXT   NULL,
  Expiry      TEXT           NULL,
  SystemQty   NUMERIC  NOT NULL DEFAULT 0,
  CountedQty  NUMERIC  NULL,
  Cost        NUMERIC  NULL
);

CREATE INDEX IX_StockCountLines_Count ON StockCountLines (CountId);

-- الإعدام (منتهي، تالف، مكسور)
CREATE TABLE StockWaste (
  Id         INTEGER PRIMARY KEY AUTOINCREMENT,
  WasteNo    INT            NOT NULL,
  StoreId    INT            NOT NULL REFERENCES Stores(Id),
  ItemId     INT            NOT NULL REFERENCES StockItems(Id),
  BatchId    INT            NULL REFERENCES StockBatches(Id),
  Qty        NUMERIC  NOT NULL,
  Cost       NUMERIC  NULL,
  Reason     TEXT  NOT NULL,
  CreatedAt  TEXT   NOT NULL,
  CreatedBy  INT            NOT NULL REFERENCES Users(Id)
);

INSERT INTO Counters (Name, Value) VALUES ('count', 0);

INSERT INTO Counters (Name, Value) VALUES ('waste', 0);

-- =====================================================================
--  تحديث 011: حسابات التعاقدات — مراجعة الحالات، المطالبة الشهرية (Cover + تفصيلي)، الشيكات والمرفوضات
--  الأوامر مفصولة بـ GO. الجزء قبل «@alters» بيشتغل زي ما هو على SQLite كمان
-- =====================================================================

-- التشخيص بيكتبه الاستقبال وقت التسجيل (بيطلع في المطالبة)
ALTER TABLE Visits ADD Diagnosis TEXT NULL;

ALTER TABLE Admissions ADD Diagnosis TEXT NULL;

-- الحالة = زيارة أو دخول على جهة. Period = شهر المطالبة (yyyy-mm): الخارجي بشهر الزيارة والداخلي بشهر الخروج، والتأجيل بيغيّره
-- Status: pending مستنية المراجعة | ok اتراجعت | note فيها ملاحظة (بترجع للاستقبال)
CREATE TABLE ClaimCases (
  Id           INTEGER PRIMARY KEY AUTOINCREMENT,
  PayerId      INT            NOT NULL REFERENCES Payers(Id),
  Kind         TEXT   NOT NULL,
  VisitId      INT            NULL REFERENCES Visits(Id),
  AdmissionId  INT            NULL REFERENCES Admissions(Id),
  PatientId    INT            NOT NULL REFERENCES Patients(Id),
  Period       TEXT    NOT NULL,
  BasePeriod   TEXT    NOT NULL,
  Status       TEXT   NOT NULL,
  Note         TEXT  NULL,
  NoteBy       INT            NULL REFERENCES Users(Id),
  NoteAt       TEXT   NULL,
  FixedBy      INT            NULL REFERENCES Users(Id),
  FixedAt      TEXT   NULL,
  ReviewedBy   INT            NULL REFERENCES Users(Id),
  ReviewedAt   TEXT   NULL,
  CreatedAt    TEXT   NOT NULL,
  CONSTRAINT CK_ClaimCases_Kind CHECK (Kind IN ('visit','admission')),
  CONSTRAINT CK_ClaimCases_Status CHECK (Status IN ('pending','ok','note'))
);

CREATE UNIQUE INDEX UX_ClaimCases_Visit ON ClaimCases (VisitId) WHERE VisitId IS NOT NULL;

CREATE UNIQUE INDEX UX_ClaimCases_Adm ON ClaimCases (AdmissionId) WHERE AdmissionId IS NOT NULL;

CREATE INDEX IX_ClaimCases_Period ON ClaimCases (PayerId, Period);

-- مستندات الحالة (روشتة، تقرير، صورة كارنيه…)
CREATE TABLE ClaimCaseFiles (
  Id         INTEGER PRIMARY KEY AUTOINCREMENT,
  CaseId     INT            NOT NULL REFERENCES ClaimCases(Id),
  FileName   TEXT  NOT NULL,
  Label      TEXT  NULL,
  CreatedAt  TEXT   NOT NULL,
  CreatedBy  INT            NOT NULL REFERENCES Users(Id)
);

-- المطالبة: draft مسودة (بتتحدث لوحدها) ← sent اتبعتت (مقفولة) ← partial اتدفع جزء ← closed خلصت
CREATE TABLE Claims (
  Id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ClaimNo      INT            NOT NULL,
  PayerId      INT            NOT NULL REFERENCES Payers(Id),
  Period       TEXT    NOT NULL,
  IssueDate    TEXT           NULL,
  Status       TEXT   NOT NULL,
  Total        NUMERIC  NOT NULL DEFAULT 0,
  Paid         NUMERIC  NOT NULL DEFAULT 0,
  Rejected     NUMERIC  NOT NULL DEFAULT 0,
  Note         TEXT  NULL,
  CreatedAt    TEXT   NOT NULL,
  CreatedBy    INT            NOT NULL REFERENCES Users(Id),
  SentAt       TEXT   NULL,
  SentBy       INT            NULL REFERENCES Users(Id),
  ReopenCount  INT            NOT NULL DEFAULT 0,
  CONSTRAINT UQ_Claims_No UNIQUE (ClaimNo),
  CONSTRAINT CK_Claims_Status CHECK (Status IN ('draft','sent','partial','closed'))
);

CREATE INDEX IX_Claims_Payer ON Claims (PayerId, Period);

-- سطور المطالبة: نسخة من نصيب الشركة في كل بند بتاريخ الخدمة (الفرق بعد المطالبة بيروح للمطالبة اللي بعدها)
CREATE TABLE ClaimLines (
  Id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ClaimId          INT            NOT NULL REFERENCES Claims(Id),
  CaseId           INT            NOT NULL REFERENCES ClaimCases(Id),
  VisitItemId      INT            NULL REFERENCES VisitItems(Id),
  AdmissionItemId  INT            NULL REFERENCES AdmissionItems(Id),
  ServiceDate      TEXT           NULL,
  Description      TEXT  NOT NULL,
  Qty              INT            NOT NULL DEFAULT 1,
  FullAmount       NUMERIC  NOT NULL DEFAULT 0,
  Amount           NUMERIC  NOT NULL,
  Rejected         NUMERIC  NOT NULL DEFAULT 0,
  RejectReason     TEXT  NULL
);

CREATE INDEX IX_ClaimLines_Claim ON ClaimLines (ClaimId);

-- الشيكات (ممكن أكتر من شيك للمطالبة)
CREATE TABLE ClaimPayments (
  Id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ClaimId     INT            NOT NULL REFERENCES Claims(Id),
  ChequeNo    TEXT   NOT NULL,
  Bank        TEXT   NULL,
  ChequeDate  TEXT           NULL,
  Amount      NUMERIC  NOT NULL,
  Note        TEXT  NULL,
  CreatedAt   TEXT   NOT NULL,
  CreatedBy   INT            NOT NULL REFERENCES Users(Id)
);

INSERT INTO Counters (Name, Value) VALUES ('claim', 0);

-- =====================================================================
--  تحديث 012: الحسابات العامة
--  صرف مستحقات الأطباء (بالضريبة)، الموردين وفواتيرهم ودفعاتهم وشيكاتهم،
--  المصروفات (بموافقة أو مباشر)، الأقساط على المستشفى، وإذن الصرف النقدي من الخزينة
--  الأوامر مفصولة بـ GO. الجزء قبل «@alters» بيشتغل زي ما هو على SQLite كمان
-- =====================================================================

-- إذن صرف نقدي: الحسابات بتجهّزه والخزينة بتصرف منه وبيتخصم من درج وردية اللي صرف
-- Kind: payout = مستحقات دكتور ، expense = مصروف ، supplier = دفعة مورد ، installment = قسط
CREATE TABLE CashVouchers (
  Id           INTEGER PRIMARY KEY AUTOINCREMENT,
  VoucherNo    INT            NOT NULL,
  Kind         TEXT   NOT NULL,
  RefId        INT            NOT NULL,
  Payee        TEXT  NOT NULL,
  Description  TEXT  NOT NULL,
  Amount       NUMERIC  NOT NULL,
  Status       TEXT   NOT NULL DEFAULT 'pending',
  CreatedAt    TEXT   NOT NULL,
  CreatedBy    INT            NOT NULL REFERENCES Users(Id),
  PaidAt       TEXT   NULL,
  PaidBy       INT            NULL REFERENCES Users(Id),
  ShiftId      INT            NULL REFERENCES Shifts(Id),
  CancelReason TEXT  NULL,
  CONSTRAINT UQ_CashVouchers_No UNIQUE (VoucherNo),
  CONSTRAINT CK_CashVouchers_Kind CHECK (Kind IN ('payout','expense','supplier','installment')),
  CONSTRAINT CK_CashVouchers_Status CHECK (Status IN ('pending','paid','cancelled'))
);

CREATE INDEX IX_CashVouchers_Status ON CashVouchers (Status, CreatedAt);

CREATE INDEX IX_CashVouchers_Shift ON CashVouchers (ShiftId);

-- صرف مستحقات الأطباء: بتتحسب لحد آخر الشهر، والصافي = المستحق − الضريبة
CREATE TABLE DoctorPayouts (
  Id          INTEGER PRIMARY KEY AUTOINCREMENT,
  PayoutNo    INT            NOT NULL,
  DoctorId    INT            NOT NULL REFERENCES Doctors(Id),
  Period      TEXT    NOT NULL,
  CutoffAt    TEXT   NOT NULL,
  Gross       NUMERIC  NOT NULL,
  TaxPct      NUMERIC   NOT NULL,
  Tax         NUMERIC  NOT NULL,
  Net         NUMERIC  NOT NULL,
  Status      TEXT   NOT NULL DEFAULT 'issued',
  Note        TEXT  NULL,
  CreatedAt   TEXT   NOT NULL,
  CreatedBy   INT            NOT NULL REFERENCES Users(Id),
  PaidAt      TEXT   NULL,
  VoidReason  TEXT  NULL,
  VoucherId   INT            NULL REFERENCES CashVouchers(Id),
  CONSTRAINT UQ_DoctorPayouts_No UNIQUE (PayoutNo),
  CONSTRAINT CK_DoctorPayouts_Status CHECK (Status IN ('issued','paid','void'))
);

CREATE INDEX IX_DoctorPayouts_Doctor ON DoctorPayouts (DoctorId, Status);

-- نصيب الشركة من أتعاب الدكتور مستحق بعد التحصيل: بيتحرّر يدوي بعد ما الشركة تدفع
ALTER TABLE DoctorEarnings ADD PayerReleased INTEGER NOT NULL DEFAULT 0;

-- الموردين
CREATE TABLE Suppliers (
  Id         INTEGER PRIMARY KEY AUTOINCREMENT,
  Name       TEXT  NOT NULL,
  Phone      TEXT   NULL,
  Note       TEXT  NULL,
  Active     INTEGER            NOT NULL DEFAULT 1,
  CreatedAt  TEXT   NOT NULL,
  CONSTRAINT UQ_Suppliers_Name UNIQUE (Name)
);

CREATE TABLE SupplierInvoices (
  Id          INTEGER PRIMARY KEY AUTOINCREMENT,
  InvNo       INT            NOT NULL,
  SupplierId  INT            NOT NULL REFERENCES Suppliers(Id),
  PurchaseId  INT            NULL REFERENCES Purchases(Id),
  DocNo       TEXT   NULL,
  DocDate     TEXT           NOT NULL,
  DueDate     TEXT           NULL,
  Amount      NUMERIC  NOT NULL,
  Note        TEXT  NULL,
  Status      TEXT   NOT NULL DEFAULT 'open',
  VoidReason  TEXT  NULL,
  CreatedAt   TEXT   NOT NULL,
  CreatedBy   INT            NOT NULL REFERENCES Users(Id),
  CONSTRAINT UQ_SupplierInvoices_No UNIQUE (InvNo),
  CONSTRAINT CK_SupplierInvoices_Status CHECK (Status IN ('open','void'))
);

CREATE INDEX IX_SupplierInvoices_Supplier ON SupplierInvoices (SupplierId, DueDate);

-- دفعة مورد: bank تحويل من حساب البنك ، cash من الخزينة (بإذن صرف) ، cheque شيك (ClearedAt لما يتصرف)
CREATE TABLE SupplierPayments (
  Id          INTEGER PRIMARY KEY AUTOINCREMENT,
  SupplierId  INT            NOT NULL REFERENCES Suppliers(Id),
  InvoiceId   INT            NULL REFERENCES SupplierInvoices(Id),
  Method      TEXT    NOT NULL,
  Amount      NUMERIC  NOT NULL,
  PayDate     TEXT           NOT NULL,
  ChequeNo    TEXT   NULL,
  ChequeDate  TEXT           NULL,
  Bank        TEXT   NULL,
  ClearedAt   TEXT   NULL,
  VoucherId   INT            NULL REFERENCES CashVouchers(Id),
  Status      TEXT    NOT NULL DEFAULT 'ok',
  VoidReason  TEXT  NULL,
  Note        TEXT  NULL,
  CreatedAt   TEXT   NOT NULL,
  CreatedBy   INT            NOT NULL REFERENCES Users(Id),
  CONSTRAINT CK_SupplierPayments_Method CHECK (Method IN ('bank','cash','cheque')),
  CONSTRAINT CK_SupplierPayments_Status CHECK (Status IN ('ok','void'))
);

CREATE INDEX IX_SupplierPayments_Invoice ON SupplierPayments (InvoiceId);

CREATE INDEX IX_SupplierPayments_Cheque ON SupplierPayments (Method, ClearedAt);

-- المصروفات
CREATE TABLE ExpenseCategories (
  Id         INTEGER PRIMARY KEY AUTOINCREMENT,
  Name       TEXT  NOT NULL,
  SortOrder  INT           NOT NULL DEFAULT 0,
  Active     INTEGER           NOT NULL DEFAULT 1,
  CONSTRAINT UQ_ExpenseCategories_Name UNIQUE (Name)
);

CREATE TABLE Expenses (
  Id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ExpNo       INT            NOT NULL,
  ExpDate     TEXT           NOT NULL,
  CategoryId  INT            NOT NULL REFERENCES ExpenseCategories(Id),
  Amount      NUMERIC  NOT NULL,
  Method      TEXT    NOT NULL,
  Payee       TEXT  NULL,
  Note        TEXT  NULL,
  Status      TEXT   NOT NULL DEFAULT 'approved',
  CreatedAt   TEXT   NOT NULL,
  CreatedBy   INT            NOT NULL REFERENCES Users(Id),
  DecidedAt   TEXT   NULL,
  DecidedBy   INT            NULL REFERENCES Users(Id),
  RejectReason TEXT NULL,
  VoucherId   INT            NULL REFERENCES CashVouchers(Id),
  CONSTRAINT UQ_Expenses_No UNIQUE (ExpNo),
  CONSTRAINT CK_Expenses_Method CHECK (Method IN ('cash','bank')),
  CONSTRAINT CK_Expenses_Status CHECK (Status IN ('pending','approved','rejected','void'))
);

CREATE INDEX IX_Expenses_Date ON Expenses (ExpDate, Status);

-- الأقساط على المستشفى (أجهزة، قروض، موردين مقسّطين)
CREATE TABLE Obligations (
  Id         INTEGER PRIMARY KEY AUTOINCREMENT,
  Name       TEXT  NOT NULL,
  Party      TEXT  NULL,
  Note       TEXT  NULL,
  Active     INTEGER            NOT NULL DEFAULT 1,
  CreatedAt  TEXT   NOT NULL,
  CreatedBy  INT            NOT NULL REFERENCES Users(Id)
);

CREATE TABLE ObligationInstallments (
  Id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ObligationId  INT            NOT NULL REFERENCES Obligations(Id),
  No            INT            NOT NULL,
  DueDate       TEXT           NOT NULL,
  Amount        NUMERIC  NOT NULL,
  Status        TEXT    NOT NULL DEFAULT 'due',
  PaidAt        TEXT   NULL,
  PaidBy        INT            NULL REFERENCES Users(Id),
  Method        TEXT    NULL,
  ChequeNo      TEXT   NULL,
  ClearedAt     TEXT   NULL,
  VoucherId     INT            NULL REFERENCES CashVouchers(Id),
  CONSTRAINT CK_ObligationInstallments_Status CHECK (Status IN ('due','paid'))
);

CREATE INDEX IX_ObligationInstallments_Due ON ObligationInstallments (Status, DueDate);

INSERT INTO Counters (Name, Value) VALUES ('payout', 0);

INSERT INTO Counters (Name, Value) VALUES ('voucher', 0);

INSERT INTO Counters (Name, Value) VALUES ('expense', 0);

INSERT INTO Counters (Name, Value) VALUES ('supinv', 0);

INSERT INTO ExpenseCategories (Name, SortOrder) VALUES ('كهرباء ومياه وغاز', 1);

INSERT INTO ExpenseCategories (Name, SortOrder) VALUES ('صيانة', 2);

INSERT INTO ExpenseCategories (Name, SortOrder) VALUES ('نظافة وتشغيل', 3);

INSERT INTO ExpenseCategories (Name, SortOrder) VALUES ('مستلزمات إدارية', 4);

INSERT INTO ExpenseCategories (Name, SortOrder) VALUES ('ضيافة وكافتيريا', 5);

INSERT INTO ExpenseCategories (Name, SortOrder) VALUES ('انتقالات وشحن', 6);

INSERT INTO ExpenseCategories (Name, SortOrder) VALUES ('إيجارات وإنترنت واتصالات', 7);

INSERT INTO ExpenseCategories (Name, SortOrder) VALUES ('أخرى', 99);

-- =====================================================================
--  تحديث 013: القوائم المرجعية (Lookups)
--  بدل قيود CHECK على أنواع بتختلف من مستشفى لمستشفى: الأقسام، أنواع الدخول،
--  أنواع الغرف. كل قيمة ليها اسم ولون وأيقونة وسلوك (Behavior) والكود
--  بيتعامل مع السلوك مش مع الاسم. المدير بيضيف ويعدّل ويوقف من الشاشة.
--  الأوامر مفصولة بـ GO. الجزء قبل «@alters» بيشتغل زي ما هو على SQLite كمان.
-- =====================================================================

-- Domain: dept | admission_type | room_kind
-- Behavior (للأقسام): clinic | emergency | lab | radiology | ward | or | service
-- Meta: JSON (prefix, visit, pay, roomKind ...)
CREATE TABLE LookupValues (
  Id         INTEGER PRIMARY KEY AUTOINCREMENT,
  Domain     TEXT  NOT NULL,
  Code       TEXT  NOT NULL,
  Name       TEXT NOT NULL,
  ShortName  TEXT  NULL,
  Color      TEXT   NULL,
  Icon       TEXT  NULL,
  Behavior   TEXT  NULL,
  SortOrder  INT           NOT NULL DEFAULT 0,
  Active     INTEGER           NOT NULL DEFAULT 1,
  Meta       TEXT NULL,
  CONSTRAINT UQ_LookupValues UNIQUE (Domain, Code)
);

-- القالب الافتراضي: أقسام عامة أي مستشفى بتبدأ بيها (تتعدّل أو تتوقف أو تتمسح لو مش مستخدمة)
INSERT INTO LookupValues (Domain, Code, Name, ShortName, Color, Icon, Behavior, SortOrder, Meta) VALUES ('dept', 'clinic', 'العيادات', 'عيادة', '#0e8a87', 'steth', 'clinic', 10, '{"visit":true,"prefix":"CL"}');

INSERT INTO LookupValues (Domain, Code, Name, ShortName, Color, Icon, Behavior, SortOrder, Meta) VALUES ('dept', 'emergency', 'الطوارئ', 'طوارئ', '#e2474f', 'bolt', 'emergency', 20, '{"visit":true,"prefix":"ER","pay":"after"}');

INSERT INTO LookupValues (Domain, Code, Name, ShortName, Color, Icon, Behavior, SortOrder, Meta) VALUES ('dept', 'lab', 'المعمل', 'معمل', '#6c55d1', 'flask', 'lab', 30, '{"visit":true,"prefix":"LAB"}');

INSERT INTO LookupValues (Domain, Code, Name, ShortName, Color, Icon, Behavior, SortOrder, Meta) VALUES ('dept', 'radiology', 'الأشعة', 'أشعة', '#2c6ddc', 'scan', 'radiology', 40, '{"visit":true,"prefix":"RAD"}');

INSERT INTO LookupValues (Domain, Code, Name, ShortName, Color, Icon, Behavior, SortOrder, Meta) VALUES ('dept', 'ward', 'خدمات الإقامة', 'إقامة', '#b5651d', 'bed', 'ward', 50, '{"visit":false,"prefix":"IP"}');

INSERT INTO LookupValues (Domain, Code, Name, ShortName, Color, Icon, Behavior, SortOrder, Meta) VALUES ('dept', 'or', 'العمليات', 'عمليات', '#4f5bd5', 'scalpel', 'or', 60, '{"visit":false,"prefix":"OR"}');

-- أنواع الدخول: roomKind = نوع الغرفة اللي بتناسبه
INSERT INTO LookupValues (Domain, Code, Name, ShortName, Color, Icon, Behavior, SortOrder, Meta) VALUES ('admission_type', 'inpatient', 'داخلي', 'داخلي', '#d0661c', 'bed', 'standard', 10, '{"roomKind":"ward"}');

INSERT INTO LookupValues (Domain, Code, Name, ShortName, Color, Icon, Behavior, SortOrder, Meta) VALUES ('admission_type', 'surgery', 'عمليات', 'عمليات', '#4f5bd5', 'scalpel', 'surgery', 20, '{"roomKind":"ward"}');

INSERT INTO LookupValues (Domain, Code, Name, ShortName, Color, Icon, Behavior, SortOrder, Meta) VALUES ('admission_type', 'icu', 'عناية', 'عناية', '#d23c4f', 'heart', 'standard', 30, '{"roomKind":"icu"}');

INSERT INTO LookupValues (Domain, Code, Name, ShortName, Color, Icon, Behavior, SortOrder, Meta) VALUES ('admission_type', 'nursery', 'حضانة', 'حضانة', '#d4508f', 'baby', 'standard', 40, '{"roomKind":"nursery"}');

-- أنواع الغرف
INSERT INTO LookupValues (Domain, Code, Name, ShortName, Color, Icon, Behavior, SortOrder) VALUES ('room_kind', 'ward', 'إقامة', 'إقامة', '#d0661c', 'bed', NULL, 10);

INSERT INTO LookupValues (Domain, Code, Name, ShortName, Color, Icon, Behavior, SortOrder) VALUES ('room_kind', 'icu', 'عناية', 'عناية', '#d23c4f', 'heart', NULL, 20);

INSERT INTO LookupValues (Domain, Code, Name, ShortName, Color, Icon, Behavior, SortOrder) VALUES ('room_kind', 'nursery', 'حضانة', 'حضانة', '#d4508f', 'baby', NULL, 30);

-- =====================================================================
--  تحديث 014: التشخيص الإجباري عند دخول الإقامة
--  DiagnosisProvisional = التشخيص مبدئي (طوارئ حرجة) ولازم يتحوّل لنهائي في المهلة اللي في الإعدادات
--  DiagnosisList = القايمة الجاهزة اللي بتظهر مع البحث (والنص الحر مسموح كمان)
--  الأوامر مفصولة بـ GO
-- =====================================================================
ALTER TABLE Admissions ADD DiagnosisProvisional INTEGER NOT NULL DEFAULT 0;

CREATE TABLE DiagnosisList (
  Id        INTEGER PRIMARY KEY AUTOINCREMENT,
  Name      TEXT NOT NULL UNIQUE,
  Active    INTEGER NOT NULL DEFAULT 1,
  SortOrder INT NOT NULL DEFAULT 0
);

INSERT INTO DiagnosisList (Name, SortOrder) VALUES
  ('التهاب رئوي', 1),
  ('التهاب شعبي حاد', 2),
  ('ربو شعبي (نوبة حادة)', 3),
  ('انسداد رئوي مزمن (تفاقم)', 4),
  ('فشل تنفسي', 5),
  ('ذبحة صدرية غير مستقرة', 6),
  ('جلطة بالقلب (احتشاء عضلة القلب)', 7),
  ('فشل قلب احتقاني', 8),
  ('عدم انتظام ضربات القلب', 9),
  ('ارتفاع حاد في ضغط الدم', 10),
  ('جلطة بالمخ', 11),
  ('نزيف بالمخ', 12),
  ('غيبوبة', 13),
  ('تشنجات', 14),
  ('التهاب سحائي', 15),
  ('نزيف بالجهاز الهضمي العلوي', 16),
  ('التهاب المرارة / حصوات المرارة', 17),
  ('التهاب الزائدة الدودية', 18),
  ('انسداد معوي', 19),
  ('التهاب البنكرياس الحاد', 20),
  ('فشل كبدي', 21),
  ('غيبوبة كبدية', 22),
  ('دوالي المريء', 23),
  ('فشل كلوي حاد', 24),
  ('فشل كلوي مزمن (غسيل)', 25),
  ('حصوات بالكلى / الحالب', 26),
  ('التهاب بالمسالك البولية', 27),
  ('غيبوبة سكر / حموضة كيتونية', 28),
  ('هبوط سكر حاد', 29),
  ('جفاف شديد / نزلة معوية', 30),
  ('تسمم غذائي', 31),
  ('تسمم دوائي', 32),
  ('كسر بالعظام', 33),
  ('كسر بالفخذ', 34),
  ('حادث طريق (إصابات متعددة)', 35),
  ('جرح قطعي', 36),
  ('حروق', 37),
  ('ولادة طبيعية', 38),
  ('ولادة قيصرية', 39),
  ('نزيف ما بعد الولادة', 40),
  ('تسمم حمل', 41),
  ('إجهاض', 42),
  ('التهاب رئوي أطفال', 43),
  ('تشنجات حرارية (أطفال)', 44),
  ('صفراء المواليد', 45),
  ('خدّج (حضّانة)', 46),
  ('التهاب لوزتين', 47),
  ('عملية جراحية مجدولة', 48),
  ('متابعة بعد عملية', 49),
  ('قرحة بالمعدة أو الاثني عشر', 50);

-- =====================================================================
--  تحديث 015: وحدة بيع افتراضية ووحدة شراء افتراضية للصنف
--  القيمة: base (الصغيرة) أو mid (الوسطى) أو pack (الكبيرة). NULL = السلوك القديم بالظبط
--  السعر لسه واحد على أصغر وحدة، والوحدة الافتراضية بتحدد الاختيار المبدئي بس
--  الأوامر مفصولة بـ GO
-- =====================================================================
ALTER TABLE StockItems ADD DefaultSaleUnit TEXT NULL;

ALTER TABLE StockItems ADD DefaultPurchaseUnit TEXT NULL;

-- =====================================================================
--  تحديث 016: العيادات (R1b)
--  Clinics = عيادة بمخزنها (StoreId اختياري وواحد لواحد). نسبة العيادة الافتراضية بتتضاف مع شريحة نصيب الدكتور (محاسبية)
--  Doctors.ClinicId = عيادة الدكتور الأساسية. التخصص القديم بيتنقل لعيادات تلقائي عند أول تشغيل
--  الأوامر مفصولة بـ GO
-- =====================================================================
CREATE TABLE Clinics (
  Id              INTEGER PRIMARY KEY AUTOINCREMENT,
  Name            TEXT NOT NULL UNIQUE,
  StoreId         INT NULL REFERENCES Stores(Id),
  SortOrder       INT NOT NULL DEFAULT 0,
  Active          INTEGER NOT NULL DEFAULT 1,
  CreatedAt       DATETIME2 NOT NULL
);

CREATE UNIQUE INDEX UX_Clinics_Store ON Clinics (StoreId) WHERE StoreId IS NOT NULL;

ALTER TABLE Doctors ADD ClinicId INT NULL REFERENCES Clinics(Id);

-- =====================================================================
--  تحديث 017: قايمة وحدات الأصناف (علبة، شريط، سم، متر...)
--  الأصناف بتختار الوحدة من القايمة (من غير كتابة يدوي). القايمة بتتملا تلقائي من الوحدات الموجودة في الأصناف
--  الأوامر مفصولة بـ GO
-- =====================================================================
CREATE TABLE StockUnits (
  Id        INTEGER PRIMARY KEY AUTOINCREMENT,
  Name      TEXT NOT NULL UNIQUE,
  Active    INTEGER NOT NULL DEFAULT 1,
  SortOrder INT NOT NULL DEFAULT 0
);

-- =====================================================================
--  تحديث 018: الأدوار والصلاحيات كبيانات (R1b-2أ)
--  Roles = الدور واسمه. RolePermissions = صلاحيات الدور ('*' = كل الصلاحيات). الأدوار الحالية بتتزرع تلقائي بنفس صلاحياتها بالظبط
--  شلنا قيد CK_Users_Role عشان الأدوار الجديدة تتضاف من غير تعديل قاعدة البيانات
--  الأوامر مفصولة بـ GO
-- =====================================================================

CREATE TABLE Roles (
  Code      TEXT NOT NULL PRIMARY KEY,
  Name      TEXT NOT NULL,
  Description TEXT NULL,
  Color     TEXT NULL,
  Home      TEXT NOT NULL DEFAULT '/',
  IsSystem  INTEGER NOT NULL DEFAULT 0,
  Active    INTEGER NOT NULL DEFAULT 1,
  SortOrder INT NOT NULL DEFAULT 0
);

CREATE TABLE RolePermissions (
  RoleCode TEXT NOT NULL REFERENCES Roles(Code),
  Perm     TEXT NOT NULL,
  PRIMARY KEY (RoleCode, Perm)
);

-- =====================================================================
--  تحديث 019: استثناءات الصلاحيات لكل موظف (R1b-3)
--  Grants (موجودة) = صلاحيات بتتضاف فوق الدور. Denied = صلاحيات بتتشال من الدور. الباقي زي دور الموظف بالظبط
--  الأوامر مفصولة بـ GO. الجزء قبل «@alters» بيشتغل زي ما هو على SQLite كمان
-- =====================================================================
ALTER TABLE Users ADD Denied TEXT NULL;

-- =====================================================================
--  تحديث 020: نصيب الدكتور على الخدمة والعيادة (R1c-share)
--  Services/Clinics: نسبة % أو مبلغ ثابت للوحدة (واحد منهم بس). VisitItems/AdmissionItems.DoctorFixed = المبلغ الثابت وقت التسجيل (0 = مفيش)
--  الأولوية: صف الدكتور (استثناء) > نسبة الخدمة > نسبة العيادة > صفر. الأوامر مفصولة بـ GO
-- =====================================================================
ALTER TABLE Services ADD SharePct NUMERIC NULL;

ALTER TABLE Services ADD ShareFixed NUMERIC NULL;

ALTER TABLE Clinics ADD SharePct NUMERIC NULL;

ALTER TABLE Clinics ADD ShareFixed NUMERIC NULL;

ALTER TABLE VisitItems ADD DoctorFixed NUMERIC NOT NULL DEFAULT 0;

ALTER TABLE AdmissionItems ADD DoctorFixed NUMERIC NOT NULL DEFAULT 0;

-- =====================================================================
--  تحديث 021: قوائم أسعار مستقلة للتعاقدات
--  قايمة باسم (مثلًا «لائحة التأمين 2026») أكتر من جهة تربط بيها (Payers.PriceListId). الجهة اللي من غير قايمة بتفضل بأسعارها الخاصة زي ما هي
--  الأوامر مفصولة بـ GO
-- =====================================================================
CREATE TABLE PriceLists (
  Id        INTEGER PRIMARY KEY AUTOINCREMENT,
  Name      TEXT NOT NULL,
  Active    INTEGER NOT NULL DEFAULT 1,
  CreatedAt TEXT NOT NULL,
  CONSTRAINT UQ_PriceLists_Name UNIQUE (Name)
);

CREATE TABLE PriceListItems (
  Id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ListId    INT NOT NULL REFERENCES PriceLists(Id),
  ServiceId INT NOT NULL REFERENCES Services(Id),
  Price     NUMERIC NOT NULL,
  CONSTRAINT UQ_PriceListItems UNIQUE (ListId, ServiceId),
  CONSTRAINT CK_PriceListItems CHECK (Price >= 0)
);

CREATE TABLE PriceListClassPrices (
  Id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ListId     INT NOT NULL REFERENCES PriceLists(Id),
  ClassId    INT NOT NULL REFERENCES RoomClasses(Id),
  NightPrice NUMERIC NOT NULL,
  CONSTRAINT UQ_PriceListClassPrices UNIQUE (ListId, ClassId),
  CONSTRAINT CK_PriceListClassPrices CHECK (NightPrice >= 0)
);

ALTER TABLE Payers ADD PriceListId INT NULL REFERENCES PriceLists(Id);

-- =====================================================================
--  تحديث 022: اعتماد مستحقات الأطباء (شريحة A)
--  DoctorPayouts: ApprovedAt/ApprovedBy (الاعتماد) و EditedAt/EditedBy/EditNote (آخر تعديل بصلاحية).
--  مفيش حالة جديدة: «مستني الاعتماد» = Status issued ومفيش VoucherId. الأوامر مفصولة بـ GO
-- =====================================================================
ALTER TABLE DoctorPayouts ADD ApprovedAt TEXT NULL;

ALTER TABLE DoctorPayouts ADD ApprovedBy INT NULL REFERENCES Users(Id);

ALTER TABLE DoctorPayouts ADD EditedAt TEXT NULL;

ALTER TABLE DoctorPayouts ADD EditedBy INT NULL REFERENCES Users(Id);

ALTER TABLE DoctorPayouts ADD EditNote TEXT NULL;

-- =====================================================================
--  تحديث 023: دليل الحسابات والقيود اليومية (شريحة B)
--  Accounts: شجرة الحسابات (IsGroup = حساب تجميعي مفيهوش قيود). AccountMap: ربط العمليات بالحسابات (من الإعدادات).
--  JournalEntries/JournalLines: القيد المزدوج. الإلغاء = قيد عكسي (ReversalOf)، مفيش مسح. الأوامر مفصولة بـ GO
-- =====================================================================
CREATE TABLE Accounts (
  Id        INTEGER PRIMARY KEY AUTOINCREMENT,
  Code      TEXT  NOT NULL,
  Name      TEXT NOT NULL,
  Type      TEXT  NOT NULL,
  ParentId  INT           NULL REFERENCES Accounts(Id),
  IsGroup   INTEGER           NOT NULL DEFAULT 0,
  Active    INTEGER           NOT NULL DEFAULT 1,
  SortOrder INT           NOT NULL DEFAULT 0,
  CONSTRAINT UQ_Accounts_Code UNIQUE (Code),
  CONSTRAINT CK_Accounts_Type CHECK (Type IN ('asset','liability','equity','revenue','expense'))
);

CREATE TABLE AccountMap (
  [Key]     TEXT NOT NULL PRIMARY KEY,
  AccountId INT          NOT NULL REFERENCES Accounts(Id)
);

CREATE TABLE JournalEntries (
  Id          INTEGER PRIMARY KEY AUTOINCREMENT,
  EntryNo     INT           NOT NULL,
  EntryDate   TEXT          NOT NULL,
  Source      TEXT  NOT NULL,
  SourceId    INT           NULL,
  Description TEXT NOT NULL,
  Status      TEXT  NOT NULL DEFAULT 'posted',
  ReversalOf  INT           NULL REFERENCES JournalEntries(Id),
  CreatedAt   TEXT  NOT NULL,
  CreatedBy   INT           NOT NULL REFERENCES Users(Id),
  CONSTRAINT UQ_JournalEntries_No UNIQUE (EntryNo),
  CONSTRAINT CK_JournalEntries_Status CHECK (Status IN ('posted','reversed'))
);

CREATE INDEX IX_JournalEntries_Source ON JournalEntries (Source, SourceId);

CREATE INDEX IX_JournalEntries_Date ON JournalEntries (EntryDate);

CREATE TABLE JournalLines (
  Id        INTEGER PRIMARY KEY AUTOINCREMENT,
  EntryId   INT           NOT NULL REFERENCES JournalEntries(Id),
  AccountId INT           NOT NULL REFERENCES Accounts(Id),
  Debit     NUMERIC NOT NULL DEFAULT 0,
  Credit    NUMERIC NOT NULL DEFAULT 0,
  Memo      TEXT NULL
);

CREATE INDEX IX_JournalLines_Entry ON JournalLines (EntryId);

CREATE INDEX IX_JournalLines_Account ON JournalLines (AccountId);

INSERT INTO Counters (Name, Value) VALUES ('jv', 0);

-- =====================================================================
--  تحديث 024: الربط مع منشأة تانية (المستشفى <-> الصفا كاث)
--  Patients.GlobalId = الرقم العالمي للمريض (نفسه في النسختين).
--  PeerOutbox = طابور تعديلات البيانات التعريفية للمربوطين (بيتبعت لما الاتصال يرجع). الأوامر مفصولة بـ GO
-- =====================================================================
ALTER TABLE Patients ADD GlobalId TEXT NULL;

CREATE UNIQUE INDEX UX_Patients_GlobalId ON Patients (GlobalId) WHERE GlobalId IS NOT NULL;

CREATE TABLE PeerOutbox (
  Id         INTEGER PRIMARY KEY AUTOINCREMENT,
  GlobalId   TEXT   NOT NULL,
  Op         TEXT   NOT NULL,          -- update | unlink
  Payload    TEXT  NOT NULL,
  CreatedAt  TEXT   NOT NULL,
  Attempts   INT            NOT NULL DEFAULT 0,
  LastError  TEXT  NULL,
  DoneAt     TEXT   NULL
);

CREATE INDEX IX_PeerOutbox_Pending ON PeerOutbox (DoneAt, Id);

-- =====================================================================
--  تحديث 025: طلبات الخدمات بين المنشأتين وأحداث الانتقال (الصفا كاث)
--  PeerRequests = طلب خدمة جه من المنشأة التانية (بند زيارة عندنا + مين طلبه + حالة التنفيذ).
--  PeerEvents  = أحداث انتقال المريض (راح للمنشأة التانية / رجع منها). الأوامر مفصولة بـ GO
-- =====================================================================
CREATE TABLE PeerRequests (
  Id           INTEGER PRIMARY KEY AUTOINCREMENT,
  GlobalId     TEXT  NOT NULL,
  PatientId    INT           NOT NULL REFERENCES Patients(Id),
  VisitId      INT           NOT NULL REFERENCES Visits(Id),
  VisitItemId  INT           NOT NULL REFERENCES VisitItems(Id),
  FromName     TEXT NULL,           -- المنشأة اللي طلبت
  FromUser     TEXT NULL,           -- الموظف اللي طلب
  Note         TEXT NULL,
  Status       TEXT  NOT NULL DEFAULT 'new',   -- new | done | cancelled
  CreatedAt    TEXT  NOT NULL,
  DoneAt       TEXT  NULL,
  DoneBy       INT           NULL REFERENCES Users(Id),
  CancelReason TEXT NULL
);

CREATE INDEX IX_PeerRequests_Status ON PeerRequests (Status, Id);

CREATE INDEX IX_PeerRequests_Global ON PeerRequests (GlobalId);

CREATE TABLE PeerEvents (
  Id         INTEGER PRIMARY KEY AUTOINCREMENT,
  GlobalId   TEXT  NOT NULL,
  PatientId  INT           NOT NULL REFERENCES Patients(Id),
  Kind       TEXT  NOT NULL,           -- to_peer (راح للمنشأة التانية) | from_peer (رجع منها)
  Origin     TEXT   NOT NULL,           -- local | remote
  At         TEXT  NOT NULL,
  ByName     TEXT NULL,
  Note       TEXT NULL
);

CREATE INDEX IX_PeerEvents_Patient ON PeerEvents (PatientId, Id);

-- =====================================================================
--  تحديث 026: تجهيز الإيصال/الفاتورة الإلكترونية (مصلحة الضرايب)
--  EtaDocs = مستند إلكتروني لكل إيصال (الحالة، الـ JSON اللي هيتبعت، رد المنظومة، المحاولات). الأوامر مفصولة بـ GO
-- =====================================================================
CREATE TABLE EtaDocs (
  Id          INTEGER PRIMARY KEY AUTOINCREMENT,
  Kind        TEXT  NOT NULL,            -- receipt (إيصال) | invoice (فاتورة شركة، مرحلة لاحقة)
  ReceiptId   INT           NOT NULL REFERENCES Receipts(Id),
  Uuid        TEXT  NOT NULL,
  Status      TEXT  NOT NULL,            -- incomplete | ready | submitted | accepted | rejected | failed | skipped
  Env         TEXT   NOT NULL,            -- sim | preprod | prod
  Payload     TEXT NULL,
  Response    TEXT NULL,
  Message     TEXT NULL,
  Attempts    INT           NOT NULL DEFAULT 0,
  CreatedAt   TEXT  NOT NULL,
  SubmittedAt TEXT  NULL
);

CREATE UNIQUE INDEX UX_EtaDocs_Receipt ON EtaDocs (ReceiptId, Kind);

CREATE INDEX IX_EtaDocs_Status ON EtaDocs (Status, Id);
