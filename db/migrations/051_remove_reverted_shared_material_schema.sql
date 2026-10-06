-- Completely remove the two reverted shared-material features and their data.
-- The preceding rollback migration removes their triggers first.
drop view if exists shared_inventory_owned_stock;
drop view if exists shared_inventory_item_metadata;
alter table material_issue_transactions drop column if exists shared_movement_id;
alter table material_requisition_lines drop column if exists inventory_reservation_id;
drop table if exists inventory_reservation_events;
drop table if exists shared_inventory_movements;
drop table if exists inventory_reservations;
drop table if exists inventory_pool_matches;
drop table if exists inventory_pool_materials;
drop table if exists inventory_pool_jobs;
drop table if exists inventory_pools;
drop table if exists inventory_pool_lock;
drop function if exists enforce_shared_mrr_number();
drop function if exists check_shared_inventory_balances();
drop function if exists lock_shared_inventory();
