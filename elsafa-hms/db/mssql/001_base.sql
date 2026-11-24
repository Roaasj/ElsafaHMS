-- =====================================================================
--  نظام إدارة مستشفى الصفا - قاعدة ElsafaHMS
--  المرحلة الأولى / الشريحة 1: المستخدمين، المرضى، الخدمات، الأطباء،
--  الزيارات الخارجية، الخزينة والإيصالات
--  يتشغل على قاعدة فاضية اسمها ElsafaHMS (npm run db:init بيعمل كده)
--  منفصلة تمامًا عن قاعدة البرنامج القديم
-- =====================================================================

CREATE TABLE Users (
  Id            INT IDENTITY(1,1) PRIMARY KEY,
  Username      NVARCHAR(50)  NOT NULL,
  FullName      NVARCHAR(120) NOT NULL,
  PasswordHash  NVARCHAR(100) NOT NULL,
  Role          NVARCHAR(30)  NOT NULL,      -- reception | supervisor | reviewer | manager
  Active        BIT           NOT NULL DEFAULT 1,
  CreatedAt     DATETIME2(0)  NOT NULL,
  LastLoginAt   DATETIME2(0)  NULL,
  CONSTRAINT UQ_Users_Username UNIQUE (Username),
  CONSTRAINT CK_Users_Role CHECK (Role IN ('reception','supervisor','reviewer','manager'))
);

CREATE TABLE Sessions (
  Id          INT IDENTITY(1,1) PRIMARY KEY,
  TokenHash   CHAR(64)     NOT NULL,
  UserId      INT          NOT NULL REFERENCES Users(Id),
  CreatedAt   DATETIME2(0) NOT NULL,
  ExpiresAt   DATETIME2(0) NOT NULL,
  LastSeenAt  DATETIME2(0) NOT NULL,
  CONSTRAINT UQ_Sessions_Token UNIQUE (TokenHash)
);

CREATE TABLE AuditLog (
  Id        INT IDENTITY(1,1) PRIMARY KEY,
  At        DATETIME2(0)  NOT NULL,
  UserId    INT           NULL REFERENCES Users(Id),
  Action    NVARCHAR(50)  NOT NULL,
  Entity    NVARCHAR(30)  NOT NULL,
  EntityId  INT           NULL,
  OldValue  NVARCHAR(MAX) NULL,
  NewValue  NVARCHAR(MAX) NULL,
  Note      NVARCHAR(400) NULL
);
CREATE INDEX IX_AuditLog_Entity ON AuditLog (Entity, EntityId);
CREATE INDEX IX_AuditLog_At ON AuditLog (At);

-- عدادات الترقيم المتسلسل (رقم الملف، رقم الزيارة، رقم الإيصال)
CREATE TABLE Counters (
  Name   NVARCHAR(30) NOT NULL PRIMARY KEY,
  Value  INT          NOT NULL
);
INSERT INTO Counters (Name, Value) VALUES (N'patient', 0), (N'visit', 0), (N'receipt', 0);

CREATE TABLE Patients (
  Id              INT IDENTITY(1,1) PRIMARY KEY,
  PatientNo       INT            NOT NULL,
  FullName        NVARCHAR(150)  NOT NULL,
  SearchKey       NVARCHAR(150)  NOT NULL,
  Phone           NVARCHAR(20)   NULL,
  BirthDate       DATE           NULL,
  AgeYears        INT            NULL,
  AgeRecordedAt   DATETIME2(0)   NULL,
  Sex             CHAR(1)        NULL,
  NationalId      CHAR(14)       NULL,
  Address         NVARCHAR(250)  NULL,
  EmergencyName   NVARCHAR(120)  NULL,
  EmergencyPhone  NVARCHAR(20)   NULL,
  Notes           NVARCHAR(500)  NULL,
  Incomplete      BIT            NOT NULL DEFAULT 0,   -- اتفتح بالاسم بس (طوارئ)
  CreatedAt       DATETIME2(0)   NOT NULL,
  CreatedBy       INT            NOT NULL REFERENCES Users(Id),
  UpdatedAt       DATETIME2(0)   NULL,
  UpdatedBy       INT            NULL REFERENCES Users(Id),
  CONSTRAINT UQ_Patients_No UNIQUE (PatientNo),
  CONSTRAINT CK_Patients_Sex CHECK (Sex IN ('M','F'))
);
CREATE INDEX IX_Patients_SearchKey ON Patients (SearchKey);
CREATE INDEX IX_Patients_Phone ON Patients (Phone);
CREATE UNIQUE INDEX UX_Patients_NationalId ON Patients (NationalId) WHERE NationalId IS NOT NULL;

CREATE TABLE PatientEdits (
  Id         INT IDENTITY(1,1) PRIMARY KEY,
  PatientId  INT           NOT NULL REFERENCES Patients(Id),
  At         DATETIME2(0)  NOT NULL,
  UserId     INT           NOT NULL REFERENCES Users(Id),
  Field      NVARCHAR(40)  NOT NULL,
  OldValue   NVARCHAR(500) NULL,
  NewValue   NVARCHAR(500) NULL
);
CREATE INDEX IX_PatientEdits_Patient ON PatientEdits (PatientId);

CREATE TABLE Services (
  Id         INT IDENTITY(1,1) PRIMARY KEY,
  Code       NVARCHAR(30)  NOT NULL,
  Name       NVARCHAR(150) NOT NULL,
  SearchKey  NVARCHAR(150) NOT NULL,
  Dept       NVARCHAR(20)  NOT NULL,     -- clinic | emergency | lab | radiology
  PayTiming  NVARCHAR(10)  NOT NULL,     -- before | after
  HasDoctor  BIT           NOT NULL DEFAULT 0,
  Quick      BIT           NOT NULL DEFAULT 0,  -- يظهر كزرار سريع
  SortOrder  INT           NOT NULL DEFAULT 0,
  Active     BIT           NOT NULL DEFAULT 1,
  CreatedAt  DATETIME2(0)  NOT NULL,
  CONSTRAINT UQ_Services_Code UNIQUE (Code),
  CONSTRAINT CK_Services_Dept CHECK (Dept IN ('clinic','emergency','lab','radiology')),
  CONSTRAINT CK_Services_Pay CHECK (PayTiming IN ('before','after'))
);

-- الأسعار بالسريان: كل تغيير سعر سطر جديد بتاريخه
CREATE TABLE ServicePrices (
  Id             INT IDENTITY(1,1) PRIMARY KEY,
  ServiceId      INT            NOT NULL REFERENCES Services(Id),
  Price          DECIMAL(12,2)  NOT NULL,
  EffectiveFrom  DATETIME2(0)   NOT NULL,
  ChangedBy      INT            NULL REFERENCES Users(Id),
  CONSTRAINT UQ_ServicePrices UNIQUE (ServiceId, EffectiveFrom),
  CONSTRAINT CK_ServicePrices_Price CHECK (Price >= 0)
);

-- الأطباء (مؤقتًا هنا، ولما نربط بجدول اليوم المصدر يتغير بس)
CREATE TABLE Doctors (
  Id         INT IDENTITY(1,1) PRIMARY KEY,
  Name       NVARCHAR(120) NOT NULL,
  Specialty  NVARCHAR(80)  NULL,
  ExternalRef NVARCHAR(60) NULL,          -- رقم الدكتور في جدول اليوم (للربط)
  Active     BIT           NOT NULL DEFAULT 1
);

CREATE TABLE DoctorSchedule (
  Id        INT IDENTITY(1,1) PRIMARY KEY,
  DoctorId  INT         NOT NULL REFERENCES Doctors(Id),
  Weekday   TINYINT     NOT NULL,          -- 0=السبت ... 6=الجمعة
  FromTime  CHAR(5)     NOT NULL,          -- HH:MM
  ToTime    CHAR(5)     NOT NULL
);
CREATE INDEX IX_DoctorSchedule ON DoctorSchedule (Weekday, DoctorId);

-- نسب الأطباء: خدمة محددة > قسم > نسبة عامة
CREATE TABLE DoctorShares (
  Id         INT IDENTITY(1,1) PRIMARY KEY,
  DoctorId   INT           NOT NULL REFERENCES Doctors(Id),
  ServiceId  INT           NULL REFERENCES Services(Id),
  Dept       NVARCHAR(20)  NULL,
  Pct        DECIMAL(5,2)  NOT NULL,
  CONSTRAINT CK_DoctorShares_Pct CHECK (Pct >= 0 AND Pct <= 100)
);
CREATE INDEX IX_DoctorShares ON DoctorShares (DoctorId);

CREATE TABLE Shifts (
  Id        INT IDENTITY(1,1) PRIMARY KEY,
  UserId    INT          NOT NULL REFERENCES Users(Id),
  OpenedAt  DATETIME2(0) NOT NULL,
  ClosedAt  DATETIME2(0) NULL
);
CREATE INDEX IX_Shifts_User ON Shifts (UserId, ClosedAt);

CREATE TABLE Visits (
  Id         INT IDENTITY(1,1) PRIMARY KEY,
  VisitNo    INT           NOT NULL,
  PatientId  INT           NOT NULL REFERENCES Patients(Id),
  Type       NVARCHAR(20)  NOT NULL,       -- clinic | emergency | lab | radiology
  Status     NVARCHAR(10)  NOT NULL,       -- open | closed
  OpenedAt   DATETIME2(0)  NOT NULL,
  OpenedBy   INT           NOT NULL REFERENCES Users(Id),
  ClosedAt   DATETIME2(0)  NULL,
  ClosedBy   INT           NULL REFERENCES Users(Id),
  Notes      NVARCHAR(400) NULL,
  CONSTRAINT UQ_Visits_No UNIQUE (VisitNo),
  CONSTRAINT CK_Visits_Type CHECK (Type IN ('clinic','emergency','lab','radiology')),
  CONSTRAINT CK_Visits_Status CHECK (Status IN ('open','closed'))
);
CREATE INDEX IX_Visits_Patient ON Visits (PatientId);
CREATE INDEX IX_Visits_Status ON Visits (Status, OpenedAt);

CREATE TABLE Receipts (
  Id                  INT IDENTITY(1,1) PRIMARY KEY,
  ReceiptNo           INT            NOT NULL,
  Kind                NVARCHAR(10)   NOT NULL,   -- payment | refund (المرتجع بالسالب)
  VisitId             INT            NOT NULL REFERENCES Visits(Id),
  PatientId           INT            NOT NULL REFERENCES Patients(Id),
  ShiftId             INT            NOT NULL REFERENCES Shifts(Id),
  Gross               DECIMAL(12,2)  NOT NULL,
  Discount            DECIMAL(12,2)  NOT NULL,
  Net                 DECIMAL(12,2)  NOT NULL,
  Cash                DECIMAL(12,2)  NOT NULL,
  Card                DECIMAL(12,2)  NOT NULL,
  Credit              DECIMAL(12,2)  NOT NULL,   -- آجل
  DiscountReason      NVARCHAR(300)  NULL,
  DiscountApprovedBy  INT            NULL REFERENCES Users(Id),
  CreditApprovedBy    INT            NULL REFERENCES Users(Id),
  ReversesReceiptId   INT            NULL REFERENCES Receipts(Id),
  ReversedByReceiptId INT            NULL REFERENCES Receipts(Id),
  Reason              NVARCHAR(300)  NULL,       -- سبب الإلغاء
  PrintCount          INT            NOT NULL DEFAULT 0,
  CreatedAt           DATETIME2(0)   NOT NULL,
  CreatedBy           INT            NOT NULL REFERENCES Users(Id),
  CONSTRAINT UQ_Receipts_No UNIQUE (ReceiptNo),
  CONSTRAINT CK_Receipts_Kind CHECK (Kind IN ('payment','refund')),
  CONSTRAINT CK_Receipts_Balance CHECK (Cash + Card + Credit = Net AND Gross - Discount = Net)
);
CREATE INDEX IX_Receipts_Visit ON Receipts (VisitId);
CREATE INDEX IX_Receipts_Shift ON Receipts (ShiftId);
CREATE INDEX IX_Receipts_CreatedAt ON Receipts (CreatedAt);

CREATE TABLE VisitItems (
  Id             INT IDENTITY(1,1) PRIMARY KEY,
  VisitId        INT            NOT NULL REFERENCES Visits(Id),
  ServiceId      INT            NOT NULL REFERENCES Services(Id),
  ServiceName    NVARCHAR(150)  NOT NULL,   -- نسخة وقت التسجيل
  Dept           NVARCHAR(20)   NOT NULL,
  DoctorId       INT            NULL REFERENCES Doctors(Id),
  Qty            INT            NOT NULL,
  UnitPrice      DECIMAL(12,2)  NOT NULL,   -- السعر وقت التسجيل
  Amount         DECIMAL(12,2)  NOT NULL,
  PayTiming      NVARCHAR(10)   NOT NULL,
  DoctorPct      DECIMAL(5,2)   NOT NULL DEFAULT 0,  -- النسبة وقت التسجيل
  Status         NVARCHAR(10)   NOT NULL,   -- active | voided
  PaidReceiptId  INT            NULL REFERENCES Receipts(Id),
  AddedAt        DATETIME2(0)   NOT NULL,
  AddedBy        INT            NOT NULL REFERENCES Users(Id),
  VoidedAt       DATETIME2(0)   NULL,
  VoidedBy       INT            NULL REFERENCES Users(Id),
  VoidReason     NVARCHAR(300)  NULL,
  CONSTRAINT CK_VisitItems_Status CHECK (Status IN ('active','voided')),
  CONSTRAINT CK_VisitItems_Qty CHECK (Qty > 0)
);
CREATE INDEX IX_VisitItems_Visit ON VisitItems (VisitId);

CREATE TABLE ReceiptLines (
  Id             INT IDENTITY(1,1) PRIMARY KEY,
  ReceiptId      INT            NOT NULL REFERENCES Receipts(Id),
  VisitItemId    INT            NOT NULL REFERENCES VisitItems(Id),
  Description    NVARCHAR(200)  NOT NULL,
  Qty            INT            NOT NULL,
  UnitPrice      DECIMAL(12,2)  NOT NULL,
  Amount         DECIMAL(12,2)  NOT NULL,
  DiscountShare  DECIMAL(12,2)  NOT NULL
);
CREATE INDEX IX_ReceiptLines_Receipt ON ReceiptLines (ReceiptId);

-- مستحقات الأطباء: سطر لكل بند مدفوع، والإلغاء بسطر بالسالب
CREATE TABLE DoctorEarnings (
  Id           INT IDENTITY(1,1) PRIMARY KEY,
  VisitItemId  INT            NOT NULL REFERENCES VisitItems(Id),
  DoctorId     INT            NOT NULL REFERENCES Doctors(Id),
  ReceiptId    INT            NOT NULL REFERENCES Receipts(Id),
  BaseAmount   DECIMAL(12,2)  NOT NULL,
  Pct          DECIMAL(5,2)   NOT NULL,
  Amount       DECIMAL(12,2)  NOT NULL,
  CreatedAt    DATETIME2(0)   NOT NULL
);
CREATE INDEX IX_DoctorEarnings_Doctor ON DoctorEarnings (DoctorId, CreatedAt);
