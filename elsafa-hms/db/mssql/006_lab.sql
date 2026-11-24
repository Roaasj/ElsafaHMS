-- =====================================================================
--  تحديث 006: المعمل (التحاليل وبنودها والمعدلات، العينات، النتايج، المعامل الخارجية)
--  الأوامر مفصولة بـ GO. الجزء قبل «@alters» بيشتغل زي ما هو على SQLite كمان
-- =====================================================================

-- تعريف التحليل (قالب النتيجة). ServiceId = الخدمة اللي بتتدفع في الاستقبال
CREATE TABLE LabTests (
  Id          INT IDENTITY(1,1) PRIMARY KEY,
  Code        NVARCHAR(30)   NOT NULL,
  Name        NVARCHAR(150)  NOT NULL,          -- الاسم في التقرير (إنجليزي غالبًا)
  ArName      NVARCHAR(150)  NULL,
  ServiceId   INT            NULL REFERENCES Services(Id),
  Keywords    NVARCHAR(300)  NULL,              -- كلمات لربط الخدمة بالتحليل لوحدها
  Section     NVARCHAR(40)   NOT NULL,          -- hematology | chemistry | hormones | serology | urine | stool | coagulation | other
  Sample      NVARCHAR(20)   NOT NULL,          -- blood | serum | urine | stool | swab | other
  Tube        NVARCHAR(30)   NULL,
  Hours       INT            NOT NULL DEFAULT 2,
  [External]  BIT            NOT NULL DEFAULT 0, -- كلمة محجوزة في T-SQL: لازم الأقواس دايمًا
  ExternalLab NVARCHAR(120)  NULL,
  Comment     NVARCHAR(400)  NULL,
  SortOrder   INT            NOT NULL DEFAULT 0,
  Active      BIT            NOT NULL DEFAULT 1,
  CreatedAt   DATETIME2(0)   NOT NULL,
  UpdatedAt   DATETIME2(0)   NULL,
  CONSTRAINT UQ_LabTests_Code UNIQUE (Code)
);
GO
-- بنود التحليل. Kind: num رقم ، text نص ، select اختيار ، header عنوان. Ranges = JSON بالمعدلات حسب النوع والسن
CREATE TABLE LabParams (
  Id         INT IDENTITY(1,1) PRIMARY KEY,
  TestId     INT            NOT NULL REFERENCES LabTests(Id),
  Name       NVARCHAR(120)  NOT NULL,
  Unit       NVARCHAR(40)   NULL,
  Kind       NVARCHAR(10)   NOT NULL DEFAULT 'num',
  Options    NVARCHAR(300)  NULL,
  NormalText NVARCHAR(100)  NULL,
  Decimals   INT            NULL,
  Ranges     NVARCHAR(MAX)  NULL,
  RefText    NVARCHAR(200)  NULL,
  SortOrder  INT            NOT NULL DEFAULT 0,
  Active     BIT            NOT NULL DEFAULT 1
);
GO
CREATE INDEX IX_LabParams_Test ON LabParams (TestId, SortOrder);
GO
-- شغل المعمل: سطر لكل تحليل اتطلب (زيارة أو دخول) أول ما المعمل يلمسه
-- Status: waiting مستني السحب ، collected اتسحبت ، done النتيجة اتكتبت ، sent اتبعت بره ، verified جاهزة ، delivered اتسلّمت
CREATE TABLE LabWork (
  Id               INT IDENTITY(1,1) PRIMARY KEY,
  AccNo            INT            NULL,
  PatientId        INT            NOT NULL REFERENCES Patients(Id),
  VisitItemId      INT            NULL REFERENCES VisitItems(Id),
  AdmissionItemId  INT            NULL REFERENCES AdmissionItems(Id),
  TestId           INT            NULL REFERENCES LabTests(Id),
  ServiceName      NVARCHAR(150)  NOT NULL,
  Status           NVARCHAR(10)   NOT NULL DEFAULT 'waiting',
  CollectedAt      DATETIME2(0)   NULL,
  CollectedBy      INT            NULL REFERENCES Users(Id),
  DueAt            DATETIME2(0)   NULL,
  SentAt           DATETIME2(0)   NULL,
  SentTo           NVARCHAR(150)  NULL,
  EnteredAt        DATETIME2(0)   NULL,
  EnteredBy        INT            NULL REFERENCES Users(Id),
  VerifiedAt       DATETIME2(0)   NULL,
  VerifiedBy       INT            NULL REFERENCES Users(Id),
  DeliveredAt      DATETIME2(0)   NULL,
  DeliveredBy      INT            NULL REFERENCES Users(Id),
  DeliveredTo      NVARCHAR(150)  NULL,
  ExtFile          NVARCHAR(200)  NULL,
  ExtFileType      NVARCHAR(60)   NULL,
  Comment          NVARCHAR(500)  NULL,
  PrintCount       INT            NOT NULL DEFAULT 0,
  CreatedAt        DATETIME2(0)   NOT NULL,
  UpdatedAt        DATETIME2(0)   NULL,
  CONSTRAINT CK_LabWork_Status CHECK (Status IN ('waiting','collected','done','sent','verified','delivered','cancelled')),
  CONSTRAINT CK_LabWork_Src CHECK (VisitItemId IS NOT NULL OR AdmissionItemId IS NOT NULL)
);
GO
CREATE INDEX IX_LabWork_Status ON LabWork (Status, CreatedAt);
GO
CREATE INDEX IX_LabWork_VisitItem ON LabWork (VisitItemId);
GO
CREATE INDEX IX_LabWork_AdmItem ON LabWork (AdmissionItemId);
GO
CREATE INDEX IX_LabWork_Patient ON LabWork (PatientId);
GO
-- القيم. Flag: H عالي ، L واطي ، A غير طبيعي (نص) ، فاضي = طبيعي
CREATE TABLE LabValues (
  Id         INT IDENTITY(1,1) PRIMARY KEY,
  WorkId     INT            NOT NULL REFERENCES LabWork(Id),
  ParamId    INT            NULL REFERENCES LabParams(Id),
  Name       NVARCHAR(120)  NOT NULL,
  Unit       NVARCHAR(40)   NULL,
  Value      NVARCHAR(200)  NULL,
  Flag       NVARCHAR(2)    NULL,
  RefText    NVARCHAR(200)  NULL,
  Kind       NVARCHAR(10)   NOT NULL DEFAULT 'num',
  SortOrder  INT            NOT NULL DEFAULT 0
);
GO
CREATE INDEX IX_LabValues_Work ON LabValues (WorkId, SortOrder);
GO
INSERT INTO Counters (Name, Value) VALUES (N'lab', 100000);
GO
INSERT INTO AppSettings ([Key], Value) VALUES (N'labVerify', N'0');
GO
-- @alters (SQL Server بس: دور «المعمل»)
ALTER TABLE Users DROP CONSTRAINT CK_Users_Role;
GO
ALTER TABLE Users ADD CONSTRAINT CK_Users_Role CHECK (Role IN ('reception','supervisor','reviewer','manager','cashier','radiology','lab'));
GO
