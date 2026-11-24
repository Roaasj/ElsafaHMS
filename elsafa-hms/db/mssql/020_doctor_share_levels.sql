-- =====================================================================
--  تحديث 020: نصيب الدكتور على الخدمة والعيادة (R1c-share)
--  Services/Clinics: نسبة % أو مبلغ ثابت للوحدة (واحد منهم بس). VisitItems/AdmissionItems.DoctorFixed = المبلغ الثابت وقت التسجيل (0 = مفيش)
--  الأولوية: صف الدكتور (استثناء) > نسبة الخدمة > نسبة العيادة > صفر. الأوامر مفصولة بـ GO
-- =====================================================================
ALTER TABLE Services ADD SharePct DECIMAL(5,2) NULL;
GO
ALTER TABLE Services ADD ShareFixed DECIMAL(18,2) NULL;
GO
ALTER TABLE Clinics ADD SharePct DECIMAL(5,2) NULL;
GO
ALTER TABLE Clinics ADD ShareFixed DECIMAL(18,2) NULL;
GO
ALTER TABLE VisitItems ADD DoctorFixed DECIMAL(18,2) NOT NULL DEFAULT 0;
GO
ALTER TABLE AdmissionItems ADD DoctorFixed DECIMAL(18,2) NOT NULL DEFAULT 0;
GO
