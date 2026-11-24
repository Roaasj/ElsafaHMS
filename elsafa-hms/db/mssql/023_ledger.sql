-- =====================================================================
--  تحديث 023: دليل الحسابات والقيود اليومية (شريحة B)
--  Accounts: شجرة الحسابات (IsGroup = حساب تجميعي مفيهوش قيود). AccountMap: ربط العمليات بالحسابات (من الإعدادات).
--  JournalEntries/JournalLines: القيد المزدوج. الإلغاء = قيد عكسي (ReversalOf)، مفيش مسح. الأوامر مفصولة بـ GO
-- =====================================================================
CREATE TABLE Accounts (
  Id        INT IDENTITY(1,1) PRIMARY KEY,
  Code      NVARCHAR(20)  NOT NULL,
  Name      NVARCHAR(120) NOT NULL,
  Type      NVARCHAR(10)  NOT NULL,
  ParentId  INT           NULL REFERENCES Accounts(Id),
  IsGroup   BIT           NOT NULL DEFAULT 0,
  Active    BIT           NOT NULL DEFAULT 1,
  SortOrder INT           NOT NULL DEFAULT 0,
  CONSTRAINT UQ_Accounts_Code UNIQUE (Code),
  CONSTRAINT CK_Accounts_Type CHECK (Type IN ('asset','liability','equity','revenue','expense'))
);
GO
CREATE TABLE AccountMap (
  [Key]     NVARCHAR(40) NOT NULL PRIMARY KEY,
  AccountId INT          NOT NULL REFERENCES Accounts(Id)
);
GO
CREATE TABLE JournalEntries (
  Id          INT IDENTITY(1,1) PRIMARY KEY,
  EntryNo     INT           NOT NULL,
  EntryDate   DATE          NOT NULL,
  Source      NVARCHAR(30)  NOT NULL,
  SourceId    INT           NULL,
  Description NVARCHAR(300) NOT NULL,
  Status      NVARCHAR(10)  NOT NULL DEFAULT 'posted',
  ReversalOf  INT           NULL REFERENCES JournalEntries(Id),
  CreatedAt   DATETIME2(0)  NOT NULL,
  CreatedBy   INT           NOT NULL REFERENCES Users(Id),
  CONSTRAINT UQ_JournalEntries_No UNIQUE (EntryNo),
  CONSTRAINT CK_JournalEntries_Status CHECK (Status IN ('posted','reversed'))
);
GO
CREATE INDEX IX_JournalEntries_Source ON JournalEntries (Source, SourceId);
GO
CREATE INDEX IX_JournalEntries_Date ON JournalEntries (EntryDate);
GO
CREATE TABLE JournalLines (
  Id        INT IDENTITY(1,1) PRIMARY KEY,
  EntryId   INT           NOT NULL REFERENCES JournalEntries(Id),
  AccountId INT           NOT NULL REFERENCES Accounts(Id),
  Debit     DECIMAL(14,2) NOT NULL DEFAULT 0,
  Credit    DECIMAL(14,2) NOT NULL DEFAULT 0,
  Memo      NVARCHAR(200) NULL
);
GO
CREATE INDEX IX_JournalLines_Entry ON JournalLines (EntryId);
GO
CREATE INDEX IX_JournalLines_Account ON JournalLines (AccountId);
GO
INSERT INTO Counters (Name, Value) VALUES (N'jv', 0);
GO
