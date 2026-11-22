-- ============================================================================
-- File 04: Bổ sung dữ liệu cho ứng dụng chạy thật (khớp prototype HTML)
--  * Băm thật mật khẩu & PIN (bcrypt qua pgcrypto) thay cho giá trị giả 'pin_xxxx'
--  * Thêm 2 món, modifier 50% đường, quy đổi đơn vị, phân quyền, chấm công mẫu
-- Mật khẩu đăng nhập mặc định của mọi tài khoản demo: 123456
-- PIN: OWNER 9999 • MANAGER 2468 • CASHIER 1111 • BARISTA 2222
-- ============================================================================
BEGIN;

UPDATE users SET password_hash = crypt('123456', gen_salt('bf', 8));
UPDATE users SET pos_pin_hash = crypt('9999', gen_salt('bf', 8)) WHERE id = '20000000-0000-0000-0000-000000000001';
UPDATE users SET pos_pin_hash = crypt('2468', gen_salt('bf', 8)) WHERE id = '20000000-0000-0000-0000-000000000002';
UPDATE users SET pos_pin_hash = crypt('1111', gen_salt('bf', 8)) WHERE id = '20000000-0000-0000-0000-000000000003';
UPDATE users SET pos_pin_hash = crypt('2222', gen_salt('bf', 8)) WHERE id = '20000000-0000-0000-0000-000000000004';

-- Quy đổi đơn vị mua / đếm (pack)
INSERT INTO item_unit_conversions (item_id, unit_name, to_base_factor, is_purchase_unit, is_count_unit) VALUES
    ('30000000-0000-0000-0000-000000000001', 'Hộp 1L',    1000, TRUE, TRUE),
    ('30000000-0000-0000-0000-000000000001', 'Thùng 12 hộp', 12000, TRUE, FALSE),
    ('30000000-0000-0000-0000-000000000002', 'Chai 1L',   1000, TRUE, TRUE),
    ('30000000-0000-0000-0000-000000000003', 'Bình 1L',   1000, FALSE, TRUE),
    ('30000000-0000-0000-0000-000000000004', 'Hộp 1kg',   1000, FALSE, TRUE),
    ('30000000-0000-0000-0000-000000000005', 'Cây 50 ly', 50,   TRUE, TRUE),
    ('30000000-0000-0000-0000-000000000006', 'Cây 50 ly', 50,   TRUE, TRUE);

-- SOP chi tiết cho món gốc
UPDATE recipes SET sop_steps_json =
 '["1. Đong 150ml cốt hồng trà vào bình lắc (jigger chuẩn)", "2. Thêm 100ml sữa tươi thanh trùng & siro đường theo mức chọn", "3. Thêm đá bi, lắc mạnh 10 giây, rót ra ly và thêm topping"]'::jsonb
WHERE id = '41000000-0000-0000-0000-000000000001';

-- Thêm 2 món theo prototype
INSERT INTO menu_items (id, code, name, category, base_price, is_available) VALUES
    ('40000000-0000-0000-0000-000000000002', 'TEA-BLACK',  'Hồng Trà Đường Đen',     'Trà Trái Cây', 28000.00, TRUE),
    ('40000000-0000-0000-0000-000000000003', 'MILK-PEARL', 'Sữa Tươi Trân Châu Đen', 'Sữa Tươi',     40000.00, TRUE);

INSERT INTO recipes (id, menu_item_id, version_no, is_active, standard_yield_base, calculated_cogs, sop_steps_json, created_by) VALUES
    ('41000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000002', 1, TRUE, 1, 3525.00,
     '["1. Đong 200ml cốt hồng trà ủ lạnh", "2. Thêm 35ml siro đường khuấy tan đều", "3. Thêm đá đầy ly, dập nắp màng hoặc nắp cầu"]'::jsonb,
     '20000000-0000-0000-0000-000000000001'),
    ('41000000-0000-0000-0000-000000000003', '40000000-0000-0000-0000-000000000003', 1, TRUE, 1, 9800.00,
     '["1. Múc 60g trân châu đen nóng tráng thành ly", "2. Thêm đá viên 2/3 ly, rót chậm 180ml sữa tươi thanh trùng", "3. Không khuấy để giữ vân đẹp mắt"]'::jsonb,
     '20000000-0000-0000-0000-000000000001');

INSERT INTO recipe_lines (recipe_id, item_id, qty_base, ingredient_role) VALUES
    ('41000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000003', 200, 'BASE_TEA'),
    ('41000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000002',  35, 'SUGAR'),
    ('41000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000005',   1, 'CUP'),
    ('41000000-0000-0000-0000-000000000003', '30000000-0000-0000-0000-000000000001', 180, 'MILK'),
    ('41000000-0000-0000-0000-000000000003', '30000000-0000-0000-0000-000000000004',  60, 'TOPPING'),
    ('41000000-0000-0000-0000-000000000003', '30000000-0000-0000-0000-000000000002',  20, 'SUGAR'),
    ('41000000-0000-0000-0000-000000000003', '30000000-0000-0000-0000-000000000005',   1, 'CUP');

-- Modifier 50% đường
INSERT INTO modifiers (id, group_name, name, price_delta) VALUES
    ('42000000-0000-0000-0000-000000000004', 'SUGAR', '50% Đường', 0.00);
INSERT INTO modifier_recipe_rules (modifier_id, target_ingredient_role, action_type, value_num) VALUES
    ('42000000-0000-0000-0000-000000000004', 'SUGAR', 'MULTIPLY', 0.500);

-- Danh mục quyền (tham chiếu ma trận RBAC Phần 2.2; backend thực thi chi tiết)
INSERT INTO permissions (code, module, description, requires_pin_override) VALUES
    ('POS_SELL',            'POS',       'Tạo đơn, thu tiền, in tem', FALSE),
    ('POS_VOID_PAID',       'POS',       'Hủy món sau khi in tem / thu tiền', TRUE),
    ('POS_CASH_CLOSE',      'POS',       'Chốt két mù cuối ca', FALSE),
    ('INV_VIEW',            'INVENTORY', 'Xem tồn & FEFO', FALSE),
    ('INV_VIEW_COST',       'INVENTORY', 'Xem đơn giá & giá vốn', FALSE),
    ('INV_PREP',            'INVENTORY', 'Nấu bán thành phẩm', FALSE),
    ('INV_WASTE_CREATE',    'INVENTORY', 'Tạo phiếu báo hủy', FALSE),
    ('INV_WASTE_APPROVE',   'INVENTORY', 'Duyệt phiếu báo hủy', FALSE),
    ('EOD_COUNT',           'EOD',       'Nhập số kiểm kho mù', FALSE),
    ('EOD_VIEW_VARIANCE',   'EOD',       'Xem chênh lệch & tồn lý thuyết', FALSE),
    ('BOM_VIEW',            'BOM',       'Xem định lượng & SOP', FALSE),
    ('BOM_EDIT',            'BOM',       'Sửa định lượng / tạo phiên bản', FALSE),
    ('HR_CLOCK',            'HR',        'Tự chấm công', FALSE),
    ('AUDIT_VIEW',          'AUDIT',     'Xem nhật ký bất biến', FALSE);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON
    (r.code = 'OWNER')
 OR (r.code = 'MANAGER' AND p.code IN ('POS_SELL','POS_VOID_PAID','POS_CASH_CLOSE','INV_VIEW','INV_PREP','INV_WASTE_APPROVE','EOD_COUNT','BOM_VIEW','HR_CLOCK'))
 OR (r.code = 'CASHIER' AND p.code IN ('POS_SELL','POS_CASH_CLOSE','HR_CLOCK'))
 OR (r.code = 'BARISTA' AND p.code IN ('INV_VIEW','INV_PREP','INV_WASTE_CREATE','EOD_COUNT','BOM_VIEW','HR_CLOCK'));

-- Chấm công mẫu ca chiều
INSERT INTO attendance_logs (user_id, shift_id, clock_in_at, wifi_bssid, gps_lat, gps_lng, face_photo_url) VALUES
    ('20000000-0000-0000-0000-000000000002', '21000000-0000-0000-0000-000000000001', NOW() - INTERVAL '65 mins', '8C:3B:AD:12:9F', 10.903200, 106.768100, 'face/manager_live.jpg'),
    ('20000000-0000-0000-0000-000000000003', '21000000-0000-0000-0000-000000000001', NOW() - INTERVAL '62 mins', '8C:3B:AD:12:9F', 10.903100, 106.768000, 'face/cashier_live.jpg'),
    ('20000000-0000-0000-0000-000000000004', '21000000-0000-0000-0000-000000000001', NOW() - INTERVAL '60 mins', '8C:3B:AD:12:9F', 10.903200, 106.768200, 'face/barista_live.jpg');

INSERT INTO audit_logs (actor_id, action_code, entity_table, entity_id, new_values_json, reason) VALUES
    ('20000000-0000-0000-0000-000000000002', 'SHIFT_OPEN', 'work_shifts', '21000000-0000-0000-0000-000000000001',
     '{"opening_cash": 2000000}'::jsonb, 'Mở Ca Chiều, quỹ đầu ca 2.000.000đ');

COMMIT;
