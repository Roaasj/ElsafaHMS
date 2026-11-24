-- =====================================================================
--  تحديث 008: أسعار الأدوار (نفس الخدمة ونفس الدرجة، وسعر مختلف حسب الدور)
--  الأوامر مفصولة بـ GO، وبيشتغل زي ما هو على SQLite كمان
-- =====================================================================

-- سعر الخدمة في دور معين (للمقيمين بس). مفيش سطر = السعر الأساسي
CREATE TABLE FloorServicePrices (
  Id         INT IDENTITY(1,1) PRIMARY KEY,
  FloorId    INT            NOT NULL REFERENCES Floors(Id),
  ServiceId  INT            NOT NULL REFERENCES Services(Id),
  Price      DECIMAL(12,2)  NOT NULL,
  UpdatedAt  DATETIME2(0)   NOT NULL,
  UpdatedBy  INT            NULL REFERENCES Users(Id),
  CONSTRAINT UQ_FloorServicePrices UNIQUE (FloorId, ServiceId),
  CONSTRAINT CK_FloorServicePrices_Price CHECK (Price >= 0)
);
GO
-- سعر ليلة الدرجة في دور معين. مفيش سطر = سعر الدرجة الأساسي
CREATE TABLE FloorClassPrices (
  Id          INT IDENTITY(1,1) PRIMARY KEY,
  FloorId     INT            NOT NULL REFERENCES Floors(Id),
  ClassId     INT            NOT NULL REFERENCES RoomClasses(Id),
  NightPrice  DECIMAL(12,2)  NOT NULL,
  UpdatedAt   DATETIME2(0)   NOT NULL,
  UpdatedBy   INT            NULL REFERENCES Users(Id),
  CONSTRAINT UQ_FloorClassPrices UNIQUE (FloorId, ClassId),
  CONSTRAINT CK_FloorClassPrices_Price CHECK (NightPrice >= 0)
);
GO
-- الدور اللي اتسعّر عليه البند
ALTER TABLE AdmissionItems ADD FloorId INT NULL;
GO
