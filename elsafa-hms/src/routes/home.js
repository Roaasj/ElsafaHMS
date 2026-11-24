// ملخص الشاشة الرئيسية
import { router } from '../lib/router.js';
import { need } from '../lib/auth.js';
import { cents, pounds, cairoDayRange } from '../lib/util.js';
import { toIso } from '../db/index.js';
import { cashierOnDuty, SHIFT_LABELS } from '../lib/cashier.js';
import { radCounts } from './radiology.js';
import { labCounts } from './lab.js';
import { ticketCounts } from './tickets.js';
import { can } from '../lib/auth.js';

export default function homeRouter(db) {
  const r = router();
  r.get('/summary', async (req, res) => {
    need(req.user, 'visits.read');
    const tickets = can(req.user, 'adm.bill') ? await ticketCounts(db) : null;
    const { start, end } = cairoDayRange();
    const shift = await db.one(db.top('SELECT Id, OpenedAt, Label FROM Shifts WHERE UserId = ? AND ClosedAt IS NULL ORDER BY Id DESC', 1), [req.user.id]);
    let mine = { net: 0, cash: 0, card: 0, credit: 0, count: 0 };
    if (shift) {
      const s = await db.one(
        `SELECT SUM(Net) AS Net, SUM(Cash) AS Cash, SUM(Card) AS Card, SUM(Credit) AS Credit,
                SUM(CASE WHEN Kind = 'payment' THEN 1 ELSE 0 END) AS Cnt
           FROM Receipts WHERE ShiftId = ?`, [shift.Id]);
      mine = { net: pounds(cents(s.Net)), cash: pounds(cents(s.Cash)), card: pounds(cents(s.Card)), credit: pounds(cents(s.Credit)), count: Number(s.Cnt || 0) };
    }
    const visits = await db.query('SELECT Type, COUNT(*) AS N FROM Visits WHERE OpenedAt >= ? AND OpenedAt < ? GROUP BY Type', [start, end]);
    const open = await db.one(
      `SELECT COUNT(*) AS N FROM Visits v WHERE v.Status = 'open'
          AND EXISTS (SELECT 1 FROM VisitItems i WHERE i.VisitId = v.Id AND i.Status = 'active' AND i.PaidReceiptId IS NULL)`);
    const newPatients = await db.one('SELECT COUNT(*) AS N FROM Patients WHERE CreatedAt >= ? AND CreatedAt < ?', [start, end]);
    const beds = await db.query(
      `SELECT b.Status, (SELECT COUNT(*) FROM Admissions a WHERE a.BedId = b.Id AND a.Status = 'active') AS Occ
         FROM Beds b JOIN Rooms r ON r.Id = b.RoomId JOIN Floors f ON f.Id = r.FloorId WHERE b.Active = 1 AND r.Active = 1 AND f.Active = 1`);
    const bedStat = { total: beds.length, occupied: 0, free: 0, cleaning: 0, reserved: 0 };
    for (const b of beds) bedStat[Number(b.Occ) ? 'occupied' : b.Status]++;
    const admToday = await db.one('SELECT COUNT(*) AS N FROM Admissions WHERE AdmittedAt >= ? AND AdmittedAt < ?', [start, end]);
    const disToday = await db.one('SELECT COUNT(*) AS N FROM Admissions WHERE DischargedAt >= ? AND DischargedAt < ?', [start, end]);
    const recent = await db.query(db.top(
      `SELECT r.Id, r.ReceiptNo, r.Kind, r.Net, r.CreatedAt, p.FullName FROM Receipts r JOIN Patients p ON p.Id = r.PatientId
        WHERE r.CreatedBy = ? ORDER BY r.Id DESC`, 5), [req.user.id]);
    const ap = await db.one("SELECT SUM(CASE WHEN Status = 'pending' THEN 1 ELSE 0 END) AS P, SUM(CASE WHEN Status = 'tempcash' THEN 1 ELSE 0 END) AS T FROM Approvals");
    const ord = await db.one("SELECT COUNT(*) AS N, SUM(Amount) AS S FROM PayOrders WHERE Status = 'pending'");
    const hand = await db.one('SELECT COUNT(*) AS N FROM Shifts WHERE HandedTo = ? AND ReceivedAt IS NULL AND ClosedAt IS NOT NULL', [req.user.id]);
    const duty = await cashierOnDuty(db);
    const radiology = can(req.user, 'rad.work') ? await radCounts(db) : null;
    const lab = can(req.user, 'lab.work') ? await labCounts(db) : null;
    res.json({
      radiology, lab, tickets,
      orders: { count: Number(ord.N || 0), amount: pounds(cents(ord.S)) },
      handovers: Number(hand.N || 0),
      cashier: duty ? { name: duty.FullName, userId: duty.UserId } : null,
      approvals: { pending: Number(ap?.P || 0), tempcash: Number(ap?.T || 0) },
      shift: shift ? { id: shift.Id, openedAt: toIso(shift.OpenedAt), label: SHIFT_LABELS[shift.Label] || '', ...mine } : null,
      today: {
        byType: Object.fromEntries(visits.map((v) => [v.Type, Number(v.N)])),
        visits: visits.reduce((s, v) => s + Number(v.N), 0),
        newPatients: Number(newPatients.N),
        openWithDue: Number(open.N),
        admitted: Number(admToday.N), discharged: Number(disToday.N),
      },
      beds: bedStat,
      recent: recent.map((x) => ({ id: x.Id, no: x.ReceiptNo, kind: x.Kind, net: pounds(cents(x.Net)), at: toIso(x.CreatedAt), patient: x.FullName })),
    });
  });
  return r;
}
