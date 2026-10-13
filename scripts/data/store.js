/* ============================================================
   store.js — Data layer (Supabase)
   ============================================================ */

/* ---- Helpers ---- */
/* LOCAL calendar date as YYYY-MM-DD. Using toISOString() here was a bug:
   it converts to UTC, so a user east/west of UTC could log a transaction
   on the wrong day (and "this week/month" boundaries shifted). */
function isoLocal(d) {
  const t = d instanceof Date ? d : new Date(d);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}
function todayISO() { return isoLocal(new Date()); }

function currentMonthRange() {
  const now  = new Date();
  const from = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  return { from, to: todayISO() };
}

async function userId() {
  const user = await SupaAuth.getUser();
  return user?.id;
}

/* ---- camelCase mappers ---- */
function accountToCamel(r) {
  return {
    id:             r.id,
    name:           r.name,
    type:           r.type,
    initialBalance: Number(r.initial_balance),
    color:          r.color,
    createdAt:      r.created_at,
  };
}

function txToCamel(r) {
  return {
    id:          r.id,
    date:        r.date,
    amount:      Number(r.amount),
    type:        r.type,
    categoryId:  r.category_id,
    accountId:   r.account_id,
    toAccountId: r.to_account_id,
    note:        r.note,
    tags:        r.tags || [],
    createdAt:   r.created_at,
    updatedAt:   r.updated_at,
  };
}

/* ============================================================
   TRANSACTION STORE
   ============================================================ */
const TransactionStore = {

  /* last-good cache so a transient network/Supabase blip degrades to stale
     data instead of a blank page (Account/Transaction stores used to throw) */
  _cacheKey: 'pf_tx_cache',
  _readCache() { try { return JSON.parse(localStorage.getItem(this._cacheKey) || 'null'); } catch { return null; } },
  _writeCache(list) { try { localStorage.setItem(this._cacheKey, JSON.stringify(list)); } catch (_) {} },

  /* PostgREST/Supabase caps a response at 1000 rows; without paging, heavy
     accounts silently lost transactions (wrong balances/charts). Page through
     in 1000-row windows until a short page signals the end. */
  async getAll() {
    const PAGE = 1000;
    try {
      let all = [], offset = 0;
      for (;;) {
        const { data, error } = await sb.from('transactions').select('*')
          .order('date', { ascending: false }).order('created_at', { ascending: false })
          .range(offset, offset + PAGE - 1);
        if (error) throw new Error(error.message);
        const rows = data || [];
        all = all.concat(rows);
        if (rows.length < PAGE) break;
        offset += PAGE;
      }
      const mapped = all.map(txToCamel);
      if (mapped.length <= 3000) this._writeCache(mapped);   /* keep cache writes cheap */
      return mapped;
    } catch (err) {
      const cached = this._readCache();
      if (cached) return cached;
      throw err;
    }
  },

  async getById(id) {
    const { data, error } = await sb.from('transactions').select('*').eq('id', id).single();
    if (error) return null;
    return txToCamel(data);
  },

  async add(data) {
    const uid = await userId();
    const { data: row, error } = await sb.from('transactions').insert({
      user_id:       uid,
      date:          data.date || todayISO(),
      amount:        Math.abs(Number(data.amount)),
      type:          data.type || 'expense',
      category_id:   data.categoryId  || null,
      account_id:    data.accountId   || null,
      to_account_id: data.toAccountId || null,
      note:          data.note        || '',
      tags:          data.tags        || [],
    }).select().single();
    if (error) throw new Error(error.message);
    return txToCamel(row);
  },

  /* Insert many at once — used by the CSV importer so a 200-row statement is a
     couple of round-trips, not 200. Chunked to stay under payload limits. */
  async bulkAdd(list) {
    if (!Array.isArray(list) || !list.length) return [];
    const uid = await userId();
    const rows = list.map(data => ({
      user_id:       uid,
      date:          data.date || todayISO(),
      amount:        Math.abs(Number(data.amount)),
      type:          data.type || 'expense',
      category_id:   data.categoryId  || null,
      account_id:    data.accountId   || null,
      to_account_id: data.toAccountId || null,
      note:          data.note        || '',
      tags:          data.tags        || [],
    }));
    const out = [];
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const { data: got, error } = await sb.from('transactions').insert(rows.slice(i, i + CHUNK)).select();
      if (error) throw new Error(error.message);
      out.push(...(got || []).map(txToCamel));
    }
    return out;
  },

  async update(id, data) {
    const patch = {};
    if (data.date        !== undefined) patch.date          = data.date;
    if (data.amount      !== undefined) patch.amount        = Math.abs(Number(data.amount));
    if (data.type        !== undefined) patch.type          = data.type;
    if (data.categoryId  !== undefined) patch.category_id   = data.categoryId;
    if (data.accountId   !== undefined) patch.account_id    = data.accountId;
    if (data.toAccountId !== undefined) patch.to_account_id = data.toAccountId;
    if (data.note        !== undefined) patch.note          = data.note;
    if (data.tags        !== undefined) patch.tags          = data.tags;
    /* NB: don't write `updated_at` — it's unused by the app and absent from
       older DBs (the schema uses `create table if not exists`, so the column
       was never added to tables created before it). Setting it made every
       edit fail with "column updated_at does not exist" while creates (which
       never set it) worked. */

    const { data: row, error } = await sb.from('transactions').update(patch).eq('id', id).select().single();
    if (error) throw new Error(error.message);
    return txToCamel(row);
  },

  async delete(id) {
    const { error } = await sb.from('transactions').delete().eq('id', id);
    if (error) throw new Error(error.message);
  },

  async query({ from, to, categoryId, accountId, type, search } = {}) {
    const PAGE = 1000;
    const build = () => {
      let q = sb.from('transactions').select('*');
      if (from)       q = q.gte('date', from);
      if (to)         q = q.lte('date', to);
      if (categoryId) q = q.eq('category_id', categoryId);
      if (accountId)  q = q.or(`account_id.eq.${accountId},to_account_id.eq.${accountId}`);
      if (type)       q = q.eq('type', type);
      if (search)     q = q.ilike('note', `%${search}%`);
      return q.order('date', { ascending: false }).order('created_at', { ascending: false });
    };
    let all = [], offset = 0;
    for (;;) {
      const { data, error } = await build().range(offset, offset + PAGE - 1);
      if (error) throw new Error(error.message);
      const rows = data || [];
      all = all.concat(rows);
      if (rows.length < PAGE) break;
      offset += PAGE;
    }
    return all.map(txToCamel);
  },

  async thisMonth() {
    const { from, to } = currentMonthRange();
    return this.query({ from, to });
  },
};

/* ============================================================
   ACCOUNT STORE
   ============================================================ */
const AccountStore = {

  /* Default account for new transactions (local convenience — prefills the
     Add Transaction form and the dashboard quick-log). '' = no preference. */
  getDefaultId() { return localStorage.getItem('pf_default_account') || ''; },
  setDefaultId(id) {
    if (id) localStorage.setItem('pf_default_account', id);
    else localStorage.removeItem('pf_default_account');
    SettingsStore.setJobSettings({ defaultAccountId: id || '' });   /* sync cross-device */
  },

  /* Custom account order — set by dragging accounts in the dashboard's
     customize mode. Ids in display order; synced via ui_prefs.accountOrder
     and mirrored here because renders read it synchronously. Accounts not in
     the list (new ones) keep their creation order, after the ordered ones. */
  ORDER_KEY: 'pf_account_order',
  getOrder() {
    try { const v = JSON.parse(localStorage.getItem(this.ORDER_KEY) || '[]'); return Array.isArray(v) ? v : []; }
    catch { return []; }
  },
  hasCustomOrder() { return this.getOrder().length > 0; },
  async setOrder(ids) {
    try { localStorage.setItem(this.ORDER_KEY, JSON.stringify(ids)); } catch (_) {}
    await SettingsStore.setUiPref({ accountOrder: ids });
  },
  _applyOrder(list) {
    const order = this.getOrder();
    if (!order.length) return list;
    const rank = new Map(order.map((id, i) => [id, i]));
    return list
      .map((a, i) => ({ a, i }))
      .sort((x, y) => (rank.get(x.a.id) ?? order.length + x.i) - (rank.get(y.a.id) ?? order.length + y.i))
      .map(x => x.a);
  },

  /* last-good cache → a transient error shows stale accounts, not a blank page */
  _cacheKey: 'pf_acct_cache',
  async getAll() {
    try {
      const { data, error } = await sb.from('accounts').select('*').order('created_at');
      if (error) throw new Error(error.message);
      const mapped = (data || []).map(accountToCamel);
      try { localStorage.setItem(this._cacheKey, JSON.stringify(mapped)); } catch (_) {}
      return this._applyOrder(mapped);
    } catch (err) {
      try { const c = JSON.parse(localStorage.getItem(this._cacheKey) || 'null'); if (c) return this._applyOrder(c); } catch (_) {}
      throw err;
    }
  },

  async getById(id) {
    const { data, error } = await sb.from('accounts').select('*').eq('id', id).single();
    if (error) return null;
    return accountToCamel(data);
  },

  async add(data) {
    const uid = await userId();
    const { data: row, error } = await sb.from('accounts').insert({
      user_id:         uid,
      name:            data.name || 'Account',
      type:            data.type || 'bank',
      initial_balance: Number(data.initialBalance) || 0,
      color:           data.color || '#6366f1',
    }).select().single();
    if (error) throw new Error(error.message);
    return accountToCamel(row);
  },

  async update(id, data) {
    const patch = {};
    if (data.name            !== undefined) patch.name            = data.name;
    if (data.type            !== undefined) patch.type            = data.type;
    if (data.initialBalance  !== undefined) patch.initial_balance = Number(data.initialBalance);
    if (data.color           !== undefined) patch.color           = data.color;
    const { data: row, error } = await sb.from('accounts').update(patch).eq('id', id).select().single();
    if (error) throw new Error(error.message);
    return accountToCamel(row);
  },

  async delete(id) {
    const { error } = await sb.from('accounts').delete().eq('id', id);
    if (error) throw new Error(error.message);
  },

  async getBalance(accountId) {
    const account = await this.getById(accountId);
    if (!account) return 0;
    const { data: txs, error } = await sb.from('transactions').select('type, amount, account_id, to_account_id').or(`account_id.eq.${accountId},to_account_id.eq.${accountId}`);
    if (error) return account.initialBalance;
    return (txs || []).reduce((bal, t) => {
      if (t.type === 'income'   && t.account_id    === accountId) return bal + Number(t.amount);
      if (t.type === 'expense'  && t.account_id    === accountId) return bal - Number(t.amount);
      if (t.type === 'transfer' && t.account_id    === accountId) return bal - Number(t.amount);
      if (t.type === 'transfer' && t.to_account_id === accountId) return bal + Number(t.amount);
      return bal;
    }, account.initialBalance);
  },

  async getTotalBalance() {
    const accounts = await this.getAll();
    const balances = await Promise.all(accounts.map(a => this.getBalance(a.id)));
    return balances.reduce((s, b) => s + b, 0);
  },
};

/* ============================================================
   CATEGORY STORE (hardcoded defaults, no DB)
   ============================================================ */
const DEFAULT_CATEGORIES = [
  { id: 'cat-salary',    name: 'Salary',           icon: '💼', type: 'income'  },
  { id: 'cat-freelance', name: 'Freelance',        icon: '💻', type: 'income'  },
  { id: 'cat-bonus',     name: 'Bonus',            icon: '💰', type: 'income'  },
  { id: 'cat-refund',    name: 'Refund',           icon: '💸', type: 'income'  },
  { id: 'cat-gift',      name: 'Gift',             icon: '🎁', type: 'income'  },
  { id: 'cat-invest',    name: 'Investment',       icon: '📈', type: 'income'  },
  { id: 'cat-food',      name: 'Restaurants',      icon: '🍔', type: 'expense' },
  { id: 'cat-groceries', name: 'Groceries',        icon: '🛒', type: 'expense' },
  { id: 'cat-rent',      name: 'Rent',             icon: '🏠', type: 'expense' },
  { id: 'cat-bills',     name: 'Bills',            icon: '⚡', type: 'expense' },
  { id: 'cat-subs',      name: 'Subscriptions',    icon: '📺', type: 'expense' },
  { id: 'cat-transport', name: 'Transport',        icon: '🚗', type: 'expense' },
  { id: 'cat-health',    name: 'Health',           icon: '❤️', type: 'expense' },
  { id: 'cat-fitness',   name: 'Sports & Fitness', icon: '🏋️', type: 'expense' },
  { id: 'cat-care',      name: 'Personal Care',    icon: '💈', type: 'expense' },
  { id: 'cat-shopping',  name: 'Shopping',         icon: '🛍️', type: 'expense' },
  { id: 'cat-entertain', name: 'Entertainment',    icon: '🎮', type: 'expense' },
  { id: 'cat-pets',      name: 'Pets',             icon: '🐾', type: 'expense' },
  { id: 'cat-insurance', name: 'Insurance',        icon: '🛡️', type: 'expense' },
  { id: 'cat-taxes',     name: 'Taxes',            icon: '🧾', type: 'expense' },
  { id: 'cat-donations', name: 'Gifts & Donations', icon: '💝', type: 'expense' },
  { id: 'cat-education', name: 'Education',        icon: '📚', type: 'expense' },
  { id: 'cat-travel',    name: 'Travel',           icon: '✈️', type: 'expense' },
  { id: 'cat-other',     name: 'Other',            icon: '📦', type: 'both'   },
];

const CategoryStore = {
  async getAll() {
    const custom = await SettingsStore.getCustomCategories();
    return [...DEFAULT_CATEGORIES, ...custom];
  },
  async getById(id) {
    const all = await this.getAll();
    return all.find(c => c.id === id) || null;
  },
  async getByType(type) {
    const all = await this.getAll();
    return all.filter(c => c.type === type || c.type === 'both');
  },
};

/* ============================================================
   SETTINGS STORE (Supabase — all user preferences)
   ============================================================ */
const SettingsStore = {
  _cache: null,

  _defaults() {
    return { currency: 'CAD', budgets: {}, custom_categories: [], subscriptions: [] };
  },

  async _load() {
    if (this._cache) return this._cache;
    const uid = await userId();
    if (!uid) return this._defaults();
    const { data } = await sb.from('user_settings').select('*').eq('user_id', uid).maybeSingle();
    this._cache = data ? { ...this._defaults(), ...data } : this._defaults();
    /* keep the synchronous formatCurrency cache in step with the server value */
    if (data && data.currency) localStorage.setItem('pf_currency', data.currency);
    return this._cache;
  },

  _invalidate() { this._cache = null; },

  async _save(patch) {
    const uid = await userId();
    if (!uid) return;
    /* ensure cache is fully loaded before merging to avoid clobbering fields */
    if (!this._cache) await this._load();
    this._cache = { ...this._cache, ...patch };
    await sb.from('user_settings').upsert({ user_id: uid, ...this._cache }, { onConflict: 'user_id' });
  },

  async getCurrency() {
    const cached = localStorage.getItem('pf_currency');
    if (cached) return cached;
    const s = await this._load();
    const c = s.currency || 'CAD';
    localStorage.setItem('pf_currency', c);
    return c;
  },

  async setCurrency(currency) {
    localStorage.setItem('pf_currency', currency);
    await this._save({ currency });
  },

  async getCustomCategories() {
    const s = await this._load();
    return Array.isArray(s.custom_categories) ? s.custom_categories : [];
  },

  async setCustomCategories(cats) {
    await this._save({ custom_categories: cats });
  },

  async getBudgets() {
    const s = await this._load();
    const budgets = s.budgets || {};
    localStorage.setItem('pf_budgets', JSON.stringify(budgets));
    return budgets;
  },

  async setBudgets(budgets) {
    localStorage.setItem('pf_budgets', JSON.stringify(budgets));
    await this._save({ budgets });
  },

  async getSubscriptions() {
    const s = await this._load();
    return Array.isArray(s.subscriptions) ? s.subscriptions : [];
  },

  async setSubscriptions(subs) {
    if (this._cache) this._cache.subscriptions = subs;
    await this._save({ subscriptions: subs });
  },

  /* ---- Hours-tracker defaults, synced cross-device ----
     The job/account defaults used to live only in localStorage, so a second
     device started blank. They now persist in user_settings.job_defaults and
     mirror back into the same localStorage keys the synchronous getters read
     (pf_default_job / pf_job_employer / pf_shift_rate / pf_job_account /
     pf_default_account) — so nothing downstream changes, it just hydrates from
     the server on load. The write is an isolated upsert of only job_defaults,
     so a pre-migration DB (no column yet) degrades to local-only instead of
     breaking the other settings saves. */
  /* Write a single jsonb column on its own — isolated from _save so a
     pre-migration DB (missing column) degrades to local-only rather than
     breaking the other settings. Caches the value only on success.

     NB: supabase-js does NOT throw on a DB error — it resolves with { error }.
     So we must inspect `error`, not rely on try/catch. If the column is missing
     (a DB that predates the v6 job_defaults / ui_prefs / shift_* settings), the
     write can't persist and the setting won't sync across devices; we surface
     that once instead of silently losing it, and we do NOT cache a value the
     server never accepted. */
  async _putColumn(column, value) {
    const uid = await userId();
    if (!uid) return;
    let error;
    try {
      ({ error } = await sb.from('user_settings').upsert({ user_id: uid, [column]: value }, { onConflict: 'user_id' }));
    } catch (e) { error = e; }   /* genuine network/exception path */
    if (error) { this._warnSyncFailed(column, error); return; }
    if (this._cache) this._cache[column] = value;
  },

  /* One warning per column per session — a missing column (Postgres 42703 /
     PostgREST PGRST204 "could not find column") means the DB needs the latest
     supabase-schema.sql. Kept to the console so end users aren't alarmed. */
  _warnSyncFailed(column, error) {
    try {
      const seen = (this._warnedCols || (this._warnedCols = new Set()));
      if (seen.has(column)) return;
      seen.add(column);
    } catch (_) {}
    const msg = (error && (error.message || error.details || error.code)) || error;
    console.warn(
      `[settings] "${column}" could not be saved to Supabase, so it won't sync across devices ` +
      `(it stays only on this device). This usually means the database is missing the "${column}" ` +
      `column — run the ALTER TABLE statements in supabase-schema.sql. Cause:`, msg,
    );
  },

  async getJobSettings() {
    const s = await this._load();
    return (s && s.job_defaults && typeof s.job_defaults === 'object') ? s.job_defaults : {};
  },

  _mirrorJobDefaults(jd) {
    const set = (k, v) => { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); };
    if (jd.defaultJobId     !== undefined) set('pf_default_job',     jd.defaultJobId);
    if (jd.employer         !== undefined) set('pf_job_employer',    jd.employer);
    if (jd.rate             !== undefined) localStorage.setItem('pf_shift_rate', String(Number(jd.rate) || 0));
    if (jd.accountId        !== undefined) set('pf_job_account',     jd.accountId);
    if (jd.defaultAccountId !== undefined) set('pf_default_account', jd.defaultAccountId);
  },

  async setJobSettings(patch) {
    const merged = { ...(await this.getJobSettings()), ...patch };
    this._mirrorJobDefaults(merged);                 /* local mirror applies immediately */
    await this._putColumn('job_defaults', merged);
  },

  /* Weekly goal { metric, target } */
  async setShiftGoal(goal) {
    localStorage.setItem('pf_shift_goal', JSON.stringify(goal));
    await this._putColumn('shift_goal', goal);
  },

  /* Saved quick-log shift presets (array) */
  async setShiftPresets(list) {
    localStorage.setItem('pf_shift_presets', JSON.stringify(list));
    await this._putColumn('shift_presets', list);
  },

  /* ---- goal switches ----------------------------------------------------
     Which goal widgets are switched on: the dashboard's net-worth ring and the
     Hours Tracker's weekly goal. Absent means ON, so existing users see no
     change. Lives in the ui_prefs blob (no new column to migrate) and is
     mirrored to localStorage because the render paths that need it run
     synchronously, before any await. */
  GOALS_KEY: 'pf_goals',
  GOAL_IDS: ['netWorth', 'hours'],

  getGoalPrefs() {
    const on = { netWorth: true, hours: true };
    try {
      const raw = JSON.parse(localStorage.getItem(this.GOALS_KEY) || '{}');
      for (const k of this.GOAL_IDS) if (raw[k] === false) on[k] = false;
    } catch (_) {}
    return on;
  },
  goalEnabled(id) { return this.getGoalPrefs()[id] !== false; },

  async setGoalPref(id, enabled) {
    if (!this.GOAL_IDS.includes(id)) return this.getGoalPrefs();
    const next = { ...this.getGoalPrefs(), [id]: !!enabled };
    try { localStorage.setItem(this.GOALS_KEY, JSON.stringify(next)); } catch (_) {}
    await this.setUiPref({ goals: next });
    return next;
  },

  /* ---- navigation prefs ------------------------------------------------
     focus: what the user mainly uses Flow for — 'money' | 'hours' | 'both',
            asked once on the dashboard; 'hours' turns the bottom-bar + into
            "Log hours". null = not answered yet.
     slot:  which section sits in the mobile bottom bar's 4th spot.
     Synced in ui_prefs.nav and mirrored to localStorage because nav.js renders
     synchronously on every page, before any await. */
  NAV_KEY: 'pf_nav',
  NAV_SLOTS: ['money', 'shifts', 'crypto'],   /* 'insights' was dropped with the Insights page; a saved one falls back to money */
  NAV_FOCI:  ['money', 'hours', 'both'],

  getNavPrefs() {
    const p = { focus: null, slot: 'money' };
    try {
      const raw = JSON.parse(localStorage.getItem(this.NAV_KEY) || '{}');
      if (this.NAV_FOCI.includes(raw.focus)) p.focus = raw.focus;
      if (this.NAV_SLOTS.includes(raw.slot)) p.slot = raw.slot;
    } catch (_) {}
    return p;
  },

  async setNavPrefs(patch) {
    const next = { ...this.getNavPrefs(), ...patch };
    try { localStorage.setItem(this.NAV_KEY, JSON.stringify(next)); } catch (_) {}
    await this.setUiPref({ nav: next });
    return next;
  },

  /* Misc UI prefs, e.g. { balanceMode } */
  async getUiPrefs() {
    const s = await this._load();
    return (s && s.ui_prefs && typeof s.ui_prefs === 'object') ? s.ui_prefs : {};
  },
  async setUiPref(patch) {
    const merged = { ...(await this.getUiPrefs()), ...patch };
    if (merged.balanceMode) localStorage.setItem('pf_balance_mode', merged.balanceMode);
    await this._putColumn('ui_prefs', merged);
  },

  /* On boot: pull the server's settings into localStorage so the synchronous
     getters see them. For any field the server hasn't got yet, seed it from
     this device's current local value (one-time per field). */
  async hydrateLocalDefaults() {
    try {
      const s = await this._load();

      /* job/account defaults */
      const jd = (s && s.job_defaults && Object.keys(s.job_defaults).length) ? s.job_defaults : null;
      if (jd) this._mirrorJobDefaults(jd);
      else {
        const local = {
          defaultJobId:     localStorage.getItem('pf_default_job')     || '',
          employer:         localStorage.getItem('pf_job_employer')    || '',
          rate:             Number(localStorage.getItem('pf_shift_rate')) || 0,
          accountId:        localStorage.getItem('pf_job_account')     || '',
          defaultAccountId: localStorage.getItem('pf_default_account') || '',
        };
        if (Object.values(local).some(Boolean)) await this.setJobSettings(local);
      }

      /* weekly goal */
      if (s && s.shift_goal && Object.keys(s.shift_goal).length) {
        localStorage.setItem('pf_shift_goal', JSON.stringify(s.shift_goal));
      } else {
        const lg = localStorage.getItem('pf_shift_goal');
        if (lg && lg !== '{}') { try { await this._putColumn('shift_goal', JSON.parse(lg)); } catch (_) {} }
      }

      /* shift presets */
      if (s && Array.isArray(s.shift_presets) && s.shift_presets.length) {
        localStorage.setItem('pf_shift_presets', JSON.stringify(s.shift_presets));
      } else {
        const lp = localStorage.getItem('pf_shift_presets');
        if (lp && lp !== '[]') { try { await this._putColumn('shift_presets', JSON.parse(lp)); } catch (_) {} }
      }

      /* UI prefs (balance-chart mode + net-worth goal) */
      const up = (s && s.ui_prefs && typeof s.ui_prefs === 'object') ? s.ui_prefs : null;
      if (up && Object.keys(up).length) {
        if (up.balanceMode) localStorage.setItem('pf_balance_mode', up.balanceMode);
        if (up.nwGoal !== undefined) {
          if (Number(up.nwGoal) > 0) localStorage.setItem('pf_nw_goal', String(up.nwGoal));
          else localStorage.removeItem('pf_nw_goal');
        }
        if (Array.isArray(up.txTemplates)) localStorage.setItem('pf_tx_templates', JSON.stringify(up.txTemplates));
        if (Array.isArray(up.accountOrder)) localStorage.setItem(AccountStore.ORDER_KEY, JSON.stringify(up.accountOrder));
        if (up.goals && typeof up.goals === 'object') {
          localStorage.setItem(this.GOALS_KEY, JSON.stringify(up.goals));
        }
        if (up.nav && typeof up.nav === 'object') {
          const prev = localStorage.getItem(this.NAV_KEY);
          localStorage.setItem(this.NAV_KEY, JSON.stringify(up.nav));
          /* changed on another device — redraw the bar this page already painted */
          if (prev !== JSON.stringify(up.nav)) window.PFNav?.refresh();
        } else if (localStorage.getItem(this.NAV_KEY)) {
          /* chosen on this device before the blob existed — push it up once */
          try { await this.setUiPref({ nav: this.getNavPrefs() }); } catch (_) {}
        }
      } else {
        const seed = {};
        const bm = localStorage.getItem('pf_balance_mode');
        if (bm) seed.balanceMode = bm;
        const g = parseFloat(localStorage.getItem('pf_nw_goal'));
        if (Number.isFinite(g) && g > 0) seed.nwGoal = g;
        try {
          const goals = JSON.parse(localStorage.getItem(this.GOALS_KEY) || '{}');
          if (goals && Object.keys(goals).length) seed.goals = goals;
        } catch (_) {}
        if (localStorage.getItem(this.NAV_KEY)) seed.nav = this.getNavPrefs();
        if (AccountStore.hasCustomOrder()) seed.accountOrder = AccountStore.getOrder();
        try {
          const tpls = JSON.parse(localStorage.getItem('pf_tx_templates') || '[]');
          if (Array.isArray(tpls) && tpls.length) seed.txTemplates = tpls;
        } catch (_) {}
        if (Object.keys(seed).length) await this._putColumn('ui_prefs', seed);
      }
    } catch (_) {}
  },
};

/* ============================================================
   BUDGET STORE (syncs to Supabase via SettingsStore)
   ============================================================ */
const BudgetStore = {
  _key: 'pf_budgets',

  _all() {
    try { return JSON.parse(localStorage.getItem(this._key) || '{}'); }
    catch { return {}; }
  },

  async load() {
    return SettingsStore.getBudgets();
  },

  getMonth(monthKey) { return this._all()[monthKey] || {}; },

  async set(monthKey, categoryId, limit) {
    const all = this._all();
    if (!all[monthKey]) all[monthKey] = {};
    if (!limit || limit <= 0) delete all[monthKey][categoryId];
    else all[monthKey][categoryId] = Number(limit);
    await SettingsStore.setBudgets(all);
  },

  async copyFromPrevious(monthKey) {
    const all  = this._all();
    const d    = new Date(monthKey + '-01T00:00:00');
    d.setMonth(d.getMonth() - 1);
    const prev = isoLocal(d).slice(0, 7);
    all[monthKey] = { ...(all[prev] || {}) };
    await SettingsStore.setBudgets(all);
    return all[monthKey];
  },
};

/* ============================================================
   SHARED ID / DATE HELPERS (used by SubscriptionStore)
   ============================================================ */
const IS_UUID = s => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s || '');
function newUUID() {
  return crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}
function advanceDate(iso, frequency) {
  const d = new Date(iso + 'T00:00:00');
  switch (frequency) {
    case 'daily':   d.setDate(d.getDate() + 1); break;
    case 'weekly':  d.setDate(d.getDate() + 7); break;
    case 'monthly': d.setMonth(d.getMonth() + 1); break;
    case 'yearly':  d.setFullYear(d.getFullYear() + 1); break;
  }
  return isoLocal(d);
}

/* ============================================================
   TX TEMPLATE STORE — saved transaction templates for fast
   re-logging of recurring purchases. Device-local (localStorage);
   no schema dependency. Mirrors the shift-preset pattern.
   Template: { id, name, type, amount, note, accountId,
               toAccountId, categoryId, tags }
   ============================================================ */
const TxTemplateStore = {
  _key: 'pf_tx_templates',
  getAll() {
    try { return JSON.parse(localStorage.getItem(this._key) || '[]'); } catch { return []; }
  },
  save(tpl) {
    const list = this.getAll();
    if (tpl.id) {
      const i = list.findIndex(t => t.id === tpl.id);
      if (i >= 0) list[i] = tpl; else list.push(tpl);
    } else {
      tpl.id = 'tpl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      list.push(tpl);
    }
    this._persist(list);
    return tpl;
  },
  remove(id) {
    this._persist(this.getAll().filter(t => t.id !== id));
  },
  _persist(list) {
    try { localStorage.setItem(this._key, JSON.stringify(list)); } catch (_) {}
    /* sync cross-device via the settings ui_prefs blob (fire and forget) */
    try { SettingsStore.setUiPref({ txTemplates: list }); } catch (_) {}
  },
};

/* ============================================================
   SUBSCRIPTION STORE — Supabase table `subscriptions`.
   Table-first, with a legacy user_settings jsonb-blob fallback
   and lazy migration into the table once it exists.
   ============================================================ */
function subToCamel(r) {
  return {
    id: r.id, name: r.name, amount: Number(r.amount), frequency: r.frequency,
    nextDue: r.next_due, accountId: r.account_id, categoryId: r.category_id,
    color: r.color, autoLog: r.auto_log, active: r.active, createdAt: r.created_at,
  };
}

function subToRow(s) {
  const row = {};
  if (s.name       !== undefined) row.name        = s.name;
  if (s.amount     !== undefined) row.amount      = s.amount;
  if (s.frequency  !== undefined) row.frequency   = s.frequency;
  if (s.nextDue    !== undefined) row.next_due    = s.nextDue;
  if (s.accountId  !== undefined) row.account_id  = s.accountId  || null;
  if (s.categoryId !== undefined) row.category_id = s.categoryId || null;
  if (s.color      !== undefined) row.color       = s.color || null;
  if (s.autoLog    !== undefined) row.auto_log    = s.autoLog !== false;
  if (s.active     !== undefined) row.active      = s.active !== false;
  return row;
}

const SubscriptionStore = {
  _mode: null,

  async _detect() {
    if (this._mode) return this._mode;
    const { error } = await sb.from('subscriptions').select('id').limit(1);
    this._mode = error ? 'legacy' : 'table';
    if (this._mode === 'table') await this._migrate();
    return this._mode;
  },

  async _migrate() {
    try {
      const legacy = await SettingsStore.getSubscriptions();
      if (!legacy.length) return;
      const uid = await userId();
      if (!uid) return;
      const accounts = await AccountStore.getAll();
      const accIds   = new Set(accounts.map(a => a.id));
      const rows = legacy.map(s => ({
        id: IS_UUID(s.id) ? s.id : newUUID(),
        user_id: uid,
        ...subToRow({
          ...s,
          accountId: accIds.has(s.accountId) ? s.accountId : null,
          name: s.name, amount: s.amount, frequency: s.frequency || 'monthly',
          nextDue: s.nextDue, categoryId: s.categoryId, color: s.color,
          autoLog: s.autoLog, active: s.active,
        }),
      }));
      const { error } = await sb.from('subscriptions').insert(rows);
      if (!error) await SettingsStore.setSubscriptions([]);
    } catch (_) { /* legacy data stays in the blob; retried next load */ }
  },

  async getAll() {
    if (await this._detect() === 'legacy') return SettingsStore.getSubscriptions();
    const { data, error } = await sb.from('subscriptions').select('*').order('created_at');
    if (error) throw new Error(error.message);
    return (data || []).map(subToCamel);
  },

  async add(sub) {
    if (await this._detect() === 'legacy') {
      const list = await SettingsStore.getSubscriptions();
      sub.id = newUUID();
      list.push(sub);
      await SettingsStore.setSubscriptions(list);
      return sub;
    }
    const uid = await userId();
    const { data, error } = await sb.from('subscriptions').insert({ user_id: uid, ...subToRow(sub) }).select().single();
    if (error) throw new Error(error.message);
    return subToCamel(data);
  },

  async update(id, patch) {
    if (await this._detect() === 'legacy') {
      const list = await SettingsStore.getSubscriptions();
      const idx  = list.findIndex(s => s.id === id);
      if (idx === -1) return;
      list[idx] = { ...list[idx], ...patch };
      await SettingsStore.setSubscriptions(list);
      return list[idx];
    }
    const { data, error } = await sb.from('subscriptions').update(subToRow(patch)).eq('id', id).select().single();
    if (error) throw new Error(error.message);
    return subToCamel(data);
  },

  async remove(id) {
    if (await this._detect() === 'legacy') {
      const list = await SettingsStore.getSubscriptions();
      await SettingsStore.setSubscriptions(list.filter(s => s.id !== id));
      return;
    }
    const { error } = await sb.from('subscriptions').delete().eq('id', id);
    if (error) throw new Error(error.message);
  },

  async getDue() {
    const today = todayISO();
    const list  = await this.getAll();
    return list.filter(s => s.active !== false && s.nextDue <= today);
  },

  async advanceNext(id) {
    if (await this._detect() === 'legacy') {
      const list = await SettingsStore.getSubscriptions();
      const sub  = list.find(s => s.id === id);
      if (!sub) return;
      sub.nextDue = advanceDate(sub.nextDue, sub.frequency);
      await SettingsStore.setSubscriptions(list);
      return;
    }
    const list = await this.getAll();
    const sub  = list.find(s => s.id === id);
    if (!sub) return;
    const { error } = await sb.from('subscriptions').update({ next_due: advanceDate(sub.nextDue, sub.frequency) }).eq('id', id);
    if (error) throw new Error(error.message);
  },

  /* Set next_due directly. Used to catch an overdue subscription up to today
     in one pass, after its missed occurrences have been logged. */
  async setNextDue(id, iso) {
    if (!iso) return;
    if (await this._detect() === 'legacy') {
      const list = await SettingsStore.getSubscriptions();
      const sub  = list.find(s => s.id === id);
      if (!sub) return;
      sub.nextDue = iso;
      await SettingsStore.setSubscriptions(list);
      return;
    }
    const { error } = await sb.from('subscriptions').update({ next_due: iso }).eq('id', id);
    if (error) throw new Error(error.message);
  },
};

/* ============================================================
   SHIFT STORE — Supabase table `shifts` (work hours + pay).
   Table-first with a localStorage fallback + lazy migration once
   the table exists (mirrors CryptoStore). A logged shift may link
   to an income transaction via `txId`.
   Shift (camel): { id, date, start, end, breakMin, rate, employer,
                    accountId, categoryId, txId, note }
   ============================================================ */
function shiftToRow(s) {
  const row = {};
  if (s.date       !== undefined) row.date        = s.date;
  if (s.hours      !== undefined) row.hours       = Number(s.hours) || 0;
  if (s.start      !== undefined) row.start_time  = s.start || '';
  if (s.end        !== undefined) row.end_time    = s.end   || '';
  if (s.breakMin   !== undefined) row.break_min   = Number(s.breakMin) || 0;
  if (s.rate       !== undefined) row.rate        = Number(s.rate) || 0;
  if (s.employer   !== undefined) row.employer    = s.employer || '';
  if (s.payMode    !== undefined) row.pay_mode    = s.payMode === 'fixed' ? 'fixed' : 'hourly';
  if (s.fixedPay   !== undefined) row.fixed_pay   = Number(s.fixedPay) || 0;
  if (s.tips       !== undefined) row.tips        = Number(s.tips) || 0;
  if (s.accountId  !== undefined) row.account_id  = s.accountId  || null;
  if (s.categoryId !== undefined) row.category_id = s.categoryId || null;
  if (s.txId       !== undefined) row.tx_id       = s.txId       || null;
  if (s.jobId      !== undefined) row.job_id      = s.jobId      || null;
  if (s.note       !== undefined) row.note        = s.note || '';
  return row;
}
function shiftToCamel(r) {
  return {
    id: r.id, date: r.date, hours: Number(r.hours) || 0,
    start: r.start_time || '', end: r.end_time || '',
    breakMin: r.break_min || 0, rate: Number(r.rate) || 0, employer: r.employer || '',
    payMode: r.pay_mode === 'fixed' ? 'fixed' : 'hourly',
    fixedPay: Number(r.fixed_pay) || 0, tips: Number(r.tips) || 0,
    accountId: r.account_id || null, categoryId: r.category_id || null,
    txId: r.tx_id || null, jobId: r.job_id || null, note: r.note || '',
  };
}

const ShiftStore = {
  _key: 'pf_shifts',
  _mode: null,

  _local() { try { return JSON.parse(localStorage.getItem(this._key) || '[]'); } catch { return []; } },
  _persistLocal(list) { localStorage.setItem(this._key, JSON.stringify(list)); },

  /* default hourly rate — local convenience, pre-fills the form */
  getDefaultRate() { return Number(localStorage.getItem('pf_shift_rate')) || 0; },
  setDefaultRate(r) { localStorage.setItem('pf_shift_rate', String(Number(r) || 0)); },

  /* "Job defaults" — the default job/salary used by the dashboard quick-log.
     { employer, rate, accountId }. rate shares the pf_shift_rate key above so
     logging a shift on the tracker keeps it in sync. */
  getJobDefaults() {
    return {
      employer:  localStorage.getItem('pf_job_employer') || '',
      rate:      this.getDefaultRate(),
      accountId: localStorage.getItem('pf_job_account') || '',
    };
  },
  setJobDefaults({ employer, rate, accountId }) {
    if (employer !== undefined) {
      if (employer) localStorage.setItem('pf_job_employer', employer);
      else localStorage.removeItem('pf_job_employer');
    }
    if (rate !== undefined) this.setDefaultRate(rate);
    if (accountId !== undefined) {
      if (accountId) localStorage.setItem('pf_job_account', accountId);
      else localStorage.removeItem('pf_job_account');
    }
    /* sync cross-device — only the fields that were actually passed */
    const patch = {};
    if (employer  !== undefined) patch.employer  = employer  || '';
    if (rate      !== undefined) patch.rate      = Number(rate) || 0;
    if (accountId !== undefined) patch.accountId = accountId || '';
    if (Object.keys(patch).length) SettingsStore.setJobSettings(patch);
  },

  /* weekly goal — local convenience. { metric: 'pay'|'hours', target:number }.
     Drives the progress ring on the Hours Tracker. target 0 = no goal set. */
  _goalKey: 'pf_shift_goal',
  getGoal() {
    try {
      const g = JSON.parse(localStorage.getItem(this._goalKey) || '{}');
      return { metric: g.metric === 'hours' ? 'hours' : 'pay', target: Number(g.target) || 0 };
    } catch { return { metric: 'pay', target: 0 }; }
  },
  setGoal(goal) {
    const g = { metric: goal.metric === 'hours' ? 'hours' : 'pay', target: Math.max(0, Number(goal.target) || 0) };
    localStorage.setItem(this._goalKey, JSON.stringify(g));
    SettingsStore.setShiftGoal(g);          /* sync cross-device */
    return g;
  },

  /* shift presets (saved templates) — local convenience for fast logging.
     Preset: { id, name, employer, start, end, breakMin, payMode, rate,
               fixedPay, accountId, categoryId } */
  _presetKey: 'pf_shift_presets',
  getPresets() {
    try { return JSON.parse(localStorage.getItem(this._presetKey) || '[]'); }
    catch { return []; }
  },
  savePreset(preset) {
    const list = this.getPresets();
    if (preset.id) {
      const i = list.findIndex(p => p.id === preset.id);
      if (i >= 0) list[i] = preset; else list.push(preset);
    } else {
      preset.id = 'ps_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      list.push(preset);
    }
    localStorage.setItem(this._presetKey, JSON.stringify(list));
    SettingsStore.setShiftPresets(list);    /* sync cross-device */
    return preset;
  },
  removePreset(id) {
    const list = this.getPresets().filter(p => p.id !== id);
    localStorage.setItem(this._presetKey, JSON.stringify(list));
    SettingsStore.setShiftPresets(list);    /* sync cross-device */
  },

  async _detect() {
    if (this._mode) return this._mode;
    const { error } = await sb.from('shifts').select('id').limit(1);
    this._mode = error ? 'local' : 'table';
    if (this._mode === 'table') await this._migrate();
    return this._mode;
  },

  async _migrate() {
    try {
      const legacy = this._local();
      if (!legacy.length) return;
      const uid = await userId();
      if (!uid) return;
      const rows = legacy.map(s => ({ id: IS_UUID(s.id) ? s.id : newUUID(), user_id: uid, ...shiftToRow(s) }));
      const { error } = await sb.from('shifts').insert(rows);
      if (!error) this._persistLocal([]);
    } catch (_) { /* local data stays until the next successful load */ }
  },

  async getAll() {
    if (await this._detect() === 'local') {
      return this._local().slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    }
    const { data, error } = await sb.from('shifts').select('*').order('date', { ascending: false });
    if (error) throw new Error(error.message);
    return (data || []).map(shiftToCamel);
  },

  async getById(id) { return (await this.getAll()).find(s => s.id === id) || null; },

  async add(shift) {
    if (await this._detect() === 'local') {
      const list = this._local();
      shift.id = newUUID();
      list.push(shift);
      this._persistLocal(list);
      return shift;
    }
    const uid = await userId();
    const { data, error } = await sb.from('shifts').insert({ user_id: uid, ...shiftToRow(shift) }).select().single();
    if (error) throw new Error(error.message);
    return shiftToCamel(data);
  },

  async update(id, patch) {
    if (await this._detect() === 'local') {
      const list = this._local();
      const idx  = list.findIndex(s => s.id === id);
      if (idx === -1) return;
      list[idx] = { ...list[idx], ...patch };
      this._persistLocal(list);
      return list[idx];
    }
    const { data, error } = await sb.from('shifts').update(shiftToRow(patch)).eq('id', id).select().single();
    if (error) throw new Error(error.message);
    return shiftToCamel(data);
  },

  async remove(id) {
    if (await this._detect() === 'local') {
      this._persistLocal(this._local().filter(s => s.id !== id));
      return;
    }
    const { error } = await sb.from('shifts').delete().eq('id', id);
    if (error) throw new Error(error.message);
  },
};

/* ============================================================
   JOBS — named, reusable employers/roles with default rate + deposit
   account + income category. Replaces the per-device localStorage "job
   defaults" so the same jobs follow you across devices. Table-first
   (`jobs`) with a localStorage fallback + lazy migration, same pattern as
   ShiftStore. Shifts link to a job via jobId and keep the job's name in
   `employer` so the existing by-job analytics keep working.
   ============================================================ */
function jobToRow(j) {
  const row = {};
  if (j.name       !== undefined) row.name        = j.name || '';
  if (j.rate       !== undefined) row.rate        = Number(j.rate) || 0;
  if (j.accountId  !== undefined) row.account_id  = j.accountId  || null;
  if (j.categoryId !== undefined) row.category_id = j.categoryId || null;
  if (j.archived   !== undefined) row.archived    = !!j.archived;
  return row;
}
function jobToCamel(r) {
  return {
    id: r.id, name: r.name || '', rate: Number(r.rate) || 0,
    accountId: r.account_id || null, categoryId: r.category_id || null,
    archived: !!r.archived,
  };
}

const JobStore = {
  _key: 'pf_jobs',
  _mode: null,

  _local() { try { return JSON.parse(localStorage.getItem(this._key) || '[]'); } catch { return []; } },
  _persistLocal(list) { localStorage.setItem(this._key, JSON.stringify(list)); },

  /* The default job (set in Settings) — what the quick-logs log against.
     Stored as a job id; '' = none chosen. */
  getDefaultId() { return localStorage.getItem('pf_default_job') || ''; },
  setDefaultId(id) {
    if (id) localStorage.setItem('pf_default_job', id);
    else localStorage.removeItem('pf_default_job');
    SettingsStore.setJobSettings({ defaultJobId: id || '' });   /* sync cross-device */
  },

  async _detect() {
    if (this._mode) return this._mode;
    const { error } = await sb.from('jobs').select('id').limit(1);
    this._mode = error ? 'local' : 'table';
    if (this._mode === 'table') await this._migrate();
    return this._mode;
  },

  async _migrate() {
    try {
      const legacy = this._local();
      if (!legacy.length) return;
      const uid = await userId();
      if (!uid) return;
      const rows = legacy.map(j => ({ id: IS_UUID(j.id) ? j.id : newUUID(), user_id: uid, ...jobToRow(j) }));
      const { error } = await sb.from('jobs').insert(rows);
      if (!error) this._persistLocal([]);
    } catch (_) { /* local data stays until the next successful load */ }
  },

  async getAll() {
    if (await this._detect() === 'local') {
      return this._local().filter(j => !j.archived)
        .slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    }
    const { data, error } = await sb.from('jobs').select('*').eq('archived', false).order('name');
    if (error) throw new Error(error.message);
    return (data || []).map(jobToCamel);
  },

  async getById(id) { return (await this.getAll()).find(j => j.id === id) || null; },

  async add(job) {
    if (await this._detect() === 'local') {
      const list = this._local();
      job.id = newUUID();
      job.archived = !!job.archived;
      list.push(job);
      this._persistLocal(list);
      return job;
    }
    const uid = await userId();
    const { data, error } = await sb.from('jobs').insert({ user_id: uid, ...jobToRow(job) }).select().single();
    if (error) throw new Error(error.message);
    return jobToCamel(data);
  },

  async update(id, patch) {
    if (await this._detect() === 'local') {
      const list = this._local();
      const idx  = list.findIndex(j => j.id === id);
      if (idx === -1) return;
      list[idx] = { ...list[idx], ...patch };
      this._persistLocal(list);
      return list[idx];
    }
    const { data, error } = await sb.from('jobs').update(jobToRow(patch)).eq('id', id).select().single();
    if (error) throw new Error(error.message);
    return jobToCamel(data);
  },

  async remove(id) {
    if (await this._detect() === 'local') {
      this._persistLocal(this._local().filter(j => j.id !== id));
      return;
    }
    const { error } = await sb.from('jobs').delete().eq('id', id);
    if (error) throw new Error(error.message);
  },

  /* One-time seed: if there are no jobs yet, create one per distinct job name
     already on the user's shifts (carrying the saved default rate + account),
     so existing data maps onto jobs without manual re-entry. */
  async seedFromShifts(shifts) {
    const existing = await this.getAll();
    if (existing.length) return existing;
    const names = [...new Set((shifts || []).map(s => (s.employer || '').trim()).filter(Boolean))];
    if (!names.length) return existing;
    const rate = ShiftStore.getDefaultRate() || 0;
    const accountId = ShiftStore.getJobDefaults().accountId || null;
    for (const name of names) {
      try { await this.add({ name, rate, accountId, categoryId: null }); } catch (_) {}
    }
    return this.getAll();
  },
};

/* ============================================================
   PAYOUTS — weekly "marked as paid" cash events.
   Each payout settles a set of shifts: it records the estimated total
   (hours × rate), the actual cash received, and the difference (the boss's
   rounding-up bonus). A shift is "paid" when some payout's shiftIds include
   it. Table-first (`shift_payouts`) with a localStorage fallback + lazy
   migration, same pattern as ShiftStore/SubscriptionStore.
   ============================================================ */
function payoutToRow(p) {
  const row = {};
  if (p.date      !== undefined) row.date       = p.date;
  if (p.hours     !== undefined) row.hours      = Number(p.hours) || 0;
  if (p.estimated !== undefined) row.estimated  = Number(p.estimated) || 0;
  if (p.actual    !== undefined) row.actual     = Number(p.actual) || 0;
  if (p.bonus     !== undefined) row.bonus      = Number(p.bonus) || 0;
  if (p.shiftIds  !== undefined) row.shift_ids  = Array.isArray(p.shiftIds) ? p.shiftIds : [];
  if (p.txId      !== undefined) row.tx_id      = p.txId || null;
  if (p.note      !== undefined) row.note       = p.note || '';
  return row;
}
function payoutToCamel(r) {
  return {
    id: r.id, date: r.date,
    hours: Number(r.hours) || 0, estimated: Number(r.estimated) || 0,
    actual: Number(r.actual) || 0, bonus: Number(r.bonus) || 0,
    shiftIds: Array.isArray(r.shift_ids) ? r.shift_ids : [],
    txId: r.tx_id || null, note: r.note || '',
  };
}

const PayoutStore = {
  _key: 'pf_payouts',
  _mode: null,

  _local() { try { return JSON.parse(localStorage.getItem(this._key) || '[]'); } catch { return []; } },
  _persistLocal(list) { localStorage.setItem(this._key, JSON.stringify(list)); },

  async _detect() {
    if (this._mode) return this._mode;
    const { error } = await sb.from('shift_payouts').select('id').limit(1);
    this._mode = error ? 'local' : 'table';
    if (this._mode === 'table') await this._migrate();
    return this._mode;
  },

  async _migrate() {
    try {
      const legacy = this._local();
      if (!legacy.length) return;
      const uid = await userId();
      if (!uid) return;
      const rows = legacy.map(p => ({ id: IS_UUID(p.id) ? p.id : newUUID(), user_id: uid, ...payoutToRow(p) }));
      const { error } = await sb.from('shift_payouts').insert(rows);
      if (!error) this._persistLocal([]);
    } catch (_) { /* local data stays until the next successful load */ }
  },

  async getAll() {
    if (await this._detect() === 'local') {
      return this._local().slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    }
    const { data, error } = await sb.from('shift_payouts').select('*').order('date', { ascending: false });
    if (error) throw new Error(error.message);
    return (data || []).map(payoutToCamel);
  },

  /* Set of shift ids already covered by a payout — drives the "unpaid" view. */
  async paidShiftIds() {
    const set = new Set();
    (await this.getAll()).forEach(p => (p.shiftIds || []).forEach(id => set.add(id)));
    return set;
  },

  async add(payout) {
    if (await this._detect() === 'local') {
      const list = this._local();
      payout.id = newUUID();
      list.push(payout);
      this._persistLocal(list);
      return payout;
    }
    const uid = await userId();
    const { data, error } = await sb.from('shift_payouts').insert({ user_id: uid, ...payoutToRow(payout) }).select().single();
    if (error) throw new Error(error.message);
    return payoutToCamel(data);
  },

  async update(id, patch) {
    if (await this._detect() === 'local') {
      const list = this._local();
      const i = list.findIndex(p => p.id === id);
      if (i >= 0) { list[i] = { ...list[i], ...patch }; this._persistLocal(list); }
      return;
    }
    const { error } = await sb.from('shift_payouts').update(payoutToRow(patch)).eq('id', id);
    if (error) throw new Error(error.message);
  },

  async remove(id) {
    if (await this._detect() === 'local') {
      this._persistLocal(this._local().filter(p => p.id !== id));
      return;
    }
    const { error } = await sb.from('shift_payouts').delete().eq('id', id);
    if (error) throw new Error(error.message);
  },
};

/* ============================================================
   FORMAT HELPERS
   ============================================================ */
const CURRENCY_LOCALES = {
  USD: 'en-US', EUR: 'de-DE', GBP: 'en-GB', JPY: 'ja-JP',
  CAD: 'en-CA', AUD: 'en-AU', CHF: 'de-CH', INR: 'en-IN',
  BRL: 'pt-BR', MXN: 'es-MX',
};

function escapeHTML(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function formatCurrency(amount) {
  const currency = localStorage.getItem('pf_currency') || 'CAD';
  const locale   = CURRENCY_LOCALES[currency] || 'en-CA';
  return new Intl.NumberFormat(locale, {
    style: 'currency', currency, minimumFractionDigits: currency === 'JPY' ? 0 : 2,
  }).format(Math.abs(amount));
}

function formatDate(isoDate) {
  if (!isoDate) return '';
  return new Date(isoDate + 'T00:00:00').toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

function formatDateShort(isoDate) {
  if (!isoDate) return '';
  return new Date(isoDate + 'T00:00:00').toLocaleDateString('en-US', {
    month: 'short', day: 'numeric',
  });
}

function showToast(message, type = '') {
  const container = document.getElementById('toastContainer') || (() => {
    const el = document.createElement('div');
    el.id = 'toastContainer';
    el.className = 'toast-container';
    document.body.appendChild(el);
    return el;
  })();
  const toast = document.createElement('div');
  toast.className = `toast${type ? ' toast--' + type : ''}`;
  toast.textContent = message;
  toast.style.cursor = 'pointer';
  container.appendChild(toast);

  const dismiss = () => {
    if (toast.classList.contains('toast--dismissing')) return;
    toast.classList.add('toast--dismissing');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
  };
  toast.addEventListener('click', dismiss);
  setTimeout(dismiss, 3200);
}

/* ============================================================
   CSV SERVICE — export / import transactions
   ============================================================ */
const CSVService = {
  HEADERS: ['date','type','amount','note','category','account','to_account','tags'],

  /* Export to CSV. Pass `subset` (e.g. the current filtered view) to export
     just those; omit to export every transaction. */
  async export(subset = null) {
    const [txs, accounts, cats] = await Promise.all([
      subset ? Promise.resolve(subset) : TransactionStore.getAll(),
      AccountStore.getAll(),
      CategoryStore.getAll(),
    ]);
    const accMap = Object.fromEntries(accounts.map(a => [a.id, a.name]));
    const catMap = Object.fromEntries(cats.map(c => [c.id, c.name]));

    const escape = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = txs.map(t => [
      t.date,
      t.type,
      t.amount,
      escape(t.note),
      escape(catMap[t.categoryId] || t.categoryId || ''),
      escape(accMap[t.accountId]  || t.accountId  || ''),
      escape(accMap[t.toAccountId] || ''),
      escape((t.tags || []).join(';')),
    ].join(','));

    const csv = [this.HEADERS.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `transactions-${todayISO()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  },

  /* RFC-4180-ish CSV tokenizer: handles quoted fields containing commas,
     escaped quotes ("") and embedded newlines. Returns an array of rows,
     each an array of cell strings. (The old line-split + regex broke on any
     note that contained a comma or a line break.) */
  _parse(text, delim = ',') {
    const rows = [];
    let row = [], field = '', inQuotes = false;
    const pushField = () => { row.push(field); field = ''; };
    const pushRow = () => { if (row.length > 1 || row[0] !== '') rows.push(row); row = []; };
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
        else field += c;
      } else if (c === '"') { inQuotes = true; }
      else if (c === delim) { pushField(); }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        pushField(); pushRow();
      } else field += c;
    }
    if (field !== '' || row.length) { pushField(); pushRow(); }
    return rows;
  },

  /* ---- Bank / generic CSV import helpers (pure, testable) ------------------
     A real bank statement rarely matches our own export headers, so the import
     wizard parses arbitrary CSVs: auto-detect columns, parse messy amounts and
     dates, and infer income/expense from sign. These helpers stay DOM- and
     network-free; the wizard (scripts/pages/import.js) drives them. */

  /* Split a CSV file's text into { header:[], rows:[[]] }. */
  splitRows(text) {
    const records = this._parse(text);
    if (!records.length) return { header: [], rows: [] };
    return { header: records[0].map(h => (h || '').trim()), rows: records.slice(1) };
  },

  /* Parse a money cell into a signed Number. Handles "$1,234.56", "(4.50)"
     (accounting negative), a trailing minus "4.50-", and EU "1.234,56".
     Returns NaN when there's no number. */
  parseAmount(raw) {
    if (raw == null) return NaN;
    let s = String(raw).trim();
    if (!s) return NaN;
    let neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }   /* (4.50) → −4.50 */
    if (/-\s*$/.test(s)) neg = true;                              /* "4.50-"        */
    if (/^\s*-/.test(s)) neg = true;
    s = s.replace(/[^0-9.,]/g, '');                              /* drop symbols/spaces/signs */
    if (!s) return NaN;
    const hasComma = s.indexOf(',') > -1, hasDot = s.indexOf('.') > -1;
    if (hasComma && hasDot) {
      /* whichever separator is last is the decimal one */
      s = s.lastIndexOf(',') > s.lastIndexOf('.')
        ? s.replace(/\./g, '').replace(',', '.')   /* 1.234,56 → 1234.56 */
        : s.replace(/,/g, '');                      /* 1,234.56 → 1234.56 */
    } else if (hasComma) {
      s = /,\d{2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, '');
    }
    const n = parseFloat(s);
    if (isNaN(n)) return NaN;
    return neg ? -n : n;
  },

  /* Parse a date cell into an ISO "YYYY-MM-DD" string, or '' if unparseable.
     `dayFirst`: how to read ambiguous numeric dates (e.g. 03/04/2026) —
     true → DD/MM, false → MM/DD. Unambiguous dates (a part > 12, or ISO,
     or a named month) ignore the hint. */
  parseDate(raw, dayFirst = false) {
    if (!raw) return '';
    const s = String(raw).trim();
    const pad = n => String(n).padStart(2, '0');
    let m;
    /* ISO-ish: YYYY-MM-DD / YYYY/MM/DD */
    if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) {
      return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
    }
    /* compact YYYYMMDD (OFX, BMO) — optional time suffix "120000[-5:EST]" */
    if ((m = s.match(/^(\d{4})(\d{2})(\d{2})(?:\d{6}|$|[\s.[])/))) {
      const mm = +m[2], dd = +m[3];
      if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return '';
      return `${m[1]}-${m[2]}-${m[3]}`;
    }
    /* numeric D/M/Y or M/D/Y (2- or 4-digit year) */
    if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/))) {
      let a = +m[1], b = +m[2];
      const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
      let mm, dd;
      if (a > 12)      { dd = a; mm = b; }      /* first part can't be a month */
      else if (b > 12) { mm = a; dd = b; }      /* second part can't be a month */
      else             { if (dayFirst) { dd = a; mm = b; } else { mm = a; dd = b; } }
      if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return '';
      return `${y}-${pad(mm)}-${pad(dd)}`;
    }
    /* named month, e.g. "01 Jan 2026" / "Jan 1, 2026" */
    const d = new Date(s);
    if (!isNaN(d.getTime())) return isoLocal(d);
    return '';
  },

  /* Guess which columns hold what, from the header row. Returns 0-based
     indexes (−1 when absent) plus a `mode`:
       'debitcredit' — separate money-out / money-in columns
       'signed'      — one amount column (sign = direction)
       'typed'       — our own export (explicit `type` column) */
  autoDetect(header) {
    const h = header.map(x => String(x).toLowerCase().trim());
    const find = (...keys) => {
      for (const k of keys) { const i = h.findIndex(c => c.includes(k)); if (i >= 0) return i; }
      return -1;
    };
    const dateIdx   = find('date', 'posted', 'time');
    /* payee/name before memo: Tangerine's "Name" is the merchant, "Memo" is noise */
    const descIdx   = find('description', 'details', 'narrative', 'payee', 'merchant', 'name', 'memo', 'reference', 'note', 'transaction');
    const debitIdx  = find('debit', 'withdrawal', 'money out', 'paid out', 'outflow', 'spent');
    const creditIdx = find('credit', 'deposit', 'money in', 'paid in', 'inflow', 'received');
    const amountIdx = find('amount', 'value', 'cad$', 'cad');
    /* exact names only — "Account Type" (RBC) holds "Chequing", not a direction */
    const typeIdx   = h.findIndex(c => c === 'type' || c === 'transaction type');
    let mode = 'signed';
    if (typeIdx >= 0 && amountIdx >= 0)          mode = 'typed';
    else if (debitIdx >= 0 || creditIdx >= 0)    mode = 'debitcredit';
    return { dateIdx, descIdx, desc2Idx: -1, amountIdx, debitIdx, creditIdx, typeIdx, mode };
  },

  /* Strict "is this cell a date?" — regex only. new Date() is far too lenient
     (Chrome parses "Coffee 12" as a date), so content sniffing can't use it. */
  _looksLikeDate(raw) {
    const s = String(raw || '').trim();
    return /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(s)
      || /^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}$/.test(s)
      || /^\d{8}(\d{6})?(\[.*\])?$/.test(s)
      || /^\d{1,2}[ -][A-Za-z]{3,9}\.?[ -,]+\d{2,4}$/.test(s)
      || /^[A-Za-z]{3,9}\.? \d{1,2},? \d{4}$/.test(s);
  },

  _looksLikeAmount(raw) {
    const s = String(raw || '').trim();
    if (!s || this._looksLikeDate(s)) return false;
    return /^[-+(]?\s*(?:[A-Z]{0,3}\$|[€£])?\s*-?\d[\d,\s]*(?:[.,]\d+)?\s*\)?-?$/.test(s);
  },

  /* Separator sniffing: French-locale exports often use ";" (with "," as the
     decimal mark) and some tools emit tabs. Counts on the first line only. */
  detectDelimiter(text) {
    const first = String(text || '').split(/\r?\n/).find(l => l.trim()) || '';
    const count = ch => first.split(ch).length - 1;
    const best = [',', ';', '\t'].map(d => [d, count(d)]).sort((a, b) => b[1] - a[1])[0];
    return best[1] > 0 ? best[0] : ',';
  },

  /* Ambiguous numeric dates (03/04/2026): read the whole column — one value
     whose first part is > 12 proves day-first, second part > 12 proves month-first. */
  guessDayFirst(values) {
    for (const v of values) {
      const m = String(v || '').trim().match(/^(\d{1,2})[-/.](\d{1,2})[-/.]\d{2,4}/);
      if (!m) continue;
      if (+m[1] > 12) return true;
      if (+m[2] > 12) return false;
    }
    return false;
  },

  /* Single-amount statements disagree on sign: bank accounts show spending as
     negative, most credit cards as positive. Spending outnumbers income on
     nearly every statement, so whichever sign dominates is "expense". */
  guessExpensesPositive(values) {
    let pos = 0, neg = 0;
    for (const v of values) {
      const n = this.parseAmount(v);
      if (isNaN(n) || n === 0) continue;
      if (n > 0) pos++; else neg++;
    }
    return pos > neg * 1.5;
  },

  /* Index of the header row, skipping preamble lines (BMO prefixes the CSV
     with "Following data is valid as of…"). −1 when the file has no header
     at all (TD, CIBC and Scotiabank export bare data rows). */
  findHeaderRow(records) {
    const isData = row => row.some(c => this._looksLikeDate(c)) && row.some(c => this._looksLikeAmount(c));
    if (!records.length || isData(records[0])) return -1;
    for (let i = 0; i < Math.min(records.length, 15); i++) {
      const row = records[i];
      if (isData(row)) break;
      const d = this.autoDetect(row);
      if (d.dateIdx >= 0 && (d.amountIdx >= 0 || d.debitIdx >= 0 || d.creditIdx >= 0)) return i;
    }
    return 0;
  },

  /* Column roles for a header-less file, read from the cells themselves.
     A balance column is filled on every row; debit/credit columns take turns
     (one is blank on each row) — that's how the two layouts are told apart. */
  inferColumns(rows) {
    const sample = rows.slice(0, 60);
    const n = sample.length;
    const width = Math.max(0, ...sample.map(r => r.length));
    const stats = [];
    for (let j = 0; j < width; j++) {
      let filled = 0, dates = 0, amts = 0, neg = 0, len = 0;
      const has = [];
      sample.forEach((r, ri) => {
        const v = String(r[j] || '').trim();
        if (!v) return;
        filled++; has.push(ri); len += v.length;
        if (this._looksLikeDate(v)) dates++;
        else if (this._looksLikeAmount(v)) { amts++; if (this.parseAmount(v) < 0) neg++; }
      });
      stats.push({ j, filled, dates, amts, neg, avgLen: filled ? len / filled : 0, rows: new Set(has) });
    }
    const out = { dateIdx: -1, descIdx: -1, desc2Idx: -1, amountIdx: -1, debitIdx: -1, creditIdx: -1, typeIdx: -1, mode: 'signed' };
    if (!n) return out;

    const dateCol = stats.filter(s => s.filled >= n * 0.8 && s.dates >= s.filled * 0.8)[0];
    if (dateCol) out.dateIdx = dateCol.j;
    const numeric = stats.filter(s => s.j !== out.dateIdx && s.filled && s.amts >= s.filled * 0.8);
    const text = stats.filter(s => s.j !== out.dateIdx && s.filled && !numeric.includes(s))
      .sort((a, b) => b.avgLen - a.avgLen);
    if (text[0]) out.descIdx = text[0].j;

    /* any two columns that never share a row (a full debit column on a card
       statement plus a sparse payments column still counts) */
    let pair = null;
    for (let a = 0; a < numeric.length && !pair; a++) {
      for (let b = a + 1; b < numeric.length && !pair; b++) {
        let both = 0;
        numeric[a].rows.forEach(ri => { if (numeric[b].rows.has(ri)) both++; });
        if (both <= n * 0.05 && Math.min(numeric[a].filled, numeric[b].filled) < n * 0.95 && numeric[a].filled + numeric[b].filled >= n * 0.8) pair = [numeric[a], numeric[b]];
      }
    }
    if (pair) {
      out.mode = 'debitcredit';
      out.debitIdx = pair[0].j;     /* Canadian banks list money-out first */
      out.creditIdx = pair[1].j;
    } else {
      const full = numeric.filter(s => s.filled >= n * 0.95);
      const signed = full.find(s => s.neg > 0) || full[0] || numeric[0];
      if (signed) out.amountIdx = signed.j;
    }
    return out;
  },

  /* Known exports whose headers the generic matcher reads wrong. Returns
     { bank, map } or null. Signatures are header-based only; header-less
     exports fall through to inferColumns. */
  detectBank(header) {
    const h = header.map(x => String(x).toLowerCase().trim());
    const at = name => h.indexOf(name);
    const base = { dateIdx: -1, descIdx: -1, desc2Idx: -1, amountIdx: -1, debitIdx: -1, creditIdx: -1, typeIdx: -1, mode: 'signed' };
    if (at('cad$') >= 0 && at('description 1') >= 0) {
      return { bank: 'RBC', map: { ...base, dateIdx: at('transaction date'), descIdx: at('description 1'),
        desc2Idx: at('description 2'), amountIdx: at('cad$') } };
    }
    if (at('date posted') >= 0 && at('transaction amount') >= 0) {
      return { bank: 'BMO', map: { ...base, dateIdx: at('date posted'), descIdx: at('description'),
        amountIdx: at('transaction amount') } };
    }
    if (at('transaction date') >= 0 && at('name') >= 0 && at('memo') >= 0 && at('amount') >= 0) {
      return { bank: 'Tangerine', map: { ...base, dateIdx: at('transaction date'), descIdx: at('name'),
        amountIdx: at('amount') } };
    }
    return null;
  },

  /* One call from raw text to { header, rows, headerless, bank, detect }. */
  analyze(text) {
    const delim = this.detectDelimiter(text);
    const records = this._parse(String(text || '').replace(/^﻿/, ''), delim)
      .filter(r => r.some(c => String(c || '').trim()));
    if (!records.length) return { header: [], rows: [], headerless: false, bank: null, detect: null };
    const hi = this.findHeaderRow(records);
    if (hi < 0) {
      const width = Math.max(...records.slice(0, 60).map(r => r.length));
      return {
        header: Array.from({ length: width }, (_, i) => `Column ${i + 1}`),
        rows: records, headerless: true, bank: null, detect: this.inferColumns(records),
      };
    }
    const header = records[hi].map(x => String(x || '').trim());
    const rows = records.slice(hi + 1);
    const known = this.detectBank(header);
    return { header, rows, headerless: false, bank: known ? known.bank : null,
             detect: known ? known.map : this.autoDetect(header) };
  },

  /* Apply a column mapping to raw rows → [{ date, note, amount, type, ok }].
     amount is always positive; direction lives in `type`. */
  mapRows(rows, m) {
    const cell = (row, i) => (i >= 0 && i < row.length ? String(row[i] || '').trim() : '');
    return rows.map(row => {
      const note = [cell(row, m.descIdx), cell(row, m.desc2Idx)].filter(Boolean).join(' · ');
      const date = this.parseDate(cell(row, m.dateIdx), !!m.dayFirst);
      let amount = NaN, type = 'expense';
      if (m.mode === 'debitcredit') {
        const deb = this.parseAmount(cell(row, m.debitIdx));
        const cre = this.parseAmount(cell(row, m.creditIdx));
        if (!isNaN(deb) && deb !== 0)      { amount = Math.abs(deb); type = 'expense'; }
        else if (!isNaN(cre) && cre !== 0) { amount = Math.abs(cre); type = 'income'; }
      } else {
        const explicit = cell(row, m.typeIdx).toLowerCase();
        const n = this.parseAmount(cell(row, m.amountIdx));
        if (!isNaN(n)) {
          amount = Math.abs(n);
          if (['income', 'expense', 'transfer'].includes(explicit)) type = explicit;
          else if (explicit === 'debit' || explicit === 'dr')  type = 'expense';
          else if (explicit === 'credit' || explicit === 'cr') type = 'income';
          else type = m.expensesPositive ? (n > 0 ? 'expense' : 'income') : (n < 0 ? 'expense' : 'income');
        }
      }
      return { date, note, amount, type, ok: !!date && !isNaN(amount) && amount > 0 };
    });
  },

  /* OFX / QFX / QBO (the "Quicken" / "Money" download every Canadian bank
     offers). Handles SGML OFX 1.x (unclosed tags) and XML OFX 2.x alike.
     Returns [{ date, note, amount (signed), fitid }]. */
  parseOFX(text) {
    const decode = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&apos;|&#39;/g, "'").replace(/&amp;/g, '&');
    const out = [];
    const blocks = String(text || '').match(/<STMTTRN>[\s\S]*?(?=<\/STMTTRN>|<STMTTRN>|<\/BANKTRANLIST>|$)/gi) || [];
    for (const b of blocks) {
      const tag = t => { const m = b.match(new RegExp(`<${t}>([^<\\r\\n]*)`, 'i')); return m ? decode(m[1].trim()) : ''; };
      const amount = this.parseAmount(tag('TRNAMT'));
      const date = this.parseDate(tag('DTPOSTED') || tag('DTUSER'));
      const name = tag('NAME'), memo = tag('MEMO');
      const note = memo && !name.toLowerCase().includes(memo.toLowerCase())
        ? [name, memo].filter(Boolean).join(' · ') : (name || memo);
      if (!date || isNaN(amount)) continue;
      out.push({ date, note, amount, fitid: tag('FITID') });
    }
    return out;
  },

  /* Flag rows that already exist in the target account, so a re-import or a
     switch from manual logging doesn't double-count. Two passes:
       'exact'  — same date, amount and description (a re-imported file)
       'likely' — same direction and amount within ±windowDays, whatever the
                  description (you typed "coffee", the bank says "STARBUCKS #12")
     Each existing transaction can only absorb ONE imported row, so two real
     identical coffees on the same day don't both vanish. A transfer counts as
     money out of its source account and money into its destination.
     Mutates and returns rows, setting r.dup ('exact'|'likely'|null) + r.match. */
  markDuplicates(rows, existing, accountId, { windowDays = 3 } = {}) {
    const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const cents = a => Math.round(Number(a) * 100);
    const dayNum = iso => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000;
    const fits = (r, t) => t.type === 'transfer'
      ? (r.type === 'expense' && t.accountId === accountId) || (r.type === 'income' && t.toAccountId === accountId)
      : t.accountId === accountId && t.type === r.type;
    const pool = (existing || []).filter(t => t && t.date && (t.accountId === accountId || t.toAccountId === accountId));
    const used = new Set();
    rows.forEach(r => { r.dup = null; r.match = null; });

    rows.forEach(r => {
      if (!r.ok) return;
      const hit = pool.find(t => !used.has(t) && t.date === r.date && cents(t.amount) === cents(r.amount)
        && norm(t.note) === norm(r.note) && fits(r, t));
      if (hit) { used.add(hit); r.dup = 'exact'; r.match = hit; }
    });
    rows.forEach(r => {
      if (!r.ok || r.dup) return;
      const d = dayNum(r.date);
      let best = null, gap = Infinity;
      for (const t of pool) {
        if (used.has(t) || cents(t.amount) !== cents(r.amount) || !fits(r, t)) continue;
        const g = Math.abs(dayNum(t.date) - d);
        if (g <= windowDays && g < gap) { best = t; gap = g; }
      }
      if (best) { used.add(best); r.dup = 'likely'; r.match = best; }
    });
    return rows;
  },

  /* Cold-start category guess from well-known (mostly Canadian) merchant names,
     for when the user's own history has nothing to go on yet. Returns a
     default-category id or null. Word-boundary matches, so "shell" never
     fires on "shellfish". Order matters: "uber eats" before "uber". */
  MERCHANT_RULES: [
    ['cat-food',      ['taco bell', 'uber eats', 'ubereats', 'doordash', 'skip the dishes', 'skipthedishes', 'tim hortons', 'tims', 'starbucks', 'mcdonald', 'mcdonalds', 'a&w', 'subway', 'second cup', 'pizza', 'restaurant', 'resto', 'cafe', 'café', 'bistro', 'sushi', 'burger', 'harvey', 'harveys', 'st-hubert', 'boston pizza', 'chipotle', 'poutine']],
    ['cat-groceries', ['loblaws', 'no frills', 'nofrills', 'sobeys', 'metro', 'iga', 'maxi', 'provigo', 'superstore', 'real canadian superstore', 'food basics', 'freshco', 'safeway', 'save on foods', 'save-on-foods', 'farm boy', 'longos', 'super c', 'adonis', 'grocery', 'epicerie', 'épicerie', 'zehrs', 'fortinos', 'foodland', 't&t']],
    ['cat-transport', ['petro-canada', 'petro canada', 'esso', 'shell', 'ultramar', 'husky', 'irving', 'pioneer', 'uber', 'lyft', 'presto', 'ttc', 'stm', 'opus', 'go transit', 'via rail', 'translink', 'compass', 'parking', 'impark', 'indigo park', 'stationnement', 'gas station']],
    ['cat-subs',      ['netflix', 'spotify', 'disney plus', 'disney+', 'crave', 'prime video', 'amazon prime', 'apple.com/bill', 'youtube premium', 'youtubepremium', 'icloud', 'patreon', 'chatgpt', 'openai', 'adobe', 'microsoft 365', 'xbox game pass', 'playstation plus']],
    ['cat-bills',     ['hydro', 'hydro-quebec', 'hydro quebec', 'hydro one', 'bc hydro', 'enbridge', 'fortis', 'epcor', 'bell', 'rogers', 'videotron', 'vidéotron', 'telus', 'fido', 'koodo', 'virgin plus', 'freedom mobile', 'public mobile', 'fizz', 'cogeco', 'shaw', 'eastlink']],
    ['cat-health',    ['shoppers drug', 'shoppers drug mart', 'pharmaprix', 'jean coutu', 'uniprix', 'familiprix', 'rexall', 'london drugs', 'pharmacy', 'pharmacie', 'dentist', 'dentaire', 'clinic', 'clinique', 'physio']],
    ['cat-fitness',   ['goodlife', 'ymca', 'econofitness', 'planet fitness', 'anytime fitness', 'gym', 'sport chek', 'sportchek', 'decathlon']],
    ['cat-entertain', ['cineplex', 'steam', 'steamgames', 'playstation', 'nintendo', 'xbox', 'ticketmaster', 'eventbrite', 'cinema', 'cinéma']],
    ['cat-travel',    ['air canada', 'westjet', 'porter', 'flair', 'airbnb', 'expedia', 'booking.com', 'hotel', 'marriott', 'hilton']],
    ['cat-pets',      ['petsmart', 'pet valu', 'mondou', 'veterinary', 'vet clinic', 'veterinaire', 'vétérinaire']],
    ['cat-shopping',  ['amazon', 'amzn', 'canadian tire', 'best buy', 'ikea', 'walmart', 'costco', 'winners', 'homesense', 'marshalls', 'simons', 'dollarama', 'staples', 'bureau en gros', 'the bay', 'hudson', 'sephora', 'uniqlo', 'h&m', 'zara', 'apple store', 'home depot', 'rona', 'lowes']],
    ['cat-insurance', ['insurance', 'assurance', 'intact', 'desjardins assurance', 'belairdirect', 'td insurance', 'sun life', 'manulife', 'canada life']],
    ['cat-taxes',     ['cra', 'canada revenue', 'revenu quebec', 'revenu québec', 'property tax', 'taxes municipales']],
    ['cat-education', ['tuition', 'university', 'universite', 'université', 'college', 'cégep', 'cegep', 'coursera', 'udemy']],
    ['cat-salary',    ['payroll', 'salary', 'salaire', 'paie', 'direct deposit pay', 'pay ']],
    ['cat-refund',    ['refund', 'remboursement', 'reversal']],
  ],

  guessCategory(note, type) {
    const s = ' ' + String(note || '').toLowerCase().replace(/[^\p{L}\p{N}&+./\- ]/gu, ' ').replace(/\s+/g, ' ') + ' ';
    if (!s.trim()) return null;
    const esc = k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const [id, keys] of this.MERCHANT_RULES) {
      const income = id === 'cat-salary' || id === 'cat-refund';
      if (type && (type === 'income') !== income) continue;
      for (const k of keys) {
        const word = k.trimEnd();
        if (new RegExp(`(^|[^\\p{L}\\p{N}])${esc(word)}([^\\p{L}\\p{N}]|$)`, 'u').test(s)) return id;
      }
    }
    return null;
  },

  async import(file) {
    const text = await file.text();
    const records = this._parse(text);
    if (records.length < 2) throw new Error('CSV is empty or has no data rows');

    const header = records[0].map(h => h.toLowerCase().trim());
    const idx = k => header.indexOf(k);

    const [accounts, cats] = await Promise.all([
      AccountStore.getAll(),
      CategoryStore.getAll(),
    ]);
    const accByName = Object.fromEntries(accounts.map(a => [a.name.toLowerCase(), a.id]));
    const catByName = Object.fromEntries(cats.map(c => [c.name.toLowerCase(), c.id]));

    let imported = 0, skipped = 0;
    for (const cells0 of records.slice(1)) {
      try {
        const cells = cells0.map(c => (c || '').trim());
        const type   = cells[idx('type')]?.toLowerCase();
        const amount = parseFloat(cells[idx('amount')]);
        if (!['income','expense','transfer'].includes(type) || !amount || amount <= 0) { skipped++; continue; }

        const catName  = cells[idx('category')]?.toLowerCase();
        const accName  = cells[idx('account')]?.toLowerCase();
        const toName   = cells[idx('to_account')]?.toLowerCase();
        const tagsRaw  = cells[idx('tags')] || '';

        await TransactionStore.add({
          date:        cells[idx("date")] || todayISO(),
          type,
          amount,
          note:        cells[idx('note')] || '',
          categoryId:  catByName[catName] || null,
          accountId:   accByName[accName] || accounts[0]?.id || null,
          toAccountId: accByName[toName]  || null,
          tags:        tagsRaw ? tagsRaw.split(';').map(t => t.trim()).filter(Boolean) : [],
        });
        imported++;
      } catch { skipped++; }
    }
    return { imported, skipped };
  },
};

/* Export for Node-based unit tests. Harmless in the browser, where there is
   no `module` and these stay globals. Only the pure, DOM/Supabase-free pieces
   are exposed (the CSV tokenizer + formatters); the store methods need a live
   Supabase client and aren't unit-testable here. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CSVService, isoLocal, formatCurrency, formatDate, formatDateShort };
}
