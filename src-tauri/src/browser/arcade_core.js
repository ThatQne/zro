/* Deterministic, DOM-free arcade primitives. */
(() => {
  const node = typeof module !== 'undefined' && module.exports;
  if (!node && !window.__zroNewTabDocument) return;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function physics(bodies, dt, width, height, gravity = 850, bounce = .22, contact, inset = 0) {
    dt = clamp(dt, 0, 1 / 60);
    for (const b of bodies) {
      b.vy += gravity * dt;
      const drag = Math.exp(-.3 * dt);
      b.vx *= drag; b.vy *= drag;
      b.x += b.vx * dt; b.y += b.vy * dt;
      const left = inset + b.r, right = width - inset - b.r, top = inset + b.r, bottom = height - inset - b.r;
      if (b.x < left) { b.x = left; b.vx = Math.abs(b.vx) * bounce; }
      if (b.x > right) { b.x = right; b.vx = -Math.abs(b.vx) * bounce; }
      if (b.y < top) { b.y = top; b.vy = Math.abs(b.vy) * bounce; }
      if (b.y > bottom) {
        b.y = bottom; b.vy = -Math.abs(b.vy) * bounce; b.vx *= Math.exp(-4 * dt);
        if (Math.abs(b.vy) < 10) b.vy = 0;
      }
    }
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i], b = bodies[j], dx = b.x - a.x, dy = b.y - a.y, rr = a.r + b.r;
        const squared = dx * dx + dy * dy;
        if (squared >= rr * rr) continue;
        if (pass === 0 && contact) contact(a, b);
        const distance = Math.sqrt(squared), nx = distance > .001 ? dx / distance : 1, ny = distance > .001 ? dy / distance : 0;
        const ia = 1 / (a.r * a.r), ib = 1 / (b.r * b.r), sum = ia + ib, depth = rr - distance;
        a.x -= nx * depth * ia / sum; a.y -= ny * depth * ia / sum;
        b.x += nx * depth * ib / sum; b.y += ny * depth * ib / sum;
        const speed = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (speed < 0) {
          const impulse = -(1 + bounce) * speed / sum;
          a.vx -= impulse * nx * ia; a.vy -= impulse * ny * ia;
          b.vx += impulse * nx * ib; b.vy += impulse * ny * ib;
        }
      }
      for (const b of bodies) {
        b.x = clamp(b.x, inset + b.r, width - inset - b.r);
        b.y = clamp(b.y, inset + b.r, height - inset - b.r);
      }
    }
  }

  const shapes = [
    [[1, 1, 1, 1]], [[1, 1], [1, 1]], [[0, 1, 0], [1, 1, 1]],
    [[0, 1, 1], [1, 1, 0]], [[1, 1, 0], [0, 1, 1]],
    [[1, 0, 0], [1, 1, 1]], [[0, 0, 1], [1, 1, 1]],
  ];
  function tetris(random = Math.random, settings = {}) {
    const start = clamp(Number(settings.startLevel) || 1, 1, 10);
    const s = { board: Array.from({ length: 20 }, () => Array(10).fill(0)), bag: [],
      piece: null, next: null, held: null, holdUsed: false, score: 0, lines: 0, over: false, startLevel: start };
    const draw = () => {
      if (!s.bag.length) {
        s.bag = [0, 1, 2, 3, 4, 5, 6];
        for (let i = 6; i > 0; i--) {
          const j = Math.floor(random() * (i + 1));
          [s.bag[i], s.bag[j]] = [s.bag[j], s.bag[i]];
        }
      }
      return s.bag.pop();
    };
    s.level = () => s.startLevel + Math.floor(s.lines / 10);
    s.fits = (matrix, x, y) => matrix.every((row, ry) => row.every((v, rx) => !v ||
      (x + rx >= 0 && x + rx < 10 && y + ry >= 0 && y + ry < 20 && !s.board[y + ry][x + rx])));
    s.spawn = () => {
      s.holdUsed = false;
      const type = s.next === null ? draw() : s.next;
      s.next = draw(); s.piece = { matrix: shapes[type].map(row => row.slice()), type: type + 1, x: 3, y: 0 };
      s.over = !s.fits(s.piece.matrix, 3, 0);
    };
    s.hold = () => {
      if (s.over || s.holdUsed) return false;
      const type = s.piece.type - 1, previous = s.held;
      if (previous === null) s.spawn();
      else { s.piece = {matrix: shapes[previous].map(row=>row.slice()), type: previous+1, x:3, y:0}; s.over = !s.fits(s.piece.matrix,3,0); }
      s.held = type; s.holdUsed = true; return true;
    };
    s.move = (dx, dy) => {
      const p = s.piece;
      if (s.over || !s.fits(p.matrix, p.x + dx, p.y + dy)) return false;
      p.x += dx; p.y += dy; return true;
    };
    s.rotate = () => {
      if (s.over) return false;
      const p = s.piece, m = p.matrix[0].map((_, x) => p.matrix.map(row => row[x]).reverse());
      for (const kick of [0, -1, 1, -2, 2]) if (s.fits(m, p.x + kick, p.y)) {
        p.matrix = m; p.x += kick; return true;
      }
      return false;
    };
    s.lock = () => {
      if (s.over) return 0;
      const p = s.piece;
      p.matrix.forEach((row, y) => row.forEach((v, x) => { if (v) s.board[p.y + y][p.x + x] = p.type; }));
      const rest = s.board.filter(row => row.some(v => !v)), cleared = 20 - rest.length;
      while (rest.length < 20) rest.unshift(Array(10).fill(0));
      s.board = rest; s.score += [0, 100, 300, 500, 800][cleared] * s.level(); s.lines += cleared; s.spawn();
      return cleared;
    };
    s.drop = () => { if (s.over) return 0; while (s.move(0, 1)) s.score += 2; return s.lock(); };
    s.spawn(); return s;
  }

  const minerItems = [
    { id: 'node', name: 'Ping node', detail: 'A tiny background worker', base: 15, growth: 1.18, rate: 1, unlock: 0 },
    { id: 'rig', name: 'Render rig', detail: 'Eight cycles every second', base: 120, growth: 1.19, rate: 8, unlock: 75 },
    { id: 'array', name: 'Memory array', detail: 'Keeps the signal moving', base: 950, growth: 1.20, rate: 52, unlock: 600 },
    { id: 'cluster', name: 'Edge cluster', detail: 'A compact compute room', base: 8200, growth: 1.21, rate: 310, unlock: 5000 },
    { id: 'core', name: 'Quant core', detail: 'Turns heat into momentum', base: 78000, growth: 1.22, rate: 1850, unlock: 45000 },
    { id: 'lab', name: 'Photon lab', detail: 'Light-speed signal processors', base: 950000, growth: 1.22, rate: 18000, unlock: 600000 },
    { id: 'station', name: 'Orbital station', detail: 'A network above the clouds', base: 24000000, growth: 1.23, rate: 280000, unlock: 15000000 },
    { id: 'swarm', name: 'Solar swarm', detail: 'Harvest a star to power the fleet', base: 850000000, growth: 1.24, rate: 6500000, unlock: 500000000 },
    { id: 'gate', name: 'Deep-space relay', detail: 'Bridge distant colonies', base: 45000000000, growth: 1.25, rate: 230000000, unlock: 25000000000 },
    { id: 'engine', name: 'Horizon engine', detail: 'Explore the edge of the network', base: 3500000000000, growth: 1.26, rate: 11000000000, unlock: 2000000000000 },
    ...[1e15,1e18,1e21,1e24,1e27].map((base,i)=>({id:'frontier'+i,name:['Nebula forge','Galaxy lattice','Void observatory','Multiverse gate','Infinity archive'][i],detail:'Late-game frontier infrastructure',base,growth:1.26,rate:base/500,unlock:base*.6})),
  ];
  const minerUpgrades = [
    { id: 'tap2', name: 'Better switch', detail: 'Tap power ×2', cost: 80, unlock: 40 },
    { id: 'node2', name: 'Node scheduler', detail: 'Ping nodes ×2', cost: 450, unlock: 250 },
    { id: 'all2', name: 'Lean runtime', detail: 'All production ×2', cost: 3000, unlock: 1800 },
    { id: 'tap10', name: 'Parallel input', detail: 'Tap power ×5', cost: 18000, unlock: 10000 },
    { id: 'all3', name: 'Vector pipeline', detail: 'All production ×3', cost: 160000, unlock: 100000 },
    ...[1e7, 1e9, 1e11, 1e13, 1e15].map((cost,i)=>({id:`network${i}`,name:['Optical mesh','Orbital links','Star map','Warp routing','Event horizon'][i],detail:'All production ×2',cost,unlock:cost/2})),
    ...[1e18,1e21,1e24,1e27,1e30].map((cost,i)=>({id:`network${i+5}`,name:['Nebula compression','Galactic backbone','Void telemetry','Universal relay','Infinite signal'][i],detail:'All production ×2',cost,unlock:cost/2})),
  ];
  const researchTree = [
    {id:'scheduler',name:'Task scheduler',detail:'Production ×2',cost:1,requires:[],branch:'Compute'},
    {id:'parallel',name:'Parallel execution',detail:'Production ×3',cost:3,requires:['scheduler'],branch:'Compute'},
    {id:'optical',name:'Optical processor',detail:'Production ×5',cost:12,requires:['parallel'],branch:'Compute'},
    {id:'fusion',name:'Fusion network',detail:'Production ×8',cost:60,requires:['optical'],branch:'Compute'},
    {id:'input',name:'Input amplifier',detail:'Tap ×10',cost:1,requires:[],branch:'Input'},
    {id:'combo',name:'Signal cascade',detail:'Tap ×25',cost:4,requires:['input'],branch:'Input'},
    {id:'resonance',name:'Resonance array',detail:'Tap ×100',cost:18,requires:['combo'],branch:'Input'},
    {id:'salvage',name:'Salvage scanner',detail:'More artifacts from expeditions',cost:2,requires:[],branch:'Discovery'},
    {id:'survey',name:'Deep survey',detail:'Artifact power ×2',cost:8,requires:['salvage'],branch:'Discovery'},
    {id:'archive',name:'Ancient archive',detail:'Production ×10',cost:40,requires:['survey','optical'],branch:'Discovery'},
  ];
  const artifactDefs=['Signal chip','Photon lens','Cryo capacitor','Relic processor','Horizon beacon'];
  const achievementDefs = [
    { id: 'first', name: 'First signal', detail: 'Tap once', test: s => s.taps >= 1 },
    { id: 'hundred', name: 'Three digits', detail: 'Produce 100 cycles', test: s => s.total >= 100 },
    { id: 'crew', name: 'Small fleet', detail: 'Own 10 items', test: s => s.items.reduce((a, b) => a + b, 0) >= 10 },
    { id: 'fast', name: 'Real momentum', detail: 'Reach 100 cycles/s', test: s => s.rate() >= 100 },
    { id: 'tenk', name: 'Five digits', detail: 'Produce 10,000 cycles', test: s => s.total >= 10000 },
    { id: 'collector', name: 'One of everything', detail: 'Own every item', test: s => s.items.every(v => v > 0) },
    { id: 'million', name: 'Signal city', detail: 'Produce 1,000,000 cycles', test: s => s.total >= 1000000 },
    { id: 'tap500', name: 'Persistent', detail: 'Tap 500 times', test: s => s.taps >= 500 },
    ...[1e8,1e10,1e12,1e14,1e16].map((goal,i)=>({id:`frontier${i}`,name:['Beyond the city','Stellar network','Galactic signal','Cosmic web','Infinite horizon'][i],detail:`Produce ${goal.toExponential()} cycles in one run`,test:s=>s.total>=goal})),
    {id:'reboot',name:'New beginning',detail:'Reboot your network',test:s=>s.reboots>0},
    {id:'research',name:'Researcher',detail:'Reach research level 5',test:s=>s.research>=5},
  ];
  function factory(data = {}) {
    const s = { energy: Number(data.energy) || 0, total: Number(data.total) || 0, taps: Number(data.taps) || 0,
      items: minerItems.map((_, i) => Math.max(0, Number(data.items?.[i]) || 0)),
      upgrades: Array.isArray(data.upgrades) ? data.upgrades.filter(id => minerUpgrades.some(u => u.id === id)) : [],
      achievements: Array.isArray(data.achievements) ? data.achievements.filter(id => achievementDefs.some(a => a.id === id)) : [],
      lastSaved: Number(data.lastSaved) || Date.now() };
    s.shards = Math.max(0, Number(data.shards)||0); s.reboots = Math.max(0,Number(data.reboots)||0); s.research = Math.max(0,Number(data.research)||0);
    s.tree=Array.isArray(data.tree)?[...new Set(data.tree.filter(id=>researchTree.some(r=>r.id===id)))]:[];
    s.artifacts=artifactDefs.map((_,i)=>Math.max(0,Math.floor(Number(data.artifacts?.[i])||0)));
    s.expeditions=Math.max(0,Math.floor(Number(data.expeditions)||0));
    const has=id=>s.tree.includes(id);
    s.multiplier = () => (1 + s.achievements.length * .1) * (s.upgrades.includes('all2') ? 2 : 1) * (s.upgrades.includes('all3') ? 3 : 1) * 2**s.upgrades.filter(id=>id.startsWith('network')).length * (1+s.research*.5) * (has('scheduler')?2:1)*(has('parallel')?3:1)*(has('optical')?5:1)*(has('fusion')?8:1)*(has('archive')?10:1)*(1+s.artifacts.reduce((n,v,i)=>n+Math.log2(1+v)*(i+1)*.03,0)*(has('survey')?2:1));
    s.clickPower = () => (s.upgrades.includes('tap2') ? 2 : 1) * (s.upgrades.includes('tap10') ? 5 : 1) * s.multiplier()*(has('input')?10:1)*(has('combo')?25:1)*(has('resonance')?100:1);
    s.rate = () => minerItems.reduce((sum, item, i) => sum + item.rate * s.items[i] * (i === 0 && s.upgrades.includes('node2') ? 2 : 1), 0) * s.multiplier();
    s.cost = i => Math.ceil(minerItems[i].base * minerItems[i].growth ** s.items[i]);
    s.tap = () => { const n = s.clickPower(); s.energy += n; s.total += n; s.taps++; return s.check(); };
    s.tick = dt => { const n = s.rate() * clamp(dt, 0, 28800); s.energy += n; s.total += n; return s.check(); };
    s.buy = i => { const cost = s.cost(i); if (s.energy < cost || s.total < minerItems[i].unlock) return false; s.energy -= cost; s.items[i]++; s.check(); return true; };
    s.buyUpgrade = id => { const u = minerUpgrades.find(x => x.id === id); if (!u || s.upgrades.includes(id) || s.energy < u.cost || s.total < u.unlock) return false; s.energy -= u.cost; s.upgrades.push(id); s.check(); return true; };
    s.rebootGain = () => Math.floor(Math.sqrt(s.total/1e8));
    s.reboot = () => { const gain = s.rebootGain(); if (!gain) return false; s.shards+=gain; s.reboots++; s.energy=s.total=0; s.items=minerItems.map(()=>0); s.upgrades=[]; s.check(); return true; };
    s.researchCost = () => 2**Math.min(40,s.research);
    s.buyResearch = () => { const cost=s.researchCost(); if(s.shards<cost)return false; s.shards-=cost; s.research++; s.check(); return true; };
    s.unlockResearch=id=>{const r=researchTree.find(r=>r.id===id);if(!r||has(id)||s.shards<r.cost||!r.requires.every(has))return false;s.shards-=r.cost;s.tree.push(id);return true;};
    // Earned, deterministic exploration rewards; no paid/random loot boxes.
    s.expeditionCost=()=>1e6*4**Math.min(40,s.expeditions);
    s.explore=()=>{const cost=s.expeditionCost();if(s.energy<cost)return false;s.energy-=cost;const id=Math.min(4,Math.floor(s.expeditions/4));s.artifacts[id]+=has('salvage')?2:1;s.expeditions++;return artifactDefs[id];};
    s.check = () => { const before = s.achievements.length; for (const a of achievementDefs) if (!s.achievements.includes(a.id) && a.test(s)) s.achievements.push(a.id); return s.achievements.slice(before); };
    return s;
  }

  function snake(data={}) {
    const s={body:[{x:10,y:12},{x:9,y:12},{x:8,y:12}],direction:{x:1,y:0},queued:null,food:{x:15,y:12},score:0,best:0,elapsed:0,over:false};
    s.turn=(x,y)=>{if(s.queued||x===-s.direction.x&&y===-s.direction.y)return false;s.queued={x,y};return true;};
    s.placeFood=()=>{const occupied=new Set(s.body.map(p=>p.y*20+p.x));const free=[];for(let i=0;i<400;i++)if(!occupied.has(i))free.push(i);if(!free.length){s.over=true;return;}const cell=free[(s.score*73+17)%free.length];s.food={x:cell%20,y:Math.floor(cell/20)};};
    s.step=dt=>{if(s.over)return;s.elapsed+=clamp(dt,0,.05);const interval=Math.max(.065,.17-s.score*.002);if(s.elapsed<interval)return;s.elapsed-=interval;
      if(s.queued){s.direction=s.queued;s.queued=null;}const head={x:s.body[0].x+s.direction.x,y:s.body[0].y+s.direction.y};const eat=head.x===s.food.x&&head.y===s.food.y;
      const collision=s.body.slice(0,eat?s.body.length:-1).some(p=>p.x===head.x&&p.y===head.y);
      if(head.x<0||head.x>=20||head.y<0||head.y>=20||collision){s.over=true;return;}
      s.body.unshift(head);if(eat){s.score++;s.best=Math.max(s.best,s.score);s.placeFood();}else s.body.pop();
    };
    for(const key of ['body','direction','queued','food','score','best','elapsed','over'])if(Object.hasOwn(data,key))s[key]=JSON.parse(JSON.stringify(data[key]));
    return s;
  }

  function breakout(data = {}) {
    const s = { score: 0, best: 0, wave: 1, lives: 3, paddle: 180, ball: {x:180,y:468,vx:0,vy:0}, bricks: [], launched: false, over: false };
    s.build = () => { s.bricks = Array.from({length:35},(_,i)=>({x:17+(i%7)*47,y:60+Math.floor(i/7)*24,hp:1+Math.floor((s.wave-1)/3)})); };
    s.serve = () => { s.ball={x:s.paddle,y:468,vx:0,vy:0}; s.launched=false; };
    s.launch = () => { if(s.over||s.launched)return; s.launched=true; s.ball.vx=120; s.ball.vy=-Math.min(460,240+s.wave*15); };
    s.step = dt => {
      dt=clamp(dt,0,1/120); const b=s.ball;
      if(s.over)return;
      if(!s.launched){b.x=s.paddle;b.y=468;return;}
      const oldY=b.y; b.x+=b.vx*dt;b.y+=b.vy*dt;
      if(b.x<8){b.x=8;b.vx=Math.abs(b.vx);} if(b.x>352){b.x=352;b.vx=-Math.abs(b.vx);}
      if(b.y<8){b.y=8;b.vy=Math.abs(b.vy);}
      if(b.vy>0&&oldY<=474&&b.y>=474&&Math.abs(b.x-s.paddle)<47){
        b.y=474; const angle=clamp((b.x-s.paddle)/47,-.9,.9)*1.1,speed=Math.min(540,Math.hypot(b.vx,b.vy)+8); b.vx=Math.sin(angle)*speed;b.vy=-Math.cos(angle)*speed;
      }
      for(let i=0;i<s.bricks.length;i++) { const r=s.bricks[i]; if(b.x+7<r.x||b.x-7>r.x+43||b.y+7<r.y||b.y-7>r.y+18)continue;
        if(oldY+7<=r.y||oldY-7>=r.y+18)b.vy=-b.vy;else b.vx=-b.vx;
        r.hp--;if(!r.hp)s.bricks.splice(i,1);s.score+=10*s.wave;s.best=Math.max(s.best,s.score);break;
      }
      if(b.y>535){s.lives--;s.over=s.lives<=0;s.serve();}
      if(!s.bricks.length){s.wave++;s.lives=Math.min(5,s.lives+1);s.build();s.serve();}
    };
    s.build();
    for(const key of ['score','best','wave','lives','paddle','ball','bricks','launched','over']) if(Object.hasOwn(data,key))s[key]=JSON.parse(JSON.stringify(data[key]));
    return s;
  }

  const poolPockets = [[28,28],[320,25],[612,28],[28,372],[320,375],[612,372]];
  function pool(data = {}) {
    const s = { score: Number(data.score) || 0, best: Number(data.best) || 0, racks: Number(data.racks) || 0,
      shots: Number(data.shots) || 0, balls: [], moving: false, cuePocketed: false };
    s.rack = () => {
      s.balls = [{ id: 0, x: 175, y: 200, r: 10, vx: 0, vy: 0, cue: true }];
      let id = 1;
      for (let row = 0; row < 5; row++) for (let col = 0; col <= row; col++) {
        s.balls.push({ id: id++, x: 438 + row * 17.5, y: 200 + (col - row / 2) * 20.4, r: 10, vx: 0, vy: 0, cue: false });
      }
      s.moving = false; s.cuePocketed = false;
    };
    s.rack(); return s;
  }
  function poolStep(s, dt) {
    dt = clamp(dt, 0, 1 / 60);
    const live = s.balls;
    for (const b of live) {
      b.x += b.vx * dt; b.y += b.vy * dt;
      const damping = Math.exp(-1.15 * dt); b.vx *= damping; b.vy *= damping;
      if (Math.hypot(b.vx, b.vy) < 3) b.vx = b.vy = 0;
    }
    for (let pass = 0; pass < 2; pass++) for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
      const a = live[i], b = live[j], dx = b.x - a.x, dy = b.y - a.y, rr = a.r + b.r, d2 = dx * dx + dy * dy;
      if (d2 >= rr * rr) continue;
      const d = Math.sqrt(d2), nx = d > .001 ? dx / d : 1, ny = d > .001 ? dy / d : 0, overlap = rr - d;
      a.x -= nx * overlap / 2; a.y -= ny * overlap / 2; b.x += nx * overlap / 2; b.y += ny * overlap / 2;
      const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
      if (rel < 0) { const impulse = -rel * .97; a.vx -= impulse * nx; a.vy -= impulse * ny; b.vx += impulse * nx; b.vy += impulse * ny; }
    }
    for (const b of live) {
      const pocket = poolPockets.some(([x, y]) => Math.hypot(b.x - x, b.y - y) < 17);
      if (pocket) { b.pocketed = true; if (b.cue) s.cuePocketed = true; else { s.score++; s.best = Math.max(s.best, s.score); } continue; }
      if (b.x < 38) { b.x = 38; b.vx = Math.abs(b.vx) * .82; }
      if (b.x > 602) { b.x = 602; b.vx = -Math.abs(b.vx) * .82; }
      if (b.y < 38) { b.y = 38; b.vy = Math.abs(b.vy) * .82; }
      if (b.y > 362) { b.y = 362; b.vy = -Math.abs(b.vy) * .82; }
    }
    s.balls = live.filter(b => !b.pocketed);
    s.moving = s.balls.some(b => b.vx || b.vy);
    if (!s.moving && s.cuePocketed) {
      s.balls.unshift({ id: 0, x: 175, y: 200, r: 10, vx: 0, vy: 0, cue: true }); s.cuePocketed = false; s.score = Math.max(0, s.score - 1);
    }
    if (!s.moving && s.balls.every(b => b.cue)) { s.racks++; s.rack(); }
  }

  const api = { clamp, physics, tetris, factory, snake, breakout, pool, poolStep, poolPockets, shapes, minerItems, minerUpgrades, achievementDefs, researchTree, artifactDefs };
  if (node) module.exports = api;
  else Object.defineProperty(window, '__zroArcade', { value: api, configurable: true });
})();
