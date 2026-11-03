// Presentation attributes come from Item Master; stock calculations keep their original ledger keys.
export function withItemMasterAttributes(rows, masters) {
  const key = value => String(value || '').trim().toLowerCase();
  const lookup = new Map(masters.map(item => [key(item.item_code), item]));
  const fields = ['item_code','description','size_1','size_2','thk_1','thk_2','material_type','uom','commodity_code'];
  return rows.map(row => {
    const master = lookup.get(key(row.item_code));
    if (!master) return {...row};
    const attributes = Object.fromEntries(fields.map(field => [field, master[field] ?? '']));
    return {...row, ...attributes};
  });
}
