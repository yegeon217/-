/**
 * 시간표 벽돌깨기
 * 현재 화면에 그려진 시간표의 모든 도형(DOM 요소)을 그대로 벽돌로 사용한다.
 *  - 글자/버튼/과목 칸 등은 "한 덩어리" 벽돌 (부수면 사라짐)
 *  - 하얀 카드처럼 다른 요소를 감싸는 상자는 "껍데기" 벽돌 (부수면 배경만 사라지고 안쪽이 드러남)
 * 레이아웃은 절대 움직이지 않도록 visibility / 배경만 건드리고, 종료 시 원래 스타일로 복구한다.
 */
(() => {
  'use strict';

  const HUD_H = 56;
  const TABLE_TAGS = new Set(['TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH']);
  const ATOMIC_TAGS = new Set(['BUTTON', 'SELECT', 'INPUT', 'TEXTAREA', 'IMG', 'SVG', 'CANVAS']);
  const MAX_BALLS = 12;
  const MAX_SHARDS = 320;

  const POWERS = {
    wide:   { label: '와이드',   desc: '패들 확장',        color: '#5fb8ff', weight: 15, dur: 15 },
    multi:  { label: '멀티볼',   desc: '모든 공이 3개로 분열', color: '#ffaa4d', weight: 12, dur: 0 },
    extra:  { label: '볼 +2',    desc: '새 공 2개 발사',   color: '#ffd23f', weight: 12, dur: 0 },
    pierce: { label: '파이어볼', desc: '벽돌 관통',        color: '#ff5a36', weight: 7,  dur: 8 },
    laser:  { label: '레이저',   desc: '자동 사격',        color: '#a8d82c', weight: 10, dur: 10 },
    catch:  { label: '캐치',     desc: '공이 패들에 붙음', color: '#a07cff', weight: 9,  dur: 15 },
    slow:   { label: '슬로우',   desc: '공 속도 감소',     color: '#3fcfa8', weight: 11, dur: 10 },
    life:   { label: '1UP',      desc: '목숨 +1',          color: '#ff6fae', weight: 5,  dur: 0 },
    shrink: { label: '미니',     desc: '패들 축소',        color: '#8a8299', weight: 8,  dur: 10 },
  };
  const POWER_BAG = Object.entries(POWERS).flatMap(([k, v]) => Array(v.weight).fill(k));

  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  /* ================= 사운드 (WebAudio 합성) ================= */

  const Sfx = {
    ctx: null,
    noiseBuf: null,
    muted: (() => { try { return localStorage.getItem('brickgame-muted') === '1'; } catch { return false; } })(),
    init() {
      try {
        if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        if (this.ctx.state === 'suspended') this.ctx.resume();
      } catch { this.ctx = null; }
    },
    tone(f, d, type = 'sine', v = 0.1, f2 = null, delay = 0) {
      if (this.muted || !this.ctx) return;
      const c = this.ctx;
      const t = c.currentTime + delay;
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = type;
      o.frequency.setValueAtTime(f, t);
      if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + d);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(v, t + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(g).connect(c.destination);
      o.start(t);
      o.stop(t + d + 0.03);
    },
    noise(d, v, freq) {
      if (this.muted || !this.ctx) return;
      const c = this.ctx;
      if (!this.noiseBuf) {
        this.noiseBuf = c.createBuffer(1, c.sampleRate * 0.5, c.sampleRate);
        const data = this.noiseBuf.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      }
      const src = c.createBufferSource();
      src.buffer = this.noiseBuf;
      const filter = c.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = freq;
      filter.Q.value = 0.8;
      const g = c.createGain();
      const t = c.currentTime;
      g.gain.setValueAtTime(v, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      src.connect(filter).connect(g).connect(c.destination);
      src.start(t);
      src.stop(t + d);
    },
    paddle() { this.tone(330, 0.1, 'triangle', 0.16, 494); },
    wall() { this.tone(260, 0.04, 'sine', 0.05); },
    hit() { this.tone(900 + Math.random() * 250, 0.05, 'square', 0.035); },
    crack() { this.noise(0.08, 0.12, 3000); this.tone(520, 0.06, 'triangle', 0.06, 380); },
    break(big, combo) {
      const pitch = 1 + Math.min(combo, 16) * 0.045;
      this.noise(big ? 0.45 : 0.16, big ? 0.3 : 0.14, big ? 700 : 2600);
      this.tone((big ? 200 : 620) * pitch, big ? 0.4 : 0.13, 'triangle', 0.1, (big ? 60 : 310) * pitch);
    },
    power(good) {
      if (!good) { this.tone(320, 0.28, 'square', 0.05, 140); return; }
      [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.1, 'triangle', 0.09, null, i * 0.055));
    },
    laser() { this.tone(1500, 0.06, 'sawtooth', 0.025, 700); },
    lose() { [392, 330, 262, 196].forEach((f, i) => this.tone(f, 0.18, 'sawtooth', 0.05, null, i * 0.13)); },
    win() { [523, 659, 784, 1047, 784, 1047, 1319].forEach((f, i) => this.tone(f, 0.16, 'triangle', 0.1, null, i * 0.09)); },
  };

  /* ================= DOM → 벽돌 변환 ================= */

  function parseColor(str) {
    const m = str && str.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }

  function hasBox(cs) {
    const bg = parseColor(cs.backgroundColor);
    if (bg && bg.a > 0.02) return true;
    if (cs.backgroundImage && cs.backgroundImage !== 'none') return true;
    for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
      if (cs[`border${side}Style`] === 'none') continue;
      if (parseFloat(cs[`border${side}Width`]) < 0.5) continue;
      const c = parseColor(cs[`border${side}Color`]);
      if (c && c.a > 0.05) return true;
    }
    return false;
  }

  function hasDirectText(el) {
    for (const n of el.childNodes) {
      if (n.nodeType === 3 && n.textContent.trim()) return true;
    }
    return false;
  }

  function isAtomic(el) {
    return ATOMIC_TAGS.has(el.tagName.toUpperCase())
      || el.classList.contains('cell-subject')
      || el.classList.contains('legend-item')
      || hasDirectText(el);
  }

  function clipByAncestors(el, r) {
    let x1 = r.x, y1 = r.y, x2 = r.x + r.w, y2 = r.y + r.h;
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
      const pr = p.getBoundingClientRect();
      x1 = Math.max(x1, pr.left); y1 = Math.max(y1, pr.top);
      x2 = Math.min(x2, pr.right); y2 = Math.min(y2, pr.bottom);
    }
    return { x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1) };
  }

  function measure(br) {
    let r = null;
    if (br.useText) {
      const range = document.createRange();
      range.selectNodeContents(br.el);
      const t = range.getBoundingClientRect();
      if (t.width > 1 && t.height > 1) r = { x: t.left - 4, y: t.top - 2, w: t.width + 8, h: t.height + 4 };
    }
    if (!r) {
      const t = br.el.getBoundingClientRect();
      r = { x: t.left, y: t.top, w: t.width, h: t.height };
    }
    br.rect = clipByAncestors(br.el, r);
  }

  function brickColor(cs, box) {
    const bg = box ? parseColor(cs.backgroundColor) : null;
    let c = bg && bg.a > 0.15 ? bg : parseColor(cs.color) || { r: 155, g: 127, b: 212 };
    const luma = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
    if (luma > 238) c = { r: 201, g: 182, b: 245 };
    return `rgb(${c.r},${c.g},${c.b})`;
  }

  function makeBrick(el, kind, parent, box, cs, card) {
    const changed = el.classList.contains('changed');
    let hp = 1;
    if (kind === 'shell') hp = el === card ? 3 : 2;
    else if (changed) hp = 2;
    const br = {
      el, kind, parent, hp, maxHp: hp,
      useText: kind === 'leaf' && !box,
      value: kind === 'shell' ? (el === card ? 500 : 250) : changed ? 200 : 100,
      color: brickColor(cs, box),
      cracks: [],
      broken: false,
      rect: null,
    };
    measure(br);
    if (br.rect.w < 3 || br.rect.h < 3) return null;
    return br;
  }

  function scan(node, parent, out, card) {
    for (const el of node.children) {
      if (el.classList.contains('bg-ui')) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) continue;
      const box = hasBox(cs);
      if (isAtomic(el)) {
        const br = makeBrick(el, 'leaf', parent, box, cs, card);
        if (br) out.push(br);
        continue;
      }
      if (box && !TABLE_TAGS.has(el.tagName.toUpperCase())) {
        const br = makeBrick(el, 'shell', parent, box, cs, card);
        if (br) {
          out.push(br);
          scan(el, br, out, card);
          continue;
        }
      }
      scan(el, parent, out, card);
    }
  }

  /* ================= 파편(실제 DOM 조각) ================= */

  function styledClone(el) {
    const clone = el.cloneNode(true);
    const src = [el, ...el.querySelectorAll('*')];
    const dst = [clone, ...clone.querySelectorAll('*')];
    for (let i = 0; i < src.length; i++) {
      const cs = getComputedStyle(src[i]);
      let css = '';
      for (let k = 0; k < cs.length; k++) {
        const p = cs[k];
        css += `${p}:${cs.getPropertyValue(p)};`;
      }
      const d = dst[i];
      d.removeAttribute('id');
      d.removeAttribute('class');
      d.style.cssText = css + 'transition:none;animation:none;pointer-events:none;';
    }
    return clone;
  }

  function shardPolys(w, h, cx, cy, n, ring) {
    const pts = [[0, 0], [w, 0], [w, h], [0, h]];
    const per = 2 * (w + h);
    for (let i = 0; i < n - 4; i++) {
      let t = Math.random() * per;
      if (t < w) { pts.push([t, 0]); continue; }
      t -= w;
      if (t < h) { pts.push([w, t]); continue; }
      t -= h;
      if (t < w) { pts.push([w - t, h]); continue; }
      t -= w;
      pts.push([0, h - t]);
    }
    pts.sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
    const C = [cx, cy];
    const Q = pts.map(([px, py]) => {
      const k = rand(0.3, 0.62);
      return [cx + (px - cx) * k, cy + (py - cy) * k];
    });
    const polys = [];
    for (let i = 0; i < pts.length; i++) {
      const j = (i + 1) % pts.length;
      if (ring) {
        polys.push([C, Q[i], Q[j]]);
        polys.push([Q[i], pts[i], pts[j], Q[j]]);
      } else {
        polys.push([C, pts[i], pts[j]]);
      }
    }
    return polys;
  }

  /* ================= 게임 ================= */

  let G = null;

  function saveStyle(el) {
    if (!G.saved.has(el)) G.saved.set(el, el.getAttribute('style'));
  }

  function computeScale() {
    const appRoot = G.appRoot;
    saveStyle(appRoot);
    appRoot.style.transform = 'none';
    const r = appRoot.getBoundingClientRect();
    const bottomZone = Math.max(190, window.innerHeight * 0.3);
    const avail = window.innerHeight - bottomZone - r.top;
    // 높이와 가로 폭 모두 화면 안에 들어오도록 축소 (좁은 화면에서 넘치는 부분까지 고려)
    const contentW = Math.max(r.width, appRoot.scrollWidth);
    const s = clamp(Math.min(avail / r.height, (window.innerWidth - 8) / contentW), 0.3, 1);
    appRoot.style.transformOrigin = 'top center';
    appRoot.style.transform = `scale(${s})`;
    G.scale = s;
  }

  function buildUi() {
    const layer = document.createElement('div');
    layer.className = 'bg-ui bg-layer';

    const canvas = document.createElement('canvas');
    canvas.className = 'bg-ui bg-canvas';

    const hud = document.createElement('div');
    hud.className = 'bg-ui bg-hud';
    hud.innerHTML = `
      <div class="bg-hud-left">
        <span class="bg-hud-label">SCORE</span>
        <span class="bg-score" data-ref="score">0</span>
        <span class="bg-combo" data-ref="combo"></span>
      </div>
      <div class="bg-hud-mid" data-ref="powers"></div>
      <div class="bg-hud-right">
        <span class="bg-lives" data-ref="lives"></span>
        <button type="button" class="bg-icon-btn" data-act="pause" title="일시정지 (P)">❚❚</button>
        <button type="button" class="bg-icon-btn" data-act="mute" title="소리">${Sfx.muted ? '🔇' : '🔊'}</button>
        <button type="button" class="bg-icon-btn" data-act="exit" title="나가기">✕</button>
      </div>`;

    const hint = document.createElement('div');
    hint.className = 'bg-ui bg-hint';
    hint.innerHTML = window.matchMedia('(pointer: coarse)').matches
      ? '<b>탭</b>해서 발사 · 화면을 <b>드래그</b>해서 이동'
      : '<b>클릭</b> 또는 <b>스페이스</b>로 발사 · 마우스 / ← → 로 이동';

    const overlay = document.createElement('div');
    overlay.className = 'bg-ui bg-overlay bg-hidden';
    overlay.innerHTML = '<div class="bg-panel"><h2></h2><p></p><div class="bg-actions"></div></div>';

    document.body.append(layer, canvas, hud, hint, overlay);
    const ref = (k) => hud.querySelector(`[data-ref="${k}"]`);
    return {
      layer, canvas, hud, hint, overlay,
      ctx: canvas.getContext('2d'),
      scoreEl: ref('score'), comboEl: ref('combo'), powersEl: ref('powers'), livesEl: ref('lives'),
      muteBtn: hud.querySelector('[data-act="mute"]'),
    };
  }

  function resizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    G.W = window.innerWidth;
    G.H = window.innerHeight;
    G.dpr = dpr;
    G.canvas.width = Math.round(G.W * dpr);
    G.canvas.height = Math.round(G.H * dpr);
    G.paddle.y = G.H - HUD_H - 36;
    G.baseSpeed = clamp(G.H * 0.62, 380, 660);
    G.basePaddleW = clamp(G.W * 0.13, 92, 170);
  }

  function start() {
    if (G) return;
    const timetableView = document.getElementById('timetable-view');
    if (!timetableView || timetableView.classList.contains('hidden')) return;

    Sfx.init();
    document.activeElement?.blur?.();
    document.body.classList.add('bg-playing'); // 트랜지션을 먼저 꺼서 레이아웃이 즉시 확정되게 한다
    document.getElementById('timetable-layout')?.classList.remove('sidebar-open');
    document.getElementById('meal-info')?.classList.add('hidden');
    window.scrollTo(0, 0);

    const appRoot = document.getElementById('app-root');
    G = {
      appRoot,
      saved: new Map(),
      bricks: [], active: [],
      balls: [], capsules: [], lasers: [], particles: [], texts: [], shards: [],
      paddle: { x: window.innerWidth / 2, target: window.innerWidth / 2, w: 120, h: 16, y: 0, vx: 0 },
      keys: { left: false, right: false },
      timers: {},
      score: 0, shownScore: -1, lives: 3, combo: 0, brokenCount: 0,
      ramp: 1, shake: 0, laserCd: 0, time: 0,
      state: 'ready', prevState: 'ready',
      raf: 0, last: performance.now(),
      best: (() => { try { return Number(localStorage.getItem('brickgame-best')) || 0; } catch { return 0; } })(),
    };
    Object.assign(G, buildUi());
    resizeCanvas();
    G.paddle.w = G.basePaddleW;
    computeScale();

    const card = document.querySelector('#timetable-view .timetable-main');
    const header = document.querySelector('#app-root .app-header');
    if (header) scan(header, null, G.bricks, card);
    if (card) {
      const cs = getComputedStyle(card);
      const cardBrick = makeBrick(card, 'shell', null, hasBox(cs), cs, card);
      if (cardBrick) G.bricks.push(cardBrick);
      scan(card, cardBrick, G.bricks, card);
    }
    refreshActive();

    G.balls.push(newStuckBall());
    bindEvents();
    introPulse();
    updateHud(true);
    G.hint.classList.add('bg-show');
    G.raf = requestAnimationFrame(loop);
  }

  function introPulse() {
    if (prefersReducedMotion) return;
    const minY = Math.min(...G.bricks.map((b) => b.rect.y));
    for (const br of G.bricks) {
      if (br.kind !== 'leaf') continue;
      try {
        br.el.animate(
          [{ transform: 'scale(1)', filter: 'brightness(1)' },
            { transform: 'scale(1.07)', filter: 'brightness(1.15)' },
            { transform: 'scale(1)', filter: 'brightness(1)' }],
          { duration: 320, delay: (br.rect.y - minY) * 0.7 + br.rect.x * 0.15, easing: 'ease-out' }
        );
      } catch { /* 일부 요소는 애니메이션 미지원 */ }
    }
  }

  function exitGame() {
    if (!G) return;
    cancelAnimationFrame(G.raf);
    unbindEvents();
    for (const el of [G.layer, G.canvas, G.hud, G.hint, G.overlay]) el.remove();
    for (const br of G.bricks) br.el.getAnimations?.().forEach((a) => a.cancel());
    for (const [el, css] of G.saved) {
      if (css === null) el.removeAttribute('style');
      else el.setAttribute('style', css);
    }
    document.body.classList.remove('bg-playing');
    G = null;
  }

  function restart() {
    exitGame();
    start();
  }

  /* ---------- 상태/입력 ---------- */

  const handlers = {
    resize() {
      resizeCanvas();
      computeScale();
      for (const br of G.bricks) measure(br);
      G.paddle.x = clamp(G.paddle.x, G.paddle.w / 2, G.W - G.paddle.w / 2);
      G.paddle.target = G.paddle.x;
      if (G.state === 'play') pause();
    },
    pointermove(e) {
      G.paddle.target = e.clientX;
    },
    pointerdown(e) {
      if (e.target !== G.canvas) return;
      G.paddle.target = e.clientX;
      action();
    },
    keydown(e) {
      const k = e.key;
      if (k === 'ArrowLeft' || k === 'a' || k === 'A') { G.keys.left = true; e.preventDefault(); }
      else if (k === 'ArrowRight' || k === 'd' || k === 'D') { G.keys.right = true; e.preventDefault(); }
      else if (k === ' ' || k === 'Enter') {
        e.preventDefault();
        if (G.state === 'paused') resume();
        else action();
      } else if (k === 'p' || k === 'P' || k === 'Escape') {
        e.preventDefault();
        if (G.state === 'paused') resume();
        else if (G.state === 'play' || G.state === 'ready') pause();
      }
    },
    keyup(e) {
      const k = e.key;
      if (k === 'ArrowLeft' || k === 'a' || k === 'A') G.keys.left = false;
      if (k === 'ArrowRight' || k === 'd' || k === 'D') G.keys.right = false;
    },
    visibilitychange() {
      if (document.hidden && (G.state === 'play' || G.state === 'ready')) pause();
    },
    hudclick(e) {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'pause') G.state === 'paused' ? resume() : pause();
      else if (act === 'mute') {
        Sfx.muted = !Sfx.muted;
        G.muteBtn.textContent = Sfx.muted ? '🔇' : '🔊';
        try { localStorage.setItem('brickgame-muted', Sfx.muted ? '1' : '0'); } catch { /* 무시 */ }
      } else if (act === 'exit') exitGame();
    },
  };

  function bindEvents() {
    window.addEventListener('resize', handlers.resize);
    window.addEventListener('pointermove', handlers.pointermove);
    window.addEventListener('pointerdown', handlers.pointerdown);
    window.addEventListener('keydown', handlers.keydown);
    window.addEventListener('keyup', handlers.keyup);
    document.addEventListener('visibilitychange', handlers.visibilitychange);
    G.hud.addEventListener('click', handlers.hudclick);
  }

  function unbindEvents() {
    window.removeEventListener('resize', handlers.resize);
    window.removeEventListener('pointermove', handlers.pointermove);
    window.removeEventListener('pointerdown', handlers.pointerdown);
    window.removeEventListener('keydown', handlers.keydown);
    window.removeEventListener('keyup', handlers.keyup);
    document.removeEventListener('visibilitychange', handlers.visibilitychange);
  }

  function action() {
    if (G.state !== 'ready' && G.state !== 'play') return;
    let launched = false;
    for (const b of G.balls) {
      if (!b.stuck) continue;
      b.stuck = false;
      const rel = clamp(b.offset / (G.paddle.w / 2), -1, 1);
      const a = rel * 0.9 + rand(-0.12, 0.12);
      b.vx = Math.sin(a);
      b.vy = -Math.cos(a);
      launched = true;
    }
    if (launched) {
      Sfx.paddle();
      if (G.state === 'ready') {
        G.state = 'play';
        G.hint.classList.remove('bg-show');
      }
    }
  }

  function pause() {
    if (!G || G.state === 'paused') return;
    G.prevState = G.state;
    G.state = 'paused';
    showOverlay('일시정지', '잠깐 쉬어가요.', [
      { label: '계속하기', primary: true, fn: resume },
      { label: '다시 시작', fn: restart },
      { label: '나가기', fn: exitGame },
    ]);
  }

  function resume() {
    if (!G || G.state !== 'paused') return;
    hideOverlay();
    G.state = G.prevState;
    G.last = performance.now();
  }

  function showOverlay(title, text, actions) {
    const o = G.overlay;
    o.querySelector('h2').textContent = title;
    o.querySelector('p').innerHTML = text;
    const box = o.querySelector('.bg-actions');
    box.innerHTML = '';
    for (const a of actions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'bg-btn' + (a.primary ? ' primary' : '');
      btn.textContent = a.label;
      btn.addEventListener('click', (e) => { e.stopPropagation(); a.fn(); });
      box.appendChild(btn);
    }
    o.classList.remove('bg-hidden');
    G.canvas.classList.add('bg-cursor');
  }

  function hideOverlay() {
    G.overlay.classList.add('bg-hidden');
    G.canvas.classList.remove('bg-cursor');
  }

  /* ---------- 공 / 벽돌 ---------- */

  function newStuckBall() {
    return {
      x: G.paddle.x, y: G.paddle.y - 20, vx: 0, vy: -1, r: 7,
      stuck: true, offset: rand(-0.18, 0.18) * G.paddle.w, stuckT: 0, trail: [],
    };
  }

  function curSpeed() {
    return G.baseSpeed * G.ramp * (G.timers.slow ? 0.62 : 1);
  }

  function ancestorsBroken(br) {
    for (let p = br.parent; p; p = p.parent) if (!p.broken) return false;
    return true;
  }

  function refreshActive() {
    G.active = G.bricks.filter((b) => !b.broken && ancestorsBroken(b));
  }

  function addScore(n) {
    G.score += n;
  }

  function addCrack(br, hx, hy) {
    const r = br.rect;
    const lx = clamp(hx - r.x, 0, r.w);
    const ly = clamp(hy - r.y, 0, r.h);
    const L = Math.min(Math.max(r.w, r.h) * 0.45, 160) * rand(0.7, 1);
    const branches = Math.round(rand(3, 5));
    const base = rand(0, Math.PI * 2);
    for (let i = 0; i < branches; i++) {
      let a = base + (i / branches) * Math.PI * 2 + rand(-0.4, 0.4);
      let x = lx, y = ly;
      const pts = [[x / r.w, y / r.h]];
      const segs = Math.round(rand(3, 6));
      for (let s = 0; s < segs; s++) {
        const len = (L / segs) * rand(0.6, 1.3);
        a += rand(-0.55, 0.55);
        x += Math.cos(a) * len;
        y += Math.sin(a) * len;
        pts.push([x / r.w, y / r.h]);
      }
      br.cracks.push(pts);
    }
  }

  function flash(br) {
    if (prefersReducedMotion) return;
    try {
      if (br.kind === 'shell') {
        br.el.animate(
          [{ transform: 'translate(0,0)' }, { transform: `translate(${rand(-4, 4)}px,${rand(-4, 4)}px)` }, { transform: 'translate(0,0)' }],
          { duration: 150 }
        );
      } else {
        br.el.animate(
          [{ transform: 'scale(0.92)', filter: 'brightness(1.35)' }, { transform: 'scale(1)', filter: 'brightness(1)' }],
          { duration: 200, easing: 'ease-out' }
        );
      }
    } catch { /* 무시 */ }
  }

  function sparks(x, y, color, n, spread = 1) {
    for (let i = 0; i < n; i++) {
      const a = rand(0, Math.PI * 2);
      const sp = rand(60, 260) * spread;
      G.particles.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 60,
        life: rand(0.35, 0.75), age: 0, size: rand(1.5, 3.5), color, g: 700,
      });
    }
  }

  function floatText(x, y, text, color, size = 15) {
    G.texts.push({ x, y, text, color, size, age: 0, life: 1.1 });
  }

  function damage(br, amt, hx, hy, ball) {
    if (br.broken) return;
    br.hp -= amt;
    if (br.hp <= 0) {
      breakBrick(br, hx, hy, ball);
    } else {
      addCrack(br, hx, hy);
      flash(br);
      sparks(hx, hy, br.color, 7);
      addScore(20);
      Sfx.crack();
    }
  }

  function breakBrick(br, hx, hy, ball) {
    br.broken = true;
    G.combo++;
    G.brokenCount++;
    G.ramp = 1 + Math.min(0.45, G.brokenCount * 0.006);

    const gained = Math.round((br.value * (1 + Math.min(G.combo - 1, 20) * 0.1)) / 10) * 10;
    addScore(gained);
    const r = br.rect;
    floatText(r.x + r.w / 2, r.y + r.h / 2, `+${gained}`, br.kind === 'shell' ? '#9b7fd4' : '#5d4b86', br.kind === 'shell' ? 22 : 15);
    if (G.combo >= 3) floatText(r.x + r.w / 2, r.y + r.h / 2 - 20, `${G.combo} COMBO`, '#ff6fae', 12);

    shatter(br, hx, hy, ball);
    hideBrick(br);
    sparks(hx, hy, br.color, br.kind === 'shell' ? 30 : 14, br.kind === 'shell' ? 1.6 : 1);
    Sfx.break(br.kind === 'shell', G.combo);
    if (br.kind === 'shell') G.shake = Math.max(G.shake, br.el.classList.contains('card') ? 10 : 6);
    else G.shake = Math.max(G.shake, 2.5);

    const dropChance = br.kind === 'shell' ? 0.7 : 0.15;
    if (G.capsules.length < 3 && Math.random() < dropChance) {
      spawnCapsule(r.x + r.w / 2, r.y + r.h / 2, br.kind === 'shell');
    }

    refreshActive();
    if (G.bricks.every((b) => b.broken)) win();
  }

  function hideBrick(br) {
    const el = br.el;
    saveStyle(el);
    if (br.kind === 'leaf') {
      el.style.visibility = 'hidden';
    } else {
      el.style.background = 'transparent';
      el.style.borderColor = 'transparent';
      el.style.boxShadow = 'none';
      el.style.outlineColor = 'transparent';
    }
  }

  function shatter(br, hx, hy, ball) {
    const r = br.rect;
    if (r.w < 2 || r.h < 2) return;
    const el = br.el;
    const er = el.getBoundingClientRect();

    let base;
    if (br.kind === 'leaf') {
      base = styledClone(el);
    } else {
      const cs = getComputedStyle(el);
      base = document.createElement('div');
      base.style.cssText = [
        'box-sizing:border-box',
        `width:${el.offsetWidth}px`, `height:${el.offsetHeight}px`,
        `background-color:${cs.backgroundColor}`, `background-image:${cs.backgroundImage}`,
        `border-radius:${cs.borderRadius}`,
        `border-top:${cs.borderTop}`, `border-right:${cs.borderRight}`,
        `border-bottom:${cs.borderBottom}`, `border-left:${cs.borderLeft}`,
      ].join(';');
    }
    Object.assign(base.style, {
      position: 'absolute',
      left: `${er.left - r.x}px`,
      top: `${er.top - r.y}px`,
      margin: '0',
      transform: `scale(${G.scale})`,
      transformOrigin: '0 0',
      visibility: 'visible',
    });

    const lx = clamp(hx - r.x, r.w * 0.15, r.w * 0.85);
    const ly = clamp(hy - r.y, r.h * 0.15, r.h * 0.85);
    const area = r.w * r.h;
    const n = clamp(Math.round(Math.sqrt(area) / 9), 5, 16);
    const polys = shardPolys(r.w, r.h, lx, ly, n, area > 2600);
    const isShell = br.kind === 'shell';
    const isSelect = el.tagName === 'SELECT';

    for (const poly of polys) {
      const wrap = document.createElement('div');
      wrap.className = 'bg-shard';
      const clip = poly.map(([x, y]) => `${x.toFixed(1)}px ${y.toFixed(1)}px`).join(',');
      const mx = poly.reduce((s, p) => s + p[0], 0) / poly.length;
      const my = poly.reduce((s, p) => s + p[1], 0) / poly.length;
      wrap.style.cssText = `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;clip-path:polygon(${clip});transform-origin:${mx}px ${my}px;`;
      const piece = base.cloneNode(true);
      if (isSelect) piece.selectedIndex = el.selectedIndex;
      wrap.appendChild(piece);
      G.layer.appendChild(wrap);

      const dx = mx - lx, dy = my - ly;
      const d = Math.hypot(dx, dy) || 1;
      const sp = rand(70, 240) * (isShell ? 0.55 : 1);
      G.shards.push({
        el: wrap, x: 0, y: 0,
        vx: (dx / d) * sp + (ball ? ball.vx * 0.1 : 0) + rand(-25, 25),
        vy: (dy / d) * sp + (ball ? ball.vy * 0.1 : 0) - rand(60, 200) * (isShell ? 0.4 : 1),
        rot: 0, vr: rand(-420, 420) * (isShell ? 0.25 : 1),
        age: 0, life: rand(0.9, 1.5) * (isShell ? 1.3 : 1),
      });
    }
    while (G.shards.length > MAX_SHARDS) G.shards.shift().el.remove();
  }

  function spawnCapsule(x, y, goodOnly) {
    let type = POWER_BAG[Math.floor(Math.random() * POWER_BAG.length)];
    if (goodOnly && type === 'shrink') type = 'multi';
    G.capsules.push({ x, y, type, vy: 150, t: rand(0, 6) });
  }

  function applyPower(type) {
    const P = POWERS[type];
    const good = type !== 'shrink';
    Sfx.power(good);
    floatText(G.paddle.x, G.paddle.y - 34, `${P.label}! ${P.desc}`, P.color, 16);
    sparks(G.paddle.x, G.paddle.y, P.color, 18, 1.2);
    addScore(50);

    switch (type) {
      case 'life':
        G.lives = Math.min(6, G.lives + 1);
        break;
      case 'multi': {
        const spd = curSpeed();
        const free = G.balls.filter((b) => !b.stuck);
        if (!free.length) {
          action();
          free.push(...G.balls);
        }
        const add = [];
        for (const b of free) {
          const a = Math.atan2(b.vx, -b.vy);
          for (const da of [-0.38, 0.38]) {
            add.push({ x: b.x, y: b.y, vx: Math.sin(a + da) * spd, vy: -Math.cos(a + da) * spd, r: b.r, stuck: false, offset: 0, stuckT: 0, trail: [] });
          }
        }
        G.balls.push(...add.slice(0, Math.max(0, MAX_BALLS - G.balls.length)));
        break;
      }
      case 'extra': {
        const spd = curSpeed();
        const p = G.paddle;
        for (const a of [-0.45, 0.45]) {
          if (G.balls.length >= MAX_BALLS) break;
          G.balls.push({ x: p.x + Math.sign(a) * p.w * 0.25, y: p.y - p.h / 2 - 8, vx: Math.sin(a) * spd, vy: -Math.cos(a) * spd, r: 7, stuck: false, offset: 0, stuckT: 0, trail: [] });
        }
        sparks(p.x, p.y - p.h, '#ffd23f', 16, 1);
        break;
      }
      case 'wide':
        delete G.timers.shrink;
        G.timers.wide = P.dur;
        break;
      case 'shrink':
        delete G.timers.wide;
        G.timers.shrink = P.dur;
        break;
      default:
        G.timers[type] = P.dur;
    }
  }

  function releaseStuck() {
    if (G.state !== 'play') return;
    action();
  }

  function loseBall() {
    G.lives--;
    G.combo = 0;
    G.timers = {};
    G.capsules = [];
    G.lasers = [];
    Sfx.lose();
    G.shake = 8;
    if (G.lives <= 0) {
      gameOver();
      return;
    }
    G.balls = [newStuckBall()];
    G.state = 'ready';
    G.hint.classList.add('bg-show');
  }

  function saveBest() {
    const isBest = G.score > G.best;
    if (isBest) {
      G.best = G.score;
      try { localStorage.setItem('brickgame-best', String(G.best)); } catch { /* 무시 */ }
    }
    return isBest;
  }

  function gameOver() {
    G.state = 'over';
    G.balls = [];
    const isBest = saveBest();
    const left = G.bricks.filter((b) => !b.broken).length;
    setTimeout(() => {
      if (!G) return;
      showOverlay('게임 오버', `점수 <b>${G.score.toLocaleString()}</b>${isBest ? ' · 🏆 최고 기록!' : ` · 최고 ${G.best.toLocaleString()}`}<br>남은 벽돌 ${left}개`, [
        { label: '다시 하기', primary: true, fn: restart },
        { label: '시간표로 돌아가기', fn: exitGame },
      ]);
    }, 700);
  }

  function win() {
    G.state = 'won';
    for (const b of G.balls) sparks(b.x, b.y, '#ffffff', 10);
    G.balls = [];
    G.capsules = [];
    G.lasers = [];
    const bonus = G.lives * 1000;
    addScore(bonus);
    const isBest = saveBest();
    Sfx.win();
    if (typeof window.launchFireworks === 'function') window.launchFireworks(3200);
    setTimeout(() => {
      if (!G) return;
      showOverlay('시간표 완파! 🎉', `점수 <b>${G.score.toLocaleString()}</b> (남은 목숨 보너스 +${bonus.toLocaleString()})${isBest ? '<br>🏆 최고 기록!' : ''}`, [
        { label: '다시 하기', primary: true, fn: restart },
        { label: '시간표로 돌아가기', fn: exitGame },
      ]);
    }, 1400);
  }

  /* ---------- 물리 ---------- */

  function normalizeBall(b, spd) {
    const len = Math.hypot(b.vx, b.vy) || 1;
    let vx = b.vx / len, vy = b.vy / len;
    if (Math.abs(vy) < 0.26) {
      vy = (vy < 0 ? -1 : 1) * 0.26;
      vx = (vx < 0 ? -1 : 1) * Math.sqrt(1 - vy * vy);
    }
    b.vx = vx * spd;
    b.vy = vy * spd;
  }

  function collideBricks(b) {
    let best = null, bestPen = 0, bestN = null;
    const pierce = !!G.timers.pierce;
    for (const br of G.active) {
      if (br.broken) continue;
      const r = br.rect;
      if (b.x + b.r < r.x || b.x - b.r > r.x + r.w || b.y + b.r < r.y || b.y - b.r > r.y + r.h) continue;
      const cx = clamp(b.x, r.x, r.x + r.w);
      const cy = clamp(b.y, r.y, r.y + r.h);
      const dx = b.x - cx, dy = b.y - cy;
      const d2 = dx * dx + dy * dy;
      let nx, ny, pen;
      if (d2 > 1e-6) {
        if (d2 >= b.r * b.r) continue;
        const d = Math.sqrt(d2);
        nx = dx / d; ny = dy / d; pen = b.r - d;
      } else {
        const l = b.x - r.x, rr = r.x + r.w - b.x, t = b.y - r.y, bo = r.y + r.h - b.y;
        const m = Math.min(l, rr, t, bo);
        if (m === l) { nx = -1; ny = 0; } else if (m === rr) { nx = 1; ny = 0; } else if (m === t) { nx = 0; ny = -1; } else { nx = 0; ny = 1; }
        pen = m + b.r;
      }
      if (pierce) {
        damage(br, br.hp, cx, cy, b);
        continue;
      }
      if (pen > bestPen) { bestPen = pen; best = br; bestN = [nx, ny, cx, cy]; }
    }
    if (best) {
      const [nx, ny, cx, cy] = bestN;
      const dot = b.vx * nx + b.vy * ny;
      if (dot < 0) { b.vx -= 2 * dot * nx; b.vy -= 2 * dot * ny; }
      b.x += nx * bestPen;
      b.y += ny * bestPen;
      damage(best, 1, cx, cy, b);
    }
  }

  function updateBall(b, dt) {
    const p = G.paddle;
    const top = p.y - p.h / 2;
    if (b.stuck) {
      b.offset = clamp(b.offset, -p.w / 2 + 4, p.w / 2 - 4);
      b.x = p.x + b.offset;
      b.y = top - b.r;
      if (G.state === 'play' && G.timers.catch !== undefined) {
        b.stuckT -= dt;
        if (b.stuckT <= 0) releaseStuck();
      }
      return true;
    }

    const spd = curSpeed();
    normalizeBall(b, spd);
    const steps = Math.ceil((spd * dt) / 4);
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const prevY = b.y;
      b.x += b.vx * h;
      b.y += b.vy * h;

      if (b.x < b.r) { b.x = b.r; b.vx = Math.abs(b.vx); Sfx.wall(); }
      else if (b.x > G.W - b.r) { b.x = G.W - b.r; b.vx = -Math.abs(b.vx); Sfx.wall(); }
      if (b.y < b.r) { b.y = b.r; b.vy = Math.abs(b.vy); Sfx.wall(); }

      if (b.vy > 0 && prevY + b.r <= top + 8 && b.y + b.r >= top && b.y - b.r <= top + p.h
        && b.x >= p.x - p.w / 2 - b.r && b.x <= p.x + p.w / 2 + b.r) {
        const rel = clamp((b.x - p.x) / (p.w / 2), -1, 1);
        const a = rel * 1.05 + clamp(p.vx / 4000, -0.15, 0.15);
        b.vx = Math.sin(a) * spd;
        b.vy = -Math.cos(a) * spd;
        b.y = top - b.r;
        G.combo = 0;
        p.squash = 1;
        sparks(b.x, top, '#c9b6f5', 5, 0.6);
        Sfx.paddle();
        if (G.timers.catch !== undefined) {
          b.stuck = true;
          b.offset = b.x - p.x;
          b.stuckT = 2.5;
          return true;
        }
        continue;
      }

      collideBricks(b);
      if (G.state !== 'play') return true;
      if (b.y - b.r > G.H) return false;
    }

    if (G.timers.pierce && Math.random() < 0.8) {
      G.particles.push({ x: b.x + rand(-3, 3), y: b.y + rand(-3, 3), vx: rand(-30, 30), vy: rand(-60, -10), life: rand(0.25, 0.5), age: 0, size: rand(2, 4), color: Math.random() < 0.5 ? '#ff5a36' : '#ffb347', g: -80 });
    }
    return true;
  }

  function update(dt) {
    G.time += dt;
    const p = G.paddle;

    for (const k of Object.keys(G.timers)) {
      G.timers[k] -= dt;
      if (G.timers[k] <= 0) {
        delete G.timers[k];
        if (k === 'catch') releaseStuck();
      }
    }

    // 막대
    const keyDir = (G.keys.right ? 1 : 0) - (G.keys.left ? 1 : 0);
    if (keyDir) p.target = p.x + keyDir * 900 * dt * 1.6;
    const targetW = G.basePaddleW * (G.timers.wide ? 1.55 : 1) * (G.timers.shrink ? 0.62 : 1);
    p.w += (targetW - p.w) * Math.min(1, dt * 10);
    const prevX = p.x;
    const tx = clamp(p.target, p.w / 2, G.W - p.w / 2);
    p.x += (tx - p.x) * Math.min(1, dt * 22);
    p.vx = (p.x - prevX) / Math.max(dt, 1e-4);
    p.squash = Math.max(0, (p.squash || 0) - dt * 6);

    // 공
    if (G.state === 'play' || G.state === 'ready') {
      G.balls = G.balls.filter((b) => {
        const alive = updateBall(b, dt);
        b.trail.push([b.x, b.y]);
        if (b.trail.length > 10) b.trail.shift();
        return alive;
      });
      if (G.state === 'won' || G.state === 'over') G.balls = [];
      else if (G.state === 'play' && !G.balls.length) loseBall();
    }

    // 레이저
    if (G.timers.laser && G.state === 'play') {
      G.laserCd -= dt;
      if (G.laserCd <= 0) {
        G.laserCd = 0.32;
        for (const s of [-1, 1]) G.lasers.push({ x: p.x + s * (p.w / 2 - 8), y: p.y - p.h / 2, len: 18 });
        Sfx.laser();
      }
    }
    G.lasers = G.lasers.filter((l) => {
      l.y -= 1000 * dt;
      if (l.y < -20) return false;
      for (const br of G.active) {
        const r = br.rect;
        if (l.x >= r.x && l.x <= r.x + r.w && l.y <= r.y + r.h && l.y + l.len >= r.y) {
          damage(br, 1, l.x, r.y + r.h, null);
          sparks(l.x, r.y + r.h, '#d4f25a', 6, 0.7);
          return false;
        }
      }
      return true;
    });

    // 캡슐
    const top = p.y - p.h / 2;
    G.capsules = G.capsules.filter((c) => {
      c.t += dt;
      c.y += c.vy * dt;
      if (c.y + 10 >= top && c.y - 10 <= top + p.h && Math.abs(c.x - p.x) <= p.w / 2 + 24) {
        applyPower(c.type);
        return false;
      }
      return c.y < G.H + 30;
    });

    // 파티클 / 글자
    G.particles = G.particles.filter((q) => {
      q.age += dt;
      q.vy += q.g * dt;
      q.x += q.vx * dt;
      q.y += q.vy * dt;
      return q.age < q.life;
    });
    G.texts = G.texts.filter((t) => {
      t.age += dt;
      t.y -= 38 * dt;
      return t.age < t.life;
    });

    // 파편
    G.shards = G.shards.filter((s) => {
      s.age += dt;
      s.vy += 1500 * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.rot += s.vr * dt;
      const fade = clamp((s.life - s.age) / (s.life * 0.45), 0, 1);
      s.el.style.transform = `translate3d(${s.x.toFixed(1)}px,${s.y.toFixed(1)}px,0) rotate(${s.rot.toFixed(1)}deg)`;
      s.el.style.opacity = fade.toFixed(3);
      if (s.age >= s.life) { s.el.remove(); return false; }
      return true;
    });

    G.shake = Math.max(0, G.shake - dt * 30);
  }

  /* ---------- 그리기 ---------- */

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, h / 2, w / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawCracks(ctx) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const br of G.active) {
      if (!br.cracks.length) continue;
      const r = br.rect;
      ctx.save();
      ctx.beginPath();
      ctx.rect(r.x, r.y, r.w, r.h);
      ctx.clip();
      for (const pass of [0, 1]) {
        ctx.strokeStyle = pass ? 'rgba(255,255,255,0.85)' : 'rgba(70,55,105,0.5)';
        ctx.lineWidth = pass ? 0.8 : 1.7;
        const off = pass ? 0.9 : 0;
        for (const c of br.cracks) {
          ctx.beginPath();
          c.forEach(([u, v], i) => {
            const x = r.x + u * r.w + off, y = r.y + v * r.h + off;
            if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
          });
          ctx.stroke();
        }
      }
      ctx.restore();
    }
  }

  function drawPaddle(ctx) {
    const p = G.paddle;
    const sq = p.squash || 0;
    const w = p.w * (1 + sq * 0.06);
    const h = p.h * (1 - sq * 0.25);
    const x = p.x - w / 2;
    const y = p.y - h / 2 + sq * 2;

    ctx.save();
    if (G.timers.catch) {
      ctx.shadowColor = 'rgba(160,124,255,0.9)';
      ctx.shadowBlur = 18 + Math.sin(G.time * 8) * 6;
    } else {
      ctx.shadowColor = 'rgba(155,127,212,0.55)';
      ctx.shadowBlur = 16;
    }
    ctx.shadowOffsetY = 4;
    const grad = ctx.createLinearGradient(x, 0, x + w, 0);
    grad.addColorStop(0, '#ff9cc4');
    grad.addColorStop(0.5, '#c4a6ff');
    grad.addColorStop(1, '#8f72d8');
    roundRect(ctx, x, y, w, h, h / 2);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.restore();

    // 하이라이트
    roundRect(ctx, x + 6, y + 2.5, w - 12, h * 0.32, h * 0.16);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fill();

    if (G.timers.laser) {
      for (const s of [-1, 1]) {
        const ex = p.x + s * (w / 2 - 8);
        roundRect(ctx, ex - 5, y - 7, 10, 10, 3);
        ctx.fillStyle = '#c6f04d';
        ctx.fill();
        ctx.strokeStyle = 'rgba(80,110,0,0.5)';
        ctx.stroke();
      }
    }
  }

  function drawBall(ctx, b) {
    const pierce = !!G.timers.pierce;
    const slow = !!G.timers.slow;
    const glow = pierce ? '255,90,54' : slow ? '63,207,168' : '155,127,212';
    for (let i = 0; i < b.trail.length; i++) {
      const [tx, ty] = b.trail[i];
      const k = i / b.trail.length;
      ctx.beginPath();
      ctx.arc(tx, ty, b.r * (0.35 + k * 0.55), 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${glow},${k * 0.28})`;
      ctx.fill();
    }
    ctx.save();
    ctx.shadowColor = `rgba(${glow},0.95)`;
    ctx.shadowBlur = pierce ? 22 : 14;
    const g = ctx.createRadialGradient(b.x - b.r * 0.35, b.y - b.r * 0.35, 1, b.x, b.y, b.r);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(1, pierce ? '#ffb38f' : slow ? '#bff3e3' : '#e6dcff');
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.restore();
  }

  function drawCapsule(ctx, c) {
    const P = POWERS[c.type];
    const w = 58, h = 22;
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(Math.sin(c.t * 4) * 0.08);
    ctx.shadowColor = P.color;
    ctx.shadowBlur = 14;
    const g = ctx.createLinearGradient(0, -h / 2, 0, h / 2);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.35, P.color);
    g.addColorStop(1, P.color);
    roundRect(ctx, -w / 2, -h / 2, w, h, h / 2);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.stroke();
    // 반짝임
    const shine = ((c.t * 0.9) % 1.6) - 0.3;
    if (shine > 0 && shine < 1) {
      ctx.save();
      roundRect(ctx, -w / 2, -h / 2, w, h, h / 2);
      ctx.clip();
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.beginPath();
      const sx = -w / 2 + shine * w;
      ctx.moveTo(sx - 6, h / 2); ctx.lineTo(sx + 4, -h / 2); ctx.lineTo(sx + 12, -h / 2); ctx.lineTo(sx + 2, h / 2);
      ctx.fill();
      ctx.restore();
    }
    ctx.font = "800 12px 'Segoe UI','Pretendard','Malgun Gothic',sans-serif";
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.strokeText(P.label, 0, 1);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(P.label, 0, 1);
    ctx.restore();
  }

  function render() {
    const ctx = G.ctx;
    ctx.setTransform(G.dpr, 0, 0, G.dpr, 0, 0);
    ctx.clearRect(0, 0, G.W, G.H);
    if (G.shake > 0 && !prefersReducedMotion) {
      ctx.translate(rand(-G.shake, G.shake), rand(-G.shake, G.shake));
    }

    drawCracks(ctx);

    // 레이저
    ctx.lineCap = 'round';
    for (const l of G.lasers) {
      ctx.strokeStyle = 'rgba(198,240,77,0.55)';
      ctx.lineWidth = 7;
      ctx.beginPath(); ctx.moveTo(l.x, l.y); ctx.lineTo(l.x, l.y + l.len); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(l.x, l.y + 2); ctx.lineTo(l.x, l.y + l.len - 2); ctx.stroke();
    }

    for (const c of G.capsules) drawCapsule(ctx, c);

    for (const q of G.particles) {
      ctx.globalAlpha = clamp(1 - q.age / q.life, 0, 1);
      ctx.fillStyle = q.color;
      ctx.beginPath();
      ctx.arc(q.x, q.y, q.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    for (const b of G.balls) drawBall(ctx, b);
    if (G.state !== 'over') drawPaddle(ctx);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const t of G.texts) {
      const k = t.age / t.life;
      ctx.globalAlpha = k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3;
      const pop = k < 0.12 ? 0.6 + (k / 0.12) * 0.4 : 1;
      ctx.font = `800 ${Math.round(t.size * pop)}px 'Segoe UI','Pretendard','Malgun Gothic',sans-serif`;
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.strokeText(t.text, t.x, t.y);
      ctx.fillStyle = t.color;
      ctx.fillText(t.text, t.x, t.y);
    }
    ctx.globalAlpha = 1;
  }

  function updateHud(force) {
    if (force || G.shownScore !== G.score) {
      G.shownScore = G.score;
      G.scoreEl.textContent = G.score.toLocaleString();
    }
    const comboText = G.combo >= 3 ? `${G.combo} COMBO` : '';
    if (G.comboEl.textContent !== comboText) G.comboEl.textContent = comboText;

    const livesHtml = '<i></i>'.repeat(Math.max(0, G.lives));
    if (force || G.livesEl.dataset.n !== String(G.lives)) {
      G.livesEl.dataset.n = String(G.lives);
      G.livesEl.innerHTML = livesHtml;
    }

    const keys = Object.keys(G.timers).join(',');
    if (force || G.powersEl.dataset.keys !== keys) {
      G.powersEl.dataset.keys = keys;
      G.powersEl.innerHTML = Object.keys(G.timers).map((k) =>
        `<span class="bg-chip" style="--c:${POWERS[k].color}" data-k="${k}">${POWERS[k].label}<i></i></span>`).join('');
    }
    for (const chip of G.powersEl.children) {
      const k = chip.dataset.k;
      const ratio = clamp((G.timers[k] || 0) / POWERS[k].dur, 0, 1);
      chip.style.setProperty('--p', ratio.toFixed(3));
    }
  }

  function loop(now) {
    if (!G) return;
    const dt = Math.min(0.033, (now - G.last) / 1000);
    G.last = now;
    if (G.state !== 'paused') update(dt);
    if (!G) return;
    render();
    updateHud(false);
    G.raf = requestAnimationFrame(loop);
  }

  /* ================= 진입 버튼 ================= */

  // 제작자 본인확인 입력창에 "벽돌깨기"를 입력하면 app.js에서 호출한다.
  window.startBrickGame = () => {
    start();
    return Boolean(G);
  };
})();
