/* Transport Roster — Supabase sync layer.
   Depends on globals exposed by index.html:
   state, save, persistAndRender, showModal, closeModal, val, num, nowISO, uid, esc,
   updateSyncIndicator, showToast, markDirty, logActivity, paxVersion, payVersion */
(function(){
  const sb = { client: null, loading: null };
  let authUser = null;

  function loadScript(){
    return new Promise((resolve, reject) => {
      if (window.supabase) return resolve();
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
      s.onload = resolve; s.onerror = () => reject(new Error('Failed to load Supabase'));
      document.head.appendChild(s);
    });
  }

  async function ensureClient(){
    const cfg = state.settings.supabase || {};
    if (!cfg.url || !cfg.anonKey) throw new Error('Supabase not configured in Settings');
    if (!sb.client) {
      if (!sb.loading) sb.loading = loadScript();
      await sb.loading;
      sb.client = window.supabase.createClient(cfg.url, cfg.anonKey);
      sb.client.auth.onAuthStateChange((_evt, session) => {
        authUser = session?.user || null;
        persistAndRender();
      });
      const { data } = await sb.client.auth.getSession();
      authUser = data?.session?.user || null;
    }
    return sb.client;
  }

  async function signInWithEmail(email){
    const c = await ensureClient();
    const redirectTo = location.origin + location.pathname + (location.search || '');
    const { error } = await c.auth.signInWithOtp({ email, options: { emailRedirectTo: redirectTo } });
    if (error) throw error;
  }
  async function signOut(){
    if (!sb.client) return;
    await sb.client.auth.signOut();
    authUser = null;
    persistAndRender();
  }

  function toRow(ev, ownerId){
    return {
      id: ev.remoteId,
      owner: ownerId,
      name: ev.name,
      event_date: ev.eventDate || null,
      deadline_at: ev.deadlineAt || null,
      total_transport_cost: num(ev.totalTransportCost),
      pricing_mode: ev.pricingMode || 'auto',
      manual_seat_price: num(ev.manualSeatPrice),
      rounding_mode: ev.roundingMode || 'none',
      no_show_mode: ev.noShowMode || 'none',
      no_show_units: num(ev.noShowUnits),
      no_show_percent: num(ev.noShowPercent),
      status: ev.status || 'open',
      passengers: ev.passengers || [],
      payments: ev.payments || [],
      updated_at: nowISO()
    };
  }
  function fromRow(row){
    return {
      remoteId: row.id,
      name: row.name,
      eventDate: row.event_date,
      deadlineAt: row.deadline_at,
      totalTransportCost: Number(row.total_transport_cost) || 0,
      pricingMode: row.pricing_mode,
      manualSeatPrice: Number(row.manual_seat_price) || 0,
      roundingMode: row.rounding_mode,
      noShowMode: row.no_show_mode,
      noShowUnits: Number(row.no_show_units) || 0,
      noShowPercent: Number(row.no_show_percent) || 0,
      status: row.status,
      passengers: row.passengers || [],
      payments: row.payments || [],
      updatedAt: row.updated_at,
      lastSyncedAt: row.updated_at,
      version: row.version ?? 0,
      syncState: 'synced'
    };
  }

  class ConflictError extends Error {
    constructor(expectedVersion) {
      super('Remote has a newer version. Resolve the conflict.');
      this.name = 'ConflictError';
      this.expectedVersion = expectedVersion;
    }
  }

  async function pushEvent(ev){
    const c = await ensureClient();
    if (!authUser) throw new Error('Sign in required');
    if (!ev.myRole) ev.myRole = 'owner';
    const row = toRow(ev, authUser.id);

    if (!ev.remoteId) {
      ev.remoteId = crypto.randomUUID();
      row.id = ev.remoteId;
      row.version = 0;
      const { error } = await c.from('transport_events').insert(row);
      if (error) throw error;
      ev.version = 0;
    } else {
      const expected = ev.version ?? 0;
      row.version = expected + 1;
      const { data, error } = await c.from('transport_events')
        .update(row).eq('id', ev.remoteId).eq('version', expected)
        .select('version, updated_at');
      if (error) throw error;
      if (!data || data.length === 0) throw new ConflictError(expected);
      ev.version = data[0].version;
      ev.lastSyncedAt = data[0].updated_at;
      ev.updatedAt = data[0].updated_at;
    }
    ev.lastSyncedAt = ev.lastSyncedAt || row.updated_at || nowISO();
    ev.updatedAt = ev.updatedAt || ev.lastSyncedAt;
    ev.syncState = 'synced';
    save();
  }

  async function forcePushEvent(ev){
    const c = await ensureClient();
    if (!authUser) throw new Error('Sign in required');
    if (!ev.remoteId) ev.remoteId = crypto.randomUUID();
    const { data: cur } = await c.from('transport_events')
      .select('version').eq('id', ev.remoteId).maybeSingle();
    const row = toRow(ev, authUser.id);
    if (!cur) {
      row.version = 0;
      const { error } = await c.from('transport_events').insert(row);
      if (error) throw error;
      ev.version = 0;
    } else {
      row.version = (cur.version ?? 0) + 1;
      const { error } = await c.from('transport_events').update(row).eq('id', ev.remoteId);
      if (error) throw error;
      ev.version = row.version;
    }
    ev.lastSyncedAt = row.updated_at || nowISO();
    ev.updatedAt = ev.lastSyncedAt;
    ev.syncState = 'synced';
    save();
  }

  async function pullEvent(ev){
    const c = await ensureClient();
    if (!ev.remoteId) throw new Error('Nothing to pull — event has no cloud copy yet.');
    const { data, error } = await c.from('transport_events').select('*').eq('id', ev.remoteId).maybeSingle();
    if (error) throw error;
    if (!data) {
      if (ev.myRole === 'viewer') {
        const idx = state.events.findIndex(x => x.id === ev.id);
        if (idx >= 0) state.events.splice(idx, 1);
        if (state.view.name === 'event' && state.view.id === ev.id) state.view = { name: 'events' };
        save();
        throw new Error('This event is no longer accessible — the share may have been revoked.');
      }
      throw new Error('Event not found on server');
    }
    Object.assign(ev, fromRow(data));
    if (ev.shareSlug && ev.myRole === 'viewer') {
      touchShare(ev.shareSlug, authUser?.email).catch(() => {});
    }
    save();
  }

  async function mergeRemote(ev){
    const c = await ensureClient();
    if (!ev.remoteId) throw new Error('Nothing to merge — event has no cloud copy yet.');
    const { data, error } = await c.from('transport_events').select('*').eq('id', ev.remoteId).single();
    if (error) throw error;
    const remote = fromRow(data);

    const pById = new Map();
    for (const p of (ev.passengers || [])) pById.set(p.id, p);
    for (const p of (remote.passengers || [])) {
      const cur = pById.get(p.id);
      if (!cur) { pById.set(p.id, p); continue; }
      const remoteWins = paxVersion(p) > paxVersion(cur);
      const winner = remoteWins ? p : cur;
      const loser  = remoteWins ? cur : p;
      const seen = new Set();
      const mergedHistory = [...(loser.editHistory || []), ...(winner.editHistory || [])]
        .filter(h => {
          const key = `${h.at}|${h.field}|${String(h.oldValue)}|${String(h.newValue)}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .sort((a, b) => String(a.at).localeCompare(String(b.at)));
      pById.set(p.id, Object.assign({}, winner, { editHistory: mergedHistory }));
    }
    ev.passengers = [...pById.values()].sort((a,b) => (a.listNumber||0) - (b.listNumber||0));

    const payById = new Map();
    for (const x of (ev.payments || [])) payById.set(x.id, x);
    for (const x of (remote.payments || [])) {
      const cur = payById.get(x.id);
      if (!cur) { payById.set(x.id, x); continue; }
      if (payVersion(x) > payVersion(cur)) {
        const merged = [...(cur.editHistory || []), ...(x.editHistory || [])]
          .sort((a, b) => String(a.at).localeCompare(String(b.at)));
        payById.set(x.id, Object.assign({}, x, { editHistory: merged }));
      }
    }
    ev.payments = [...payById.values()];

    const lT = new Date(ev.updatedAt || 0).getTime();
    const rT = new Date(remote.updatedAt || 0).getTime();
    if (rT > lT) {
      for (const k of ['name','eventDate','deadlineAt','totalTransportCost','pricingMode',
                       'manualSeatPrice','roundingMode','noShowMode','noShowUnits','noShowPercent']) {
        ev[k] = remote[k];
      }
    }

    ev.version = remote.version ?? 0;
    await pushEvent(ev);
  }

  async function syncEvent(ev){
    const c = await ensureClient();
    if (!authUser) throw new Error('Sign in required');
    if (!ev.remoteId) { await pushEvent(ev); await syncAllLogs(ev); return 'pushed'; }

    const { data, error } = await c.from('transport_events').select('*').eq('id', ev.remoteId).maybeSingle();
    if (error) throw error;
    if (!data) {
      ev.remoteId = crypto.randomUUID();
      ev.version = 0;
      await pushEvent(ev);
      await syncAllLogs(ev);
      return 'pushed';
    }
    if (ev.syncState === 'dirty') {
      await pushEvent(ev);
      await syncAllLogs(ev);
      return 'pushed';
    }
    if ((data.version ?? 0) > (ev.version ?? 0)) {
      Object.assign(ev, fromRow(data));
      await syncAllLogs(ev);
      save();
      return 'pulled';
    }
    ev.syncState = 'synced';
    ev.version = data.version ?? 0;
    await syncAllLogs(ev);
    save();
    return 'noop';
  }

  /* ---- logs ---- */
  async function pushLog(ev, entry){
    if (!authUser || !ev.remoteId) return;
    const c = await ensureClient();
    const { error } = await c.from('event_logs').upsert({
      id: entry.id,
      event_id: ev.remoteId,
      action: entry.action,
      actor_email: entry.actor?.email || null,
      actor_id: entry.actor?.id && entry.actor.id !== 'local' ? entry.actor.id : null,
      details: entry.details || {},
      at: entry.at
    }, { onConflict: 'id' });
    if (error) throw error;
  }
  async function pullLogs(ev){
    if (!ev.remoteId) return [];
    const c = await ensureClient();
    const { data, error } = await c.from('event_logs')
      .select('*').eq('event_id', ev.remoteId).order('at', { ascending: true });
    if (error) throw error;
    return data || [];
  }
  async function syncAllLogs(ev){
    if (!authUser || !ev.remoteId) return;
    const remote = await pullLogs(ev);
    const local  = Array.isArray(ev.activity) ? ev.activity : [];
    const byId = new Map();
    for (const e of local) byId.set(e.id, e);
    for (const r of remote) {
      if (!byId.has(r.id)) {
        byId.set(r.id, {
          id: r.id, at: r.at, action: r.action,
          actor: { id: r.actor_id, email: r.actor_email || 'someone' },
          details: r.details || {}
        });
      }
    }
    ev.activity = [...byId.values()].sort((a,b) => String(a.at).localeCompare(String(b.at)));
    const remoteIds = new Set(remote.map(r => r.id));
    for (const e of local) {
      if (!remoteIds.has(e.id)) {
        try { await pushLog(ev, e); } catch (err) { console.warn('log push failed', err); }
      }
    }
    save();
  }

  /* ---- shares ---- */
  async function createShare(ev, canEdit = true){
    const c = await ensureClient();
    if (!authUser) throw new Error('Sign in required');
    if (!ev.remoteId) await pushEvent(ev);
    const slug = Math.random().toString(36).slice(2, 10);
    const { error } = await c.from('transport_event_shares').insert({
      slug, event_id: ev.remoteId, created_by: authUser.id, can_edit: !!canEdit
    });
    if (error) throw error;
    return { slug, canEdit: !!canEdit };
  }
  async function listShares(ev){
    const c = await ensureClient();
    if (!authUser) throw new Error('Sign in required');
    if (!ev.remoteId) return [];
    const { data, error } = await c.from('transport_event_shares')
      .select('slug, can_edit, created_at, created_by, last_viewed_at, viewer_email')
      .eq('event_id', ev.remoteId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data || []).map(s => ({ ...s, is_mine: s.created_by === authUser.id }));
  }
  async function revokeShare(slug){
    const c = await ensureClient();
    if (!authUser) throw new Error('Sign in required');
    const { error, count } = await c.from('transport_event_shares')
      .delete({ count: 'exact' }).eq('slug', slug);
    if (error) throw error;
    if (!count) throw new Error('Not authorized to revoke this share');
  }
  async function touchShare(slug, email){
    if (!slug) return;
    if (!authUser) return;
    try {
      const c = await ensureClient();
      await c.rpc('touch_share', { p_slug: slug, p_email: authUser.email || null });
    } catch (_) {}
  }
  async function joinShare(slug){
    const c = await ensureClient();
    const { data: share, error: e1 } = await c.from('transport_event_shares').select('*').eq('slug', slug).single();
    if (e1 || !share) throw new Error('Share not found');
    const { data: row, error: e2 } = await c.from('transport_events').select('*').eq('id', share.event_id).single();
    if (e2) throw new Error('Event not found');
    let ev = state.events.find(e => e.remoteId === row.id);
    if (!ev) {
      ev = { id: uid(), passengers: [], payments: [], createdAt: nowISO() };
      state.events.push(ev);
    }
    Object.assign(ev, fromRow(row));
    ev.isShared = true;
    ev.myRole = share.can_edit ? 'editor' : 'viewer';
    ev.shareSlug = slug;
    touchShare(slug, authUser?.email).catch(() => {});
    state.view = { name: 'event', id: ev.id, tab: 'roster', filter: 'all' };
    persistAndRender();
  }

  async function deleteRemote(remoteId){
    const c = await ensureClient();
    const { error } = await c.from('transport_events').delete().eq('id', remoteId);
    if (error) throw error;
  }

  window.Cloud = {
    ensureClient, signInWithEmail, signOut,
    pushEvent, syncEvent, forcePushEvent, pullEvent, mergeRemote,
    createShare, listShares, revokeShare, touchShare, joinShare, deleteRemote,
    pushLog, pullLogs, syncAllLogs,
    ConflictError,
    getUser: () => authUser,
    isConfigured: () => !!(state.settings.supabase?.url && state.settings.supabase?.anonKey)
  };

  /* Auto-join from ?share=slug */
  const params = new URLSearchParams(location.search);
  const shareSlug = params.get('share');
  if (shareSlug) {
    setTimeout(async () => {
      try {
        const c = await ensureClient();
        const { data: { session } } = await c.auth.getSession();
        if (session) {
          await joinShare(shareSlug);
          history.replaceState({}, '', location.pathname);
        } else {
          showModal(`
            <h2>Join shared event</h2>
            <p class="muted small">Sign in with your email to access this shared event.</p>
            <form>
              <label>Email<input type="email" id="join_email" required></label>
              <div class="row gap mt12">
                <button type="button" class="btn" data-act="close-modal">Cancel</button>
                <button type="submit" class="btn primary">Send magic link</button>
              </div>
            </form>`, async () => {
              try {
                await signInWithEmail(val('join_email'));
                closeModal();
                alert('Check your email for the sign-in link. Open it on this device, then return.');
              } catch (e) { alert(e.message); }
            });
        }
      } catch (e) { console.warn('share join failed:', e); }
    }, 600);
  }
})();