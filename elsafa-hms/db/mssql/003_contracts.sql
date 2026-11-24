-- =====================================================================
--  تحديث 003: التعاقدات ومستويات الكارنيه والموافقات وحساب الجهات
--  الأوامر مفصولة بـ GO. الأوامر دي بتشتغل زي ما هي على SQLite كمان (نسخة التجربة)
-- =====================================================================

-- جهة التعاقد. PriceMode: cash = أسعار المستشفى ، list = قايمة أسعار خاصة ، discount = خصم ثابت على أسعار المستشفى
CREATE TABLE Payers (
  Id            INT IDENTITY(1,1) PRIMARY KEY,
  Name          NVARCHAR(120)  NOT NULL,
  Kind          NVARCHAR(30)   NULL,
  ContactName   NVARCHAR(120)  NULL,
  ContactPhone  NVARCHAR(30)   NULL,
  ValidFrom     DATE           NULL,
  ValidTo       DATE           NULL,
  PriceMode     NVARCHAR(10)   NOT NULL DEFAULT 'cash',
  DiscountPct   DECIMAL(5,2)   NULL,
  RequiredDocs  NVARCHAR(300)  NULL,
  VisitCap      DECIMAL(12,2)  NULL,
  YearCap       DECIMAL(12,2)  NULL,
  Notes         NVARCHAR(500)  NULL,
  Active        BIT            NOT NULL DEFAULT 1,
  CreatedAt     DATETIME2(0)   NOT NULL,
  CONSTRAINT UQ_Payers_Name UNIQUE (Name),
  CONSTRAINT CK_Payers_PriceMode CHECK (PriceMode IN ('cash','list','discount')),
  CONSTRAINT CK_Payers_Discount CHECK (DiscountPct IS NULL OR (DiscountPct >= 0 AND DiscountPct <= 100))
);
GO
-- مستويات الكارنيه
CREATE TABLE PayerTiers (
  Id         INT IDENTITY(1,1) PRIMARY KEY,
  PayerId    INT           NOT NULL REFERENCES Payers(Id),
  Name       NVARCHAR(60)  NOT NULL,
  SortOrder  INT           NOT NULL DEFAULT 0,
  Active     BIT           NOT NULL DEFAULT 1,
  CONSTRAINT UQ_PayerTiers UNIQUE (PayerId, Name)
);
GO
-- نسبة تحمّل الشركة لكل قسم خدمات (clinic, emergency, lab, radiology, ward, or)
CREATE TABLE TierCoverage (
  Id      INT IDENTITY(1,1) PRIMARY KEY,
  TierId  INT           NOT NULL REFERENCES PayerTiers(Id),
  Dept    NVARCHAR(20)  NOT NULL,
  Pct     DECIMAL(5,2)  NOT NULL,
  CONSTRAINT UQ_TierCoverage UNIQUE (TierId, Dept),
  CONSTRAINT CK_TierCoverage_Pct CHECK (Pct >= 0 AND Pct <= 100)
);
GO
CREATE TABLE PayerPrices (
  Id         INT IDENTITY(1,1) PRIMARY KEY,
  PayerId    INT            NOT NULL REFERENCES Payers(Id),
  ServiceId  INT            NOT NULL REFERENCES Services(Id),
  Price      DECIMAL(12,2)  NOT NULL,
  CONSTRAINT UQ_PayerPrices UNIQUE (PayerId, ServiceId),
  CONSTRAINT CK_PayerPrices CHECK (Price >= 0)
);
GO
CREATE TABLE PayerClassPrices (
  Id          INT IDENTITY(1,1) PRIMARY KEY,
  PayerId     INT            NOT NULL REFERENCES Payers(Id),
  ClassId     INT            NOT NULL REFERENCES RoomClasses(Id),
  NightPrice  DECIMAL(12,2)  NOT NULL,
  CONSTRAINT UQ_PayerClassPrices UNIQUE (PayerId, ClassId),
  CONSTRAINT CK_PayerClassPrices CHECK (NightPrice >= 0)
);
GO
-- excluded = مش مغطاة ، approval = محتاجة موافقة مسبقة
CREATE TABLE PayerRules (
  Id         INT IDENTITY(1,1) PRIMARY KEY,
  PayerId    INT           NOT NULL REFERENCES Payers(Id),
  ServiceId  INT           NOT NULL REFERENCES Services(Id),
  [Rule]     NVARCHAR(10)  NOT NULL,
  CONSTRAINT UQ_PayerRules UNIQUE (PayerId, ServiceId),
  CONSTRAINT CK_PayerRules CHECK ([Rule] IN ('excluded','approval'))
);
GO
-- الموافقات: pending مستنية المراجعة ، tempcash نقدي مؤقت (لسه مفيش موافقة) ، approved ، rejected ، cancelled
CREATE TABLE Approvals (
  Id               INT IDENTITY(1,1) PRIMARY KEY,
  Scope            NVARCHAR(10)   NOT NULL,
  PayerId          INT            NOT NULL REFERENCES Payers(Id),
  PatientId        INT            NOT NULL REFERENCES Patients(Id),
  VisitItemId      INT            NULL REFERENCES VisitItems(Id),
  AdmissionItemId  INT            NULL REFERENCES AdmissionItems(Id),
  AdmissionId      INT            NULL REFERENCES Admissions(Id),
  ApprovalNo       NVARCHAR(60)   NULL,
  ApprovalDate     DATE           NULL,
  ImageFile        NVARCHAR(100)  NULL,
  Status           NVARCHAR(10)   NOT NULL,
  Amount           DECIMAL(12,2)  NOT NULL DEFAULT 0,
  Note             NVARCHAR(300)  NULL,
  CreatedAt        DATETIME2(0)   NOT NULL,
  CreatedBy        INT            NOT NULL REFERENCES Users(Id),
  ReviewedAt       DATETIME2(0)   NULL,
  ReviewedBy       INT            NULL REFERENCES Users(Id),
  ReviewNote       NVARCHAR(300)  NULL,
  CONSTRAINT CK_Approvals_Scope CHECK (Scope IN ('item','admission')),
  CONSTRAINT CK_Approvals_Status CHECK (Status IN ('pending','tempcash','approved','rejected','cancelled'))
);
GO
CREATE INDEX IX_Approvals_Status ON Approvals (Status, CreatedAt);
GO
-- حساب الجهات: كل نصيب شركة اتأكد (charge بالموجب، والإلغاء بالسالب) = أساس المطالبة الشهرية
CREATE TABLE PayerLedger (
  Id               INT IDENTITY(1,1) PRIMARY KEY,
  PayerId          INT            NOT NULL REFERENCES Payers(Id),
  PatientId        INT            NOT NULL REFERENCES Patients(Id),
  VisitItemId      INT            NULL REFERENCES VisitItems(Id),
  AdmissionItemId  INT            NULL REFERENCES AdmissionItems(Id),
  ReceiptId        INT            NULL REFERENCES Receipts(Id),
  ApprovalId       INT            NULL REFERENCES Approvals(Id),
  Description      NVARCHAR(200)  NOT NULL,
  CardNo           NVARCHAR(60)   NULL,
  FullAmount       DECIMAL(12,2)  NOT NULL,
  Amount           DECIMAL(12,2)  NOT NULL,
  ReversesId       INT            NULL,
  At               DATETIME2(0)   NOT NULL,
  CreatedBy        INT            NOT NULL REFERENCES Users(Id)
);
GO
CREATE INDEX IX_PayerLedger ON PayerLedger (PayerId, At);
GO

-- تعاقد المريض الافتراضي، وتعاقد كل زيارة ودخول
ALTER TABLE Patients ADD PayerId INT NULL REFERENCES Payers(Id);
GO
ALTER TABLE Patients ADD TierId INT NULL REFERENCES PayerTiers(Id);
GO
ALTER TABLE Patients ADD CardNo NVARCHAR(60) NULL;
GO
ALTER TABLE Visits ADD PayerId INT NULL REFERENCES Payers(Id);
GO
ALTER TABLE Visits ADD TierId INT NULL REFERENCES PayerTiers(Id);
GO
ALTER TABLE Visits ADD CardNo NVARCHAR(60) NULL;
GO
ALTER TABLE Admissions ADD PayerId INT NULL REFERENCES Payers(Id);
GO
ALTER TABLE Admissions ADD TierId INT NULL REFERENCES PayerTiers(Id);
GO
ALTER TABLE Admissions ADD CardNo NVARCHAR(60) NULL;
GO
-- ok = التعاقد شغال ، rejected = موافقة الدخول اترفضت والحساب اتحول نقدي
ALTER TABLE Admissions ADD PayerStatus NVARCHAR(10) NULL;
GO

-- نصيب الشركة ونصيب المريض لكل بند. CoverStatus: none ، covered ، excluded ، pending ، tempcash ، approved ، rejected
ALTER TABLE VisitItems ADD PayerPct DECIMAL(5,2) NOT NULL DEFAULT 0;
GO
ALTER TABLE VisitItems ADD PayerAmount DECIMAL(12,2) NOT NULL DEFAULT 0;
GO
ALTER TABLE VisitItems ADD PatientAmount DECIMAL(12,2) NULL;
GO
ALTER TABLE VisitItems ADD CoverStatus NVARCHAR(10) NOT NULL DEFAULT 'none';
GO
ALTER TABLE VisitItems ADD RefundDue DECIMAL(12,2) NOT NULL DEFAULT 0;
GO
UPDATE VisitItems SET PatientAmount = Amount;
GO
ALTER TABLE AdmissionItems ADD PayerPct DECIMAL(5,2) NOT NULL DEFAULT 0;
GO
ALTER TABLE AdmissionItems ADD PayerAmount DECIMAL(12,2) NOT NULL DEFAULT 0;
GO
ALTER TABLE AdmissionItems ADD PatientAmount DECIMAL(12,2) NULL;
GO
ALTER TABLE AdmissionItems ADD CoverStatus NVARCHAR(10) NOT NULL DEFAULT 'none';
GO
UPDATE AdmissionItems SET PatientAmount = Amount;
GO
ALTER TABLE ReceiptLines ADD PayerAmount DECIMAL(12,2) NOT NULL DEFAULT 0;
GO
ALTER TABLE DoctorEarnings ADD PayerPart DECIMAL(12,2) NOT NULL DEFAULT 0;
GO
