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
    prepOpen: false,      // preparation drawer
    profile: '',          // profile.md: resume and stories, shared by every interview
    profileSavedAt: null,
    systemAudioOkAt: null, // last time the system channel carried sound
    loaded: false,        // first state:get done
    meetings: [],         // past meetings (summaries)
    people: [],
    jobs: {},             // sessionId -> { stage, error }
    viewing: null,        // a loaded past session, read-only
    lib: { tab: 'all', q: '', person: '', results: [], detail: null },
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

  /** 28/10 */
  function fmtShort(ts) {
    return new Date(ts).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  }

  /** hoje · ontem · qua 28/10 · 28/10/25 */
  function fmtDay(ts) {
    const d = new Date(ts); d.setHours(0, 0, 0, 0);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const diff = Math.round((today - d) / 86400000);
    if (diff === 0) return 'hoje';
    if (diff === 1) return 'ontem';
    if (d.getFullYear() !== today.getFullYear()) return new Date(ts).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' });
    return `${new Date(ts).toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '')} ${fmtShort(ts)}`;
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
    const home = !live && !viewing;
    const library = home && state.uiMode === 'library';
    $('#topbar').classList.toggle('hidden', !home);
    $('#view-setup').classList.toggle('hidden', !home || library);
    $('#view-library').classList.toggle('hidden', !library);
    $('#view-live').classList.toggle('hidden', home);
    $('#view-live').classList.toggle('readonly', viewing && !live);
    $('#prep').classList.toggle('hidden', !(home && state.uiMode === 'interview' && state.prepOpen));
    if (!home) closeOverlays();
    applyBodyMode();
  }

  function setUiMode(m) {
    state.uiMode = m;
    localStorage.setItem('uiMode', m);
    $$('.mode-tabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
    $('#panel-meeting').classList.toggle('hidden', m !== 'meeting');
    $('#panel-interview').classList.toggle('hidden', m !== 'interview');
    showView();
    renderReadiness();
    if (m === 'library') openLibrary();
  }

  function closeOverlays() {
    stopRecording(false);
    $('#status-pop').classList.add('hidden');
    $('#settings-modal').classList.add('hidden');
    $('#profile-modal').classList.add('hidden');
  }

  // ---------- home: readiness (pill, diagnostics, blocking issues) ----------

  /** One line per dependency. `err` items also show up above the page with their fix. */
  function readiness() {
    const items = [];
    const add = (level, label, value, extra) => items.push({ level, label, value, ...(extra || {}) });
    add(state.claudeBinary ? 'ok' : 'err', 'Claude Code', state.claudeBinary ? 'ok' : 'não encontrado', {
      title: state.claudeBinary || '',
      issue: 'Claude Code não encontrado: sem respostas, resumo e chat. Instale e rode claude uma vez no terminal.',
    });
    add(state.deepgramKey ? 'ok' : 'err', 'Deepgram', state.deepgramKey ? 'ok' : 'sem chave', {
      issue: 'Falta a chave Deepgram (DEEPGRAM_API_KEY no .env). Grava o áudio, mas sem transcrição.',
    });
    add(state.native.available ? 'ok' : 'err', 'Motor de áudio', state.native.available ? 'ok' : 'indisponível', {
      issue: `Motor de áudio nativo indisponível: ${state.native.error || 'erro desconhecido'}.`,
    });
    const mic = state.permissions.microphone;
    add(mic === 'granted' ? 'ok' : mic === 'not-determined' ? 'warn' : 'err', 'Microfone',
      mic === 'granted' ? 'permitido' : mic === 'not-determined' ? 'pede ao começar' : 'negado', {
        issue: 'Microfone negado: sua voz não é gravada.',
        perm: 'microphone', action: mic === 'not-determined' ? 'pedir' : 'abrir ajustes',
      });
    add(state.systemAudioOkAt ? 'ok' : 'warn', 'Áudio do sistema',
      state.systemAudioOkAt ? `ok · ${fmtShort(state.systemAudioOkAt)}` : 'pede na primeira captura',
      { perm: 'audio', action: 'ajustes', title: 'Confirmado quando o canal do sistema traz som numa sessão.' });
    if (state.uiMode === 'interview') {
      const scr = state.permissions.screen;
      add(scr === 'granted' ? 'ok' : scr === 'not-determined' ? 'warn' : 'err', 'Tela (Código)',
        scr === 'granted' ? 'permitida' : scr === 'not-determined' ? 'pede no primeiro screenshot' : 'negada', {
          issue: 'Gravação de tela negada: o atalho de Código não funciona.',
          perm: 'screen', action: 'abrir ajustes',
        });
    }
    const hs = state.headset || {};
    if (hs.outputName) {
      add(hs.bluetooth ? 'warn' : 'ok', 'Saída', hs.bluetooth ? `${hs.outputName} · usa o mic do Mac` : hs.outputName, {
        title: hs.bluetooth ? 'Bluetooth: o app usa o microfone do Mac e o define como padrão do sistema durante a sessão.' : '',
      });
    } else if (!hs.helper) {
      add('warn', 'Helper de áudio', 'rode npm install', { title: 'native/audio-defaults não compilado' });
    }
    return items;
  }

  function renderReadiness() {
    if (!state.loaded) return;
    const items = readiness();
    const issues = items.filter((i) => i.level === 'err');
    $('#status-pill').classList.toggle('warn', issues.length > 0);
    $('#status-pill .dot').className = `dot ${issues.length ? 'warn' : 'ok'}`;
    $('#status-text').textContent = issues.length ? `${issues.length} ${issues.length === 1 ? 'pendência' : 'pendências'}` : 'Pronto';
    $('#status-pop-title').textContent = issues.length ? 'Falta algo para gravar tudo' : 'Pronto para gravar';
    $('#checklist').innerHTML = items.map((i) => `
      <li title="${esc(i.title || '')}"><span class="dot ${i.level}"></span><span class="ck-label">${esc(i.label)}</span><span class="ck-value ${i.level}">${esc(i.value)}</span>${i.perm && i.level !== 'ok' ? `<button class="link" data-perm="${i.perm}" type="button">${esc(i.action)}</button>` : '<span></span>'}</li>`).join('');
    const box = $('#issues');
    box.innerHTML = issues.map((i) => `
      <div class="issue"><span class="issue-icon">⚠</span><span class="grow">${esc(i.issue)}</span>${i.perm ? `<button class="link" data-perm="${i.perm}" type="button">${esc(i.action)}</button>` : ''}</div>`).join('');
    box.classList.toggle('hidden', !issues.length);
  }

  // ---------- home: session rows (recent meetings, library) ----------

  /** "jonatas@acme.com" or "Jonatas Silva" -> "Jonatas". */
  function shortGuest(g) {
    const s = String(g || '').trim();
    const base = s.includes('@') ? s.split('@')[0] : s;
    const first = base.split(/[\s._-]+/).find(Boolean) || base;
    return first.charAt(0).toUpperCase() + first.slice(1);
  }

  /** "Ana", "Ana e Bruno", "Ana, Bruno, Caio e mais 4". */
  function namesLine(names, max = 3) {
    const list = (names || []).filter(Boolean);
    if (list.length > max) return `${list.slice(0, max).join(', ')} e mais ${list.length - max}`;
    if (list.length > 1) return `${list.slice(0, -1).join(', ')} e ${list[list.length - 1]}`;
    return list[0] || '';
  }

  function sessionStatus(s) {
    const job = state.jobs[s.id];
    if (job && job.stage !== 'done') return `<span class="st ${job.stage === 'error' ? 'err' : 'busy'}">${esc(jobLabel(job))}</span>`;
    if (s.refined === 'error') return '<span class="st err">refino falhou</span>';
    return '';
  }

  function sessionRowHtml(s, opts) {
    const o = opts || {};
    const sub = s.kind === 'meeting'
      ? namesLine(s.participants && s.participants.length ? s.participants : (s.guests || []).map(shortGuest))
      : `Entrevista · ${s.answers} ${s.answers === 1 ? 'resposta' : 'respostas'}`;
    const matches = o.matches && s.matches && s.matches.length
      ? `<ul class="hits">${s.matches.map((m) => `<li><span class="who">${esc(m.speaker)}</span> ${esc(m.text)}</li>`).join('')}</ul>`
      : '';
    return `<li class="srow" data-id="${esc(s.id)}" title="Abrir">
      <div class="srow-main">
        <div class="srow-title">${esc(s.title)}</div>
        ${sub ? `<div class="srow-sub">${esc(sub)}</div>` : ''}
        ${matches}
      </div>
      <div class="srow-meta"><span>${esc(fmtDay(s.startedAt))} · ${fmtDuration(s.durationMs)}</span>${sessionStatus(s)}</div>
    </li>`;
  }

  function renderRecentMeetings() {
    const el = $('#recent-meetings');
    const list = state.meetings.slice(0, 3);
    el.innerHTML = list.length
      ? list.map((s) => sessionRowHtml(s)).join('')
      : '<li class="rows-empty">Nenhuma reunião ainda. O app grava seu microfone e o áudio do Mac em canais separados, sem bot na chamada, e guarda tudo no seu Mac.</li>';
  }

  // ---------- home: meeting (calendar + ad-hoc) ----------

  // The next calendar meeting takes over the page when it starts within this window.
  const HERO_AHEAD_MS = 90 * 60 * 1000;

  function hm(ts) {
    return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  function dayLabel(ts) {
    const day = new Date(ts); day.setHours(0, 0, 0, 0);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const diff = Math.round((day - today) / 86400000);
    if (diff <= 0) return 'Hoje';
    if (diff === 1) return 'Amanhã';
    return new Date(ts).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' }).replace('.', '');
  }

  function heroWhen(e) {
    const span = `${hm(e.start)}–${hm(e.end)}`;
    const now = Date.now();
    if (e.start <= now) return `<span class="soon">Agora</span> · ${span}`;
    const min = Math.round((e.start - now) / 60000);
    if (min <= 60) return `<span class="soon">Em ${min} min</span> · ${span}`;
    return `${esc(dayLabel(e.start))} · ${span}`;
  }

  function heroHtml(e) {
    const guests = namesLine((e.guests || []).map(shortGuest));
    const actions = e.link
      ? `<button class="btn primary" data-join="${esc(e.id)}" type="button" title="${esc(e.link)}">Entrar e gravar</button><button class="link" data-rec="${esc(e.id)}" type="button">só gravar</button>`
      : `<button class="btn primary" data-rec="${esc(e.id)}" type="button">Gravar</button>`;
    return `<div class="hero">
      <span class="hero-bar"></span>
      <div class="hero-main">
        <div class="hero-when">${heroWhen(e)}</div>
        <div class="hero-title" title="${esc(e.title)}">${esc(e.title || '(sem título)')}</div>
        ${guests ? `<div class="hero-who">${esc(guests)}</div>` : ''}
      </div>
      <div class="hero-actions">${actions}</div>
    </div>`;
  }

  function renderUpcoming() {
    const cal = state.calendar;
    const granted = cal.access === 'granted';
    const events = granted ? cal.events : [];
    const first = events[0];
    const hero = first && first.start - Date.now() <= HERO_AHEAD_MS ? first : null;
    $('#panel-meeting').classList.toggle('has-hero', Boolean(hero));
    $('#cal-hero').innerHTML = hero ? heroHtml(hero) : '';
    // The page CSP blocks style attributes; set the calendar color through the CSSOM.
    if (hero && /^#[0-9a-f]{6}$/i.test(hero.color || '')) $('#cal-hero .hero').style.setProperty('--cal', hero.color);
    $('#cal-more').innerHTML = hero ? events.slice(1, 3).map((e) => `
      <li><span class="t">${esc(dayLabel(e.start))} ${hm(e.start)}</span><span class="grow" title="${esc(e.title)}">${esc(e.title || '(sem título)')}</span><button class="link" data-rec="${esc(e.id)}" type="button">gravar</button></li>`).join('') : '';
    let line = '';
    if (!hero) {
      if (cal.access === 'notDetermined' || cal.access === 'unknown') {
        line = 'Veja aqui suas próximas reuniões do Calendário do Mac. <button class="link" data-cal="connect" type="button">conectar calendário</button>';
      } else if (cal.access && !granted && cal.access !== 'unavailable') {
        line = 'Sem acesso ao calendário. <button class="link" data-cal="settings" type="button">abrir ajustes</button>';
      } else if (first) {
        line = `Próxima no calendário: <b>${esc(dayLabel(first.start).toLowerCase())} ${hm(first.start)} · ${esc(first.title || '(sem título)')}</b> <button class="link" data-rec="${esc(first.id)}" type="button">gravar</button>`;
      }
    }
    $('#cal-line').innerHTML = line;
    $('#cal-line').classList.toggle('hidden', !line);
    renderAdhoc();
  }

  /** With a calendar meeting up front, the ad-hoc start steps back to a small button. */
  function renderAdhoc() {
    const hero = $('#panel-meeting').classList.contains('has-hero');
    const btn = $('#btn-start-meeting');
    if (!btn.disabled) btn.textContent = hero ? 'Começar reunião avulsa' : 'Começar reunião';
    btn.classList.toggle('primary', !hero);
    btn.classList.toggle('secondary', hero);
    btn.classList.toggle('small', hero);
  }

  async function refreshCalendar(request) {
    const cal = state.calendar;
    if (cal.loading) return;
    cal.loading = true;
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

  // ---------- home: interview (profile + this interview) ----------

  function profileHeadline(text) {
    const line = text.split('\n').map((l) => l.replace(/^[#*\s]+/, '').replace(/\*+$/, '').trim()).find(Boolean) || '';
    return line.length > 70 ? `${line.slice(0, 69)}…` : line;
  }

  function initials(name) {
    const words = name.split(/\s+/).filter((w) => /^\p{L}/u.test(w));
    if (!words.length) return 'CV';
    return (words[0][0] + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase();
  }

  function renderProfile() {
    const card = $('#profile-card');
    const text = (state.profile || '').trim();
    $('#profile-edit').classList.toggle('hidden', !text);
    card.classList.toggle('empty', !text);
    if (!text) {
      card.innerHTML = '<span class="grow">Cole seu currículo uma vez. Ele fica salvo para todas as entrevistas.</span><button class="btn secondary small" type="button">Adicionar perfil</button>';
      return;
    }
    const name = profileHeadline(text);
    const words = text.split(/\s+/).filter(Boolean).length;
    const saved = state.profileSavedAt ? ` · salvo em ${fmtShort(state.profileSavedAt)}` : '';
    card.innerHTML = `<span class="avatar">${esc(initials(name))}</span><span class="grow"><span class="pc-name">${esc(name)}</span><span class="pc-sub">${words} palavras${saved}</span></span>`;
  }

  function renderKeysLine() {
    const cfg = state.config || {};
    const hk = cfg.hotkeys || {};
    $('#keys-line').innerHTML = [[hk.answer, 'resposta'], [hk.code, 'código pela tela'], [hk.toggleWindow, 'ocultar']]
      .filter(([k]) => k)
      .map(([k, label]) => `<span><kbd>${esc(accelLabel(k))}</kbd> ${label}</span>`).join('');
    $('#setup-model').textContent = cfg.setup ? `${cfg.setup.model} · ${cfg.setup.effort}` : '';
  }

  function openProfile() {
    $('#profile-text').value = state.profile || '';
    $('#profile-modal').classList.remove('hidden');
    $('#profile-text').focus();
  }

  function closeProfile() {
    const changed = $('#profile-text').value.trim() !== (state.profile || '').trim();
    if (changed && !window.confirm('Descartar as alterações do perfil?')) return;
    $('#profile-modal').classList.add('hidden');
  }

  async function saveProfileText() {
    const r = await api.invoke('profile:save', { text: $('#profile-text').value });
    if (!r || !r.ok) { showToast('error', (r && r.error) || 'Perfil não salvo.'); return; }
    state.profile = r.profile || '';
    state.profileSavedAt = r.savedAt || null;
    renderProfile();
    $('#profile-modal').classList.add('hidden');
    showToast('info', 'Perfil salvo.');
  }

  function setPrepOpen(open) {
    state.prepOpen = open;
    showView();
  }

  function renderSetupChat() {
    const log = $('#chat-log');
    log.innerHTML = state.setupChat.map((m) => {
      if (m.role === 'user') return `<div class="msg user"><span class="who">Você</span><div class="body">${inline(m.text).replace(/\n/g, '<br>')}</div></div>`;
      // Hide the <briefing> block from the chat; it lands in the job field.
      const visible = m.text.replace(/<briefing>[\s\S]*?(<\/briefing>|$)/i, m.status === 'done' ? '<em>(briefing copiado para Esta entrevista)</em>' : '<em>(escrevendo o briefing…)</em>');
      return `<div class="msg assistant ${m.status === 'streaming' ? 'streaming' : ''}"><span class="who">Claude</span><div class="body">${renderMd(visible)}</div></div>`;
    }).join('');
    log.scrollTop = log.scrollHeight;
  }

  // ---------- settings ----------

  const MODEL_CHOICES = ['sonnet', 'opus', 'haiku'];
  const EFFORT_CHOICES = ['low', 'medium', 'high', 'xhigh', 'max'];
  const MODEL_ROWS = [['answer', 'Respostas'], ['code', 'Código'], ['setup', 'Preparação'], ['meeting.summary', 'Resumo da reunião'], ['meeting.chat', 'Chat da reunião']];
  const MEETING_FLAGS = [['diarize', 'Separar as vozes do outro lado'], ['saveAudio', 'Gravar o áudio'], ['refine', 'Refinar a transcrição ao parar'], ['autoSummary', 'Resumo automático ao parar']];
  const HOTKEY_ROWS = [['answer', 'Resposta agora'], ['code', 'Screenshot e solução'], ['toggleWindow', 'Ocultar / mostrar'], ['language', 'Idioma da resposta'], ['opacityUp', 'Fundo mais opaco'], ['opacityDown', 'Fundo menos opaco']];

  function cfgAt(keyPath) {
    return keyPath.split('.').reduce((o, k) => (o ? o[k] : undefined), state.config);
  }

  /** "meeting.chat", { model } -> { meeting: { chat: { model } } } */
  function patchAt(keyPath, value) {
    return keyPath.split('.').reduceRight((inner, k) => ({ [k]: inner }), value);
  }

  function renderSettings() {
    const c = state.config;
    if (!c) return;
    const options = (list, cur) => (list.includes(cur) ? list : [cur, ...list])
      .map((v) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(v)}</option>`).join('');
    const models = MODEL_ROWS.map(([key, label]) => {
      const m = cfgAt(key) || {};
      return `<div class="set-row"><span>${label}</span><span class="set-ctl">
        <select data-model="${key}" aria-label="Modelo: ${label}">${options(MODEL_CHOICES, m.model)}</select>
        <select data-effort="${key}" aria-label="Esforço: ${label}">${options(EFFORT_CHOICES, m.effort)}</select></span></div>`;
    }).join('');
    const flags = MEETING_FLAGS.map(([key, label]) => `
      <label class="set-row"><span>${label}</span><input type="checkbox" class="switch" data-flag="${key}" ${c.meeting && c.meeting[key] ? 'checked' : ''} /></label>`).join('');
    const keys = HOTKEY_ROWS.map(([key, label]) => `
      <div class="set-row"><span>${label}</span><button type="button" class="keycap" data-hotkey="${key}" title="Clique e pressione o novo atalho">${esc(accelLabel(c.hotkeys[key]))}</button></div>`).join('');
    $('#settings-body').innerHTML = `<h5>Modelos <span class="muted">modelo · esforço</span></h5>${models}<h5>Reunião</h5>${flags}<h5>Atalhos</h5>${keys}`;
  }

  async function saveSetting(patch) {
    const r = await api.invoke('settings:save', patch);
    if (!r || !r.ok) {
      showToast('error', (r && r.error) || 'Ajuste não salvo.');
      renderSettings();
      return;
    }
    state.config = { ...state.config, ...r.config };
    renderSettings();
    renderKeysLine();
    renderLiveChrome();
    const el = $('#settings-saved');
    el.textContent = 'salvo';
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.textContent = ''; }, 1600);
  }

  // Shortcut recorder: our global shortcuts are off while it listens.
  let recording = null;

  function startRecording(button) {
    stopRecording(false);
    recording = { key: button.dataset.hotkey, button };
    button.classList.add('recording');
    button.textContent = 'pressione o atalho…';
    api.invoke('hotkeys:suspend', { suspend: true });
  }

  function stopRecording(saving) {
    if (!recording) return;
    recording = null;
    // Saving re-registers every shortcut in main (the new set, or the old one if it fails).
    if (!saving) { api.invoke('hotkeys:suspend', { suspend: false }); renderSettings(); }
  }

  const KEY_NAMES = {
    Space: 'Space', Enter: 'Return', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Minus: '-', Equal: '=', Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'",
    BracketLeft: '[', BracketRight: ']', Backslash: '\\', Backquote: '`',
  };

  /** Electron accelerator for a key press, or null until a real key comes with a modifier. */
  function accelFromEvent(e) {
    const code = e.code || '';
    const key = /^Key[A-Z]$/.test(code) ? code.slice(3)
      : /^Digit\d$/.test(code) ? code.slice(5)
        : /^F\d{1,2}$/.test(code) ? code
          : KEY_NAMES[code] || null;
    if (!key) return null;
    const mods = [];
    if (e.metaKey) mods.push('CommandOrControl');
    if (e.ctrlKey) mods.push('Control');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (!mods.length) return null;
    return [...mods, key].join('+');
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
  }

  async function runSearch() {
    try {
      state.lib.results = (await api.invoke('sessions:search', { q: state.lib.q, person: state.lib.person })) || [];
    } catch { state.lib.results = []; }
    renderLibrary();
  }

  function setLibTab(tab) {
    state.lib.tab = tab;
    $$('.lib-tabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    $('#lib-meetings').classList.toggle('hidden', tab === 'people');
    $('#lib-people').classList.toggle('hidden', tab !== 'people');
  }

  function renderLibrary() {
    const tab = state.lib.tab;
    setLibTab(tab);
    const list = tab === 'meeting' || tab === 'interview' ? state.lib.results.filter((s) => s.kind === tab) : state.lib.results;
    const q = state.lib.q || state.lib.person;
    const empty = q ? 'Nada encontrado.'
      : tab === 'meeting' ? 'Nenhuma reunião gravada ainda.'
        : tab === 'interview' ? 'Nenhuma entrevista gravada ainda.'
          : 'Nada gravado ainda.';
    $('#lib-meetings').innerHTML = list.length
      ? `<ul class="rows">${list.map((s) => sessionRowHtml(s, { matches: true })).join('')}</ul>`
      : `<p class="lib-empty">${empty}</p>`;
    const people = $('#lib-people');
    if (state.lib.detail) {
      const d = state.lib.detail;
      people.innerHTML = `
        <div class="person-head">
          <button class="link" id="person-back" type="button">← todas as pessoas</button>
          <h3>${esc(d.name)}</h3>
          <p class="muted">${d.meetings} ${d.meetings === 1 ? 'reunião' : 'reuniões'} · ${d.utterances} falas</p>
        </div>
        <ul class="rows">${d.results.map((s) => sessionRowHtml(s, { matches: true })).join('')}</ul>`;
      people.querySelector('#person-back').addEventListener('click', () => { state.lib.detail = null; renderLibrary(); });
    } else if (!state.people.length) {
      people.innerHTML = '<p class="lib-empty">Ninguém nomeado ainda. Clique em um participante na transcrição para dar nome.</p>';
    } else {
      people.innerHTML = `<ul class="rows">${state.people.map((p) => `
        <li class="srow" data-name="${esc(p.name)}">
          <div class="srow-main"><div class="srow-title">${esc(p.name)}</div><div class="srow-sub">${p.meetings} ${p.meetings === 1 ? 'reunião' : 'reuniões'} · ${p.utterances} falas</div></div>
          <div class="srow-meta"><span>última ${esc(fmtDay(p.lastAt))}</span></div>
        </li>`).join('')}</ul>`;
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
      // The title line is stored apart once the summary is done; keep it out while it streams too.
      const body = streaming.text.replace(/^\s*#(?!#)[^\n]*\n?/, '');
      $('#summary').innerHTML = `<div class="streaming">${renderMd(body) || '<p class="muted">Pensando…</p>'}</div>`;
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
      // Main starts a fresh preparation chat after every session.
      state.setupChat = [];
      state.chatStarted = false;
      state.prepOpen = false;
      renderSetupChat();
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
      // A saved interview used its notes: the next one starts with an empty field.
      if (wasLive && d.mode === 'interview' && d.sessionId) {
        $('#job').value = '';
        localStorage.removeItem('interviewJob');
      }
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
    const ta = $('#job');
    ta.value = d.briefing;
    localStorage.setItem('interviewJob', ta.value);
    ta.classList.add('flash');
    setTimeout(() => ta.classList.remove('flash'), 1500);
    showToast('info', 'Briefing pronto em Esta entrevista. Revise e clique em Começar entrevista.');
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
    state.meetings = all.filter((s) => s.kind === 'meeting');
    renderRecentMeetings();
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
    state.profile = s.profile || '';
    state.profileSavedAt = s.profileSavedAt || null;
    state.systemAudioOkAt = s.systemAudioOkAt || null;
    state.loaded = true;
    applyAlpha(s.alpha);
    state.segments = s.segments || [];
    state.names = s.names || {};
    state.participants = s.participants || {};
    state.chat = s.chat || [];
    const sel = $('#meeting-lang');
    const wanted = localStorage.getItem('meetingLang') || (s.config && s.config.meeting && s.config.meeting.language) || 'pt-BR';
    if ([...sel.options].some((o) => o.value === wanted)) sel.value = wanted;
    await refreshLists();
    showView();
    renderReadiness();
    renderProfile();
    renderKeysLine();
    renderLiveChrome();
    renderStatus();
    renderParticipants();
    renderTranscript();
    renderAnswers();
    renderMeetingChat();
    renderSummary();
    console.log(`[ui] state loaded: phase=${state.phase} mode=${state.mode} deepgram=${state.deepgramKey} claude=${Boolean(state.claudeBinary)} native=${state.native.available} checks=${$('#checklist').children.length}`);
  }

  /** `display` is what the chat log shows when the message itself is long (profile + notes). */
  async function sendSetupChat(text, display) {
    const t = (text || '').trim();
    if (!t) return;
    state.setupChat.push({ id: `u-${Date.now()}`, role: 'user', text: display || t });
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

  async function requestPermission(which) {
    await api.invoke('permissions:request', { which });
    setTimeout(refreshState, 800);
  }

  // top bar: tabs, readiness pill, settings
  $$('.mode-tabs .tab').forEach((b) => b.addEventListener('click', () => setUiMode(b.dataset.mode)));
  $('#status-pill').addEventListener('click', (e) => {
    e.stopPropagation();
    $('#status-pop').classList.toggle('hidden');
  });
  document.addEventListener('click', (e) => {
    const perm = e.target.closest('[data-perm]');
    if (perm) { requestPermission(perm.dataset.perm); return; }
    if (!e.target.closest('#status-pop')) $('#status-pop').classList.add('hidden');
  });
  $('#btn-settings').addEventListener('click', () => {
    renderSettings();
    $('#settings-modal').classList.remove('hidden');
  });
  $('#settings-close').addEventListener('click', () => { stopRecording(false); $('#settings-modal').classList.add('hidden'); });
  $('#settings-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) { stopRecording(false); e.currentTarget.classList.add('hidden'); }
  });
  $('#settings-body').addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.model) saveSetting(patchAt(t.dataset.model, { model: t.value }));
    else if (t.dataset.effort) saveSetting(patchAt(t.dataset.effort, { effort: t.value }));
    else if (t.dataset.flag) saveSetting({ meeting: { [t.dataset.flag]: t.checked } });
  });
  $('#settings-body').addEventListener('click', (e) => {
    const b = e.target.closest('[data-hotkey]');
    if (b) startRecording(b);
  });
  window.addEventListener('keydown', (e) => {
    if (recording) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { stopRecording(false); return; }
      const accel = accelFromEvent(e);
      if (!accel) return;
      const key = recording.key;
      stopRecording(true);
      saveSetting({ hotkeys: { [key]: accel } });
      return;
    }
    if (e.key !== 'Escape') return;
    if (!$('#settings-modal').classList.contains('hidden')) $('#settings-modal').classList.add('hidden');
    else if (!$('#profile-modal').classList.contains('hidden')) closeProfile();
    else if (!$('#status-pop').classList.contains('hidden')) $('#status-pop').classList.add('hidden');
    else if (state.prepOpen) setPrepOpen(false);
  }, true);

  // session rows (recent meetings, library) open the viewer
  ['#recent-meetings', '#lib-meetings', '#lib-people'].forEach((sel) => $(sel).addEventListener('click', (e) => {
    const row = e.target.closest('li[data-id]');
    if (row) { viewSession(row.dataset.id); return; }
    const person = e.target.closest('li[data-name]');
    if (person) openPerson(person.dataset.name);
  }));

  // library
  $('#btn-library').addEventListener('click', () => setUiMode('library'));
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
      $('#adhoc').classList.remove('ctx-open');
    } finally {
      btn.disabled = false;
      renderAdhoc();
    }
  }
  $('#btn-start-meeting').addEventListener('click', () => startMeeting($('#context').value));
  $('#context').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); startMeeting($('#context').value); } });
  $('#ctx-toggle').addEventListener('click', () => { $('#adhoc').classList.add('ctx-open'); $('#context').focus(); });
  $('#panel-meeting').addEventListener('click', (e) => {
    const t = e.target.closest('[data-join],[data-rec],[data-cal]');
    if (!t) return;
    if (t.dataset.join) startFromEvent(t.dataset.join, true);
    else if (t.dataset.rec) startFromEvent(t.dataset.rec, false);
    else if (t.dataset.cal === 'connect') refreshCalendar(true);
    else if (t.dataset.cal === 'settings') api.invoke('permissions:request', { which: 'calendars' });
  });
  // Keep the calendar current while the home screen is up: every 5 min and when the window comes back.
  setInterval(() => { if (state.phase === 'setup') refreshCalendar(false); }, 5 * 60 * 1000);
  // "Em 12 min" counts down, and the next meeting takes over the page when it gets close.
  setInterval(() => { if (state.phase === 'setup' && !state.viewing) renderUpcoming(); }, 30 * 1000);
  window.addEventListener('focus', () => {
    if (state.phase === 'setup' && Date.now() - state.calendar.fetchedAt > 60 * 1000) refreshCalendar(false);
  });

  // interview setup
  $('#job').value = localStorage.getItem('interviewJob') || '';
  $('#job').addEventListener('input', (e) => localStorage.setItem('interviewJob', e.target.value));
  $('#profile-edit').addEventListener('click', openProfile);
  $('#profile-card').addEventListener('click', openProfile);
  $('#profile-cancel').addEventListener('click', closeProfile);
  $('#profile-save').addEventListener('click', saveProfileText);
  $('#profile-modal').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeProfile(); });
  $('#profile-text').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.metaKey) { e.preventDefault(); saveProfileText(); } });

  $('#btn-refine').addEventListener('click', async () => {
    setPrepOpen(true);
    if (state.chatStarted) { $('#chat-input').focus(); return; }
    state.chatStarted = true;
    const profile = (state.profile || '').trim();
    const job = $('#job').value.trim();
    const sent = [profile ? 'perfil' : '', job ? 'notas desta entrevista' : ''].filter(Boolean).join(' e ');
    await sendSetupChat([
      'Help me prepare for this interview. Ask what you need, then produce the briefing.',
      `PROFILE:\n${profile || '(empty: I have not saved a profile yet)'}`,
      `NOTES ABOUT THIS INTERVIEW:\n${job || '(none yet)'}`,
    ].join('\n\n'), sent ? `(${sent} enviados)` : 'Ainda não tenho perfil nem notas. Me pergunte o que precisa.');
    $('#chat-input').focus();
  });
  $('#prep-close').addEventListener('click', () => setPrepOpen(false));
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
      const r = await api.invoke('session:start', { mode: 'interview', job: $('#job').value });
      if (r && r.warnings && r.warnings.length) showToast('warn', r.warnings.join(' · '), 8000);
    } finally {
      btn.disabled = false; btn.textContent = 'Começar entrevista';
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
  renderUpcoming();
  refreshState().then(() => refreshCalendar(false));
})();
