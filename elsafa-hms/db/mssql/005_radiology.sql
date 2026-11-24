-- =====================================================================
--  تحديث 005: قسم الأشعة (قايمة الشغل، تقارير السونار بالقوالب، متابعة المقطعية، التسليم)
--  الأوامر مفصولة بـ GO. الجزء قبل «@alters» بيشتغل زي ما هو على SQLite كمان
-- =====================================================================

-- نوع الجهاز للخدمة: us سونار ، ct مقطعية ، mri رنين ، xray عادية ، mammo ماموجرام ، other
ALTER TABLE Services ADD Modality NVARCHAR(10) NULL;
GO
-- قوالب تقارير الأشعة (المدير ودكتور الأشعة يعدّلوها)
CREATE TABLE RadTemplates (
  Id         INT IDENTITY(1,1) PRIMARY KEY,
  Name       NVARCHAR(120)  NOT NULL,
  Modality   NVARCHAR(10)   NOT NULL,
  Title      NVARCHAR(200)  NULL,             -- عنوان الفحص في التقرير
  Body       NVARCHAR(MAX)  NOT NULL,         -- HTML بسيط
  SortOrder  INT            NOT NULL DEFAULT 0,
  Active     BIT            NOT NULL DEFAULT 1,
  CreatedAt  DATETIME2(0)   NOT NULL,
  UpdatedAt  DATETIME2(0)   NULL,
  UpdatedBy  INT            NULL REFERENCES Users(Id)
);
GO
-- فحص أشعة: سطر لكل خدمة أشعة (زيارة أو دخول) أول ما القسم يبدأ يشتغل عليها
-- Status: waiting مستني ، done اتعمل ، sent اتبعت للدكتور ، reported التقرير جاهز ، delivered اتسلّم ، cancelled
CREATE TABLE RadStudies (
  Id               INT IDENTITY(1,1) PRIMARY KEY,
  StudyNo          INT            NOT NULL,
  PatientId        INT            NOT NULL REFERENCES Patients(Id),
  VisitItemId      INT            NULL REFERENCES VisitItems(Id),
  AdmissionItemId  INT            NULL REFERENCES AdmissionItems(Id),
  ServiceName      NVARCHAR(150)  NOT NULL,
  Modality         NVARCHAR(10)   NOT NULL,
  Status           NVARCHAR(10)   NOT NULL DEFAULT 'waiting',
  ClinicalInfo     NVARCHAR(400)  NULL,
  DoneAt           DATETIME2(0)   NULL,
  DoneBy           INT            NULL REFERENCES Users(Id),
  SentAt           DATETIME2(0)   NULL,
  SentTo           NVARCHAR(150)  NULL,
  DueAt            DATETIME2(0)   NULL,
  ReportTitle      NVARCHAR(200)  NULL,
  ReportHtml       NVARCHAR(MAX)  NULL,
  ReportFile       NVARCHAR(200)  NULL,
  ReportFileType   NVARCHAR(60)   NULL,
  ReportLink       NVARCHAR(500)  NULL,
  Radiologist      NVARCHAR(150)  NULL,
  ReportedAt       DATETIME2(0)   NULL,
  ReportedBy       INT            NULL REFERENCES Users(Id),
  DeliveredAt      DATETIME2(0)   NULL,
  DeliveredBy      INT            NULL REFERENCES Users(Id),
  DeliveredTo      NVARCHAR(150)  NULL,
  PrintCount       INT            NOT NULL DEFAULT 0,
  Notes            NVARCHAR(400)  NULL,
  CreatedAt        DATETIME2(0)   NOT NULL,
  UpdatedAt        DATETIME2(0)   NULL,
  CONSTRAINT UQ_RadStudies_No UNIQUE (StudyNo),
  CONSTRAINT CK_RadStudies_Status CHECK (Status IN ('waiting','done','sent','reported','delivered','cancelled')),
  CONSTRAINT CK_RadStudies_Src CHECK (VisitItemId IS NOT NULL OR AdmissionItemId IS NOT NULL)
);
GO
CREATE INDEX IX_RadStudies_Status ON RadStudies (Status, CreatedAt);
GO
CREATE INDEX IX_RadStudies_Patient ON RadStudies (PatientId);
GO
CREATE INDEX IX_RadStudies_VisitItem ON RadStudies (VisitItemId);
GO
CREATE INDEX IX_RadStudies_AdmItem ON RadStudies (AdmissionItemId);
GO
INSERT INTO Counters (Name, Value) VALUES (N'study', 0);
GO
-- الوقت المتوقع للتقرير بالساعات لكل نوع
INSERT INTO AppSettings ([Key], Value) VALUES (N'radDue', N'{"us":2,"xray":1,"ct":24,"mri":48,"mammo":24,"other":24}');
GO
-- @alters (SQL Server بس: دور «قسم الأشعة»)
ALTER TABLE Users DROP CONSTRAINT CK_Users_Role;
GO
ALTER TABLE Users ADD CONSTRAINT CK_Users_Role CHECK (Role IN ('reception','supervisor','reviewer','manager','cashier','radiology'));
GO
