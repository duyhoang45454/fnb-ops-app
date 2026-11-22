-- ============================================================================
-- File 03: Seed Data & Bài test 2 ly Trà Sữa Size L + 0% Đường + Trân châu
-- ============================================================================
BEGIN;

INSERT INTO roles (id, code, name, description) VALUES
    ('10000000-0000-0000-0000-000000000001', 'OWNER',   'Chủ quán',   'Toàn quyền hệ thống'),
    ('10000000-0000-0000-0000-000000000002', 'MANAGER', 'Quản lý ca', 'Vận hành ca, duyệt PIN, kiểm kho mù'),
    ('10000000-0000-0000-0000-000000000003', 'CASHIER', 'Thu ngân',   'Bán hàng POS, chốt két mù'),
    ('10000000-0000-0000-0000-000000000004', 'BARISTA', 'Pha chế',    'Xem SOP, nấu bán thành phẩm, báo hủy');

INSERT INTO users (id, role_id, full_name, phone, password_hash, pos_pin_hash, hourly_rate) VALUES
    ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Nguyễn Minh Chủ',  '0901000001', 'hash_owner',   'pin_9999', 0),
    ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', 'Trần Lan Quản Lý', '0901000002', 'hash_manager', 'pin_2468', 45000),
    ('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000003', 'Lê Huy Thu Ngân',  '0901000003', 'hash_cashier', 'pin_1111', 28000),
    ('20000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000004', 'Phạm An Barista',  '0901000004', 'hash_barista', 'pin_2222', 30000);

INSERT INTO work_shifts (id, shift_date, shift_slot, manager_id, opening_cash, status) VALUES
    ('21000000-0000-0000-0000-000000000001', CURRENT_DATE, 'AFTERNOON', '20000000-0000-0000-0000-000000000002', 2000000, 'OPEN');

INSERT INTO inventory_items (id, sku, name, item_type, abc_class, base_unit, tare_weight_g, min_stock_base, avg_unit_cost) VALUES
    ('30000000-0000-0000-0000-000000000001', 'MILK-FRESH',  'Sữa tươi thanh trùng',  'RAW',           'A', 'ml',  45.000, 1000.000,   32.5000),
    ('30000000-0000-0000-0000-000000000002', 'SUGAR-SYRUP', 'Siro đường nước',       'RAW',           'B', 'ml',  60.000,  500.000,   25.0000),
    ('30000000-0000-0000-0000-000000000003', 'PREP-TEA',    'Cốt hồng trà ủ sẵn',    'SEMI_FINISHED', 'A', 'ml', 180.000, 1000.000,    8.5000),
    ('30000000-0000-0000-0000-000000000004', 'PREP-PEARL',  'Trân châu đen đã nấu',  'SEMI_FINISHED', 'A', 'g',  220.000,  300.000,   45.0000),
    ('30000000-0000-0000-0000-000000000005', 'CUP-500ML',   'Ly nhựa 500ml (Size M)','PACKAGING',     'A', 'pcs',  0.000,   50.000,  950.0000),
    ('30000000-0000-0000-0000-000000000006', 'CUP-700ML',   'Ly nhựa 700ml (Size L)','PACKAGING',     'A', 'pcs',  0.000,   50.000, 1200.0000);

INSERT INTO inventory_batches (id, item_id, batch_code, received_at, expires_at, initial_qty_base, remaining_qty_base, unit_cost) VALUES
    ('31000000-0000-0000-0000-000000000000', '30000000-0000-0000-0000-000000000001', 'MILK-EXPIRED-00', NOW() - INTERVAL '10 days', NOW() - INTERVAL '2 days',  500.000,  500.000,   30.0000),
    ('31000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'MILK-FEFO-01',    NOW() - INTERVAL '4 days',  NOW() + INTERVAL '1 day',   150.000,  150.000,   30.0000),
    ('31000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000001', 'MILK-FEFO-02',    NOW() - INTERVAL '1 day',   NOW() + INTERVAL '5 days', 1000.000, 1000.000,   35.0000),
    ('31000000-0000-0000-0000-000000000003', '30000000-0000-0000-0000-000000000003', 'TEA-MORNING-01',  NOW() - INTERVAL '4 hours', NOW() + INTERVAL '2 hours', 200.000,  200.000,    8.0000),
    ('31000000-0000-0000-0000-000000000004', '30000000-0000-0000-0000-000000000003', 'TEA-NOON-02',     NOW() - INTERVAL '30 mins', NOW() + INTERVAL '6 hours',3000.000, 3000.000,    9.0000),
    ('31000000-0000-0000-0000-000000000005', '30000000-0000-0000-0000-000000000004', 'PEARL-NOON-01',   NOW() - INTERVAL '1 hour',  NOW() + INTERVAL '4 hours',1000.000, 1000.000,   45.0000),
    ('31000000-0000-0000-0000-000000000006', '30000000-0000-0000-0000-000000000002', 'SUGAR-LOT-01',    NOW() - INTERVAL '5 days',  NOW() + INTERVAL '180 days',2000.000,2000.000,   25.0000),
    ('31000000-0000-0000-0000-000000000007', '30000000-0000-0000-0000-000000000005', 'CUP500-LOT-01',   NOW() - INTERVAL '10 days', NOW() + INTERVAL '365 days', 200.000, 200.000,  950.0000),
    ('31000000-0000-0000-0000-000000000008', '30000000-0000-0000-0000-000000000006', 'CUP700-LOT-01',   NOW() - INTERVAL '10 days', NOW() + INTERVAL '365 days', 200.000, 200.000, 1200.0000);

INSERT INTO stock_ledger (item_id, batch_id, txn_type, qty_change_base, unit_cost_snapshot, ref_table, ref_id, created_by)
SELECT b.item_id, b.id, CASE WHEN ii.item_type = 'SEMI_FINISHED' THEN 'PREP_IN' ELSE 'PURCHASE' END,
       b.initial_qty_base, b.unit_cost, 'inventory_batches', b.id, '20000000-0000-0000-0000-000000000001'
FROM inventory_batches b JOIN inventory_items ii ON ii.id = b.item_id;

INSERT INTO menu_items (id, code, name, category, base_price, is_available) VALUES
    ('40000000-0000-0000-0000-000000000001', 'MT-CLASSIC', 'Trà Sữa Truyền Thống', 'Trà Sữa', 35000.00, TRUE);

INSERT INTO recipes (id, menu_item_id, version_no, is_active, standard_yield_base, calculated_cogs, sop_steps_json, created_by) VALUES
    ('41000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 1, TRUE, 1.000, 6225.00,
     '["1. Đong cốt hồng trà vào bình lắc", "2. Thêm sữa tươi và đường", "3. Thêm đá lắc đều 10 giây"]'::jsonb,
     '20000000-0000-0000-0000-000000000001');

INSERT INTO recipe_lines (recipe_id, item_id, qty_base, ingredient_role) VALUES
    ('41000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000003', 150.000, 'BASE_TEA'),
    ('41000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 100.000, 'MILK'),
    ('41000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002',  30.000, 'SUGAR'),
    ('41000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000005',   1.000, 'CUP');

INSERT INTO modifiers (id, group_name, name, price_delta) VALUES
    ('42000000-0000-0000-0000-000000000001', 'SIZE',    'Size L',             7000.00),
    ('42000000-0000-0000-0000-000000000002', 'SUGAR',   '0% Đường',              0.00),
    ('42000000-0000-0000-0000-000000000003', 'TOPPING', 'Thêm Trân châu đen', 8000.00);

INSERT INTO modifier_recipe_rules (modifier_id, target_ingredient_role, target_item_id, action_type, value_num, replace_with_item_id) VALUES
    ('42000000-0000-0000-0000-000000000001', 'CUP',      NULL, 'REPLACE',  NULL,  '30000000-0000-0000-0000-000000000006'),
    ('42000000-0000-0000-0000-000000000001', 'BASE_TEA', NULL, 'MULTIPLY', 1.300, NULL),
    ('42000000-0000-0000-0000-000000000001', 'MILK',     NULL, 'MULTIPLY', 1.300, NULL),
    ('42000000-0000-0000-0000-000000000001', 'SUGAR',    NULL, 'MULTIPLY', 1.300, NULL),
    ('42000000-0000-0000-0000-000000000002', 'SUGAR',    NULL, 'MULTIPLY', 0.000, NULL),
    ('42000000-0000-0000-0000-000000000003', NULL, '30000000-0000-0000-0000-000000000004', 'ADD', 50.000, NULL);

-- (Đơn kiểm thử ORD-TEST-001 đã tách sang tests/sql/ord_test_001.sql để DB ứng dụng khởi động sạch;
--  integration test tạo lại đơn này qua API và qua SQL.)
COMMIT;
