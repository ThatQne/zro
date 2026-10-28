const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const source = readFileSync(resolve(__dirname, '../src-tauri/src/browser/arcade_core.js'), 'utf8');
const context = { module: { exports: {} } };
vm.runInNewContext(source, context);
const { physics, tetris, factory, breakout, pool, poolStep, minerItems, minerUpgrades, achievementDefs } = context.module.exports;

test('arcade core exits immediately on websites', () => {
  const window = {};
  vm.runInNewContext(source, { location: { href: 'https://example.com/' }, window });
  assert.equal(window.__zroArcade, undefined);
});

test('circle solver is bounded, finite and clamps long frame gaps', () => {
  const bodies = Array.from({ length: 36 }, (_, i) => ({ x: 180, y: 90, vx: i % 2 ? 200 : -200, vy: 0, r: 14 }));
  for (let i = 0; i < 1200; i++) physics(bodies, 1 / 120, 360, 520, 850, .12, null, 12);
  for (const b of bodies) {
    assert.ok(Object.values(b).every(Number.isFinite));
    assert.ok(b.x >= 26 && b.x <= 334 && b.y >= 26 && b.y <= 494);
  }
  const a = { x: 100, y: 100, vx: 10, vy: 10, r: 15 }, b = { ...a };
  physics([a], 500, 360, 520); physics([b], 1 / 60, 360, 520); assert.deepEqual(a, b);
});

test('circle contacts fire once despite three stabilization passes', () => {
  const a = { x: 100, y: 100, vx: 100, vy: 0, r: 15 }, b = { x: 125, y: 100, vx: -100, vy: 0, r: 15 };
  let contacts = 0; physics([a, b], 1 / 120, 360, 520, 0, 1, () => contacts++);
  assert.equal(contacts, 1); assert.ok(a.vx < 0 && b.vx > 0); assert.ok(b.x - a.x >= 30 - 1e-6);
});

test('blocks honors starting level, uses a seven-piece bag and clears rows', () => {
  const game = tetris(() => .3, { startLevel: 6 }), types = [];
  assert.equal(game.level(), 6);
  for (let i = 0; i < 7; i++) { types.push(game.piece.type); game.spawn(); }
  assert.equal(new Set(types).size, 7);
  game.board[19].fill(1); game.board[19][9] = 0; game.piece = { matrix: [[1]], type: 1, x: 9, y: 0 };
  assert.equal(game.drop(), 1); assert.equal(game.lines, 1); assert.equal(game.score, 638); assert.equal(game.board.length, 20);
});

test('blocks rejects movement after game over and keeps live methods on hydration', () => {
  const game = tetris(); game.move(-1, 0); game.drop(); const saved = JSON.parse(JSON.stringify(game));
  const restored = tetris();
  for (const key of Object.keys(restored)) if (typeof restored[key] !== 'function' && Object.hasOwn(saved, key)) restored[key] = saved[key];
  assert.equal(typeof restored.move, 'function'); assert.equal(restored.move(0, 1), true);
  restored.board.forEach(row => row.fill(1)); restored.spawn(); assert.equal(restored.over, true);
  assert.equal(restored.move(0, 1), false); assert.equal(restored.rotate(), false); assert.equal(restored.drop(), 0);
});

test('miner has clear item progression, upgrades and achievement multipliers', () => {
  const game = factory(); assert.equal(minerItems.length, 15); assert.equal(minerUpgrades.length, 15); assert.equal(achievementDefs.length, 15);
  const unlocked = game.tap(); assert.ok(unlocked.includes('first')); assert.equal(game.achievements.length, 1);
  game.energy = game.total = 1000;
  assert.equal(game.buy(0), true); assert.equal(game.items[0], 1);
  const baseRate = game.rate(); assert.ok(baseRate > 1);
  assert.equal(game.buyUpgrade('node2'), true); assert.ok(game.rate() > baseRate);
  assert.equal(game.buy(4), false, 'locked tiers cannot be skipped');
});

test('miner restores exact state and caps offline production at eight hours', () => {
  const game = factory({ energy: 12, total: 50, taps: 7, items: [2,0,0,0,0], upgrades: ['tap2'], achievements: ['first'], lastSaved: 123 });
  assert.equal(game.energy, 12); assert.equal(game.items[0], 2); assert.equal(game.clickPower(), 2.2);
  const before = game.energy, rate = game.rate(); game.tick(999999); assert.ok(Math.abs((game.energy - before) - rate * 28800) < 1e-6);
});

test('pool resolves collisions, pockets balls and restores a scratched cue', () => {
  const game = pool(); assert.equal(game.balls.length, 16);
  const cue = game.balls.find(b => b.cue), target = game.balls.find(b => !b.cue);
  game.balls = [cue, target]; cue.x = 100; cue.y = 200; target.x = 119; target.y = 200; cue.vx = 300; target.vx = 0;
  poolStep(game, 1/120); assert.ok(target.vx > 0);
  target.x = 28; target.y = 28; target.vx = target.vy = 0; poolStep(game, 1/120);
  assert.equal(game.score, 1); assert.equal(game.balls.some(b => b.id === target.id), false);
  const liveCue = game.balls.find(b => b.cue); liveCue.x = 28; liveCue.y = 28; liveCue.vx = liveCue.vy = 0; poolStep(game, 1/120);
  assert.ok(game.balls.some(b => b.cue)); assert.equal(game.score, 0);
});

test('arcade hibernation snapshots remain bounded and use version two', () => {
  const capture = readFileSync(resolve(__dirname, '../src-tauri/src/browser/sleep_capture.js'), 'utf8');
  const snapshot = vm.runInNewContext(capture, {
    __zroNewTabDocument: true, location: { href: 'http://tauri.localhost/newtab.html' }, scrollX: 0, scrollY: 45,
    __zroArcadeSave: () => ({ version: 2, selected: 'factory', games: { factory: JSON.parse(JSON.stringify(factory())) } }),
  });
  assert.equal(snapshot.arcade.version, 2); assert.equal(snapshot.y, 45);
  assert.ok(Array.isArray(snapshot.forms) && Array.isArray(snapshot.scrollers)); assert.ok(JSON.stringify(snapshot).length < 32768);
});

test('hold can be used once per piece and persists through snapshots', () => {
  const s=tetris(()=>.5), type=s.piece.type;
  assert.equal(s.hold(),true);assert.equal(s.held,type-1);assert.equal(s.hold(),false);
  s.drop();assert.equal(s.holdUsed,false);assert.equal(s.hold(),true);assert.equal(s.piece.type,type);
  const data=JSON.parse(JSON.stringify(s)), restored=tetris();Object.assign(restored,data);
  assert.equal(restored.held,s.held);assert.equal(restored.holdUsed,true);assert.equal(restored.hold(),false);
});

test('miner migrates five-item saves and reboots only earned run production', () => {
  const s=factory({items:[4,3,2,1,1],energy:1e8,total:1e8});
  assert.equal(s.items.length,15);assert.ok(Number.isFinite(s.rate()));
  assert.equal(s.reboot(),true);assert.equal(s.shards,1);assert.equal(s.total,0);assert.equal(s.reboot(),false);
  assert.equal(s.buyResearch(),true);assert.equal(s.shards,0);assert.equal(s.research,1);
  const restored=factory(JSON.parse(JSON.stringify(s)));assert.equal(restored.research,1);assert.equal(restored.reboots,1);
  assert.equal(restored.buyResearch(),false);
});

test('Breakout loses lives, advances waves, and restores without resetting progress', () => {
  const s=breakout();s.launch();s.ball.y=540;s.step(1/120);assert.equal(s.lives,2);assert.equal(s.launched,false);
  s.bricks=[];s.launch();s.step(1/120);assert.equal(s.wave,2);assert.equal(s.lives,3);assert.equal(s.bricks.length,35);
  s.score=123;const restored=breakout(JSON.parse(JSON.stringify(s)));assert.equal(restored.score,123);assert.equal(restored.wave,2);
  s.lives=1;s.launch();s.ball.y=540;s.step(1/120);assert.equal(s.over,true);s.launch();assert.equal(s.launched,false);
});

test('snake rejects reversal, grows, detects walls, and restores the trail',()=>{
  const {snake}=context.module.exports,s=snake();
  assert.equal(s.turn(-1,0),false);assert.equal(s.turn(0,-1),true);assert.equal(s.turn(0,1),false);
  for(let i=0;i<4;i++)s.step(.05);assert.equal(s.body[0].y,11);
  s.food={x:10,y:10};for(let i=0;i<4;i++)s.step(.05);assert.equal(s.score,1);assert.equal(s.body.length,4);
  const restored=snake(JSON.parse(JSON.stringify(s)));assert.equal(JSON.stringify(restored.body),JSON.stringify(s.body));
  for(let i=0;i<100;i++)restored.step(.05);assert.equal(restored.over,true);
});

test('miner research prerequisites and artifact progression survive reboot',()=>{
  const s=factory({energy:1e20,total:1e20,shards:100});
  assert.equal(s.unlockResearch('fusion'),false);assert.equal(s.unlockResearch('scheduler'),true);
  assert.equal(s.unlockResearch('parallel'),true);assert.equal(s.unlockResearch('parallel'),false);
  const before=s.rate();s.items[0]=1;assert.ok(s.rate()>before);
  assert.equal(s.explore(),'Signal chip');assert.equal(s.artifacts[0],1);assert.equal(s.expeditions,1);
  s.reboot();assert.equal(s.artifacts[0],1);assert.ok(s.tree.includes('parallel'));
  const restored=factory(JSON.parse(JSON.stringify(s)));assert.equal(restored.expeditions,1);assert.equal(restored.tree.length,2);
});
