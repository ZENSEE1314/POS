// Floor view state. Module-level so a language switch (which remounts the view) keeps the selected bill.
const initialState = () => ({
  tables: [],
  totals: new Map(),
  products: [],
  staff: [],
  shift: null,
  billId: null,
  bill: null,
  category: 'all',
  query: '',
  qty: 1,
  gift: false,
  pending: null,
});

export const S = initialState();

/** Clears everything tied to one store or session (login, logout, store switch). */
export const resetFloorState = () => Object.assign(S, initialState());

/** Called before navigating to the floor so it opens with this bill selected. */
export function selectBillOnMount(billId) {
  S.billId = billId;
  S.bill = null;
  S.pending = null;
}
