-- ============================================================================
-- File 02: Bộ 3 hàm PL/pgSQL tính BOM động (REPLACE -> MULTIPLY -> ADD) & FEFO
-- ============================================================================

CREATE OR REPLACE FUNCTION fn_calculate_dynamic_bom(p_order_item_id UUID)
RETURNS TABLE (item_id UUID, total_qty_base NUMERIC(12, 3))
LANGUAGE sql STABLE AS $$
WITH order_ctx AS (
    SELECT id, recipe_version_id, quantity FROM pos_order_items WHERE id = p_order_item_id
),
applied_rules AS (
    SELECT mrr.id, mrr.action_type, mrr.target_ingredient_role, mrr.target_item_id, mrr.value_num, mrr.replace_with_item_id
    FROM pos_order_item_modifiers oim
    JOIN modifier_recipe_rules mrr ON mrr.modifier_id = oim.modifier_id
    WHERE oim.order_item_id = p_order_item_id
),
base_after_replace AS (
    SELECT
        rl.id AS recipe_line_id,
        COALESCE(rep.replace_with_item_id, rl.item_id) AS effective_item_id,
        rl.item_id AS original_item_id,
        rl.ingredient_role, rl.qty_base, oc.quantity AS cup_qty
    FROM order_ctx oc
    JOIN recipe_lines rl ON rl.recipe_id = oc.recipe_version_id
    LEFT JOIN LATERAL (
        SELECT ar.replace_with_item_id
        FROM applied_rules ar
        WHERE ar.action_type = 'REPLACE'
          AND ((ar.target_item_id IS NOT NULL AND ar.target_item_id = rl.item_id)
               OR (ar.target_item_id IS NULL AND ar.target_ingredient_role = rl.ingredient_role))
        ORDER BY (ar.target_item_id IS NOT NULL) DESC, ar.id ASC
        LIMIT 1
    ) rep ON TRUE
),
base_after_multiply AS (
    SELECT
        b.effective_item_id AS item_id,
        ROUND(b.qty_base * COALESCE(mul.net_factor, 1.0) * b.cup_qty, 3) AS line_qty_base
    FROM base_after_replace b
    LEFT JOIN LATERAL (
        SELECT CASE
            WHEN BOOL_OR(ar.value_num = 0) THEN 0::NUMERIC
            ELSE EXP(SUM(LN(NULLIF(ar.value_num, 0))))::NUMERIC
        END AS net_factor
        FROM applied_rules ar
        WHERE ar.action_type = 'MULTIPLY'
          AND ((ar.target_item_id IS NOT NULL AND ar.target_item_id IN (b.original_item_id, b.effective_item_id))
               OR (ar.target_item_id IS NULL AND ar.target_ingredient_role = b.ingredient_role))
    ) mul ON TRUE
),
added_lines AS (
    SELECT ar.target_item_id AS item_id, ROUND(ar.value_num * oc.quantity, 3) AS line_qty_base
    FROM order_ctx oc
    JOIN applied_rules ar ON ar.action_type = 'ADD'
),
combined AS (
    SELECT item_id, line_qty_base FROM base_after_multiply
    UNION ALL
    SELECT item_id, line_qty_base FROM added_lines
)
SELECT c.item_id, SUM(c.line_qty_base)::NUMERIC(12, 3) AS total_qty_base
FROM combined c
GROUP BY c.item_id
HAVING SUM(c.line_qty_base) > 0
ORDER BY c.item_id ASC;
$$;

CREATE OR REPLACE FUNCTION fn_deduct_stock_fefo(
    p_item_id UUID, p_qty_needed NUMERIC(12, 3), p_txn_type VARCHAR(20),
    p_ref_table VARCHAR(50), p_ref_id UUID, p_actor_id UUID, p_allow_negative BOOLEAN DEFAULT TRUE
)
RETURNS TABLE (total_cogs NUMERIC(15, 2), shortfall_qty NUMERIC(12, 3))
LANGUAGE plpgsql AS $$
DECLARE
    v_item      RECORD;
    v_batch     RECORD;
    v_remaining NUMERIC(12, 3) := p_qty_needed;
    v_deduct    NUMERIC(12, 3);
    v_cogs_acc  NUMERIC(18, 4) := 0;
    v_shortfall NUMERIC(12, 3) := 0;
BEGIN
    IF p_qty_needed IS NULL OR p_qty_needed <= 0 THEN
        RAISE EXCEPTION 'Số lượng cần trừ phải lớn hơn 0 (item_id: %)', p_item_id USING ERRCODE = '22023';
    END IF;

    SELECT id, sku, name, avg_unit_cost INTO v_item
    FROM inventory_items WHERE id = p_item_id AND deleted_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Không tìm thấy nguyên liệu id: %', p_item_id USING ERRCODE = 'P0002';
    END IF;

    FOR v_batch IN
        SELECT id, remaining_qty_base, unit_cost
        FROM inventory_batches
        WHERE item_id = p_item_id AND remaining_qty_base > 0 AND expires_at > NOW()
        ORDER BY expires_at ASC, received_at ASC, id ASC
        FOR UPDATE
    LOOP
        v_deduct := LEAST(v_remaining, v_batch.remaining_qty_base);
        UPDATE inventory_batches SET remaining_qty_base = remaining_qty_base - v_deduct WHERE id = v_batch.id;
        INSERT INTO stock_ledger (item_id, batch_id, txn_type, qty_change_base, unit_cost_snapshot, ref_table, ref_id, created_by)
        VALUES (p_item_id, v_batch.id, p_txn_type, -v_deduct, v_batch.unit_cost, p_ref_table, p_ref_id, p_actor_id);

        v_cogs_acc  := v_cogs_acc + (v_deduct * v_batch.unit_cost);
        v_remaining := v_remaining - v_deduct;
        EXIT WHEN v_remaining <= 0;
    END LOOP;

    IF v_remaining > 0 THEN
        IF NOT p_allow_negative THEN
            RAISE EXCEPTION 'Không đủ tồn kho còn hạn cho "%" (SKU: %). Thiếu: %', v_item.name, v_item.sku, v_remaining USING ERRCODE = 'P0001';
        END IF;
        INSERT INTO stock_ledger (item_id, batch_id, txn_type, qty_change_base, unit_cost_snapshot, ref_table, ref_id, created_by)
        VALUES (p_item_id, NULL, p_txn_type, -v_remaining, v_item.avg_unit_cost, p_ref_table, p_ref_id, p_actor_id);
        v_cogs_acc  := v_cogs_acc + (v_remaining * v_item.avg_unit_cost);
        v_shortfall := v_remaining;
    END IF;

    RETURN QUERY SELECT ROUND(v_cogs_acc, 2), v_shortfall;
END;
$$;

CREATE OR REPLACE FUNCTION fn_process_pos_order_deduction(
    p_order_id UUID, p_actor_id UUID, p_allow_negative BOOLEAN DEFAULT TRUE
)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
    v_order            RECORD;
    v_oi               RECORD;
    v_bom_line         RECORD;
    v_deduct_res       RECORD;
    v_line_cogs_total  NUMERIC(15, 2);
    v_order_cogs_total NUMERIC(15, 2) := 0;
    v_negative_alerts  JSONB := '[]'::jsonb;
    v_low_stock_alerts JSONB := '[]'::jsonb;
BEGIN
    SELECT id, order_code, status INTO v_order FROM pos_orders WHERE id = p_order_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy hóa đơn id: %', p_order_id USING ERRCODE = 'P0002'; END IF;
    IF v_order.status IN ('VOIDED', 'REFUNDED') THEN
        RAISE EXCEPTION 'Không thể trừ kho cho hóa đơn "%" trạng thái %', v_order.order_code, v_order.status USING ERRCODE = 'P0003';
    END IF;
    IF EXISTS (
        SELECT 1 FROM stock_ledger sl JOIN pos_order_items oi ON oi.id = sl.ref_id
        WHERE sl.ref_table = 'pos_order_items' AND sl.txn_type = 'POS_SALE' AND oi.order_id = p_order_id
    ) THEN
        RAISE EXCEPTION 'Hóa đơn "%" đã được trừ kho trước đó.', v_order.order_code USING ERRCODE = 'P0004';
    END IF;

    CREATE TEMP TABLE IF NOT EXISTS tmp_order_bom (
        order_item_id UUID NOT NULL, item_id UUID NOT NULL, qty_base NUMERIC(12, 3) NOT NULL
    ) ON COMMIT DROP;
    TRUNCATE tmp_order_bom;

    INSERT INTO tmp_order_bom (order_item_id, item_id, qty_base)
    SELECT oi.id, bom.item_id, bom.total_qty_base
    FROM pos_order_items oi CROSS JOIN LATERAL fn_calculate_dynamic_bom(oi.id) bom
    WHERE oi.order_id = p_order_id;

    PERFORM 1 FROM inventory_items WHERE id IN (SELECT DISTINCT item_id FROM tmp_order_bom) ORDER BY id ASC FOR UPDATE;

    FOR v_oi IN SELECT id, quantity FROM pos_order_items WHERE order_id = p_order_id ORDER BY id ASC LOOP
        v_line_cogs_total := 0;
        FOR v_bom_line IN SELECT item_id, qty_base FROM tmp_order_bom WHERE order_item_id = v_oi.id ORDER BY item_id ASC LOOP
            SELECT total_cogs, shortfall_qty INTO v_deduct_res
            FROM fn_deduct_stock_fefo(v_bom_line.item_id, v_bom_line.qty_base, 'POS_SALE', 'pos_order_items', v_oi.id, p_actor_id, p_allow_negative);
            v_line_cogs_total := v_line_cogs_total + v_deduct_res.total_cogs;
            IF v_deduct_res.shortfall_qty > 0 THEN
                v_negative_alerts := v_negative_alerts || jsonb_build_object('order_item_id', v_oi.id, 'item_id', v_bom_line.item_id, 'shortfall_qty', v_deduct_res.shortfall_qty);
            END IF;
        END LOOP;
        UPDATE pos_order_items
        SET cogs_snapshot = ROUND(v_line_cogs_total / v_oi.quantity, 2), ticket_printed_at = COALESCE(ticket_printed_at, NOW())
        WHERE id = v_oi.id;
        v_order_cogs_total := v_order_cogs_total + v_line_cogs_total;
    END LOOP;

    SELECT COALESCE(jsonb_agg(jsonb_build_object('item_id', ii.id, 'sku', ii.sku, 'name', ii.name, 'remaining_valid_qty', COALESCE(b.valid_qty, 0), 'min_stock_base', ii.min_stock_base)), '[]'::jsonb)
    INTO v_low_stock_alerts
    FROM (SELECT DISTINCT item_id FROM tmp_order_bom) touched
    JOIN inventory_items ii ON ii.id = touched.item_id
    LEFT JOIN (SELECT item_id, SUM(remaining_qty_base) AS valid_qty FROM inventory_batches WHERE remaining_qty_base > 0 AND expires_at > NOW() GROUP BY item_id) b ON b.item_id = ii.id
    WHERE COALESCE(b.valid_qty, 0) <= ii.min_stock_base;

    RETURN jsonb_build_object(
        'order_id', p_order_id, 'order_code', v_order.order_code,
        'total_order_cogs_vnd', ROUND(v_order_cogs_total, 2),
        'negative_stock_alerts', v_negative_alerts, 'low_stock_alerts', v_low_stock_alerts, 'processed_at', NOW()
    );
END;
$$;

GRANT EXECUTE ON FUNCTION fn_calculate_dynamic_bom(UUID) TO fnb_app_user;
GRANT EXECUTE ON FUNCTION fn_deduct_stock_fefo(UUID, NUMERIC, VARCHAR, VARCHAR, UUID, UUID, BOOLEAN) TO fnb_app_user;
GRANT EXECUTE ON FUNCTION fn_process_pos_order_deduction(UUID, UUID, BOOLEAN) TO fnb_app_user;
