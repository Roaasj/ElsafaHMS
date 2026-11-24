-- =====================================================================
--  تحديث 016: العيادات (R1b)
--  Clinics = عيادة بمخزنها (StoreId اختياري وواحد لواحد). نسبة العيادة الافتراضية بتتضاف مع شريحة نصيب الدكتور (محاسبية)
--  Doctors.ClinicId = عيادة الدكتور الأساسية. التخصص القديم بيتنقل لعيادات تلقائي عند أول تشغيل
--  الأوامر مفصولة بـ GO
-- =====================================================================
CREATE TABLE Clinics (
  Id              INT IDENTITY(1,1) PRIMARY KEY,
  Name            NVARCHAR(100) NOT NULL UNIQUE,
  StoreId         INT NULL REFERENCES Stores(Id),
  SortOrder       INT NOT NULL DEFAULT 0,
  Active          BIT NOT NULL DEFAULT 1,
  CreatedAt       DATETIME2 NOT NULL
);
GO
CREATE UNIQUE INDEX UX_Clinics_Store ON Clinics (StoreId) WHERE StoreId IS NOT NULL;
GO
ALTER TABLE Doctors ADD ClinicId INT NULL REFERENCES Clinics(Id);
GO
