// =============================================================================
// app.js — BrewGuard F&B Frontend (kết nối live API, ZERO tính toán nghiệp vụ)
// =============================================================================
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // 1. LỚP GỌI API TRUNG TÂM & QUẢN LÝ PHIÊN ĐĂNG NHẬP
  // ---------------------------------------------------------------------------
  const TOKEN_KEY = 'fnb_token';
  const ROLE_KEY = 'fnb_role';
  const USER_KEY = 'fnb_user';

  class ApiError extends Error {
    constructor(status, code, message, body) {
      super(message || code || ('HTTP ' + status));
      this.status = status;
      this.code = code || 'HTTP_' + status;
      this.body = body;
    }
  }

  const session = {
    get token() { return localStorage.getItem(TOKEN_KEY); },
    get role() { return localStorage.getItem(ROLE_KEY) || 'OWNER'; },
    get user() {
      try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch (e) { return null; }
    },
    save(token, user) {
      localStorage.setItem(TOKEN_KEY, token);
      if (user) {
        localStorage.setItem(USER_KEY, JSON.stringify(user));
        if (user.role) localStorage.setItem(ROLE_KEY, user.role);
      }
    },
    setRole(role) { localStorage.setItem(ROLE_KEY, role); },
    clear() {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
    }
  };

  async function rawFetch(method, path, body, token) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = 'Bearer ' + token;

    let res;
    try {
      res = await fetch(path, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined
      });
    } catch (e) {
      throw new ApiError(0, 'NETWORK_ERROR', 'Không kết nối được máy chủ API. Vui lòng kiểm tra backend.');
    }

    let data = null;
    const text = await res.text();
    if (text) {
      try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }
    }
    if (!res.ok) {
      const err = (data && data.error) || {};
      throw new ApiError(res.status, err.code, err.message || ('Lỗi HTTP ' + res.status), data);
    }
    return data;
  }

  async function demoLogin(role) {
    const data = await rawFetch('POST', '/api/auth/demo-login', { role });
    session.save(data.token, data.user);
    return data;
  }

  async function loginWithPhone(phone, password) {
    const data = await rawFetch('POST', '/api/auth/login', { phone, password });
    session.save(data.token, data.user);
    return data;
  }

  function showErrorToast(e) {
    const titles = {
      FORBIDDEN: '⛔ Không có quyền (RBAC)',
      VALIDATION_ERROR: 'Dữ liệu không hợp lệ',
      SHIFT_CLOSED: '🔒 Ca đã chốt',
      INVALID_PIN: 'Sai mã PIN phê duyệt',
      ATTENDANCE_REJECTED: '❌ Chấm công bị từ chối',
      CONFLICT: 'Xung đột dữ liệu',
      INVALID_STATE: 'Trạng thái không hợp lệ',
      NOT_FOUND: 'Không tìm thấy',
      NETWORK_ERROR: 'Mất kết nối API'
    };
    showToast(titles[e.code] || `Lỗi ${e.status || ''} ${e.code || ''}`.trim(), e.message, 'danger');
  }

  async function api(method, path, body, opts = {}) {
    try {
      try {
        return await rawFetch(method, path, body, session.token);
      } catch (e) {
        if (e.status === 401 && !opts._retried) {
          await demoLogin(session.role || 'OWNER');
          return await rawFetch(method, path, body, session.token);
        }
        throw e;
      }
    } catch (e) {
      if (!opts.quiet) showErrorToast(e);
      throw e;
    }
  }

  // ---------------------------------------------------------------------------
  // 2. HẰNG SỐ GIAO DIỆN (khớp prototype)
  // ---------------------------------------------------------------------------
  const ROLES = {
    OWNER:   { name: 'Nguyễn Minh Chủ',  label: 'Chủ quán',   badge: 'bg-amber-100 text-amber-900',     hint: 'Toàn quyền: xem COGS, sửa BOM, xem chênh lệch EOD & Audit Log.' },
    MANAGER: { name: 'Trần Lan Quản Lý', label: 'Quản lý ca', badge: 'bg-blue-100 text-blue-900',       hint: 'Ẩn giá vốn & kiểm kho mù. Mã PIN duyệt tại quầy: 2468.' },
    CASHIER: { name: 'Lê Huy Thu Ngân',  label: 'Thu ngân',   badge: 'bg-emerald-100 text-emerald-900', hint: 'Chỉ bán POS & chốt két mù. Hủy đơn đã in tem cần PIN Quản lý.' },
    BARISTA: { name: 'Phạm An Barista',  label: 'Barista',    badge: 'bg-purple-100 text-purple-900',   hint: 'Xem SOP, nấu bán thành phẩm, báo hủy kèm ảnh & kiểm kho mù.' }
  };

  const NAV_ITEMS = [
    { id: 'dashboard', label: 'Tổng quan Chủ quán', icon: 'layout-dashboard', roles: ['OWNER'] },
    { id: 'pos',       label: 'Bán hàng POS & BOM', icon: 'shopping-bag',     roles: ['OWNER', 'MANAGER', 'CASHIER'] },
    { id: 'inventory', label: 'Kho FEFO & Sổ cái',  icon: 'boxes',            roles: ['OWNER', 'MANAGER', 'BARISTA'] },
    { id: 'bom',       label: 'Công thức & SOP',    icon: 'book-open',        roles: ['OWNER', 'MANAGER', 'BARISTA', 'CASHIER'] },
    { id: 'eod',       label: 'Đối soát EOD (Mù)',  icon: 'scale',            roles: ['OWNER', 'MANAGER', 'BARISTA'] },
    { id: 'hr',        label: 'Nhân sự & Audit Log',icon: 'shield-check',     roles: ['OWNER', 'MANAGER', 'CASHIER', 'BARISTA'] }
  ];

  const SHIFT_SLOTS = { MORNING: 'Ca Sáng', AFTERNOON: 'Ca Chiều', EVENING: 'Ca Tối', NIGHT: 'Ca Đêm' };
  const MOD_GROUP_LABELS = { SIZE: 'Kích cỡ ly', SUGAR: 'Mức đường', ICE: 'Mức đá', TOPPING: 'Topping thêm' };
  const SINGLE_CHOICE_GROUPS = { SIZE: 'Size M (mặc định)', SUGAR: '100% Đường (mặc định)', ICE: 'Đá bình thường (mặc định)' };
  const WASTE_REASONS = {
    EXPIRED: 'Hết hạn sử dụng (EXPIRED)',
    SPILL: 'Làm đổ / vỡ (SPILL)',
    WRONG_DRINK: 'Pha nhầm món (WRONG_DRINK)',
    QUALITY_TEST: 'Kiểm tra chất lượng (QUALITY_TEST)',
    EQUIPMENT_FAULT: 'Lỗi thiết bị (EQUIPMENT_FAULT)'
  };
  const PAYMENT_LABELS = { CASH: 'Tiền mặt', QR_TRANSFER: 'Chuyển khoản QR', CARD: 'Thẻ', EWALLET: 'Ví điện tử' };
  const EOD_STATUS_LABEL = { DRAFT_COUNTING: 'Đang kiểm đếm', SUBMITTED: 'Đã nộp', LOCKED: 'Đã khóa sổ' };

  const PRESET = {
    menuId: '40000000-0000-0000-0000-000000000001',
    modifierIds: [
      '42000000-0000-0000-0000-000000000001',
      '42000000-0000-0000-0000-000000000002',
      '42000000-0000-0000-0000-000000000003'
    ],
    orderCode: 'ORD-TEST-001'
  };
  const DEMO_GEO = { wifi_bssid: '8C:3B:AD:12:9F', gps_lat: 10.9032, gps_lng: 106.7681 };

  // ---------------------------------------------------------------------------
  // 3. TRẠNG THÁI UI (chỉ cache dữ liệu API + giỏ hàng tạm + nháp ô nhập EOD)
  // ---------------------------------------------------------------------------
  const state = {
    role: session.role,
    user: session.user,
    tab: localStorage.getItem('fnb_tab') || 'pos',
    cart: [],
    loading: false,
    loadSeq: 0,
    errors: {},
    shift: null,
    menu: [],
    modifiers: [],
    orders: [],
    items: [],
    batches: [],
    ledger: [],
    waste: [],
    eod: null,
    eodEdits: {},
    attendance: [],
    auditLogs: [],
    dashboard: null
  };

  // ---------------------------------------------------------------------------
  // 4. TIỆN ÍCH HIỂN THỊ (CHỈ FORMAT DỮ LIỆU TỪ API)
  // ---------------------------------------------------------------------------
  const esc = v => String(v ?? '').replace(/[&<>"'`]/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;'
  }[c]));
  const has = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
  const vnd = n => new Intl.NumberFormat('vi-VN').format(Math.round(Number(n) || 0)) + 'đ';
  const num = n => new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 2 }).format(Number(n) || 0);
  const isOwner = () => state.role === 'OWNER';

  function fmtTime(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    if (isNaN(d)) return esc(ts);
    return d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function fmtDateTime(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    if (isNaN(d)) return esc(ts);
    return d.toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
  }

  function timeLeftLabel(ts) {
    const ms = new Date(ts).getTime() - Date.now();
    if (isNaN(ms)) return '—';
    const h = ms / 3600000;
    if (h < 1) return `Còn ${Math.max(1, Math.round(ms / 60000))} phút`;
    if (h < 48) return `Còn ${Math.round(h)} giờ`;
    const d = h / 24;
    if (d < 60) return `Còn ${Math.round(d)} ngày`;
    if (d < 365) return `Còn ${Math.round(d / 30)} tháng`;
    return `Còn ${Math.round(d / 365)} năm`;
  }

  function auditDetail(l) {
    const parts = [];
    if (l.reason) parts.push(l.reason);
    const nv = l.new_values_json;
    if (nv && typeof nv === 'object') {
      const s = Object.entries(nv)
        .slice(0, 4)
        .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
        .join(', ');
      if (s) parts.push(s);
    } else if (nv) {
      parts.push(String(nv));
    }
    if (l.entity_table) parts.push(`(${l.entity_table})`);
    const txt = parts.join(' — ');
    return txt.length > 180 ? txt.slice(0, 177) + '...' : txt;
  }

  function showToast(title, desc, type = 'info') {
    const colors = {
      success: 'bg-emerald-600 text-white',
      warn:    'bg-amber-500 text-slate-950',
      danger:  'bg-rose-600 text-white',
      info:    'bg-slate-800 text-white'
    };
    const el = document.createElement('div');
    el.className = `toast-enter rounded-xl shadow-lg px-4 py-3 ${colors[type] || colors.info}`;
    el.innerHTML = `<div class="font-bold text-sm">${esc(title)}</div>${desc ? `<div class="text-xs opacity-90 mt-0.5">${esc(desc)}</div>` : ''}`;
    const container = document.getElementById('toast-container');
    if (container) {
      container.appendChild(el);
      setTimeout(() => el.remove(), 5200);
    }
  }

  function refreshIcons() {
    if (window.lucide) window.lucide.createIcons();
  }

  function openModal(html) {
    const bd = document.getElementById('modal-backdrop');
    document.getElementById('modal-box').innerHTML = html;
    bd.classList.remove('hidden');
    bd.classList.add('flex');
    refreshIcons();
  }

  function closeModal() {
    const bd = document.getElementById('modal-backdrop');
    bd.classList.add('hidden');
    bd.classList.remove('flex');
  }

  function setBusy(btn, busy) {
    if (!btn) return;
    btn.disabled = busy;
    btn.classList.toggle('opacity-60', busy);
  }

  // ---------------------------------------------------------------------------
  // 5. AUTH & ĐIỀU HƯỚNG
  // ---------------------------------------------------------------------------
  async function ensureSession() {
    if (!session.token) {
      await demoLogin(state.role || 'OWNER');
    }
    try {
      const me = await api('GET', '/api/me', undefined, { quiet: true });
      if (me && me.role) {
        state.user = me;
        state.role = me.role;
        session.setRole(me.role);
      }
    } catch (e) {
      await demoLogin(state.role || 'OWNER');
      state.user = session.user;
      state.role = session.role;
    }
    state.user = state.user || session.user;
  }

  async function switchRole(role) {
    try {
      const data = await demoLogin(role);
      state.role = data.user?.role || role;
      state.user = data.user;
      state.cart = [];
      state.eodEdits = {};
      state.errors = {};
      showToast(`Đang giả lập: ${ROLES[state.role]?.label || state.role}`, ROLES[state.role]?.hint || '', 'info');
    } catch (e) {
      showToast('Không đổi được vai trò', e.message, 'danger');
      document.getElementById('role-switcher').value = state.role;
      return;
    }
    await loadAndRender();
  }

  function openLoginModal() {
    openModal(`
      <div class="p-5 border-b border-slate-200 flex items-center justify-between">
        <div>
          <h3 class="font-bold text-slate-900">Đăng nhập SĐT &amp; Mật khẩu</h3>
          <div class="text-xs text-slate-500">Tài khoản seed: 0901000001 → 0901000004 • Mật khẩu: 123456</div>
        </div>
        <button onclick="closeModal()" class="text-slate-400 hover:text-slate-700"><i data-lucide="x" class="w-5 h-5"></i></button>
      </div>
      <div class="p-5 space-y-3 text-sm">
        <div>
          <label class="text-xs font-semibold text-slate-600">Số điện thoại</label>
          <input id="login-phone" type="tel" value="0901000003" class="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2" />
        </div>
        <div>
          <label class="text-xs font-semibold text-slate-600">Mật khẩu</label>
          <input id="login-password" type="password" value="" placeholder="123456" class="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2" />
        </div>
      </div>
      <div class="p-4 bg-slate-50 border-t border-slate-200 flex justify-end gap-2">
        <button onclick="closeModal()" class="px-4 py-2 text-xs font-semibold text-slate-600">Hủy</button>
        <button id="login-submit" onclick="submitLogin(this)" class="px-4 py-2 bg-slate-900 text-white text-xs font-bold rounded-lg">Đăng nhập</button>
      </div>
    `);
  }

  async function submitLogin(btn) {
    const phone = document.getElementById('login-phone').value.trim();
    const password = document.getElementById('login-password').value;
    if (!phone || !password) return showToast('Thiếu thông tin', 'Nhập số điện thoại và mật khẩu.', 'danger');
    setBusy(btn, true);
    try {
      const data = await loginWithPhone(phone, password);
      state.user = data.user;
      state.role = data.user.role;
      state.cart = [];
      state.eodEdits = {};
      state.errors = {};
      closeModal();
      showToast(`Xin chào ${data.user.full_name}`, `Đăng nhập với vai trò ${ROLES[state.role]?.label || state.role}.`, 'success');
      await loadAndRender();
    } catch (e) {
      showToast('Đăng nhập thất bại', e.status === 401 ? 'Sai số điện thoại hoặc mật khẩu.' : e.message, 'danger');
    } finally {
      setBusy(btn, false);
    }
  }

  function allowedTabs() {
    return NAV_ITEMS.filter(t => t.roles.includes(state.role));
  }

  function switchTab(id) {
    if (!allowedTabs().some(t => t.id === id)) return;
    state.tab = id;
    localStorage.setItem('fnb_tab', id);
    loadAndRender();
  }

  // ---------------------------------------------------------------------------
  // 6. NẠP DỮ LIỆU TỪ API
  // ---------------------------------------------------------------------------
  async function loadShift() {
    try {
      state.shift = await api('GET', '/api/shift/current', undefined, { quiet: true });
    } catch (e) {
      state.shift = null;
    }
    renderShiftBadge();
  }

  async function safeGet(key, path, assign) {
    try {
      const data = await api('GET', path, undefined, { quiet: true });
      assign(data);
      delete state.errors[key];
    } catch (e) {
      state.errors[key] = e;
    }
  }

  async function loadTabData(tab) {
    const tasks = [loadShift()];
    switch (tab) {
      case 'dashboard':
        tasks.push(safeGet('dashboard', '/api/dashboard', d => { state.dashboard = d; }));
        break;
      case 'pos':
        tasks.push(safeGet('menu', '/api/menu', d => { state.menu = d || []; }));
        tasks.push(safeGet('modifiers', '/api/modifiers', d => { state.modifiers = d || []; }));
        tasks.push(safeGet('orders', '/api/orders', d => { state.orders = d || []; }));
        break;
      case 'inventory':
        tasks.push(safeGet('items', '/api/inventory/items', d => { state.items = d || []; }));
        tasks.push(safeGet('batches', '/api/inventory/batches', d => { state.batches = d || []; }));
        tasks.push(safeGet('waste', '/api/waste', d => { state.waste = d || []; }));
        tasks.push(safeGet('ledger', '/api/inventory/ledger?limit=200', d => { state.ledger = d || []; }));
        break;
      case 'bom':
        tasks.push(safeGet('menu', '/api/menu', d => { state.menu = d || []; }));
        break;
      case 'eod':
        tasks.push(safeGet('eod', '/api/eod/current', d => {
          state.eod = d;
          state.eodEdits = {};
        }));
        break;
      case 'hr':
        tasks.push(safeGet('attendance', '/api/hr/attendance', d => { state.attendance = d || []; }));
        if (isOwner()) {
          tasks.push(safeGet('audit', '/api/audit-logs?limit=100', d => { state.auditLogs = d || []; }));
        } else {
          state.auditLogs = [];
          delete state.errors.audit;
        }
        break;
    }
    await Promise.all(tasks);
  }

  async function loadAndRender() {
    const seq = ++state.loadSeq;
    const tabs = allowedTabs();
    if (!tabs.some(t => t.id === state.tab)) state.tab = tabs[0].id;
    state.loading = true;
    renderAll();
    await loadTabData(state.tab);
    if (seq !== state.loadSeq) return;
    state.loading = false;
    renderAll();
  }

  async function refreshCurrent() {
    await loadTabData(state.tab);
    renderAll();
  }

  // ---------------------------------------------------------------------------
  // 7. SIDEBAR & HEADER
  // ---------------------------------------------------------------------------
  function renderSidebar() {
    const nav = document.getElementById('sidebar-nav');
    const role = state.role;
    nav.innerHTML = NAV_ITEMS.map(item => {
      const allowed = item.roles.includes(role);
      const active = state.tab === item.id;
      if (!allowed) {
        return `<div class="px-5 py-2.5 flex items-center justify-between text-slate-600 cursor-not-allowed text-sm" title="Vai trò hiện tại không có quyền truy cập" data-nav-locked="${item.id}">
          <span class="flex items-center gap-3"><i data-lucide="${item.icon}" class="w-4 h-4"></i>${esc(item.label)}</span>
          <i data-lucide="lock" class="w-3.5 h-3.5"></i>
        </div>`;
      }
      return `<button onclick="switchTab('${item.id}')" data-nav="${item.id}" class="w-full px-5 py-2.5 flex items-center gap-3 text-sm font-medium transition ${active ? 'tab-active' : 'hover:bg-slate-800 hover:text-white'}">
        <i data-lucide="${item.icon}" class="w-4 h-4"></i>
        <span>${esc(item.label)}</span>
      </button>`;
    }).join('');

    const r = ROLES[role] || ROLES.OWNER;
    const badge = document.getElementById('role-badge');
    badge.className = `text-xs font-semibold px-2.5 py-1 rounded-full ${r.badge}`;
    badge.textContent = `${r.label} • ${state.user?.full_name || r.name}`;
    document.getElementById('role-hint').textContent = r.hint;
    document.getElementById('role-switcher').value = role;
    document.getElementById('page-title').textContent = NAV_ITEMS.find(t => t.id === state.tab)?.label || '';
  }

  function renderShiftBadge() {
    const el = document.getElementById('shift-badge');
    const s = state.shift;
    if (!s) {
      el.className = 'hidden md:flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-50 text-slate-500 border border-slate-200';
      el.innerHTML = `<span class="w-2 h-2 rounded-full bg-slate-400"></span><span class="font-medium">Chưa có thông tin ca</span>`;
      return;
    }
    const slot = SHIFT_SLOTS[s.shift_slot] || esc(s.shift_slot || 'Ca');
    if (s.status === 'OPEN') {
      el.className = 'hidden md:flex items-center gap-2 px-3 py-1.5 rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-200';
      el.innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span><span class="font-medium">${slot}: Đang mở</span>`;
    } else {
      el.className = 'hidden md:flex items-center gap-2 px-3 py-1.5 rounded-lg bg-rose-50 text-rose-700 border border-rose-200';
      el.innerHTML = `<span class="w-2 h-2 rounded-full bg-rose-500"></span><span class="font-medium">${slot}: Đã đóng</span>`;
    }
    el.dataset.status = s.status;
  }

  function errorBox(keys) {
    const errs = keys.map(k => state.errors[k]).filter(Boolean);
    if (!errs.length) return '';
    return `<div class="mb-4 p-3.5 rounded-xl bg-rose-50 border border-rose-200 text-sm text-rose-800">
      <b>Không tải được dữ liệu:</b> ${errs.map(e => esc(e.message)).join(' • ')}
      <button onclick="refreshCurrent()" class="ml-2 text-xs font-bold underline">Thử lại</button>
    </div>`;
  }

  function loadingBox() {
    return `<div class="py-24 text-center text-slate-400 text-sm flex flex-col items-center gap-3">
      <i data-lucide="loader-2" class="w-6 h-6 animate-spin"></i> Đang tải dữ liệu từ máy chủ...
    </div>`;
  }

  // ---------------------------------------------------------------------------
  // 8. TAB 1: TỔNG QUAN CHỦ QUÁN (DASHBOARD)
  // ---------------------------------------------------------------------------
  function renderDashboard() {
    const d = state.dashboard;
    if (!d) return errorBox(['dashboard']) || loadingBox();
    const fc = Number(d.food_cost_pct) || 0;
    const low = d.low_stock || [];
    const expired = d.expired_batches || [];
    const eodDone = d.eod && d.eod.status && d.eod.status !== 'DRAFT_COUNTING';
    const red = d.eod ? Number(d.eod.red) || 0 : 0;
    const yellow = d.eod ? Number(d.eod.yellow) || 0 : 0;

    return `
      ${errorBox(['dashboard'])}
      <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <div class="bg-white rounded-xl p-5 border border-slate-200 shadow-xs">
          <div class="text-xs font-semibold text-slate-500 uppercase">Doanh thu ca hiện tại</div>
          <div class="text-2xl font-bold text-slate-900 mt-1" data-kpi="revenue">${vnd(d.revenue)}</div>
          <div class="text-xs text-emerald-600 mt-1">${num(d.paid_orders)} đơn đã thanh toán${d.voided_orders ? ` • <span class="text-rose-600">${num(d.voided_orders)} đơn hủy</span>` : ''}</div>
        </div>
        <div class="bg-white rounded-xl p-5 border border-slate-200 shadow-xs">
          <div class="text-xs font-semibold text-slate-500 uppercase">Giá vốn thực xuất (COGS)</div>
          <div class="text-2xl font-bold text-slate-900 mt-1">${vnd(d.cogs)}</div>
          <div class="text-xs ${fc > 35 ? 'text-rose-600 font-bold' : 'text-slate-500'} mt-1">Food Cost: ${fc.toFixed(2)}% (Ngưỡng an toàn &le; 35%)</div>
        </div>
        <div class="bg-white rounded-xl p-5 border border-slate-200 shadow-xs">
          <div class="text-xs font-semibold text-slate-500 uppercase">Cảnh báo Kho &amp; Date</div>
          <div class="text-2xl font-bold ${low.length + expired.length > 0 ? 'text-amber-600' : 'text-emerald-600'} mt-1">${low.length} chạm đáy • ${expired.length} quá hạn</div>
          <div class="text-xs text-slate-500 mt-1">Tự động quét theo FEFO (${low.length + expired.length} cảnh báo)</div>
        </div>
        <div class="bg-white rounded-xl p-5 border border-slate-200 shadow-xs">
          <div class="text-xs font-semibold text-slate-500 uppercase">Cờ Đỏ Đối soát EOD</div>
          <div class="text-2xl font-bold ${red > 0 ? 'text-rose-600' : 'text-slate-800'} mt-1">${eodDone ? red + ' cảnh báo đỏ' : 'Chưa nộp kiểm mù'}</div>
          <div class="text-xs text-slate-500 mt-1">${eodDone ? `Đã đối chiếu sổ cái • ${yellow} vàng (${esc(d.eod.status)})` : 'Đang chờ ca tối kiểm đếm'}</div>
        </div>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div class="bg-white rounded-xl border border-slate-200 p-5">
          <h2 class="font-bold text-slate-900 mb-3 flex items-center gap-2">
            <i data-lucide="alert-triangle" class="w-4 h-4 text-amber-500"></i> Cảnh báo vận hành cần xử lý ngay
          </h2>
          <div class="space-y-2.5 text-sm">
            ${expired.map(b => `
              <div class="p-3 rounded-lg bg-rose-50 border border-rose-200 flex items-center justify-between gap-2">
                <div>
                  <div class="font-semibold text-rose-800">Lô QUÁ HẠN: ${esc(b.batch_code)} (${esc(b.item_name)})</div>
                  <div class="text-xs text-rose-600">Còn ${num(b.remaining_qty_base)} ${esc(b.base_unit)} — Hệ thống FEFO đã khóa tự xuất bán, cần lập phiếu Báo hủy.</div>
                </div>
                <button onclick="switchTab('inventory')" class="text-xs font-semibold px-2.5 py-1 bg-rose-600 text-white rounded-lg shrink-0">Xử lý</button>
              </div>
            `).join('')}
            ${low.map(i => `
              <div class="p-3 rounded-lg bg-amber-50 border border-amber-200 flex items-center justify-between gap-2">
                <div>
                  <div class="font-semibold text-amber-900">Chạm Min-Stock: ${esc(i.name)}</div>
                  <div class="text-xs text-amber-700">Tồn khả dụng: ${num(i.valid_stock)} / ngưỡng tối thiểu ${num(i.min_stock_base)} ${esc(i.base_unit)}. Cần lên đơn PO.</div>
                </div>
                <button onclick="switchTab('inventory')" class="text-xs font-bold text-amber-800 bg-amber-200/70 px-2 py-1 rounded shrink-0">Đặt hàng</button>
              </div>
            `).join('')}
            ${expired.length === 0 && low.length === 0 ? `<div class="text-slate-500 text-sm">Không có cảnh báo kho bất thường.</div>` : ''}
          </div>
        </div>

        <div class="bg-white rounded-xl border border-slate-200 p-5">
          <h2 class="font-bold text-slate-900 mb-3 flex items-center gap-2">
            <i data-lucide="activity" class="w-4 h-4 text-indigo-500"></i> Nhật ký bảo mật mới nhất (Audit Log)
          </h2>
          <div class="space-y-2 text-xs">
            ${(d.recent_audit || []).map(l => `
              <div class="p-2.5 rounded-lg bg-slate-50 border border-slate-200 flex justify-between gap-2">
                <div class="min-w-0">
                  <span class="font-bold text-slate-800">[${esc(l.action_code)}]</span> <span class="break-words">${esc(auditDetail(l))}</span>
                  <div class="text-slate-500 mt-0.5">Thực hiện: ${esc(l.actor_name || '—')} ${l.approver_name ? '• Duyệt PIN: ' + esc(l.approver_name) : ''}</div>
                </div>
                <span class="text-slate-400 shrink-0">${fmtTime(l.created_at)}</span>
              </div>
            `).join('') || '<div class="text-slate-400">Chưa có nhật ký.</div>'}
          </div>
        </div>
      </div>
    `;
  }

  // ---------------------------------------------------------------------------
  // 9. TAB 2: BÁN HÀNG POS & BOM ĐỘNG
  // ---------------------------------------------------------------------------
  function canToggleMenu() {
    return ['OWNER', 'MANAGER'].includes(state.role);
  }

  function renderPOS() {
    const cartTotal = state.cart.reduce((s, c) => s + c.unitPrice * c.qty, 0);
    const showCogs = isOwner() || state.orders.some(o => has(o, 'cogs'));
    const shiftClosed = state.shift && state.shift.status !== 'OPEN';

    return `
      ${errorBox(['menu', 'modifiers', 'orders'])}
      ${shiftClosed ? `<div class="mb-4 p-3.5 rounded-xl bg-rose-50 border border-rose-200 text-sm text-rose-800 flex items-center gap-2"><i data-lucide="lock" class="w-4 h-4"></i> Ca hiện tại đã đóng — POS bị khóa bán. ${isOwner() ? 'Vào <b>Nhân sự &amp; Audit Log</b> để mở lại ca (Demo).' : ''}</div>` : ''}
      <div class="mb-4 p-3.5 rounded-xl bg-amber-50 border border-amber-200 flex flex-wrap items-center justify-between gap-3">
        <div class="text-sm text-amber-900">
          <span class="font-bold">⚡ Kịch bản kiểm thử nhanh (Khớp Seed Data SQL):</span>
          Bấm nút bên phải để bán ngay <b>2 ly Trà Sữa Truyền Thống — Size L + 0% Đường + Thêm Trân châu</b> và xem FEFO trừ 2 lô Sữa + 2 mẻ Trà, tính đúng COGS <b>18.560đ</b>.
        </div>
        <button id="btn-preset" onclick="runSeedOrderPreset(this)" class="px-3.5 py-2 bg-amber-500 hover:bg-amber-600 text-slate-950 font-bold text-xs rounded-lg shadow-xs shrink-0">
          Chạy thử đơn ORD-TEST-001
        </button>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <!-- Menu -->
        <div class="lg:col-span-2 space-y-4">
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
            ${state.menu.map(m => `
              <div class="bg-white rounded-xl border border-slate-200 p-4 flex flex-col justify-between hover:border-amber-400 transition shadow-xs" data-menu-code="${esc(m.code)}">
                <div>
                  <div class="flex items-center justify-between gap-1">
                    <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">${esc(m.category)}</span>
                    ${canToggleMenu()
                      ? `<button onclick="toggleAvailability('${esc(m.id)}', ${!m.is_available})" title="Bấm để chuyển Đang bán / Hết món" class="text-[11px] px-2 py-0.5 rounded-full font-semibold ${m.is_available ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200' : 'bg-slate-200 text-slate-600 hover:bg-slate-300'}">${m.is_available ? 'Đang bán' : 'Hết món'} ⇄</button>`
                      : `<span class="text-[11px] px-2 py-0.5 rounded-full ${m.is_available ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600'}">${m.is_available ? 'Đang bán' : 'Hết món'}</span>`}
                  </div>
                  <h3 class="font-bold text-slate-900 mt-1.5">${esc(m.name)}</h3>
                  <div class="text-amber-600 font-bold mt-1">${vnd(m.base_price)}</div>
                </div>
                <button ${!m.is_available ? 'disabled' : ''} onclick="openModifierModal('${esc(m.id)}')" class="mt-4 w-full py-2 rounded-lg text-xs font-bold ${m.is_available ? 'bg-slate-900 hover:bg-slate-800 text-white' : 'bg-slate-200 text-slate-400 cursor-not-allowed'}">
                  + Chọn biến thể &amp; Thêm
                </button>
              </div>
            `).join('') || '<div class="text-sm text-slate-400 col-span-3">Chưa có món trong thực đơn.</div>'}
          </div>

          <!-- Danh sách hóa đơn đã bán trong ca -->
          <div class="bg-white rounded-xl border border-slate-200 p-5">
            <div class="flex items-center justify-between mb-3">
              <h2 class="font-bold text-slate-900">Hóa đơn trong ca (${state.orders.length})</h2>
              <span class="text-xs text-slate-500">Hủy hóa đơn đã in tem yêu cầu <b>PIN Quản lý (2468)</b></span>
            </div>
            ${state.orders.length === 0 ? `<div class="text-sm text-slate-400 py-6 text-center">Chưa có hóa đơn nào. Hãy chọn món hoặc bấm "Chạy thử đơn ORD-TEST-001".</div>` : `
              <div class="overflow-x-auto">
                <table class="w-full text-sm text-left" id="orders-table">
                  <thead class="text-xs uppercase bg-slate-50 text-slate-500">
                    <tr>
                      <th class="px-3 py-2">Mã đơn</th>
                      <th class="px-3 py-2">Chi tiết món</th>
                      <th class="px-3 py-2 text-right">Thanh toán</th>
                      ${showCogs ? '<th class="px-3 py-2 text-right">COGS thực xuất</th>' : ''}
                      <th class="px-3 py-2 text-center">Trạng thái</th>
                      <th class="px-3 py-2 text-right">Thao tác</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-slate-100">
                    ${state.orders.map(o => `
                      <tr data-order-code="${esc(o.order_code)}">
                        <td class="px-3 py-2.5 font-mono text-xs font-bold">${esc(o.order_code)}<div class="text-[11px] font-sans font-normal text-slate-400">${fmtTime(o.paid_at || o.created_at)} • ${esc(PAYMENT_LABELS[o.payment_method] || o.payment_method)}</div></td>
                        <td class="px-3 py-2.5 text-xs">${esc(o.summary)}<div class="text-[11px] text-slate-400">Thu ngân: ${esc(o.cashier_name || '—')}</div></td>
                        <td class="px-3 py-2.5 text-right font-semibold">${vnd(o.total_amount)}</td>
                        ${showCogs ? `<td class="px-3 py-2.5 text-right text-xs font-semibold text-indigo-700">${has(o, 'cogs') ? vnd(o.cogs) + `<div class="text-[11px] text-slate-400">${Number(o.total_amount) > 0 ? (Number(o.cogs) / Number(o.total_amount) * 100).toFixed(2) : '0.00'}%</div>` : '—'}</td>` : ''}
                        <td class="px-3 py-2.5 text-center">
                          <span class="text-[11px] font-bold px-2 py-0.5 rounded-full ${o.status === 'PAID' ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}">${esc(o.status)}</span>
                        </td>
                        <td class="px-3 py-2.5 text-right">
                          ${o.status === 'PAID'
                            ? `<button onclick="requestVoidOrder('${esc(o.id)}')" class="text-xs font-semibold text-rose-600 hover:underline">Hủy bill</button>`
                            : `<span class="text-[11px] text-slate-400">${esc(o.void_reason || '')}${o.void_approved_by_name ? `<br/>Duyệt: ${esc(o.void_approved_by_name)}` : ''}</span>`}
                        </td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
            `}
          </div>
        </div>

        <!-- Giỏ hàng -->
        <div class="bg-white rounded-xl border border-slate-200 p-5 flex flex-col justify-between h-fit">
          <div>
            <h2 class="font-bold text-slate-900 pb-3 border-b border-slate-100 flex items-center justify-between">
              <span>Đơn đang gọi</span>
              <span class="text-xs font-normal text-slate-500">${state.cart.length} dòng</span>
            </h2>
            <div class="py-3 space-y-3 min-h-[140px]">
              ${state.cart.length === 0 ? `<div class="text-sm text-slate-400 text-center py-8">Giỏ hàng trống</div>` : state.cart.map((c, idx) => `
                <div class="flex justify-between gap-2 text-sm border-b border-slate-100 pb-2.5">
                  <div>
                    <div class="font-semibold text-slate-800">${c.qty}x ${esc(c.menuName)}</div>
                    <div class="text-xs text-slate-500">${c.modNames.length ? esc(c.modNames.join(', ')) : 'Tiêu chuẩn Size M'}</div>
                  </div>
                  <div class="text-right shrink-0">
                    <div class="font-bold">${vnd(c.unitPrice * c.qty)}</div>
                    <button onclick="removeCartItem(${idx})" class="text-[11px] text-rose-500 hover:underline">Xóa</button>
                  </div>
                </div>
              `).join('')}
            </div>
          </div>
          <div class="pt-3 border-t border-slate-200 space-y-3">
            <div class="flex justify-between text-base font-bold">
              <span>Tổng cộng</span>
              <span class="text-amber-600">${vnd(cartTotal)}</span>
            </div>
            <div class="grid grid-cols-2 gap-2">
              <button ${state.cart.length === 0 ? 'disabled' : ''} onclick="checkoutCart('CASH', this)" class="py-2.5 rounded-lg text-xs font-bold ${state.cart.length ? 'bg-emerald-600 hover:bg-emerald-700 text-white' : 'bg-slate-200 text-slate-400'}">Thu Tiền Mặt</button>
              <button ${state.cart.length === 0 ? 'disabled' : ''} onclick="checkoutCart('QR_TRANSFER', this)" class="py-2.5 rounded-lg text-xs font-bold ${state.cart.length ? 'bg-slate-900 hover:bg-slate-800 text-white' : 'bg-slate-200 text-slate-400'}">Chuyển Khoản QR</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function groupModifiers() {
    const groups = {};
    state.modifiers.forEach(m => {
      (groups[m.group_name] = groups[m.group_name] || []).push(m);
    });
    return groups;
  }

  function openModifierModal(menuId) {
    const m = state.menu.find(x => x.id === menuId);
    if (!m) return;
    const groups = groupModifiers();
    openModal(`
      <div class="p-5 border-b border-slate-200 flex items-center justify-between">
        <div>
          <h3 class="font-bold text-slate-900">${esc(m.name)}</h3>
          <div class="text-xs text-slate-500">Giá gốc Size M: ${vnd(m.base_price)}</div>
        </div>
        <button onclick="closeModal()" class="text-slate-400 hover:text-slate-700"><i data-lucide="x" class="w-5 h-5"></i></button>
      </div>
      <div class="p-5 space-y-4 text-sm max-h-[65vh] overflow-y-auto custom-scroll">
        <div>
          <label class="font-semibold text-xs uppercase text-slate-500">Số lượng ly</label>
          <input id="mod-qty" type="number" min="1" value="1" class="mt-1 w-24 border border-slate-300 rounded-lg px-3 py-1.5 font-bold block" />
        </div>
        <div>
          <label class="font-semibold text-xs uppercase text-slate-500 block mb-2">Tùy chọn biến thể (Tự động đổi định lượng BOM)</label>
          <div class="space-y-3">
            ${Object.entries(groups).map(([g, mods]) => {
              const single = has(SINGLE_CHOICE_GROUPS, g);
              const optRow = (inputHtml, label, price) => `
                <label class="flex items-center justify-between p-2.5 rounded-lg border border-slate-200 hover:bg-slate-50 cursor-pointer">
                  <span class="flex items-center gap-2">${inputHtml}<span class="font-medium">${label}</span></span>
                  <span class="text-xs font-semibold text-slate-600">${price}</span>
                </label>`;
              return `
                <div>
                  <div class="text-[11px] font-bold uppercase tracking-wide text-slate-400 mb-1.5">${esc(MOD_GROUP_LABELS[g] || g)} ${single ? '<span class="font-normal normal-case">(chọn 1)</span>' : ''}</div>
                  <div class="space-y-1.5">
                    ${single ? optRow(`<input type="radio" name="mod-${esc(g)}" value="" checked class="mod-chk text-amber-600" />`, esc(SINGLE_CHOICE_GROUPS[g]), '0đ') : ''}
                    ${mods.map(mod => optRow(
                      `<input type="${single ? 'radio' : 'checkbox'}" ${single ? `name="mod-${esc(g)}"` : ''} value="${esc(mod.id)}" class="mod-chk rounded text-amber-600" />`,
                      esc(mod.name),
                      Number(mod.price_delta) > 0 ? '+' + vnd(mod.price_delta) : (Number(mod.price_delta) < 0 ? vnd(mod.price_delta) : '0đ')
                    )).join('')}
                  </div>
                </div>`;
            }).join('') || '<div class="text-xs text-slate-400">Không có tùy chọn.</div>'}
          </div>
        </div>
      </div>
      <div class="p-4 bg-slate-50 border-t border-slate-200 flex justify-end gap-2">
        <button onclick="closeModal()" class="px-4 py-2 text-xs font-semibold text-slate-600">Hủy</button>
        <button id="btn-add-cart" onclick="confirmAddToCart('${esc(m.id)}')" class="px-4 py-2 bg-slate-900 text-white text-xs font-bold rounded-lg">Thêm vào đơn</button>
      </div>
    `);
  }

  function confirmAddToCart(menuId) {
    const m = state.menu.find(x => x.id === menuId);
    if (!m) return;
    const qty = Math.max(1, parseInt(document.getElementById('mod-qty').value, 10) || 1);
    const modIds = [...document.querySelectorAll('.mod-chk:checked')].map(el => el.value).filter(Boolean);
    const mods = modIds.map(id => state.modifiers.find(x => x.id === id)).filter(Boolean);
    const unitPrice = Number(m.base_price) + mods.reduce((s, x) => s + Number(x.price_delta || 0), 0);
    state.cart.push({ menuId, menuName: m.name, qty, modIds, modNames: mods.map(x => x.name), unitPrice });
    closeModal();
    renderAll();
  }

  function removeCartItem(idx) {
    state.cart.splice(idx, 1);
    renderAll();
  }

  function lowStockToasts(deduction) {
    if (!deduction) return;
    (deduction.low_stock_alerts || []).forEach(a => {
      const unit = state.items.find(i => i.id === a.item_id)?.base_unit || '';
      const unitSuffix = unit ? ' ' + unit : '';
      showToast(
        `⚠️ Cảnh báo Min-Stock: ${a.name || a.sku}`,
        `Tồn còn hạn chỉ còn ${num(a.remaining_valid_qty)}${unitSuffix} (ngưỡng tối thiểu ${num(a.min_stock_base)}${unitSuffix}).`,
        'warn'
      );
    });
    (deduction.negative_stock_alerts || []).forEach(a => {
      showToast(
        `🚨 Âm kho: ${a.name || a.sku || a.item_id}`,
        'Không đủ lô còn hạn để xuất — đã ghi nhận âm kho, cần kiểm tra nhập hàng.',
        'danger'
      );
    });
  }

  function orderSuccessToast(res) {
    const o = res.order || {};
    const d = res.deduction || {};
    const cogs = has(o, 'cogs') ? o.cogs : (has(d, 'total_order_cogs_vnd') ? d.total_order_cogs_vnd : null);
    showToast(
      `✅ Đã chốt đơn ${o.order_code || ''} (${vnd(o.total_amount)})`,
      cogs !== null
        ? `Đã trừ kho FEFO tự động. Giá vốn thực xuất: ${vnd(cogs)} (${Number(o.total_amount) > 0 ? (Number(cogs) / Number(o.total_amount) * 100).toFixed(2) : '0.00'}%).`
        : 'Đã in tem pha chế và trừ kho FEFO tự động.',
      'success'
    );
    lowStockToasts(d);
  }

  async function checkoutCart(method, btn) {
    if (state.cart.length === 0) return;
    setBusy(btn, true);
    try {
      const res = await api('POST', '/api/orders', {
        items: state.cart.map(c => ({ menu_item_id: c.menuId, quantity: c.qty, modifier_ids: c.modIds })),
        payment_method: method
      });
      state.cart = [];
      orderSuccessToast(res);
      await refreshCurrent();
    } catch (e) { /* toast */ } finally {
      setBusy(btn, false);
    }
  }

  async function runSeedOrderPreset(btn) {
    setBusy(btn, true);
    const body = {
      items: [{ menu_item_id: PRESET.menuId, quantity: 2, modifier_ids: PRESET.modifierIds }],
      payment_method: 'QR_TRANSFER',
      order_code: PRESET.orderCode
    };
    try {
      let res;
      try {
        res = await api('POST', '/api/orders', body, { quiet: true });
      } catch (e) {
        if (e.status === 409 && e.code === 'CONFLICT') {
          showToast('ORD-TEST-001 đã tồn tại', 'Tạo đơn kịch bản với mã tự sinh (bấm "Nạp lại Seed Data" để chạy lại đúng mã).', 'info');
          delete body.order_code;
          res = await api('POST', '/api/orders', body);
        } else {
          showErrorToast(e);
          throw e;
        }
      }
      orderSuccessToast(res);
      await refreshCurrent();
    } catch (e) { /* already toasted */ } finally {
      setBusy(btn, false);
    }
  }

  async function toggleAvailability(menuId, isAvailable) {
    try {
      await api('PATCH', `/api/menu/${encodeURIComponent(menuId)}/availability`, { is_available: isAvailable });
      const m = state.menu.find(x => x.id === menuId);
      showToast(isAvailable ? '✅ Đã mở bán lại' : '⛔ Đã báo Hết món', m ? m.name : '', isAvailable ? 'success' : 'warn');
      await refreshCurrent();
    } catch (e) { /* toast */ }
  }

  function requestVoidOrder(orderId) {
    const o = state.orders.find(x => x.id === orderId);
    if (!o) return;
    const needPin = state.role === 'CASHIER';
    openModal(`
      <div class="p-5 border-b border-slate-200">
        <h3 class="font-bold text-rose-700 flex items-center gap-2"><i data-lucide="shield-alert" class="w-5 h-5"></i> Hủy hóa đơn đã in tem: ${esc(o.order_code)}</h3>
        <p class="text-xs text-slate-500 mt-1">${needPin ? 'Thu ngân bị khóa quyền tự hủy. Cần Quản lý nhập mã PIN phê duyệt tại quầy (PIN mẫu: 2468).' : 'Thao tác này sẽ ghi cứng vào Audit Log và gửi cảnh báo về Chủ quán.'}</p>
      </div>
      <div class="p-5 space-y-3 text-sm">
        <div class="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-lg p-2.5">${esc(o.summary)} — <b>${vnd(o.total_amount)}</b></div>
        <div>
          <label class="text-xs font-semibold text-slate-600">Lý do hủy bắt buộc *</label>
          <input id="void-reason" type="text" placeholder="VD: Khách đổi ý chọn món khác" class="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2" />
        </div>
        ${needPin ? `
          <div>
            <label class="text-xs font-semibold text-rose-700">Mã PIN Quản lý ca (Manager Override) *</label>
            <input id="void-pin" type="password" inputmode="numeric" autocomplete="off" placeholder="Nhập PIN (gợi ý: 2468)" class="mt-1 w-full border border-rose-300 rounded-lg px-3 py-2 font-mono tracking-widest" />
          </div>
        ` : ''}
      </div>
      <div class="p-4 bg-slate-50 border-t border-slate-200 flex justify-end gap-2">
        <button onclick="closeModal()" class="px-4 py-2 text-xs font-semibold text-slate-600">Đóng</button>
        <button id="btn-confirm-void" onclick="confirmVoidOrder('${esc(o.id)}', ${needPin}, this)" class="px-4 py-2 bg-rose-600 text-white text-xs font-bold rounded-lg">Xác nhận Hủy &amp; Ghi Audit Log</button>
      </div>
    `);
  }

  async function confirmVoidOrder(orderId, needPin, btn) {
    const reason = document.getElementById('void-reason').value.trim();
    if (!reason) return showToast('Thiếu lý do', 'Bắt buộc nhập lý do hủy hóa đơn.', 'danger');
    const body = { reason };
    if (needPin) {
      const pin = document.getElementById('void-pin').value.trim();
      if (!pin) return showToast('Thiếu mã PIN', 'Cần Quản lý nhập mã PIN phê duyệt (2468).', 'danger');
      body.approver_pin = pin;
    }
    setBusy(btn, true);
    try {
      const res = await api('POST', `/api/orders/${encodeURIComponent(orderId)}/void`, body);
      closeModal();
      showToast('🚨 Đã hủy hóa đơn & Bắn cảnh báo Chủ quán', `${res.order_code || ''} — Duyệt bởi: ${res.void_approved_by_name || '—'}. Bản ghi bất biến đã được lưu vào Audit Log.`, 'warn');
      await refreshCurrent();
    } catch (e) { /* keep modal open so PIN can be re-entered */ } finally {
      setBusy(btn, false);
    }
  }

  // ---------------------------------------------------------------------------
  // 10. TAB 3: KHO FEFO, BÁN THÀNH PHẨM & SỔ CÁI
  // ---------------------------------------------------------------------------
  function renderInventory() {
    const showItemCost = state.items.some(i => has(i, 'avg_unit_cost'));
    const showBatchCost = state.batches.some(b => has(b, 'unit_cost'));
    const showLedgerValue = state.ledger.some(l => has(l, 'value_vnd'));
    const canApprove = ['OWNER', 'MANAGER'].includes(state.role);

    return `
      ${errorBox(['items', 'batches', 'waste', 'ledger'])}
      <div class="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div class="text-sm text-slate-600">Toàn bộ biến động quy về <b>đơn vị gốc (ml, g, pcs)</b>. ${showBatchCost || showItemCost ? '' : '<span class="text-amber-700 font-semibold">(Đang ẩn đơn giá &amp; giá vốn theo phân quyền RBAC)</span>'}</div>
        <div class="flex gap-2 flex-wrap">
          ${isOwner() ? `
          <button onclick="openPurchaseModal()" class="px-3.5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded-lg flex items-center gap-1.5">
            <i data-lucide="truck" class="w-3.5 h-3.5"></i> Nhập lô hàng mới
          </button>` : ''}
          <button onclick="openPrepModal()" class="px-3.5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold rounded-lg flex items-center gap-1.5">
            <i data-lucide="flame" class="w-3.5 h-3.5"></i> Nấu mẻ Bán thành phẩm (Prep)
          </button>
          <button onclick="openWasteModal()" class="px-3.5 py-2 bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold rounded-lg flex items-center gap-1.5">
            <i data-lucide="trash-2" class="w-3.5 h-3.5"></i> Báo hủy hàng (Waste)
          </button>
        </div>
      </div>

      <!-- Tổng hợp tồn kho theo mặt hàng -->
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-6" id="inventory-items-summary">
        ${state.items.map(i => {
          const cu = i.count_unit ? `${esc(i.count_unit.unit_name)} = ${num(i.count_unit.to_base_factor)} ${esc(i.base_unit)}` : 'Đơn vị lẻ';
          return `
            <div class="bg-white rounded-xl border ${i.is_low ? 'border-amber-300 bg-amber-50/40' : 'border-slate-200'} p-4 flex flex-col justify-between">
              <div class="flex items-start justify-between gap-2">
                <div>
                  <div class="text-[11px] font-mono text-slate-400">${esc(i.sku)} • Nhóm ${esc(i.abc_class)} • ${esc(i.item_type)}</div>
                  <div class="font-bold text-slate-900 mt-0.5">${esc(i.name)}</div>
                </div>
                ${i.is_low
                  ? '<span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-200 text-amber-900 shrink-0">CHẠM ĐÁY</span>'
                  : '<span class="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 shrink-0">Ổn định</span>'}
              </div>
              <div class="mt-3 flex items-end justify-between gap-2 text-xs">
                <div>
                  <div class="text-slate-500">Khả dụng: <b class="text-sm text-slate-900">${num(i.valid_stock)} ${esc(i.base_unit)}</b> <span class="text-slate-400">(min ${num(i.min_stock_base)})</span></div>
                  <div class="text-[11px] text-slate-400 mt-0.5">Quy đổi đếm: ${cu}${Number(i.expired_stock) > 0 ? ` • <span class="text-rose-600 font-semibold">Quá hạn: ${num(i.expired_stock)} ${esc(i.base_unit)}</span>` : ''}</div>
                </div>
                ${has(i, 'avg_unit_cost') ? `<div class="text-right font-mono text-[11px] text-indigo-700 font-semibold">${vnd(i.avg_unit_cost)}/${esc(i.base_unit)}</div>` : ''}
              </div>
            </div>
          `;
        }).join('')}
      </div>

      <!-- Bảng lô hàng FEFO -->
      <div class="bg-white rounded-xl border border-slate-200 overflow-hidden mb-6">
        <div class="px-5 py-3.5 border-b border-slate-200 font-bold text-slate-900">Chi tiết Lô hàng &amp; Hạn sử dụng (FEFO)</div>
        <div class="overflow-x-auto">
          <table class="w-full text-sm text-left" id="batches-table">
            <thead class="text-xs uppercase bg-slate-50 text-slate-500">
              <tr>
                <th class="px-4 py-2.5">Mã lô</th>
                <th class="px-4 py-2.5">Nguyên liệu</th>
                <th class="px-4 py-2.5">Phân loại</th>
                <th class="px-4 py-2.5 text-right">Còn lại / Ban đầu</th>
                ${showBatchCost ? '<th class="px-4 py-2.5 text-right">Đơn giá lô</th>' : ''}
                <th class="px-4 py-2.5 text-center">Trạng thái FEFO</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              ${state.batches.map(b => {
                const expired = !!b.is_expired;
                const empty = Number(b.remaining_qty_base) <= 0;
                return `
                  <tr class="${expired && !empty ? 'bg-rose-50/70' : empty ? 'opacity-50' : ''}" data-batch="${esc(b.batch_code)}">
                    <td class="px-4 py-2.5 font-mono text-xs font-bold">${esc(b.batch_code)}</td>
                    <td class="px-4 py-2.5 font-medium">${esc(b.item_name)} <span class="text-xs text-slate-400">(${esc(b.abc_class)})</span></td>
                    <td class="px-4 py-2.5 text-xs"><span class="px-2 py-0.5 rounded bg-slate-100">${esc(b.item_type)}</span></td>
                    <td class="px-4 py-2.5 text-right font-semibold">${num(b.remaining_qty_base)} / ${num(b.initial_qty_base)} ${esc(b.base_unit)}</td>
                    ${showBatchCost ? `<td class="px-4 py-2.5 text-right text-xs font-mono">${has(b, 'unit_cost') ? vnd(b.unit_cost) + '/' + esc(b.base_unit) : ''}</td>` : ''}
                    <td class="px-4 py-2.5 text-center">
                      ${empty ? '<span class="text-[11px] font-bold px-2 py-0.5 rounded-full bg-slate-200 text-slate-600">ĐÃ HẾT LÔ</span>'
                        : expired ? '<span class="text-[11px] font-bold px-2 py-0.5 rounded-full bg-rose-600 text-white">QUÁ HẠN (KHÓA XUẤT)</span>'
                        : `<span class="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800" title="HSD: ${fmtDateTime(b.expires_at)}">${timeLeftLabel(b.expires_at)}</span>`}
                    </td>
                  </tr>
                `;
              }).join('') || `<tr><td colspan="6" class="px-4 py-6 text-center text-slate-400 text-sm">Chưa có lô hàng.</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>

      <!-- Phiếu báo hủy -->
      ${state.waste.length > 0 ? `
        <div class="bg-white rounded-xl border border-slate-200 p-5 mb-6">
          <h3 class="font-bold text-slate-900 mb-3">Phiếu Báo hủy hàng (Waste Records)</h3>
          <div class="space-y-2" id="waste-list">
            ${state.waste.map(w => `
              <div class="p-3 rounded-lg border border-slate-200 flex flex-wrap items-center justify-between gap-2 text-sm" data-waste-status="${esc(w.status)}">
                <div>
                  <span class="font-bold">${esc(w.item_name)}</span> — <b>${num(w.qty_base)} ${esc(w.base_unit)}</b>
                  <span class="text-xs px-2 py-0.5 rounded bg-slate-100 ml-1">${esc(w.reason_code)}</span>
                  ${w.notes ? `<span class="text-xs text-slate-500 ml-1">“${esc(w.notes)}”</span>` : ''}
                  <div class="text-xs text-slate-500 mt-0.5">Báo bởi: ${esc(w.reported_by_name || '—')} • Ảnh camera: ${w.camera_photo_url ? `<span class="text-emerald-600 font-medium" title="${esc(w.camera_photo_url)}">✓ Đã đính kèm (${fmtTime(w.created_at)})</span>` : '<span class="text-rose-600">Thiếu ảnh</span>'}</div>
                </div>
                <div class="flex items-center gap-2">
                  ${w.status === 'PENDING' ? (
                    canApprove
                      ? `<button onclick="rejectWaste('${esc(w.id)}', this)" class="px-3 py-1.5 bg-white border border-slate-300 text-slate-700 text-xs font-bold rounded-lg hover:bg-slate-50">Từ chối</button>
                         <button onclick="approveWaste('${esc(w.id)}', this)" class="px-3 py-1.5 bg-emerald-600 text-white text-xs font-bold rounded-lg hover:bg-emerald-700">Duyệt</button>`
                      : `<span class="text-xs font-semibold text-amber-600 bg-amber-50 px-2.5 py-1 rounded">Chờ Quản lý duyệt</span>`
                  ) : w.status === 'APPROVED'
                    ? `<span class="text-xs font-bold text-emerald-700 bg-emerald-100 px-2.5 py-1 rounded">ĐÃ DUYỆT (${esc(w.approved_by_name || '—')})</span>`
                    : `<span class="text-xs font-bold text-slate-600 bg-slate-200 px-2.5 py-1 rounded">ĐÃ TỪ CHỐI${w.approved_by_name ? ' (' + esc(w.approved_by_name) + ')' : ''}</span>`}
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      ` : ''}

      <!-- Sổ cái kho bất biến -->
      <div class="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div class="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
          <span class="font-bold text-slate-900">Sổ cái kho bất biến (stock_ledger — Append-Only)</span>
          <span class="text-xs text-slate-500">Chỉ INSERT • Cấm sửa/xóa</span>
        </div>
        <div class="overflow-x-auto max-h-80 overflow-y-auto custom-scroll">
          <table class="w-full text-xs text-left" id="ledger-table">
            <thead class="uppercase bg-slate-50 text-slate-500 sticky top-0">
              <tr>
                <th class="px-4 py-2">Thời gian</th>
                <th class="px-4 py-2">Loại GD</th>
                <th class="px-4 py-2">Nguyên liệu</th>
                <th class="px-4 py-2">Mã lô</th>
                <th class="px-4 py-2 text-right">Biến động</th>
                ${showLedgerValue ? '<th class="px-4 py-2 text-right">Giá trị COGS</th>' : ''}
                <th class="px-4 py-2">Chứng từ</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              ${state.ledger.map(l => {
                const q = Number(l.qty_change_base);
                return `
                  <tr>
                    <td class="px-4 py-2 text-slate-500">${fmtDateTime(l.created_at)}</td>
                    <td class="px-4 py-2 font-bold">${esc(l.txn_type)}</td>
                    <td class="px-4 py-2">${esc(l.item_name)}</td>
                    <td class="px-4 py-2 font-mono">${l.batch_code ? esc(l.batch_code) : '<span class="text-rose-600 font-bold">ÂM KHO (NULL)</span>'}</td>
                    <td class="px-4 py-2 text-right font-bold ${q < 0 ? 'text-rose-600' : 'text-emerald-600'}">${q > 0 ? '+' : ''}${num(q)} ${esc(l.base_unit)}</td>
                    ${showLedgerValue ? `<td class="px-4 py-2 text-right">${has(l, 'value_vnd') ? vnd(l.value_vnd) : ''}</td>` : ''}
                    <td class="px-4 py-2 text-slate-500">${esc(l.ref_table || '—')}${l.created_by_name ? ` • ${esc(l.created_by_name)}` : ''}</td>
                  </tr>
                `;
              }).join('') || `<tr><td colspan="7" class="px-4 py-6 text-center text-slate-400">Sổ cái trống.</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  function prepHoursHint(sku) {
    return sku === 'PREP-TEA' ? 6 : sku === 'PREP-PEARL' ? 4 : 8;
  }

  function openPrepModal() {
    const semis = state.items.filter(i => i.item_type === 'SEMI_FINISHED');
    if (!semis.length) return showToast('Không có bán thành phẩm', 'Danh mục kho chưa có mặt hàng SEMI_FINISHED.', 'warn');
    openModal(`
      <div class="p-5 border-b border-slate-200"><h3 class="font-bold text-slate-900">Nấu mẻ Bán thành phẩm mới (Prep)</h3></div>
      <div class="p-5 space-y-3 text-sm">
        <div>
          <label class="text-xs font-semibold text-slate-600">Chọn bán thành phẩm</label>
          <select id="prep-item" class="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2">
            ${semis.map(i => `<option value="${esc(i.id)}">${esc(i.name)} (${esc(i.base_unit)}) — Hạn dùng ${prepHoursHint(i.sku)} giờ</option>`).join('')}
          </select>
        </div>
        <div>
          <label class="text-xs font-semibold text-slate-600">Sản lượng thành phẩm thu được (ml / g)</label>
          <input id="prep-qty" type="number" value="2000" min="1" class="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 font-bold" />
        </div>
        <div>
          <label class="text-xs font-semibold text-slate-600">Ghi chú (tùy chọn)</label>
          <input id="prep-notes" type="text" placeholder="VD: Mẻ trà ca chiều" class="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2" />
        </div>
      </div>
      <div class="p-4 bg-slate-50 border-t border-slate-200 flex justify-end gap-2">
        <button onclick="closeModal()" class="px-4 py-2 text-xs font-semibold text-slate-600">Hủy</button>
        <button id="btn-confirm-prep" onclick="confirmPrep(this)" class="px-4 py-2 bg-indigo-600 text-white text-xs font-bold rounded-lg">Nhập lô Bán thành phẩm</button>
      </div>
    `);
  }

  async function confirmPrep(btn) {
    const semi_item_id = document.getElementById('prep-item').value;
    const yield_qty_base = parseFloat(document.getElementById('prep-qty').value);
    const notes = document.getElementById('prep-notes').value.trim();
    if (!(yield_qty_base > 0)) return showToast('Sản lượng không hợp lệ', 'Nhập sản lượng lớn hơn 0.', 'danger');
    setBusy(btn, true);
    try {
      const res = await api('POST', '/api/inventory/prep', { semi_item_id, yield_qty_base, notes: notes || undefined });
      const b = res.batch || {};
      closeModal();
      showToast('✅ Đã nhập lô bán thành phẩm', `Tạo lô ${b.batch_code || ''} (+${num(b.initial_qty_base ?? yield_qty_base)}), HSD ${fmtDateTime(b.expires_at)}.`, 'success');
      await refreshCurrent();
    } catch (e) { /* toast */ } finally {
      setBusy(btn, false);
    }
  }

  function openWasteModal() {
    if (!state.items.length) return showToast('Chưa tải danh mục kho', 'Vui lòng thử lại sau.', 'warn');
    const photo = `camera://live_${Date.now()}.jpg`;
    openModal(`
      <div class="p-5 border-b border-slate-200"><h3 class="font-bold text-rose-700">Tạo phiếu Báo hủy hàng (Waste)</h3></div>
      <div class="p-5 space-y-3 text-sm">
        <div>
          <label class="text-xs font-semibold text-slate-600">Nguyên liệu bị hủy / đổ vỡ</label>
          <select id="waste-item" class="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2">
            ${state.items.map(i => `<option value="${esc(i.id)}">${esc(i.name)} (${esc(i.base_unit)})${Number(i.expired_stock) > 0 ? ' — có ' + num(i.expired_stock) + ' quá hạn' : ''}</option>`).join('')}
          </select>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="text-xs font-semibold text-slate-600">Số lượng (ml/g/cái)</label>
            <input id="waste-qty" type="number" value="500" min="1" class="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 font-bold" />
          </div>
          <div>
            <label class="text-xs font-semibold text-slate-600">Lý do</label>
            <select id="waste-reason" class="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2">
              ${Object.entries(WASTE_REASONS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}
            </select>
          </div>
        </div>
        <div>
          <label class="text-xs font-semibold text-slate-600">Ghi chú (tùy chọn)</label>
          <input id="waste-notes" type="text" placeholder="VD: Lô sữa quá hạn 2 ngày" class="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2" />
        </div>
        <div class="p-3 rounded-lg bg-slate-100 border border-dashed border-slate-300 text-xs text-slate-600 flex items-center gap-2">
          <i data-lucide="camera" class="w-4 h-4 text-emerald-600"></i>
          <span>Chụp ảnh trực tiếp từ camera: <b class="text-emerald-700" id="waste-photo" data-url="${esc(photo)}">${esc(photo)} (Đã xác thực thời gian thực)</b></span>
        </div>
      </div>
      <div class="p-4 bg-slate-50 border-t border-slate-200 flex justify-end gap-2">
        <button onclick="closeModal()" class="px-4 py-2 text-xs font-semibold text-slate-600">Hủy</button>
        <button id="btn-confirm-waste" onclick="confirmWaste(this)" class="px-4 py-2 bg-rose-600 text-white text-xs font-bold rounded-lg">${state.role === 'BARISTA' ? 'Gửi chờ Quản lý duyệt' : 'Tạo &amp; Duyệt ngay'}</button>
      </div>
    `);
  }

  async function confirmWaste(btn) {
    const body = {
      item_id: document.getElementById('waste-item').value,
      qty_base: parseFloat(document.getElementById('waste-qty').value),
      reason_code: document.getElementById('waste-reason').value,
      camera_photo_url: document.getElementById('waste-photo').dataset.url
    };
    const notes = document.getElementById('waste-notes').value.trim();
    if (notes) body.notes = notes;
    if (!(body.qty_base > 0)) return showToast('Số lượng không hợp lệ', 'Nhập số lượng lớn hơn 0.', 'danger');
    setBusy(btn, true);
    try {
      const res = await api('POST', '/api/waste', body);
      closeModal();
      if ((res && res.status) === 'PENDING') {
        showToast('📩 Đã gửi phiếu báo hủy', 'Barista không có quyền tự duyệt. Hãy đổi sang Quản lý ca để duyệt trừ kho.', 'info');
      } else {
        showToast('✅ Đã duyệt phiếu hủy & Ghi sổ cái', 'Lượng hủy hợp lệ sẽ được trừ khỏi Tồn lý thuyết EOD.', 'success');
      }
      await refreshCurrent();
    } catch (e) { /* toast */ } finally {
      setBusy(btn, false);
    }
  }

  async function approveWaste(id, btn) {
    setBusy(btn, true);
    try {
      await api('POST', `/api/waste/${encodeURIComponent(id)}/approve`);
      showToast('✅ Đã duyệt phiếu hủy & Ghi sổ cái', 'Lượng hủy hợp lệ sẽ được trừ khỏi Tồn lý thuyết EOD.', 'success');
      await refreshCurrent();
    } catch (e) {
      setBusy(btn, false);
    }
  }

  async function rejectWaste(id, btn) {
    setBusy(btn, true);
    try {
      await api('POST', `/api/waste/${encodeURIComponent(id)}/reject`, { reason: 'Không đủ bằng chứng hợp lệ' });
      showToast('Đã từ chối phiếu hủy', 'Kho không bị trừ. Đã ghi Audit Log.', 'info');
      await refreshCurrent();
    } catch (e) {
      setBusy(btn, false);
    }
  }

  function openPurchaseModal() {
    if (!state.items.length) return showToast('Chưa tải danh mục kho', 'Vui lòng thử lại sau.', 'warn');
    const d = new Date(Date.now() + 7 * 86400000);
    const pad = n => String(n).padStart(2, '0');
    const defExp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    openModal(`
      <div class="p-5 border-b border-slate-200">
        <h3 class="font-bold text-emerald-700 flex items-center gap-2"><i data-lucide="truck" class="w-5 h-5"></i> Nhập lô hàng mới (PO)</h3>
        <p class="text-xs text-slate-500 mt-1">Tạo lô mới + ghi sổ cái PURCHASE + cập nhật giá vốn bình quân gia quyền.</p>
      </div>
      <div class="p-5 space-y-3 text-sm">
        <div>
          <label class="text-xs font-semibold text-slate-600">Nguyên liệu</label>
          <select id="po-item" class="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2">
            ${state.items.map(i => `<option value="${esc(i.id)}">${esc(i.name)} (${esc(i.base_unit)})${has(i, 'avg_unit_cost') ? ' — BQ ' + vnd(i.avg_unit_cost) + '/' + esc(i.base_unit) : ''}</option>`).join('')}
          </select>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="text-xs font-semibold text-slate-600">Số lượng (đơn vị gốc)</label>
            <input id="po-qty" type="number" min="1" value="1000" class="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 font-bold" />
          </div>
          <div>
            <label class="text-xs font-semibold text-slate-600">Đơn giá / đơn vị gốc (đ)</label>
            <input id="po-cost" type="number" min="0" step="0.01" value="33" class="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 font-bold" />
          </div>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="text-xs font-semibold text-slate-600">Hạn sử dụng</label>
            <input id="po-exp" type="datetime-local" value="${defExp}" class="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2" />
          </div>
          <div>
            <label class="text-xs font-semibold text-slate-600">Mã lô (tùy chọn)</label>
            <input id="po-code" type="text" placeholder="Tự sinh nếu bỏ trống" class="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 font-mono" />
          </div>
        </div>
      </div>
      <div class="p-4 bg-slate-50 border-t border-slate-200 flex justify-end gap-2">
        <button onclick="closeModal()" class="px-4 py-2 text-xs font-semibold text-slate-600">Hủy</button>
        <button id="btn-confirm-po" onclick="confirmPurchase(this)" class="px-4 py-2 bg-emerald-600 text-white text-xs font-bold rounded-lg">Nhập kho</button>
      </div>
    `);
  }

  async function confirmPurchase(btn) {
    const exp = document.getElementById('po-exp').value;
    const body = {
      item_id: document.getElementById('po-item').value,
      qty_base: parseFloat(document.getElementById('po-qty').value),
      unit_cost: parseFloat(document.getElementById('po-cost').value),
      expires_at: exp ? new Date(exp).toISOString() : ''
    };
    const code = document.getElementById('po-code').value.trim();
    if (code) body.batch_code = code;
    if (!(body.qty_base > 0)) return showToast('Số lượng không hợp lệ', 'Nhập số lượng lớn hơn 0.', 'danger');
    if (!(body.unit_cost >= 0)) return showToast('Đơn giá không hợp lệ', 'Đơn giá phải ≥ 0.', 'danger');
    if (!exp) return showToast('Thiếu hạn sử dụng', 'Chọn hạn sử dụng của lô hàng.', 'danger');
    setBusy(btn, true);
    try {
      const b = await api('POST', '/api/inventory/purchases', body);
      closeModal();
      showToast('✅ Đã nhập lô hàng mới', `Lô ${b?.batch_code || ''} (+${num(body.qty_base)}) đã ghi sổ cái PURCHASE.`, 'success');
      await refreshCurrent();
    } catch (e) { /* toast */ } finally {
      setBusy(btn, false);
    }
  }

  // ---------------------------------------------------------------------------
  // 11. TAB 4: CÔNG THỨC PHA CHẾ (BOM) & SOP
  // ---------------------------------------------------------------------------
  function renderBOM() {
    const isCashier = state.role === 'CASHIER';
    return `
      ${errorBox(['menu'])}
      ${isCashier ? `<div class="mb-4 p-3.5 rounded-xl bg-amber-50 border border-amber-200 text-sm text-amber-900">🔒 <b>Phân quyền Thu ngân:</b> Thu ngân chỉ xem danh mục giá bán và mã phiên bản công thức; chi tiết định lượng, SOP và giá vốn bị ẩn bởi backend.</div>` : ''}
      <div class="space-y-5">
        ${state.menu.map(m => {
          const r = m.recipe || {};
          const lines = r.lines || null;
          const sop = r.sop_steps || null;
          const hasCost = has(r, 'est_cogs');
          const est = Number(r.est_cogs) || 0;
          const fc = has(r, 'food_cost_pct')
            ? Number(r.food_cost_pct)
            : (Number(m.base_price) > 0 ? (est / Number(m.base_price)) * 100 : 0);

          return `
            <div class="bg-white rounded-xl border border-slate-200 p-5" data-recipe="${esc(m.code)}">
              <div class="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-100">
                <div>
                  <span class="text-xs font-mono px-2 py-0.5 rounded bg-slate-100 text-slate-600">v${esc(r.version_no ?? '?')} • Đang áp dụng</span>
                  <span class="text-xs font-semibold text-amber-700 ml-2">${vnd(m.base_price)}</span>
                  <h3 class="font-bold text-lg text-slate-900 mt-1">${esc(m.name)}</h3>
                </div>
                <div class="flex items-center gap-3">
                  ${hasCost ? `
                    <div class="text-right">
                      <div class="text-xs text-slate-500">Giá vốn ước tính (Size M)</div>
                      <div class="font-bold text-indigo-700">${vnd(est)} <span class="text-xs ${fc > 35 ? 'text-rose-600' : 'text-emerald-600'}">(${fc.toFixed(1)}% giá bán)</span></div>
                    </div>
                  ` : ''}
                  ${isOwner()
                    ? `<button onclick="openBumpRecipeModal('${esc(m.id)}')" class="px-3 py-1.5 bg-slate-900 text-white text-xs font-bold rounded-lg hover:bg-slate-800">Tạo phiên bản mới</button>`
                    : `<span class="text-xs font-semibold text-amber-700 bg-amber-50 px-3 py-1.5 rounded-lg">🔒 Ẩn giá vốn &amp; Khóa chỉnh sửa BOM</span>`}
                </div>
              </div>
              ${lines ? `
                <div class="grid grid-cols-1 md:grid-cols-2 gap-6 pt-4 text-sm">
                  <div>
                    <div class="text-xs font-bold uppercase text-slate-500 mb-2">Định lượng chuẩn (Base BOM)</div>
                    <ul class="space-y-1.5">
                      ${lines.map(l => `
                        <li class="flex justify-between py-1 border-b border-slate-100">
                          <span>${esc(l.item_name)} <span class="text-[11px] font-mono text-slate-400">[${esc(l.ingredient_role)}]</span></span>
                          <span class="font-bold">${num(l.qty_base)} ${esc(l.base_unit)}</span>
                        </li>
                      `).join('') || '<li class="text-xs text-slate-400">Chưa có định lượng.</li>'}
                    </ul>
                  </div>
                  <div>
                    <div class="text-xs font-bold uppercase text-slate-500 mb-2">Quy trình thao tác chuẩn (SOP Đào tạo)</div>
                    <ol class="space-y-1.5 text-slate-700 text-xs leading-relaxed">
                      ${(sop || []).map(step => `<li class="p-2 rounded bg-slate-50 border border-slate-100">${esc(step)}</li>`).join('') || '<li class="text-slate-400">Chưa có SOP.</li>'}
                    </ol>
                  </div>
                </div>
              ` : `<div class="pt-4 text-xs text-slate-500 italic">Thu ngân chỉ xem danh mục giá bán (không xem định lượng BOM &amp; SOP).</div>`}
            </div>
          `;
        }).join('') || '<div class="text-sm text-slate-400">Chưa có công thức.</div>'}
      </div>
    `;
  }

  function openBumpRecipeModal(menuId) {
    const m = state.menu.find(x => x.id === menuId);
    if (!m) return;
    const r = m.recipe || {};
    openModal(`
      <div class="p-5 border-b border-slate-200">
        <h3 class="font-bold text-slate-900">Phát hành công thức v${(Number(r.version_no) || 0) + 1}: ${esc(m.name)}</h3>
        <p class="text-xs text-slate-500 mt-1">Định lượng được sao chép từ v${esc(r.version_no ?? '?')}. Có thể chỉnh sửa hoặc bấm phát hành ngay; hóa đơn cũ giữ nguyên phiên bản đã đóng băng.</p>
      </div>
      <div class="p-5 space-y-3 text-sm max-h-[65vh] overflow-y-auto custom-scroll">
        <div>
          <div class="text-xs font-semibold text-slate-600 mb-1">Định lượng (đơn vị gốc)</div>
          <div class="space-y-1.5">
            ${(r.lines || []).map((l, i) => `
              <div class="flex items-center justify-between gap-2">
                <span class="text-xs">${esc(l.item_name)} <span class="font-mono text-slate-400">[${esc(l.ingredient_role)}]</span></span>
                <span class="flex items-center gap-1">
                  <input type="number" min="0" step="0.001" value="${esc(l.qty_base)}" data-line-idx="${i}" class="bump-line w-24 border border-slate-300 rounded-lg px-2 py-1 text-right font-semibold" />
                  <span class="text-xs text-slate-400 w-6">${esc(l.base_unit)}</span>
                </span>
              </div>
            `).join('')}
          </div>
        </div>
        <div>
          <label class="text-xs font-semibold text-slate-600">SOP (mỗi dòng 1 bước)</label>
          <textarea id="bump-sop" rows="4" class="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-xs">${esc((r.sop_steps || []).join('\n'))}</textarea>
        </div>
      </div>
      <div class="p-4 bg-slate-50 border-t border-slate-200 flex justify-end gap-2">
        <button onclick="closeModal()" class="px-4 py-2 text-xs font-semibold text-slate-600">Hủy</button>
        <button id="btn-confirm-bump" onclick="bumpRecipeVersion('${esc(m.id)}', this)" class="px-4 py-2 bg-slate-900 text-white text-xs font-bold rounded-lg">Phát hành phiên bản mới</button>
      </div>
    `);
  }

  async function bumpRecipeVersion(menuId, btn) {
    const m = state.menu.find(x => x.id === menuId);
    const r = (m && m.recipe) || {};
    const body = {};
    const sopTxt = document.getElementById('bump-sop')?.value;
    if (sopTxt != null) {
      const steps = sopTxt.split('\n').map(s => s.trim()).filter(Boolean);
      const origSop = (r.sop_steps || []).join('\n').trim();
      if (steps.length && steps.join('\n') !== origSop) {
        body.sop_steps = steps;
      }
    }
    const inputs = [...document.querySelectorAll('.bump-line')];
    if (inputs.length && r.lines) {
      const changed = inputs.some(inp => Number(inp.value) !== Number(r.lines[+inp.dataset.lineIdx].qty_base));
      if (changed) {
        body.lines = inputs.map(inp => {
          const l = r.lines[+inp.dataset.lineIdx];
          return { item_id: l.item_id, qty_base: parseFloat(inp.value) || 0, ingredient_role: l.ingredient_role };
        }).filter(l => l.qty_base > 0);
      }
    }
    setBusy(btn, true);
    try {
      const res = await api('POST', `/api/menu/${encodeURIComponent(menuId)}/recipe-version`, body);
      closeModal();
      showToast(`📌 Đã tạo công thức v${res?.version_no ?? ''}`, 'Các hóa đơn cũ vẫn giữ nguyên phiên bản và giá vốn đã đóng băng.', 'info');
      await refreshCurrent();
    } catch (e) { /* toast */ } finally {
      setBusy(btn, false);
    }
  }

  // ---------------------------------------------------------------------------
  // 12. TAB 5: ĐỐI SOÁT EOD & KIỂM KHO MÙ
  // ---------------------------------------------------------------------------
  function collectEodLinesPayload() {
    const rows = [...document.querySelectorAll('#eod-table tbody tr[data-item-id]')];
    return rows.map(row => {
      const itemId = row.dataset.itemId;
      const sealedEl = row.querySelector('[data-field="sealed"]');
      const grossEl = row.querySelector('[data-field="gross"]');
      return {
        item_id: itemId,
        counted_sealed_units: Math.max(0, parseFloat(sealedEl?.value) || 0),
        weighed_gross_g: Math.max(0, parseFloat(grossEl?.value) || 0)
      };
    });
  }

  function renderEOD() {
    const eod = state.eod;
    if (!eod) return errorBox(['eod']) || loadingBox();
    const owner = isOwner();
    const draft = eod.status === 'DRAFT_COUNTING';
    const lines = eod.lines || [];
    const showResults = lines.some(l => has(l, 'theoretical_qty_base'));
    const showVnd = lines.some(l => has(l, 'variance_vnd'));
    const sum = eod.summary;

    let actions = '';
    if (draft) {
      actions = `<div class="flex flex-wrap gap-2 shrink-0">
        <button id="btn-eod-fill" onclick="fillDemoEodSample(this)" class="px-3 py-2 bg-white/95 border border-slate-300 text-slate-800 hover:bg-slate-100 font-semibold text-xs rounded-lg">Điền mẫu nhanh</button>
        <button id="btn-eod-save" onclick="saveEODDraft(this)" class="px-3.5 py-2 bg-white border border-slate-300 text-slate-800 hover:bg-slate-100 font-bold text-xs rounded-lg">Lưu nháp</button>
        <button id="btn-eod-submit" onclick="submitEODBlindCount(this)" class="px-4 py-2 bg-amber-500 hover:bg-amber-600 text-slate-950 font-bold text-xs rounded-lg">Khóa &amp; Nộp phiếu Kiểm kho</button>
      </div>`;
    } else if (owner) {
      actions = `<div class="flex gap-2 shrink-0">
        ${eod.status === 'SUBMITTED' ? `<button id="btn-eod-lock" onclick="lockEOD(this)" class="px-3.5 py-2 bg-slate-900 text-white font-bold text-xs rounded-lg flex items-center gap-1.5"><i data-lucide="lock" class="w-3.5 h-3.5"></i> Khóa sổ EOD</button>` : ''}
        <button id="btn-eod-reopen" onclick="reopenEOD(this)" class="px-3.5 py-2 bg-white border border-slate-300 text-slate-700 font-bold text-xs rounded-lg">Mở kiểm lại (Demo)</button>
      </div>`;
    } else {
      actions = `<span class="px-3 py-1.5 rounded-lg bg-white/10 border border-white/20 text-xs font-bold shrink-0">${esc(EOD_STATUS_LABEL[eod.status] || eod.status)} • Chờ Chủ quán đối soát</span>`;
    }

    return `
      ${errorBox(['eod'])}
      <div class="mb-5 p-4 rounded-xl ${owner ? 'bg-indigo-50 border-indigo-200 text-indigo-900' : 'bg-slate-900 text-white'} border flex flex-wrap items-center justify-between gap-3" data-eod-status="${esc(eod.status)}">
        <div class="text-sm max-w-2xl">
          ${owner
            ? `<b>👁️ Chế độ Chủ quán (Đối soát hậu kiểm):</b> ${!draft ? `Đã nhận phiếu kiểm mù từ <b>${esc(eod.counted_by_name || '—')}</b> lúc ${fmtTime(eod.submitted_at)}${eod.status === 'LOCKED' ? ' • <b>ĐÃ KHÓA SỔ</b>' : ''}. Dưới đây là kết quả đối chiếu tự động với Sổ cái.` : 'Nhân viên ca tối chưa nộp phiếu kiểm kho mù. Bạn có thể tự nhập hoặc chuyển sang vai trò Quản lý ca để kiểm thử quy trình kiểm mù.'}`
            : `<b>🙈 CHẾ ĐỘ KIỂM KHO MÙ (BLIND COUNT):</b> Hệ thống đang ẩn hoàn toàn cột <i>Tồn lý thuyết</i> và <i>Chênh lệch</i>. Chỉ cần nhập số hộp nguyên và cân tổng cả chai (máy tự trừ trọng lượng vỏ rỗng).`}
        </div>
        ${actions}
      </div>

      ${owner && sum && showResults ? `
      <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-5" id="eod-summary">
        <div class="bg-white rounded-xl p-4 border border-rose-200"><div class="text-xs font-semibold text-rose-600 uppercase">Cờ Đỏ</div><div class="text-2xl font-bold text-rose-600">${num(sum.red)}</div></div>
        <div class="bg-white rounded-xl p-4 border border-amber-200"><div class="text-xs font-semibold text-amber-600 uppercase">Cờ Vàng</div><div class="text-2xl font-bold text-amber-600">${num(sum.yellow)}</div></div>
        <div class="bg-white rounded-xl p-4 border border-emerald-200"><div class="text-xs font-semibold text-emerald-600 uppercase">An toàn</div><div class="text-2xl font-bold text-emerald-600">${num(sum.green)}</div></div>
        <div class="bg-white rounded-xl p-4 border border-slate-200"><div class="text-xs font-semibold text-slate-500 uppercase">Tổng chênh lệch (VNĐ)</div><div class="text-2xl font-bold ${Number(sum.total_variance_vnd) < 0 ? 'text-rose-600' : 'text-slate-900'}">${vnd(sum.total_variance_vnd)}</div></div>
      </div>` : ''}

      <div class="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div class="px-5 py-3.5 border-b border-slate-200 font-bold text-slate-900 flex justify-between items-center">
          <span>Danh mục kiểm kho Nhóm ${esc(eod.abc_scope || 'A')} (5 phút cuối ngày)</span>
          <span class="text-xs font-normal text-slate-500">Ngày ${esc(eod.business_date ? String(eod.business_date).slice(0, 10) : '')} • ${esc(EOD_STATUS_LABEL[eod.status] || eod.status)} <span id="eod-save-status" class="ml-1"></span></span>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-sm text-left" id="eod-table">
            <thead class="text-xs uppercase bg-slate-50 text-slate-500">
              <tr>
                <th class="px-4 py-2.5">Nguyên liệu Nhóm A</th>
                <th class="px-4 py-2.5">Số hộp/cây nguyên</th>
                <th class="px-4 py-2.5">Cân tổng cả vỏ (g) / Lẻ</th>
                <th class="px-4 py-2.5 text-right">Thực tế quy đổi</th>
                ${showResults ? `
                  <th class="px-4 py-2.5 text-right">Tồn lý thuyết</th>
                  <th class="px-4 py-2.5 text-right">Chênh lệch</th>
                  <th class="px-4 py-2.5 text-right">% / Tiêu hao</th>
                  <th class="px-4 py-2.5 text-center">Cảnh báo</th>
                ` : ''}
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              ${lines.map(l => {
                const cu = l.count_unit || { unit_name: 'Đơn vị', to_base_factor: 1 };
                const pcs = l.base_unit === 'pcs';
                const edit = state.eodEdits[l.item_id] || {};
                const sealedVal = has(edit, 'sealed') ? edit.sealed : (l.counted_sealed_units ?? 0);
                const grossVal = has(edit, 'gross') ? edit.gross : (l.weighed_gross_g ?? 0);
                const v = Number(l.variance_qty_base);
                const alert = l.alert_level;
                const badgeCls = alert === 'RED' ? 'bg-rose-600 text-white' : alert === 'YELLOW' ? 'bg-amber-400 text-slate-950' : 'bg-emerald-100 text-emerald-800';
                return `
                  <tr data-eod-item="${esc(l.sku)}" data-item-id="${esc(l.item_id)}">
                    <td class="px-4 py-3">
                      <div class="font-bold text-slate-800">${esc(l.item_name)}</div>
                      <div class="text-[11px] text-slate-400">${esc(cu.unit_name)} = ${num(cu.to_base_factor)} ${esc(l.base_unit)}${Number(l.tare_weight_g) > 0 ? ` • Vỏ rỗng: ${num(l.tare_weight_g)}g` : ''}</div>
                    </td>
                    <td class="px-4 py-3">
                      <input type="number" min="0" step="1" ${!draft ? 'disabled' : ''} value="${esc(sealedVal)}"
                        data-item="${esc(l.item_id)}" data-field="sealed" oninput="onEODDraftChange(this)"
                        class="eod-input w-20 border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm font-semibold disabled:bg-slate-100" />
                      <span class="text-xs text-slate-400 ml-1">${esc(cu.unit_name)}</span>
                    </td>
                    <td class="px-4 py-3">
                      <input type="number" min="0" step="any" ${!draft ? 'disabled' : ''} value="${esc(grossVal)}"
                        data-item="${esc(l.item_id)}" data-field="gross" oninput="onEODDraftChange(this)"
                        class="eod-input w-24 border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm font-semibold disabled:bg-slate-100" />
                      <span class="text-xs text-slate-400 ml-1">${pcs ? 'ly lẻ' : 'g (tổng)'}</span>
                    </td>
                    <td class="px-4 py-3 text-right font-bold text-slate-900" id="eod-counted-${esc(l.item_id)}">${num(l.counted_qty_base)} ${esc(l.base_unit)}</td>
                    ${showResults ? `
                      <td class="px-4 py-3 text-right text-slate-600">${num(l.theoretical_qty_base)} ${esc(l.base_unit)}</td>
                      <td class="px-4 py-3 text-right font-bold ${v < 0 ? 'text-rose-600' : v > 0 ? 'text-amber-600' : 'text-emerald-600'}">
                        ${v > 0 ? '+' : ''}${num(v)} ${esc(l.base_unit)}
                        ${showVnd && has(l, 'variance_vnd') && Number(l.variance_vnd) !== 0 ? `<div class="text-[11px] font-normal">${Number(l.variance_vnd) > 0 ? '+' : ''}${vnd(l.variance_vnd)}</div>` : ''}
                      </td>
                      <td class="px-4 py-3 text-right font-mono text-xs">${Number(l.pos_usage_qty_base) > 0 ? num(l.variance_pct_usage) + '%' : (v === 0 ? '0%' : 'Chưa bán')}<div class="text-[10px] text-slate-400 font-sans">Bán: ${num(l.pos_usage_qty_base)} • Hủy: ${num(l.waste_qty_base)}</div></td>
                      <td class="px-4 py-3 text-center">
                        <span class="text-[11px] font-bold px-2.5 py-1 rounded-full ${badgeCls}" data-alert="${esc(alert)}">${alert === 'RED' ? 'ĐỎ • BÁO ĐỘNG' : alert === 'YELLOW' ? 'VÀNG • THEO DÕI' : 'XANH • AN TOÀN'}</span>
                        ${v > 0 && alert && alert !== 'GREEN' ? '<div class="text-[10px] text-amber-700 mt-0.5">Dư bất thường (pha thiếu?)</div>' : ''}
                        ${pcs && v <= -3 ? '<div class="text-[10px] text-rose-700 font-bold mt-0.5">Nghi vấn bán ngoài POS!</div>' : ''}
                      </td>
                    ` : ''}
                  </tr>
                `;
              }).join('') || `<tr><td colspan="8" class="px-4 py-6 text-center text-slate-400">Không có mặt hàng nhóm A.</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  function setEodSaveStatus(txt, cls) {
    const el = document.getElementById('eod-save-status');
    if (el) {
      el.textContent = txt;
      el.className = 'ml-1 ' + (cls || '');
    }
  }

  function onEODDraftChange(input) {
    const itemId = input.dataset.item;
    const field = input.dataset.field;
    if (!state.eodEdits[itemId]) state.eodEdits[itemId] = {};
    state.eodEdits[itemId][field] = Math.max(0, parseFloat(input.value) || 0);
    setEodSaveStatus('• Chưa lưu nháp', 'text-amber-600');
  }

  async function saveEODDraft(btn) {
    const lines = collectEodLinesPayload();
    if (!lines.length) return;
    setBusy(btn, true);
    setEodSaveStatus('• Đang lưu...', 'text-amber-600');
    try {
      const res = await api('PUT', '/api/eod/current/lines', { lines });
      state.eod = res;
      state.eodEdits = {};
      renderAll();
      setEodSaveStatus('• Đã lưu ✓', 'text-emerald-600');
      showToast('💾 Đã lưu nháp kiểm kho', 'Số lượng quy đổi đã được cập nhật từ máy chủ.', 'success');
    } catch (e) {
      setEodSaveStatus('• Lưu lỗi', 'text-rose-600');
    } finally {
      setBusy(btn, false);
    }
  }

  async function fillDemoEodSample(btn) {
    const sampleBySku = {
      'MILK-FRESH': { sealed: 0, gross: 860 },
      'PREP-TEA':   { sealed: 2, gross: 990 },
      'PREP-PEARL': { sealed: 0, gross: 1120 },
      'CUP-500ML':  { sealed: 4, gross: 0 },
      'CUP-700ML':  { sealed: 3, gross: 45 }
    };
    const eodLines = (state.eod && state.eod.lines) || [];
    if (!eodLines.length) return;
    const payload = eodLines.map(l => {
      const s = sampleBySku[l.sku] || { sealed: 0, gross: Number(l.tare_weight_g) || 0 };
      return { item_id: l.item_id, counted_sealed_units: s.sealed, weighed_gross_g: s.gross };
    });
    setBusy(btn, true);
    try {
      const res = await api('PUT', '/api/eod/current/lines', { lines: payload });
      state.eod = res;
      state.eodEdits = {};
      renderAll();
      setEodSaveStatus('• Đã điền mẫu & lưu ✓', 'text-emerald-600');
      showToast('✨ Đã điền số liệu kiểm kho mẫu', 'Bấm "Khóa & Nộp phiếu Kiểm kho" để chạy đối soát.', 'info');
    } catch (e) { /* toast */ } finally {
      setBusy(btn, false);
    }
  }

  async function submitEODBlindCount(btn) {
    const lines = collectEodLinesPayload();
    setBusy(btn, true);
    try {
      if (lines.length) {
        const saved = await api('PUT', '/api/eod/current/lines', { lines });
        state.eod = saved;
        state.eodEdits = {};
      }
      const res = await api('POST', '/api/eod/current/submit');
      state.eod = res;
      if (isOwner()) {
        const red = res?.summary?.red ?? (res.lines || []).filter(l => l.alert_level === 'RED').length;
        showToast('📊 Đã chạy động cơ đối soát EOD', `Phát hiện ${red} cảnh báo đỏ trên danh mục Nhóm A.`, red ? 'danger' : 'success');
      } else {
        showToast('✅ Đã nộp phiếu kiểm kho mù', 'Kết quả chênh lệch đã được khóa và gửi trực tiếp về Chủ quán. Hãy chuyển sang vai trò Chủ quán để xem!', 'success');
      }
      await refreshCurrent();
    } catch (e) { /* toast */ } finally {
      setBusy(btn, false);
    }
  }

  async function lockEOD(btn) {
    setBusy(btn, true);
    try {
      await api('POST', '/api/eod/current/lock');
      showToast('🔒 Đã khóa sổ EOD', 'Phiếu kiểm kho không thể chỉnh sửa. Đã ghi Audit Log.', 'success');
      await refreshCurrent();
    } catch (e) { /* toast */ } finally {
      setBusy(btn, false);
    }
  }

  async function reopenEOD(btn) {
    setBusy(btn, true);
    try {
      await api('POST', '/api/eod/current/reopen');
      state.eodEdits = {};
      showToast('↩️ Đã mở kiểm lại', 'Phiếu quay về trạng thái kiểm đếm mù.', 'info');
      await refreshCurrent();
    } catch (e) { /* toast */ } finally {
      setBusy(btn, false);
    }
  }

  // ---------------------------------------------------------------------------
  // 13. TAB 6: NHÂN SỰ, CHỐT KÉT MÙ & AUDIT LOG
  // ---------------------------------------------------------------------------
  function renderHR() {
    const owner = isOwner();
    const s = state.shift || {};
    const closed = s.status === 'CLOSED';
    const canCash = ['OWNER', 'MANAGER', 'CASHIER'].includes(state.role);
    const slot = SHIFT_SLOTS[s.shift_slot] || 'Ca';
    const myOpen = state.attendance.find(a => a.user_id === state.user?.id && !a.clock_out_at);
    const variance = Number(s.cash_variance);

    return `
      ${errorBox(['attendance', 'audit'])}
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <!-- Chấm công GPS + Wi-Fi -->
        <div class="bg-white rounded-xl border border-slate-200 p-5">
          <div class="flex items-center justify-between mb-3 gap-2 flex-wrap">
            <h2 class="font-bold text-slate-900">Chấm công ${esc(slot)} (GPS + Wi-Fi BSSID)</h2>
            <div class="flex items-center gap-2">
              <button id="btn-fake-location" onclick="clockIn(true, this)" title="Demo: gửi BSSID &amp; GPS sai để thấy hệ thống từ chối 422" class="px-2 py-1.5 text-[11px] font-semibold text-slate-500 hover:text-rose-600 rounded-lg border border-slate-200 hover:border-rose-300">Giả lập sai GPS/Wi-Fi</button>
              ${myOpen ? `<button id="btn-clock-out" onclick="clockOut(this)" class="px-3 py-1.5 bg-white border border-slate-300 text-slate-700 text-xs font-bold rounded-lg hover:bg-slate-50">Tan ca</button>` : ''}
              <button id="btn-clock-in" onclick="clockIn(false, this)" class="px-3 py-1.5 bg-emerald-600 text-white text-xs font-bold rounded-lg hover:bg-emerald-700">Chấm công ngay</button>
            </div>
          </div>
          <div class="space-y-2 text-xs" id="attendance-list">
            ${state.attendance.map(a => `
              <div class="p-2.5 rounded-lg bg-slate-50 border border-slate-200 flex items-center justify-between">
                <div>
                  <div class="font-bold text-slate-800">${esc(a.full_name)} <span class="font-normal text-slate-500">(${esc(a.role)})</span></div>
                  <div class="text-slate-500 mt-0.5">BSSID ${esc(a.wifi_bssid || '—')} • GPS: ${a.gps_lat != null ? num(a.gps_lat) : '—'}, ${a.gps_lng != null ? num(a.gps_lng) : '—'}</div>
                </div>
                <div class="text-right">
                  <div class="font-bold text-emerald-700">${fmtTime(a.clock_in_at)}${a.clock_out_at ? ` → ${fmtTime(a.clock_out_at)}` : ''}</div>
                  <div class="text-[11px] ${a.is_valid === false ? 'text-rose-600' : 'text-emerald-600'}">${a.is_valid === false ? '✗ Không hợp lệ' : '✓ Hợp lệ'}${a.clock_out_at ? ' • Đã tan ca' : ''}</div>
                </div>
              </div>
            `).join('') || '<div class="text-slate-400 py-4 text-center">Chưa có ai chấm công trong ca.</div>'}
          </div>
        </div>

        <!-- Chốt két mù -->
        <div class="bg-white rounded-xl border border-slate-200 p-5">
          <div class="flex items-center justify-between mb-2">
            <h2 class="font-bold text-slate-900">Chốt két tiền cuối ca (Blind Close-out)</h2>
            ${owner && closed ? `<button id="btn-reopen-shift" onclick="reopenShift(this)" class="px-3 py-1.5 bg-white border border-slate-300 text-slate-700 text-xs font-bold rounded-lg hover:bg-slate-50">Mở lại ca</button>` : ''}
          </div>
          <p class="text-xs text-slate-500 mb-4">Quỹ đầu ca: <b>${vnd(s.opening_cash)}</b>. ${has(s, 'expected_cash_pos') ? `Tiền mặt kỳ vọng hiện tại (chỉ Chủ thấy): <b class="text-indigo-700">${vnd(s.expected_cash_pos)}</b>` : 'Hệ thống ẩn tổng tiền mặt bán được cho tới khi chốt sổ.'}</p>
          ${canCash ? `
            <div class="flex gap-2 items-center">
              <input id="blind-cash-input" type="number" min="0" ${closed ? 'disabled' : ''} placeholder="Nhập tiền mặt đếm thực tế trong két" value="${closed && s.blind_cash_counted != null ? esc(s.blind_cash_counted) : ''}" class="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-sm font-bold disabled:bg-slate-100" />
              <button id="btn-blind-close" ${closed ? 'disabled' : ''} onclick="submitBlindCash(this)" class="px-4 py-2 ${closed ? 'bg-slate-300 text-slate-500' : 'bg-slate-900 text-white hover:bg-slate-800'} text-xs font-bold rounded-lg">Khóa két ca</button>
            </div>
            ${closed ? `
              <div class="mt-3 p-3 rounded-lg text-xs ${has(s, 'cash_variance') ? (variance === 0 ? 'bg-emerald-50 text-emerald-800' : 'bg-rose-50 text-rose-800') : 'bg-slate-100 text-slate-700'}" id="cash-result">
                ${has(s, 'cash_variance')
                  ? `<b>Kết quả đối soát két:</b> Thực đếm ${vnd(s.blind_cash_counted)} vs Kỳ vọng ${vnd(s.expected_cash_pos)} → Chênh lệch: <b>${variance > 0 ? '+' : ''}${vnd(variance)}</b>`
                  : `✓ Đã ghi nhận số tiền thực đếm ${vnd(s.blind_cash_counted)}. Kết quả thừa/thiếu đã gửi trực tiếp cho Chủ quán.`}
                <div class="mt-1 text-[11px] opacity-80">Chốt lúc ${fmtTime(s.closed_at)} • Ca đã khóa, POS ngừng bán.</div>
              </div>
            ` : ''}
          ` : `<div class="text-xs text-slate-400 italic">Vai trò Barista không có quyền truy cập két tiền.</div>`}
        </div>
      </div>

      <!-- Audit Log (Chỉ Owner được xem) -->
      <div class="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div class="px-5 py-3.5 border-b border-slate-200 font-bold text-slate-900 flex justify-between">
          <span>Nhật ký hệ thống bất biến (audit_logs)</span>
          <span class="text-xs font-normal text-slate-500">${owner ? 'Chỉ Chủ quán có quyền xem' : '🔒 Bị khóa theo RBAC'}</span>
        </div>
        ${owner ? `
          <div class="overflow-x-auto max-h-[28rem] overflow-y-auto custom-scroll">
            <table class="w-full text-xs text-left" id="audit-table">
              <thead class="uppercase bg-slate-50 text-slate-500 sticky top-0">
                <tr><th class="px-4 py-2">Thời gian</th><th class="px-4 py-2">Hành động</th><th class="px-4 py-2">Người thực hiện</th><th class="px-4 py-2">PIN duyệt</th><th class="px-4 py-2">Chi tiết</th></tr>
              </thead>
              <tbody class="divide-y divide-slate-100">
                ${state.auditLogs.map(l => `
                  <tr>
                    <td class="px-4 py-2 text-slate-500 whitespace-nowrap">${fmtDateTime(l.created_at)}</td>
                    <td class="px-4 py-2 font-mono font-bold text-slate-800">${esc(l.action_code)}</td>
                    <td class="px-4 py-2">${esc(l.actor_name || '—')}</td>
                    <td class="px-4 py-2 font-semibold text-indigo-700">${esc(l.approver_name || '—')}</td>
                    <td class="px-4 py-2 break-all">${esc(auditDetail(l))}</td>
                  </tr>
                `).join('') || '<tr><td colspan="5" class="px-4 py-6 text-center text-slate-400">Chưa có nhật ký.</td></tr>'}
              </tbody>
            </table>
          </div>
        ` : `<div class="p-8 text-center text-sm text-slate-400">Vai trò <b>${esc(ROLES[state.role]?.label || state.role)}</b> không có quyền đọc Nhật ký Audit Log. Hãy chuyển sang <b>Chủ quán</b> để kiểm tra.</div>`}
      </div>
    `;
  }

  async function clockIn(fake, btn) {
    const ts = Date.now();
    const body = fake
      ? { wifi_bssid: 'AA:BB:CC:00:11', gps_lat: 10.7769, gps_lng: 106.7009, face_photo_url: `camera://face_${ts}.jpg` }
      : { ...DEMO_GEO, face_photo_url: `camera://face_${ts}.jpg` };
    setBusy(btn, true);
    try {
      await api('POST', '/api/hr/clock-in', body);
      showToast('✅ Chấm công thành công', `${state.user?.full_name || ''} đã xác thực Wi-Fi quán + GPS + ảnh mặt.`, 'success');
      await refreshCurrent();
    } catch (e) { /* toast shows 422 rejection */ } finally {
      setBusy(btn, false);
    }
  }

  async function clockOut(btn) {
    setBusy(btn, true);
    try {
      await api('POST', '/api/hr/clock-out');
      showToast('👋 Đã tan ca', 'Đã ghi nhận giờ kết thúc ca làm.', 'info');
      await refreshCurrent();
    } catch (e) { /* toast */ } finally {
      setBusy(btn, false);
    }
  }

  async function submitBlindCash(btn) {
    const raw = document.getElementById('blind-cash-input').value;
    const val = parseFloat(raw);
    if (raw === '' || isNaN(val) || val < 0) return showToast('Số tiền không hợp lệ', 'Vui lòng nhập số tiền mặt thực đếm.', 'danger');
    setBusy(btn, true);
    try {
      const res = await api('POST', '/api/shift/blind-close', { counted_cash: val });
      if (has(res, 'cash_variance')) {
        showToast('🔒 Đã khóa sổ két ca', `Thực đếm ${vnd(res.blind_cash_counted)} • Kỳ vọng ${vnd(res.expected_cash_pos)} • Chênh lệch ${vnd(res.cash_variance)}.`, Number(res.cash_variance) === 0 ? 'success' : 'warn');
      } else {
        showToast('🔒 Đã khóa sổ két ca', 'Số liệu đã được gửi về báo cáo đối soát của Chủ quán.', 'success');
      }
      await refreshCurrent();
    } catch (e) { /* toast */ } finally {
      setBusy(btn, false);
    }
  }

  async function reopenShift(btn) {
    setBusy(btn, true);
    try {
      await api('POST', '/api/shift/reopen');
      showToast('↩️ Đã mở lại ca', 'Ca quay về trạng thái OPEN, POS bán tiếp được.', 'info');
      await refreshCurrent();
    } catch (e) { /* toast */ } finally {
      setBusy(btn, false);
    }
  }

  // ---------------------------------------------------------------------------
  // 14. RENDER TỔNG, RESET DEMO & KHỞI CHẠY
  // ---------------------------------------------------------------------------
  function renderAll() {
    renderSidebar();
    renderShiftBadge();
    const container = document.getElementById('main-content');
    const views = {
      dashboard: renderDashboard,
      pos: renderPOS,
      inventory: renderInventory,
      bom: renderBOM,
      eod: renderEOD,
      hr: renderHR
    };
    const scroll = container.scrollTop;
    container.innerHTML = state.loading ? loadingBox() : (views[state.tab] || renderPOS)();
    container.dataset.tab = state.tab;
    container.dataset.ready = state.loading ? '0' : '1';
    if (!state.loading) container.scrollTop = scroll;
    refreshIcons();
  }

  async function resetDemoData() {
    const btn = document.getElementById('reset-demo-btn');
    setBusy(btn, true);
    try {
      if (isOwner()) {
        await api('POST', '/api/admin/reset-demo');
      } else {
        // Lấy token OWNER tạm thời (không ghi đè phiên hiện tại của người dùng) để nút demo hoạt động từ mọi vai trò
        const ownerAuth = await rawFetch('POST', '/api/auth/demo-login', { role: 'OWNER' });
        await rawFetch('POST', '/api/admin/reset-demo', undefined, ownerAuth.token);
      }
      state.cart = [];
      state.eodEdits = {};
      showToast('🔄 Đã nạp lại Seed Data chuẩn', 'Tất cả lô hàng FEFO, sổ cái và giỏ hàng đã về trạng thái ban đầu.', 'info');
      await loadAndRender();
    } catch (e) {
      showErrorToast(e);
    } finally {
      setBusy(btn, false);
    }
  }

  document.getElementById('role-switcher').addEventListener('change', e => switchRole(e.target.value));
  document.getElementById('reset-demo-btn').addEventListener('click', resetDemoData);
  document.getElementById('login-link').addEventListener('click', openLoginModal);
  document.getElementById('modal-backdrop').addEventListener('click', e => {
    if (e.target.id === 'modal-backdrop') closeModal();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeModal();
  });

  Object.assign(window, {
    switchTab, refreshCurrent, closeModal, submitLogin,
    runSeedOrderPreset, openModifierModal, confirmAddToCart, removeCartItem, checkoutCart, toggleAvailability,
    requestVoidOrder, confirmVoidOrder,
    openPrepModal, confirmPrep, openWasteModal, confirmWaste, approveWaste, rejectWaste, openPurchaseModal, confirmPurchase,
    openBumpRecipeModal, bumpRecipeVersion,
    onEODDraftChange, saveEODDraft, fillDemoEodSample, submitEODBlindCount, lockEOD, reopenEOD,
    clockIn, clockOut, submitBlindCash, reopenShift
  });

  // Boot
  (async function boot() {
    state.loading = true;
    renderAll();
    try {
      await ensureSession();
    } catch (e) {
      state.loading = false;
      document.getElementById('main-content').innerHTML = `
        <div class="max-w-lg mx-auto mt-16 p-6 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-sm">
          <div class="font-bold mb-1">Không kết nối được máy chủ API</div>
          <div>${esc(e.message)}</div>
          <button onclick="location.reload()" class="mt-3 px-3 py-1.5 bg-rose-600 text-white text-xs font-bold rounded-lg">Thử lại</button>
        </div>`;
      renderSidebar();
      return;
    }
    await loadAndRender();
  })();
})();
