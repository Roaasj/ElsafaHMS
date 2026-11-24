-- =====================================================================
--  تحديث 012: الحسابات العامة
--  صرف مستحقات الأطباء (بالضريبة)، الموردين وفواتيرهم ودفعاتهم وشيكاتهم،
--  المصروفات (بموافقة أو مباشر)، الأقساط على المستشفى، وإذن الصرف النقدي من الخزينة
--  الأوامر مفصولة بـ GO. الجزء قبل «@alters» بيشتغل زي ما هو على SQLite كمان
-- =====================================================================

-- إذن صرف نقدي: الحسابات بتجهّزه والخزينة بتصرف منه وبيتخصم من درج وردية اللي صرف
-- Kind: payout = مستحقات دكتور ، expense = مصروف ، supplier = دفعة مورد ، installment = قسط
CREATE TABLE CashVouchers (
  Id           INT IDENTITY(1,1) PRIMARY KEY,
  VoucherNo    INT            NOT NULL,
  Kind         NVARCHAR(12)   NOT NULL,
  RefId        INT            NOT NULL,
  Payee        NVARCHAR(150)  NOT NULL,
  Description  NVARCHAR(300)  NOT NULL,
  Amount       DECIMAL(14,2)  NOT NULL,
  Status       NVARCHAR(10)   NOT NULL DEFAULT 'pending',
  CreatedAt    DATETIME2(0)   NOT NULL,
  CreatedBy    INT            NOT NULL REFERENCES Users(Id),
  PaidAt       DATETIME2(0)   NULL,
  PaidBy       INT            NULL REFERENCES Users(Id),
  ShiftId      INT            NULL REFERENCES Shifts(Id),
  CancelReason NVARCHAR(300)  NULL,
  CONSTRAINT UQ_CashVouchers_No UNIQUE (VoucherNo),
  CONSTRAINT CK_CashVouchers_Kind CHECK (Kind IN ('payout','expense','supplier','installment')),
  CONSTRAINT CK_CashVouchers_Status CHECK (Status IN ('pending','paid','cancelled'))
);
GO
CREATE INDEX IX_CashVouchers_Status ON CashVouchers (Status, CreatedAt);
GO
CREATE INDEX IX_CashVouchers_Shift ON CashVouchers (ShiftId);
GO

-- صرف مستحقات الأطباء: بتتحسب لحد آخر الشهر، والصافي = المستحق − الضريبة
CREATE TABLE DoctorPayouts (
  Id          INT IDENTITY(1,1) PRIMARY KEY,
  PayoutNo    INT            NOT NULL,
  DoctorId    INT            NOT NULL REFERENCES Doctors(Id),
  Period      NVARCHAR(7)    NOT NULL,
  CutoffAt    DATETIME2(0)   NOT NULL,
  Gross       DECIMAL(14,2)  NOT NULL,
  TaxPct      DECIMAL(5,2)   NOT NULL,
  Tax         DECIMAL(14,2)  NOT NULL,
  Net         DECIMAL(14,2)  NOT NULL,
  Status      NVARCHAR(10)   NOT NULL DEFAULT 'issued',
  Note        NVARCHAR(300)  NULL,
  CreatedAt   DATETIME2(0)   NOT NULL,
  CreatedBy   INT            NOT NULL REFERENCES Users(Id),
  PaidAt      DATETIME2(0)   NULL,
  VoidReason  NVARCHAR(300)  NULL,
  VoucherId   INT            NULL REFERENCES CashVouchers(Id),
  CONSTRAINT UQ_DoctorPayouts_No UNIQUE (PayoutNo),
  CONSTRAINT CK_DoctorPayouts_Status CHECK (Status IN ('issued','paid','void'))
);
GO
CREATE INDEX IX_DoctorPayouts_Doctor ON DoctorPayouts (DoctorId, Status);
GO
-- نصيب الشركة من أتعاب الدكتور مستحق بعد التحصيل: بيتحرّر يدوي بعد ما الشركة تدفع
ALTER TABLE DoctorEarnings ADD PayerReleased BIT NOT NULL DEFAULT 0;
GO

-- الموردين
CREATE TABLE Suppliers (
  Id         INT IDENTITY(1,1) PRIMARY KEY,
  Name       NVARCHAR(150)  NOT NULL,
  Phone      NVARCHAR(40)   NULL,
  Note       NVARCHAR(300)  NULL,
  Active     BIT            NOT NULL DEFAULT 1,
  CreatedAt  DATETIME2(0)   NOT NULL,
  CONSTRAINT UQ_Suppliers_Name UNIQUE (Name)
);
GO
CREATE TABLE SupplierInvoices (
  Id          INT IDENTITY(1,1) PRIMARY KEY,
  InvNo       INT            NOT NULL,
  SupplierId  INT            NOT NULL REFERENCES Suppliers(Id),
  PurchaseId  INT            NULL REFERENCES Purchases(Id),
  DocNo       NVARCHAR(40)   NULL,
  DocDate     DATE           NOT NULL,
  DueDate     DATE           NULL,
  Amount      DECIMAL(14,2)  NOT NULL,
  Note        NVARCHAR(300)  NULL,
  Status      NVARCHAR(10)   NOT NULL DEFAULT 'open',
  VoidReason  NVARCHAR(300)  NULL,
  CreatedAt   DATETIME2(0)   NOT NULL,
  CreatedBy   INT            NOT NULL REFERENCES Users(Id),
  CONSTRAINT UQ_SupplierInvoices_No UNIQUE (InvNo),
  CONSTRAINT CK_SupplierInvoices_Status CHECK (Status IN ('open','void'))
);
GO
CREATE INDEX IX_SupplierInvoices_Supplier ON SupplierInvoices (SupplierId, DueDate);
GO
-- دفعة مورد: bank تحويل من حساب البنك ، cash من الخزينة (بإذن صرف) ، cheque شيك (ClearedAt لما يتصرف)
CREATE TABLE SupplierPayments (
  Id          INT IDENTITY(1,1) PRIMARY KEY,
  SupplierId  INT            NOT NULL REFERENCES Suppliers(Id),
  InvoiceId   INT            NULL REFERENCES SupplierInvoices(Id),
  Method      NVARCHAR(8)    NOT NULL,
  Amount      DECIMAL(14,2)  NOT NULL,
  PayDate     DATE           NOT NULL,
  ChequeNo    NVARCHAR(40)   NULL,
  ChequeDate  DATE           NULL,
  Bank        NVARCHAR(80)   NULL,
  ClearedAt   DATETIME2(0)   NULL,
  VoucherId   INT            NULL REFERENCES CashVouchers(Id),
  Status      NVARCHAR(8)    NOT NULL DEFAULT 'ok',
  VoidReason  NVARCHAR(300)  NULL,
  Note        NVARCHAR(300)  NULL,
  CreatedAt   DATETIME2(0)   NOT NULL,
  CreatedBy   INT            NOT NULL REFERENCES Users(Id),
  CONSTRAINT CK_SupplierPayments_Method CHECK (Method IN ('bank','cash','cheque')),
  CONSTRAINT CK_SupplierPayments_Status CHECK (Status IN ('ok','void'))
);
GO
CREATE INDEX IX_SupplierPayments_Invoice ON SupplierPayments (InvoiceId);
GO
CREATE INDEX IX_SupplierPayments_Cheque ON SupplierPayments (Method, ClearedAt);
GO

-- المصروفات
CREATE TABLE ExpenseCategories (
  Id         INT IDENTITY(1,1) PRIMARY KEY,
  Name       NVARCHAR(80)  NOT NULL,
  SortOrder  INT           NOT NULL DEFAULT 0,
  Active     BIT           NOT NULL DEFAULT 1,
  CONSTRAINT UQ_ExpenseCategories_Name UNIQUE (Name)
);
GO
CREATE TABLE Expenses (
  Id          INT IDENTITY(1,1) PRIMARY KEY,
  ExpNo       INT            NOT NULL,
  ExpDate     DATE           NOT NULL,
  CategoryId  INT            NOT NULL REFERENCES ExpenseCategories(Id),
  Amount      DECIMAL(14,2)  NOT NULL,
  Method      NVARCHAR(6)    NOT NULL,
  Payee       NVARCHAR(150)  NULL,
  Note        NVARCHAR(300)  NULL,
  Status      NVARCHAR(10)   NOT NULL DEFAULT 'approved',
  CreatedAt   DATETIME2(0)   NOT NULL,
  CreatedBy   INT            NOT NULL REFERENCES Users(Id),
  DecidedAt   DATETIME2(0)   NULL,
  DecidedBy   INT            NULL REFERENCES Users(Id),
  RejectReason NVARCHAR(300) NULL,
  VoucherId   INT            NULL REFERENCES CashVouchers(Id),
  CONSTRAINT UQ_Expenses_No UNIQUE (ExpNo),
  CONSTRAINT CK_Expenses_Method CHECK (Method IN ('cash','bank')),
  CONSTRAINT CK_Expenses_Status CHECK (Status IN ('pending','approved','rejected','void'))
);
GO
CREATE INDEX IX_Expenses_Date ON Expenses (ExpDate, Status);
GO

-- الأقساط على المستشفى (أجهزة، قروض، موردين مقسّطين)
CREATE TABLE Obligations (
  Id         INT IDENTITY(1,1) PRIMARY KEY,
  Name       NVARCHAR(150)  NOT NULL,
  Party      NVARCHAR(150)  NULL,
  Note       NVARCHAR(300)  NULL,
  Active     BIT            NOT NULL DEFAULT 1,
  CreatedAt  DATETIME2(0)   NOT NULL,
  CreatedBy  INT            NOT NULL REFERENCES Users(Id)
);
GO
CREATE TABLE ObligationInstallments (
  Id            INT IDENTITY(1,1) PRIMARY KEY,
  ObligationId  INT            NOT NULL REFERENCES Obligations(Id),
  No            INT            NOT NULL,
  DueDate       DATE           NOT NULL,
  Amount        DECIMAL(14,2)  NOT NULL,
  Status        NVARCHAR(8)    NOT NULL DEFAULT 'due',
  PaidAt        DATETIME2(0)   NULL,
  PaidBy        INT            NULL REFERENCES Users(Id),
  Method        NVARCHAR(8)    NULL,
  ChequeNo      NVARCHAR(40)   NULL,
  ClearedAt     DATETIME2(0)   NULL,
  VoucherId     INT            NULL REFERENCES CashVouchers(Id),
  CONSTRAINT CK_ObligationInstallments_Status CHECK (Status IN ('due','paid'))
);
GO
CREATE INDEX IX_ObligationInstallments_Due ON ObligationInstallments (Status, DueDate);
GO
INSERT INTO Counters (Name, Value) VALUES (N'payout', 0);
GO
INSERT INTO Counters (Name, Value) VALUES (N'voucher', 0);
GO
INSERT INTO Counters (Name, Value) VALUES (N'expense', 0);
GO
INSERT INTO Counters (Name, Value) VALUES (N'supinv', 0);
GO
INSERT INTO ExpenseCategories (Name, SortOrder) VALUES (N'كهرباء ومياه وغاز', 1);
GO
INSERT INTO ExpenseCategories (Name, SortOrder) VALUES (N'صيانة', 2);
GO
INSERT INTO ExpenseCategories (Name, SortOrder) VALUES (N'نظافة وتشغيل', 3);
GO
INSERT INTO ExpenseCategories (Name, SortOrder) VALUES (N'مستلزمات إدارية', 4);
GO
INSERT INTO ExpenseCategories (Name, SortOrder) VALUES (N'ضيافة وكافتيريا', 5);
GO
INSERT INTO ExpenseCategories (Name, SortOrder) VALUES (N'انتقالات وشحن', 6);
GO
INSERT INTO ExpenseCategories (Name, SortOrder) VALUES (N'إيجارات وإنترنت واتصالات', 7);
GO
INSERT INTO ExpenseCategories (Name, SortOrder) VALUES (N'أخرى', 99);
GO
-- @alters (SQL Server بس: دور «الحسابات العامة»)
ALTER TABLE Users DROP CONSTRAINT CK_Users_Role;
GO
ALTER TABLE Users ADD CONSTRAINT CK_Users_Role CHECK (Role IN ('reception','supervisor','reviewer','manager','cashier','radiology','lab','accounts','accsuper','storekeeper','storeacc','pharmacist','nurse','claims','finance'));
GO
