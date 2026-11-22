# API CONTRACT — BrewGuard F&B (nguồn sự thật chung cho Backend / Frontend / QA)

Base URL: `http://localhost:3000`. Mọi API dưới `/api`, JSON UTF-8. Backend (Node.js 22, Express + pg) cũng phục vụ tĩnh thư mục `frontend/` tại `/`.

DB: PostgreSQL 16 (docker `fnb_db`, port 5432, db `fnb_ops`). Khởi tạo từ `database/01..04*.sql`.
- App kết nối bằng role **`fnb_app_user` / `CHANGE_THIS_STRONG_PASSWORD`** (env `DATABASE_URL`) → bị chặn UPDATE/DELETE trên `stock_ledger`, `audit_logs`.
- `ADMIN_DATABASE_URL` (postgres/postgres) CHỈ dùng cho `POST /api/admin/reset-demo`.
- ID cố định trong seed: xem `database/03_seed_and_test.sql`, `04_app_seed.sql` (users `2000...0001..4`, shift `21000000-...-0001`, items `3000...0001..6`, menu `4000...0001..3`, modifiers `4200...0001..4`).

## Quy ước chung
- Auth: `Authorization: Bearer <JWT>` (HS256, env `JWT_SECRET`, payload `{sub:user_id, role}`; hạn 12h).
- Lỗi: HTTP status + body `{ "error": { "code": "STRING_CODE", "message": "Tiếng Việt" } }`.
  - 400 `VALIDATION_ERROR` • 401 `UNAUTHORIZED` • 403 `FORBIDDEN` (RBAC) • 404 `NOT_FOUND` • 409 `CONFLICT` / `SHIFT_CLOSED` / `INVALID_STATE` • 422 `INVALID_PIN` / `ATTENDANCE_REJECTED` • 500 `INTERNAL`.
- Số tiền / số lượng trả về dạng **number** JS (không phải string; convert NUMERIC).
- **Ẩn giá theo RBAC**: với role ≠ `OWNER`, KHÔNG được có các key sau trong response (xóa hẳn key, không trả null): `unit_cost`, `avg_unit_cost`, `unit_cost_snapshot`, `cogs`, `cogs_snapshot`, `total_order_cogs_vnd`, `calculated_cogs`, `est_cogs`, `food_cost_pct`, `variance_vnd`, `total_variance_vnd`, `value_vnd`.
- Mọi nghiệp vụ ghi (đơn, hủy, prep, waste, EOD, chốt két, chấm công) phải chạy trong **1 transaction** và ghi `audit_logs` khi có ghi chú dưới đây.
- "Ca hiện tại" = `work_shifts` mới nhất theo `opened_at` (seed: `21000000-0000-0000-0000-000000000001`).

## Ma trận quyền (rút gọn, enforce ở middleware)
| Endpoint nhóm | OWNER | MANAGER | CASHIER | BARISTA |
|---|---|---|---|---|
| POS bán / xem đơn | ✓ | ✓ | ✓ | 403 |
| Hủy đơn đã thu | ✓ (cần reason) | ✓ (cần reason) | cần `approver_pin` của MANAGER/OWNER | 403 |
| Kho xem (items/batches/ledger) | ✓ có giá | ✓ ẩn giá | 403 | ✓ ẩn giá |
| Nhập mua hàng (purchase) | ✓ | 403 | 403 | 403 |
| Prep | ✓ | ✓ | 403 | ✓ |
| Waste tạo | ✓ (tự duyệt) | ✓ (tự duyệt) | 403 | ✓ (PENDING) |
| Waste duyệt/từ chối | ✓ | ✓ | 403 | 403 |
| BOM xem | ✓ có giá | ✓ ẩn giá | ✓ chỉ tên món (menu) | ✓ ẩn giá |
| BOM tạo phiên bản | ✓ | 403 | 403 | 403 |
| Menu bật/tắt hết món | ✓ | ✓ | 403 | 403 |
| EOD đếm/nộp | ✓ | ✓ | 403 | ✓ |
| EOD xem chênh lệch, khóa, mở lại | ✓ | 403 | 403 | 403 |
| Chốt két mù | ✓ | ✓ | ✓ | 403 |
| Chấm công / xem chấm công | ✓ | ✓ | ✓ | ✓ |
| Audit log, Dashboard, reset-demo, mở lại ca | ✓ | 403 | 403 | 403 |

## Endpoints

### Hệ thống & Auth
- `GET /api/health` → `{ok:true, db:true}` (không cần auth).
- `POST /api/auth/login` `{phone, password}` → `{token, user:{id, full_name, role}}`. Mật khẩu demo: `123456` (phone `0901000001..4`). Sai → 401.
- `POST /api/auth/demo-login` `{role:"OWNER"|"MANAGER"|"CASHIER"|"BARISTA"}` → như login, đăng nhập user seed của role đó (phục vụ bộ chuyển vai trò của prototype). Role sai → 400.
- `GET /api/me` → `{id, full_name, role, phone}`.

### Ca làm việc & Chốt két mù
- `GET /api/shift/current` → `{id, shift_date, shift_slot, status, opened_at, closed_at, opening_cash, blind_cash_counted, manager_name}` + chỉ OWNER: `expected_cash_pos` (= opening_cash + Σ total_amount đơn PAID + CASH trong ca, tính live), `cash_variance`.
- `POST /api/shift/blind-close` `{counted_cash:number>=0}` (OWNER/MANAGER/CASHIER). Shift phải `OPEN` (khác → 409 `SHIFT_CLOSED`). Ghi `blind_cash_counted`, `expected_cash_pos`, `cash_variance = counted - expected`, `closed_at=NOW()`, `status='CLOSED'`. Audit `SHIFT_BLIND_CASH_CLOSE`. Response `{status:'CLOSED', blind_cash_counted}` + chỉ OWNER `expected_cash_pos`, `cash_variance`.
- `POST /api/shift/reopen` (OWNER) → status `OPEN`, xóa closed_at/blind_cash_counted/expected/variance. Audit `SHIFT_REOPEN`.

### Menu / BOM / Modifiers
- `GET /api/menu` → mảng `{id, code, name, category, base_price, is_available, recipe:{id, version_no, sop_steps:[string], lines:[{item_id, sku, item_name, base_unit, qty_base, ingredient_role}], est_cogs*}}` sắp xếp theo code. `est_cogs` (OWNER) = Σ qty_base × avg_unit_cost. Với CASHIER: `recipe` chỉ gồm `{id, version_no}` (không lines/sop).
- `GET /api/modifiers` → `{id, group_name, name, price_delta, rules:[{action_type, target_ingredient_role, target_item_id, value_num, replace_with_item_id}]}` (mọi role đã đăng nhập).
- `PATCH /api/menu/:id/availability` `{is_available:boolean}` (OWNER/MANAGER). Audit `MENU_AVAILABILITY`.
- `POST /api/menu/:id/recipe-version` (OWNER) body tùy chọn `{lines?:[{item_id, qty_base, ingredient_role}], sop_steps?:[string]}` → copy recipe active, `version_no+1`, active cũ = FALSE, lines mới (hoặc copy), tính `calculated_cogs`. Trả recipe mới. Audit `BOM_VERSION_BUMP` (old/new version). Đơn cũ giữ `recipe_version_id` cũ.

### POS
- `POST /api/orders` (OWNER/MANAGER/CASHIER) `{items:[{menu_item_id, quantity:int>=1, modifier_ids:[uuid]}], payment_method:'CASH'|'QR_TRANSFER'|'CARD'|'EWALLET', order_code?:string}`.
  - Ca hiện tại phải `OPEN` (khác → 409 `SHIFT_CLOSED`). Món `is_available=false` → 409. items rỗng → 400. `order_code` trùng → 409 `CONFLICT`.
  - `order_code` mặc định: `ORD-YYYYMMDD-NNN` (NNN tăng theo số đơn trong ngày).
  - Trong 1 transaction: insert `pos_orders` (status `PAID`, `paid_at=NOW()`, cashier_id = user), mỗi item: `recipe_version_id` = recipe active, `unit_price = base_price + Σ price_delta`, `cogs_snapshot=0`; insert `pos_order_item_modifiers` (snapshot price_delta); `subtotal=total_amount=Σ unit_price×quantity`; rồi `SELECT fn_process_pos_order_deduction(order_id, user_id, TRUE)`.
  - Response 201: `{order:{id, order_code, status, payment_method, subtotal, total_amount, created_at, items:[{id, menu_item_id, menu_name, quantity, unit_price, modifiers:[name], cogs_snapshot*}], cogs*}, deduction:{low_stock_alerts:[{item_id, sku, name, remaining_valid_qty, min_stock_base}], negative_stock_alerts:[...], total_order_cogs_vnd*}}`.
- `GET /api/orders` (OWNER/MANAGER/CASHIER) → đơn của ca hiện tại, mới nhất trước: `{id, order_code, status, payment_method, total_amount, created_at, paid_at, cashier_name, void_reason, void_approved_by_name, summary:"2x Trà Sữa Truyền Thống (Size L, 0% Đường, Thêm Trân châu đen)", cogs*}`.
- `POST /api/orders/:id/void` `{reason:string (bắt buộc, trim>0), approver_pin?:string}`.
  - Chỉ đơn `PAID` (khác → 409 `INVALID_STATE`). Thiếu reason → 400.
  - CASHIER: bắt buộc `approver_pin` khớp (bcrypt `crypt()`) với `pos_pin_hash` của một user active role MANAGER/OWNER, sai/thiếu → 422 `INVALID_PIN`. `void_approved_by` = user đó.
  - MANAGER/OWNER: `void_approved_by` = chính họ.
  - Không hoàn kho (ly đã pha). Status `VOIDED`. Audit `POS_VOID_PAID` (actor, approver, reason, old/new). Response `{id, order_code, status:'VOIDED', void_reason, void_approved_by_name}`.

### Kho
- `GET /api/inventory/items` (OWNER/MANAGER/BARISTA) → `{id, sku, name, item_type, abc_class, base_unit, tare_weight_g, min_stock_base, valid_stock (Σ remaining lô còn hạn), expired_stock (Σ remaining lô quá hạn), is_low (valid_stock <= min_stock_base), count_unit:{unit_name, to_base_factor}|null, avg_unit_cost*}`.
- `GET /api/inventory/batches` (OWNER/MANAGER/BARISTA) → `{id, batch_code, item_id, item_name, item_type, abc_class, base_unit, received_at, expires_at, initial_qty_base, remaining_qty_base, is_expired, unit_cost*}` sắp xếp item sku, expires_at.
- `GET /api/inventory/ledger?limit=200` (OWNER/MANAGER/BARISTA) → mới nhất trước `{id, created_at, txn_type, item_id, item_name, base_unit, batch_id, batch_code|null, qty_change_base, ref_table, ref_id, created_by_name, unit_cost_snapshot*, value_vnd* (=|qty|×unit_cost)}`.
- `POST /api/inventory/purchases` (OWNER) `{item_id, qty_base>0, unit_cost>=0, expires_at (ISO, > now), batch_code?}` → tạo `inventory_batches` + ledger `PURCHASE` (ref_table `inventory_batches`) + cập nhật `avg_unit_cost` bình quân gia quyền trên tồn còn hạn. Audit `PURCHASE_RECEIVED`. 201 trả batch.
- `POST /api/inventory/prep` (OWNER/MANAGER/BARISTA) `{semi_item_id, yield_qty_base>0, notes?}`. Item phải là `SEMI_FINISHED` (khác → 400). Hạn dùng: SKU `PREP-TEA` 6h, `PREP-PEARL` 4h, khác 8h. Nếu có recipe active cho semi_item (recipes.semi_item_id) → trừ nguyên liệu bằng `fn_deduct_stock_fefo(..., 'PREP_OUT', 'prep_productions', prep_id, user)` theo tỉ lệ yield/standard_yield_base và đơn giá lô = tổng cogs/yield; nếu không có → đơn giá lô = avg_unit_cost. Tạo batch (`batch_code` = `<SKU>-PREP-YYYYMMDDHHmmss`), `prep_productions`, ledger `PREP_IN` (ref_table `prep_productions`). Audit `PREP_PRODUCTION`. 201 trả `{batch, prep_id}`.

### Báo hủy (Waste)
- `GET /api/waste` (OWNER/MANAGER/BARISTA) → phiếu của ca hiện tại `{id, item_id, item_name, base_unit, qty_base, reason_code, notes, camera_photo_url, status, reported_by_name, approved_by_name, created_at, approved_at}`.
- `POST /api/waste` (OWNER/MANAGER/BARISTA) `{item_id, qty_base>0, reason_code:'SPILL'|'EXPIRED'|'WRONG_DRINK'|'QUALITY_TEST'|'EQUIPMENT_FAULT', notes?, camera_photo_url (bắt buộc, không rỗng; chỉ chấp nhận tiền tố "camera://" — chặn ảnh từ thư viện → 400)}`. BARISTA → `PENDING`. OWNER/MANAGER → tạo và duyệt ngay (cùng logic approve). Audit `WASTE_CREATED`. 201.
- `POST /api/waste/:id/approve` (OWNER/MANAGER) → chỉ `PENDING` (khác 409). Trừ kho: nếu `reason_code='EXPIRED'` trừ trước các lô quá hạn (UPDATE remaining + INSERT ledger `WASTE` từng lô, ref_table `waste_records`), phần còn lại qua `fn_deduct_stock_fefo(item, rem, 'WASTE', 'waste_records', id, approver, TRUE)`. Set `APPROVED`, approved_by, approved_at. Audit `WASTE_APPROVED`.
- `POST /api/waste/:id/reject` (OWNER/MANAGER) `{reason?}` → `REJECTED`. Audit `WASTE_REJECTED`.

### EOD — Kiểm kho mù
- `GET /api/eod/current` (OWNER/MANAGER/BARISTA) → phiếu của (CURRENT_DATE, ca hiện tại); nếu chưa có thì **tự tạo** `DRAFT_COUNTING` (counted_by = user, scope 'A') với dòng cho mọi item `abc_class='A'` (giá trị đếm 0). Trả `{id, business_date, status, abc_scope, counted_by_name, submitted_at, lines:[{item_id, sku, item_name, base_unit, tare_weight_g, count_unit:{unit_name,to_base_factor}, counted_sealed_units, weighed_gross_g, counted_qty_base, ...}]}`.
  - **Bất kể role**, khi `status='DRAFT_COUNTING'` KHÔNG trả các key: `opening_qty_base, purchased_qty_base, pos_usage_qty_base, waste_qty_base, theoretical_qty_base, variance_qty_base, variance_pct_usage, variance_vnd, alert_level, total_variance_vnd`.
  - Khi SUBMITTED/LOCKED: chỉ OWNER thấy các key trên + `summary:{red, yellow, green, total_variance_vnd}`; role khác vẫn bị ẩn.
- `PUT /api/eod/current/lines` (OWNER/MANAGER/BARISTA) `{lines:[{item_id, counted_sealed_units>=0, weighed_gross_g>=0}]}`. Chỉ khi DRAFT (khác → 409 `INVALID_STATE`). `counted_qty_base = sealed × count_unit.to_base_factor (mặc định 1) + (base_unit='pcs' ? weighed_gross_g : max(0, weighed_gross_g − tare_weight_g))`. Trả như GET.
- `POST /api/eod/current/submit` (OWNER/MANAGER/BARISTA) → chỉ DRAFT. Với mỗi dòng (ngày = business_date, theo ledger):
  - `purchased = Σ qty>0 PURCHASE+PREP_IN hôm nay`, `pos_usage = |Σ POS_SALE hôm nay|`, `waste = |Σ WASTE hôm nay|`, `opening = Σ ledger trước hôm nay`.
  - `theoretical = Σ toàn bộ ledger của item − Σ remaining lô đã quá hạn` (hàng quá hạn bị khóa, không tính tồn quầy).
  - `variance = counted − theoretical`; `variance_pct_usage = pos_usage>0 ? |variance|/pos_usage×100 : (variance≠0 ? 100 : 0)` (làm tròn 2).
  - `alert_level`: base_unit `pcs` và variance ≤ −3 → RED; pct > 5 → RED; pct ≥ 2 → YELLOW; còn lại GREEN.
  - `variance_vnd = variance × avg_unit_cost`. Header `total_variance_vnd = Σ variance_vnd`, `submitted_at`, status `SUBMITTED`, `alert_sent_at=NOW()` nếu có RED.
  - Audit `EOD_BLIND_SUBMIT` (số RED). Response như GET (theo quy tắc ẩn).
- `POST /api/eod/current/lock` (OWNER) → SUBMITTED → LOCKED, `locked_by`. Audit `EOD_LOCK`.
- `POST /api/eod/current/reopen` (OWNER) → về DRAFT_COUNTING, xóa các cột lý thuyết/chênh lệch. Audit `EOD_REOPEN`.

### Nhân sự & Audit
- `GET /api/hr/attendance` (mọi role) → chấm công của ca hiện tại `{id, user_id, full_name, role, clock_in_at, clock_out_at, wifi_bssid, gps_lat, gps_lng, is_valid:true}`.
- `POST /api/hr/clock-in` (mọi role) `{wifi_bssid, gps_lat, gps_lng, face_photo_url}`. Hợp lệ khi `wifi_bssid` ∈ env `ALLOWED_BSSIDS` (mặc định `8C:3B:AD:12:9F`) VÀ khoảng cách Haversine tới quán (env `STORE_LAT=10.9032`, `STORE_LNG=106.7681`) ≤ 150m VÀ face_photo_url không rỗng. Sai → 422 `ATTENDANCE_REJECTED` (message nêu lý do). Đã chấm công chưa clock-out trong ca → 409. 201. Audit `HR_CLOCK_IN`.
- `POST /api/hr/clock-out` (mọi role) → set clock_out_at bản ghi mở gần nhất; không có → 404.
- `GET /api/audit-logs?limit=100` (OWNER) → `{id, created_at, action_code, entity_table, entity_id, actor_name, approver_name, reason, old_values_json, new_values_json}` mới nhất trước.
- `GET /api/dashboard` (OWNER) → `{revenue, paid_orders, cogs, food_cost_pct, voided_orders, low_stock:[{item_id,name,base_unit,valid_stock,min_stock_base}], expired_batches:[{batch_id,batch_code,item_name,base_unit,remaining_qty_base}], eod:{status, red, yellow}|null, recent_audit:[6 dòng như audit-logs]}` (số liệu ca hiện tại).

### Demo
- `POST /api/admin/reset-demo` (OWNER) → qua ADMIN_DATABASE_URL: `DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO postgres, public;` rồi chạy lần lượt `database/01_schema.sql … 04_app_seed.sql` (đọc file từ env `DB_SQL_DIR`, mặc định `../database`). Trả `{ok:true}`. Token cũ vẫn hợp lệ (ID user cố định).

## Kịch bản kiểm thử chuẩn (phải pass)
Sau reset-demo, CASHIER bán `{items:[{menu_item_id:'40000000-0000-0000-0000-000000000001', quantity:2, modifier_ids:['42000000-0000-0000-0000-000000000001','42000000-0000-0000-0000-000000000002','42000000-0000-0000-0000-000000000003']}], payment_method:'QR_TRANSFER', order_code:'ORD-TEST-001'}`:
- total_amount = 100000; OWNER thấy `cogs`=18560 (CASHIER không thấy key `cogs`).
- Lô `MILK-EXPIRED-00` vẫn còn 500 (bị bỏ qua); `MILK-FEFO-01` còn 0; `MILK-FEFO-02` còn 890; `TEA-MORNING-01` còn 0; `TEA-NOON-02` còn 2810; `PEARL-NOON-01` còn 900; `CUP700-LOT-01` còn 198; SUGAR không bị trừ.
- `deduction.low_stock_alerts` chứa `MILK-FRESH` với `remaining_valid_qty`=890.
- Kết nối bằng `fnb_app_user`: `DELETE FROM stock_ledger` lỗi SQLSTATE `42501`.
