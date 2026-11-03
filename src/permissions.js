export const yardPermissionActions = [
  { key: "locations", label: "View Locations" },
  { key: "manage_locations", label: "Manage Warehouses / Locations" },
  { key: "move_inventory", label: "Move Inventory" },
  { key: "item_history", label: "Item History" }
];

// Older matrices used inventory for both item details and stock access.
// Resolve them without writing to the database; saving the table makes the
// independent sections explicit, including unchecked (false) permissions.
export function resolveRolePermissions(defaults, matrix, role) {
  const key = String(role || "").trim().toLowerCase();
  const base = defaults[key] || {};
  const saved = matrix[key] || {};
  const result = Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(saved)])]
    .map(section => [section, { ...base[section], ...saved[section] }]));
  const privileged = ["admin", "material_controller"].includes(key);
  const legacy = !Object.hasOwn(saved, "items");
  result.items = legacy ? { ...result.inventory } : { ...base.items, ...saved.items };
  result.inventory = { ...result.inventory };
  if (legacy) {
    result.inventory.edit = privileged || key === "warehouse" || Boolean(result.inventory.edit);
    // These roles could already enter audit counts without inventory View.
    // Keep that workflow available while leaving Items Master independent.
    if (privileged || key === "warehouse") result.inventory.view = true;
  }
  const legacyManage = privileged && Boolean(result.settings?.edit);
  result.yard = {
    locations: true,
    manage_locations: legacyManage,
    move_inventory: legacyManage,
    item_history: privileged,
    ...result.yard
  };
  return result;
}

export function hasSectionPermission(permissions, section, action = "view") {
  const access = permissions[section] || {};
  if (["items", "inventory", "yard"].includes(section)) {
    if (!access.view) return false;
    if (section === "yard" && ["manage_locations", "move_inventory"].includes(action) && !access.locations) return false;
  }
  return Boolean(access[action]);
}
