/* ============================================================
   supabase.js — Supabase client + auth helpers + guest mode
   Must be loaded after the Supabase CDN script

   Guest mode: the app works without an account. While signed out,
   every `sb.from(table)` query runs against a small local stand-in
   (GuestDB, in localStorage) that speaks the same query-builder
   dialect the stores use. The decision is made when the query is
   awaited, so store.js / crypto.js / the pages don't change.
   When the visitor signs in or creates an account, the guest rows
   are copied into their account (ensureMigrated) BEFORE any remote
   query runs, and only cleared locally once the server accepted them.
   ============================================================ */

const SUPABASE_URL = 'https://grttprtovyzmlaicowsv.supabase.co';
const SUPABASE_KEY = 'sb_publishable_igJ6qp6In8SlzseId0S3yA_oTDZjeJS';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

/* Stable, UUID-shaped owner id for guest rows (rewritten on migration). */
const GUEST_ID = '00000000-0000-0000-0000-000000000000';

/* ============================================================
   GUEST DB — one localStorage key per table
   ============================================================ */
const GuestDB = {
  PREFIX: 'pf_guest_',

  /* Tables, in foreign-key order (parents first) — the migration order. */
  TABLES: ['accounts', 'jobs', 'transactions', 'subscriptions', 'crypto_wallets', 'shifts', 'shift_payouts'],

  /* Column defaults the real schema would fill in (supabase-schema.sql). */
  DEFAULTS: {
    accounts:       { type: 'bank', initial_balance: 0, color: '#6366f1' },
    transactions:   { note: '', tags: [] },
    subscriptions:  { frequency: 'monthly', auto_log: true, active: true },
    crypto_wallets: { label: 'Wallet', addresses: [] },
    shifts:         { hours: 0, start_time: '', end_time: '', break_min: 0, rate: 0, pay_mode: 'hourly',
                      fixed_pay: 0, tips: 0, employer: '', note: '' },
    shift_payouts:  { hours: 0, estimated: 0, actual: 0, bonus: 0, shift_ids: [], note: '' },
    jobs:           { name: '', rate: 0, archived: false },
    user_settings:  { currency: 'CAD', budgets: {}, custom_categories: [], subscriptions: [] },
  },

  /* `on delete set null` foreign keys: parent table → [child table, column] */
  SET_NULL: {
    accounts:     [['transactions', 'account_id'], ['transactions', 'to_account_id'], ['subscriptions', 'account_id'],
                   ['shifts', 'account_id'], ['jobs', 'account_id']],
    transactions: [['shifts', 'tx_id'], ['shift_payouts', 'tx_id']],
    jobs:         [['shifts', 'job_id']],
  },

  /* tables keyed by something other than `id` */
  KEY: { user_settings: 'user_id' },

  read(table) {
    try { const v = JSON.parse(localStorage.getItem(this.PREFIX + table) || '[]'); return Array.isArray(v) ? v : []; }
    catch { return []; }
  },
  write(table, rows) {
    if (rows.length) localStorage.setItem(this.PREFIX + table, JSON.stringify(rows));   /* may throw on quota */
    else localStorage.removeItem(this.PREFIX + table);
  },

  /* Anything worth migrating? (sync, cheap — checked on every page load) */
  hasData() {
    return [...this.TABLES, 'user_settings'].some(t => this.read(t).length > 0);
  },

  uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  },

  _clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); },

  _newRow(table, input) {
    const row = { ...this._clone(this.DEFAULTS[table] || {}), ...this._clone(input) };
    if (table !== 'user_settings') {
      if (!row.id) row.id = this.uuid();
      if (!row.created_at) row.created_at = new Date().toISOString();
    }
    return row;
  },

  /* ---- filters ---- */
  _cmp(a, b) {
    if (a == null && b == null) return 0;
    if (a == null) return 1;           /* Postgres: NULLs sort last ascending */
    if (b == null) return -1;
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    if (typeof a === 'boolean' || typeof b === 'boolean') return Number(a) - Number(b);
    return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
  },

  _test(row, col, op, val) {
    const v = row[col];
    switch (op) {
      case 'eq':    return v === val || (v != null && val != null && String(v) === String(val));
      case 'neq':   return !(v === val || (v != null && val != null && String(v) === String(val)));
      case 'gt':    return v != null && this._cmp(v, val) > 0;
      case 'gte':   return v != null && this._cmp(v, val) >= 0;
      case 'lt':    return v != null && this._cmp(v, val) < 0;
      case 'lte':   return v != null && this._cmp(v, val) <= 0;
      case 'is':    return val === null || val === 'null' ? v == null : v === val;
      case 'in':    return (Array.isArray(val) ? val : []).map(String).includes(String(v));
      case 'like':
      case 'ilike': {
        const re = new RegExp('^' + String(val).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$',
          op === 'ilike' ? 'is' : 's');
        return v != null && re.test(String(v));
      }
      default: throw new Error(`Guest mode: unsupported filter "${op}"`);
    }
  },

  /* PostgREST `or` filter string, e.g. "account_id.eq.X,to_account_id.eq.X" */
  _parseOr(str) {
    return String(str).split(',').map(part => {
      const m = part.trim().match(/^([^.]+)\.([a-z]+)\.(.*)$/);
      if (!m) throw new Error(`Guest mode: can't parse filter "${part}"`);
      const val = m[3] === 'null' ? null : m[3] === 'true' ? true : m[3] === 'false' ? false : m[3];
      return row => this._test(row, m[1], m[2], val);
    });
  },

  /* ---- run a recorded query chain ---- */
  exec(table, ops) {
    try {
      return this._exec(table, ops);
    } catch (err) {
      return { data: null, error: { message: err.message || String(err), code: 'GUEST' }, count: null, status: 400 };
    }
  },

  _exec(table, ops) {
    let action = 'select', payload = null, opts = {}, returning = false;
    const filters = [], orders = [];
    let rangeFrom = null, rangeTo = null, limit = null, single = null;

    for (const [name, args] of ops) {
      switch (name) {
        case 'select':
          if (action === 'select') opts = args[1] || {};
          else returning = true;                     /* insert(...).select() */
          break;
        case 'insert': action = 'insert'; payload = args[0]; break;
        case 'upsert': action = 'upsert'; payload = args[0]; opts = args[1] || {}; break;
        case 'update': action = 'update'; payload = args[0]; break;
        case 'delete': action = 'delete'; break;
        case 'eq': case 'neq': case 'gt': case 'gte': case 'lt': case 'lte':
        case 'is': case 'in': case 'like': case 'ilike':
          filters.push(row => this._test(row, args[0], name, args[1])); break;
        case 'match':
          Object.entries(args[0] || {}).forEach(([c, v]) => filters.push(row => this._test(row, c, 'eq', v))); break;
        case 'or': {
          const alts = this._parseOr(args[0]);
          filters.push(row => alts.some(f => f(row)));
          break;
        }
        case 'order': orders.push({ col: args[0], asc: !(args[1] && args[1].ascending === false) }); break;
        case 'range': rangeFrom = args[0]; rangeTo = args[1]; break;
        case 'limit': limit = args[0]; break;
        case 'single': single = 'single'; break;
        case 'maybeSingle': single = 'maybe'; break;
        case 'abortSignal': case 'throwOnError': break;
        default: throw new Error(`Guest mode: unsupported query method "${name}"`);
      }
    }

    const all = this.read(table);
    const keep = row => filters.every(f => f(row));
    let out;

    if (action === 'select') {
      out = all.filter(keep);
      if (orders.length) {
        out = out.slice().sort((a, b) => {
          for (const o of orders) {
            const c = this._cmp(a[o.col], b[o.col]);
            if (c) return o.asc ? c : -c;
          }
          return 0;
        });
      }
      const count = out.length;
      if (rangeFrom != null) out = out.slice(rangeFrom, rangeTo + 1);
      if (limit != null) out = out.slice(0, limit);
      if (opts.head) return { data: null, error: null, count, status: 200 };
      return this._finish(out, single, true, opts.count ? count : null);
    }

    if (action === 'insert' || action === 'upsert') {
      const input = Array.isArray(payload) ? payload : [payload];
      const key = (opts.onConflict || this.KEY[table] || 'id').split(',')[0].trim();
      const next = all.slice();
      const written = [];
      for (const r of input) {
        const existingIdx = r[key] != null ? next.findIndex(x => String(x[key]) === String(r[key])) : -1;
        if (existingIdx >= 0) {
          if (action === 'insert') throw new Error(`duplicate key value violates unique constraint (${table}.${key})`);
          if (opts.ignoreDuplicates) continue;
          next[existingIdx] = { ...next[existingIdx], ...this._clone(r) };
          written.push(next[existingIdx]);
        } else {
          const row = this._newRow(table, r);
          next.push(row);
          written.push(row);
        }
      }
      this.write(table, next);
      return returning ? this._finish(written, single, true) : { data: null, error: null, status: 201 };
    }

    if (action === 'update') {
      const written = [];
      const next = all.map(row => {
        if (!keep(row)) return row;
        const upd = { ...row, ...this._clone(payload) };
        written.push(upd);
        return upd;
      });
      this.write(table, next);
      return returning ? this._finish(written, single, true) : { data: null, error: null, status: 204 };
    }

    if (action === 'delete') {
      const gone = all.filter(keep);
      this.write(table, all.filter(row => !keep(row)));
      /* emulate `on delete set null` so guest data migrates cleanly later */
      const goneIds = new Set(gone.map(r => String(r.id)));
      for (const [child, col] of (this.SET_NULL[table] || [])) {
        const rows = this.read(child);
        let changed = false;
        rows.forEach(r => { if (r[col] != null && goneIds.has(String(r[col]))) { r[col] = null; changed = true; } });
        if (changed) this.write(child, rows);
      }
      return returning ? this._finish(gone, single, true) : { data: null, error: null, status: 204 };
    }

    throw new Error('Guest mode: unknown action');
  },

  _finish(rows, single, clone, count = null) {
    const data = clone ? this._clone(rows) : rows;
    if (single === 'single') {
      if (data.length !== 1) return { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' }, status: 406 };
      return { data: data[0], error: null, status: 200 };
    }
    if (single === 'maybe') {
      if (data.length > 1) return { data: null, error: { message: 'JSON object requested, multiple rows returned', code: 'PGRST116' }, status: 406 };
      return { data: data[0] || null, error: null, status: 200 };
    }
    return { data, error: null, count, status: 200 };
  },
};

/* ============================================================
   sb.from(table) — guest-or-account routing
   Records the builder chain; on await, replays it against the real
   client when there's a session (after migrating guest data), or
   against GuestDB when there isn't.
   ============================================================ */
const _realFrom = sb.from.bind(sb);

sb.from = function (table) {
  const ops = [];
  let pending = null;
  const run = () => pending || (pending = (async () => {
    const session = await SupaAuth._session();
    if (!session) return GuestDB.exec(table, ops);
    await SupaAuth.ensureMigrated();
    let q = _realFrom(table);
    for (const [name, args] of ops) q = q[name](...args);
    return q;
  })());

  const proxy = new Proxy({}, {
    get(_, prop) {
      if (prop === 'then')    return (res, rej) => run().then(res, rej);
      if (prop === 'catch')   return rej => run().catch(rej);
      if (prop === 'finally') return fn => run().finally(fn);
      if (typeof prop === 'symbol') return undefined;
      return (...args) => { ops.push([prop, args]); return proxy; };
    },
  });
  return proxy;
};

/* ============================================================
   AUTH
   ============================================================ */
const SupaAuth = {
  GUEST_USER: Object.freeze({ id: GUEST_ID, email: null, isGuest: true }),

  async _session() {
    try {
      const { data: { session } } = await sb.auth.getSession();
      return session || null;
    } catch (_) { return null; }
  },

  /* Signed-in user, or the guest stand-in. Call at the top of each page init.
     (Name kept from when signed-out visitors were sent to /login.) */
  async requireAuth() {
    const session = await this._session();
    if (!session) return this.GUEST_USER;
    await this.ensureMigrated();
    return session.user;
  },

  async getUser() {
    const session = await this._session();
    return session ? session.user : this.GUEST_USER;
  },

  async isGuest() { return !(await this._session()); },

  /* Sync best guess for first paint: is a session saved in this browser?
     (supabase-js keeps it under sb-<project-ref>-auth-token) */
  hasStoredSession() {
    try {
      const ref = new URL(SUPABASE_URL).hostname.split('.')[0];
      return !!localStorage.getItem(`sb-${ref}-auth-token`);
    } catch (_) { return false; }
  },

  async signOut() {
    await sb.auth.signOut();
    window.location.replace('/login');
  },

  /* ---- guest → account migration ----------------------------------------
     Runs once per page load when signed in and guest rows exist. Every row
     keeps its id (so links between accounts/transactions/shifts/payouts
     survive) and is upserted with ignoreDuplicates, so a retry after a
     partial failure — or a second tab racing this one — never duplicates.
     A table is cleared locally only after the server accepted all of it;
     anything that fails stays on this device and is retried next load. */
  _migration: null,
  ensureMigrated() {
    if (!GuestDB.hasData()) return Promise.resolve(true);
    if (!this._migration) {
      this._migration = this._migrate().catch(err => {
        console.warn('[guest] could not move local data into the account yet:', err);
        return false;
      });
    }
    return this._migration;
  },

  async _migrate() {
    const session = await this._session();
    if (!session) return false;
    const uid = session.user.id;
    let ok = true, moved = 0;

    /* ids of every guest row — references to anything else are dropped
       rather than failing the foreign key */
    const known = {};
    GuestDB.TABLES.forEach(t => { known[t] = new Set(GuestDB.read(t).map(r => String(r.id))); });
    const fk = { account_id: 'accounts', to_account_id: 'accounts', tx_id: 'transactions', job_id: 'jobs' };

    for (const table of GuestDB.TABLES) {
      const local = GuestDB.read(table);
      if (!local.length) continue;
      const rows = local.map(r => {
        const row = { ...r, user_id: uid };
        for (const [col, parent] of Object.entries(fk)) {
          if (row[col] != null && !known[parent].has(String(row[col]))) row[col] = null;
        }
        return row;
      });
      let tableOk = true;
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await _realFrom(table)
          .upsert(rows.slice(i, i + 500), { onConflict: 'id', ignoreDuplicates: true });
        if (error) { console.warn(`[guest] migrating ${table} failed:`, error.message || error); tableOk = false; break; }
      }
      if (tableOk) { GuestDB.write(table, []); moved += rows.length; }
      else { ok = false; break; }                  /* children need their parents — stop here */
    }

    if (ok) ok = await this._migrateSettings(uid);

    if (moved) {
      /* last-good caches hold guest rows — let the next load refill them */
      ['pf_tx_cache', 'pf_acct_cache'].forEach(k => { try { localStorage.removeItem(k); } catch (_) {} });
      if (typeof SettingsStore !== 'undefined') SettingsStore._invalidate();
    }
    if (typeof showToast === 'function') {
      if (ok && moved) showToast('Your data from this device was saved to your account', 'success');
      else if (!ok) showToast("Couldn't move your local data to your account yet — it's kept on this device and will retry", 'error');
    }
    return ok;
  },

  /* Settings merge: the account's existing values win; guest values fill gaps
     and lists (custom categories, presets) are combined by id. */
  async _migrateSettings(uid) {
    const local = GuestDB.read('user_settings')[0];
    if (!local) return true;

    const { data: server, error } = await _realFrom('user_settings').select('*').eq('user_id', uid).maybeSingle();
    if (error) { console.warn('[guest] reading account settings failed:', error.message); return false; }

    const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
    const filled = v => Array.isArray(v) ? v.length > 0 : isObj(v) ? Object.keys(v).length > 0 : v != null && v !== '';
    const unionById = (a, b) => {
      const out = Array.isArray(a) ? a.slice() : [];
      const ids = new Set(out.map(x => x && x.id));
      (Array.isArray(b) ? b : []).forEach(x => { if (!x || !x.id || !ids.has(x.id)) out.push(x); });
      return out;
    };
    const s = server || {};
    const merged = {};

    merged.currency          = server && s.currency ? s.currency : (local.currency || 'CAD');
    merged.custom_categories = unionById(s.custom_categories, local.custom_categories);
    merged.subscriptions     = unionById(s.subscriptions, local.subscriptions);
    /* budgets: { 'YYYY-MM': { categoryId: limit } } — account's limits win */
    merged.budgets = isObj(local.budgets) ? this._clone(local.budgets) : {};
    if (isObj(s.budgets)) for (const [m, cats] of Object.entries(s.budgets)) merged.budgets[m] = { ...(merged.budgets[m] || {}), ...cats };

    /* the optional jsonb columns go one at a time, so a DB missing one of them
       doesn't block the rest (same approach as SettingsStore._putColumn) */
    const extra = {};
    if ('job_defaults' in local) {
      const jd = { ...(isObj(local.job_defaults) ? local.job_defaults : {}) };
      if (isObj(s.job_defaults)) for (const [k, v] of Object.entries(s.job_defaults)) if (filled(v)) jd[k] = v;
      extra.job_defaults = jd;
    }
    if ('ui_prefs' in local)      extra.ui_prefs      = { ...(isObj(local.ui_prefs) ? local.ui_prefs : {}), ...(isObj(s.ui_prefs) ? s.ui_prefs : {}) };
    if ('shift_goal' in local)    extra.shift_goal    = filled(s.shift_goal) ? s.shift_goal : local.shift_goal;
    if ('shift_presets' in local) extra.shift_presets = unionById(s.shift_presets, local.shift_presets);
    if (extra.ui_prefs && local.ui_prefs && Array.isArray(local.ui_prefs.txTemplates)) {
      extra.ui_prefs.txTemplates = unionById(s.ui_prefs && s.ui_prefs.txTemplates, local.ui_prefs.txTemplates);
    }

    const { error: e1 } = await _realFrom('user_settings').upsert({ user_id: uid, ...merged }, { onConflict: 'user_id' });
    if (e1) { console.warn('[guest] saving settings failed:', e1.message); return false; }
    for (const [col, val] of Object.entries(extra)) {
      const { error: e2 } = await _realFrom('user_settings').upsert({ user_id: uid, [col]: val }, { onConflict: 'user_id' });
      if (e2) console.warn(`[guest] "${col}" could not be saved to the account:`, e2.message);
    }
    if (merged.currency) { try { localStorage.setItem('pf_currency', merged.currency); } catch (_) {} }
    GuestDB.write('user_settings', []);
    return true;
  },

  _clone(v) { return JSON.parse(JSON.stringify(v)); },
};
