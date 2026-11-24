-- =====================================================================
--  تحديث 011: حسابات التعاقدات — مراجعة الحالات، المطالبة الشهرية (Cover + تفصيلي)، الشيكات والمرفوضات
--  الأوامر مفصولة بـ GO. الجزء قبل «@alters» بيشتغل زي ما هو على SQLite كمان
-- =====================================================================

-- التشخيص بيكتبه الاستقبال وقت التسجيل (بيطلع في المطالبة)
ALTER TABLE Visits ADD Diagnosis NVARCHAR(300) NULL;
GO
ALTER TABLE Admissions ADD Diagnosis NVARCHAR(300) NULL;
GO
-- الحالة = زيارة أو دخول على جهة. Period = شهر المطالبة (yyyy-mm): الخارجي بشهر الزيارة والداخلي بشهر الخروج، والتأجيل بيغيّره
-- Status: pending مستنية المراجعة | ok اتراجعت | note فيها ملاحظة (بترجع للاستقبال)
CREATE TABLE ClaimCases (
  Id           INT IDENTITY(1,1) PRIMARY KEY,
  PayerId      INT            NOT NULL REFERENCES Payers(Id),
  Kind         NVARCHAR(10)   NOT NULL,
  VisitId      INT            NULL REFERENCES Visits(Id),
  AdmissionId  INT            NULL REFERENCES Admissions(Id),
  PatientId    INT            NOT NULL REFERENCES Patients(Id),
  Period       NVARCHAR(7)    NOT NULL,
  BasePeriod   NVARCHAR(7)    NOT NULL,
  Status       NVARCHAR(10)   NOT NULL,
  Note         NVARCHAR(500)  NULL,
  NoteBy       INT            NULL REFERENCES Users(Id),
  NoteAt       DATETIME2(0)   NULL,
  FixedBy      INT            NULL REFERENCES Users(Id),
  FixedAt      DATETIME2(0)   NULL,
  ReviewedBy   INT            NULL REFERENCES Users(Id),
  ReviewedAt   DATETIME2(0)   NULL,
  CreatedAt    DATETIME2(0)   NOT NULL,
  CONSTRAINT CK_ClaimCases_Kind CHECK (Kind IN ('visit','admission')),
  CONSTRAINT CK_ClaimCases_Status CHECK (Status IN ('pending','ok','note'))
);
GO
CREATE UNIQUE INDEX UX_ClaimCases_Visit ON ClaimCases (VisitId) WHERE VisitId IS NOT NULL;
GO
CREATE UNIQUE INDEX UX_ClaimCases_Adm ON ClaimCases (AdmissionId) WHERE AdmissionId IS NOT NULL;
GO
CREATE INDEX IX_ClaimCases_Period ON ClaimCases (PayerId, Period);
GO
-- مستندات الحالة (روشتة، تقرير، صورة كارنيه…)
CREATE TABLE ClaimCaseFiles (
  Id         INT IDENTITY(1,1) PRIMARY KEY,
  CaseId     INT            NOT NULL REFERENCES ClaimCases(Id),
  FileName   NVARCHAR(100)  NOT NULL,
  Label      NVARCHAR(100)  NULL,
  CreatedAt  DATETIME2(0)   NOT NULL,
  CreatedBy  INT            NOT NULL REFERENCES Users(Id)
);
GO
-- المطالبة: draft مسودة (بتتحدث لوحدها) ← sent اتبعتت (مقفولة) ← partial اتدفع جزء ← closed خلصت
CREATE TABLE Claims (
  Id           INT IDENTITY(1,1) PRIMARY KEY,
  ClaimNo      INT            NOT NULL,
  PayerId      INT            NOT NULL REFERENCES Payers(Id),
  Period       NVARCHAR(7)    NOT NULL,
  IssueDate    DATE           NULL,
  Status       NVARCHAR(10)   NOT NULL,
  Total        DECIMAL(14,2)  NOT NULL DEFAULT 0,
  Paid         DECIMAL(14,2)  NOT NULL DEFAULT 0,
  Rejected     DECIMAL(14,2)  NOT NULL DEFAULT 0,
  Note         NVARCHAR(300)  NULL,
  CreatedAt    DATETIME2(0)   NOT NULL,
  CreatedBy    INT            NOT NULL REFERENCES Users(Id),
  SentAt       DATETIME2(0)   NULL,
  SentBy       INT            NULL REFERENCES Users(Id),
  ReopenCount  INT            NOT NULL DEFAULT 0,
  CONSTRAINT UQ_Claims_No UNIQUE (ClaimNo),
  CONSTRAINT CK_Claims_Status CHECK (Status IN ('draft','sent','partial','closed'))
);
GO
CREATE INDEX IX_Claims_Payer ON Claims (PayerId, Period);
GO
-- سطور المطالبة: نسخة من نصيب الشركة في كل بند بتاريخ الخدمة (الفرق بعد المطالبة بيروح للمطالبة اللي بعدها)
CREATE TABLE ClaimLines (
  Id               INT IDENTITY(1,1) PRIMARY KEY,
  ClaimId          INT            NOT NULL REFERENCES Claims(Id),
  CaseId           INT            NOT NULL REFERENCES ClaimCases(Id),
  VisitItemId      INT            NULL REFERENCES VisitItems(Id),
  AdmissionItemId  INT            NULL REFERENCES AdmissionItems(Id),
  ServiceDate      DATE           NULL,
  Description      NVARCHAR(200)  NOT NULL,
  Qty              INT            NOT NULL DEFAULT 1,
  FullAmount       DECIMAL(12,2)  NOT NULL DEFAULT 0,
  Amount           DECIMAL(12,2)  NOT NULL,
  Rejected         DECIMAL(12,2)  NOT NULL DEFAULT 0,
  RejectReason     NVARCHAR(200)  NULL
);
GO
CREATE INDEX IX_ClaimLines_Claim ON ClaimLines (ClaimId);
GO
-- الشيكات (ممكن أكتر من شيك للمطالبة)
CREATE TABLE ClaimPayments (
  Id          INT IDENTITY(1,1) PRIMARY KEY,
  ClaimId     INT            NOT NULL REFERENCES Claims(Id),
  ChequeNo    NVARCHAR(40)   NOT NULL,
  Bank        NVARCHAR(80)   NULL,
  ChequeDate  DATE           NULL,
  Amount      DECIMAL(14,2)  NOT NULL,
  Note        NVARCHAR(300)  NULL,
  CreatedAt   DATETIME2(0)   NOT NULL,
  CreatedBy   INT            NOT NULL REFERENCES Users(Id)
);
GO
INSERT INTO Counters (Name, Value) VALUES (N'claim', 0);
GO
-- @alters (SQL Server بس: دور «حسابات التعاقدات»)
ALTER TABLE Users DROP CONSTRAINT CK_Users_Role;
GO
ALTER TABLE Users ADD CONSTRAINT CK_Users_Role CHECK (Role IN ('reception','supervisor','reviewer','manager','cashier','radiology','lab','accounts','accsuper','storekeeper','storeacc','pharmacist','nurse','claims'));
GO
