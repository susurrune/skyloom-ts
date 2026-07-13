/** Browser client for the Skyloom ink-wash web UI.
 *
 * This function is serialized by src/web/ui.ts and served as /ui/app.js,
 * together with the isomorphic markdown renderer. Keep it free of imports.
 */

declare const document: any;
declare const window: any;
declare function mdToHtml(s: string): string;
declare function escapeHtml(s: string): string;

export function clientMain(): void {
  const BOOT = window.__SKYLOOM__;
  const AGENTS: any[] = BOOT.agents;
  const store = window.localStorage;
  const D = document;

  /* ── state ── */
  let cur = AGENTS[0];
  let streaming = false;
  let resetting = false;
  let syncing = false;
  let syncSeq = 0;
  let aborter: any = null;
  let unread = 0;
  let sessionsBusy = false;
  let panelActiveSessionId: string | null = null;
  let settingsData: any = null;
  let settingsBusy = false;
  let clearKeyProvider: string | null = null;
  let healthBusy = false;

  /* ── platform-aware shortcuts ──
     Apple: ⌘1-6 / ⌘K. Elsewhere: Alt+1-6 (Ctrl+digit is reserved by browsers
     for tab switching and cannot be intercepted) and Ctrl+K (the industry
     convention — GitHub/Slack/Linear — and interceptable). The handler accepts
     every modifier on every platform; only the labels differ. */
  const nav = window.navigator || {};
  const isApple = /mac|iphone|ipad|ipod/i.test(
    String((nav.userAgentData && nav.userAgentData.platform) || nav.platform || nav.userAgent || ''));
  const AGENT_MOD = isApple ? '⌘' : 'Alt+';
  const CLEAR_MOD = isApple ? '⌘' : 'Ctrl+';

  /* ── tiny helpers ── */
  const $ = (sel: string) => D.querySelector(sel);
  const el = (tag: string, cls?: string, html?: string) => {
    const e = D.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  };
  const icon = (name: string, cls?: string) =>
    '<span class="ui-icon img2-icon icon-' + name + (cls ? ' ' + cls : '') + '" aria-hidden="true"></span>';
  const fmtTime = (ts: number) =>
    new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const fmtDur = (ms: number) => (ms < 1000 ? Math.round(ms) + 'ms' : (ms / 1000).toFixed(1) + 's');

  function toast(text: string, kind?: string) {
    const t = el('div', 'toast' + (kind ? ' ' + kind : ''), escapeHtml(text));
    $('#toasts').appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 350); }, 2400);
  }

  function apiErrorPayload(payload: any): any {
    const error = payload && payload.error ? payload.error : payload;
    return error && typeof error === 'object' ? error : null;
  }

  function apiErrorText(payload: any, fallback: string): string {
    const error = apiErrorPayload(payload);
    if (!error) return fallback;
    const message = typeof error.message === 'string' && error.message ? error.message : fallback;
    return typeof error.action === 'string' && error.action ? message + ' · ' + error.action : message;
  }

  async function readApiErrorPayload(response: any): Promise<any> {
    try {
      return apiErrorPayload(await response.clone().json());
    } catch {
      return null;
    }
  }

  async function readApiError(response: any, fallback: string): Promise<string> {
    const error = await readApiErrorPayload(response);
    return error ? apiErrorText(error, fallback) : fallback + ' (HTTP ' + response.status + ')';
  }

  function isMissingSessionError(error: any): boolean {
    return Boolean(error && error.code === 'web.session_not_found');
  }

  function isCurrentAgent(agent: any): boolean {
    return Boolean(agent && cur.name === agent.name);
  }

  /* ── theme (宣纸 / 夜墨) ── */
  function themeNow(): string { return D.documentElement.getAttribute('data-theme') || 'light'; }
  function setTheme(mode: string) {
    D.documentElement.setAttribute('data-theme', mode);
    store.setItem('skyweb.theme', mode);
    $('meta[name="theme-color"]').setAttribute('content', mode === 'dark' ? '#20231f' : '#f4f2e9');
    $('#theme-btn').innerHTML = icon(mode === 'dark' ? 'sun' : 'moon');
    $('#theme-btn').setAttribute('aria-label', mode === 'dark' ? '切换到宣纸模式' : '切换到夜墨模式');
    paintPigment();
  }
  function paintPigment() {
    const c = themeNow() === 'dark' ? cur.dark : cur.light;
    D.documentElement.style.setProperty('--pigment', c);
    D.documentElement.style.setProperty('--pigment-soft', c + '1f');
    D.documentElement.style.setProperty('--pigment-faint', c + '14');
  }

  /* ── history (per-agent and per-session, localStorage) ── */
  const DKEY = (a: string) => 'skyweb.draft.' + a;
  const SKEY = (a: string) => 'skyweb.session.' + a;
  const LEGACY_HKEY = (a: string) => 'skyweb.h.' + a;
  const HKEY = (a: string) => 'skyweb.h.' + a + '.' + (store.getItem(SKEY(a)) || 'pending');
  function loadHist(a: string): any[] {
    try {
      const scoped = store.getItem(HKEY(a));
      if (scoped !== null) {
        const parsed = JSON.parse(scoped);
        return Array.isArray(parsed) ? parsed : [];
      }
      const legacy = store.getItem(LEGACY_HKEY(a));
      if (legacy === null) return [];
      const parsed = JSON.parse(legacy);
      if (!Array.isArray(parsed)) return [];
      if (store.getItem(SKEY(a))) {
        store.setItem(HKEY(a), legacy);
        store.removeItem(LEGACY_HKEY(a));
      }
      return parsed;
    } catch { return []; }
  }
  function saveHist(a: string, h: any[]) {
    try {
      store.setItem(HKEY(a), JSON.stringify(h.slice(-120)));
      if (store.getItem(SKEY(a))) store.removeItem(LEGACY_HKEY(a));
    } catch { /* quota */ }
  }
  function pushHist(entry: any) {
    const h = loadHist(cur.name); h.push(entry); saveHist(cur.name, h);
  }
  function markPendingUserFailed(agentName: string, text: string, ts: number, failed: boolean) {
    const history = loadHist(agentName);
    for (let i = history.length - 1; i >= 0; i--) {
      const entry = history[i];
      if (entry.r !== 'u' || entry.t !== text || entry.ts !== ts) continue;
      if (failed) entry.failed = true;
      else delete entry.failed;
      saveHist(agentName, history);
      return;
    }
  }
  function clearCachedSession(agentName: string) {
    store.removeItem(SKEY(agentName));
    store.removeItem('skyweb.h.' + agentName + '.pending');
  }
  function bindResponseSession(response: any, agentName: string): string | null {
    const sessionId = String(response.headers.get('X-Skyloom-Session-Id') || '').trim();
    if (!sessionId) return null;
    store.setItem(SKEY(agentName), sessionId);
    return sessionId;
  }
  function histSignature(h: any[]): string {
    return JSON.stringify(h.map((entry: any) => [entry.r, entry.t]));
  }
  function clearHistorySyncWarning() {
    const warning = msgs().querySelector('.history-sync-warning');
    if (warning) warning.remove();
  }
  function showHistorySyncWarning(agent: any) {
    if (!isCurrentAgent(agent)) return;
    clearHistorySyncWarning();
    const warning = el('div', 'sysline history-sync-warning', '历史同步失败，当前显示本机缓存');
    warning.setAttribute('role', 'status');
    msgs().appendChild(warning);
  }
  async function syncHistory(agent: any) {
    const seq = ++syncSeq;
    syncing = true;
    updateRetryButton();
    try {
      const response = await fetch('/api/history?agent=' + encodeURIComponent(agent.name));
      if (!response.ok) throw new Error(await readApiError(response, '历史同步失败'));
      const data: any = await response.json();
      const source = Array.isArray(data.messages) ? data.messages : [];
      const now = Date.now();
      const remote = source
        .filter((message: any) =>
          (message.role === 'user' || message.role === 'assistant') && typeof message.content === 'string')
        .map((message: any, index: number) => ({
          r: message.role === 'user' ? 'u' : 'a',
          t: message.content,
          ts: now - (source.length - index) * 1000,
        }));
      if (typeof data.sessionId === 'string') store.setItem(SKEY(agent.name), data.sessionId);
      const changed = histSignature(loadHist(agent.name)) !== histSignature(remote);
      if (changed) saveHist(agent.name, remote);
      if (changed && seq === syncSeq && cur.name === agent.name) renderHistory();
      if (seq === syncSeq && isCurrentAgent(agent)) clearHistorySyncWarning();
    } catch {
      if (seq === syncSeq) showHistorySyncWarning(agent);
    }
    finally {
      if (seq === syncSeq) {
        syncing = false;
        updateRetryButton();
      }
    }
  }

  /* ── ambient particles ── */
  function buildParticles(kind: string) {
    const layer = $('#ambient-layer');
    layer.innerHTML = '';
    const wrap = el('div', 'pwrap ' + kind);
    const counts: any = { mist: 7, rainfall: 22, frostc: 14, snowp: 14, dewb: 10, sunm: 16 };
    const n = counts[kind] || 10;
    for (let i = 0; i < n; i++) {
      const p = el('i');
      const s = Math.random();
      p.style.cssText = '--x:' + (4 + s * 92) + '%;--y:' + (5 + ((s * 7) % 1) * 88) + '%;--dur:' +
        (2.5 + s * 8) + 's;--delay:' + (-s * 9) + 's;--sz:' + (3 + s * 9) + 'px;--drift:' + ((s - 0.5) * 60) + 'px';
      wrap.appendChild(p);
    }
    layer.appendChild(wrap);
  }

  /* ── agent switching ── */
  function applyAgent(a: any, opts?: any) {
    closeSessions();
    cur = a;
    store.setItem('skyweb.agent', a.name);
    D.documentElement.setAttribute('data-agent', a.name);
    paintPigment();
    buildParticles(a.particles);
    $('#kanji-seal').textContent = a.kanji;
    $('#strip-weather').className = 'weather-doodle img2-icon icon-' + a.name;
    $('#strip-name').textContent = a.label;
    $('#strip-pig').textContent = a.pig + ' · ' + a.sub;
    $('#verse').textContent = a.poem;
    D.querySelectorAll('.agent-item').forEach((e: any) => {
      const active = e.dataset.agent === a.name;
      e.classList.toggle('active', active);
      e.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    if (!opts || !opts.keepMsgs) renderHistory();
    $('#chat-input').value = store.getItem(DKEY(a.name)) || '';
    autosize();
    updateRetryButton();
    $('#chat-input').focus();
    syncHistory(a);
    if (settingsData && $('#settings-panel').classList.contains('show')) renderSettings(settingsData);
  }

  /* ── message rendering ── */
  const msgs = () => $('#messages');

  function nearBottom(): boolean {
    const m = msgs();
    return m.scrollHeight - m.scrollTop - m.clientHeight < 90;
  }
  function scrollBottom(force?: boolean) {
    if (force || nearBottom()) { const m = msgs(); m.scrollTop = m.scrollHeight; hidePill(); }
  }
  function hidePill() { unread = 0; $('#scroll-pill').classList.remove('show'); }
  function bumpPill() {
    if (nearBottom()) return;
    unread++;
    const pill = $('#scroll-pill');
    pill.querySelector('span').textContent = unread > 1 ? unread + ' 条新消息' : '回到底部';
    pill.classList.add('show');
  }

  function addUserMsg(text: string, ts: number, failed = false): any {
    const w = el('div', 'msg user' + (failed ? ' failed' : ''));
    w.dataset.ts = String(ts);
    w.innerHTML = '<div class="msg-body">' + escapeHtml(text).replace(/\n/g, '<br>') +
      '</div><span class="msg-meta">' +
      (failed ? '<span class="retry-state">发送失败，可重试</span>' : '') + fmtTime(ts) + '</span>';
    msgs().appendChild(w);
    return w;
  }

  function findUserMsg(ts: number): any {
    const items = msgs().querySelectorAll('.msg.user');
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].dataset.ts === String(ts)) return items[i];
    }
    return null;
  }

  function addSysLine(text: string) {
    msgs().appendChild(el('div', 'sysline', escapeHtml(text)));
  }

  /** An assistant turn: reasoning ▸ tool rail ▸ markdown body ▸ meta. */
  function addTurn(): any {
    const w = el('div', 'msg assistant');
    w.innerHTML =
      '<div class="turn-seal"><span class="weather-doodle img2-icon icon-' + cur.name + '" aria-hidden="true"></span></div>' +
      '<div class="turn-main">' +
        '<details class="think" hidden><summary>思考过程</summary><div class="think-body"></div></details>' +
        '<div class="tools" hidden></div>' +
        '<div class="msg-body"><span class="caret"></span></div>' +
        '<div class="msg-meta"><span class="m-time"></span><span class="m-dur"></span>' +
        '<button class="m-copy" type="button" title="复制原文" aria-label="复制原文">' + icon('copy') + '</button></div>' +
      '</div>';
    msgs().appendChild(w);
    return w;
  }

  function addToolRow(turn: any, name: string, label: string): any {
    const rail = turn.querySelector('.tools');
    rail.hidden = false;
    const row = el('div', 'tool-row pending');
    row.dataset.tool = name;
    row.dataset.t0 = String(Date.now());
    row.innerHTML = '<span class="t-ind"></span><span class="t-name">' + escapeHtml(name) +
      '</span><span class="t-label">' + escapeHtml(label || '') + '</span><span class="t-dur"></span>';
    rail.appendChild(row);
    return row;
  }
  function resolveToolRow(turn: any, name: string, ok: boolean): any {
    const rows = turn.querySelectorAll('.tool-row.pending');
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].dataset.tool === name) {
        const r = rows[i];
        r.classList.remove('pending');
        r.classList.add(ok ? 'ok' : 'err');
        r.querySelector('.t-dur').textContent = fmtDur(Date.now() - Number(r.dataset.t0));
        return r;
      }
    }
    return null;
  }

  function renderToolsStatic(turn: any, tools: any[]) {
    if (!tools || !tools.length) return;
    const rail = turn.querySelector('.tools');
    rail.hidden = false;
    for (const t of tools) {
      const row = el('div', 'tool-row ' + (t.ok ? 'ok' : 'err'));
      row.innerHTML = '<span class="t-ind"></span><span class="t-name">' + escapeHtml(t.name) +
        '</span><span class="t-label"></span><span class="t-dur">' + (t.ms ? fmtDur(t.ms) : '') + '</span>';
      rail.appendChild(row);
    }
  }

  /* welcome panel for an empty session */
  function renderWelcome() {
    const w = el('div', 'welcome');
    w.innerHTML =
      '<div class="w-aside">' +
        '<span class="w-index">FIELD NOTE / 01</span>' +
        '<span class="w-doodle weather-doodle img2-icon icon-' + cur.name + '" aria-hidden="true"></span>' +
        '<span class="w-kanji" aria-hidden="true">' + escapeHtml(cur.kanji) + '</span>' +
      '</div>' +
      '<div class="w-copy">' +
        '<div class="w-kicker"><span>今日观测</span><i aria-hidden="true"></i><span>' + escapeHtml(cur.label) + '</span></div>' +
        '<div class="w-poem">' + escapeHtml(cur.poem) + '</div>' +
        '<div class="w-sub">' + escapeHtml(cur.pig + ' · ' + cur.sub) + '</div>' +
        '<div class="w-tips" aria-label="建议问题">' + cur.tips.map((t: string, i: number) =>
          '<button class="w-tip" type="button"><span class="w-tip-no">0' + (i + 1) + '</span><span class="w-tip-text">' +
          escapeHtml(t) + '</span><span class="w-tip-arrow" aria-hidden="true">↗</span></button>').join('') + '</div>' +
      '</div>';
    msgs().appendChild(w);
    w.querySelectorAll('.w-tip').forEach((b: any) => b.addEventListener('click', () => {
      const inp = $('#chat-input');
      inp.value = b.querySelector('.w-tip-text').textContent;
      store.setItem(DKEY(cur.name), inp.value);
      inp.focus();
      autosize();
    }));
  }

  function renderHistory() {
    const m = msgs();
    m.innerHTML = '';
    const h = loadHist(cur.name);
    if (!h.length) { renderWelcome(); updateRetryButton(); return; }
    for (const e of h) {
      if (e.r === 'u') addUserMsg(e.t, e.ts, !!e.failed);
      else if (e.r === 'a') {
        const turn = addTurn();
        turn.querySelector('.caret').remove();
        renderToolsStatic(turn, e.tools);
        turn.querySelector('.msg-body').innerHTML = mdToHtml(e.t);
        turn.querySelector('.m-time').textContent = fmtTime(e.ts);
        if (e.ms) turn.querySelector('.m-dur').textContent = fmtDur(e.ms);
        turn._raw = e.t;
      }
    }
    m.scrollTop = m.scrollHeight;
    updateRetryButton();
  }

  /* ── streaming chat ── */
  function chatRequestBody(text: string, useCachedSession = true): string {
    const body: any = { message: text, agent: cur.name };
    const sessionId = useCachedSession ? store.getItem(SKEY(cur.name)) : null;
    if (sessionId) body.sessionId = sessionId;
    return JSON.stringify(body);
  }

  async function send(retryEntry?: any) {
    const inp = $('#chat-input');
    const text = retryEntry ? String(retryEntry.t || '').trim() : inp.value.trim();
    if (!text || streaming || resetting) return;
    if (syncing) { toast('正在同步会话，请稍候'); return; }
    if (retryEntry) renderHistory();
    else { inp.value = ''; autosize(); }
    store.removeItem(DKEY(cur.name));
    const wEl = msgs().querySelector('.welcome'); if (wEl) wEl.remove();

    streaming = true;
    setComposer(true);
    const t0 = Date.now();
    const uts = retryEntry && Number.isFinite(Number(retryEntry.ts)) ? Number(retryEntry.ts) : Date.now();
    const pendingUser = retryEntry || { r: 'u', t: text, ts: uts };
    const userEl = retryEntry
      ? findUserMsg(uts)
      : addUserMsg(text, uts);
    if (!retryEntry) pushHist(pendingUser);
    updateRetryButton();
    scrollBottom(true);

    const turn = addTurn();
    const body = turn.querySelector('.msg-body');
    const caret = turn.querySelector('.caret');
    let content = '';
    let reasoning = '';
    const tools: any[] = [];
    let renderQueued = false;
    let renderFrame: number | null = null;
    const queueRender = () => {
      if (renderQueued) return;
      renderQueued = true;
      renderFrame = window.requestAnimationFrame(() => {
        renderFrame = null;
        renderQueued = false;
        body.innerHTML = mdToHtml(content);
        body.appendChild(caret);
        scrollBottom(); bumpPill();
      });
    };

    aborter = new AbortController();
    let stopped = false;
    let failed = false;
    let staleSessionRetried = false;
    try {
      let resp = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: chatRequestBody(text),
        signal: aborter.signal,
      });
      const apiError = !resp.ok ? await readApiErrorPayload(resp) : null;
      if (isMissingSessionError(apiError) && !staleSessionRetried) {
        staleSessionRetried = true;
        clearCachedSession(cur.name);
        toast('会话已过期，正在重新接续');
        resp = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: chatRequestBody(text, false),
          signal: aborter.signal,
        });
      }
      if (!resp.ok || !resp.body) throw new Error(await readApiError(resp, '连接失败'));
      bindResponseSession(resp, cur.name);
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop() || '';
        for (const part of parts) {
          const line = part.replace(/^data: /, '').trim();
          if (!line) continue;
          let ev: any; try { ev = JSON.parse(line); } catch { continue; }
          if (ev.type === 'content') { content += ev.text; queueRender(); }
          else if (ev.type === 'reasoning' && ev.text) {
            reasoning += ev.text;
            const th = turn.querySelector('.think');
            th.hidden = false;
            th.querySelector('.think-body').textContent = reasoning;
          }
          else if (ev.type === 'tool_status') {
            addToolRow(turn, ev.tool_name || '?', ev.label || '');
            scrollBottom();
          }
          else if (ev.type === 'tool_done') {
            resolveToolRow(turn, ev.tool_name || '?', !!ev.success);
            tools.push({ name: ev.tool_name || '?', ok: !!ev.success, ms: 0 });
          }
          else if (ev.type === 'error') {
            const text = apiErrorText(ev.error || { message: ev.text }, ev.text || '出错了');
            failed = true;
            addSysLine('✗ ' + text);
            toast(text, 'err');
          }
          else if (ev.type === 'truncated') addSysLine('⚠ ' + (ev.reason || '已截断'));
          else if (ev.type === 'interrupted') addSysLine('已停止生成');
        }
      }
    } catch (e: any) {
      if (e && e.name === 'AbortError') { stopped = true; addSysLine('已停止生成'); }
      else {
        failed = true;
        const text = e && e.message ? e.message : '连接中断，请重试';
        addSysLine('✗ ' + text);
        toast(text, 'err');
      }
    }

    if (renderFrame !== null) {
      window.cancelAnimationFrame(renderFrame);
      renderFrame = null;
      renderQueued = false;
    }
    caret.remove();
    const ms = Date.now() - t0;
    if (failed && !content.trim() && !tools.length) turn.remove();
    else {
      body.innerHTML = mdToHtml(content) ||
        '<p class="empty-reply">' + (stopped ? '（已停止）' : '（无回复）') + '</p>';
      turn.querySelector('.m-time').textContent = fmtTime(Date.now());
      turn.querySelector('.m-dur').textContent = fmtDur(ms);
      turn._raw = content;
    }
    const failedTurn = failed && !content.trim() && !tools.length;
    if (failedTurn) {
      pendingUser.failed = true;
      markPendingUserFailed(cur.name, text, uts, true);
      if (userEl) {
        userEl.classList.add('failed');
        const meta = userEl.querySelector('.msg-meta');
        if (meta && !meta.querySelector('.retry-state')) {
          meta.insertAdjacentHTML('afterbegin', '<span class="retry-state">发送失败，可重试</span>');
        }
      }
    } else {
      delete pendingUser.failed;
      markPendingUserFailed(cur.name, text, uts, false);
      if (userEl) {
        userEl.classList.remove('failed');
        const state = userEl.querySelector('.retry-state');
        if (state) state.remove();
      }
    }
    if (content.trim() || tools.length) {
      pushHist({ r: 'a', t: content, ts: Date.now(), ms, tools });
    }
    if (staleSessionRetried) await syncHistory(cur);
    streaming = false;
    aborter = null;
    setComposer(false);
    scrollBottom();
    inp.focus();
  }

  function stop() { if (aborter) aborter.abort(); }

  function setComposer(busy: boolean) {
    const btn = $('#send-btn');
    btn.classList.toggle('stop', busy);
    btn.title = busy ? '停止生成 (Esc)' : '发送 (Enter)';
    btn.setAttribute('aria-label', busy ? '停止生成' : '发送消息');
    btn.innerHTML = icon(busy ? 'stop' : 'send', busy ? 'stop-ico' : 'send-ico');
    $('#strip-weather').classList.toggle('busy', busy);
    updateRetryButton();
  }

  /* ── composer ── */
  function autosize() {
    const inp = $('#chat-input');
    inp.style.height = 'auto';
    inp.style.height = Math.min(inp.scrollHeight, 160) + 'px';
    const n = inp.value.length;
    const cnt = $('#char-count');
    cnt.textContent = n > 200 ? String(n) : '';
  }

  /* ── retry / export / new session ── */
  function updateRetryButton() {
    const btn = $('#retry-btn');
    if (!btn) return;
    btn.disabled = streaming || resetting || syncing || !loadHist(cur.name).some((entry: any) => entry.r === 'u');
  }
  function retryLast() {
    if (streaming || resetting || syncing) return;
    const last = loadHist(cur.name).filter((entry: any) => entry.r === 'u').pop();
    if (!last) { toast('还没有可重试的消息'); return; }
    const inp = $('#chat-input');
    inp.value = last.t;
    autosize();
    send(last.failed ? last : undefined);
  }

  function closeSessions() {
    const panel = $('#sessions-panel');
    if (!panel) return;
    panel.classList.remove('show');
    $('#sessions-btn').setAttribute('aria-expanded', 'false');
  }

  function closeHealth() {
    const panel = $('#health-panel');
    if (!panel) return;
    panel.classList.remove('show');
    $('#health-btn').setAttribute('aria-expanded', 'false');
  }

  function renderHealth(data: any) {
    const summary = data && data.doctor && data.doctor.summary ? data.doctor.summary : { pass: 0, warn: 0, fail: 0 };
    const runtime = data && data.runtime ? data.runtime.status || {} : {};
    const agents = runtime.agents && runtime.agents.summary ? runtime.agents.summary : {};
    const tools = runtime.tools || {};
    $('#health-state').textContent = data && data.ok ? '健康' : '需处理';
    $('#health-agents').textContent = Number(agents.idle || 0) + '/' + Number(agents.total || 0) + ' 空闲';
    $('#health-tools').textContent = Number(tools.registered || 0) + ' 个 · 失败 ' + Number(tools.failures || 0);

    const actions = $('#health-actions-list');
    actions.innerHTML = '';
    const next = Array.isArray(data.nextActions) ? data.nextActions : [];
    if (!next.length) actions.appendChild(el('p', 'health-empty', '当前没有必须处理的动作'));
    else for (const action of next) actions.appendChild(el('div', 'health-action', escapeHtml(String(action))));

    const checks = $('#health-checks');
    checks.innerHTML = '';
    const items = Array.isArray(data.doctor && data.doctor.checks) ? data.doctor.checks : [];
    for (const check of items) {
      const status = String(check.status || 'warn');
      const row = el('article', 'health-check');
      row.innerHTML =
        '<span class="health-badge ' + status + '">' + escapeHtml(status) + '</span>' +
        '<div><div class="health-check-title"><b>' + escapeHtml(String(check.title || check.id || 'check')) + '</b>' +
        '<span class="health-check-id">' + escapeHtml(String(check.id || '')) + '</span></div>' +
        '<p class="health-check-detail">' + escapeHtml(String(check.detail || '')) + '</p>' +
        (check.action ? '<p class="health-check-action">' + escapeHtml(String(check.action)) + '</p>' : '') +
        '</div>';
      checks.appendChild(row);
    }
    if (!items.length) checks.appendChild(el('p', 'health-empty', '暂无检查项'));
    $('#health-state').title = 'pass ' + Number(summary.pass || 0) + ' · warn ' + Number(summary.warn || 0) + ' · fail ' + Number(summary.fail || 0);
  }

  async function openHealth() {
    const panel = $('#health-panel');
    if (panel.classList.contains('show')) { closeHealth(); return; }
    closeSessions();
    closeSettings();
    $('#keys-modal').classList.remove('show');
    panel.classList.add('show');
    $('#health-btn').setAttribute('aria-expanded', 'true');
    $('#health-loading').hidden = false;
    $('#health-loading').textContent = '正在诊脉…';
    $('#health-content').hidden = true;
    if (healthBusy) return;
    healthBusy = true;
    try {
      const response = await fetch('/api/health');
      if (!response.ok) throw new Error(await readApiError(response, '健康中心暂时无法读取'));
      renderHealth(await response.json());
      $('#health-loading').hidden = true;
      $('#health-content').hidden = false;
      $('#health-close').focus();
    } catch (error: any) {
      const text = error && error.message ? error.message : '健康中心暂时无法读取';
      $('#health-loading').textContent = text;
      toast(text, 'err');
    } finally {
      healthBusy = false;
    }
  }

  /* ── workshop settings ── */
  function closeSettings() {
    const panel = $('#settings-panel');
    if (!panel) return;
    panel.classList.remove('show');
    $('#settings-btn').setAttribute('aria-expanded', 'false');
    clearKeyProvider = null;
  }

  function setSelectValue(select: any, value: string, label?: string) {
    if (![...select.options].some((option: any) => option.value === value)) {
      const option = el('option');
      option.value = value;
      option.textContent = label || value;
      select.appendChild(option);
    }
    select.value = value;
  }

  function fillModelSelect(select: any, data: any, inheritedModel?: string) {
    select.innerHTML = '';
    if (inheritedModel) {
      const inherited = el('option');
      inherited.value = '';
      inherited.textContent = '跟随统一模型 · ' + inheritedModel;
      select.appendChild(inherited);
    }
    const providerNames = new Map((data.providers || []).map((provider: any) => [provider.id, provider.name]));
    const groups = new Map();
    for (const model of data.models || []) {
      if (!groups.has(model.provider)) {
        const group = el('optgroup');
        group.label = providerNames.get(model.provider) || model.provider;
        groups.set(model.provider, group);
        select.appendChild(group);
      }
      const option = el('option');
      option.value = model.id;
      option.textContent = model.id + (model.local ? ' · 本地' : '');
      groups.get(model.provider).appendChild(option);
    }
  }

  function renderSettings(data: any) {
    settingsData = data;
    const agent = (data.agents || []).find((item: any) => item.name === cur.name);
    if (!agent) throw new Error('agent settings unavailable');
    $('#settings-loading').hidden = true;
    $('#settings-content').hidden = false;
    $('#settings-save').disabled = false;
    $('#settings-agent-icon').className = 'weather-doodle img2-icon icon-' + cur.name;
    $('#settings-agent-name').textContent = cur.label;
    clearKeyProvider = null;

    const unifiedSelect = $('#setting-unified-model');
    fillModelSelect(unifiedSelect, data);
    setSelectValue(unifiedSelect, data.defaults.model, data.defaults.model);
    $('#setting-workspace').value = data.runtime.workspacePath || '';

    const modelSelect = $('#setting-model');
    fillModelSelect(modelSelect, data, data.defaults.model);
    setSelectValue(modelSelect, agent.modelSource === 'agent' ? agent.model : '', agent.model);
    $('#setting-temperature').value = String(agent.temperature);
    $('#setting-temperature-value').textContent = Number(agent.temperature).toFixed(2);
    setSelectValue($('#setting-max-tokens'), String(agent.maxTokens), String(agent.maxTokens));
    $('#setting-plan-mode').checked = Boolean(agent.planMode);
    $('#setting-language').value = data.runtime.language;
    $('#setting-approval').value = data.runtime.approvalMode;
    $('#setting-concurrency').value = String(data.runtime.toolConcurrency);
    setSelectValue($('#setting-result-limit'), String(data.runtime.toolResultLimit), String(data.runtime.toolResultLimit));
    $('#setting-dark-mode').checked = themeNow() === 'dark';

    const providerSelect = $('#setting-key-provider');
    const previousProvider = providerSelect.value || agent.provider || '';
    providerSelect.innerHTML = '';
    for (const provider of data.providers || []) {
      const option = el('option');
      option.value = provider.id;
      option.textContent = provider.name + (provider.configured ? ' · 已配置' : '');
      providerSelect.appendChild(option);
    }
    if ([...providerSelect.options].some((option: any) => option.value === previousProvider)) providerSelect.value = previousProvider;
    updateKeyState(true);
  }

  function updateKeyState(syncEndpoint = false) {
    if (!settingsData) return;
    const provider = (settingsData.providers || []).find((item: any) => item.id === $('#setting-key-provider').value);
    const state = $('#setting-key-state');
    const labels: any = { environment: '环境变量', config: '已存本机', local: '本地免密', missing: '待配置' };
    state.textContent = provider ? labels[provider.credentialSource] || '待配置' : '待配置';
    state.className = provider && provider.configured ? 'configured' : '';
    if (syncEndpoint) $('#setting-provider-endpoint').value = provider ? provider.baseUrl || '' : '';
    const clear = $('#setting-clear-key');
    const pending = Boolean(provider && clearKeyProvider === provider.id);
    clear.disabled = !provider || (!provider.canClearKey && !pending);
    clear.classList.toggle('pending', pending);
    clear.textContent = pending ? '撤销清除' : '清除已存 Key';
  }

  function toggleClearKey() {
    if (!settingsData) return;
    const provider = (settingsData.providers || []).find((item: any) => item.id === $('#setting-key-provider').value);
    if (!provider || (!provider.canClearKey && clearKeyProvider !== provider.id)) return;
    clearKeyProvider = clearKeyProvider === provider.id ? null : provider.id;
    if (clearKeyProvider) $('#setting-api-key').value = '';
    updateKeyState(false);
  }

  async function openSettings() {
    const panel = $('#settings-panel');
    if (panel.classList.contains('show')) { closeSettings(); return; }
    closeSessions();
    closeHealth();
    $('#keys-modal').classList.remove('show');
    $('#settings-sheet').scrollTop = 0;
    panel.classList.add('show');
    $('#settings-btn').setAttribute('aria-expanded', 'true');
    $('#settings-loading').hidden = false;
    $('#settings-loading').textContent = '正在展开设置卷册…';
    $('#settings-content').hidden = true;
    $('#settings-save').disabled = true;
    $('#settings-result').textContent = '';
    try {
      const response = await fetch('/api/settings');
      if (!response.ok) throw new Error(await readApiError(response, '设置卷册暂时无法读取'));
      renderSettings(await response.json());
      $('#settings-close').focus();
    } catch (error: any) {
      $('#settings-loading').textContent = error && error.message ? error.message : '设置卷册暂时无法读取';
    }
  }

  async function saveSettings(e: any) {
    e.preventDefault();
    if (settingsBusy || streaming) {
      toast(streaming ? '生成中，停止后再调整运行设置' : '设置正在保存');
      return;
    }
    settingsBusy = true;
    const button = $('#settings-save');
    button.disabled = true;
    $('#settings-result').textContent = '正在落印…';
    const apiKey = $('#setting-api-key').value.trim();
    const payload: any = {
      agent: cur.name,
      unifiedModel: $('#setting-unified-model').value,
      workspacePath: $('#setting-workspace').value.trim(),
      model: $('#setting-model').value || null,
      temperature: Number($('#setting-temperature').value),
      maxTokens: Number($('#setting-max-tokens').value),
      planMode: Boolean($('#setting-plan-mode').checked),
      language: $('#setting-language').value,
      approvalMode: $('#setting-approval').value,
      toolConcurrency: Number($('#setting-concurrency').value),
      toolResultLimit: Number($('#setting-result-limit').value),
      providerEndpoint: {
        provider: $('#setting-key-provider').value,
        baseUrl: $('#setting-provider-endpoint').value.trim() || null,
      },
    };
    if (clearKeyProvider) payload.clearApiKey = { provider: clearKeyProvider };
    else if (apiKey) payload.apiKey = { provider: $('#setting-key-provider').value, value: apiKey };
    try {
      const response = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data: any = await response.json();
      if (!response.ok) throw new Error(apiErrorText(data, '保存失败'));
      $('#setting-api-key').value = '';
      clearKeyProvider = null;
      renderSettings(data);
      $('#settings-result').textContent = '已保存 · 下次对话生效';
      toast('工坊设置已保存');
    } catch (error: any) {
      $('#settings-result').textContent = error && error.message ? error.message : '保存失败';
      toast('设置保存失败', 'err');
    } finally {
      settingsBusy = false;
      button.disabled = false;
    }
  }

  function sessionDate(raw: any): string {
    if (!raw) return '刚刚';
    const source = String(raw);
    const date = new Date(source.includes('T') ? source : source.replace(' ', 'T') + 'Z');
    if (Number.isNaN(date.getTime())) return String(raw);
    const today = new Date();
    const sameDay = date.getFullYear() === today.getFullYear() &&
      date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
    const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return sameDay ? '今天 ' + time : date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + time;
  }

  function normalizeSessionQuery(value: any): string {
    return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
  }

  function applySessionFilter() {
    const input = $('#sessions-filter') as any;
    const query = normalizeSessionQuery(input.value);
    const rows = Array.from(D.querySelectorAll('#sessions-list .session-row')) as any[];
    let matched = 0;
    for (const row of rows) {
      const ok = !query || normalizeSessionQuery(row.dataset.search).includes(query);
      row.classList.toggle('hide', !ok);
      if (ok) matched++;
    }
    $('#sessions-count').textContent = rows.length ? matched + '/' + rows.length + ' 段' : '0 段';
    const empty = $('#sessions-empty-filter');
    empty.textContent = matched || !rows.length ? '' : '没有找到匹配的会话';
    empty.hidden = Boolean(matched || !rows.length);
  }

  function setSessionsBusy(busy: boolean) {
    sessionsBusy = busy;
    D.querySelectorAll('#sessions-list button').forEach((button: any) => { button.disabled = busy; });
  }

  function renderSessions(data: any) {
    const list = $('#sessions-list');
    list.innerHTML = '';
    panelActiveSessionId = typeof data.activeSessionId === 'string' ? data.activeSessionId : null;
    const sessions = Array.isArray(data.sessions) ? data.sessions : [];
    if (!sessions.length) {
      list.appendChild(el('p', 'sessions-empty', '尚无历史会话'));
      applySessionFilter();
      return;
    }
    for (const session of sessions) {
      if (!session || typeof session.id !== 'string') continue;
      const active = session.id === panelActiveSessionId;
      const row = el('div', 'session-row' + (active ? ' active' : ''));
      row.dataset.search = [
        session.preview || '空白会话',
        session.id,
        session.updatedAt || '',
        Number(session.messageCount || 0) + ' 条消息',
        active ? '当前' : '',
      ].join(' ');
      const open = el('button', 'session-open');
      open.type = 'button';
      open.dataset.sessionId = session.id;
      open.setAttribute('aria-label', (active ? '当前会话：' : '恢复会话：') + (session.preview || '空白会话'));
      const preview = el('span', 'session-preview');
      preview.textContent = session.preview || '空白会话';
      const meta = el('span', 'session-meta');
      meta.textContent = sessionDate(session.updatedAt) + ' · ' + Number(session.messageCount || 0) + ' 条消息' + (active ? ' · 当前' : '');
      open.appendChild(preview);
      open.appendChild(meta);
      if (active) open.disabled = true;
      else open.addEventListener('click', () => loadWebSession(session.id));

      const remove = el('button', 'session-delete', '删除');
      remove.type = 'button';
      remove.setAttribute('aria-label', '删除会话：' + (session.preview || '空白会话'));
      remove.addEventListener('click', () => deleteWebSession(session.id));
      row.appendChild(open);
      row.appendChild(remove);
      list.appendChild(row);
    }
    applySessionFilter();
  }

  async function openSessions(refresh?: boolean) {
    const panel = $('#sessions-panel');
    if (panel.classList.contains('show') && !refresh) { closeSessions(); return; }
    closeSettings();
    closeHealth();
    if (streaming || resetting || syncing || sessionsBusy) {
      toast(streaming ? '生成中，先停止再切换会话' : '正在同步会话，请稍候');
      return;
    }
    panel.classList.add('show');
    $('#sessions-btn').setAttribute('aria-expanded', 'true');
    $('#sessions-list').innerHTML = '<p class="sessions-empty">正在翻阅会话…</p>';
    $('#sessions-count').textContent = '0 段';
    $('#sessions-empty-filter').hidden = true;
    sessionsBusy = true;
    const agent = cur;
    try {
      const response = await fetch('/api/sessions?agent=' + encodeURIComponent(agent.name));
      if (!response.ok) throw new Error(await readApiError(response, '无法读取历史会话'));
      const data = await response.json();
      if (isCurrentAgent(agent) && panel.classList.contains('show')) renderSessions(data);
    } catch (error: any) {
      if (isCurrentAgent(agent) && panel.classList.contains('show')) {
        $('#sessions-list').innerHTML = '<p class="sessions-empty error">' +
          escapeHtml(error && error.message ? error.message : '无法读取历史会话') + '</p>';
      }
    } finally {
      sessionsBusy = false;
    }
  }

  async function loadWebSession(sessionId: string) {
    if (sessionsBusy || sessionId === panelActiveSessionId) return;
    const agent = cur;
    setSessionsBusy(true);
    try {
      const response = await fetch('/api/session/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: agent.name, sessionId }),
      });
      if (!response.ok) throw new Error(await readApiError(response, '无法恢复该会话'));
      const data: any = await response.json();
      if (typeof data.sessionId === 'string') store.setItem(SKEY(agent.name), data.sessionId);
      saveHist(agent.name, []);
      if (isCurrentAgent(agent)) {
        closeSessions();
        await syncHistory(agent);
      }
      toast('「' + agent.label + '」历史会话已恢复');
    } catch (error: any) {
      toast(error && error.message ? error.message : '无法恢复该会话', 'err');
    } finally {
      setSessionsBusy(false);
    }
  }

  async function deleteWebSession(sessionId: string) {
    if (sessionsBusy) return;
    if (!window.confirm('删除这段历史会话？此操作不可撤销。')) return;
    const agent = cur;
    const deletingActive = sessionId === panelActiveSessionId;
    let refresh = false;
    setSessionsBusy(true);
    try {
      const response = await fetch('/api/session', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: agent.name, sessionId }),
      });
      if (!response.ok) throw new Error(await readApiError(response, '无法删除该会话'));
      const data: any = await response.json();
      if (typeof data.sessionId === 'string') store.setItem(SKEY(agent.name), data.sessionId);
      if (deletingActive) {
        saveHist(agent.name, []);
        if (isCurrentAgent(agent)) await syncHistory(agent);
      }
      toast('「' + agent.label + '」会话已删除');
      refresh = isCurrentAgent(agent) && $('#sessions-panel').classList.contains('show');
    } catch (error: any) {
      toast(error && error.message ? error.message : '无法删除该会话', 'err');
    } finally {
      setSessionsBusy(false);
    }
    if (refresh) await openSessions(true);
  }

  function exportMd() {
    const h = loadHist(cur.name);
    if (!h.length) { toast('当前会话为空'); return; }
    let doc = '# 水墨气象台 · ' + cur.label + '\n\n';
    for (const e of h) {
      if (e.r === 'u') doc += '## 我\n\n' + e.t + '\n\n';
      else doc += '## ' + cur.label + (e.tools && e.tools.length ? ' （工具 × ' + e.tools.length + '）' : '') + '\n\n' + e.t + '\n\n';
    }
    const blob = new Blob([doc], { type: 'text/markdown;charset=utf-8' });
    const a = el('a');
    a.href = window.URL.createObjectURL(blob);
    a.download = 'skyloom-' + cur.name + '-' + new Date().toISOString().slice(0, 10) + '.md';
    a.click();
    window.URL.revokeObjectURL(a.href);
    toast('已导出会话');
  }
  async function clearSession() {
    if (streaming) { toast('生成中，先停止再开始新会话'); return; }
    if (syncing) { toast('正在同步会话，请稍候'); return; }
    if (resetting) return;
    if (!window.confirm('为「' + cur.label + '」开始新的独立会话？当前上下文将结束。')) return;
    resetting = true;
    const btn = $('#clear-btn');
    btn.disabled = true;
    try {
      const response = await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: cur.name }),
      });
      if (!response.ok) throw new Error(await readApiError(response, '无法开始新会话'));
      const data: any = await response.json();
      if (typeof data.sessionId === 'string') store.setItem(SKEY(cur.name), data.sessionId);
      saveHist(cur.name, []);
      store.removeItem(DKEY(cur.name));
      $('#chat-input').value = '';
      autosize();
      renderHistory();
      updateRetryButton();
      toast('新会话已就绪');
    } catch (error: any) {
      toast(error && error.message ? error.message : '无法开始新会话，请稍后重试', 'err');
    } finally {
      resetting = false;
      btn.disabled = false;
    }
  }

  /* ── status poll ── */
  async function pollStatus() {
    try {
      const r = await fetch('/api/status');
      if (!r.ok) throw new Error('bad');
      const j: any = await r.json();
      $('#conn-dot').classList.remove('off');
      const ws = (j.workspace || '').split(/[\\/]/).filter(Boolean).pop() || '';
      $('#ws-name').innerHTML = ws ? icon('home') + '<span>' + escapeHtml(ws) + '</span>' : '';
    } catch { $('#conn-dot').classList.add('off'); }
  }

  /* ── platform-localized shortcut labels ── */
  function localizeShortcuts() {
    $('#hint').textContent =
      'Enter 发送 · Shift+Enter 换行 · Esc 停止 · ' + AGENT_MOD + '1-6 唤灵 · / 聚焦';
    $('#kbd-agents').textContent = AGENT_MOD + '1 – ' + AGENT_MOD + '6';
    $('#kbd-focus').textContent = CLEAR_MOD + 'K';
    $('#clear-btn').title = '开始新会话';
  }

  /* ── build static chrome ── */
  function buildSidebar() {
    const list = $('#agents-list');
    for (const a of AGENTS) {
      const item = el('button', 'agent-item');
      item.type = 'button';
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', 'false');
      item.setAttribute('aria-label', a.label + ' · ' + a.pig + ' · ' + a.sub);
      item.dataset.agent = a.name;
      item.innerHTML =
        '<span class="a-seal"><span class="weather-doodle img2-icon icon-' + a.name + '" aria-hidden="true"></span></span>' +
        '<span class="a-col"><span class="a-label">' + a.label + '</span>' +
        '<span class="a-sub">' + a.pig + ' · ' + a.sub + '</span></span>';
      item.addEventListener('click', () => {
        if (!streaming && !resetting) applyAgent(a);
        else toast(resetting ? '正在开始新会话' : '生成中，先停止再切换');
      });
      list.appendChild(item);
    }
  }

  /* ── events ── */
  function wire() {
    const inp = $('#chat-input');
    inp.addEventListener('input', () => {
      autosize();
      if (inp.value) store.setItem(DKEY(cur.name), inp.value);
      else store.removeItem(DKEY(cur.name));
    });
    inp.addEventListener('keydown', (e: any) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });
    $('#send-btn').addEventListener('click', () => (streaming ? stop() : send()));
    $('#theme-btn').addEventListener('click', () => setTheme(themeNow() === 'dark' ? 'light' : 'dark'));
    $('#health-btn').addEventListener('click', openHealth);
    $('#health-close').addEventListener('click', closeHealth);
    $('#health-panel').addEventListener('click', (e: any) => {
      if (e.target.id === 'health-panel') closeHealth();
    });
    $('#settings-btn').addEventListener('click', openSettings);
    $('#settings-close').addEventListener('click', closeSettings);
    $('#settings-panel').addEventListener('click', (e: any) => {
      if (e.target.id === 'settings-panel') closeSettings();
    });
    $('#settings-form').addEventListener('submit', saveSettings);
    $('#setting-temperature').addEventListener('input', () => {
      $('#setting-temperature-value').textContent = Number($('#setting-temperature').value).toFixed(2);
    });
    $('#setting-key-provider').addEventListener('change', () => {
      clearKeyProvider = null;
      updateKeyState(true);
    });
    $('#setting-clear-key').addEventListener('click', toggleClearKey);
    $('#setting-unified-model').addEventListener('change', () => {
      const inherited = $('#setting-model').options[0];
      if (inherited && inherited.value === '') inherited.textContent = '跟随统一模型 · ' + $('#setting-unified-model').value;
    });
    $('#setting-dark-mode').addEventListener('change', () => {
      setTheme($('#setting-dark-mode').checked ? 'dark' : 'light');
    });
    $('#retry-btn').addEventListener('click', retryLast);
    $('#sessions-btn').addEventListener('click', () => openSessions());
    $('#sessions-close').addEventListener('click', closeSessions);
    $('#sessions-filter').addEventListener('input', applySessionFilter);
    $('#sessions-panel').addEventListener('click', (e: any) => {
      if (e.target.id === 'sessions-panel') closeSessions();
    });
    $('#export-btn').addEventListener('click', exportMd);
    $('#clear-btn').addEventListener('click', clearSession);
    $('#keys-btn').addEventListener('click', () => $('#keys-modal').classList.toggle('show'));
    $('#keys-modal').addEventListener('click', (e: any) => {
      if (e.target.id === 'keys-modal') $('#keys-modal').classList.remove('show');
    });
    $('#scroll-pill').addEventListener('click', () => scrollBottom(true));
    msgs().addEventListener('scroll', () => { if (nearBottom()) hidePill(); });

    // delegated copy: code blocks + per-message raw markdown
    msgs().addEventListener('click', (e: any) => {
      const cb = e.target.closest && e.target.closest('.cb-copy');
      if (cb) {
        const code = cb.closest('.codeblock').querySelector('code');
        window.navigator.clipboard.writeText(code.textContent).then(
          () => {
            cb.innerHTML = icon('check'); cb.setAttribute('aria-label', '已复制');
            setTimeout(() => { cb.innerHTML = icon('copy'); cb.setAttribute('aria-label', '复制代码'); }, 1500);
          },
          () => toast('复制失败', 'err'));
        return;
      }
      const mc = e.target.closest && e.target.closest('.m-copy');
      if (mc) {
        const turn = mc.closest('.msg.assistant');
        window.navigator.clipboard.writeText(turn._raw || turn.querySelector('.msg-body').textContent)
          .then(() => {
            mc.innerHTML = icon('check'); mc.setAttribute('aria-label', '已复制');
            setTimeout(() => { mc.innerHTML = icon('copy'); mc.setAttribute('aria-label', '复制原文'); }, 1500);
            toast('已复制回复原文');
          }, () => toast('复制失败', 'err'));
      }
    });

    D.addEventListener('keydown', (e: any) => {
      if (e.key === 'Escape') {
        if (streaming) { stop(); return; }
        closeSessions();
        closeHealth();
        closeSettings();
        $('#keys-modal').classList.remove('show');
        return;
      }
      const typing = D.activeElement && D.activeElement.tagName === 'TEXTAREA';
      // e.code (physical key) instead of e.key: on macOS Option+digit produces
      // special characters (¡™£…), and layouts vary — Digit1..6 does not.
      const digit = e.code && /^Digit[1-6]$/.test(e.code) ? Number(e.code.slice(5)) : 0;
      if ((e.metaKey || e.ctrlKey || e.altKey) && digit) {
        e.preventDefault();
        if (!streaming && !resetting) applyAgent(AGENTS[digit - 1]);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault(); inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); return;
      }
      if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault(); inp.focus(); return;
      }
      if (e.key === '?' && !typing) $('#keys-modal').classList.toggle('show');
    });
  }

  /* ── boot ── */
  buildSidebar();
  wire();
  localizeShortcuts();
  const savedTheme = store.getItem('skyweb.theme') ||
    (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  setTheme(savedTheme);
  const savedAgent = AGENTS.find((a: any) => a.name === store.getItem('skyweb.agent')) || AGENTS[0];
  applyAgent(savedAgent);
  pollStatus();
  setInterval(pollStatus, 25000);
}
