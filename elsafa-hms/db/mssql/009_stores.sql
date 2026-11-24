-- =====================================================================
--  تحديث 009: المخازن (الرئيسي، الصيدلية، مخازن الأدوار والأقسام)، الوحدات، التشغيلات والصلاحية،
--  الاستلام من الموردين، التحويلات، والخصم من مخزن الدور مع التذكرة
--  الأوامر مفصولة بـ GO. الجزء قبل «@alters» بيشتغل زي ما هو على SQLite كمان
-- =====================================================================

-- صلاحيات إضافية لكل مستخدم (JSON) ومخازنه
ALTER TABLE Users ADD Grants NVARCHAR(400) NULL;
GO
ALTER TABLE Users ADD StoreIds NVARCHAR(400) NULL;
GO
-- Kind: main رئيسي | pharmacy صيدلية | sub فرعي (دور/عيادة/قسم). Holds: drug | supply | all
CREATE TABLE Stores (
  Id         INT IDENTITY(1,1) PRIMARY KEY,
  Name       NVARCHAR(80)   NOT NULL,
  Kind       NVARCHAR(10)   NOT NULL,
  Holds      NVARCHAR(10)   NOT NULL DEFAULT 'all',
  FloorId    INT            NULL REFERENCES Floors(Id),
  Notes      NVARCHAR(200)  NULL,
  SortOrder  INT            NOT NULL DEFAULT 0,
  Active     BIT            NOT NULL DEFAULT 1,
  CreatedAt  DATETIME2(0)   NOT NULL,
  CONSTRAINT CK_Stores_Kind CHECK (Kind IN ('main','pharmacy','sub')),
  CONSTRAINT CK_Stores_Holds CHECK (Holds IN ('drug','supply','all'))
);
GO
-- الوحدات: Unit = أصغر وحدة (السعر عليها)، والوسطى والكبيرة بعددهم من الصغيرة
ALTER TABLE StockItems ADD MidUnit NVARCHAR(30) NULL;
GO
ALTER TABLE StockItems ADD MidQty INT NULL;
GO
ALTER TABLE StockItems ADD PackUnit NVARCHAR(30) NULL;
GO
ALTER TABLE StockItems ADD PackQty INT NULL;
GO
ALTER TABLE StockItems ADD MinQty DECIMAL(12,2) NULL;
GO
ALTER TABLE StockItems ADD LastCost DECIMAL(12,4) NULL;
GO
-- الرصيد بالتشغيلة والصلاحية (بأصغر وحدة). التشغيلة الفاضية = رصيد من غير تشغيلة (ومنها السالب)
CREATE TABLE StockBatches (
  Id         INT IDENTITY(1,1) PRIMARY KEY,
  ItemId     INT            NOT NULL REFERENCES StockItems(Id),
  StoreId    INT            NOT NULL REFERENCES Stores(Id),
  BatchNo    NVARCHAR(40)   NULL,
  Expiry     DATE           NULL,
  Qty        DECIMAL(14,2)  NOT NULL DEFAULT 0,
  Cost       DECIMAL(12,4)  NULL,
  CreatedAt  DATETIME2(0)   NOT NULL
);
GO
CREATE INDEX IX_StockBatches_StoreItem ON StockBatches (StoreId, ItemId);
GO
-- كل حركة مخزن. Qty موجبة دخول وسالبة خروج
CREATE TABLE StockMoves (
  Id        INT IDENTITY(1,1) PRIMARY KEY,
  At        DATETIME2(0)   NOT NULL,
  Kind      NVARCHAR(16)   NOT NULL,
  ItemId    INT            NOT NULL REFERENCES StockItems(Id),
  StoreId   INT            NOT NULL REFERENCES Stores(Id),
  BatchId   INT            NULL REFERENCES StockBatches(Id),
  Qty       DECIMAL(14,2)  NOT NULL,
  Cost      DECIMAL(12,4)  NULL,
  RefType   NVARCHAR(16)   NULL,
  RefId     INT            NULL,
  UserId    INT            NULL REFERENCES Users(Id),
  Note      NVARCHAR(200)  NULL
);
GO
CREATE INDEX IX_StockMoves_ItemStore ON StockMoves (ItemId, StoreId, At);
GO
CREATE INDEX IX_StockMoves_Ref ON StockMoves (RefType, RefId);
GO
-- الاستلام من الموردين (ورصيد أول المدة)
CREATE TABLE Purchases (
  Id           INT IDENTITY(1,1) PRIMARY KEY,
  PurchaseNo   INT            NOT NULL,
  Kind         NVARCHAR(10)   NOT NULL DEFAULT 'supplier',
  StoreId      INT            NOT NULL REFERENCES Stores(Id),
  Supplier     NVARCHAR(150)  NULL,
  InvoiceNo    NVARCHAR(40)   NULL,
  InvoiceDate  DATE           NULL,
  Total        DECIMAL(14,2)  NOT NULL DEFAULT 0,
  Note         NVARCHAR(300)  NULL,
  CreatedAt    DATETIME2(0)   NOT NULL,
  CreatedBy    INT            NOT NULL REFERENCES Users(Id),
  CONSTRAINT UQ_Purchases_No UNIQUE (PurchaseNo),
  CONSTRAINT CK_Purchases_Kind CHECK (Kind IN ('supplier','opening'))
);
GO
CREATE TABLE PurchaseLines (
  Id          INT IDENTITY(1,1) PRIMARY KEY,
  PurchaseId  INT            NOT NULL REFERENCES Purchases(Id),
  ItemId      INT            NOT NULL REFERENCES StockItems(Id),
  UnitName    NVARCHAR(30)   NULL,
  UnitFactor  INT            NOT NULL DEFAULT 1,
  Qty         DECIMAL(12,2)  NOT NULL,
  BaseQty     DECIMAL(14,2)  NOT NULL,
  UnitCost    DECIMAL(12,4)  NOT NULL DEFAULT 0,
  BatchNo     NVARCHAR(40)   NULL,
  Expiry      DATE           NULL,
  LineTotal   DECIMAL(14,2)  NOT NULL DEFAULT 0,
  BatchId     INT            NULL
);
GO
CREATE INDEX IX_PurchaseLines_Purchase ON PurchaseLines (PurchaseId);
GO
-- التحويلات: requested طلب ← issued اتصرف من المخزن ← received الفرعي استلم ← confirmed الرئيسي أكّد
CREATE TABLE Transfers (
  Id            INT IDENTITY(1,1) PRIMARY KEY,
  TransferNo    INT            NOT NULL,
  FromStoreId   INT            NOT NULL REFERENCES Stores(Id),
  ToStoreId     INT            NOT NULL REFERENCES Stores(Id),
  Status        NVARCHAR(10)   NOT NULL,
  Direct        BIT            NOT NULL DEFAULT 0,
  Note          NVARCHAR(300)  NULL,
  RequestedAt   DATETIME2(0)   NULL,
  RequestedBy   INT            NULL REFERENCES Users(Id),
  IssuedAt      DATETIME2(0)   NULL,
  IssuedBy      INT            NULL REFERENCES Users(Id),
  ReceivedAt    DATETIME2(0)   NULL,
  ReceivedBy    INT            NULL REFERENCES Users(Id),
  ConfirmedAt   DATETIME2(0)   NULL,
  ConfirmedBy   INT            NULL REFERENCES Users(Id),
  CancelledAt   DATETIME2(0)   NULL,
  CancelledBy   INT            NULL REFERENCES Users(Id),
  CancelReason  NVARCHAR(300)  NULL,
  CreatedAt     DATETIME2(0)   NOT NULL,
  CONSTRAINT UQ_Transfers_No UNIQUE (TransferNo),
  CONSTRAINT CK_Transfers_Status CHECK (Status IN ('requested','issued','received','confirmed','cancelled'))
);
GO
CREATE INDEX IX_Transfers_Status ON Transfers (Status, CreatedAt);
GO
CREATE TABLE TransferLines (
  Id           INT IDENTITY(1,1) PRIMARY KEY,
  TransferId   INT            NOT NULL REFERENCES Transfers(Id),
  ItemId       INT            NOT NULL REFERENCES StockItems(Id),
  ReqQty       DECIMAL(14,2)  NOT NULL DEFAULT 0,
  IssuedQty    DECIMAL(14,2)  NULL,
  Note         NVARCHAR(200)  NULL
);
GO
CREATE INDEX IX_TransferLines_Transfer ON TransferLines (TransferId);
GO
-- بند التذكرة: الوحدة اللي اتكتب بيها (عددها من أصغر وحدة) والمخزن اللي اتخصم منه
ALTER TABLE AdmissionItems ADD UnitFactor INT NULL;
GO
ALTER TABLE AdmissionItems ADD StoreId INT NULL;
GO
ALTER TABLE LateCharges ADD StoreId INT NULL;
GO
INSERT INTO Counters (Name, Value) VALUES (N'purchase', 0);
GO
INSERT INTO Counters (Name, Value) VALUES (N'transfer', 0);
GO
-- on: الأدوية والمستلزمات في التذكرة بتتخصم من مخزن الدور
INSERT INTO AppSettings ([Key], Value) VALUES (N'stockDeduct', N'on');
GO
-- @alters (SQL Server بس: أدوار المخازن)
ALTER TABLE Users DROP CONSTRAINT CK_Users_Role;
GO
ALTER TABLE Users ADD CONSTRAINT CK_Users_Role CHECK (Role IN ('reception','supervisor','reviewer','manager','cashier','radiology','lab','accounts','accsuper','storekeeper','storeacc','pharmacist','nurse'));
GO
