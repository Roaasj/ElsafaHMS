// Router بيمسك أخطاء الدوال async ويبعتها لمعالج الأخطاء
import { Router } from 'express';

export function router() {
  const r = Router();
  for (const m of ['get', 'post', 'put', 'delete', 'patch']) {
    const orig = r[m].bind(r);
    r[m] = (path, ...handlers) => orig(path, ...handlers.map((h) => (req, res, next) => {
      try { Promise.resolve(h(req, res, next)).catch(next); } catch (e) { next(e); }
    }));
  }
  return r;
}
