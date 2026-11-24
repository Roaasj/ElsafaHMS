-- =====================================================================
--  تحديث 004: الخزينة (أذونات الدفع) وتقفيل الورديات والتسليم
--  الأوامر مفصولة بـ GO. الجزء قبل «@alters» بيشتغل زي ما هو على SQLite كمان
-- =====================================================================

-- إذن دفع: الاستقبال بيجهّز الحساب، والخزينة بتحصّل وتطلع الإيصال
-- Kind: visit = خدمات زيارة ، adm_pay = دفعة دخول ، deposit = تأمين دخول ، discharge = سداد/مرتجع الخروج ، refund_due = مرتجع موافقة
CREATE TABLE PayOrders (
  Id            INT IDENTITY(1,1) PRIMARY KEY,
  OrderNo       INT            NOT NULL,
  Kind          NVARCHAR(12)   NOT NULL,
  VisitId       INT            NULL REFERENCES Visits(Id),
  AdmissionId   INT            NULL REFERENCES Admissions(Id),
  PatientId     INT            NOT NULL REFERENCES Patients(Id),
  Amount        DECIMAL(12,2)  NOT NULL,             -- المطلوب تحصيله (سالب = صرف للمريض)
  Credit        DECIMAL(12,2)  NOT NULL DEFAULT 0,   -- آجل متوافق عليه من الاستقبال
  Discount      DECIMAL(12,2)  NOT NULL DEFAULT 0,
  Description   NVARCHAR(400)  NOT NULL,
  Payload       NVARCHAR(MAX)  NOT NULL,
  Status        NVARCHAR(10)   NOT NULL DEFAULT 'pending',
  CreatedAt     DATETIME2(0)   NOT NULL,
  CreatedBy     INT            NOT NULL REFERENCES Users(Id),
  DoneAt        DATETIME2(0)   NULL,
  DoneBy        INT            NULL REFERENCES Users(Id),
  ReceiptId     INT            NULL REFERENCES Receipts(Id),
  CancelReason  NVARCHAR(300)  NULL,
  CONSTRAINT UQ_PayOrders_No UNIQUE (OrderNo),
  CONSTRAINT CK_PayOrders_Kind CHECK (Kind IN ('visit','adm_pay','deposit','discharge','refund_due')),
  CONSTRAINT CK_PayOrders_Status CHECK (Status IN ('pending','done','cancelled'))
);
GO
CREATE INDEX IX_PayOrders_Status ON PayOrders (Status, CreatedAt);
GO
INSERT INTO Counters (Name, Value) VALUES (N'order', 0);
GO
-- البنود المحجوزة في إذن دفع لسه ما اتحصلش
ALTER TABLE VisitItems ADD PendingOrderId INT NULL;
GO
ALTER TABLE Receipts ADD ManualNo NVARCHAR(30) NULL;
GO
ALTER TABLE Receipts ADD OrderId INT NULL;
GO
-- تقفيل الوردية والتسليم
ALTER TABLE Shifts ADD Label NVARCHAR(10) NULL;
GO
ALTER TABLE Shifts ADD BusinessDate DATE NULL;
GO
ALTER TABLE Shifts ADD Explicit BIT NOT NULL DEFAULT 0;
GO
ALTER TABLE Shifts ADD ExpectedCash DECIMAL(12,2) NULL;
GO
ALTER TABLE Shifts ADD CountedCash DECIMAL(12,2) NULL;
GO
ALTER TABLE Shifts ADD CardTotal DECIMAL(12,2) NULL;
GO
ALTER TABLE Shifts ADD DiffReason NVARCHAR(300) NULL;
GO
ALTER TABLE Shifts ADD CloseNote NVARCHAR(300) NULL;
GO
ALTER TABLE Shifts ADD HandedTo INT NULL REFERENCES Users(Id);
GO
ALTER TABLE Shifts ADD ReceivedAt DATETIME2(0) NULL;
GO
ALTER TABLE Shifts ADD ReceivedBy INT NULL REFERENCES Users(Id);
GO
ALTER TABLE Shifts ADD ReceivedShiftId INT NULL;
GO
INSERT INTO AppSettings ([Key], Value) VALUES (N'cashierMode', N'auto');
GO
INSERT INTO AppSettings ([Key], Value) VALUES (N'manualNoRequired', N'0');
GO
-- @alters (SQL Server بس: دور «موظف خزينة»)
ALTER TABLE Users DROP CONSTRAINT CK_Users_Role;
GO
ALTER TABLE Users ADD CONSTRAINT CK_Users_Role CHECK (Role IN ('reception','supervisor','reviewer','manager','cashier'));
GO
-- الورديات القديمة: يوم الخزينة (بيبدأ 7 الصبح بتوقيت القاهرة = 5 UTC)
UPDATE Shifts SET BusinessDate = CAST(DATEADD(hour, -5, OpenedAt) AS DATE), Label = 'am' WHERE BusinessDate IS NULL;
GO
