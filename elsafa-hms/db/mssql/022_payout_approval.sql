-- =====================================================================
--  تحديث 022: اعتماد مستحقات الأطباء (شريحة A)
--  DoctorPayouts: ApprovedAt/ApprovedBy (الاعتماد) و EditedAt/EditedBy/EditNote (آخر تعديل بصلاحية).
--  مفيش حالة جديدة: «مستني الاعتماد» = Status issued ومفيش VoucherId. الأوامر مفصولة بـ GO
-- =====================================================================
ALTER TABLE DoctorPayouts ADD ApprovedAt DATETIME2(0) NULL;
GO
ALTER TABLE DoctorPayouts ADD ApprovedBy INT NULL REFERENCES Users(Id);
GO
ALTER TABLE DoctorPayouts ADD EditedAt DATETIME2(0) NULL;
GO
ALTER TABLE DoctorPayouts ADD EditedBy INT NULL REFERENCES Users(Id);
GO
ALTER TABLE DoctorPayouts ADD EditNote NVARCHAR(300) NULL;
GO
