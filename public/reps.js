// Sales-rep picker: a select when the role may list staff, otherwise a numeric id field.
import { t, tOr } from './i18n.js';
import { app } from './session.js';

export function repField(staff, { value = '', required = true } = {}) {
  // owner sees staff of every store; only this store's staff (or tenant-wide staff) can be a rep here
  const reps = staff.filter((s) => s.active && (s.storeId === null || s.storeId === app.actor.storeId));
  if (!reps.length) return { name: 'rep', label: t('floor.repId'), type: 'int', required, min: 1, value, hint: t('floor.repIdHint') };
  return {
    name: 'rep',
    label: t('floor.rep'),
    type: 'select',
    required,
    value,
    options: [{ value: '', label: t('floor.chooseRep') }, ...reps.map((s) => ({ value: s.id, label: `${s.name} (${tOr(`role.${s.role}`, s.role)})` }))],
  };
}
