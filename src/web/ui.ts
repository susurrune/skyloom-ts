/**
 * 水墨气象台 · 宣纸/夜墨 enterprise web UI.
 *
 * Design system: refined ink-wash ("xuan paper" light / "night ink" dark),
 * agent pigment theming, ambient weather particles — deliberately rich, not
 * minimal. Interaction layer is enterprise-grade: markdown + highlighted code
 * with copy, live tool-call timeline, collapsible reasoning, stop-generation,
 * per-agent session persistence, export, smart autoscroll, toasts, keyboard
 * shortcuts, dark mode, reduced-motion support.
 *
 * Zero external JS dependencies. The client script is authored here as a real
 * TypeScript function (`clientMain`) and injected via `Function.toString()`,
 * together with the isomorphic markdown renderer (src/web/markdown.ts) — so
 * the browser code is type-checked by tsc and the renderer is unit-tested in
 * Node. Cross-references stay bare-name (no imports inside the injected fns).
 */

import * as md from './markdown';

/* Ambient declarations for the injected browser code. tsc lib is ES2020 (no
   DOM), so the few browser globals the client uses are declared loosely here.
   The markdown functions are injected alongside clientMain, hence bare-name. */
declare const document: any;
declare const window: any;
declare function mdToHtml(s: string): string;
declare function escapeHtml(s: string): string;

export interface AgentMeta {
  name: string;
  label: string;     // 雾 Fog
  kanji: string;     // 霧
  pig: string;       // pigment name 松烟墨
  sub: string;       // specialty 探索洞察
  poem: string;
  light: string;     // pigment color on paper
  dark: string;      // pigment color on night ink
  particles: 'mist' | 'rainfall' | 'frostc' | 'snowp' | 'dewb' | 'sunm';
  tips: string[];    // welcome suggestions
}

export const AGENTS_META: AgentMeta[] = [
  { name: 'fog',   label: '雾 Fog',   kanji: '霧', pig: '松烟墨', sub: '探索洞察', poem: '山色有无中',
    light: '#4a4a44', dark: '#a8a294', particles: 'mist',
    tips: ['帮我调研一下这个技术选型', '解释一下这段代码在做什么', '对比这两种方案的取舍'] },
  { name: 'rain',  label: '雨 Rain',  kanji: '雨', pig: '石青',   sub: '创造产出', poem: '一蓑烟雨任平生',
    light: '#2a5c8a', dark: '#6ea6dc', particles: 'rainfall',
    tips: ['写一个解析 CSV 的工具函数', '实现一个防抖 Hook', '把这段逻辑重构得更清晰'] },
  { name: 'frost', label: '霜 Frost', kanji: '霜', pig: '石绿',   sub: '精炼品质', poem: '月落乌啼霜满天',
    light: '#3a7a6e', dark: '#67c2af', particles: 'frostc',
    tips: ['审查这段代码有什么问题', '找出这个函数的潜在 bug', '这段实现还能怎么优化'] },
  { name: 'snow',  label: '雪 Snow',  kanji: '雪', pig: '铅白',   sub: '架构规划', poem: '千树万树梨花开',
    light: '#6e6e66', dark: '#b6b6aa', particles: 'snowp',
    tips: ['帮我规划这个项目的里程碑', '设计一个清晰的模块边界', '把这个大任务拆成步骤'] },
  { name: 'dew',   label: '露 Dew',   kanji: '露', pig: '赭石',   sub: '可靠守护', poem: '金风玉露一相逢',
    light: '#8b6914', dark: '#d2a83e', particles: 'dewb',
    tips: ['排查一下这个部署报错', '写一份 CI 工作流配置', '这个服务怎么做健康检查'] },
  { name: 'fair',  label: '晴 Fair',  kanji: '晴', pig: '朱砂',   sub: '情感陪伴', poem: '道是无晴却有晴',
    light: '#b3342d', dark: '#e0635a', particles: 'sunm',
    tips: ['今天有点累，陪我聊聊', '讲一个温柔的小故事', '给我一点出发的勇气'] },
];

/* ════════════════════════════════════════════════════════════════
   Client application — injected verbatim via toString().
   Everything it needs is nested inside or globally injected.
   ════════════════════════════════════════════════════════════════ */
function clientMain(): void {
  const BOOT = window.__SKYLOOM__;
  const AGENTS: any[] = BOOT.agents;
  const store = window.localStorage;
  const D = document;

  /* ── state ── */
  let cur = AGENTS[0];
  let streaming = false;
  let aborter: any = null;
  let unread = 0;

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
  const fmtTime = (ts: number) =>
    new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const fmtDur = (ms: number) => (ms < 1000 ? Math.round(ms) + 'ms' : (ms / 1000).toFixed(1) + 's');

  function toast(text: string, kind?: string) {
    const t = el('div', 'toast' + (kind ? ' ' + kind : ''), escapeHtml(text));
    $('#toasts').appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 350); }, 2400);
  }

  /* ── theme (宣纸 / 夜墨) ── */
  function themeNow(): string { return D.documentElement.getAttribute('data-theme') || 'light'; }
  function setTheme(mode: string) {
    D.documentElement.setAttribute('data-theme', mode);
    store.setItem('skyweb.theme', mode);
    $('#theme-btn').textContent = mode === 'dark' ? '☀' : '☾';
    paintPigment();
  }
  function paintPigment() {
    const c = themeNow() === 'dark' ? cur.dark : cur.light;
    D.documentElement.style.setProperty('--pigment', c);
    D.documentElement.style.setProperty('--pigment-soft', c + '1f');
    D.documentElement.style.setProperty('--pigment-faint', c + '14');
  }

  /* ── history (per-agent, localStorage) ── */
  const HKEY = (a: string) => 'skyweb.h.' + a;
  function loadHist(a: string): any[] {
    try { return JSON.parse(store.getItem(HKEY(a)) || '[]'); } catch { return []; }
  }
  function saveHist(a: string, h: any[]) {
    try { store.setItem(HKEY(a), JSON.stringify(h.slice(-120))); } catch { /* quota */ }
  }
  function pushHist(entry: any) {
    const h = loadHist(cur.name); h.push(entry); saveHist(cur.name, h);
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
    cur = a;
    D.documentElement.setAttribute('data-agent', a.name);
    paintPigment();
    buildParticles(a.particles);
    $('#kanji-seal').textContent = a.kanji;
    $('#strip-name').textContent = a.label;
    $('#strip-pig').textContent = a.pig + ' · ' + a.sub;
    $('#verse').textContent = a.poem;
    D.querySelectorAll('.agent-item').forEach((e: any) =>
      e.classList.toggle('active', e.dataset.agent === a.name));
    if (!opts || !opts.keepMsgs) renderHistory();
    $('#chat-input').focus();
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

  function addUserMsg(text: string, ts: number) {
    const w = el('div', 'msg user');
    w.innerHTML = '<div class="msg-body">' + escapeHtml(text).replace(/\n/g, '<br>') +
      '</div><span class="msg-meta">' + fmtTime(ts) + '</span>';
    msgs().appendChild(w);
  }

  function addSysLine(text: string) {
    msgs().appendChild(el('div', 'sysline', escapeHtml(text)));
  }

  /** An assistant turn: reasoning ▸ tool rail ▸ markdown body ▸ meta. */
  function addTurn(): any {
    const w = el('div', 'msg assistant');
    w.innerHTML =
      '<div class="turn-seal">' + cur.kanji + '</div>' +
      '<div class="turn-main">' +
        '<details class="think" hidden><summary>思考过程</summary><div class="think-body"></div></details>' +
        '<div class="tools" hidden></div>' +
        '<div class="msg-body"><span class="caret"></span></div>' +
        '<div class="msg-meta"><span class="m-time"></span><span class="m-dur"></span>' +
        '<button class="m-copy" type="button" title="复制原文">复制</button></div>' +
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
      '<div class="w-seal">' + cur.kanji + '</div>' +
      '<div class="w-poem">' + escapeHtml(cur.poem) + '</div>' +
      '<div class="w-sub">' + escapeHtml(cur.pig + ' · ' + cur.sub) + '</div>' +
      '<div class="w-tips">' + cur.tips.map((t: string) =>
        '<button class="w-tip" type="button">' + escapeHtml(t) + '</button>').join('') + '</div>';
    msgs().appendChild(w);
    w.querySelectorAll('.w-tip').forEach((b: any) => b.addEventListener('click', () => {
      const inp = $('#chat-input'); inp.value = b.textContent; inp.focus(); autosize();
    }));
  }

  function renderHistory() {
    const m = msgs();
    m.innerHTML = '';
    const h = loadHist(cur.name);
    if (!h.length) { renderWelcome(); return; }
    for (const e of h) {
      if (e.r === 'u') addUserMsg(e.t, e.ts);
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
  }

  /* ── streaming chat ── */
  async function send() {
    const inp = $('#chat-input');
    const text = inp.value.trim();
    if (!text || streaming) return;
    inp.value = ''; autosize();
    const wEl = msgs().querySelector('.welcome'); if (wEl) wEl.remove();

    streaming = true;
    setComposer(true);
    const t0 = Date.now();
    const uts = Date.now();
    addUserMsg(text, uts);
    pushHist({ r: 'u', t: text, ts: uts });
    scrollBottom(true);

    const turn = addTurn();
    const body = turn.querySelector('.msg-body');
    const caret = turn.querySelector('.caret');
    let content = '';
    let reasoning = '';
    const tools: any[] = [];
    let renderQueued = false;
    const queueRender = () => {
      if (renderQueued) return;
      renderQueued = true;
      window.requestAnimationFrame(() => {
        renderQueued = false;
        body.innerHTML = mdToHtml(content);
        body.appendChild(caret);
        scrollBottom(); bumpPill();
      });
    };

    aborter = new AbortController();
    let stopped = false;
    try {
      const resp = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, agent: cur.name }),
        signal: aborter.signal,
      });
      if (!resp.ok || !resp.body) throw new Error('HTTP ' + resp.status);
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
          else if (ev.type === 'error') addSysLine('✗ ' + (ev.text || '出错了'));
          else if (ev.type === 'truncated') addSysLine('⚠ ' + (ev.reason || '已截断'));
          else if (ev.type === 'interrupted') addSysLine('已停止生成');
        }
      }
    } catch (e: any) {
      if (e && e.name === 'AbortError') { stopped = true; addSysLine('已停止生成'); }
      else { addSysLine('✗ 连接中断'); toast('连接中断，请重试', 'err'); }
    }

    caret.remove();
    const ms = Date.now() - t0;
    body.innerHTML = mdToHtml(content) ||
      '<p class="empty-reply">' + (stopped ? '（已停止）' : '（无回复）') + '</p>';
    turn.querySelector('.m-time').textContent = fmtTime(Date.now());
    turn.querySelector('.m-dur').textContent = fmtDur(ms);
    turn._raw = content;
    if (content.trim() || tools.length) {
      pushHist({ r: 'a', t: content, ts: Date.now(), ms, tools });
    }
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
    btn.innerHTML = busy ? '<span class="stop-ico"></span>' : '<span class="send-ico">➤</span>';
    $('#strip-dot').classList.toggle('busy', busy);
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

  /* ── export / clear ── */
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
  function clearSession() {
    if (!loadHist(cur.name).length) { toast('当前会话已是空的'); return; }
    if (!window.confirm('清空「' + cur.label + '」的本地会话记录？')) return;
    saveHist(cur.name, []);
    renderHistory();
    toast('已清空会话');
  }

  /* ── status poll ── */
  async function pollStatus() {
    try {
      const r = await fetch('/api/status');
      if (!r.ok) throw new Error('bad');
      const j: any = await r.json();
      $('#conn-dot').classList.remove('off');
      const ws = (j.workspace || '').split('/').filter(Boolean).pop() || '';
      $('#ws-name').textContent = ws ? '⌂ ' + ws : '';
    } catch { $('#conn-dot').classList.add('off'); }
  }

  /* ── platform-localized shortcut labels ── */
  function localizeShortcuts() {
    $('#hint').textContent =
      'Enter 发送 · Shift+Enter 换行 · Esc 停止 · ' + AGENT_MOD + '1-6 唤灵 · ? 快捷键';
    $('#kbd-agents').textContent = AGENT_MOD + '1 – ' + AGENT_MOD + '6';
    $('#kbd-clear').textContent = CLEAR_MOD + 'K';
    $('#clear-btn').title = '清空当前会话 (' + CLEAR_MOD + 'K)';
  }

  /* ── build static chrome ── */
  function buildSidebar() {
    const list = $('#agents-list');
    for (const a of AGENTS) {
      const item = el('div', 'agent-item');
      item.dataset.agent = a.name;
      item.innerHTML =
        '<span class="a-seal">' + a.kanji + '</span>' +
        '<span class="a-col"><span class="a-label">' + a.label + '</span>' +
        '<span class="a-sub">' + a.pig + ' · ' + a.sub + '</span></span>';
      item.addEventListener('click', () => { if (!streaming) applyAgent(a); else toast('生成中，先停止再切换'); });
      list.appendChild(item);
    }
  }

  /* ── events ── */
  function wire() {
    const inp = $('#chat-input');
    inp.addEventListener('input', autosize);
    inp.addEventListener('keydown', (e: any) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });
    $('#send-btn').addEventListener('click', () => (streaming ? stop() : send()));
    $('#theme-btn').addEventListener('click', () => setTheme(themeNow() === 'dark' ? 'light' : 'dark'));
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
          () => { cb.textContent = '已复制'; setTimeout(() => { cb.textContent = '复制'; }, 1500); },
          () => toast('复制失败', 'err'));
        return;
      }
      const mc = e.target.closest && e.target.closest('.m-copy');
      if (mc) {
        const turn = mc.closest('.msg.assistant');
        window.navigator.clipboard.writeText(turn._raw || turn.querySelector('.msg-body').textContent)
          .then(() => toast('已复制回复原文'), () => toast('复制失败', 'err'));
      }
    });

    D.addEventListener('keydown', (e: any) => {
      if (e.key === 'Escape') {
        if (streaming) { stop(); return; }
        $('#keys-modal').classList.remove('show');
        return;
      }
      const typing = D.activeElement && D.activeElement.tagName === 'TEXTAREA';
      // e.code (physical key) instead of e.key: on macOS Option+digit produces
      // special characters (¡™£…), and layouts vary — Digit1..6 does not.
      const digit = e.code && /^Digit[1-6]$/.test(e.code) ? Number(e.code.slice(5)) : 0;
      if ((e.metaKey || e.ctrlKey || e.altKey) && digit) {
        e.preventDefault();
        if (!streaming) applyAgent(AGENTS[digit - 1]);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); clearSession(); return; }
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
  applyAgent(AGENTS[0]);
  pollStatus();
  setInterval(pollStatus, 25000);
}

/* ════════════════════════════════════════════════════════════════
   Page
   ════════════════════════════════════════════════════════════════ */
export function renderInkWashUI(): string {
  return `<!DOCTYPE html>
<html lang="zh" data-theme="light" data-agent="fog">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta name="color-scheme" content="light dark">
<title>水墨气象台 · Skyloom</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Cdefs%3E%3CradialGradient id='g' cx='50%25' cy='45%25' r='50%25'%3E%3Cstop offset='0%25' stop-color='%23f8f4ec'/%3E%3Cstop offset='100%25' stop-color='%23e8e0d0'/%3E%3C/radialGradient%3E%3C/defs%3E%3Ccircle cx='32' cy='32' r='30' fill='url(%23g)' stroke='%234a4a44' stroke-width='1.5'/%3E%3Cpath d='M20 28 Q24 22 32 24 Q40 22 44 28' stroke='%234a4a44' stroke-width='1.2' fill='none' stroke-linecap='round' opacity='.6'/%3E%3Cpath d='M18 34 Q26 30 32 32 Q38 30 46 34' stroke='%234a4a44' stroke-width='1' fill='none' stroke-linecap='round' opacity='.4'/%3E%3Cpath d='M22 40 Q28 37 32 38 Q36 37 42 40' stroke='%234a4a44' stroke-width='.8' fill='none' stroke-linecap='round' opacity='.25'/%3E%3Ccircle cx='22' cy='22' r='2.5' fill='%232a5c8a' opacity='.7'/%3E%3Ccircle cx='42' cy='22' r='2.5' fill='%23b3342d' opacity='.7'/%3E%3Ccircle cx='32' cy='46' r='2.5' fill='%233a7a6e' opacity='.7'/%3E%3Ctext x='32' y='36' text-anchor='middle' font-family='serif' font-size='11' font-weight='600' fill='%234a4a44' opacity='.8'%3E織%3C/text%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@300;400;600;700&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>
/* ═══════════ tokens · 宣纸 (light) ═══════════ */
:root{
  --paper:#f7f3e9; --paper-2:#f1ebdd; --card:rgba(255,255,255,.5);
  --card-solid:#fffdf6;
  --ink:#1c1814; --ink-2:#46403a; --ink-3:#8c8478; --ink-4:#c8c0b2;
  --line:rgba(120,105,80,.16); --line-soft:rgba(120,105,80,.09);
  --pigment:#4a4a44; --pigment-soft:#4a4a441f; --pigment-faint:#4a4a4414;
  --ok:#3a7a4e; --err:#b3342d;
  --shadow:0 2px 14px rgba(80,60,30,.07),0 1px 3px rgba(80,60,30,.05);
  --shadow-lift:0 6px 24px rgba(80,60,30,.11),0 2px 6px rgba(80,60,30,.07);
  --gutter:clamp(20px,4.5vw,52px); --sidebar-w:228px; --radius:10px;
  --grain-op:.30; --ambient-op:.65; --mount-op:.12;
}
/* ═══════════ tokens · 夜墨 (dark) ═══════════ */
[data-theme=dark]{
  --paper:#15171b; --paper-2:#101216; --card:rgba(255,255,255,.035);
  --card-solid:#1c1f24;
  --ink:#dcd8cd; --ink-2:#b2ada1; --ink-3:#7d786e; --ink-4:#46423b;
  --line:rgba(220,210,190,.12); --line-soft:rgba(220,210,190,.06);
  --ok:#5fae76; --err:#e0635a;
  --shadow:0 2px 14px rgba(0,0,0,.35),0 1px 3px rgba(0,0,0,.3);
  --shadow-lift:0 6px 26px rgba(0,0,0,.5),0 2px 8px rgba(0,0,0,.35);
  --grain-op:.10; --ambient-op:.4; --mount-op:.2;
}
*,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%;overflow:hidden}
body{
  font-family:'Noto Serif SC',Georgia,serif;background:var(--paper);color:var(--ink);
  display:flex;height:100vh;font-size:15.5px;line-height:1.85;
  -webkit-font-smoothing:antialiased;
  transition:background .5s ease,color .5s ease;
}

/* ═══════════ paper grain + mountain mist ═══════════ */
#grain{position:fixed;inset:0;z-index:0;pointer-events:none;opacity:var(--grain-op);
  background:
    repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(139,119,90,.022) 2px,rgba(139,119,90,.022) 4px),
    repeating-linear-gradient(90deg,transparent,transparent 3px,rgba(139,119,90,.013) 3px,rgba(139,119,90,.013) 6px),
    linear-gradient(135deg,rgba(80,60,30,.05) 0%,transparent 14%,transparent 86%,rgba(80,60,30,.05) 100%);
  transition:opacity .5s;
}
#grain::before{content:'';position:fixed;top:0;left:0;right:0;height:clamp(90px,13vh,170px);
  pointer-events:none;opacity:var(--mount-op);
  background:
    radial-gradient(ellipse 120% 100% at 22% 100%,rgba(60,55,50,.5) 0%,transparent 46%),
    radial-gradient(ellipse 85% 70% at 52% 100%,rgba(50,45,40,.4) 0%,transparent 56%),
    radial-gradient(ellipse 100% 60% at 72% 100%,rgba(70,65,60,.3) 0%,transparent 60%),
    radial-gradient(ellipse 140% 90% at 60% 100%,rgba(65,60,55,.16) 0%,transparent 72%);
  mask:linear-gradient(0deg,transparent 0%,#000 100%);
  -webkit-mask:linear-gradient(0deg,transparent 0%,#000 100%);
}

/* ═══════════ ambient particles per agent ═══════════ */
#ambient-layer{position:fixed;inset:0;z-index:0;pointer-events:none;opacity:var(--ambient-op);transition:opacity .6s}
.pwrap{position:absolute;inset:0;overflow:hidden}
.pwrap i{position:absolute}
.pwrap.mist i{border-radius:50%;background:rgba(160,155,145,.10);filter:blur(18px);
  width:calc(var(--sz) * 16);height:calc(var(--sz) * 5);left:var(--x);top:var(--y);
  animation:p-mist var(--dur) linear infinite;animation-delay:var(--delay)}
@keyframes p-mist{0%{transform:translateX(-34px);opacity:.25}50%{transform:translateX(40px);opacity:.7}100%{transform:translateX(-34px);opacity:.25}}
.pwrap.rainfall i{width:1px;height:calc(var(--sz) * 5);left:var(--x);top:-10%;
  background:linear-gradient(0deg,var(--pigment),transparent);opacity:.22;
  animation:p-rain calc(var(--dur) / 5) linear infinite;animation-delay:var(--delay)}
@keyframes p-rain{0%{transform:translateY(-12vh)}100%{transform:translateY(112vh)}}
.pwrap.frostc i{width:var(--sz);height:var(--sz);left:var(--x);top:var(--y);background:var(--pigment);opacity:.16;
  clip-path:polygon(50% 0%,100% 50%,50% 100%,0% 50%);
  animation:p-frost var(--dur) ease-in-out infinite;animation-delay:var(--delay)}
@keyframes p-frost{0%,100%{opacity:.08;transform:scale(.8) rotate(0deg)}50%{opacity:.5;transform:scale(1.4) rotate(45deg)}}
.pwrap.snowp i{border-radius:50%;background:rgba(190,188,180,.18);width:calc(var(--sz) * .8);height:calc(var(--sz) * .8);
  left:var(--x);top:-5%;animation:p-snow var(--dur) linear infinite;animation-delay:var(--delay)}
@keyframes p-snow{0%{transform:translateY(-5vh) translateX(0)}30%{transform:translateY(32vh) translateX(16px)}60%{transform:translateY(64vh) translateX(-12px)}100%{transform:translateY(112vh) translateX(6px)}}
.pwrap.dewb i{border-radius:50%;width:var(--sz);height:var(--sz);left:var(--x);bottom:calc(var(--y) / 4);
  background:radial-gradient(circle at 38% 32%,var(--pigment-soft),transparent 70%);
  animation:p-dew var(--dur) ease-in-out infinite;animation-delay:var(--delay)}
@keyframes p-dew{0%,100%{opacity:.3;transform:scale(1)}50%{opacity:.85;transform:scale(1.6)}}
.pwrap.sunm i{border-radius:50%;background:var(--pigment);opacity:.12;width:calc(var(--sz) / 2.5);height:calc(var(--sz) / 2.5);
  left:var(--x);bottom:-4%;animation:p-sun var(--dur) ease-in infinite;animation-delay:var(--delay)}
@keyframes p-sun{0%{transform:translateY(0) translateX(0);opacity:0}18%{opacity:.5}80%{opacity:.25}100%{transform:translateY(-105vh) translateX(var(--drift));opacity:0}}

/* big kanji seal */
#kanji-seal{position:fixed;right:clamp(18px,4.5vw,52px);bottom:clamp(86px,15vh,150px);z-index:0;pointer-events:none;
  font-size:clamp(2.6rem,6vw,4.6rem);font-weight:700;user-select:none;color:var(--pigment);opacity:.055;
  border:2px solid var(--pigment);border-radius:6px;padding:clamp(5px,1vw,12px) clamp(7px,1.4vw,16px);
  writing-mode:vertical-rl;letter-spacing:.12em;transition:color .7s,border-color .7s;
  animation:seal-breathe 9s ease-in-out infinite}
@keyframes seal-breathe{0%,100%{opacity:.045;transform:scale(1)}50%{opacity:.085;transform:scale(1.015)}}

/* ═══════════ sidebar ═══════════ */
#sidebar{width:var(--sidebar-w);flex-shrink:0;position:relative;z-index:2;
  padding:clamp(22px,4.5vh,44px) clamp(16px,2.2vw,24px) 18px;
  display:flex;flex-direction:column;
  background:linear-gradient(90deg,var(--line-soft),transparent 55%);
  border-right:1px solid var(--line-soft)}
#logo{ text-align:center;margin-bottom:clamp(22px,5.5vh,44px)}
#logo b{font-size:clamp(1.35rem,2.2vw,1.7rem);font-weight:700;letter-spacing:.22em;display:block}
#logo small{font-weight:300;font-size:.66rem;color:var(--ink-3);letter-spacing:.34em;text-transform:lowercase}

#agents-list{display:flex;flex-direction:column;gap:3px;flex:1;overflow-y:auto;scrollbar-width:none}
#agents-list::-webkit-scrollbar{display:none}
.agent-item{display:flex;align-items:center;gap:11px;padding:10px 12px;cursor:pointer;border-radius:8px;
  border-left:2px solid transparent;transition:background .3s,border-color .3s,transform .15s}
.agent-item:hover{background:var(--line-soft);transform:translateX(2px)}
.agent-item.active{background:var(--pigment-faint);border-left-color:var(--pigment)}
.a-seal{width:34px;height:34px;flex-shrink:0;display:flex;align-items:center;justify-content:center;
  font-size:1.05rem;font-weight:700;color:var(--ink-3);border:1.5px solid var(--line);border-radius:7px;
  transition:color .3s,border-color .3s,box-shadow .3s}
.agent-item.active .a-seal{color:var(--pigment);border-color:var(--pigment);box-shadow:0 0 0 3px var(--pigment-faint)}
.a-col{display:flex;flex-direction:column;line-height:1.45;min-width:0}
.a-label{font-size:.9rem;font-weight:600;color:var(--ink-2)}
.agent-item.active .a-label{color:var(--ink)}
.a-sub{font-size:.67rem;color:var(--ink-3);font-weight:300;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

#side-foot{margin-top:14px;padding-top:14px;border-top:1px solid var(--line-soft);
  display:flex;flex-direction:column;gap:10px}
#side-status{display:flex;align-items:center;gap:8px;font-size:.7rem;color:var(--ink-3)}
#conn-dot{width:7px;height:7px;border-radius:50%;background:var(--ok);box-shadow:0 0 6px var(--ok);transition:background .3s}
#conn-dot.off{background:var(--err);box-shadow:0 0 6px var(--err)}
#ws-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#side-actions{display:flex;gap:6px}
.side-btn{flex:1;background:none;border:1px solid var(--line);border-radius:7px;color:var(--ink-3);
  font-family:inherit;font-size:.78rem;padding:6px 0;cursor:pointer;transition:all .25s}
.side-btn:hover{color:var(--pigment);border-color:var(--pigment)}
#verse{text-align:center;font-size:.7rem;color:var(--ink-3);font-style:italic;letter-spacing:.08em;font-weight:300}

/* ═══════════ main ═══════════ */
#main{flex:1;display:flex;flex-direction:column;position:relative;z-index:1;min-width:0}
#strip{display:flex;align-items:center;gap:11px;padding:clamp(11px,2.6vh,17px) var(--gutter);position:relative}
#strip::after{content:'';position:absolute;bottom:0;left:var(--gutter);right:var(--gutter);height:1px;
  background:linear-gradient(90deg,transparent,var(--line) 18%,var(--line) 82%,transparent)}
#strip-dot{width:7px;height:7px;border-radius:50%;background:var(--pigment);flex-shrink:0;transition:background .5s;
  animation:dot-idle 3s ease-in-out infinite}
#strip-dot.busy{animation:dot-busy .9s ease-in-out infinite}
@keyframes dot-idle{0%,100%{opacity:.45}50%{opacity:1}}
@keyframes dot-busy{0%,100%{opacity:.35;transform:scale(.85)}50%{opacity:1;transform:scale(1.5)}}
#strip-name{font-weight:600;font-size:.95rem;letter-spacing:.05em}
#strip-pig{font-size:.74rem;color:var(--ink-3);font-weight:300}
#strip-sp{flex:1}
.strip-btn{background:none;border:none;color:var(--ink-3);font-family:inherit;font-size:.78rem;cursor:pointer;
  padding:5px 10px;border-radius:7px;transition:all .25s;letter-spacing:.04em}
.strip-btn:hover{color:var(--pigment);background:var(--pigment-faint)}

/* ═══════════ messages ═══════════ */
#messages{flex:1;overflow-y:auto;padding:var(--gutter) var(--gutter) calc(var(--gutter) * .6);
  display:flex;flex-direction:column;gap:clamp(16px,3vh,26px);scroll-behavior:smooth}
#messages::-webkit-scrollbar{width:5px}
#messages::-webkit-scrollbar-track{background:transparent}
#messages::-webkit-scrollbar-thumb{background:var(--ink-4);border-radius:3px}

.msg{max-width:72%;animation:msg-in .45s cubic-bezier(.2,.8,.25,1) both}
@keyframes msg-in{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}

.msg.user{align-self:flex-end}
.msg.user .msg-body{padding:10px 16px;color:var(--ink);background:var(--pigment-faint);
  border-right:2.5px solid var(--pigment);border-radius:10px 3px 3px 10px;text-align:left;
  box-shadow:var(--shadow);white-space:normal;word-break:break-word}
.msg.user .msg-meta{text-align:right}

.msg.assistant{align-self:flex-start;display:flex;gap:12px;max-width:78%}
.turn-seal{width:32px;height:32px;flex-shrink:0;margin-top:2px;display:flex;align-items:center;justify-content:center;
  font-size:.98rem;font-weight:700;color:var(--pigment);border:1.5px solid var(--pigment);border-radius:7px;
  opacity:.85;background:var(--card);transition:color .5s,border-color .5s}
.turn-main{min-width:0;flex:1}
.msg.assistant .msg-body{padding:13px 17px;color:var(--ink-2);background:var(--card);
  border:1px solid var(--line-soft);border-left:3px solid var(--pigment);border-radius:3px 11px 11px 3px;
  box-shadow:var(--shadow);transition:border-color .5s,background .5s;backdrop-filter:blur(6px);
  word-break:break-word}
.msg.assistant .msg-body:hover{box-shadow:var(--shadow-lift)}

.msg-meta{display:flex;align-items:center;gap:10px;font-size:.66rem;color:var(--ink-4);
  margin-top:6px;letter-spacing:.07em}
.m-copy{background:none;border:none;color:var(--ink-4);font-family:inherit;font-size:.66rem;cursor:pointer;
  padding:1px 4px;opacity:0;transition:all .25s;letter-spacing:.07em}
.msg.assistant:hover .m-copy{opacity:1}
.m-copy:hover{color:var(--pigment)}

.sysline{align-self:center;font-size:.72rem;color:var(--ink-3);font-style:italic;letter-spacing:.05em;
  animation:msg-in .4s ease both}

/* streaming caret */
.caret{display:inline-block;width:2px;height:1.05em;background:var(--pigment);vertical-align:-.15em;
  margin-left:2px;animation:caret-blink 1s steps(1) infinite}
@keyframes caret-blink{50%{opacity:0}}
.empty-reply{color:var(--ink-3);font-style:italic}

/* ── reasoning (思考) ── */
.think{margin-bottom:9px;border:1px dashed var(--line);border-radius:8px;background:var(--line-soft)}
.think summary{cursor:pointer;font-size:.72rem;color:var(--ink-3);padding:6px 12px;letter-spacing:.1em;user-select:none}
.think summary::marker{color:var(--ink-4)}
.think-body{padding:2px 14px 10px;font-size:.78rem;color:var(--ink-3);font-style:italic;
  white-space:pre-wrap;word-break:break-word;max-height:200px;overflow-y:auto;line-height:1.7}

/* ── tool timeline ── */
.tools{margin-bottom:9px;display:flex;flex-direction:column;gap:4px}
.tool-row{display:flex;align-items:center;gap:9px;font-size:.74rem;color:var(--ink-3);
  padding:5px 12px;border-radius:7px;background:var(--card);border:1px solid var(--line-soft);
  animation:msg-in .3s ease both}
.t-ind{width:8px;height:8px;border-radius:50%;flex-shrink:0;position:relative}
.tool-row.pending .t-ind{background:var(--pigment);animation:dot-busy 1s ease-in-out infinite}
.tool-row.ok .t-ind{background:var(--ok)}
.tool-row.err .t-ind{background:var(--err)}
.t-name{font-family:'JetBrains Mono',monospace;font-size:.7rem;color:var(--ink-2);flex-shrink:0}
.t-label{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:300}
.t-dur{font-size:.64rem;color:var(--ink-4);flex-shrink:0;font-family:'JetBrains Mono',monospace}

/* ═══════════ markdown body typography ═══════════ */
.msg-body p{margin:.35em 0}
.msg-body p:first-child{margin-top:0}
.msg-body p:last-child{margin-bottom:0}
.md-h{margin:.7em 0 .3em;line-height:1.4;color:var(--ink)}
.md-h1{font-size:1.18em;border-bottom:1px solid var(--line);padding-bottom:.25em}
.md-h2{font-size:1.1em}
.md-h3{font-size:1.02em}
.md-h4{font-size:.96em;color:var(--ink-2)}
.msg-body ul,.msg-body ol{margin:.4em 0;padding-left:1.5em}
.msg-body li{margin:.18em 0}
.msg-body blockquote{margin:.5em 0;padding:.4em 1em;border-left:3px solid var(--line);
  color:var(--ink-3);background:var(--line-soft);border-radius:0 7px 7px 0;font-style:italic}
.msg-body hr{border:none;height:1px;background:var(--line);margin:.9em 0}
.msg-body a{color:var(--pigment);text-decoration:underline;text-underline-offset:3px;text-decoration-thickness:1px}
.msg-body code{font-family:'JetBrains Mono',monospace;font-size:.83em;background:var(--line-soft);
  padding:.13em .42em;border-radius:5px;border:1px solid var(--line-soft)}
.msg-body del{color:var(--ink-3)}

/* code blocks */
.codeblock{margin:.6em 0;border:1px solid var(--line);border-radius:9px;overflow:hidden;background:var(--card-solid)}
.cb-head{display:flex;align-items:center;justify-content:space-between;padding:5px 13px;
  background:var(--line-soft);border-bottom:1px solid var(--line-soft)}
.cb-lang{font-family:'JetBrains Mono',monospace;font-size:.66rem;color:var(--ink-3);letter-spacing:.1em}
.cb-copy{background:none;border:none;color:var(--ink-3);font-family:inherit;font-size:.7rem;cursor:pointer;
  padding:2px 8px;border-radius:5px;transition:all .2s}
.cb-copy:hover{color:var(--pigment);background:var(--pigment-faint)}
.codeblock pre{padding:12px 15px;overflow-x:auto;line-height:1.65}
.codeblock pre::-webkit-scrollbar{height:4px}
.codeblock pre::-webkit-scrollbar-thumb{background:var(--ink-4);border-radius:2px}
.codeblock code{font-family:'JetBrains Mono',monospace;font-size:.8rem;background:none;border:none;padding:0;color:var(--ink-2)}
.tk-k{color:#8a4a9e;font-weight:600}
.tk-s{color:#3a7a4e}
.tk-c{color:var(--ink-4);font-style:italic}
.tk-n{color:#a86220}
[data-theme=dark] .tk-k{color:#c792ea}
[data-theme=dark] .tk-s{color:#8fd1a0}
[data-theme=dark] .tk-n{color:#e6b36a}

/* tables */
.md-table{margin:.6em 0;overflow-x:auto;border:1px solid var(--line);border-radius:9px}
.md-table table{border-collapse:collapse;width:100%;font-size:.86em}
.md-table th{background:var(--line-soft);text-align:left;font-weight:600;color:var(--ink)}
.md-table th,.md-table td{padding:7px 13px;border-bottom:1px solid var(--line-soft)}
.md-table tr:last-child td{border-bottom:none}

/* ═══════════ welcome ═══════════ */
.welcome{align-self:center;text-align:center;margin:auto 0;padding:24px;animation:msg-in .6s ease both}
.w-seal{font-size:clamp(3.2rem,8vw,5rem);font-weight:700;color:var(--pigment);opacity:.85;
  width:1.6em;height:1.6em;line-height:1.55em;margin:0 auto 18px;border:3px solid var(--pigment);
  border-radius:14px;transition:color .5s,border-color .5s;animation:seal-breathe 7s ease-in-out infinite}
.w-poem{font-size:1.05rem;color:var(--ink-2);letter-spacing:.2em;margin-bottom:6px}
.w-sub{font-size:.74rem;color:var(--ink-3);letter-spacing:.14em;margin-bottom:26px;font-weight:300}
.w-tips{display:flex;flex-direction:column;gap:9px;max-width:340px;margin:0 auto}
.w-tip{background:var(--card);border:1px solid var(--line);border-radius:9px;color:var(--ink-2);
  font-family:inherit;font-size:.85rem;padding:10px 18px;cursor:pointer;transition:all .25s;
  box-shadow:var(--shadow)}
.w-tip:hover{border-color:var(--pigment);color:var(--pigment);transform:translateY(-1px);box-shadow:var(--shadow-lift)}

/* ═══════════ scroll pill ═══════════ */
#scroll-pill{position:absolute;bottom:118px;left:50%;transform:translateX(-50%) translateY(14px);
  background:var(--card-solid);border:1px solid var(--line);border-radius:99px;padding:6px 17px;
  font-size:.76rem;color:var(--ink-2);cursor:pointer;display:flex;align-items:center;gap:7px;
  box-shadow:var(--shadow-lift);opacity:0;pointer-events:none;transition:all .3s;z-index:3}
#scroll-pill.show{opacity:1;pointer-events:auto;transform:translateX(-50%) translateY(0)}
#scroll-pill:hover{color:var(--pigment);border-color:var(--pigment)}

/* ═══════════ composer ═══════════ */
#composer{padding:10px var(--gutter) clamp(16px,3vh,26px)}
#input-card{display:flex;align-items:flex-end;gap:8px;background:var(--card-solid);
  border:1px solid var(--line);border-radius:14px;padding:10px 10px 10px 18px;
  box-shadow:var(--shadow);transition:border-color .3s,box-shadow .3s}
#input-card:focus-within{border-color:var(--pigment);box-shadow:var(--shadow-lift),0 0 0 3px var(--pigment-faint)}
#chat-input{flex:1;background:transparent;border:none;outline:none;color:var(--ink);
  font-family:inherit;font-size:.93rem;font-weight:300;resize:none;min-height:26px;max-height:160px;
  line-height:1.7;padding:3px 0}
#chat-input::placeholder{color:var(--ink-4);font-style:italic}
#char-count{font-size:.66rem;color:var(--ink-4);align-self:center;font-family:'JetBrains Mono',monospace}
#send-btn{width:38px;height:38px;flex-shrink:0;border:none;border-radius:10px;cursor:pointer;
  background:var(--pigment);color:#fff;display:flex;align-items:center;justify-content:center;
  font-size:.95rem;transition:all .25s;box-shadow:var(--shadow)}
#send-btn:hover{transform:translateY(-1px);box-shadow:var(--shadow-lift)}
#send-btn:active{transform:translateY(0)}
#send-btn.stop{background:var(--err)}
.stop-ico{width:11px;height:11px;background:#fff;border-radius:2px}
.send-ico{transform:translateX(1px)}
#hint{font-size:.65rem;color:var(--ink-4);margin-top:8px;letter-spacing:.07em;text-align:center}

/* ═══════════ toasts ═══════════ */
#toasts{position:fixed;bottom:26px;left:50%;transform:translateX(-50%);z-index:50;
  display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none}
.toast{background:var(--card-solid);border:1px solid var(--line);color:var(--ink-2);
  border-radius:10px;padding:9px 20px;font-size:.8rem;box-shadow:var(--shadow-lift);
  animation:toast-in .3s cubic-bezier(.2,.8,.25,1) both;letter-spacing:.04em}
.toast.err{border-color:var(--err);color:var(--err)}
.toast.out{animation:toast-out .35s ease both}
@keyframes toast-in{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
@keyframes toast-out{to{opacity:0;transform:translateY(8px)}}

/* ═══════════ shortcuts modal ═══════════ */
#keys-modal{position:fixed;inset:0;z-index:40;background:rgba(0,0,0,.25);backdrop-filter:blur(3px);
  display:flex;align-items:center;justify-content:center;opacity:0;pointer-events:none;transition:opacity .25s}
#keys-modal.show{opacity:1;pointer-events:auto}
#keys-card{background:var(--card-solid);border:1px solid var(--line);border-radius:16px;
  padding:26px 32px;box-shadow:var(--shadow-lift);min-width:300px;transform:translateY(8px);transition:transform .25s}
#keys-modal.show #keys-card{transform:translateY(0)}
#keys-card h3{font-size:.95rem;margin-bottom:16px;letter-spacing:.1em}
.key-row{display:flex;justify-content:space-between;gap:30px;font-size:.8rem;color:var(--ink-2);padding:5px 0}
.key-row kbd{font-family:'JetBrains Mono',monospace;font-size:.7rem;background:var(--line-soft);
  border:1px solid var(--line);border-radius:5px;padding:2px 8px;color:var(--ink-3)}

/* ═══════════ reduced motion + mobile ═══════════ */
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation-duration:.01ms !important;animation-iteration-count:1 !important;transition-duration:.01ms !important}
  #ambient-layer{display:none}
}
@media(max-width:760px){
  body{flex-direction:column}
  #sidebar{width:100%;flex-direction:row;align-items:center;padding:8px 10px;border-right:none;
    border-bottom:1px solid var(--line-soft);overflow-x:auto}
  #logo,#side-foot{display:none}
  #agents-list{flex-direction:row;gap:4px;overflow-x:auto}
  .agent-item{border-left:none;border-bottom:2px solid transparent;border-radius:8px 8px 0 0;
    padding:7px 10px;white-space:nowrap}
  .agent-item.active{border-bottom-color:var(--pigment)}
  .a-sub{display:none}
  .a-seal{width:26px;height:26px;font-size:.85rem}
  .msg,.msg.assistant{max-width:94%}
  #kanji-seal{display:none}
  #messages{padding:14px 12px}#strip{padding:9px 12px}#composer{padding:8px 10px 12px}
  #scroll-pill{bottom:96px}
}
</style>
</head>
<body>

<div id="grain"></div>
<div id="ambient-layer"></div>
<div id="kanji-seal">霧</div>

<div id="sidebar">
  <div id="logo"><b>气象台</b><small>skyloom</small></div>
  <div id="agents-list"></div>
  <div id="side-foot">
    <div id="side-status"><span id="conn-dot"></span><span id="ws-name"></span></div>
    <div id="side-actions">
      <button class="side-btn" id="theme-btn" title="切换主题">☾</button>
      <button class="side-btn" id="keys-btn" title="快捷键 (?)">⌨</button>
    </div>
    <div id="verse">山色有无中</div>
  </div>
</div>

<div id="main">
  <div id="strip">
    <div id="strip-dot"></div>
    <span id="strip-name">雾 Fog</span>
    <span id="strip-pig">松烟墨 · 探索洞察</span>
    <span id="strip-sp"></span>
    <button class="strip-btn" id="export-btn" title="导出会话为 Markdown">导出</button>
    <button class="strip-btn" id="clear-btn" title="清空当前会话">清空</button>
  </div>
  <div id="messages"></div>
  <button id="scroll-pill" type="button">↓ <span>回到底部</span></button>
  <div id="composer">
    <div id="input-card">
      <textarea id="chat-input" rows="1" placeholder="写下你想说的话…" autofocus></textarea>
      <span id="char-count"></span>
      <button id="send-btn" type="button" title="发送 (Enter)"><span class="send-ico">➤</span></button>
    </div>
    <div id="hint">Enter 发送 · Shift+Enter 换行 · Esc 停止 · ? 快捷键</div>
  </div>
</div>

<div id="keys-modal"><div id="keys-card">
  <h3>快捷键</h3>
  <div class="key-row"><span>发送</span><kbd>Enter</kbd></div>
  <div class="key-row"><span>换行</span><kbd>Shift + Enter</kbd></div>
  <div class="key-row"><span>停止生成</span><kbd>Esc</kbd></div>
  <div class="key-row"><span>切换灵</span><kbd id="kbd-agents"></kbd></div>
  <div class="key-row"><span>清空会话</span><kbd id="kbd-clear"></kbd></div>
  <div class="key-row"><span>本面板</span><kbd>?</kbd></div>
</div></div>

<div id="toasts"></div>

<script>
window.__SKYLOOM__ = ${JSON.stringify({ agents: AGENTS_META })};
${md.escapeHtml.toString()}
${md.highlightCode.toString()}
${md.mdInline.toString()}
${md.mdToHtml.toString()}
${clientMain.toString()}
clientMain();
</script>
</body>
</html>`;
}
