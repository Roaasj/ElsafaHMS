-- =====================================================================
--  تحديث 025: طلبات الخدمات بين المنشأتين وأحداث الانتقال (الصفا كاث)
--  PeerRequests = طلب خدمة جه من المنشأة التانية (بند زيارة عندنا + مين طلبه + حالة التنفيذ).
--  PeerEvents  = أحداث انتقال المريض (راح للمنشأة التانية / رجع منها). الأوامر مفصولة بـ GO
-- =====================================================================
CREATE TABLE PeerRequests (
  Id           INT IDENTITY(1,1) PRIMARY KEY,
  GlobalId     NVARCHAR(40)  NOT NULL,
  PatientId    INT           NOT NULL REFERENCES Patients(Id),
  VisitId      INT           NOT NULL REFERENCES Visits(Id),
  VisitItemId  INT           NOT NULL REFERENCES VisitItems(Id),
  FromName     NVARCHAR(100) NULL,           -- المنشأة اللي طلبت
  FromUser     NVARCHAR(100) NULL,           -- الموظف اللي طلب
  Note         NVARCHAR(300) NULL,
  Status       NVARCHAR(12)  NOT NULL DEFAULT 'new',   -- new | done | cancelled
  CreatedAt    DATETIME2(0)  NOT NULL,
  DoneAt       DATETIME2(0)  NULL,
  DoneBy       INT           NULL REFERENCES Users(Id),
  CancelReason NVARCHAR(200) NULL
);
GO
CREATE INDEX IX_PeerRequests_Status ON PeerRequests (Status, Id);
GO
CREATE INDEX IX_PeerRequests_Global ON PeerRequests (GlobalId);
GO
CREATE TABLE PeerEvents (
  Id         INT IDENTITY(1,1) PRIMARY KEY,
  GlobalId   NVARCHAR(40)  NOT NULL,
  PatientId  INT           NOT NULL REFERENCES Patients(Id),
  Kind       NVARCHAR(12)  NOT NULL,           -- to_peer (راح للمنشأة التانية) | from_peer (رجع منها)
  Origin     NVARCHAR(8)   NOT NULL,           -- local | remote
  At         DATETIME2(0)  NOT NULL,
  ByName     NVARCHAR(100) NULL,
  Note       NVARCHAR(200) NULL
);
GO
CREATE INDEX IX_PeerEvents_Patient ON PeerEvents (PatientId, Id);
GO
