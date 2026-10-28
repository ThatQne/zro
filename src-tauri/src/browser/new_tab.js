(() => {
  if (!window.__zroNewTabDocument) return;
  const render = () => {
    if (!window.__zroNewTabDocument || document.getElementById('zro-play')) return;
    const A = window.__zroArcade;
    const { clamp, physics, tetris, factory, snake, shapes, minerItems, minerUpgrades, achievementDefs, researchTree, artifactDefs } = A;
    const BLUE = '#4f80f5', BG = '#0c0c0c';
    const icon = (name, size = 16) => {
      const paths = {
        back: '<path d="m15 18-6-6 6-6"/><path d="M9 12h10"/>',
        pause: '<rect width="4" height="14" x="6" y="5" rx="1"/><rect width="4" height="14" x="14" y="5" rx="1"/>',
        play: '<path d="m8 5 11 7-11 7Z"/>',
        reset: '<path d="M20 11a8 8 0 1 1-2.3-5.7L20 8"/><path d="M20 3v5h-5"/>',
        settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21H9.6v-.1A1.7 1.7 0 0 0 8.5 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3V9.6h.1A1.7 1.7 0 0 0 4.6 8.5a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.1A1.7 1.7 0 0 0 15.5 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.38.29.6.73.6 1.2v3.6c0 .47-.22.91-.6 1.2Z"/>',
        left: '<path d="m15 18-6-6 6-6"/>', right: '<path d="m9 18 6-6-6-6"/>',
        rotate: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 6v5h-5"/>',
        down: '<path d="m6 9 6 6 6-6"/>', drop: '<path d="M12 3v13m-5-5 5 5 5-5"/><path d="M5 21h14"/>',
        bolt: '<path d="m13 2-9 12h8l-1 8 9-12h-8Z"/>',
        blocks: '<path d="M4 4h6v6H4zM14 4h6v6h-6zM9 14h6v6H9z"/>',
        mine: '<path d="M6 19h12M8 16l3-11h2l3 11M5 8h14"/>',
        merge: '<circle cx="9" cy="14" r="5"/><circle cx="16" cy="9" r="4"/><circle cx="8" cy="5" r="2"/>',
        pool: '<circle cx="8" cy="16" r="4"/><circle cx="17" cy="8" r="5"/><path d="M11 13 20 4"/>',
        breakout: '<path d="M3 3h7v5H3zM14 3h7v5h-7zM7 20h10"/><circle cx="12" cy="13" r="2"/>',
        snake: '<path d="M4 18h10a3 3 0 0 0 0-6H8a3 3 0 0 1 0-6h11"/><circle cx="18" cy="6" r="3"/>',
        hold: '<path d="M5 4v16M19 4v16M5 12h14"/>',
        cart: '<circle cx="9" cy="20" r="1"/><circle cx="18" cy="20" r="1"/><path d="M3 4h2l2 11h11l2-7H6"/>',
        trophy: '<path d="M8 3h8v5a4 4 0 0 1-8 0Z"/><path d="M8 5H4v2a4 4 0 0 0 4 4m8-6h4v2a4 4 0 0 1-4 4M12 12v5m-4 4h8m-6-4h4"/>',
        check: '<path d="m5 12 4 4L19 6"/>', lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
      };
      return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || ''}</svg>`;
    };
    document.title = 'New Tab';
    document.documentElement.style.cssText = `background:${BG};color:#e4e4e4;font:13px Outfit,-apple-system,BlinkMacSystemFont,Inter,system-ui,sans-serif`;
    const style = document.createElement('style');
    style.textContent = `
      *{box-sizing:border-box}html{color-scheme:dark}body{margin:0;background:#0c0c0c}button,input,select{font:inherit;color:inherit}
      button{cursor:pointer}button:focus-visible,input:focus-visible,select:focus-visible{outline:1px solid #4f80f5;outline-offset:2px}
      canvas{outline:none!important;-webkit-tap-highlight-color:transparent;user-select:none;touch-action:none}[hidden]{display:none!important}
      #previews canvas{width:104px;height:72px;margin:4px 0 10px}#previews .label{color:#888}
      #zro-play{max-width:1060px;margin:auto;padding:38px 34px 24px;min-height:100vh}.top{height:54px;display:flex;align-items:center;border-bottom:1px solid rgba(255,255,255,.065)}
      #logo{font:400 34px Outfit,sans-serif;letter-spacing:-2px;border:0;background:none;padding:0 10px 4px 0;touch-action:none;user-select:none;cursor:grab;z-index:9}
      #logo:active{cursor:grabbing}.top-copy{margin-left:auto;color:#555;font-size:11px}.intro{padding:48px 0 28px}.kicker{font-size:10px;letter-spacing:.16em;color:#666;text-transform:uppercase}
      .intro h1{font-size:clamp(31px,5vw,48px);font-weight:400;letter-spacing:-1.7px;margin:10px 0 6px}.intro h1 span{color:#7a9cf5}.intro p{color:#777;margin:0;line-height:1.6}
      .cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.card{position:relative;display:flex;flex-direction:column;text-align:left;padding:19px;background:#101010;border:1px solid rgba(255,255,255,.065);border-radius:9px;min-height:210px;overflow:hidden}
      .card:before{content:'';position:absolute;inset:0;background:linear-gradient(145deg,rgba(79,128,245,.07),transparent 48%);opacity:0;transition:opacity .15s}.card:hover{background:#131313;border-color:rgba(79,128,245,.28)}.card:hover:before{opacity:1}
      .card-icon{width:38px;height:38px;border-radius:7px;display:grid;place-items:center;color:#7a9cf5;background:rgba(79,128,245,.1);margin-bottom:29px}.card h2{font-size:15px;font-weight:500;margin:0 0 7px}.card p{font-size:11px;color:#666;line-height:1.55;margin:0}.open{display:flex;align-items:center;gap:5px;color:#777;margin-top:auto;font-size:11px}.open svg{margin-left:auto}
      footer{display:flex;justify-content:space-between;gap:16px;margin-top:24px;padding-top:16px;border-top:1px solid rgba(255,255,255,.04);font-size:10px;color:#444}.dot{display:inline-block;width:5px;height:5px;background:#4f80f5;border-radius:50%;margin-right:7px}
      #arena{padding-top:20px}.toolbar{display:flex;align-items:center;gap:7px;margin-bottom:16px}.toolbar h1{font-size:15px;font-weight:500;margin:0 auto 0 7px}.icon-button,.quiet-button{height:30px;border:1px solid rgba(255,255,255,.07);background:#121212;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;color:#888}.icon-button{width:30px;padding:0}.quiet-button{padding:0 10px;gap:6px;font-size:11px}.icon-button:hover,.quiet-button:hover{background:#181818;color:#ddd;border-color:rgba(255,255,255,.12)}
      .game-layout{display:grid;grid-template-columns:minmax(0,1fr) 220px;gap:18px;align-items:start}.surface{position:relative;display:grid;place-items:center;min-width:0;min-height:410px;background:#0f0f0f;border:1px solid rgba(255,255,255,.065);border-radius:9px;overflow:hidden}
      canvas{display:block;width:min(100%,360px,60vh);height:auto}.surface.wide canvas{width:min(100%,640px)}aside{padding:4px 0}.label{font-size:9px;letter-spacing:.14em;color:#555;text-transform:uppercase}.score{font-size:35px;font-weight:400;letter-spacing:-1px;margin:4px 0 14px;font-variant-numeric:tabular-nums}.instructions{color:#777;line-height:1.65;font-size:11px;white-space:pre-line;margin:0 0 16px}.detail{color:#8faaf5;font-size:11px;line-height:1.75;white-space:pre-line}.controls{display:flex;gap:6px;flex-wrap:wrap;margin-top:18px}.controls button{height:30px;min-width:30px}
      .curtain{position:absolute;inset:0;z-index:3;display:grid;place-content:center;text-align:center;background:rgba(12,12,12,.92)}.curtain strong{font-size:20px;font-weight:500}.curtain p{font-size:11px;color:#666;margin:8px 0 14px}.primary{border:0;background:#4f80f5!important;color:white!important;border-radius:6px;height:32px;padding:0 14px}
      dialog{border:1px solid rgba(255,255,255,.09);border-radius:9px;background:#111;color:#e4e4e4;padding:0;min-width:290px;box-shadow:0 24px 80px #000}dialog::backdrop{background:rgba(0,0,0,.66)}.modal-head{display:flex;align-items:center;padding:14px 15px;border-bottom:1px solid rgba(255,255,255,.06)}.modal-head strong{font-weight:500}.modal-head button{margin-left:auto}.modal-body{padding:10px 15px 16px}.setting{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:10px 0;color:#aaa}.setting small{display:block;color:#555;margin-top:2px}.switch{width:32px;height:18px;padding:2px;border:0;border-radius:9px;background:#292929}.switch i{display:block;width:14px;height:14px;border-radius:50%;background:#777;transition:transform .15s}.switch.on{background:#315dbb}.switch.on i{background:white;transform:translateX(14px)}select{background:#191919;border:1px solid rgba(255,255,255,.08);border-radius:5px;padding:4px 7px}
      .miner{width:100%;padding:18px}.miner-top{display:grid;grid-template-columns:1fr auto;gap:6px 20px;align-items:end;padding:3px 4px 16px;border-bottom:1px solid rgba(255,255,255,.06)}.miner-top .amount{font-size:32px}.rate{color:#7a9cf5;font-size:11px}.mine-button{width:112px;height:112px;margin:20px auto;border-radius:50%;border:1px solid rgba(79,128,245,.32);background:rgba(79,128,245,.08);color:#7a9cf5;display:grid;place-content:center;gap:5px}.mine-button:hover{background:rgba(79,128,245,.13)}.mine-button:active{transform:scale(.98)}.mine-button small{font-size:10px}.progress{height:3px;background:#202020;border-radius:2px;overflow:hidden;margin:7px 0}.progress i{display:block;height:100%;background:#4f80f5}.milestone{text-align:center;color:#555;font-size:10px;min-height:14px}
      .miner-tabs{display:flex;gap:4px;margin:20px 0 10px}.miner-tabs button{flex:1;height:30px;border:0;background:transparent;color:#666;border-radius:5px;font-size:11px}.miner-tabs button.on{background:#1a1a1a;color:#ddd}.shop{display:grid;gap:5px;max-height:250px;overflow:auto}.shop-row{display:grid;grid-template-columns:30px 1fr auto;align-items:center;gap:9px;width:100%;padding:8px;text-align:left;background:#121212;border:1px solid rgba(255,255,255,.055);border-radius:6px}.shop-row:hover:not(:disabled){background:#171717}.shop-row:disabled{opacity:.4}.shop-row .mini-icon{display:grid;place-items:center;color:#718dcc}.shop-row strong{display:block;font-size:11px;font-weight:500}.shop-row small{color:#555;font-size:9px}.cost{color:#8faaf5;font-size:10px}.badge{min-width:21px;text-align:center;padding:2px 5px;background:#1e1e1e;border-radius:8px;color:#888;font-size:9px}.achievement.done{border-color:rgba(79,128,245,.2)}.achievement.done .mini-icon{color:#4f80f5}.offline{height:18px;text-align:center;font-size:10px;color:#7a9cf5}
      @media(max-width:820px){.cards{grid-template-columns:repeat(2,minmax(0,1fr))}.card{min-height:175px}.card-icon{margin-bottom:20px}.game-layout{grid-template-columns:minmax(0,1fr) 180px}}
      @media(max-width:560px){#zro-play{padding:20px 16px}.top-copy{display:none}.intro{padding:31px 0 21px}.game-layout{grid-template-columns:1fr}.surface{min-height:360px}aside{display:grid;grid-template-columns:1fr 1fr;gap:0 12px}.instructions{grid-column:2;grid-row:1/4}.controls{grid-column:1/3}.cards{gap:8px}.card{padding:15px;min-height:168px}.card-icon{margin-bottom:15px}footer{flex-direction:column}.miner{padding:10px}}
    `;
    document.head.append(style);
    const card = (id, glyph, title, text) => `<button class="card" data-game="${id}"><span class="card-icon">${icon(glyph,20)}</span><h2>${title}</h2><p>${text}</p><span class="open">Open ${icon('right',13)}</span></button>`;
    document.body.innerHTML = `<main id="zro-play"><header class="top"><button id="logo" aria-label="zro logo — drag and fling">zro</button><span class="top-copy">Fast by default. Play by choice.</span></header>
      <section id="menu"><div class="intro"><div class="kicker">New tab · local arcade</div><h1>A quieter place to <span>play.</span></h1><p>Type above to search, or pick up where you left off.</p></div><div class="cards">
        ${card('blocks','blocks','Blocks','Classic falling blocks with configurable pace and display.')}
        ${card('factory','mine','Cycle Miner','Build a tiny compute network with items, upgrades and milestones.')}
        ${card('merge','merge','Merge Drop','Drop and combine numbered orbs in a smooth physics jar.')}
        ${card('snake','snake','Snake','Collect signals, grow your trail and weave through a faster grid.')}
      </div></section>
      <section id="arena" hidden><div class="toolbar"><button class="icon-button" id="back" title="Arcade" aria-label="Back to arcade">${icon('back')}</button><h1 id="game-title"></h1><button class="icon-button" id="game-settings" title="Game settings" aria-label="Game settings">${icon('settings')}</button><button class="icon-button" id="pause" title="Pause" aria-label="Pause">${icon('pause')}</button><button class="icon-button" id="restart" title="Restart" aria-label="Restart">${icon('reset')}</button></div>
        <div class="game-layout"><div class="surface" id="surface"><div class="curtain" id="curtain" hidden><strong>Paused</strong><p>No game work is running.</p><button class="primary" id="resume">Resume</button></div></div><aside><div class="label" id="score-label">Score</div><div class="score" id="score">0</div><p class="instructions" id="instructions"></p><div class="detail" id="detail"></div><div class="controls" id="controls"></div></aside></div>
      </section><footer><span><i class="dot"></i>Runs locally · progress saved</span><span id="footnote">No game running</span></footer></main>
      <dialog id="settings-dialog"><div class="modal-head"><strong>Blocks settings</strong><button class="icon-button" id="close-settings" aria-label="Close settings">${icon('back')}</button></div><div class="modal-body"><div class="setting"><span>Ghost piece<small>Preview the landing position</small></span><button class="switch" data-setting="ghost" aria-label="Toggle ghost piece"><i></i></button></div><div class="setting"><span>Grid<small>Show subtle board guides</small></span><button class="switch" data-setting="grid" aria-label="Toggle board grid"><i></i></button></div><label class="setting"><span>Starting level<small>Applies to the next game</small></span><select id="start-level">${Array.from({length:10},(_,i)=>`<option>${i+1}</option>`).join('')}</select></label></div></dialog>`;

    const $ = id => document.getElementById(id), sessions = new Map();
    const settings = { blocks: { ghost: true, grid: true, startLevel: 1, highScore: 0, updatedAt: 0 } };
    const names = { blocks: 'Blocks', factory: 'Cycle Miner', merge: 'Merge Drop', snake: 'Snake' };
    const hints = {
      blocks: 'Arrow keys move and rotate.\nDown soft-drops · Space hard-drops.\nC / Shift holds a piece · P pauses.',
      factory: 'Generate cycles, buy hardware, unlock upgrades and collect achievements. Production continues between sessions for up to 8 hours.',
      merge: 'Move to aim, then click or press Space to drop. Equal orbs combine. Keep the stack below the line.',
      snake: 'Arrows or WASD steer. Collect signals without hitting a wall or your trail. P pauses. Swipe to steer on touch.',
    };
    let kind = null, game = null, canvas = null, ctx = null, paused = false, minerView = 'items';
    let raf = 0, last = 0, accumulator = 0, factoryTimer = 0, saveTimer = 0, particles = [], aimDrag = null;
    let logo = null, logoDrag = null, logoMoving = false, logoTime = 0, loadedDisk = false, restoredSession = false;
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const cloneData = value => JSON.parse(JSON.stringify(value, (key, v) => typeof v === 'function' ? undefined : v));
    const active = () => kind && !paused && !document.hidden;
    const animated = () => logoMoving || (active() && game && !game.over &&
      ((kind === 'blocks') || (kind === 'merge' && game.bodies.length && !game.sleeping) || kind === 'snake'));
    function wake() { if (!raf && animated()) raf = requestAnimationFrame(frame); }
    function stop() { if (raf) cancelAnimationFrame(raf); raf = 0; last = 0; accumulator = 0; }
    function message(payload) { try { window.chrome?.webview?.postMessage(JSON.stringify(payload)); } catch (_) {} }
    function snapshot(selected = kind) {
      if (kind && game) { game.updatedAt = Date.now(); sessions.set(kind, game); }
      if (sessions.has('factory')) sessions.get('factory').lastSaved = Date.now();
      return { version: 2, selected, settings: cloneData(settings), games: Object.fromEntries([...sessions].map(([k,v]) => [k, cloneData(v)])) };
    }
    function saveNow() { clearTimeout(saveTimer); saveTimer = 0; message({ type: 'zro-arcade-save', data: snapshot(null) }); }
    function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 250); }
    function hydrate(type, data) {
      if (!data || typeof data !== 'object') return makeGame(type);
      let state = makeGame(type, data);
      if (type === 'factory' || type === 'snake' || type === 'merge') return state;
      for (const key of Object.keys(state)) if (typeof state[key] !== 'function' && Object.hasOwn(data,key)) state[key] = cloneData(data[key]);
      return state;
    }
    function applySave(saved, resume = false) {
      if (!saved || saved.version !== 2) return;
      const incomingSettings = saved.settings?.blocks;
      if (incomingSettings && Number(incomingSettings.updatedAt) >= settings.blocks.updatedAt) Object.assign(settings.blocks, incomingSettings);
      for (const type of Object.keys(names)) {
        const data = saved.games?.[type]; if (!data) continue;
        const current = sessions.get(type);
        if (!current || Number(data.updatedAt || 0) >= Number(current.updatedAt || 0)) sessions.set(type, hydrate(type, data));
      }
      if (resume && Object.hasOwn(names, saved.selected)) { restoredSession = true; select(saved.selected); setPaused(true); }
    }
    window.__zroArcadeLoad = saved => { loadedDisk = true; applySave(saved, false); if (kind === 'factory') { game = sessions.get(kind); renderMiner(); stats(); } };
    window.__zroArcadeSave = () => snapshot(kind);
    window.__zroArcadeRestore = saved => applySave(saved, true);
    message({ type: 'zro-arcade-load' });

    function makeGame(type, data = {}) {
      if (type === 'blocks') return Object.assign(tetris(Math.random, settings.blocks), { fall: 0, flash: 0, updatedAt: Date.now() });
      if (type === 'factory') {
        const state = factory(data);
        const elapsed = clamp((Date.now() - state.lastSaved) / 1000, 0, 28800), gain = state.rate() * elapsed;
        if (gain > 0) { state.energy += gain; state.total += gain; state.offlineGain = gain; }
        state.updatedAt = Number(data.updatedAt) || Date.now(); return state;
      }
      if (type === 'merge') {
        const state = Object.assign({ bodies: [], next: Math.floor(Math.random()*3), aim: 180, score: 0, best: 0, biggest: 0, cooldown: 0, danger: 0, settled: 0, sleeping: false, over: false }, data, { updatedAt: Number(data.updatedAt)||Date.now() });
        state.bodies = state.bodies.map(b=>({...b,r:radius(b.level)})); return state;
      }
      const state = snake(data);
      state.updatedAt = Number(data.updatedAt)||Date.now(); return state;
    }
    function stats() {
      if (!game) return;
      const score = kind === 'factory' ? game.energy : game.score;
      $('score').textContent = Math.floor(score).toLocaleString();
      if (kind === 'blocks') $('detail').textContent = `${game.lines} lines · level ${game.level()}\nBest ${settings.blocks.highScore.toLocaleString()}`;
      if (kind === 'merge') $('detail').textContent = `${game.bodies.length} / 36 orbs · best ${game.best.toLocaleString()}\nLargest orb ${game.biggest + 1}`;
      if (kind === 'snake') $('detail').textContent = `Length ${game.body.length} · best ${game.best}\nSpeed ${Math.round(1/Math.max(.065,.17-game.score*.002))} cells/s`;
      if (kind === 'factory') $('detail').textContent = `${format(game.rate())} cycles / second\n${game.achievements.length} / ${achievementDefs.length} achievements`;
    }
    const format = n => n >= 1e15 ? (n/1e15).toFixed(2)+'q' : n >= 1e12 ? (n/1e12).toFixed(2)+'t' : n >= 1e9 ? (n/1e9).toFixed(2)+'b' : n >= 1e6 ? (n/1e6).toFixed(2)+'m' : n >= 1e3 ? (n/1e3).toFixed(1)+'k' : Math.floor(n).toLocaleString();
    function control(glyph, label, fn) {
      const b = document.createElement('button'); b.className='icon-button'; b.innerHTML=icon(glyph); b.title=label; b.setAttribute('aria-label',label);
      b.onclick=()=>{ if(active()&&!game.over){fn();stats();draw();saveSoon();wake();} }; $('controls').append(b);
    }
    function select(type, fresh = false) {
      stop(); clearTimeout(factoryTimer); factoryTimer=0; particles=[]; aimDrag=null; canvas?.remove(); $('miner-panel')?.remove();
      kind=type; paused=false; game=fresh?makeGame(type):sessions.get(type)||makeGame(type); sessions.set(type,game);
      $('menu').hidden=true;$('arena').hidden=false;$('game-title').textContent=names[type];$('instructions').textContent=hints[type];
      $('score-label').textContent=type==='factory'?'Cycles':'Score'; $('surface').classList.remove('wide');
      $('curtain').hidden=true;$('pause').disabled=false;$('pause').innerHTML=icon('pause');$('pause').title='Pause';
      $('game-settings').hidden=type!=='blocks';$('controls').replaceChildren();$('footnote').textContent='Progress saves automatically';
      $('previews')?.remove();
      if(type==='blocks') {
        const previews=document.createElement('div');previews.id='previews';previews.innerHTML='<div class="label">Next</div><canvas id="next-piece" width="104" height="72"></canvas><div class="label">Hold · C / Shift</div><canvas id="hold-piece" width="104" height="72"></canvas>';
        $('controls').before(previews);
      }
      if(type==='factory'){canvas=ctx=null;renderMiner();scheduleFactory();}
      else {
        canvas=document.createElement('canvas');canvas.width=360;canvas.height=520;canvas.setAttribute('aria-label',`${names[type]} game board`);$('surface').prepend(canvas);ctx=canvas.getContext('2d',{alpha:false});
        canvas.addEventListener('pointerdown',pointerDown);canvas.addEventListener('pointermove',pointerMove);canvas.addEventListener('pointerup',pointerUp);canvas.addEventListener('pointercancel',()=>aimDrag=null);
        if(type==='blocks'){control('left','Move left',()=>game.move(-1,0));control('rotate','Rotate',()=>game.rotate());control('right','Move right',()=>game.move(1,0));control('down','Soft drop',softDrop);control('drop','Hard drop',hardDrop);control('hold','Hold (C / Shift)',()=>{game.hold();if(game.over)finish('Game over');});}
        if(type==='merge'){control('left','Aim left',()=>game.aim=clamp(game.aim-18,30,330));control('drop','Drop orb',dropOrb);control('right','Aim right',()=>game.aim=clamp(game.aim+18,30,330));}
        if(type==='snake'){control('left','Left',()=>game.turn(-1,0));control('rotate','Up',()=>game.turn(0,-1));control('down','Down',()=>game.turn(0,1));control('right','Right',()=>game.turn(1,0));}
      }
      stats();draw();wake();saveSoon();
    }
    function finish(title,text='Your progress is saved.') {game.over=true;stats();$('curtain').hidden=false;$('curtain').querySelector('strong').textContent=title;$('curtain').querySelector('p').textContent=text;$('resume').textContent='Play again';$('pause').disabled=true;saveNow();}
    function setPaused(value){if(!kind||game.over)return;paused=value;stop();clearTimeout(factoryTimer);factoryTimer=0;aimDrag=null;$('curtain').hidden=!value;$('curtain').querySelector('strong').textContent='Paused';$('curtain').querySelector('p').textContent='No game work is running.';$('resume').textContent='Resume';$('pause').innerHTML=icon(value?'play':'pause');$('pause').title=value?'Resume':'Pause';if(!value){scheduleFactory();wake();}}
    function leave(){stop();clearTimeout(factoryTimer);factoryTimer=0;saveNow();canvas?.remove();$('miner-panel')?.remove();canvas=ctx=null;kind=game=null;$('arena').hidden=true;$('menu').hidden=false;$('footnote').textContent='No game running';}

    function renderMiner(tick=false){
      let panel=$('miner-panel');if(!panel){panel=document.createElement('div');panel.id='miner-panel';panel.className='miner';$('surface').prepend(panel);}
      if(tick&&panel.querySelector('.amount')){
        panel.querySelector('.amount').textContent=format(game.energy);panel.querySelector('.rate').textContent='+'+format(game.rate())+'/s';
        panel.querySelectorAll('[data-buy]').forEach(b=>{const i=+b.dataset.buy;b.disabled=game.total<minerItems[i].unlock||game.energy<game.cost(i);if(game.total>=minerItems[i].unlock)b.querySelector('small').textContent=minerItems[i].detail;});
        panel.querySelectorAll('[data-upgrade]').forEach(b=>{const u=minerUpgrades.find(u=>u.id===b.dataset.upgrade);b.disabled=game.upgrades.includes(u.id)||game.total<u.unlock||game.energy<u.cost;});
        const pack=panel.querySelector('[data-expedition]');if(pack)pack.disabled=game.energy<game.expeditionCost();
        return;
      }
      const scroll=panel.querySelector('.shop')?.scrollTop||0;
      const rate=game.rate(), milestones=[100,1000,10000,100000,1000000,1e8,1e10,1e12,1e14,1e16,1e18,1e21,1e24,1e27,1e30], next=milestones.find(x=>game.total<x), previous=next?([0,...milestones][milestones.indexOf(next)]):milestones.at(-1), progress=next?clamp((game.total-previous)/(next-previous)*100,0,100):100;
      const items=minerItems.map((item,i)=>{const locked=game.total<item.unlock,cost=game.cost(i);return `<button class="shop-row" data-buy="${i}" ${locked||game.energy<cost?'disabled':''}><span class="mini-icon">${icon(locked?'lock':'mine',15)}</span><span><strong>${item.name}</strong><small>${locked?`Unlock at ${format(item.unlock)} total`:item.detail}</small></span><span>${game.items[i]?`<b class="badge">${game.items[i]}</b>`:`<b class="cost">${format(cost)}</b>`}</span></button>`}).join('');
      const upgrades=minerUpgrades.map(u=>{const owned=game.upgrades.includes(u.id),locked=game.total<u.unlock;return `<button class="shop-row" data-upgrade="${u.id}" ${owned||locked||game.energy<u.cost?'disabled':''}><span class="mini-icon">${icon(owned?'check':locked?'lock':'bolt',15)}</span><span><strong>${u.name}</strong><small>${owned?'Installed':locked?`Unlock at ${format(u.unlock)} total`:u.detail}</small></span><b class="${owned?'badge':'cost'}">${owned?'✓':format(u.cost)}</b></button>`}).join('');
      const achievements=achievementDefs.map(a=>{const done=game.achievements.includes(a.id);return `<div class="shop-row achievement ${done?'done':''}"><span class="mini-icon">${icon(done?'trophy':'lock',15)}</span><span><strong>${a.name}</strong><small>${a.detail}</small></span><b class="badge">${done?'✓':'+10%'}</b></div>`}).join('');
      panel.innerHTML=`<div class="miner-top"><div><div class="label">Available cycles</div><div class="amount">${format(game.energy)}</div></div><div class="rate">+${format(rate)}/s</div></div><button class="mine-button" id="generate">${icon('bolt',28)}<small>+${format(game.clickPower())}</small></button><div class="offline">${game.offlineGain?`Welcome back · +${format(game.offlineGain)} offline cycles`:''}</div><div class="progress"><i style="width:${progress}%"></i></div><div class="milestone">${next?`${format(next-game.total)} to the next network milestone`:'All core milestones reached'}</div><div class="miner-tabs"><button data-view="items" class="${minerView==='items'?'on':''}">${icon('cart',13)} Hardware</button><button data-view="upgrades" class="${minerView==='upgrades'?'on':''}">${icon('bolt',13)} Upgrades</button><button data-view="achievements" class="${minerView==='achievements'?'on':''}">${icon('trophy',13)} Achievements</button></div><div class="shop">${minerView==='items'?items:minerView==='upgrades'?upgrades:achievements}</div>`;
      $('generate').onclick=()=>{if(!active())return;const unlocked=game.tap();game.offlineGain=0;notifyAchievements(unlocked);renderMiner();stats();saveSoon();};
      panel.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{minerView=b.dataset.view;renderMiner();});
      panel.querySelectorAll('[data-buy]').forEach(b=>b.onclick=()=>{game.buy(+b.dataset.buy);renderMiner();stats();saveSoon();scheduleFactory();});
      panel.querySelectorAll('[data-upgrade]').forEach(b=>b.onclick=()=>{game.buyUpgrade(b.dataset.upgrade);renderMiner();stats();saveSoon();});
      const research=document.createElement('button');research.className='quiet-button';research.textContent=`Research ${game.research} · ${game.shards} shards · Upgrade (${game.researchCost()})`;research.disabled=game.shards<game.researchCost();research.title='Each research level permanently increases all production by 50%';research.onclick=()=>{game.buyResearch();renderMiner();stats();saveSoon();};panel.append(research);
      const reboot=document.createElement('button');reboot.className='quiet-button';reboot.textContent=`Reboot · +${game.rebootGain()} shards`;reboot.disabled=!game.rebootGain();reboot.title='Reset this run for permanent research shards. First reboot unlocks at 100 million cycles.';reboot.onclick=()=>{if(confirm('Reboot your network? Hardware, cycles and run upgrades reset. Achievements and research stay.')){game.reboot();renderMiner();stats();saveNow();}};panel.append(reboot);
      const treeTab=document.createElement('button');treeTab.innerHTML=icon('merge',13)+' Research tree';treeTab.className=minerView==='tree'?'on':'';treeTab.onclick=()=>{minerView='tree';renderMiner();};panel.querySelector('.miner-tabs').append(treeTab);
      const artifactsTab=document.createElement('button');artifactsTab.innerHTML=icon('blocks',13)+' Artifacts';artifactsTab.className=minerView==='artifacts'?'on':'';artifactsTab.onclick=()=>{minerView='artifacts';renderMiner();};panel.querySelector('.miner-tabs').append(artifactsTab);
      const shop=panel.querySelector('.shop');
      if(minerView==='tree'){
        shop.innerHTML=researchTree.map(r=>{const owned=game.tree.includes(r.id),ready=r.requires.every(id=>game.tree.includes(id));return `<button class="shop-row" data-research="${r.id}" ${owned||!ready||game.shards<r.cost?'disabled':''}><span class="mini-icon">${icon(owned?'check':ready?'bolt':'lock',15)}</span><span><strong>${r.branch} · ${r.name}</strong><small>${r.detail}${r.requires.length?' · After '+r.requires.join(' + '):' · Root node'}</small></span><b class="cost">${owned?'Installed':r.cost+' shards'}</b></button>`}).join('');
        shop.querySelectorAll('[data-research]').forEach(b=>b.onclick=()=>{game.unlockResearch(b.dataset.research);renderMiner();stats();saveNow();});
      }
      if(minerView==='artifacts'){
        shop.innerHTML=`<div class="instructions">Expeditions award known, permanent artifacts. No paid or random loot boxes. Keep artifacts and research through reboots.</div>`+artifactDefs.map((name,i)=>`<div class="shop-row"><span class="mini-icon">${icon('blocks',15)}</span><span><strong>${name}</strong><small>Permanent production bonus, diminishing returns</small></span><b class="badge">${game.artifacts[i]}</b></div>`).join('');
        const explore=document.createElement('button');explore.dataset.expedition='true';explore.className='quiet-button';explore.textContent=`Unpack expedition ${game.expeditions+1} · ${format(game.expeditionCost())} cycles`;explore.disabled=game.energy<game.expeditionCost();explore.onclick=()=>{const reward=game.explore();if(reward)$('footnote').textContent='Discovered · '+reward;renderMiner();stats();saveNow();};shop.prepend(explore);
      }
      shop.scrollTop=scroll;
    }
    function notifyAchievements(list){if(list?.length)$('footnote').textContent=`Achievement unlocked · ${achievementDefs.find(a=>a.id===list.at(-1))?.name}`;}
    function scheduleFactory(){clearTimeout(factoryTimer);factoryTimer=0;if(!active()||kind!=='factory'||!game.rate())return;factoryTimer=setTimeout(()=>{if(active()&&kind==='factory'){const unlocked=game.tick(1);notifyAchievements(unlocked);renderMiner(true);stats();saveSoon();scheduleFactory();}},1000);}

    function softDrop(){if(!game.move(0,1))clearRows(game.lock());else game.score++;game.fall=0;}
    function hardDrop(){clearRows(game.drop());game.fall=0;}
    function clearRows(rows){if(rows&&!reducedMotion)burst(180,390,18);settings.blocks.highScore=Math.max(settings.blocks.highScore,game.score);settings.blocks.updatedAt=Date.now();if(game.over)finish('Game over');}
    // Successive merges conserve disc area until the final tier is capped to
    // fit the jar. The same radii drive rendering, collision and saved games.
    const radius=level=>Math.min(145,12*Math.SQRT2**clamp(level,0,9));
    function dropOrb(){if(game.cooldown>0||game.over)return;if(game.bodies.length>=36){finish('Jar full');return;}const r=radius(game.next);game.bodies.push({x:clamp(game.aim,12+r,348-r),y:42,r,vx:0,vy:0,level:game.next,age:0});game.next=Math.floor(Math.random()*3);game.cooldown=.36;game.sleeping=false;game.settled=0;saveSoon();}
    function burst(x,y,count){for(let i=0;i<count&&particles.length<40;i++){const a=Math.random()*Math.PI*2,s=30+Math.random()*90;particles.push({x,y,vx:Math.cos(a)*s,vy:Math.sin(a)*s,life:.45});}}

    function point(e){const r=canvas.getBoundingClientRect();return{x:(e.clientX-r.left)*canvas.width/r.width,y:(e.clientY-r.top)*canvas.height/r.height};}
    function pointerDown(e){if(!active()||game.over||e.button!==0)return;const p=point(e);if(kind==='merge'){game.aim=p.x;dropOrb();}else if(kind==='snake'){aimDrag={x:p.x,y:p.y};canvas.setPointerCapture(e.pointerId);}draw();wake();}
    function pointerMove(e){if(!active()||game.over)return;const p=point(e);if(kind==='merge')game.aim=clamp(p.x,12+radius(game.next),348-radius(game.next));if(!raf)draw();}
    function pointerUp(e){if(kind==='snake'&&aimDrag){const p=point(e),dx=p.x-aimDrag.x,dy=p.y-aimDrag.y;if(Math.hypot(dx,dy)>12)game.turn(Math.abs(dx)>Math.abs(dy)?Math.sign(dx):0,Math.abs(dy)>=Math.abs(dx)?Math.sign(dy):0);aimDrag=null;}}

    function update(dt){
      if(kind==='blocks'){game.fall+=dt;game.flash=Math.max(0,game.flash-dt);const interval=Math.max(.075,.8-(game.level()-1)*.065);if(game.fall>=interval){game.fall=0;if(!game.move(0,1))clearRows(game.lock());}}
      if(kind==='merge'){
        game.cooldown=Math.max(0,game.cooldown-dt);for(const b of game.bodies)b.age+=dt;const removed=new Set(),add=[];
        physics(game.bodies,dt,360,520,820,.12,(a,b)=>{if(a.level!==b.level||a.level>=9||removed.has(a)||removed.has(b))return;removed.add(a);removed.add(b);const level=a.level+1;add.push({x:(a.x+b.x)/2,y:(a.y+b.y)/2,vx:(a.vx+b.vx)/2,vy:-35,r:radius(level),level,age:0});game.score+=2**level*10;game.best=Math.max(game.best,game.score);game.biggest=Math.max(game.biggest,level);if(!reducedMotion)burst((a.x+b.x)/2,(a.y+b.y)/2,8);},12);
        if(removed.size){game.bodies=game.bodies.filter(b=>!removed.has(b)).concat(add);stats();saveSoon();}const danger=game.bodies.some(b=>b.age>1.5&&b.y-b.r<78);game.danger=danger?game.danger+dt:0;if(game.danger>1.4)finish('Jar full');const settled=!danger&&game.bodies.every(b=>b.age>1.2&&Math.hypot(b.vx,b.vy)<12);game.settled=settled?game.settled+dt:0;if(game.settled>.45){game.sleeping=true;for(const b of game.bodies)b.vx=b.vy=0;saveNow();}}
      if(kind==='snake'){const before=game.score;game.step(dt);if(game.score!==before){stats();saveSoon();}if(game.over)finish('Game over');}
      for(const p of particles){p.x+=p.vx*dt;p.y+=p.vy*dt;p.vy+=180*dt;p.life-=dt;}particles=particles.filter(p=>p.life>0);
    }
    function cell(x,y,size,color,alpha=1){ctx.globalAlpha=alpha;ctx.fillStyle=color;ctx.fillRect(x+1,y+1,size-2,size-2);ctx.globalAlpha=1;}
    function draw(){if(!ctx||!game)return;ctx.fillStyle='#0f0f0f';ctx.fillRect(0,0,canvas.width,canvas.height);
      if(kind==='blocks'){const off=50,size=26;if(settings.blocks.grid){ctx.strokeStyle='#363c46';ctx.lineWidth=1;for(let x=0;x<=10;x++){ctx.beginPath();ctx.moveTo(off+x*size,0);ctx.lineTo(off+x*size,520);ctx.stroke();}for(let y=0;y<=20;y++){ctx.beginPath();ctx.moveTo(off,y*size);ctx.lineTo(off+260,y*size);ctx.stroke();}}game.board.forEach((row,y)=>row.forEach((v,x)=>v&&cell(off+x*size,y*size,size,v%2?BLUE:'#6f8fd8')));const p=game.piece;let gy=p.y;if(!game.over&&settings.blocks.ghost)while(game.fits(p.matrix,p.x,gy+1))gy++;p.matrix.forEach((row,y)=>row.forEach((v,x)=>{if(!v)return;if(settings.blocks.ghost)cell(off+(p.x+x)*size,(gy+y)*size,size,'#4f80f5',.14);cell(off+(p.x+x)*size,(p.y+y)*size,size,BLUE);}));preview('next-piece',game.next);preview('hold-piece',game.held);}
      if(kind==='merge'){ctx.strokeStyle='#303030';ctx.lineWidth=2;ctx.strokeRect(12,12,336,506);ctx.setLineDash([4,7]);ctx.strokeStyle=game.danger?'#a84e59':'#333';ctx.beginPath();ctx.moveTo(13,78);ctx.lineTo(347,78);ctx.stroke();ctx.setLineDash([]);for(const b of game.bodies)orb(b);if(!game.over)orb({x:clamp(game.aim,38,322),y:40,r:radius(game.next),level:game.next},game.cooldown?.2:.7);}
      if(kind==='snake'){ctx.strokeStyle='#303943';ctx.strokeRect(10,90,340,340);for(let i=0;i<game.body.length;i++){const p=game.body[i];ctx.fillStyle=i===0?'#adc5ff':BLUE;ctx.fillRect(11+p.x*17,91+p.y*17,15,15);}ctx.fillStyle='#80cebe';ctx.beginPath();ctx.arc(18.5+game.food.x*17,98.5+game.food.y*17,5,0,Math.PI*2);ctx.fill();}
      for(const p of particles){ctx.globalAlpha=p.life/.45;ctx.fillStyle='#7095f1';ctx.fillRect(p.x,p.y,2,2);}ctx.globalAlpha=1;
    }
    function orb(b,alpha=1){const shades=['#527ecf','#6a87c5','#8297c0','#9aa8be','#7188b5'];ctx.globalAlpha=alpha;ctx.fillStyle=shades[b.level%shades.length];ctx.beginPath();ctx.arc(b.x,b.y,b.r-1,0,Math.PI*2);ctx.fill();ctx.fillStyle='#fff';ctx.globalAlpha=alpha*.8;ctx.font=`500 ${Math.max(10,b.r*.48)}px Outfit,sans-serif`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(b.level+1,b.x,b.y);ctx.globalAlpha=1;}
    function preview(id,type){const cv=$(id);if(!cv)return;const c=cv.getContext('2d');c.clearRect(0,0,104,72);if(type===null)return;const m=shapes[type],size=18,ox=(104-m[0].length*size)/2,oy=(72-m.length*size)/2;c.fillStyle=BLUE;m.forEach((row,y)=>row.forEach((v,x)=>{if(v)c.fillRect(ox+x*size,oy+y*size,size-2,size-2);}));}
    function poolBall(b){ctx.fillStyle=b.cue?'#e1e1df':(b.id%2?BLUE:'#8c9bbd');ctx.beginPath();ctx.arc(b.x,b.y,b.r,0,Math.PI*2);ctx.fill();if(!b.cue){ctx.fillStyle='#101010';ctx.beginPath();ctx.arc(b.x,b.y,4.4,0,Math.PI*2);ctx.fill();ctx.fillStyle='#ddd';ctx.font='7px Outfit';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(b.id,b.x,b.y+.3);}}
    function frame(now){raf=0;const dt=last?Math.min((now-last)/1000,.05):0;last=now;accumulator+=dt;while(accumulator>=1/120){if(active()&&!game.over)update(1/120);if(logoMoving){physics([logo],1/120,innerWidth,innerHeight,600,.6);logoTime+=1/120;if(logoTime>6||(logo.y>=innerHeight-logo.r-1&&Math.hypot(logo.vx,logo.vy)<12))logoMoving=false;}accumulator-=1/120;}if(logo)positionLogo();draw();if(animated())wake();else{last=0;accumulator=0;}}

    document.querySelectorAll('[data-game]').forEach(b=>b.onclick=()=>select(b.dataset.game));$('back').onclick=leave;$('pause').onclick=()=>setPaused(!paused);$('restart').onclick=()=>{if(confirm(`Restart ${names[kind]}? Your saved progress for this game will reset.`))select(kind,true);};$('resume').onclick=()=>game.over?select(kind,true):setPaused(false);
    $('game-settings').onclick=()=>{$('start-level').value=settings.blocks.startLevel;document.querySelectorAll('[data-setting]').forEach(b=>b.classList.toggle('on',!!settings.blocks[b.dataset.setting]));$('settings-dialog').showModal();};$('close-settings').onclick=()=>$('settings-dialog').close();
    document.querySelectorAll('[data-setting]').forEach(b=>b.onclick=()=>{const k=b.dataset.setting;settings.blocks[k]=!settings.blocks[k];settings.blocks.updatedAt=Date.now();b.classList.toggle('on',settings.blocks[k]);draw();saveNow();});$('start-level').onchange=e=>{settings.blocks.startLevel=+e.target.value;settings.blocks.updatedAt=Date.now();saveNow();};
    document.addEventListener('keydown',e=>{
      if(!kind||e.ctrlKey||e.altKey||e.metaKey||$('settings-dialog').open)return;
      if(e.code==='Escape'){e.preventDefault();if(!paused&&!game.over)setPaused(true);else leave();return;}
      if(e.code==='KeyP'){e.preventDefault();if(!e.repeat)setPaused(!paused);return;}
      if(!active()||game.over||kind==='factory')return;
      let handled=true;
      if(kind==='blocks'){
        if(e.code==='ArrowLeft')game.move(-1,0);else if(e.code==='ArrowRight')game.move(1,0);
        else if(e.code==='ArrowUp'){if(!e.repeat)game.rotate();}else if(e.code==='ArrowDown')softDrop();
        else if(e.code==='Space'){if(!e.repeat)hardDrop();}
        else if(['KeyC','ShiftLeft','ShiftRight'].includes(e.code)){if(!e.repeat){game.hold();if(game.over)finish('Game over');}}
        else handled=false;
      }else if(kind==='snake'){
        if(['ArrowLeft','KeyA'].includes(e.code))game.turn(-1,0);
        else if(['ArrowRight','KeyD'].includes(e.code))game.turn(1,0);
        else if(['ArrowUp','KeyW'].includes(e.code))game.turn(0,-1);
        else if(['ArrowDown','KeyS'].includes(e.code))game.turn(0,1);else handled=false;
      }else{
        if(e.code==='ArrowLeft')game.aim=clamp(game.aim-14,12+radius(game.next),348-radius(game.next));
        else if(e.code==='ArrowRight')game.aim=clamp(game.aim+14,12+radius(game.next),348-radius(game.next));
        else if(e.code==='Space'){if(!e.repeat)dropOrb();}else handled=false;
      }
      if(handled){e.preventDefault();stats();draw();saveSoon();wake();}
    });
    function quiet(){logoMoving=false;logoDrag=null;aimDrag=null;saveNow();stop();if(kind&&!game.over)setPaused(true);clearTimeout(factoryTimer);factoryTimer=0;}addEventListener('blur',quiet);document.addEventListener('visibilitychange',()=>{if(document.hidden)quiet();});addEventListener('pagehide',quiet);
    function positionLogo(){$('logo').style.transform=`translate(${logo.x-logo.ox}px,${logo.y-logo.oy}px)`;}function prepareLogo(){if(logo)return;const r=$('logo').getBoundingClientRect();logo={x:r.left+r.width/2,y:r.top+r.height/2,r:27,vx:0,vy:0,ox:r.left+r.width/2,oy:r.top+r.height/2};}
    $('logo').onpointerdown=e=>{if(e.button!==0)return;e.preventDefault();prepareLogo();logoMoving=false;logoDrag={id:e.pointerId,x:e.clientX,y:e.clientY,at:performance.now(),dx:e.clientX-logo.x,dy:e.clientY-logo.y};logo.vx=logo.vy=0;$('logo').setPointerCapture(e.pointerId);};$('logo').onpointermove=e=>{if(logoDrag?.id!==e.pointerId)return;const now=performance.now(),dt=Math.max(.008,(now-logoDrag.at)/1000);logo.vx=clamp((e.clientX-logoDrag.x)/dt,-1400,1400);logo.vy=clamp((e.clientY-logoDrag.y)/dt,-1400,1400);logo.x=clamp(e.clientX-logoDrag.dx,logo.r,innerWidth-logo.r);logo.y=clamp(e.clientY-logoDrag.dy,logo.r,innerHeight-logo.r);Object.assign(logoDrag,{x:e.clientX,y:e.clientY,at:now});positionLogo();};$('logo').onpointerup=e=>{if(logoDrag?.id!==e.pointerId)return;logoDrag=null;logoMoving=true;logoTime=0;wake();};
    addEventListener('resize',()=>{logoMoving=false;logoDrag=null;logo=null;$('logo').style.transform='';});
    window.__zroArcadeReady=true;
  };
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',render,{once:true});else render();
})();
