-- =====================================================================
--  تحديث 010: مخازن الأقسام، الصرف من مخزن تختاره في التذكرة، صرف الأدوية والمستلزمات في الزيارة،
--  بيع الصيدلية، المرتجعات، الجرد، والإعدام
--  الأوامر مفصولة بـ GO. الجزء قبل «@alters» بيشتغل زي ما هو على SQLite كمان
-- =====================================================================

-- القسم اللي المخزن تبعه (عشان البرنامج يختاره لوحده): or عمليات | icu عناية | nursery حضانة | emergency طوارئ | clinic عيادات | lab | radiology
ALTER TABLE Stores ADD Dept NVARCHAR(20) NULL;
GO
-- الدفعة اتصرفت من أنهي مخزن
ALTER TABLE Tickets ADD StoreId INT NULL;
GO
-- صرف صنف في الزيارة الخارجية (والصيدلية)
ALTER TABLE VisitItems ADD StockItemId INT NULL;
GO
ALTER TABLE VisitItems ADD StoreId INT NULL;
GO
ALTER TABLE VisitItems ADD UnitFactor INT NULL;
GO
ALTER TABLE VisitItems ADD ReturnedQty INT NOT NULL DEFAULT 0;
GO
-- الجرد: المخزن بيقف لحد ما الجرد يتعتمد أو يتلغي
-- Status: open بيتعد ← submitted اتسلّم للاعتماد ← approved اتعتمد والرصيد اتظبط | cancelled
CREATE TABLE StockCounts (
  Id           INT IDENTITY(1,1) PRIMARY KEY,
  CountNo      INT            NOT NULL,
  StoreId      INT            NOT NULL REFERENCES Stores(Id),
  Status       NVARCHAR(10)   NOT NULL,
  Note         NVARCHAR(300)  NULL,
  CreatedAt    DATETIME2(0)   NOT NULL,
  CreatedBy    INT            NOT NULL REFERENCES Users(Id),
  SubmittedAt  DATETIME2(0)   NULL,
  SubmittedBy  INT            NULL REFERENCES Users(Id),
  ApprovedAt   DATETIME2(0)   NULL,
  ApprovedBy   INT            NULL REFERENCES Users(Id),
  CancelledAt  DATETIME2(0)   NULL,
  CancelledBy  INT            NULL REFERENCES Users(Id),
  DiffValue    DECIMAL(14,2)  NULL,
  CONSTRAINT UQ_StockCounts_No UNIQUE (CountNo),
  CONSTRAINT CK_StockCounts_Status CHECK (Status IN ('open','submitted','approved','cancelled'))
);
GO
CREATE TABLE StockCountLines (
  Id          INT IDENTITY(1,1) PRIMARY KEY,
  CountId     INT            NOT NULL REFERENCES StockCounts(Id),
  ItemId      INT            NOT NULL REFERENCES StockItems(Id),
  BatchId     INT            NULL REFERENCES StockBatches(Id),
  BatchNo     NVARCHAR(40)   NULL,
  Expiry      DATE           NULL,
  SystemQty   DECIMAL(14,2)  NOT NULL DEFAULT 0,
  CountedQty  DECIMAL(14,2)  NULL,
  Cost        DECIMAL(12,4)  NULL
);
GO
CREATE INDEX IX_StockCountLines_Count ON StockCountLines (CountId);
GO
-- الإعدام (منتهي، تالف، مكسور)
CREATE TABLE StockWaste (
  Id         INT IDENTITY(1,1) PRIMARY KEY,
  WasteNo    INT            NOT NULL,
  StoreId    INT            NOT NULL REFERENCES Stores(Id),
  ItemId     INT            NOT NULL REFERENCES StockItems(Id),
  BatchId    INT            NULL REFERENCES StockBatches(Id),
  Qty        DECIMAL(14,2)  NOT NULL,
  Cost       DECIMAL(12,4)  NULL,
  Reason     NVARCHAR(300)  NOT NULL,
  CreatedAt  DATETIME2(0)   NOT NULL,
  CreatedBy  INT            NOT NULL REFERENCES Users(Id)
);
GO
INSERT INTO Counters (Name, Value) VALUES (N'count', 0);
GO
INSERT INTO Counters (Name, Value) VALUES (N'waste', 0);
GO
-- @alters (SQL Server بس: بند الزيارة ممكن يبقى صنف من غير خدمة، ونوع زيارة «الصيدلية»)
DECLARE @fk3 sysname;
SELECT @fk3 = fk.name FROM sys.foreign_keys fk
  JOIN sys.foreign_key_columns c ON c.constraint_object_id = fk.object_id
  JOIN sys.columns col ON col.object_id = c.parent_object_id AND col.column_id = c.parent_column_id
 WHERE fk.parent_object_id = OBJECT_ID(N'dbo.VisitItems') AND col.name = N'ServiceId';
IF @fk3 IS NOT NULL EXEC (N'ALTER TABLE dbo.VisitItems DROP CONSTRAINT [' + @fk3 + N']');
GO
ALTER TABLE VisitItems ALTER COLUMN ServiceId INT NULL;
GO
ALTER TABLE VisitItems ADD CONSTRAINT FK_VisitItems_Service FOREIGN KEY (ServiceId) REFERENCES Services(Id);
GO
ALTER TABLE Visits DROP CONSTRAINT CK_Visits_Type;
GO
ALTER TABLE Visits ADD CONSTRAINT CK_Visits_Type CHECK (Type IN ('clinic','emergency','lab','radiology','pharmacy'));
GO
