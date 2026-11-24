// حسابات الإقامة: تصنيفات التذكرة وإعداد تشغيلها
import { cents, pounds } from './util.js';
import { R } from './runtime.js';

/** بنود الفاتورة الإجمالية (بالترتيب) */
export const CATS = {
  night: 'الإقامة',
  service: 'الخدمات',
  drug: 'الأدوية',
  supply: 'المستلزمات',
  fee: 'أتعاب الأطباء',
  visit: 'الزيارات',
};
/** اللي بيتكتب من التذكرة (الليالي بتتحسب لوحدها) */
export const TICKET_CATS = ['service', 'drug', 'supply', 'fee', 'visit'];
export const STOCK_KINDS = { drug: 'دواء', supply: 'مستلزم' };
/** قسم التغطية في التعاقد للأدوية والمستلزمات */
export const COVER_DEPT = { drug: 'drugs', supply: 'supplies' };

/** نظام التذكرة شغال؟ (الحسابات بس بتكتب البنود، والخروج محتاج قفل) */
export async function ticketOn(db) {
  const r = await db.one("SELECT Value FROM AppSettings WHERE [Key] = 'ticketMode'");
  return (r?.Value ?? 'on') !== 'off';
}

/** سعر الصنف للجهة: الجهات اللي بالخصم بتاخد نفس نسبة الخصم، والباقي بسعر النقدي */
export function stockPrice(payer, cashCents) {
  if (payer?.priceMode === 'discount' && payer.discountPct) return R.money.discount(cashCents, payer.discountPct);
  return cashCents;
}

export function stockDto(r) {
  return {
    id: r.Id, code: r.Code, name: r.Name, kind: r.Kind, unit: r.Unit || '', price: pounds(cents(r.Price)),
    barcode: r.Barcode || '', active: !!Number(r.Active),
    midUnit: r.MidUnit || '', midQty: r.MidQty == null ? null : Number(r.MidQty), packUnit: r.PackUnit || '', packQty: r.PackQty == null ? null : Number(r.PackQty),
    minQty: r.MinQty == null ? null : Number(r.MinQty), saleUnit: r.DefaultSaleUnit || '', purchaseUnit: r.DefaultPurchaseUnit || '',
  };
}
