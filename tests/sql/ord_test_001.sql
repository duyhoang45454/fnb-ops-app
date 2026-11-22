-- Tách từ 03_seed_and_test.sql (Mục 5.3). Kỳ vọng: COGS 18.560đ, MILK-FRESH low_stock còn 890ml
BEGIN;
-- Test đơn hàng ORD-TEST-001 (Kết quả kỳ vọng: Tổng COGS = 18.560đ, MILK-FRESH báo low_stock còn 890ml)
INSERT INTO pos_orders (id, order_code, shift_id, cashier_id, status, subtotal, total_amount, payment_method, paid_at) VALUES
    ('50000000-0000-0000-0000-000000000001', 'ORD-TEST-001', '21000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000003', 'PAID', 100000, 100000, 'QR_TRANSFER', NOW());

INSERT INTO pos_order_items (id, order_id, menu_item_id, recipe_version_id, quantity, unit_price, cogs_snapshot) VALUES
    ('51000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', '41000000-0000-0000-0000-000000000001', 2, 50000, 0);

INSERT INTO pos_order_item_modifiers (order_item_id, modifier_id, price_delta_snapshot) VALUES
    ('51000000-0000-0000-0000-000000000001', '42000000-0000-0000-0000-000000000001', 7000),
    ('51000000-0000-0000-0000-000000000001', '42000000-0000-0000-0000-000000000002',    0),
    ('51000000-0000-0000-0000-000000000001', '42000000-0000-0000-0000-000000000003', 8000);

SELECT jsonb_pretty(fn_process_pos_order_deduction('50000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000003', TRUE));
COMMIT;
