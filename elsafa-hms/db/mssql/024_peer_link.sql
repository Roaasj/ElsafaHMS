-- =====================================================================
--  تحديث 024: الربط مع منشأة تانية (المستشفى <-> الصفا كاث)
--  Patients.GlobalId = الرقم العالمي للمريض (نفسه في النسختين).
--  PeerOutbox = طابور تعديلات البيانات التعريفية للمربوطين (بيتبعت لما الاتصال يرجع). الأوامر مفصولة بـ GO
-- =====================================================================
ALTER TABLE Patients ADD GlobalId NVARCHAR(40) NULL;
GO
CREATE UNIQUE INDEX UX_Patients_GlobalId ON Patients (GlobalId) WHERE GlobalId IS NOT NULL;
GO
CREATE TABLE PeerOutbox (
  Id         INT IDENTITY(1,1) PRIMARY KEY,
  GlobalId   NVARCHAR(40)   NOT NULL,
  Op         NVARCHAR(20)   NOT NULL,          -- update | unlink
  Payload    NVARCHAR(MAX)  NOT NULL,
  CreatedAt  DATETIME2(0)   NOT NULL,
  Attempts   INT            NOT NULL DEFAULT 0,
  LastError  NVARCHAR(300)  NULL,
  DoneAt     DATETIME2(0)   NULL
);
GO
CREATE INDEX IX_PeerOutbox_Pending ON PeerOutbox (DoneAt, Id);
GO
