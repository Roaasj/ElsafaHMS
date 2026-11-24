-- =====================================================================
--  تحديث 021: قوائم أسعار مستقلة للتعاقدات
--  قايمة باسم (مثلًا «لائحة التأمين 2026») أكتر من جهة تربط بيها (Payers.PriceListId). الجهة اللي من غير قايمة بتفضل بأسعارها الخاصة زي ما هي
--  الأوامر مفصولة بـ GO
-- =====================================================================
CREATE TABLE PriceLists (
  Id        INT IDENTITY(1,1) PRIMARY KEY,
  Name      NVARCHAR(120) NOT NULL,
  Active    BIT NOT NULL DEFAULT 1,
  CreatedAt DATETIME2(0) NOT NULL,
  CONSTRAINT UQ_PriceLists_Name UNIQUE (Name)
);
GO
CREATE TABLE PriceListItems (
  Id        INT IDENTITY(1,1) PRIMARY KEY,
  ListId    INT NOT NULL REFERENCES PriceLists(Id),
  ServiceId INT NOT NULL REFERENCES Services(Id),
  Price     DECIMAL(18,2) NOT NULL,
  CONSTRAINT UQ_PriceListItems UNIQUE (ListId, ServiceId),
  CONSTRAINT CK_PriceListItems CHECK (Price >= 0)
);
GO
CREATE TABLE PriceListClassPrices (
  Id         INT IDENTITY(1,1) PRIMARY KEY,
  ListId     INT NOT NULL REFERENCES PriceLists(Id),
  ClassId    INT NOT NULL REFERENCES RoomClasses(Id),
  NightPrice DECIMAL(18,2) NOT NULL,
  CONSTRAINT UQ_PriceListClassPrices UNIQUE (ListId, ClassId),
  CONSTRAINT CK_PriceListClassPrices CHECK (NightPrice >= 0)
);
GO
ALTER TABLE Payers ADD PriceListId INT NULL REFERENCES PriceLists(Id);
GO
