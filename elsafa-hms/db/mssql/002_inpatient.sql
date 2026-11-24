-- =====================================================================
--  تحديث 002: الدخول والإقامة ولوحة الأسرّة
--  بيتشغل لوحده من npm run db:init (على القاعدة الجديدة أو اللي اتعملت بنسخة 0.1/0.2)
--  الأوامر مفصولة بـ GO
-- =====================================================================

CREATE TABLE AppSettings (
  [Key]      NVARCHAR(50)  NOT NULL PRIMARY KEY,
  Value      NVARCHAR(400) NULL,
  UpdatedAt  DATETIME2(0)  NULL,
  UpdatedBy  INT           NULL REFERENCES Users(Id)
);
GO
CREATE TABLE Floors (
  Id         INT IDENTITY(1,1) PRIMARY KEY,
  Number     INT           NOT NULL,
  Name       NVARCHAR(60)  NOT NULL,
  Notes      NVARCHAR(200) NULL,
  Active     BIT           NOT NULL DEFAULT 1,
  CONSTRAINT UQ_Floors_Number UNIQUE (Number)
);
GO
-- درجات الغرف: ward = إقامة عادية، icu = عناية، nursery = حضانة
CREATE TABLE RoomClasses (
  Id          INT IDENTITY(1,1) PRIMARY KEY,
  Name        NVARCHAR(60)   NOT NULL,
  Kind        NVARCHAR(10)   NOT NULL,
  NightPrice  DECIMAL(12,2)  NULL,
  Deposit     DECIMAL(12,2)  NULL,
  SortOrder   INT            NOT NULL DEFAULT 0,
  Active      BIT            NOT NULL DEFAULT 1,
  CONSTRAINT CK_RoomClasses_Kind CHECK (Kind IN ('ward','icu','nursery')),
  CONSTRAINT CK_RoomClasses_Price CHECK (NightPrice IS NULL OR NightPrice >= 0),
  CONSTRAINT CK_RoomClasses_Deposit CHECK (Deposit IS NULL OR Deposit >= 0)
);
GO
CREATE TABLE Rooms (
  Id        INT IDENTITY(1,1) PRIMARY KEY,
  FloorId   INT           NOT NULL REFERENCES Floors(Id),
  Number    NVARCHAR(20)  NOT NULL,
  ClassId   INT           NOT NULL REFERENCES RoomClasses(Id),
  Notes     NVARCHAR(200) NULL,
  Active    BIT           NOT NULL DEFAULT 1,
  CONSTRAINT UQ_Rooms_Number UNIQUE (Number)
);
GO
-- حالة السرير: free فاضي | occupied مشغول | cleaning تحت التنظيف | reserved محجوز
CREATE TABLE Beds (
  Id          INT IDENTITY(1,1) PRIMARY KEY,
  RoomId      INT           NOT NULL REFERENCES Rooms(Id),
  Label       NVARCHAR(20)  NOT NULL,
  Status      NVARCHAR(10)  NOT NULL DEFAULT 'free',
  StatusNote  NVARCHAR(200) NULL,
  StatusAt    DATETIME2(0)  NULL,
  StatusBy    INT           NULL REFERENCES Users(Id),
  Active      BIT           NOT NULL DEFAULT 1,
  CONSTRAINT CK_Beds_Status CHECK (Status IN ('free','occupied','cleaning','reserved')),
  CONSTRAINT UQ_Beds_Label UNIQUE (RoomId, Label)
);
GO
-- نوع الدخول: inpatient داخلي | icu عناية | nursery حضانة | surgery عمليات
CREATE TABLE Admissions (
  Id                 INT IDENTITY(1,1) PRIMARY KEY,
  AdmissionNo        INT            NOT NULL,
  PatientId          INT            NOT NULL REFERENCES Patients(Id),
  Type               NVARCHAR(10)   NOT NULL,
  Status             NVARCHAR(10)   NOT NULL,
  DoctorId           INT            NULL REFERENCES Doctors(Id),
  ExpectedProcedure  NVARCHAR(200)  NULL,
  BedId              INT            NOT NULL REFERENCES Beds(Id),
  DepositRequired    DECIMAL(12,2)  NOT NULL DEFAULT 0,
  FromVisitId        INT            NULL REFERENCES Visits(Id),
  Notes              NVARCHAR(400)  NULL,
  AdmittedAt         DATETIME2(0)   NOT NULL,
  AdmittedBy         INT            NOT NULL REFERENCES Users(Id),
  DischargedAt       DATETIME2(0)   NULL,
  DischargedBy       INT            NULL REFERENCES Users(Id),
  DischargeNote      NVARCHAR(300)  NULL,
  CONSTRAINT UQ_Admissions_No UNIQUE (AdmissionNo),
  CONSTRAINT CK_Admissions_Type CHECK (Type IN ('inpatient','icu','nursery','surgery')),
  CONSTRAINT CK_Admissions_Status CHECK (Status IN ('active','discharged'))
);
GO
CREATE INDEX IX_Admissions_Patient ON Admissions (PatientId);
GO
CREATE INDEX IX_Admissions_Status ON Admissions (Status);
GO
-- مريض واحد مايدخلش مرتين في نفس الوقت، وسرير واحد لمريض واحد
CREATE UNIQUE INDEX UX_Admissions_ActivePatient ON Admissions (PatientId) WHERE Status = 'active';
GO
CREATE UNIQUE INDEX UX_Admissions_ActiveBed ON Admissions (BedId) WHERE Status = 'active';
GO
CREATE TABLE BedMoves (
  Id           INT IDENTITY(1,1) PRIMARY KEY,
  AdmissionId  INT           NOT NULL REFERENCES Admissions(Id),
  BedId        INT           NOT NULL REFERENCES Beds(Id),
  ClassId      INT           NOT NULL REFERENCES RoomClasses(Id),
  FromAt       DATETIME2(0)  NOT NULL,
  ToAt         DATETIME2(0)  NULL,
  MovedBy      INT           NOT NULL REFERENCES Users(Id),
  Reason       NVARCHAR(200) NULL
);
GO
CREATE INDEX IX_BedMoves_Admission ON BedMoves (AdmissionId);
GO
-- بنود حساب الإقامة: night = ليلة إقامة، service = خدمة
CREATE TABLE AdmissionItems (
  Id                 INT IDENTITY(1,1) PRIMARY KEY,
  AdmissionId        INT            NOT NULL REFERENCES Admissions(Id),
  Kind               NVARCHAR(10)   NOT NULL,
  ServiceId          INT            NULL REFERENCES Services(Id),
  Name               NVARCHAR(150)  NOT NULL,
  Dept               NVARCHAR(20)   NOT NULL,
  DoctorId           INT            NULL REFERENCES Doctors(Id),
  Qty                INT            NOT NULL,
  UnitPrice          DECIMAL(12,2)  NOT NULL,
  Amount             DECIMAL(12,2)  NOT NULL,
  DoctorPct          DECIMAL(5,2)   NOT NULL DEFAULT 0,
  ChargeDate         DATE           NULL,
  ClassId            INT            NULL REFERENCES RoomClasses(Id),
  IncludedNights     INT            NULL,
  Note               NVARCHAR(200)  NULL,
  Status             NVARCHAR(10)   NOT NULL,
  SourceVisitItemId  INT            NULL REFERENCES VisitItems(Id),
  AddedAt            DATETIME2(0)   NOT NULL,
  AddedBy            INT            NOT NULL REFERENCES Users(Id),
  VoidedAt           DATETIME2(0)   NULL,
  VoidedBy           INT            NULL REFERENCES Users(Id),
  VoidReason         NVARCHAR(300)  NULL,
  CONSTRAINT CK_AdmissionItems_Kind CHECK (Kind IN ('night','service')),
  CONSTRAINT CK_AdmissionItems_Status CHECK (Status IN ('active','voided')),
  CONSTRAINT CK_AdmissionItems_Qty CHECK (Qty > 0)
);
GO
CREATE INDEX IX_AdmissionItems_Admission ON AdmissionItems (AdmissionId);
GO
INSERT INTO Counters (Name, Value) VALUES (N'admission', 0);
GO
INSERT INTO AppSettings ([Key], Value) VALUES (N'checkoutTime', N'12:00');
GO
INSERT INTO Floors (Number, Name, Notes) VALUES
  (3, N'الدور الثالث', N'إقامة + حضانة'),
  (4, N'الدور الرابع', N'إقامة'),
  (6, N'الدور السادس', N'عناية + عمليات'),
  (7, N'الدور السابع', N'إقامة'),
  (8, N'الدور الثامن', N'إقامة');
GO
INSERT INTO RoomClasses (Name, Kind, SortOrder) VALUES
  (N'عادية', 'ward', 1), (N'ممتازة', 'ward', 2), (N'جناح', 'ward', 3), (N'جناح ملكي', 'ward', 4),
  (N'عناية مركزة', 'icu', 5), (N'حضانة', 'nursery', 6);
GO

-- @alters  (تعديلات على جداول موجودة: النسخة الـ SQLite بتتعمل من غير الجزء ده)

-- الخدمات: قسمين جداد (خدمات الإقامة والعمليات) + عدد ليالي الباكدج
ALTER TABLE Services DROP CONSTRAINT CK_Services_Dept;
GO
ALTER TABLE Services ADD CONSTRAINT CK_Services_Dept CHECK (Dept IN ('clinic','emergency','lab','radiology','ward','or'));
GO
ALTER TABLE Services ADD IncludedNights INT NULL;
GO

-- الإيصالات: ممكن تبقى على زيارة أو على دخول
DECLARE @fk sysname;
SELECT @fk = fk.name FROM sys.foreign_keys fk
  JOIN sys.foreign_key_columns c ON c.constraint_object_id = fk.object_id
  JOIN sys.columns col ON col.object_id = c.parent_object_id AND col.column_id = c.parent_column_id
 WHERE fk.parent_object_id = OBJECT_ID(N'dbo.Receipts') AND col.name = N'VisitId';
IF @fk IS NOT NULL EXEC (N'ALTER TABLE dbo.Receipts DROP CONSTRAINT [' + @fk + N']');
GO
DROP INDEX IX_Receipts_Visit ON Receipts;
GO
ALTER TABLE Receipts ALTER COLUMN VisitId INT NULL;
GO
ALTER TABLE Receipts ADD CONSTRAINT FK_Receipts_Visit FOREIGN KEY (VisitId) REFERENCES Visits(Id);
GO
CREATE INDEX IX_Receipts_Visit ON Receipts (VisitId);
GO
ALTER TABLE Receipts ADD AdmissionId INT NULL CONSTRAINT FK_Receipts_Admission REFERENCES Admissions(Id);
GO
ALTER TABLE Receipts ADD Note NVARCHAR(300) NULL;
GO
CREATE INDEX IX_Receipts_Admission ON Receipts (AdmissionId);
GO
ALTER TABLE Receipts DROP CONSTRAINT CK_Receipts_Kind;
GO
-- payment دفع / دفعة تحت الحساب ، deposit تأمين دخول ، final سداد نهائي ، return مرتجع للمريض ، refund إلغاء إيصال
ALTER TABLE Receipts ADD CONSTRAINT CK_Receipts_Kind CHECK (Kind IN ('payment','refund','deposit','final','return'));
GO
ALTER TABLE Receipts ADD CONSTRAINT CK_Receipts_Target CHECK (VisitId IS NOT NULL OR AdmissionId IS NOT NULL);
GO

-- مستحقات الأطباء: ممكن تبقى على بند زيارة أو بند إقامة
DECLARE @fk2 sysname;
SELECT @fk2 = fk.name FROM sys.foreign_keys fk
  JOIN sys.foreign_key_columns c ON c.constraint_object_id = fk.object_id
  JOIN sys.columns col ON col.object_id = c.parent_object_id AND col.column_id = c.parent_column_id
 WHERE fk.parent_object_id = OBJECT_ID(N'dbo.DoctorEarnings') AND col.name = N'VisitItemId';
IF @fk2 IS NOT NULL EXEC (N'ALTER TABLE dbo.DoctorEarnings DROP CONSTRAINT [' + @fk2 + N']');
GO
ALTER TABLE DoctorEarnings ALTER COLUMN VisitItemId INT NULL;
GO
ALTER TABLE DoctorEarnings ADD CONSTRAINT FK_DoctorEarnings_VisitItem FOREIGN KEY (VisitItemId) REFERENCES VisitItems(Id);
GO
ALTER TABLE DoctorEarnings ADD AdmissionItemId INT NULL CONSTRAINT FK_DoctorEarnings_AdmissionItem REFERENCES AdmissionItems(Id);
GO
