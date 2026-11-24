-- =====================================================================
--  تحديث 007: حسابات الإقامة (التذكرة اليومية، أصناف الأدوية والمستلزمات، قفل التذكرة، المستحقات اللاحقة)
--  الأوامر مفصولة بـ GO. الجزء قبل «@alters» بيشتغل زي ما هو على SQLite كمان
-- =====================================================================

-- أصناف الأدوية والمستلزمات بأسعارها (هتبقى أساس الصيدلية والمخازن بعدين)
-- Kind: drug دواء | supply مستلزم
CREATE TABLE StockItems (
  Id         INT IDENTITY(1,1) PRIMARY KEY,
  Code       NVARCHAR(30)   NOT NULL,
  Name       NVARCHAR(150)  NOT NULL,
  SearchKey  NVARCHAR(300)  NULL,
  Kind       NVARCHAR(10)   NOT NULL,
  Unit       NVARCHAR(30)   NULL,
  Price      DECIMAL(12,2)  NOT NULL DEFAULT 0,
  Barcode    NVARCHAR(60)   NULL,
  Active     BIT            NOT NULL DEFAULT 1,
  CreatedAt  DATETIME2(0)   NOT NULL,
  UpdatedAt  DATETIME2(0)   NULL,
  UpdatedBy  INT            NULL REFERENCES Users(Id),
  CONSTRAINT UQ_StockItems_Code UNIQUE (Code),
  CONSTRAINT CK_StockItems_Kind CHECK (Kind IN ('drug','supply')),
  CONSTRAINT CK_StockItems_Price CHECK (Price >= 0)
);
GO
CREATE INDEX IX_StockItems_Kind ON StockItems (Kind, Active);
GO
-- دفعة تذكرة: كل مرة التذكرة الورق تنزل الحسابات (ممكن كذا مرة في اليوم)
CREATE TABLE Tickets (
  Id           INT IDENTITY(1,1) PRIMARY KEY,
  TicketNo     INT            NOT NULL,
  AdmissionId  INT            NOT NULL REFERENCES Admissions(Id),
  TicketDate   DATE           NOT NULL,
  ShiftLabel   NVARCHAR(10)   NULL,
  PaperNo      NVARCHAR(30)   NULL,
  Note         NVARCHAR(300)  NULL,
  Lines        INT            NOT NULL DEFAULT 0,
  Total        DECIMAL(12,2)  NOT NULL DEFAULT 0,
  CreatedAt    DATETIME2(0)   NOT NULL,
  CreatedBy    INT            NOT NULL REFERENCES Users(Id),
  CONSTRAINT UQ_Tickets_No UNIQUE (TicketNo)
);
GO
CREATE INDEX IX_Tickets_Admission ON Tickets (AdmissionId, TicketDate);
GO
-- بند التذكرة على حساب الإقامة. Cat: service خدمة | drug دواء | supply مستلزم | fee أتعاب أطباء | visit زيارة
ALTER TABLE AdmissionItems ADD TicketId INT NULL REFERENCES Tickets(Id);
GO
ALTER TABLE AdmissionItems ADD StockItemId INT NULL REFERENCES StockItems(Id);
GO
ALTER TABLE AdmissionItems ADD Cat NVARCHAR(10) NULL;
GO
-- قفل التذكرة: BillStatus = closed بعد ما آخر موظف حسابات يقفلها (الحساب بيتجمد على وقت القفل)
ALTER TABLE Admissions ADD BillStatus NVARCHAR(10) NULL;
GO
ALTER TABLE Admissions ADD ClosedAt DATETIME2(0) NULL;
GO
ALTER TABLE Admissions ADD ClosedBy INT NULL REFERENCES Users(Id);
GO
ALTER TABLE Admissions ADD ReopenCount INT NOT NULL DEFAULT 0;
GO
-- تصنيف الخدمة في التذكرة (fee أتعاب أطباء | visit زيارة) ، والسعر المفتوح (الموظف يكتب المبلغ)
ALTER TABLE Services ADD TicketCat NVARCHAR(10) NULL;
GO
ALTER TABLE Services ADD OpenPrice BIT NOT NULL DEFAULT 0;
GO
-- حاجة اتنست بعد خروج المريض
-- Status: open مستني القرار | billed المريض هيدفعها | charged اتحمّلت على موظف أو قسم | cancelled اتلغت
CREATE TABLE LateCharges (
  Id               INT IDENTITY(1,1) PRIMARY KEY,
  LateNo           INT            NOT NULL,
  AdmissionId      INT            NOT NULL REFERENCES Admissions(Id),
  PatientId        INT            NOT NULL REFERENCES Patients(Id),
  Cat              NVARCHAR(10)   NOT NULL,
  ServiceId        INT            NULL REFERENCES Services(Id),
  StockItemId      INT            NULL REFERENCES StockItems(Id),
  DoctorId         INT            NULL REFERENCES Doctors(Id),
  Name             NVARCHAR(150)  NOT NULL,
  Qty              INT            NOT NULL DEFAULT 1,
  UnitPrice        DECIMAL(12,2)  NOT NULL,
  Amount           DECIMAL(12,2)  NOT NULL,
  Reason           NVARCHAR(300)  NOT NULL,
  Status           NVARCHAR(10)   NOT NULL DEFAULT 'open',
  ChargeTo         NVARCHAR(10)   NULL,
  ChargeName       NVARCHAR(150)  NULL,
  ChargeUserId     INT            NULL REFERENCES Users(Id),
  AdmissionItemId  INT            NULL REFERENCES AdmissionItems(Id),
  OrderId          INT            NULL,
  DecisionNote     NVARCHAR(300)  NULL,
  DecidedAt        DATETIME2(0)   NULL,
  DecidedBy        INT            NULL REFERENCES Users(Id),
  CreatedAt        DATETIME2(0)   NOT NULL,
  CreatedBy        INT            NOT NULL REFERENCES Users(Id),
  CONSTRAINT UQ_LateCharges_No UNIQUE (LateNo),
  CONSTRAINT CK_LateCharges_Status CHECK (Status IN ('open','billed','charged','cancelled')),
  CONSTRAINT CK_LateCharges_To CHECK (ChargeTo IS NULL OR ChargeTo IN ('employee','dept'))
);
GO
CREATE INDEX IX_LateCharges_Status ON LateCharges (Status, CreatedAt);
GO
INSERT INTO Counters (Name, Value) VALUES (N'ticket', 0);
GO
INSERT INTO Counters (Name, Value) VALUES (N'late', 0);
GO
-- on: البنود بتتكتب من الحسابات بس، والخروج محتاج قفل التذكرة. off: زي الأول (الاستقبال بيضيف ويخرّج)
INSERT INTO AppSettings ([Key], Value) VALUES (N'ticketMode', N'on');
GO
-- @alters (SQL Server بس: دور «حسابات الإقامة» و«مشرف الحسابات»)
ALTER TABLE Users DROP CONSTRAINT CK_Users_Role;
GO
ALTER TABLE Users ADD CONSTRAINT CK_Users_Role CHECK (Role IN ('reception','supervisor','reviewer','manager','cashier','radiology','lab','accounts','accsuper'));
GO
-- البنود القديمة: تصنيفها في التذكرة
UPDATE AdmissionItems SET Cat = CASE WHEN Kind = 'night' THEN 'night' ELSE 'service' END WHERE Cat IS NULL;
GO
