-- ============================================================================
-- HỆ THỐNG QUẢN LÝ VẬN HÀNH F&B CHỐNG THẤT THOÁT (POSTGRESQL 14+)
-- File 01: Schema 23 bảng, Constraints, Indexes, Immutable Triggers & DB Role
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. roles
CREATE TABLE roles (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code        VARCHAR(30)  NOT NULL UNIQUE,
    name        VARCHAR(100) NOT NULL,
    description TEXT,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_roles_code CHECK (code IN ('OWNER', 'MANAGER', 'CASHIER', 'BARISTA'))
);

-- 2. permissions
CREATE TABLE permissions (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code                  VARCHAR(80)  NOT NULL UNIQUE,
    module                VARCHAR(40)  NOT NULL,
    description           TEXT,
    requires_pin_override BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_permissions_module CHECK (
        module IN ('POS', 'INVENTORY', 'BOM', 'EOD', 'HR', 'AUDIT')
    )
);

-- 3. role_permissions
CREATE TABLE role_permissions (
    role_id          UUID  NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_id    UUID  NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    constraints_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (role_id, permission_id)
);

-- 4. users
CREATE TABLE users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    role_id       UUID           NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
    full_name     VARCHAR(120)   NOT NULL,
    phone         VARCHAR(20)    NOT NULL UNIQUE,
    password_hash VARCHAR(255)   NOT NULL,
    pos_pin_hash  VARCHAR(255),
    hourly_rate   NUMERIC(12, 2) NOT NULL DEFAULT 0,
    is_active     BOOLEAN        NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    deleted_at    TIMESTAMPTZ,
    CONSTRAINT chk_users_hourly_rate CHECK (hourly_rate >= 0)
);

-- 5. work_shifts
CREATE TABLE work_shifts (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shift_date         DATE           NOT NULL,
    shift_slot         VARCHAR(20)    NOT NULL,
    manager_id         UUID           NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    opened_at          TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    closed_at          TIMESTAMPTZ,
    opening_cash       NUMERIC(15, 2) NOT NULL DEFAULT 0,
    blind_cash_counted NUMERIC(15, 2),
    expected_cash_pos  NUMERIC(15, 2),
    cash_variance      NUMERIC(15, 2),
    status             VARCHAR(20)    NOT NULL DEFAULT 'OPEN',
    CONSTRAINT chk_work_shifts_slot   CHECK (shift_slot IN ('MORNING', 'AFTERNOON', 'EVENING', 'FULL_DAY')),
    CONSTRAINT chk_work_shifts_status CHECK (status IN ('OPEN', 'CLOSED', 'LOCKED')),
    CONSTRAINT chk_work_shifts_cash   CHECK (opening_cash >= 0 AND (blind_cash_counted IS NULL OR blind_cash_counted >= 0)),
    CONSTRAINT chk_work_shifts_time   CHECK (closed_at IS NULL OR closed_at >= opened_at)
);

-- 6. attendance_logs
CREATE TABLE attendance_logs (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID          NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    shift_id         UUID          NOT NULL REFERENCES work_shifts(id) ON DELETE RESTRICT,
    clock_in_at      TIMESTAMPTZ   NOT NULL,
    clock_out_at     TIMESTAMPTZ,
    wifi_bssid       VARCHAR(32)   NOT NULL,
    gps_lat          NUMERIC(9, 6) NOT NULL,
    gps_lng          NUMERIC(9, 6) NOT NULL,
    face_photo_url   TEXT          NOT NULL,
    is_manual_edited BOOLEAN       NOT NULL DEFAULT FALSE,
    edit_approved_by UUID          REFERENCES users(id) ON DELETE RESTRICT,
    edit_reason      TEXT,
    CONSTRAINT chk_attendance_time CHECK (clock_out_at IS NULL OR clock_out_at >= clock_in_at),
    CONSTRAINT chk_attendance_manual_edit CHECK (
        is_manual_edited = FALSE OR (edit_approved_by IS NOT NULL AND edit_reason IS NOT NULL)
    )
);

-- 7. inventory_items
CREATE TABLE inventory_items (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sku            VARCHAR(50)    NOT NULL UNIQUE,
    name           VARCHAR(150)   NOT NULL,
    item_type      VARCHAR(20)    NOT NULL,
    abc_class      CHAR(1)        NOT NULL DEFAULT 'B',
    base_unit      VARCHAR(15)    NOT NULL,
    tare_weight_g  NUMERIC(10, 3) NOT NULL DEFAULT 0,
    min_stock_base NUMERIC(12, 3) NOT NULL DEFAULT 0,
    avg_unit_cost  NUMERIC(15, 4) NOT NULL DEFAULT 0,
    is_active      BOOLEAN        NOT NULL DEFAULT TRUE,
    created_at     TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    deleted_at     TIMESTAMPTZ,
    CONSTRAINT chk_items_type     CHECK (item_type IN ('RAW', 'SEMI_FINISHED', 'PACKAGING')),
    CONSTRAINT chk_items_abc      CHECK (abc_class IN ('A', 'B', 'C')),
    CONSTRAINT chk_items_baseunit CHECK (base_unit IN ('ml', 'g', 'pcs')),
    CONSTRAINT chk_items_nonneg   CHECK (tare_weight_g >= 0 AND min_stock_base >= 0 AND avg_unit_cost >= 0)
);

-- 8. item_unit_conversions
CREATE TABLE item_unit_conversions (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    item_id          UUID           NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
    unit_name        VARCHAR(40)    NOT NULL,
    to_base_factor   NUMERIC(12, 3) NOT NULL,
    is_purchase_unit BOOLEAN        NOT NULL DEFAULT FALSE,
    is_count_unit    BOOLEAN        NOT NULL DEFAULT FALSE,
    CONSTRAINT uq_item_unit_name     UNIQUE (item_id, unit_name),
    CONSTRAINT chk_conversion_factor CHECK (to_base_factor > 0)
);

-- 9. inventory_batches
CREATE TABLE inventory_batches (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    item_id            UUID           NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
    batch_code         VARCHAR(60)    NOT NULL,
    received_at        TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    expires_at         TIMESTAMPTZ    NOT NULL,
    initial_qty_base   NUMERIC(12, 3) NOT NULL,
    remaining_qty_base NUMERIC(12, 3) NOT NULL,
    unit_cost          NUMERIC(15, 4) NOT NULL,
    CONSTRAINT uq_item_batch_code CHECK (LENGTH(TRIM(batch_code)) > 0),
    CONSTRAINT chk_batch_dates    CHECK (expires_at > received_at),
    CONSTRAINT chk_batch_qty      CHECK (initial_qty_base > 0 AND remaining_qty_base >= 0 AND unit_cost >= 0)
);

-- 10. prep_productions
CREATE TABLE prep_productions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    semi_item_id    UUID           NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
    output_batch_id UUID           NOT NULL UNIQUE REFERENCES inventory_batches(id) ON DELETE RESTRICT,
    prepared_by     UUID           NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    yield_qty_base  NUMERIC(12, 3) NOT NULL,
    prepared_at     TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMPTZ    NOT NULL,
    notes           TEXT,
    CONSTRAINT chk_prep_yield CHECK (yield_qty_base > 0),
    CONSTRAINT chk_prep_dates CHECK (expires_at > prepared_at)
);

-- 11. stock_ledger (APPEND-ONLY)
CREATE TABLE stock_ledger (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    item_id            UUID           NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
    batch_id           UUID           REFERENCES inventory_batches(id) ON DELETE RESTRICT,
    txn_type           VARCHAR(20)    NOT NULL,
    qty_change_base    NUMERIC(12, 3) NOT NULL,
    unit_cost_snapshot NUMERIC(15, 4) NOT NULL,
    ref_table          VARCHAR(50)    NOT NULL,
    ref_id             UUID           NOT NULL,
    created_by         UUID           NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at         TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_ledger_txn_type CHECK (
        txn_type IN ('PURCHASE', 'POS_SALE', 'PREP_OUT', 'PREP_IN', 'WASTE', 'EOD_ADJ')
    ),
    CONSTRAINT chk_ledger_nonzero  CHECK (qty_change_base <> 0),
    CONSTRAINT chk_ledger_cost     CHECK (unit_cost_snapshot >= 0)
);

-- 12. menu_items
CREATE TABLE menu_items (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code         VARCHAR(40)    NOT NULL UNIQUE,
    name         VARCHAR(150)   NOT NULL,
    category     VARCHAR(80)    NOT NULL,
    base_price   NUMERIC(15, 2) NOT NULL,
    is_available BOOLEAN        NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    deleted_at   TIMESTAMPTZ,
    CONSTRAINT chk_menu_price CHECK (base_price >= 0)
);

-- 13. recipes
CREATE TABLE recipes (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    menu_item_id        UUID           REFERENCES menu_items(id) ON DELETE RESTRICT,
    semi_item_id        UUID           REFERENCES inventory_items(id) ON DELETE RESTRICT,
    version_no          INTEGER        NOT NULL DEFAULT 1,
    is_active           BOOLEAN        NOT NULL DEFAULT TRUE,
    standard_yield_base NUMERIC(12, 3) NOT NULL DEFAULT 1,
    calculated_cogs     NUMERIC(15, 2) NOT NULL DEFAULT 0,
    sop_steps_json      JSONB          NOT NULL DEFAULT '[]'::jsonb,
    image_url           TEXT,
    effective_from      TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    created_by          UUID           NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    CONSTRAINT chk_recipes_target_xor CHECK ((menu_item_id IS NOT NULL) <> (semi_item_id IS NOT NULL)),
    CONSTRAINT chk_recipes_version    CHECK (version_no > 0),
    CONSTRAINT chk_recipes_yield      CHECK (standard_yield_base > 0),
    CONSTRAINT chk_recipes_cogs       CHECK (calculated_cogs >= 0)
);

-- 14. recipe_lines
CREATE TABLE recipe_lines (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipe_id       UUID           NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    item_id         UUID           NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
    qty_base        NUMERIC(12, 3) NOT NULL,
    ingredient_role VARCHAR(30)    NOT NULL,
    CONSTRAINT uq_recipe_item_role UNIQUE (recipe_id, item_id, ingredient_role),
    CONSTRAINT chk_recipe_line_qty CHECK (qty_base > 0),
    CONSTRAINT chk_ingredient_role CHECK (
        ingredient_role IN ('BASE_TEA', 'COFFEE', 'MILK', 'SUGAR', 'ICE', 'SYRUP', 'CUP', 'LID', 'TOPPING', 'OTHER')
    )
);

-- 15. modifiers
CREATE TABLE modifiers (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_name  VARCHAR(50)    NOT NULL,
    name        VARCHAR(100)   NOT NULL,
    price_delta NUMERIC(15, 2) NOT NULL DEFAULT 0,
    is_active   BOOLEAN        NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_modifier_group_name UNIQUE (group_name, name)
);

-- 16. modifier_recipe_rules
CREATE TABLE modifier_recipe_rules (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    modifier_id            UUID           NOT NULL REFERENCES modifiers(id) ON DELETE CASCADE,
    target_ingredient_role VARCHAR(30),
    target_item_id         UUID           REFERENCES inventory_items(id) ON DELETE RESTRICT,
    action_type            VARCHAR(20)    NOT NULL,
    value_num              NUMERIC(12, 3),
    replace_with_item_id   UUID           REFERENCES inventory_items(id) ON DELETE RESTRICT,
    CONSTRAINT chk_mod_action CHECK (action_type IN ('ADD', 'MULTIPLY', 'REPLACE')),
    CONSTRAINT chk_mod_target CHECK (
        (action_type = 'ADD' AND target_item_id IS NOT NULL AND value_num > 0) OR
        (action_type = 'MULTIPLY' AND (target_ingredient_role IS NOT NULL OR target_item_id IS NOT NULL) AND value_num >= 0) OR
        (action_type = 'REPLACE' AND (target_ingredient_role IS NOT NULL OR target_item_id IS NOT NULL) AND replace_with_item_id IS NOT NULL)
    )
);

-- 17. pos_orders
CREATE TABLE pos_orders (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_code       VARCHAR(40)    NOT NULL UNIQUE,
    shift_id         UUID           NOT NULL REFERENCES work_shifts(id) ON DELETE RESTRICT,
    cashier_id       UUID           NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    status           VARCHAR(20)    NOT NULL DEFAULT 'OPEN',
    subtotal         NUMERIC(15, 2) NOT NULL DEFAULT 0,
    discount_amount  NUMERIC(15, 2) NOT NULL DEFAULT 0,
    total_amount     NUMERIC(15, 2) NOT NULL DEFAULT 0,
    payment_method   VARCHAR(20)    NOT NULL DEFAULT 'CASH',
    void_approved_by UUID           REFERENCES users(id) ON DELETE RESTRICT,
    void_reason      TEXT,
    created_at       TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    paid_at          TIMESTAMPTZ,
    CONSTRAINT chk_orders_status  CHECK (status IN ('OPEN', 'PAID', 'VOIDED', 'REFUNDED')),
    CONSTRAINT chk_orders_payment CHECK (payment_method IN ('CASH', 'QR_TRANSFER', 'CARD', 'EWALLET')),
    CONSTRAINT chk_orders_amounts CHECK (subtotal >= 0 AND discount_amount >= 0 AND total_amount >= 0),
    CONSTRAINT chk_orders_void    CHECK (
        status NOT IN ('VOIDED', 'REFUNDED') OR (void_reason IS NOT NULL AND LENGTH(TRIM(void_reason)) > 0)
    )
);

-- 18. pos_order_items
CREATE TABLE pos_order_items (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id          UUID           NOT NULL REFERENCES pos_orders(id) ON DELETE RESTRICT,
    menu_item_id      UUID           NOT NULL REFERENCES menu_items(id) ON DELETE RESTRICT,
    recipe_version_id UUID           NOT NULL REFERENCES recipes(id) ON DELETE RESTRICT,
    quantity          INTEGER        NOT NULL DEFAULT 1,
    unit_price        NUMERIC(15, 2) NOT NULL,
    cogs_snapshot     NUMERIC(15, 2) NOT NULL,
    ticket_printed_at TIMESTAMPTZ,
    CONSTRAINT chk_order_items_qty    CHECK (quantity > 0),
    CONSTRAINT chk_order_items_prices CHECK (unit_price >= 0 AND cogs_snapshot >= 0)
);

-- 19. pos_order_item_modifiers
CREATE TABLE pos_order_item_modifiers (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_item_id        UUID           NOT NULL REFERENCES pos_order_items(id) ON DELETE RESTRICT,
    modifier_id          UUID           NOT NULL REFERENCES modifiers(id) ON DELETE RESTRICT,
    price_delta_snapshot NUMERIC(15, 2) NOT NULL DEFAULT 0
);

-- 20. waste_records
CREATE TABLE waste_records (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shift_id         UUID           NOT NULL REFERENCES work_shifts(id) ON DELETE RESTRICT,
    item_id          UUID           NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
    batch_id         UUID           REFERENCES inventory_batches(id) ON DELETE RESTRICT,
    qty_base         NUMERIC(12, 3) NOT NULL,
    reason_code      VARCHAR(30)    NOT NULL,
    notes            TEXT,
    camera_photo_url TEXT           NOT NULL,
    reported_by      UUID           NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    approved_by      UUID           REFERENCES users(id) ON DELETE RESTRICT,
    status           VARCHAR(20)    NOT NULL DEFAULT 'PENDING',
    created_at       TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    approved_at      TIMESTAMPTZ,
    CONSTRAINT chk_waste_qty    CHECK (qty_base > 0),
    CONSTRAINT chk_waste_photo  CHECK (LENGTH(TRIM(camera_photo_url)) > 0),
    CONSTRAINT chk_waste_reason CHECK (reason_code IN ('SPILL', 'EXPIRED', 'WRONG_DRINK', 'QUALITY_TEST', 'EQUIPMENT_FAULT')),
    CONSTRAINT chk_waste_status CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
    CONSTRAINT chk_waste_approve CHECK (
        status <> 'APPROVED' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)
    )
);

-- 21. eod_reconciliations
CREATE TABLE eod_reconciliations (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_date      DATE           NOT NULL,
    shift_id           UUID           NOT NULL REFERENCES work_shifts(id) ON DELETE RESTRICT,
    abc_scope          VARCHAR(10)    NOT NULL DEFAULT 'A',
    status             VARCHAR(20)    NOT NULL DEFAULT 'DRAFT_COUNTING',
    counted_by         UUID           NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    locked_by          UUID           REFERENCES users(id) ON DELETE RESTRICT,
    total_variance_vnd NUMERIC(15, 2) NOT NULL DEFAULT 0,
    submitted_at       TIMESTAMPTZ,
    alert_sent_at      TIMESTAMPTZ,
    created_at         TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_eod_date_shift UNIQUE (business_date, shift_id),
    CONSTRAINT chk_eod_scope     CHECK (abc_scope IN ('A', 'AB', 'ALL')),
    CONSTRAINT chk_eod_status    CHECK (status IN ('DRAFT_COUNTING', 'SUBMITTED', 'LOCKED'))
);

-- 22. eod_reconciliation_lines
CREATE TABLE eod_reconciliation_lines (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reconciliation_id    UUID           NOT NULL REFERENCES eod_reconciliations(id) ON DELETE CASCADE,
    item_id              UUID           NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
    counted_sealed_units NUMERIC(12, 3) NOT NULL DEFAULT 0,
    weighed_gross_g      NUMERIC(12, 3) NOT NULL DEFAULT 0,
    counted_qty_base     NUMERIC(12, 3) NOT NULL DEFAULT 0,
    opening_qty_base     NUMERIC(12, 3),
    purchased_qty_base   NUMERIC(12, 3),
    pos_usage_qty_base   NUMERIC(12, 3),
    waste_qty_base       NUMERIC(12, 3),
    theoretical_qty_base NUMERIC(12, 3),
    variance_qty_base    NUMERIC(12, 3),
    variance_pct_usage   NUMERIC(8, 2),
    variance_vnd         NUMERIC(15, 2),
    alert_level          VARCHAR(10),
    explanation_note     TEXT,
    CONSTRAINT uq_eod_line_item UNIQUE (reconciliation_id, item_id),
    CONSTRAINT chk_eod_counts   CHECK (counted_sealed_units >= 0 AND weighed_gross_g >= 0 AND counted_qty_base >= 0),
    CONSTRAINT chk_eod_alert    CHECK (alert_level IS NULL OR alert_level IN ('GREEN', 'YELLOW', 'RED'))
);

-- 23. audit_logs (APPEND-ONLY)
CREATE TABLE audit_logs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id        UUID         NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    approver_id     UUID         REFERENCES users(id) ON DELETE RESTRICT,
    action_code     VARCHAR(60)  NOT NULL,
    entity_table    VARCHAR(60)  NOT NULL,
    entity_id       UUID         NOT NULL,
    old_values_json JSONB,
    new_values_json JSONB,
    reason          TEXT,
    device_ip       INET,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- INDEXES
CREATE INDEX idx_batches_fefo            ON inventory_batches (item_id, expires_at ASC) WHERE remaining_qty_base > 0;
CREATE INDEX idx_stock_ledger_item_time  ON stock_ledger (item_id, created_at DESC);
CREATE INDEX idx_stock_ledger_ref        ON stock_ledger (ref_table, ref_id);
CREATE UNIQUE INDEX uq_recipes_active_menu ON recipes (menu_item_id) WHERE is_active = TRUE AND menu_item_id IS NOT NULL;
CREATE UNIQUE INDEX uq_recipes_active_semi ON recipes (semi_item_id) WHERE is_active = TRUE AND semi_item_id IS NOT NULL;
CREATE INDEX idx_pos_orders_shift_status ON pos_orders (shift_id, status, created_at DESC);
CREATE INDEX idx_pos_order_items_order   ON pos_order_items (order_id);
CREATE INDEX idx_waste_shift_status      ON waste_records (shift_id, status, created_at DESC);
CREATE INDEX idx_eod_lines_alerts        ON eod_reconciliation_lines (alert_level, reconciliation_id) WHERE alert_level IN ('YELLOW', 'RED');
CREATE INDEX idx_audit_logs_entity       ON audit_logs (entity_table, entity_id, created_at DESC);
CREATE INDEX idx_audit_logs_actor_time   ON audit_logs (actor_id, created_at DESC);
CREATE INDEX idx_attendance_shift_user   ON attendance_logs (shift_id, user_id);

-- IMMUTABILITY TRIGGERS & ROLE
CREATE OR REPLACE FUNCTION fn_prevent_immutable_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'VI PHẠM BẢO MẬT: Bảng "%" là sổ cái bất biến (Append-Only). Cấm %!',
        TG_TABLE_NAME, TG_OP USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_stock_ledger_immutable
    BEFORE UPDATE OR DELETE OR TRUNCATE ON stock_ledger
    FOR EACH STATEMENT EXECUTE FUNCTION fn_prevent_immutable_mutation();

CREATE TRIGGER trg_audit_logs_immutable
    BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_logs
    FOR EACH STATEMENT EXECUTE FUNCTION fn_prevent_immutable_mutation();

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fnb_app_user') THEN
        CREATE ROLE fnb_app_user LOGIN PASSWORD 'CHANGE_THIS_STRONG_PASSWORD';
    END IF;
END $$;

GRANT USAGE ON SCHEMA public TO fnb_app_user;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO fnb_app_user;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE stock_ledger, audit_logs FROM fnb_app_user, PUBLIC;
GRANT SELECT, INSERT ON TABLE stock_ledger, audit_logs TO fnb_app_user;
