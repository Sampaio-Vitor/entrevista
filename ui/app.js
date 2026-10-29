/* global window, document, localStorage */
(() => {
  const api = window.api;
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const state = {
    phase: 'setup',
    mode: 'meeting',        // kind of the live session (from main)
    uiMode: localStorage.getItem('uiMode') || 'meeting', // meeting | interview | library
    startedAt: null,
    sessionId: null,
    config: null,
    permissions: { microphone: 'unknown', screen: 'unknown' },
    deepgramKey: false,
    claudeBinary: null,
    native: { available: false, error: null },
    headset: null,
    status: null,
    segments: [],
    names: {},
    participants: {},
    chat: [],             // live meeting chat
    answers: [],          // newest first (interview)
    setupChat: [],        // interview preparation dialogue
    chatStarted: false,
    sessions: [],         // past interviews (summaries)
    meetings: [],         // past meetings (summaries)
    people: [],
    jobs: {},             // sessionId -> { stage, error }
    viewing: null,        // a loaded past session, read-only
    lib: { tab: 'meetings', q: '', person: '', results: [], person: '', detail: null },
    editingSpeaker: null,
    summaryStreaming: null, // { sessionId, text }
    calendar: { access: null, events: [], fetchedAt: 0, loading: false }, // upcoming meetings
  };

  // ---------- utilities ----------

  function esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function inline(s) {
    return esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  }

  // Minimal markdown: fenced code, bullets, checkboxes, numbered lists, headings, bold, inline code.
  function renderMd(src) {
    const lines = String(src || '').split('\n');
    let html = '';
    let inCode = false;
    let codeBuf = [];
    let list = null;
    const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
    for (const raw of lines) {
      const line = raw.replace(/\s+$/, '');
      if (line.trim().startsWith('```')) {
        if (inCode) {
          html += `<pre><code>${esc(codeBuf.join('\n'))}</code></pre>`;
          inCode = false; codeBuf = [];
        } else {
          closeList(); inCode = true;
        }
        continue;
      }
      if (inCode) { codeBuf.push(line); continue; }
      const task = line.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/);
      const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
      const num = line.match(/^\s*\d+[.)]\s+(.*)$/);
      const head = line.match(/^\s*#{1,6}\s+(.*)$/);
      if (task) {
        if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul'; }
        html += `<li class="task ${task[1] !== ' ' ? 'done' : ''}"><span class="box">${task[1] !== ' ' ? '☑' : '☐'}</span> ${labelize(task[2])}</li>`;
      } else if (bullet) {
        if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul'; }
        html += `<li>${labelize(bullet[1])}</li>`;
      } else if (num) {
        if (list !== 'ol') { closeList(); html += '<ol>'; list = 'ol'; }
        html += `<li>${labelize(num[1])}</li>`;
      } else if (head) {
        closeList(); html += `<h4>${inline(head[1])}</h4>`;
      } else if (!line.trim()) {
        closeList();
      } else {
        closeList(); html += `<p>${inline(line)}</p>`;
      }
    }
    if (inCode) html += `<pre><code>${esc(codeBuf.join('\n'))}</code></pre>`;
    closeList();
    return html;
  }

  // "Problem: ..." -> bold label, used by the code-mode answers.
  function labelize(text) {
    const m = text.match(/^([A-Z][A-Za-z ]{1,24}):\s+(.*)$/);
    if (!m) return inline(text);
    return `<span class="lbl2">${esc(m[1])}:</span> ${inline(m[2])}`;
  }

  function accelLabel(accel) {
    if (!accel) return '';
    return accel
      .replace(/CommandOrControl|CmdOrCtrl|Command|Cmd/g, '⌘')
      .replace(/Control|Ctrl/g, '⌃')
      .replace(/Shift/g, '⇧')
      .replace(/Alt|Option/g, '⌥')
      .replace(/Return|Enter/g, '↩')
      .replace(/Space/g, '␣')
      .replace(/Up/g, '↑')
      .replace(/Down/g, '↓')
      .replace(/\+/g, '');
  }

  function fmtMs(ms) {
    if (ms == null) return '';
    return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
  }

  function shortModel(m) {
    if (!m) return '';
    return m.replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/-(\d)-(\d)/, ' $1.$2').replace(/-(\d)$/, ' $1');
  }

  function fmtDuration(ms) {
    const m = Math.round((ms || 0) / 60000);
    if (m < 1) return '< 1 min';
    if (m < 60) return `${m} min`;
    return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
  }

  function fmtWhen(ts) {
    const d = new Date(ts);
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  function fmtDate(ts) {
    return new Date(ts).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
  }

  function fmtClock(ts) {
    return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  let toastTimer = null;
  function showToast(level, message, ms) {
    const el = $('#toast');
    el.textContent = message;
    el.className = `toast ${level || 'info'}`;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), ms || (level === 'error' ? 9000 : 4500));
  }

  function jobLabel(job) {
    if (!job) return '';
    switch (job.stage) {
      case 'uploading': return 'enviando áudio…';
      case 'transcribing': return 'refinando transcrição…';
      case 'summarizing': return 'gerando resumo…';
      case 'error': return 'falhou';
      default: return '';
    }
  }

  // ---------- speakers ----------

  /** Which kind of session the live/viewer screen is showing. */
  function activeKind() {
    if (state.viewing && state.phase !== 'live') return state.viewing.kind;
    if (state.phase === 'live') return state.mode;
    return state.uiMode === 'interview' ? 'interview' : 'meeting';
  }

  function activeNames() {
    return (state.viewing && state.phase !== 'live') ? (state.viewing.names || {}) : state.names;
  }

  function activeParticipants() {
    return (state.viewing && state.phase !== 'live') ? (state.viewing.participants || {}) : state.participants;
  }

  /** Stable color per voice: order of the system-channel speakers in `names`. */
  function speakerClass(spk, names) {
    if (spk === 'me') return 'me';
    const others = Object.keys(names || {}).filter((k) => k !== 'me');
    const i = Math.max(0, others.indexOf(spk));
    return `them c${i % 6}`;
  }

  function displayName(spk, names, kind) {
    if (kind === 'interview') return spk === 'me' ? 'Me' : 'Interviewer';
    return (names && names[spk]) || (spk === 'me' ? 'Eu' : spk);
  }

  // ---------- views ----------

  function applyBodyMode() {
    const kind = activeKind();
    document.body.classList.toggle('mode-meeting', kind === 'meeting');
    document.body.classList.toggle('mode-interview', kind === 'interview');
  }

  function showView() {
    const viewing = Boolean(state.viewing);
    const live = state.phase === 'live';
    const library = !live && !viewing && state.uiMode === 'library';
    $('#view-setup').classList.toggle('hidden', live || viewing || library);
    $('#view-library').classList.toggle('hidden', !library);
    $('#view-live').classList.toggle('hidden', !(live || viewing));
    $('#view-live').classList.toggle('readonly', viewing && !live);
    applyBodyMode();
  }

  function setUiMode(m) {
    state.uiMode = m;
    localStorage.setItem('uiMode', m);
    $$('.mode-tabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
    $('#panel-meeting').classList.toggle('hidden', m !== 'meeting');
    $('#panel-interview').classList.toggle('hidden', m !== 'interview');
    $('#brand-title').textContent = m === 'interview' ? 'Entrevista' : 'Reuniões';
    $('#brand-sub').textContent = m === 'interview'
      ? 'Copiloto ao vivo. Transcreve os dois lados e responde quando você pedir.'
      : 'Grava os dois lados sem bot, separa quem falou e guarda tudo no seu Mac.';
    showView();
    if (m === 'library') openLibrary();
  }

  // ---------- setup: meeting ----------

  function meetingCardHtml(s, withMatches) {
    const job = state.jobs[s.id];
    const chips = [];
    if (job && job.stage !== 'done') chips.push(`<span class="chip ${job.stage === 'error' ? 'err' : 'busy'}">${esc(jobLabel(job))}</span>`);
    else if (s.refined === 'done') chips.push('<span class="chip ok">refinada</span>');
    if (s.hasSummary) chips.push('<span class="chip">resumo</span>');
    const people = (s.participants || []).slice(0, 5).map((p) => `<span class="pp">${esc(p)}</span>`).join('');
    const matches = withMatches && s.matches && s.matches.length
      ? `<ul class="hits">${s.matches.map((m) => `<li><span class="who">${esc(m.speaker)}</span> ${esc(m.text)}</li>`).join('')}</ul>`
      : '';
    return `<li class="meeting-card" data-id="${esc(s.id)}" title="Abrir reunião">
      <div class="mc-top"><span class="mc-when">${esc(fmtDate(s.startedAt))} · ${fmtWhen(s.startedAt).slice(6)} · ${fmtDuration(s.durationMs)}</span><span class="mc-chips">${chips.join('')}</span></div>
      <div class="mc-title">${esc(s.title)}</div>
      <div class="mc-people">${people || '<span class="muted">sem participantes nomeados</span>'}</div>
      ${matches}
    </li>`;
  }

  function renderRecentMeetings() {
    const el = $('#recent-meetings');
    const list = state.meetings.slice(0, 8);
    if (!list.length) {
      el.innerHTML = '<li class="s-empty">Nenhuma ainda. Começar reunião grava, transcreve e salva em sessions/.</li>';
      return;
    }
    el.innerHTML = list.map((s) => meetingCardHtml(s, false)).join('');
    el.querySelectorAll('li[data-id]').forEach((li) => li.addEventListener('click', () => viewSession(li.dataset.id)));
    const note = [];
    if (!state.deepgramKey) note.push('sem transcrição (falta a chave Deepgram)');
    if (!state.claudeBinary) note.push('sem resumo e chat (Claude não encontrado)');
    $('#meeting-note').textContent = note.length ? `Vai iniciar ${note.join(' e ')}.` : '';
  }

  // ---------- setup: upcoming meetings (macOS calendar) ----------

  function fmtEventWhen(e) {
    const hm = (ts) => new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const day = new Date(e.start); day.setHours(0, 0, 0, 0);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const diff = Math.round((day - today) / 86400000);
    const label = diff <= 0 ? 'Hoje' : diff === 1 ? 'Amanhã' : new Date(e.start).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' });
    return `${label} · ${hm(e.start)}–${hm(e.end)}`;
  }

  function eventChip(e) {
    const now = Date.now();
    if (e.start <= now) return '<span class="chip busy">agora</span>';
    const min = Math.round((e.start - now) / 60000);
    return min <= 60 ? `<span class="chip">em ${min} min</span>` : '';
  }

  function renderUpcoming() {
    const cal = state.calendar;
    const block = $('#upcoming-block');
    block.classList.toggle('hidden', !cal.access || cal.access === 'unavailable');
    const el = $('#upcoming');
    if (cal.access === 'notDetermined' || cal.access === 'unknown') {
      el.innerHTML = '<li class="s-empty">Veja suas reuniões de todas as contas do Calendário do Mac.<button class="link" id="cal-connect" type="button">conectar calendário</button></li>';
      $('#cal-connect').addEventListener('click', () => refreshCalendar(true));
      return;
    }
    if (cal.access && cal.access !== 'granted') {
      el.innerHTML = '<li class="s-empty">Sem acesso ao calendário. Ative "Entrevista" em Ajustes > Privacidade > Calendários.<button class="link" id="cal-settings" type="button">abrir ajustes</button></li>';
      $('#cal-settings').addEventListener('click', () => api.invoke('permissions:request', { which: 'calendars' }));
      return;
    }
    const list = cal.events.slice(0, 4);
    if (!list.length) {
      el.innerHTML = `<li class="s-empty">${cal.loading ? 'Lendo o calendário…' : 'Nenhuma reunião nas próximas 36 horas.'}</li>`;
      return;
    }
    el.innerHTML = list.map((e) => {
      const color = /^#[0-9a-f]{6}$/i.test(e.color || '') ? ` style="--cal:${e.color}"` : '';
      const guests = e.guests || [];
      const people = guests.slice(0, 4).map((g) => `<span class="pp">${esc(g)}</span>`).join('')
        + (guests.length > 4 ? `<span class="pp">+${guests.length - 4}</span>` : '');
      const join = e.link ? `<button class="btn primary small" data-join="${esc(e.id)}" type="button" title="${esc(e.link)}">Entrar e gravar</button>` : '';
      return `<li class="meeting-card ${e.start <= Date.now() ? 'now' : ''}"${color}>
        <div class="uc-body">
          <div class="mc-top"><span class="mc-when">${esc(fmtEventWhen(e))} · ${esc(e.source)}</span><span class="mc-chips">${eventChip(e)}</span></div>
          <div class="mc-title" title="${esc(e.title)}">${esc(e.title || '(sem título)')}</div>
          ${people ? `<div class="mc-people">${people}</div>` : ''}
        </div>
        <div class="uc-actions">${join}<button class="btn ${e.link ? 'secondary' : 'primary'} small" data-rec="${esc(e.id)}" type="button">Só gravar</button></div>
      </li>`;
    }).join('');
    el.querySelectorAll('[data-join]').forEach((b) => b.addEventListener('click', () => startFromEvent(b.dataset.join, true)));
    el.querySelectorAll('[data-rec]').forEach((b) => b.addEventListener('click', () => startFromEvent(b.dataset.rec, false)));
  }

  async function refreshCalendar(request) {
    const cal = state.calendar;
    if (cal.loading) return;
    cal.loading = true;
    renderUpcoming();
    try {
      const r = await api.invoke('calendar:upcoming', { request: Boolean(request) });
      if (r) { cal.access = r.access; cal.events = r.events || []; cal.fetchedAt = r.fetchedAt || Date.now(); }
    } catch (err) {
      console.warn('calendar failed', err);
    } finally {
      cal.loading = false;
      renderUpcoming();
    }
  }

  async function startFromEvent(id, join) {
    const e = state.calendar.events.find((x) => x.id === id);
    if (!e) return;
    const guests = e.guests || [];
    const typed = $('#context').value.trim();
    const context = [e.title, guests.length ? `Participantes: ${guests.join(', ')}` : '', typed].filter(Boolean).join('\n');
    if (join && e.link) await api.invoke('open:external', { url: e.link });
    await startMeeting(context, { title: e.title, start: e.start, end: e.end, source: e.source, link: e.link, guests });
  }

  function renderSidePeople() {
    const el = $('#side-people');
    if (!state.people.length) {
      el.innerHTML = '<li class="s-empty">Ninguém nomeado ainda. Dê nome aos participantes durante ou depois da reunião.</li>';
      return;
    }
    el.innerHTML = state.people.slice(0, 10).map((p) => `<li data-name="${esc(p.name)}"><span class="pname">${esc(p.name)}</span><span class="muted">${p.meetings} ${p.meetings === 1 ? 'reunião' : 'reuniões'}</span></li>`).join('');
    el.querySelectorAll('li[data-name]').forEach((li) => li.addEventListener('click', () => { setUiMode('library'); openPerson(li.dataset.name); }));
  }

  // ---------- setup: interview ----------

  function renderSessions() {
    const el = $('#sessions');
    if (!state.sessions.length) {
      el.innerHTML = '<li class="s-empty">Nenhuma ainda. Cada Começar abre uma entrevista nova; Parar salva em sessions/.</li>';
      return;
    }
    el.innerHTML = state.sessions.map((s) => `
      <li data-id="${esc(s.id)}" title="Abrir sessão">
        <div class="s-when"><span>${fmtWhen(s.startedAt)}</span><span>${fmtDuration(s.durationMs)} · ${s.answers} resp.</span></div>
        <div class="s-title">${esc(s.title)}</div>
      </li>`).join('');
    el.querySelectorAll('li[data-id]').forEach((li) => li.addEventListener('click', () => viewSession(li.dataset.id)));
  }

  function renderSetup() {
    const cfg = state.config || {};
    const hk = cfg.hotkeys || {};
    const items = [];
    const dot = (ok) => `<span class="dot ${ok === true ? 'ok' : ok === 'pending' ? 'warn' : 'err'}"></span>`;
    const interview = state.uiMode === 'interview';

    items.push(`<li>${dot(state.claudeBinary ? true : false)}<span class="txt">Claude Code (<code>claude -p</code>)<span class="sub">${state.claudeBinary ? esc(state.claudeBinary) : 'binário não encontrado'}</span></span></li>`);
    items.push(`<li>${dot(state.deepgramKey)}<span class="txt">Chave Deepgram<span class="sub">${state.deepgramKey ? 'carregada do .env' : 'DEEPGRAM_API_KEY ausente no .env'}</span></span></li>`);
    items.push(`<li>${dot(state.native.available)}<span class="txt">Motor de áudio nativo<span class="sub">${state.native.available ? 'Core Audio tap + microfone, 16 kHz' : esc(state.native.error || 'indisponível')}</span></span></li>`);
    const mic = state.permissions.microphone;
    items.push(`<li>${dot(mic === 'granted' ? true : mic === 'not-determined' ? 'pending' : false)}<span class="txt">Microfone<span class="sub">${mic === 'granted' ? 'permitido' : mic === 'not-determined' ? 'pede ao iniciar' : 'negado: Ajustes > Privacidade > Microfone'}</span></span>${mic !== 'granted' ? '<button class="link" data-perm="microphone">pedir</button>' : ''}</li>`);
    items.push(`<li>${dot('pending')}<span class="txt">Gravação de áudio do sistema<span class="sub">macOS pergunta na primeira captura (sem compartilhar tela)</span></span><button class="link" data-perm="audio">ajustes</button></li>`);
    if (interview) {
      const scr = state.permissions.screen;
      items.push(`<li>${dot(scr === 'granted' ? true : scr === 'not-determined' ? 'pending' : false)}<span class="txt">Gravação de tela (para Código)<span class="sub">${scr === 'granted' ? 'permitida' : 'pede no primeiro screenshot'}</span></span>${scr !== 'granted' ? '<button class="link" data-perm="screen">ajustes</button>' : ''}</li>`);
    } else if (cfg.meeting) {
      const m = cfg.meeting;
      items.push(`<li>${dot(true)}<span class="txt">Modo reunião<span class="sub">${m.diarize ? 'separa vozes do outro lado' : 'sem separação de vozes'} · ${m.saveAudio ? 'grava WAV por canal' : 'sem gravação de áudio'} · ${m.refine ? 'refina ao parar' : 'sem refino'} · ${m.autoSummary ? 'resumo automático' : 'resumo manual'}</span></span></li>`);
    }
    const hs = state.headset || {};
    if (hs.outputName) {
      items.push(`<li>${dot(hs.bluetooth ? 'pending' : true)}<span class="txt">Saída: ${esc(hs.outputName)}<span class="sub">${hs.bluetooth ? 'Bluetooth: o app usa o microfone do Mac e o define como padrão do sistema durante a sessão' : 'com fio ou alto-falante, sem restrições'}</span></span></li>`);
    } else if (!hs.helper) {
      items.push(`<li>${dot('pending')}<span class="txt">Helper de áudio<span class="sub">native/audio-defaults não compilado (rode npm install)</span></span></li>`);
    }
    $('#checklist').innerHTML = items.join('');
    $('#checklist').querySelectorAll('[data-perm]').forEach((b) => {
      b.addEventListener('click', async () => {
        await api.invoke('permissions:request', { which: b.dataset.perm });
        setTimeout(refreshState, 800);
      });
    });

    $('#hotkeys').innerHTML = [
      `<li><span>Resposta agora</span><kbd>${accelLabel(hk.answer)}</kbd></li>`,
      `<li><span>Screenshot e solução</span><kbd>${accelLabel(hk.code)}</kbd></li>`,
      `<li><span>Ocultar / mostrar</span><kbd>${accelLabel(hk.toggleWindow)}</kbd></li>`,
      `<li><span>Idioma da resposta</span><kbd>${accelLabel(hk.language)}</kbd></li>`,
      `<li><span>Fundo mais / menos opaco</span><kbd>${accelLabel(hk.opacityUp)} ${accelLabel(hk.opacityDown)}</kbd></li>`,
    ].join('');

    const mc = (m) => m ? `<code>${esc(m.model)}</code> ${m.fastMode ? '↯ fast' : ''} esforço ${esc(m.effort)}` : '';
    $('#models').innerHTML = [
      `<li><span>Respostas</span><span>${mc(cfg.answer)}</span></li>`,
      `<li><span>Código</span><span>${mc(cfg.code)}</span></li>`,
      `<li><span>Preparação</span><span>${mc(cfg.setup)}</span></li>`,
    ].join('');
    $('#setup-model').textContent = cfg.setup ? `(${cfg.setup.model}, velocidade padrão)` : '';

    const note = [];
    if (!state.deepgramKey) note.push('sem transcrição (falta a chave)');
    if (!state.claudeBinary) note.push('sem Claude (binário não encontrado)');
    $('#start-note').textContent = note.length ? `Vai iniciar ${note.join(' e ')}.` : '';
  }

  function renderSetupChat() {
    const log = $('#chat-log');
    log.innerHTML = state.setupChat.map((m) => {
      if (m.role === 'user') return `<div class="msg user"><span class="who">Você</span><div class="body">${inline(m.text).replace(/\n/g, '<br>')}</div></div>`;
      // Hide the <briefing> block from the chat; it lands in the textarea.
      const visible = m.text.replace(/<briefing>[\s\S]*?(<\/briefing>|$)/i, m.status === 'done' ? '<em>(briefing copiado para a caixa acima)</em>' : '<em>(escrevendo o briefing…)</em>');
      return `<div class="msg assistant ${m.status === 'streaming' ? 'streaming' : ''}"><span class="who">Claude</span><div class="body">${renderMd(visible)}</div></div>`;
    }).join('');
    log.scrollTop = log.scrollHeight;
  }

  // ---------- library ----------

  let libTimer = null;

  async function openLibrary() {
    try { state.people = (await api.invoke('sessions:people')) || []; } catch { state.people = []; }
    const sel = $('#lib-person');
    const current = state.lib.person;
    sel.innerHTML = '<option value="">Todas as pessoas</option>' + state.people.map((p) => `<option value="${esc(p.name)}" ${p.name === current ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
    $('#lib-q').value = state.lib.q;
    await runSearch();
    renderLibrary();
  }

  async function runSearch() {
    try {
      state.lib.results = (await api.invoke('sessions:search', { q: state.lib.q, person: state.lib.person })) || [];
    } catch { state.lib.results = []; }
    state.lib.results = state.lib.results.filter((s) => s.kind === 'meeting' || state.lib.q || state.lib.person);
    renderLibrary();
  }

  function setLibTab(tab) {
    state.lib.tab = tab;
    $$('.lib-tabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    $('#lib-meetings').classList.toggle('hidden', tab !== 'meetings');
    $('#lib-people').classList.toggle('hidden', tab !== 'people');
  }

  function renderLibrary() {
    setLibTab(state.lib.tab);
    const list = $('#lib-meetings');
    const q = state.lib.q || state.lib.person;
    if (!state.lib.results.length) {
      list.innerHTML = `<p class="lib-empty">${q ? 'Nada encontrado.' : 'Nenhuma reunião gravada ainda.'}</p>`;
    } else {
      list.innerHTML = `<ul class="meetings">${state.lib.results.map((s) => meetingCardHtml(s, true)).join('')}</ul>`;
      list.querySelectorAll('li[data-id]').forEach((li) => li.addEventListener('click', () => viewSession(li.dataset.id)));
    }
    const people = $('#lib-people');
    if (state.lib.detail) {
      const d = state.lib.detail;
      people.innerHTML = `
        <div class="person-head">
          <button class="link" id="person-back" type="button">← todas as pessoas</button>
          <h3>${esc(d.name)}</h3>
          <p class="muted">${d.meetings} ${d.meetings === 1 ? 'reunião' : 'reuniões'} · ${d.utterances} falas</p>
        </div>
        <ul class="meetings">${d.results.map((s) => meetingCardHtml(s, true)).join('')}</ul>`;
      people.querySelector('#person-back').addEventListener('click', () => { state.lib.detail = null; renderLibrary(); });
      people.querySelectorAll('li[data-id]').forEach((li) => li.addEventListener('click', () => viewSession(li.dataset.id)));
    } else if (!state.people.length) {
      people.innerHTML = '<p class="lib-empty">Ninguém nomeado ainda. Clique em um participante na transcrição para dar nome.</p>';
    } else {
      people.innerHTML = `<ul class="people">${state.people.map((p) => `
        <li data-name="${esc(p.name)}">
          <span class="pname">${esc(p.name)}</span>
          <span class="muted">${p.meetings} ${p.meetings === 1 ? 'reunião' : 'reuniões'} · ${p.utterances} falas · última ${fmtDate(p.lastAt)}</span>
        </li>`).join('')}</ul>`;
      people.querySelectorAll('li[data-name]').forEach((li) => li.addEventListener('click', () => openPerson(li.dataset.name)));
    }
  }

  async function openPerson(name) {
    const p = state.people.find((x) => x.name === name) || { name, meetings: 0, utterances: 0 };
    let results = [];
    try { results = (await api.invoke('sessions:search', { q: '', person: name })) || []; } catch { results = []; }
    state.lib.detail = { ...p, results };
    state.lib.tab = 'people';
    renderLibrary();
  }

  // ---------- live / viewer ----------

  async function viewSession(id) {
    const s = await api.invoke('sessions:load', { id });
    if (!s) { showToast('error', 'Sessão não encontrada.'); return; }
    state.viewing = s;
    if (s.job) state.jobs[s.id] = s.job; else delete state.jobs[s.id];
    state.editingSpeaker = null;
    renderViewTitle();
    showView();
    renderParticipants();
    renderTranscript();
    renderAnswers();
    renderSummary();
    renderMeetingChat();
    $('.answer-pane').scrollTop = 0;
    $('.transcript-pane').scrollTop = 0;
  }

  function renderViewTitle() {
    const s = state.viewing;
    if (!s) return;
    const job = state.jobs[s.id];
    const kind = s.kind === 'meeting' ? 'Reunião' : 'Entrevista';
    const extra = s.kind === 'meeting' ? `${s.segments.length} falas` : `${s.segments.length} falas · ${s.answers.length} respostas`;
    const jobTxt = job && job.stage !== 'done' ? ` · ${jobLabel(job)}` : '';
    $('#view-title').textContent = `${kind} ${fmtWhen(s.startedAt)} · ${fmtDuration((s.endedAt || s.startedAt) - s.startedAt)} · ${extra}${jobTxt}`;
    $('#btn-summarize').textContent = s.summary ? 'Regerar resumo' : 'Resumir';
    $('#btn-summarize').disabled = Boolean(job && job.stage === 'summarizing');
    $('#btn-refine-again').classList.toggle('hidden', !(s.audio && s.audio.length));
    $('#btn-refine-again').disabled = Boolean(job && (job.stage === 'uploading' || job.stage === 'transcribing'));
  }

  async function leaveViewer() {
    state.viewing = null;
    state.editingSpeaker = null;
    showView();
    await refreshState();
    if (state.uiMode === 'library') openLibrary();
  }

  function renderLiveChrome() {
    const hk = (state.config && state.config.hotkeys) || {};
    $('#kbd-answer').textContent = accelLabel(hk.answer);
    $('#kbd-code').textContent = accelLabel(hk.code);
    $('#kbd-hide').textContent = accelLabel(hk.toggleWindow);
    const k2 = $('#kbd-answer-2'); if (k2) k2.textContent = accelLabel(hk.answer);
    const k3 = $('#kbd-code-2'); if (k3) k3.textContent = accelLabel(hk.code);
  }

  function renderStatus() {
    const st = state.status;
    if (!st) return;
    const dotClass = (chState) => chState === 'running' ? 'ok' : chState === 'starting' || chState === 'rebinding' ? 'warn' : chState === 'error' ? 'err' : 'idle';
    $('#dot-me').className = `live-only dot ${dotClass(st.audio.me.state)}`;
    $('#dot-me').title = st.audio.me.detail || st.audio.me.state;
    $('#dot-them').className = `live-only dot ${dotClass(st.audio.them.state)}`;
    $('#dot-them').title = st.audio.them.detail || st.audio.them.state;
    const sttClass = !st.stt.enabled ? 'err' : (st.stt.me && st.stt.them) ? 'ok' : (st.stt.me || st.stt.them) ? 'warn' : 'idle';
    $('#dot-stt').className = `live-only dot ${sttClass}`;
    $('#dot-stt').title = !st.stt.enabled ? 'sem chave Deepgram' : `mic ${st.stt.me ? 'ok' : 'off'} · sistema ${st.stt.them ? 'ok' : 'off'}`;

    const lang = st.lang === 'pt' ? 'pt' : 'en';
    const hk = (state.config && state.config.hotkeys) || {};
    $('#btn-lang').textContent = lang === 'pt' ? '🇧🇷' : '🇺🇸';
    $('#btn-lang').title = `Respostas em ${lang === 'pt' ? 'português' : 'inglês'}. Segue o idioma da sua última fala; clique (${accelLabel(hk.language)}) para trocar até você falar de novo.`;

    // Headset banner: HFP warning beats the informational routing line.
    const banner = $('#banner');
    const hfp = st.hfp || {};
    const mr = st.micRouting;
    if (hfp.hfp && hfp.message) {
      banner.textContent = hfp.message;
      banner.className = 'banner warn';
    } else if (hfp.switchedInputTo) {
      banner.textContent = `Fone Bluetooth (${hfp.outputName}): microfone padrão do sistema é ${hfp.switchedInputTo} durante a sessão. No Zoom/Meet mantenha o microfone em "Same as System" ou "${hfp.switchedInputTo}".`;
      banner.className = 'banner';
    } else if (mr && mr.reason === 'avoid_bluetooth_hfp') {
      banner.textContent = `Fone Bluetooth (${mr.outputName}): usando ${mr.deviceName}. No Zoom/Meet escolha também o microfone "${mr.deviceName}", senão o fone cai em modo chamada e o áudio do outro lado vem embaralhado.`;
      banner.className = 'banner';
    } else {
      banner.className = 'banner hidden';
    }

    const a = st.claude && st.claude.answer;
    const badge = $('#model-badge');
    if (a) {
      const used = a.model ? shortModel(a.model) : '';
      const speed = a.speed === 'fast' ? ' ↯' : '';
      badge.textContent = `${used || a.model || ''}${speed} · ${a.effort}`.replace(/^ · /, '');
      badge.className = `badge ${a.speed === 'fast' ? 'fast' : ''}`;
    } else {
      badge.textContent = '';
    }
    const live = state.phase === 'live' && state.mode === 'meeting';
    $('#transcript-note').textContent = live ? (st.recording ? 'gravando áudio' : '') : '';
  }

  function renderParticipants() {
    const el = $('#participants');
    const kind = activeKind();
    if (kind !== 'meeting') { el.innerHTML = ''; return; }
    const names = activeNames();
    const participants = activeParticipants();
    const ids = Object.keys(names);
    if (!ids.length) { el.innerHTML = '<span class="muted small">Os participantes aparecem aqui conforme falam. Clique para nomear.</span>'; return; }
    el.innerHTML = ids.map((spk) => {
      const named = Boolean(participants[spk]);
      if (state.editingSpeaker === spk) {
        return `<span class="pchip editing ${speakerClass(spk, names)}"><input type="text" data-spk="${esc(spk)}" value="${esc(named ? participants[spk].name : '')}" placeholder="${esc(names[spk])}" maxlength="40" /></span>`;
      }
      return `<button type="button" class="pchip ${speakerClass(spk, names)} ${named ? 'named' : ''}" data-spk="${esc(spk)}" title="${spk === 'me' ? 'Você. Clique para trocar o nome.' : 'Clique para dar nome a esta voz.'}"><span class="swatch"></span>${esc(names[spk])}</button>`;
    }).join('');
    el.querySelectorAll('button[data-spk]').forEach((b) => b.addEventListener('click', () => {
      state.editingSpeaker = b.dataset.spk;
      renderParticipants();
      const input = el.querySelector('input[data-spk]');
      if (input) { input.focus(); input.select(); }
    }));
    const input = el.querySelector('input[data-spk]');
    if (input) {
      const finish = async (save) => {
        const spk = input.dataset.spk;
        const value = input.value;
        state.editingSpeaker = null;
        if (save) {
          const id = state.viewing && state.phase !== 'live' ? state.viewing.id : null;
          const r = await api.invoke('participants:rename', { id, speaker: spk, name: value });
          if (!r || !r.ok) showToast('error', (r && r.error) || 'Não foi possível renomear.');
          else applyNames(id, r.names, r.participants);
        }
        renderParticipants();
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      });
      input.addEventListener('blur', () => { if (state.editingSpeaker === input.dataset.spk) finish(true); });
    }
  }

  function applyNames(sessionId, names, participants) {
    if (sessionId && state.viewing && state.viewing.id === sessionId) {
      state.viewing.names = names || state.viewing.names;
      state.viewing.participants = participants || state.viewing.participants;
    } else if (!sessionId || sessionId === state.sessionId) {
      state.names = names || state.names;
      state.participants = participants || state.participants;
    }
    renderParticipants();
    renderTranscript();
    renderMeetingChat();
  }

  function renderTranscript() {
    const el = $('#transcript');
    const pane = el.closest('.pane'); // the pane is the scroll container, not #transcript
    const viewing = state.viewing && state.phase !== 'live';
    const kind = activeKind();
    const names = activeNames();
    const segments = viewing ? state.viewing.segments : state.segments;
    const nearBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 80;
    if (!segments.length) {
      el.innerHTML = `<p class="transcript-empty">${viewing ? 'Sem fala registrada.' : 'Aguardando fala…'}</p>`;
      return;
    }
    let html = '';
    let prev = null;
    for (const s of segments) {
      const who = displayName(s.speaker, names, kind);
      const cls = kind === 'interview' ? (s.speaker === 'me' ? 'me' : 'them') : speakerClass(s.speaker, names);
      const same = prev === s.speaker;
      const time = viewing ? `<span class="t">${fmtClock(s.startedAt).slice(0, 5)}</span>` : '';
      html += `<div class="seg ${cls} ${s.final ? '' : 'open'} ${same ? 'cont' : ''}">
        ${same ? '' : `<span class="who"><span class="swatch"></span>${esc(who)}${time}</span>`}
        <span class="txt">${s.final ? esc(s.text) : `<span class="interim">${esc(s.text)}</span>`}</span></div>`;
      prev = s.speaker;
    }
    el.innerHTML = html;
    if (nearBottom && !viewing) pane.scrollTop = pane.scrollHeight;
  }

  function answerHtml(a) {
    const kind = a.kind === 'code' ? 'Código' : 'Resposta';
    const when = new Date(a.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const shot = a.meta && a.meta.thumb ? `<img class="shot" src="${a.meta.thumb}" alt="screenshot" />` : '';
    let body;
    if (a.status === 'error') body = `<p>Erro: ${esc(a.error || 'desconhecido')}</p>${a.text ? renderMd(a.text) : ''}`;
    else if (a.status === 'queued') body = '<p class="muted">Na fila, aguardando a resposta anterior…</p>';
    else if (!a.text) body = '<p class="muted">Pensando…</p>';
    else body = renderMd(a.text);
    const foot = [];
    if (a.ttftMs != null) foot.push(`${fmtMs(a.ttftMs)} até a primeira palavra`);
    if (a.ms != null) foot.push(`${fmtMs(a.ms)} total`);
    if (a.model) foot.push(shortModel(a.model) + (a.speed === 'fast' ? ' ↯' : ''));
    if (a.meta && a.meta.shotMs != null) foot.push(`screenshot ${fmtMs(a.meta.shotMs)}${a.meta.display ? ` · ${esc(a.meta.display)}` : ''}`);
    return `<article class="answer ${a.status}" data-id="${a.id}">
      <div class="answer-head"><span class="kind ${a.kind}">${kind}</span><span class="time">${when}</span></div>
      ${shot}
      <div class="answer-body">${body}</div>
      ${foot.length ? `<div class="answer-foot">${foot.join(' · ')}</div>` : ''}
    </article>`;
  }

  function renderAnswers() {
    const viewing = state.viewing && state.phase !== 'live';
    if (viewing) {
      // Stored answers are oldest first; show them in order, all at full size.
      const stored = (state.viewing.answers || []).map((a) => ({
        id: a.id, kind: a.kind, text: a.text, status: a.status, error: a.error, at: a.at,
        ms: a.ms, ttftMs: a.ttftMs, model: a.model, meta: { thumb: a.thumb || null },
      }));
      $('#answer-empty').classList.toggle('hidden', stored.length > 0);
      $('#answer-empty').querySelector('p').textContent = stored.length ? '' : 'Nenhuma resposta pedida nesta sessão.';
      $('#answer-current').innerHTML = stored.map(answerHtml).join('');
      $('#answer-history').innerHTML = '';
      return;
    }
    const live = state.answers.filter((a) => a.kind === 'answer' || a.kind === 'code');
    $('#answer-empty').classList.toggle('hidden', live.length > 0);
    $('#answer-current').innerHTML = live.length ? answerHtml(live[0]) : '';
    $('#answer-history').innerHTML = live.slice(1, 12).map(answerHtml).join('');
  }

  function renderSummary() {
    const block = $('#summary-block');
    const viewing = state.viewing && state.phase !== 'live';
    if (!viewing || state.viewing.kind !== 'meeting') { block.classList.add('hidden'); return; }
    const s = state.viewing;
    const streaming = state.summaryStreaming && state.summaryStreaming.sessionId === s.id ? state.summaryStreaming : null;
    const job = state.jobs[s.id];
    if (streaming) {
      block.classList.remove('hidden');
      $('#summary-meta').textContent = 'escrevendo…';
      $('#summary').innerHTML = `<div class="streaming">${renderMd(streaming.text) || '<p class="muted">Pensando…</p>'}</div>`;
      return;
    }
    if (s.summary) {
      block.classList.remove('hidden');
      $('#summary-meta').textContent = `${fmtWhen(s.summary.at)}${s.summary.model ? ' · ' + shortModel(s.summary.model) : ''}`;
      $('#summary').innerHTML = renderMd(s.summary.text);
      return;
    }
    if (job && job.stage !== 'done') {
      block.classList.remove('hidden');
      $('#summary-meta').textContent = '';
      $('#summary').innerHTML = `<p class="muted">${esc(jobLabel(job))}${job.stage === 'error' && job.error ? ` — ${esc(job.error)}` : ''}</p>`;
      return;
    }
    block.classList.remove('hidden');
    $('#summary-meta').textContent = '';
    $('#summary').innerHTML = '<p class="muted">Sem resumo ainda. Clique em Resumir.</p>';
  }

  function activeChat() {
    const viewing = state.viewing && state.phase !== 'live';
    return viewing ? (state.viewing.chat || []) : state.chat;
  }

  function renderMeetingChat() {
    const kind = activeKind();
    if (kind !== 'meeting') return;
    const log = $('#mchat-log');
    const msgs = activeChat();
    const live = state.phase === 'live' && state.mode === 'meeting';
    const viewing = state.viewing && state.phase !== 'live';
    if (!msgs.length) {
      log.innerHTML = `<p class="muted mchat-empty">${live ? 'Perdeu algo? Pergunte: "o que a Ana disse sobre o prazo?"' : viewing ? 'Pergunte qualquer coisa sobre esta reunião.' : ''}</p>`;
    } else {
      log.innerHTML = msgs.map((m) => {
        if (m.role === 'user') return `<div class="msg user"><span class="who">Você</span><div class="body">${inline(m.text).replace(/\n/g, '<br>')}</div></div>`;
        const cls = m.status === 'streaming' ? 'streaming' : m.status === 'error' ? 'error' : '';
        return `<div class="msg assistant ${cls}"><span class="who">Claude</span><div class="body">${m.text ? renderMd(m.text) : '<p class="muted">Pensando…</p>'}</div></div>`;
      }).join('');
    }
    log.scrollTop = log.scrollHeight;
    const enabled = Boolean(state.claudeBinary) && (live || viewing);
    $('#mchat-input').disabled = !enabled;
    $('#mchat-send').disabled = !enabled;
    $('#mchat-note').textContent = state.claudeBinary ? '' : 'Claude não encontrado';
  }

  // ---------- timer ----------

  setInterval(() => {
    if (state.phase !== 'live' || !state.startedAt) return;
    const s = Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000));
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    $('#timer').textContent = `${mm}:${ss}`;
  }, 500);

  // ---------- events from main ----------

  api.on('phase', (d) => {
    const wasLive = state.phase === 'live';
    state.phase = d.phase;
    state.mode = d.mode || state.mode;
    state.startedAt = d.startedAt || null;
    if (d.phase === 'live') {
      // New session: nothing from the previous one stays on screen.
      state.answers = [];
      state.segments = [];
      state.chat = [];
      state.names = {};
      state.participants = {};
      state.viewing = null;
      state.sessionId = d.sessionId || null;
      renderLiveChrome();
    }
    showView();
    renderAnswers();
    renderTranscript();
    renderParticipants();
    renderMeetingChat();
    renderSummary();
    if (d.phase === 'setup') {
      state.sessionId = null;
      refreshState().then(() => {
        // A finished meeting opens straight away so the refine and summary can be watched.
        if (wasLive && d.mode === 'meeting' && d.sessionId) viewSession(d.sessionId);
      });
    }
  });

  api.on('status', (st) => { state.status = st; renderStatus(); });

  const levelEls = { me: null, them: null };
  api.on('level', (d) => {
    const el = levelEls[d.channel] || (levelEls[d.channel] = $(`#lvl-${d.channel}`));
    if (!el) return;
    // rms 0..1 -> perceptual-ish width
    const pct = Math.min(100, Math.round(Math.sqrt(Math.min(1, d.rms * 6)) * 100));
    el.style.width = `${pct}%`;
    clearTimeout(el._decay);
    el._decay = setTimeout(() => { el.style.width = '0%'; }, 400);
  });

  api.on('transcript', (d) => {
    state.segments = d.segments || [];
    const before = Object.keys(state.names).join('|');
    state.names = d.names || state.names;
    renderTranscript();
    if (Object.keys(state.names).join('|') !== before) renderParticipants();
  });

  api.on('participants', (d) => applyNames(d.live ? null : d.sessionId, d.names, d.participants));

  api.on('job', (d) => {
    if (d.stage === 'done') delete state.jobs[d.id];
    else state.jobs[d.id] = { stage: d.stage, error: d.error };
    if (state.viewing && state.viewing.id === d.id) {
      renderViewTitle();
      renderSummary();
      // The offline pass replaced the transcript: reload what is on screen.
      if (d.stage === 'done' || d.stage === 'summarizing') viewSession(d.id);
    }
    renderRecentMeetings();
    if (state.uiMode === 'library' && !state.viewing) renderLibrary();
    if (d.stage === 'done' || d.stage === 'error') refreshLists();
  });

  function findAnswer(id) { return state.answers.find((a) => a.id === id); }

  function chatTarget(meta) {
    const sid = meta && meta.sessionId ? meta.sessionId : null;
    if (!sid) return state.phase === 'live' ? state.chat : null;
    if (state.viewing && state.viewing.id === sid) return state.viewing.chat || (state.viewing.chat = []);
    return null;
  }

  function upsertChatMsg(list, msg) {
    const i = list.findIndex((m) => m.id === msg.id);
    if (i >= 0) list[i] = { ...list[i], ...msg }; else list.push(msg);
  }

  api.on('answer:queued', (d) => {
    if (d.kind === 'chat') {
      const list = chatTarget(d.meta);
      if (list) { upsertChatMsg(list, { id: d.id, role: 'assistant', text: '', status: 'streaming', at: Date.now() }); renderMeetingChat(); }
      return;
    }
    if (d.kind !== 'answer' && d.kind !== 'code') return;
    state.answers.unshift({ id: d.id, kind: d.kind, text: '', status: 'queued', at: Date.now(), meta: {} });
    renderAnswers();
  });

  api.on('answer:start', (d) => {
    if (d.kind === 'setup') {
      let m = state.setupChat.find((c) => c.id === d.id);
      if (!m) { m = { id: d.id, role: 'assistant', text: '', status: 'streaming' }; state.setupChat.push(m); }
      m.status = 'streaming';
      renderSetupChat();
      return;
    }
    if (d.kind === 'chat') {
      const list = chatTarget(d.meta);
      if (list) { upsertChatMsg(list, { id: d.id, role: 'assistant', text: '', status: 'streaming', at: Date.now() }); renderMeetingChat(); }
      return;
    }
    if (d.kind === 'summary') {
      state.summaryStreaming = { sessionId: d.meta.sessionId, text: '' };
      renderSummary();
      return;
    }
    let a = findAnswer(d.id);
    if (!a) { a = { id: d.id, kind: d.kind, text: '', at: Date.now(), meta: {} }; state.answers.unshift(a); }
    a.status = 'streaming';
    a.meta = d.meta || {};
    a.at = (d.meta && d.meta.at) || a.at;
    renderAnswers();
    $('.answer-pane') && ($('.answer-pane').scrollTop = 0);
  });

  api.on('answer:delta', (d) => {
    if (d.kind === 'setup') {
      const m = state.setupChat.find((c) => c.id === d.id);
      if (m) { m.text = d.full; renderSetupChat(); }
      return;
    }
    if (d.kind === 'chat') {
      const list = chatTarget(d.meta);
      if (list) { upsertChatMsg(list, { id: d.id, role: 'assistant', text: d.full, status: 'streaming' }); renderMeetingChat(); }
      return;
    }
    if (d.kind === 'summary') {
      if (state.summaryStreaming && state.summaryStreaming.sessionId === d.meta.sessionId) { state.summaryStreaming.text = d.full; renderSummary(); }
      return;
    }
    const a = findAnswer(d.id);
    if (!a) return;
    a.text = d.full;
    renderAnswers();
  });

  api.on('answer:done', (d) => {
    if (d.kind === 'setup') {
      const m = state.setupChat.find((c) => c.id === d.id);
      if (m) { m.text = d.text; m.status = 'done'; renderSetupChat(); }
      $('#chat-send').disabled = false;
      return;
    }
    if (d.kind === 'chat') {
      const list = chatTarget(d.meta);
      if (list) { upsertChatMsg(list, { id: d.id, role: 'assistant', text: d.text, status: 'done' }); renderMeetingChat(); }
      $('#mchat-send').disabled = false;
      return;
    }
    if (d.kind === 'summary') {
      state.summaryStreaming = null;
      if (state.viewing && state.viewing.id === d.meta.sessionId) viewSession(d.meta.sessionId);
      return;
    }
    const a = findAnswer(d.id);
    if (!a) return;
    a.text = d.text || a.text;
    a.status = 'done';
    a.ms = d.ms; a.ttftMs = d.ttftMs; a.model = d.model; a.speed = d.speed;
    renderAnswers();
  });

  api.on('answer:error', (d) => {
    if (d.kind === 'setup') {
      const m = state.setupChat.find((c) => c.id === d.id);
      if (m) { m.status = 'done'; m.text = (m.text || '') + `\n\n*Erro: ${d.message}*`; renderSetupChat(); }
      $('#chat-send').disabled = false;
      showToast('error', `Claude (preparação): ${d.message}`);
      return;
    }
    if (d.kind === 'chat') {
      const list = chatTarget(d.meta);
      if (list) { upsertChatMsg(list, { id: d.id, role: 'assistant', text: `${d.partial || ''}\n\n*Erro: ${d.message}*`.trim(), status: 'error' }); renderMeetingChat(); }
      $('#mchat-send').disabled = false;
      return;
    }
    if (d.kind === 'summary') {
      state.summaryStreaming = null;
      renderSummary();
      return;
    }
    const a = findAnswer(d.id);
    if (!a) return;
    a.status = 'error'; a.error = d.message; a.text = d.partial || a.text;
    renderAnswers();
  });

  api.on('setup:briefing', (d) => {
    const ta = $('#briefing');
    ta.value = d.briefing;
    ta.classList.add('flash');
    setTimeout(() => ta.classList.remove('flash'), 1500);
    showToast('info', 'Briefing pronto. Revise e clique em Começar sessão.');
  });

  api.on('toast', (d) => showToast(d.level, d.message));

  function applyAlpha(alpha) {
    const a = Math.min(1, Math.max(0.3, Number(alpha) || 1));
    document.documentElement.style.setProperty('--bg-alpha', String(a));
    const slider = $('#opacity');
    if (slider && Number(slider.value) !== Math.round(a * 100)) slider.value = String(Math.round(a * 100));
  }
  api.on('opacity', (d) => applyAlpha(d.alpha));
  $('#opacity').addEventListener('input', (e) => {
    const a = Number(e.target.value) / 100;
    applyAlpha(a);
    api.invoke('window:opacity', { alpha: a });
  });

  // ---------- actions ----------

  async function refreshLists() {
    let all = [];
    try { all = (await api.invoke('sessions:list')) || []; } catch { all = []; }
    state.sessions = all.filter((s) => s.kind !== 'meeting');
    state.meetings = all.filter((s) => s.kind === 'meeting');
    try { state.people = (await api.invoke('sessions:people')) || []; } catch { state.people = []; }
    renderSessions();
    renderRecentMeetings();
    renderSidePeople();
  }

  async function refreshState() {
    const s = await api.invoke('state:get');
    state.phase = s.phase;
    state.mode = s.mode || state.mode;
    state.startedAt = s.startedAt;
    state.sessionId = s.sessionId || null;
    state.config = s.config;
    state.permissions = s.permissions;
    state.deepgramKey = s.deepgramKey;
    state.claudeBinary = s.claudeBinary;
    state.native = s.native;
    state.headset = s.headset;
    state.status = s.status;
    state.jobs = s.jobs || {};
    applyAlpha(s.alpha);
    state.segments = s.segments || [];
    state.names = s.names || {};
    state.participants = s.participants || {};
    state.chat = s.chat || [];
    if (!$('#briefing').value && s.briefing) $('#briefing').value = s.briefing;
    const sel = $('#meeting-lang');
    const wanted = localStorage.getItem('meetingLang') || (s.config && s.config.meeting && s.config.meeting.language) || 'pt-BR';
    if ([...sel.options].some((o) => o.value === wanted)) sel.value = wanted;
    await refreshLists();
    showView();
    renderSetup();
    renderLiveChrome();
    renderStatus();
    renderParticipants();
    renderTranscript();
    renderAnswers();
    renderMeetingChat();
    renderSummary();
    console.log(`[ui] state loaded: phase=${state.phase} mode=${state.mode} deepgram=${state.deepgramKey} claude=${Boolean(state.claudeBinary)} native=${state.native.available} checklist=${$('#checklist').children.length}`);
  }

  async function sendSetupChat(text) {
    const t = (text || '').trim();
    if (!t) return;
    state.setupChat.push({ id: `u-${Date.now()}`, role: 'user', text: t });
    renderSetupChat();
    $('#chat-send').disabled = true;
    const r = await api.invoke('setup:chat', { text: t });
    if (!r || !r.ok) { $('#chat-send').disabled = false; showToast('error', 'Não foi possível falar com o Claude.'); }
  }

  async function sendMeetingChat(text) {
    const t = (text || '').trim();
    if (!t) return;
    const viewing = state.viewing && state.phase !== 'live';
    const id = viewing ? state.viewing.id : null;
    const list = viewing ? (state.viewing.chat || (state.viewing.chat = [])) : state.chat;
    list.push({ id: `u-${Date.now()}`, role: 'user', text: t, at: Date.now() });
    renderMeetingChat();
    $('#mchat-send').disabled = true;
    const r = await api.invoke('meeting:chat', { id, text: t });
    if (!r || !r.ok) {
      $('#mchat-send').disabled = false;
      showToast('error', (r && r.error) || 'Não foi possível perguntar ao Claude.');
    }
  }

  // mode tabs
  $$('.mode-tabs .tab').forEach((b) => b.addEventListener('click', () => { setUiMode(b.dataset.mode); renderSetup(); }));
  $('#btn-library').addEventListener('click', () => setUiMode('library'));
  $('#lib-back').addEventListener('click', () => setUiMode('meeting'));
  $$('.lib-tabs .tab').forEach((b) => b.addEventListener('click', () => { state.lib.detail = null; setLibTab(b.dataset.tab); renderLibrary(); }));
  $('#lib-q').addEventListener('input', (e) => {
    state.lib.q = e.target.value;
    if (libTimer) clearTimeout(libTimer);
    libTimer = setTimeout(runSearch, 250);
  });
  $('#lib-person').addEventListener('change', (e) => { state.lib.person = e.target.value; state.lib.detail = null; runSearch(); });

  // meeting start
  async function startMeeting(briefing, event) {
    const btn = $('#btn-start-meeting');
    btn.disabled = true; btn.textContent = 'Iniciando…';
    try {
      const r = await api.invoke('session:start', { mode: 'meeting', briefing, language: $('#meeting-lang').value, event });
      if (r && r.warnings && r.warnings.length) showToast('warn', r.warnings.join(' · '), 8000);
      $('#context').value = '';
    } finally {
      btn.disabled = false; btn.textContent = 'Começar reunião';
    }
  }
  $('#btn-start-meeting').addEventListener('click', () => startMeeting($('#context').value));
  $('#cal-refresh').addEventListener('click', () => refreshCalendar(false));
  // Keep the list current while the setup screen is up: every 5 min and when the window comes back.
  setInterval(() => { if (state.phase === 'setup') refreshCalendar(false); }, 5 * 60 * 1000);
  window.addEventListener('focus', () => {
    if (state.phase === 'setup' && Date.now() - state.calendar.fetchedAt > 60 * 1000) refreshCalendar(false);
  });

  // interview setup
  $('#btn-refine').addEventListener('click', async () => {
    $('#setup-chat').classList.remove('hidden');
    const ctx = $('#briefing').value.trim();
    if (!state.chatStarted) {
      state.chatStarted = true;
      await sendSetupChat(ctx
        ? `Here is my raw context. Ask what you need, then produce the briefing.\n\n${ctx}`
        : 'I have no written context yet. Ask me the questions you need to build my briefing.');
    } else {
      $('#chat-input').focus();
    }
  });
  $('#chat-send').addEventListener('click', () => { const i = $('#chat-input'); sendSetupChat(i.value); i.value = ''; });
  $('#chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); const i = $('#chat-input'); sendSetupChat(i.value); i.value = ''; } });
  $('#chat-reset').addEventListener('click', async () => {
    await api.invoke('setup:reset');
    state.setupChat = []; state.chatStarted = false; $('#chat-send').disabled = false;
    renderSetupChat();
  });
  $('#btn-start').addEventListener('click', async () => {
    const btn = $('#btn-start');
    btn.disabled = true; btn.textContent = 'Iniciando…';
    try {
      const r = await api.invoke('session:start', { mode: 'interview', briefing: $('#briefing').value });
      if (r && r.warnings && r.warnings.length) showToast('warn', r.warnings.join(' · '), 8000);
    } finally {
      btn.disabled = false; btn.textContent = 'Começar sessão';
    }
  });

  // live
  $('#btn-answer').addEventListener('click', () => api.invoke('answer:ask'));
  $('#btn-code').addEventListener('click', () => api.invoke('code:ask'));
  $('#btn-lang').addEventListener('click', () => api.invoke('lang:toggle'));
  $('#btn-clear').addEventListener('click', () => api.invoke('transcript:clear'));
  $('#btn-hide').addEventListener('click', () => api.invoke('window:toggle'));
  $('#btn-stop').addEventListener('click', async () => {
    const btn = $('#btn-stop');
    btn.disabled = true; btn.textContent = 'Parando…';
    try { await api.invoke('session:stop'); } finally { btn.disabled = false; btn.textContent = 'Parar'; }
  });

  // meeting chat
  $('#mchat-send').addEventListener('click', () => { const i = $('#mchat-input'); sendMeetingChat(i.value); i.value = ''; });
  $('#mchat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); const i = $('#mchat-input'); sendMeetingChat(i.value); i.value = ''; } });

  // viewer
  $('#btn-back').addEventListener('click', leaveViewer);
  $('#btn-reveal').addEventListener('click', () => { if (state.viewing) api.invoke('sessions:reveal', { id: state.viewing.id }); });
  $('#btn-summarize').addEventListener('click', async () => {
    if (!state.viewing) return;
    const r = await api.invoke('meeting:summarize', { id: state.viewing.id });
    if (!r || !r.ok) showToast('error', (r && r.error) || 'Não foi possível resumir.');
  });
  $('#btn-refine-again').addEventListener('click', async () => {
    if (!state.viewing) return;
    await api.invoke('meeting:refine', { id: state.viewing.id });
  });
  $('#btn-delete').addEventListener('click', async () => {
    if (!state.viewing) return;
    const what = state.viewing.kind === 'meeting' ? 'esta reunião (transcrição, áudio, resumo e chat)' : 'esta sessão (transcrição e respostas)';
    if (!window.confirm(`Apagar ${what}? Não dá para desfazer.`)) return;
    await api.invoke('sessions:delete', { id: state.viewing.id });
    leaveViewer();
  });

  $('#meeting-lang').addEventListener('change', (e) => localStorage.setItem('meetingLang', e.target.value));

  setUiMode(state.uiMode === 'library' ? 'meeting' : state.uiMode);
  refreshState().then(() => refreshCalendar(false));
})();
