-- =====================================================================
--  تحديث 013: القوائم المرجعية (Lookups)
--  بدل قيود CHECK على أنواع بتختلف من مستشفى لمستشفى: الأقسام، أنواع الدخول،
--  أنواع الغرف. كل قيمة ليها اسم ولون وأيقونة وسلوك (Behavior) والكود
--  بيتعامل مع السلوك مش مع الاسم. المدير بيضيف ويعدّل ويوقف من الشاشة.
--  الأوامر مفصولة بـ GO. الجزء قبل «@alters» بيشتغل زي ما هو على SQLite كمان.
-- =====================================================================

-- Domain: dept | admission_type | room_kind
-- Behavior (للأقسام): clinic | emergency | lab | radiology | ward | or | service
-- Meta: JSON (prefix, visit, pay, roomKind ...)
CREATE TABLE LookupValues (
  Id         INT IDENTITY(1,1) PRIMARY KEY,
  Domain     NVARCHAR(30)  NOT NULL,
  Code       NVARCHAR(30)  NOT NULL,
  Name       NVARCHAR(100) NOT NULL,
  ShortName  NVARCHAR(40)  NULL,
  Color      NVARCHAR(9)   NULL,
  Icon       NVARCHAR(30)  NULL,
  Behavior   NVARCHAR(30)  NULL,
  SortOrder  INT           NOT NULL DEFAULT 0,
  Active     BIT           NOT NULL DEFAULT 1,
  Meta       NVARCHAR(MAX) NULL,
  CONSTRAINT UQ_LookupValues UNIQUE (Domain, Code)
);
GO

-- القالب الافتراضي: أقسام عامة أي مستشفى بتبدأ بيها (تتعدّل أو تتوقف أو تتمسح لو مش مستخدمة)
INSERT INTO LookupValues (Domain, Code, Name, ShortName, Color, Icon, Behavior, SortOrder, Meta) VALUES ('dept', 'clinic', N'العيادات', N'عيادة', '#0e8a87', 'steth', 'clinic', 10, '{"visit":true,"prefix":"CL"}');
GO
INSERT INTO LookupValues (Domain, Code, Name, ShortName, Color, Icon, Behavior, SortOrder, Meta) VALUES ('dept', 'emergency', N'الطوارئ', N'طوارئ', '#e2474f', 'bolt', 'emergency', 20, '{"visit":true,"prefix":"ER","pay":"after"}');
GO
INSERT INTO LookupValues (Domain, Code, Name, ShortName, Color, Icon, Behavior, SortOrder, Meta) VALUES ('dept', 'lab', N'المعمل', N'معمل', '#6c55d1', 'flask', 'lab', 30, '{"visit":true,"prefix":"LAB"}');
GO
INSERT INTO LookupValues (Domain, Code, Name, ShortName, Color, Icon, Behavior, SortOrder, Meta) VALUES ('dept', 'radiology', N'الأشعة', N'أشعة', '#2c6ddc', 'scan', 'radiology', 40, '{"visit":true,"prefix":"RAD"}');
GO
INSERT INTO LookupValues (Domain, Code, Name, ShortName, Color, Icon, Behavior, SortOrder, Meta) VALUES ('dept', 'ward', N'خدمات الإقامة', N'إقامة', '#b5651d', 'bed', 'ward', 50, '{"visit":false,"prefix":"IP"}');
GO
INSERT INTO LookupValues (Domain, Code, Name, ShortName, Color, Icon, Behavior, SortOrder, Meta) VALUES ('dept', 'or', N'العمليات', N'عمليات', '#4f5bd5', 'scalpel', 'or', 60, '{"visit":false,"prefix":"OR"}');
GO

-- أنواع الدخول: roomKind = نوع الغرفة اللي بتناسبه
INSERT INTO LookupValues (Domain, Code, Name, ShortName, Color, Icon, Behavior, SortOrder, Meta) VALUES ('admission_type', 'inpatient', N'داخلي', N'داخلي', '#d0661c', 'bed', 'standard', 10, '{"roomKind":"ward"}');
GO
INSERT INTO LookupValues (Domain, Code, Name, ShortName, Color, Icon, Behavior, SortOrder, Meta) VALUES ('admission_type', 'surgery', N'عمليات', N'عمليات', '#4f5bd5', 'scalpel', 'surgery', 20, '{"roomKind":"ward"}');
GO
INSERT INTO LookupValues (Domain, Code, Name, ShortName, Color, Icon, Behavior, SortOrder, Meta) VALUES ('admission_type', 'icu', N'عناية', N'عناية', '#d23c4f', 'heart', 'standard', 30, '{"roomKind":"icu"}');
GO
INSERT INTO LookupValues (Domain, Code, Name, ShortName, Color, Icon, Behavior, SortOrder, Meta) VALUES ('admission_type', 'nursery', N'حضانة', N'حضانة', '#d4508f', 'baby', 'standard', 40, '{"roomKind":"nursery"}');
GO

-- أنواع الغرف
INSERT INTO LookupValues (Domain, Code, Name, ShortName, Color, Icon, Behavior, SortOrder) VALUES ('room_kind', 'ward', N'إقامة', N'إقامة', '#d0661c', 'bed', NULL, 10);
GO
INSERT INTO LookupValues (Domain, Code, Name, ShortName, Color, Icon, Behavior, SortOrder) VALUES ('room_kind', 'icu', N'عناية', N'عناية', '#d23c4f', 'heart', NULL, 20);
GO
INSERT INTO LookupValues (Domain, Code, Name, ShortName, Color, Icon, Behavior, SortOrder) VALUES ('room_kind', 'nursery', N'حضانة', N'حضانة', '#d4508f', 'baby', NULL, 30);
GO
-- @alters (SQL Server بس: شيل قيود CHECK اللي كانت بتقفل القوايم دي)
IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_Services_Dept') ALTER TABLE Services DROP CONSTRAINT CK_Services_Dept;
GO
IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_Visits_Type') ALTER TABLE Visits DROP CONSTRAINT CK_Visits_Type;
GO
IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_Admissions_Type') ALTER TABLE Admissions DROP CONSTRAINT CK_Admissions_Type;
GO
IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_RoomClasses_Kind') ALTER TABLE RoomClasses DROP CONSTRAINT CK_RoomClasses_Kind;
GO
