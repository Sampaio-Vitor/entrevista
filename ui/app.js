/* global window, document */
(() => {
  const api = window.api;
  const $ = (sel) => document.querySelector(sel);

  const state = {
    phase: 'setup',
    startedAt: null,
    config: null,
    permissions: { microphone: 'unknown', screen: 'unknown' },
    deepgramKey: false,
    claudeBinary: null,
    native: { available: false, error: null },
    status: null,
    segments: [],
    answers: [],          // newest first
    chat: [],             // setup dialogue
    chatStarted: false,
    sessions: [],         // past interviews (summaries)
    viewing: null,        // a loaded past session, read-only
  };

  // ---------- utilities ----------

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function inline(s) {
    return esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  }

  // Minimal markdown: fenced code, bullets, numbered lists, headings, bold, inline code.
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
      const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
      const num = line.match(/^\s*\d+[.)]\s+(.*)$/);
      const head = line.match(/^\s*#{1,6}\s+(.*)$/);
      if (bullet) {
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

  let toastTimer = null;
  function showToast(level, message, ms) {
    const el = $('#toast');
    el.textContent = message;
    el.className = `toast ${level || 'info'}`;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), ms || (level === 'error' ? 9000 : 4500));
  }

  // ---------- views ----------

  function showView() {
    const viewing = Boolean(state.viewing);
    const live = state.phase === 'live';
    $('#view-setup').classList.toggle('hidden', live || viewing);
    $('#view-live').classList.toggle('hidden', !(live || viewing));
    $('#view-live').classList.toggle('readonly', viewing && !live);
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

  async function viewSession(id) {
    const s = await api.invoke('sessions:load', { id });
    if (!s) { showToast('error', 'Sessão não encontrada.'); return; }
    state.viewing = s;
    $('#view-title').textContent = `Sessão ${fmtWhen(s.startedAt)} · ${fmtDuration((s.endedAt || s.startedAt) - s.startedAt)} · ${s.segments.length} falas · ${s.answers.length} respostas`;
    showView();
    renderTranscript();
    renderAnswers();
    $('.answer-pane').scrollTop = 0;
    $('.transcript-pane').scrollTop = 0;
  }

  function leaveViewer() {
    state.viewing = null;
    showView();
    refreshState();
  }

  function renderSetup() {
    const cfg = state.config || {};
    const hk = cfg.hotkeys || {};
    const items = [];
    const dot = (ok) => `<span class="dot ${ok === true ? 'ok' : ok === 'pending' ? 'warn' : 'err'}"></span>`;

    items.push(`<li>${dot(state.claudeBinary ? true : false)}<span class="txt">Claude Code (<code>claude -p</code>)<span class="sub">${state.claudeBinary ? esc(state.claudeBinary) : 'binário não encontrado'}</span></span></li>`);
    items.push(`<li>${dot(state.deepgramKey)}<span class="txt">Chave Deepgram<span class="sub">${state.deepgramKey ? 'carregada do .env' : 'DEEPGRAM_API_KEY ausente no .env'}</span></span></li>`);
    items.push(`<li>${dot(state.native.available)}<span class="txt">Motor de áudio nativo<span class="sub">${state.native.available ? 'Core Audio tap + microfone, 16 kHz' : esc(state.native.error || 'indisponível')}</span></span></li>`);
    const mic = state.permissions.microphone;
    items.push(`<li>${dot(mic === 'granted' ? true : mic === 'not-determined' ? 'pending' : false)}<span class="txt">Microfone<span class="sub">${mic === 'granted' ? 'permitido' : mic === 'not-determined' ? 'pede ao iniciar' : 'negado: Ajustes > Privacidade > Microfone'}</span></span>${mic !== 'granted' ? '<button class="link" data-perm="microphone">pedir</button>' : ''}</li>`);
    items.push(`<li>${dot('pending')}<span class="txt">Gravação de áudio do sistema<span class="sub">macOS pergunta na primeira captura (sem compartilhar tela)</span></span><button class="link" data-perm="audio">ajustes</button></li>`);
    const scr = state.permissions.screen;
    items.push(`<li>${dot(scr === 'granted' ? true : scr === 'not-determined' ? 'pending' : false)}<span class="txt">Gravação de tela (para Código)<span class="sub">${scr === 'granted' ? 'permitida' : 'pede no primeiro screenshot'}</span></span>${scr !== 'granted' ? '<button class="link" data-perm="screen">ajustes</button>' : ''}</li>`);
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

  function renderChat() {
    const log = $('#chat-log');
    log.innerHTML = state.chat.map((m) => {
      if (m.role === 'user') return `<div class="msg user"><span class="who">Você</span><div class="body">${inline(m.text).replace(/\n/g, '<br>')}</div></div>`;
      // Hide the <briefing> block from the chat; it lands in the textarea.
      const visible = m.text.replace(/<briefing>[\s\S]*?(<\/briefing>|$)/i, m.status === 'done' ? '<em>(briefing copiado para a caixa acima)</em>' : '<em>(escrevendo o briefing…)</em>');
      return `<div class="msg assistant ${m.status === 'streaming' ? 'streaming' : ''}"><span class="who">Claude</span><div class="body">${renderMd(visible)}</div></div>`;
    }).join('');
    log.scrollTop = log.scrollHeight;
  }

  function renderLiveChrome() {
    const hk = (state.config && state.config.hotkeys) || {};
    $('#kbd-answer').textContent = accelLabel(hk.answer);
    $('#kbd-code').textContent = accelLabel(hk.code);
    $('#kbd-hide').textContent = accelLabel(hk.toggleWindow);
    $('#kbd-answer-2').textContent = accelLabel(hk.answer);
    $('#kbd-code-2').textContent = accelLabel(hk.code);
  }

  function renderStatus() {
    const st = state.status;
    if (!st) return;
    const dotClass = (chState) => chState === 'running' ? 'ok' : chState === 'starting' || chState === 'rebinding' ? 'warn' : chState === 'error' ? 'err' : 'idle';
    $('#dot-me').className = `dot ${dotClass(st.audio.me.state)}`;
    $('#dot-me').title = st.audio.me.detail || st.audio.me.state;
    $('#dot-them').className = `dot ${dotClass(st.audio.them.state)}`;
    $('#dot-them').title = st.audio.them.detail || st.audio.them.state;
    const sttClass = !st.stt.enabled ? 'err' : (st.stt.me && st.stt.them) ? 'ok' : (st.stt.me || st.stt.them) ? 'warn' : 'idle';
    $('#dot-stt').className = `dot ${sttClass}`;
    $('#dot-stt').title = !st.stt.enabled ? 'sem chave Deepgram' : `mic ${st.stt.me ? 'ok' : 'off'} · sistema ${st.stt.them ? 'ok' : 'off'}`;

    // Headset banner: HFP warning beats the informational routing line.
    const lang = st.lang === 'pt' ? 'pt' : 'en';
    const hk = (state.config && state.config.hotkeys) || {};
    $('#btn-lang').textContent = lang === 'pt' ? '🇧🇷' : '🇺🇸';
    $('#btn-lang').title = `Respostas em ${lang === 'pt' ? 'português' : 'inglês'}. Segue o idioma da sua última fala; clique (${accelLabel(hk.language)}) para trocar até você falar de novo.`;

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
      banner.textContent = `Fone Bluetooth (${mr.outputName}): usando ${mr.deviceName}. No Zoom/Meet escolha também o microfone "${mr.deviceName}", senão o fone cai em modo chamada e o áudio do entrevistador vem embaralhado.`;
      banner.className = 'banner';
    } else {
      banner.className = 'banner hidden';
    }

    const a = st.claude && st.claude.answer;
    const badge = $('#model-badge');
    if (a) {
      const used = a.model ? shortModel(a.model) : a.model === null ? a.model : '';
      const speed = a.speed === 'fast' ? ' ↯' : '';
      badge.textContent = `${used || a.model || ''}${speed} · ${a.effort}`.replace(/^ · /, '');
      badge.className = `badge ${a.speed === 'fast' ? 'fast' : ''}`;
      badge.title = `modelo ${a.model || a.model === '' ? a.model : ''}${a.fastMode ? ' (fast mode pedido)' : ''}`;
    } else {
      badge.textContent = '';
    }
  }

  function renderTranscript() {
    const el = $('#transcript');
    const pane = el.closest('.pane'); // the pane is the scroll container, not #transcript
    const viewing = state.viewing && state.phase !== 'live';
    const segments = viewing ? state.viewing.segments : state.segments;
    const nearBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 80;
    if (!segments.length) {
      el.innerHTML = `<p class="transcript-empty">${viewing ? 'Sem fala registrada.' : 'Aguardando fala…'}</p>`;
      return;
    }
    el.innerHTML = segments.map((s) => {
      const who = s.speaker === 'me' ? 'Me' : 'Interviewer';
      return `<div class="seg ${s.speaker} ${s.final ? '' : 'open'}"><span class="who">${who}</span><span class="txt">${s.final ? esc(s.text) : `<span class="interim">${esc(s.text)}</span>`}</span></div>`;
    }).join('');
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
      const stored = state.viewing.answers.map((a) => ({
        id: a.id, kind: a.kind, text: a.text, status: a.status, error: a.error, at: a.at,
        ms: a.ms, ttftMs: a.ttftMs, model: a.model, meta: { thumb: a.thumb || null },
      }));
      $('#answer-empty').classList.toggle('hidden', stored.length > 0);
      $('#answer-empty').querySelector('p').textContent = stored.length ? '' : 'Nenhuma resposta pedida nesta sessão.';
      $('#answer-current').innerHTML = stored.map(answerHtml).join('');
      $('#answer-history').innerHTML = '';
      return;
    }
    const live = state.answers.filter((a) => a.kind !== 'setup');
    $('#answer-empty').classList.toggle('hidden', live.length > 0);
    $('#answer-current').innerHTML = live.length ? answerHtml(live[0]) : '';
    $('#answer-history').innerHTML = live.slice(1, 12).map(answerHtml).join('');
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
    state.phase = d.phase;
    state.startedAt = d.startedAt || null;
    if (d.phase === 'live') {
      // New interview: nothing from the previous one stays on screen.
      state.answers = [];
      state.segments = [];
      state.viewing = null;
      $('#answer-empty').querySelector('p').innerHTML = `Pressione <kbd class="kbd-inline" id="kbd-answer-2"></kbd> para a resposta ou <kbd class="kbd-inline" id="kbd-code-2"></kbd> para resolver o que está na tela.`;
      renderLiveChrome();
    }
    showView();
    renderAnswers();
    renderTranscript();
    if (d.phase === 'setup') refreshState();
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

  api.on('transcript', (d) => { state.segments = d.segments || []; renderTranscript(); });

  function findAnswer(id) { return state.answers.find((a) => a.id === id); }

  api.on('answer:queued', (d) => {
    if (d.kind === 'setup') return;
    state.answers.unshift({ id: d.id, kind: d.kind, text: '', status: 'queued', at: Date.now(), meta: {} });
    renderAnswers();
  });

  api.on('answer:start', (d) => {
    if (d.kind === 'setup') {
      let m = state.chat.find((c) => c.id === d.id);
      if (!m) { m = { id: d.id, role: 'assistant', text: '', status: 'streaming' }; state.chat.push(m); }
      m.status = 'streaming';
      renderChat();
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
      const m = state.chat.find((c) => c.id === d.id);
      if (m) { m.text = d.full; renderChat(); }
      return;
    }
    const a = findAnswer(d.id);
    if (!a) return;
    a.text = d.full;
    renderAnswers();
  });

  api.on('answer:done', (d) => {
    if (d.kind === 'setup') {
      const m = state.chat.find((c) => c.id === d.id);
      if (m) { m.text = d.text; m.status = 'done'; renderChat(); }
      $('#chat-send').disabled = false;
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
      const m = state.chat.find((c) => c.id === d.id);
      if (m) { m.status = 'done'; m.text = (m.text || '') + `\n\n*Erro: ${d.message}*`; renderChat(); }
      $('#chat-send').disabled = false;
      showToast('error', `Claude (preparação): ${d.message}`);
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

  async function refreshState() {
    const s = await api.invoke('state:get');
    state.phase = s.phase;
    state.startedAt = s.startedAt;
    state.config = s.config;
    state.permissions = s.permissions;
    state.deepgramKey = s.deepgramKey;
    state.claudeBinary = s.claudeBinary;
    state.native = s.native;
    state.headset = s.headset;
    state.status = s.status;
    applyAlpha(s.alpha);
    state.segments = s.segments || [];
    if (!$('#briefing').value && s.briefing) $('#briefing').value = s.briefing;
    try { state.sessions = (await api.invoke('sessions:list')) || []; } catch { state.sessions = []; }
    showView();
    renderSetup();
    renderSessions();
    renderLiveChrome();
    renderStatus();
    renderTranscript();
    renderAnswers();
    console.log(`[ui] state loaded: phase=${state.phase} deepgram=${state.deepgramKey} claude=${Boolean(state.claudeBinary)} native=${state.native.available} checklist=${$('#checklist').children.length}`);
  }

  async function sendChat(text) {
    const t = (text || '').trim();
    if (!t) return;
    state.chat.push({ id: `u-${Date.now()}`, role: 'user', text: t });
    renderChat();
    $('#chat-send').disabled = true;
    const r = await api.invoke('setup:chat', { text: t });
    if (!r || !r.ok) { $('#chat-send').disabled = false; showToast('error', 'Não foi possível falar com o Claude.'); }
  }

  $('#btn-refine').addEventListener('click', async () => {
    $('#setup-chat').classList.remove('hidden');
    const ctx = $('#briefing').value.trim();
    if (!state.chatStarted) {
      state.chatStarted = true;
      await sendChat(ctx
        ? `Here is my raw context. Ask what you need, then produce the briefing.\n\n${ctx}`
        : 'I have no written context yet. Ask me the questions you need to build my briefing.');
    } else {
      $('#chat-input').focus();
    }
  });

  $('#chat-send').addEventListener('click', () => { const i = $('#chat-input'); sendChat(i.value); i.value = ''; });
  $('#chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); const i = $('#chat-input'); sendChat(i.value); i.value = ''; } });
  $('#chat-reset').addEventListener('click', async () => {
    await api.invoke('setup:reset');
    state.chat = []; state.chatStarted = false; $('#chat-send').disabled = false;
    renderChat();
  });

  $('#btn-start').addEventListener('click', async () => {
    const btn = $('#btn-start');
    btn.disabled = true; btn.textContent = 'Iniciando…';
    try {
      const r = await api.invoke('session:start', { briefing: $('#briefing').value });
      if (r && r.warnings && r.warnings.length) showToast('warn', r.warnings.join(' · '), 8000);
    } finally {
      btn.disabled = false; btn.textContent = 'Começar sessão';
    }
  });

  $('#btn-answer').addEventListener('click', () => api.invoke('answer:ask'));
  $('#btn-code').addEventListener('click', () => api.invoke('code:ask'));
  $('#btn-lang').addEventListener('click', () => api.invoke('lang:toggle'));
  $('#btn-clear').addEventListener('click', () => api.invoke('transcript:clear'));
  $('#btn-hide').addEventListener('click', () => api.invoke('window:toggle'));
  $('#btn-stop').addEventListener('click', async () => { await api.invoke('session:stop'); refreshState(); });

  $('#btn-back').addEventListener('click', leaveViewer);
  $('#btn-reveal').addEventListener('click', () => { if (state.viewing) api.invoke('sessions:reveal', { id: state.viewing.id }); });
  $('#btn-delete').addEventListener('click', async () => {
    if (!state.viewing) return;
    if (!window.confirm('Apagar esta sessão (transcrição e respostas)? Não dá para desfazer.')) return;
    await api.invoke('sessions:delete', { id: state.viewing.id });
    leaveViewer();
  });

  refreshState();
})();
