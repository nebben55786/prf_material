import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { resolveRolePermissions, hasSectionPermission, yardPermissionActions } from "../src/permissions.js";

const source = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const defaults = vm.runInNewContext(source.slice(source.indexOf("const defaultPermissionMatrix ="), source.indexOf("function safeCookieDecode")) + "\ndefaultPermissionMatrix;", {
  roleAdmin: "admin", roleMaterialController: "material_controller"
});
const roles = ["admin", "material_controller", "buyer", "warehouse", "field", "supervisor"];
const resolve = (role, saved) => resolveRolePermissions(defaults, { [role]: saved }, role);
const allow = (p, section, action) => hasSectionPermission(p, section, action);

test("legacy Items Master settings survive the split; Warehouse stock workflows remain available", () => {
  const p = resolve("warehouse", { inventory: { view: false, edit: false }, yard: { view: true, edit: true } });
  assert.equal(allow(p, "items", "view"), false);
  assert.equal(allow(p, "items", "edit"), false);
  assert.equal(allow(p, "inventory", "view"), true);
  assert.equal(allow(p, "inventory", "edit"), true);
  assert.equal(allow(p, "yard", "locations"), true);
  for (const action of ["manage_locations", "move_inventory", "item_history"]) assert.equal(allow(p, "yard", action), false);
});

test("explicit settings grant and revoke each capability for every role without role bypasses", () => {
  for (const role of roles) {
    const p = resolve(role, {
      items: { view: false, edit: false }, inventory: { view: true, edit: false },
      yard: { view: true, locations: true, manage_locations: true, move_inventory: false, item_history: true }
    });
    assert.equal(allow(p, "items", "view"), false, role);
    assert.equal(allow(p, "inventory", "view"), true, role);
    assert.equal(allow(p, "inventory", "edit"), false, role);
    assert.equal(allow(p, "yard", "manage_locations"), true, role);
    assert.equal(allow(p, "yard", "move_inventory"), false, role);
    assert.equal(allow(p, "yard", "item_history"), true, role);
    p.items = { view: true, edit: true };
    p.inventory.view = false;
    assert.equal(allow(p, "items", "edit"), true, role);
    assert.equal(allow(p, "inventory", "edit"), false, role);
    p.yard.locations = false;
    assert.equal(allow(p, "yard", "manage_locations"), false, role);
    p.yard.view = false;
    assert.equal(allow(p, "yard", "item_history"), false, role);
  }
});

test("Yard renders only links authorized by the same permission evaluator", async () => {
  const start = source.indexOf('app.get("/yard",');
  const end = source.indexOf('app.get("/yard/issue-by-po",', start);
  for (const enabled of [false, true]) {
    const p = resolve("warehouse", {
      items: { view: false, edit: false }, inventory: { view: enabled, edit: enabled },
      yard: { view: true, locations: enabled, item_history: enabled },
      requisitions: { view: enabled, issue: enabled }
    });
    let handler;
    vm.runInNewContext(source.slice(start, end), {
      app: { get: (_path, ...handlers) => { handler = handlers.at(-1); } },
      requireAuth() {}, requireJobContext() {}, requirePermission: () => () => {},
      currentJobId: () => 1, query: async () => ({ rows: [{ count: 0 }] }),
      canAccess: (_user, section, action) => allow(p, section, action),
      canEditInventoryAudit: () => allow(p, "inventory", "edit"), layout: (_title, body) => body
    });
    let html;
    await handler({ user: { role: "warehouse" } }, { send: body => { html = body; } });
    for (const url of ["/inventory", "/inventory-audit", "/yard/location-inventory", "/yard/locations", "/yard/item-history", "/yard/issue-by-po", "/requisitions?status=REQUESTED"]) {
      assert.equal(html.includes(`href="${url}"`), enabled, url);
    }
  }
});

test("storage and item endpoints use the separated server permissions", () => {
  for (const line of source.split("\n").filter(line => /^app\.(get|post)\("\/items/.test(line))) {
    assert.match(line, /requirePermission\("items",/);
  }
  for (const line of source.split("\n").filter(line => /^app\.(get|post)\("\/settings\/(warehouses|warehouse-locations)/.test(line))) {
    assert.match(line, /requirePermission\("yard", "manage_locations"\)/);
    assert.doesNotMatch(line, /requireRole/);
  }
  assert.match(source, /"\/yard\/item-history", requireAuth, requireJobContext, requirePermission\("yard", "item_history"\)/);
  assert.match(fs.readFileSync(new URL("../src/inventory-moves.js", import.meta.url), "utf8"), /requirePermission\('yard','move_inventory'\)/);
});

test("saving the table persists independent checked and unchecked actions across reloads", async () => {
  const start = source.indexOf('app.post("/settings/permissions",');
  const end = source.indexOf('app.get("/settings/material-log-imports",', start);
  let handler, saved, persisted;
  const sections = vm.runInNewContext(source.slice(source.indexOf("const permissionSections ="), source.indexOf("const roleAdmin =")) + "\npermissionSections;");
  vm.runInNewContext(source.slice(start, end), {
    app: { post: (_path, ...handlers) => { handler = handlers.at(-1); } },
    requireAuth() {}, requireRole: () => () => {}, requirePermission: () => () => {},
    adminEquivalentRoles: ["admin", "material_controller"], asyncHandler: fn => fn,
    permissionRoles: roles, permissionSections: sections, yardPermissionActions,
    getPermissionsForRole: role => resolve(role, {}), isCheckedFormValue: value => value === "on",
    withTransaction: async fn => fn({ query: async (_sql, params) => { persisted = JSON.parse(params[0]); } }),
    auditLog: async () => {}, setPermissionMatrix: value => { saved = value; },
    getSafeReturnPath: (_req, path) => path
  });
  await handler({ user: { id: 1 }, body: {
    perm__warehouse__items__view: "on", perm__warehouse__inventory__view: "on",
    perm__warehouse__inventory__edit: "on", perm__warehouse__yard__view: "on",
    perm__warehouse__yard__locations: "on", perm__warehouse__yard__move_inventory: "on"
  } }, { redirect() {} });
  const p = resolveRolePermissions(defaults, persisted, "warehouse");
  assert.equal(JSON.stringify(saved), JSON.stringify(persisted));
  assert.equal(allow(p, "items", "view"), true);
  assert.equal(allow(p, "items", "edit"), false);
  assert.equal(allow(p, "inventory", "edit"), true);
  assert.equal(allow(p, "yard", "move_inventory"), true);
  assert.equal(allow(p, "yard", "manage_locations"), false);
  assert.equal(allow(p, "yard", "item_history"), false);
  assert.equal(allow(resolveRolePermissions(defaults, persisted, "admin"), "inventory", "edit"), false);
});

test("direct endpoint middleware denies unchecked actions even for privileged roles", () => {
  const start = source.indexOf("function requirePermission(");
  const end = source.indexOf("function canEditRequisition(", start);
  for (const role of roles) {
    let p = resolve(role, { items: { view: true, edit: false }, inventory: { view: true, edit: false }, yard: { view: true, locations: true, manage_locations: false, move_inventory: false, item_history: false } });
    const context = vm.createContext({
      canAccess: (_user, section, action) => allow(p, section, action),
      canEditInventoryAudit: () => allow(p, "inventory", "edit"), layout: (_title, html) => html
    });
    vm.runInContext(source.slice(start, end), context);
    for (const [section, action] of [["items", "edit"], ["inventory", "edit"], ["yard", "manage_locations"], ["yard", "move_inventory"], ["yard", "item_history"]]) {
      let status, next = false;
      const res = { status(code) { status = code; return this; }, send() {} };
      const middleware = context.requirePermission(section, action);
      middleware({ user: { role } }, res, () => { next = true; });
      assert.equal(status, 403, `${role}: ${section}.${action}`);
      assert.equal(next, false);
      p[section][action] = true;
      middleware({ user: { role } }, res, () => { next = true; });
      assert.equal(next, true);
      p[section][action] = false;
    }
  }
});

test("Locations exposes management and movement independently", async () => {
  const start = source.indexOf('app.get("/yard/locations",');
  const end = source.indexOf('\napp.', start + 10);
  for (const manage of [false, true]) for (const move of [false, true]) {
    const p = resolve("warehouse", { items: { view: false }, yard: { view: true, locations: true, manage_locations: manage, move_inventory: move } });
    let handler, html;
    vm.runInNewContext(source.slice(start, end), {
      app: { get: (_path, ...handlers) => { handler = handlers.at(-1); } },
      requireAuth() {}, requireJobContext() {}, requirePermission: () => () => {},
      currentJobId: () => 1, query: async () => ({ rows: [{ id: 1, name: "BIN", warehouse_name: "YARD", is_active: true }] }),
      canAccess: (_user, section, action) => allow(p, section, action),
      esc: String, normalizeWarehouseName: String, normalizeLocationName: String, layout: (_title, body) => body
    });
    await handler({ user: { role: "warehouse" }, query: {} }, { send: body => { html = body; } });
    assert.equal(html.includes('action="/settings/warehouses/add"'), manage);
    assert.equal(html.includes('action="/settings/warehouses/1/toggle"'), manage);
    assert.equal(html.includes('action="/settings/warehouse-locations/1/toggle"'), manage);
    assert.equal(html.includes('href="/yard/move-inventory?warehouse_id=1"'), move);
    assert.equal(html.includes('href="/yard/move-inventory?location_id=1"'), move);
  }
});
