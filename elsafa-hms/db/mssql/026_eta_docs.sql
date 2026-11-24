-- =====================================================================
--  تحديث 026: تجهيز الإيصال/الفاتورة الإلكترونية (مصلحة الضرايب)
--  EtaDocs = مستند إلكتروني لكل إيصال (الحالة، الـ JSON اللي هيتبعت، رد المنظومة، المحاولات). الأوامر مفصولة بـ GO
-- =====================================================================
CREATE TABLE EtaDocs (
  Id          INT IDENTITY(1,1) PRIMARY KEY,
  Kind        NVARCHAR(10)  NOT NULL,            -- receipt (إيصال) | invoice (فاتورة شركة، مرحلة لاحقة)
  ReceiptId   INT           NOT NULL REFERENCES Receipts(Id),
  Uuid        NVARCHAR(40)  NOT NULL,
  Status      NVARCHAR(12)  NOT NULL,            -- incomplete | ready | submitted | accepted | rejected | failed | skipped
  Env         NVARCHAR(8)   NOT NULL,            -- sim | preprod | prod
  Payload     NVARCHAR(MAX) NULL,
  Response    NVARCHAR(MAX) NULL,
  Message     NVARCHAR(400) NULL,
  Attempts    INT           NOT NULL DEFAULT 0,
  CreatedAt   DATETIME2(0)  NOT NULL,
  SubmittedAt DATETIME2(0)  NULL
);
GO
CREATE UNIQUE INDEX UX_EtaDocs_Receipt ON EtaDocs (ReceiptId, Kind);
GO
CREATE INDEX IX_EtaDocs_Status ON EtaDocs (Status, Id);
GO
