-- =====================================================================
--  تحديث 018: الأدوار والصلاحيات كبيانات (R1b-2أ)
--  Roles = الدور واسمه. RolePermissions = صلاحيات الدور ('*' = كل الصلاحيات). الأدوار الحالية بتتزرع تلقائي بنفس صلاحياتها بالظبط
--  شلنا قيد CK_Users_Role عشان الأدوار الجديدة تتضاف من غير تعديل قاعدة البيانات
--  الأوامر مفصولة بـ GO
-- =====================================================================
ALTER TABLE Users DROP CONSTRAINT CK_Users_Role;
GO
CREATE TABLE Roles (
  Code      NVARCHAR(30) NOT NULL PRIMARY KEY,
  Name      NVARCHAR(80) NOT NULL,
  Description NVARCHAR(300) NULL,
  Color     NVARCHAR(30) NULL,
  Home      NVARCHAR(30) NOT NULL DEFAULT '/',
  IsSystem  BIT NOT NULL DEFAULT 0,
  Active    BIT NOT NULL DEFAULT 1,
  SortOrder INT NOT NULL DEFAULT 0
);
GO
CREATE TABLE RolePermissions (
  RoleCode NVARCHAR(30) NOT NULL REFERENCES Roles(Code),
  Perm     NVARCHAR(60) NOT NULL,
  PRIMARY KEY (RoleCode, Perm)
);
GO
