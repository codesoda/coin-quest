/* Tests run the shipped native core, never a substitute physics model.
 * Only isolated collision fixtures place objects. Traversal writes inputs only. */
'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { Game, FixedClock, Controls, STEP } = require('../web/core.js');
const root = path.resolve(__dirname, '..');
const data = { version: 1, levels: JSON.parse(fs.readFileSync(path.join(root, 'assets/levels.json'), 'utf8')) };
function fresh() { const g = new Game(data); g.restart(); g.step(); return g; }
function ticks(g, n, input = {}) { for (let i = 0; i < n; i++) g.step(input); }
function place(g, x, y = -112, extra = {}) {
  Object.assign(g.player, { x, y, vx: 0, vy: 0, grounded: true, coyote: 4,
    jumpHeld: false, jumpBuffer: 0, invulnerable: 0, ...extra });
  g.snap();
}
const airborne = { grounded: false, coyote: 0 };
function firstBlock(g) { return g.level.geometry.find(x => x.kind === 'bonus_block'); }

test('exports a browser-independent game with the three real layouts', () => {
  assert.equal(STEP, 1 / 60);
  const g = new Game(data);
  assert.equal(g.state, 'title');
  assert.deepEqual(data.levels.map(l => l.theme), ['grassland', 'underground', 'castle']);
  g.instructions(); assert.equal(g.state, 'instructions');
  g.closeInstructions(); assert.equal(g.state, 'title');
  g.restart(); assert.equal(g.state, 'play');
  assert.throws(() => new Game({ version: 2, levels: [] }), /data/);
});
test('controls map aliases, reject repeats, retain other aliases, and release cleanly', () => {
  const c = new Controls();
  assert.equal(c.press('KeyD'), true); assert.equal(c.press('KeyD'), false);
  c.press('ArrowRight'); c.release('KeyD'); assert.equal(c.sample().right, true);
  c.press('Space'); c.press('ArrowUp'); c.release('Space'); assert.equal(c.sample().jump, true);
  c.press('KeyA'); assert.equal(c.sample().left, true);
  c.clear(); assert.deepEqual(c.sample(), { left: false, right: false, jump: false });
});
test('movement accelerates, caps at four, brakes on release and with opposed keys', () => {
  const g = fresh(); g.step({ right: true }); assert.equal(g.player.vx, .65);
  ticks(g, 7, { right: true }); assert.equal(g.player.vx, 4);
  g.step({ right: true, left: true }); assert.equal(g.player.vx, 3);
  ticks(g, 25, { right: true, left: true }); assert.equal(g.player.vx, 0);
  ticks(g, 8, { left: true }); assert.equal(g.player.vx, -4); assert.equal(g.player.face, -1);
  ticks(g, 20); assert.equal(g.player.vx, 0);
});
test('camera and world edges clamp; transform history captures the previous tick', () => {
  const g = fresh(); place(g, 11); ticks(g, 10, { left: true });
  assert.equal(g.player.x, 10); assert.equal(g.camera, 0);
  place(g, 2400, 90); g.step(); assert.equal(g.camera, 2080);
  place(g, 800, 90); g.step({ right: true });
  assert.equal(g.player.prevX, 800); assert.equal(g.prevCamera, 620);
  assert.ok(Math.abs(g.camera - 620.65) < 1e-6);
});
test('tap jumps are shorter than held jumps; held jump never auto-repeats', () => {
  function height(hold) {
    const g = fresh(); let high = -112;
    for (let i = 0; i < 60; i++) { g.step({ jump: i < hold }); high = Math.max(high, g.player.y); }
    assert.equal(g.player.grounded, true); assert.equal(g.player.y, -112);
    return high;
  }
  const short = height(1), full = height(60);
  assert.ok(full - short > 55, `${short} vs ${full}`);
  assert.ok(full > -15 && full < -5, `full jump top ${full}`);
});
test('coyote jump works inside four ticks and expires outside the window', () => {
  for (const wait of [0, 4]) {
    const g = fresh(); place(g, 639);
    while (g.player.grounded) g.step({ right: true });
    ticks(g, wait, { right: true });
    g.step({ right: true, jump: true });
    if (!wait) assert.ok(g.player.vy > 10);
    else assert.ok(g.player.vy < 0);
  }
});
test('jump buffering triggers after landing, but an old buffer expires', () => {
  const g = fresh(); place(g, 80, -103, { ...airborne, vy: -4 });
  g.step({ jump: true }); assert.ok(g.player.jumpBuffer > 0); assert.ok(g.player.vy < 0);
  g.step({ jump: true }); assert.equal(g.player.grounded, true);
  g.step({ jump: true }); assert.ok(g.player.vy > 10); assert.equal(g.player.jumpBuffer, 0);
  place(g, 80, 30, { ...airborne, vy: -1 });
  ticks(g, 40, { jump: true }); assert.equal(g.player.y, -112); assert.equal(g.player.vy, 0);
});
test('X collision stops at platform side and numerical Y landing does not sink', () => {
  const g = fresh(); place(g, 371, -56, { ...airborne, vx: 4 });
  g.step({ right: true }); assert.equal(g.player.x, 374); assert.equal(g.player.vx, 0);
  place(g, 432, 8, { ...airborne, vy: -8 }); ticks(g, 10);
  assert.equal(g.player.y, -32); assert.equal(g.player.vy, 0); assert.equal(g.player.grounded, true);
});
test('swept collisions catch thin floors, ceilings and walls instead of tunneling', () => {
  const g = fresh();
  g.level.geometry = [{ x: 60, y: -103, w: 40, h: 1, kind: 'platform' }];
  place(g, 80, -100, { ...airborne, vy: -12 }); g.step();
  assert.equal(g.player.y, -102); assert.equal(g.player.grounded, true);
  g.level.geometry = [{ x: 60, y: -70, w: 40, h: 1, kind: 'platform' }];
  place(g, 80, -100, { ...airborne, vy: 11.8, jumpHeld: true }); g.step({ jump: true });
  assert.equal(g.player.y, -98); assert.equal(g.player.vy, 0);
  g.level.geometry = [{ x: 92, y: -112, w: 1, h: 40, kind: 'platform' }];
  place(g, 80, -112, { vx: 4 }); g.step({ right: true }); assert.equal(g.player.x, 82);
});
test('head bump activates the existing indexed acorn exactly once', () => {
  const g = fresh(), bonus = firstBlock(g);
  place(g, 272, -90, { ...airborne, vy: 11, jumpHeld: true }); g.step({ jump: true });
  assert.equal(g.player.y, -84); assert.equal(g.player.vy, 0);
  assert.equal(bonus.state, 1); assert.equal(g.level.powers[bonus.power - 1].state, 1);
  assert.equal(g.score, 50);
  place(g, 272, -90, { ...airborne, vy: 11, jumpHeld: true }); g.step({ jump: true });
  assert.equal(g.score, 50);
});
test('keyboard-only block hit and following the falling acorn cause growth', () => {
  const g = fresh(); ticks(g, 47, { right: true }); ticks(g, 18);
  assert.ok(g.player.x > 256 && g.player.x < 288);
  for (let i = 0; i < 12 && g.level.powers[0].state === -1; i++) g.step({ jump: true });
  for (let i = 0; i < 140 && !g.player.grown; i++) {
    const distance = g.level.powers[0].x - g.player.x;
    g.step({ right: distance > 4, left: distance < -4 });
  }
  assert.equal(g.player.grown, true); assert.equal(g.player.height, 42); assert.equal(g.player.half, 14);
  assert.equal(g.level.powers[0].state, 0); assert.equal(g.lives, 3); assert.equal(g.score, 270);
});
test('coins collect once for ten points', () => {
  const g = fresh(); place(g, 144); ticks(g, 5);
  assert.equal(g.coins, 1); assert.equal(g.score, 10); assert.equal(g.level.coins[0].state, 0);
});
test('active acorns move, fall, land numerically, and award 200 for growth', () => {
  const g = fresh(), power = g.level.powers[0];
  Object.assign(power, { state: 1, x: 320, y: -60, vy: 0 });
  place(g, 340); ticks(g, 15);
  assert.equal(g.player.grown, true); assert.equal(g.score, 200); assert.equal(power.state, 0);
  const h = fresh(), p = h.level.powers[0];
  Object.assign(p, { state: 1, x: 320, y: -60, vy: 0 }); ticks(h, 40);
  assert.ok(p.x > 360); assert.equal(p.y, -112); assert.equal(p.vy, 0);
});
test('growth is blocked by a low ceiling and remains available for later', () => {
  const g = fresh(); place(g, 272);
  Object.assign(g.level.powers[0], { state: 1, x: 272, y: -112 });
  g.level.geometry.push({ x: 240, y: -80, w: 64, h: 16, kind: 'platform' });
  g.step(); assert.equal(g.player.grown, false); assert.equal(g.player.height, 28);
  assert.equal(g.level.powers[0].state, 1); assert.equal(g.score, 0);
  g.level.geometry.pop(); g.step(); assert.equal(g.player.grown, true); assert.equal(g.score, 200);
});
test('descending prior feet above enemy top stomps and bounces for 100', () => {
  const g = fresh(); place(g, g.level.enemies[0].x, -85, { ...airborne, vy: -5 }); g.step({ jump: true });
  assert.equal(g.level.enemies[0].state, 0); assert.equal(g.lives, 3);
  assert.equal(g.player.y, -88); assert.equal(g.player.vy, 7.5); assert.equal(g.score, 100);
});
test('rising and low descending side contact cause damage, not a stomp', () => {
  for (const vy of [5, -5]) {
    const g = fresh(); place(g, g.level.enemies[0].x, -108, { ...airborne, vy }); g.step({ jump: true });
    assert.equal(g.level.enemies[0].state, 1); assert.equal(g.lives, 2); assert.equal(g.player.x, 80);
  }
});
test('patrols stay in bounds and reverse at their ends', () => {
  const g = fresh(); ticks(g, 1000);
  for (const e of g.level.enemies) assert.ok(e.x >= e.lo && e.x <= e.hi);
  const e = g.level.enemies[0]; e.x = e.hi - .2; e.dir = 1; g.step();
  assert.equal(e.x, e.hi); assert.equal(e.dir, -1);
});
test('growth absorbs a hit and invulnerability expires after 60 ticks', () => {
  const g = fresh(); place(g, g.level.enemies[0].x, -112, { grown: true, half: 14, height: 42 }); g.step();
  assert.equal(g.lives, 3); assert.equal(g.player.grown, false); assert.equal(g.player.invulnerable, 60);
  place(g, g.level.enemies[0].x, -112, { invulnerable: 60 }); g.step(); assert.equal(g.lives, 3);
  place(g, 80, -112, { invulnerable: 59 }); ticks(g, 59); assert.equal(g.player.invulnerable, 0);
  place(g, g.level.enemies[0].x); g.step(); assert.equal(g.lives, 2);
});
test('spikes hurt; falling loses a life even when grown and invulnerable', () => {
  const g = fresh(); place(g, g.level.spikes[0].x + 16); g.step(); assert.equal(g.lives, 2);
  place(g, 672, -240, { ...airborne, invulnerable: 60, grown: true }); g.step();
  assert.equal(g.lives, 1); assert.equal(g.player.grown, false);
});
test('checkpoint gives 100 once; respawn preserves coins, blocks, enemies and powers', () => {
  const g = fresh(); place(g, 144); g.step();
  firstBlock(g).state = 1; g.level.enemies[0].state = 0; g.level.powers[0].state = 0;
  place(g, 1250); g.step(); assert.equal(g.checkpointActive, true); assert.equal(g.score, 110);
  g.step(); assert.equal(g.score, 110);
  place(g, 1500, -240, airborne); g.step();
  assert.equal(g.player.x, 1248); assert.equal(g.player.y, -112); assert.equal(g.player.vx, 0);
  assert.equal(g.level.coins[0].state, 0); assert.equal(firstBlock(g).state, 1);
  assert.equal(g.level.enemies[0].state, 0); assert.equal(g.level.powers[0].state, 0);
  assert.equal(g.player.prevX, 1248); assert.equal(g.prevCamera, g.camera);
});
test('life loss suppresses held jump until release, then a fresh jump works', () => {
  const g = fresh(); place(g, 672, -240, airborne); g.step({ jump: true });
  ticks(g, 8, { jump: true }); assert.equal(g.player.y, -112); assert.equal(g.player.vy, 0);
  g.step(); g.step({ jump: true }); assert.ok(g.player.vy > 10);
});
test('three lost lives reach gameover; restart resets all state and source data stays pristine', () => {
  const before = JSON.stringify(data.levels), g = fresh();
  place(g, 144); g.step(); firstBlock(g).state = 1;
  for (let i = 0; i < 3; i++) { place(g, 672, -240, airborne); g.step(); }
  assert.equal(g.state, 'gameover'); assert.equal(g.lives, 0);
  const frame = g.frame; ticks(g, 10); assert.equal(g.frame, frame);
  g.restart(); assert.equal(g.state, 'play'); assert.equal(g.lives, 3); assert.equal(g.score, 0);
  assert.equal(g.coins, 0); assert.equal(g.levelIndex, 0); assert.equal(g.frame, 0);
  assert.equal(g.level.coins[0].state, 1); assert.equal(firstBlock(g).state, 0);
  assert.equal(JSON.stringify(data.levels), before);
});
test('goals award 500, reload next-level data, show transitions and finish in victory', () => {
  const g = fresh();
  for (let i = 0; i < 3; i++) {
    assert.equal(g.levelIndex, i); g.level.coins[0].state = 0;
    place(g, 2500, 20); g.step();
    if (i < 2) {
      assert.equal(g.state, 'transition'); assert.equal(g.player.x, 80);
      assert.equal(g.level.coins[0].state, 1); assert.equal(g.checkpointActive, false);
      ticks(g, 74); assert.equal(g.state, 'transition');
      g.step(); assert.equal(g.state, 'play');
    }
  }
  assert.equal(g.state, 'victory'); assert.equal(g.score, 1800);
  g.restart(); assert.equal(g.state, 'play'); assert.equal(g.levelIndex, 0);
});
test('pause/help freeze simulation and resume without held movement or clock backlog', () => {
  const g = fresh(), c = new Controls(), clock = new FixedClock(); c.press('KeyD');
  clock.advance(0, () => g.step(c.sample())); clock.advance(100, () => g.step(c.sample()));
  g.pause(); c.clear(); clock.reset();
  const before = JSON.stringify(g.player), frame = g.frame;
  ticks(g, 60, { right: true }); assert.equal(JSON.stringify(g.player), before); assert.equal(g.frame, frame);
  clock.advance(50000, () => g.step(c.sample()), false); assert.equal(clock.last, null);
  g.instructions(); assert.equal(g.state, 'instructions'); g.closeInstructions(); assert.equal(g.state, 'paused');
  g.resume(); clock.advance(60000, () => g.step(c.sample())); assert.equal(g.frame, frame);
  clock.advance(60000 + 1000 / 60, () => g.step(c.sample())); assert.equal(g.frame, frame + 1);
  assert.equal(c.sample().right, false); assert.ok(g.player.vx < 4);
});
test('a fresh jump immediately after resume is not swallowed', () => {
  const g = fresh(); g.pause(); g.resume(); g.step({ jump: true });
  assert.ok(g.player.vy > 10);
});
test('fixed accumulator produces identical input-driven states at 30, 60, 120, 144 Hz and uneven frames', () => {
  function run(deltas) {
    const g = fresh(), clock = new FixedClock(); let time = 0, frame = 0;
    const update = () => {
      const t = g.frame;
      g.step({ right: t < 28 || (t >= 75 && t < 120), left: t >= 160 && t < 210, jump: t >= 12 && t < 45 });
    };
    clock.advance(0, update);
    while (time < 4000 - 1e-7) {
      time = Math.min(4000, time + deltas[frame++ % deltas.length]); clock.advance(time, update);
    }
    assert.equal(g.frame, 241);
    return JSON.stringify({ p: g.player, level: g.level, coins: g.coins, lives: g.lives, score: g.score, camera: g.camera });
  }
  const expected = run([1000 / 60]);
  for (const deltas of [[1000 / 30], [1000 / 120], [1000 / 144], [4, 19, 7, 25, 11]]) assert.equal(run(deltas), expected);
});
test('clock caps stalls at eight ticks and resets on inactivity, bad timestamp and stop', () => {
  const clock = new FixedClock(); let count = 0;
  clock.advance(0, () => count++); assert.equal(clock.advance(60000, () => count++), 8);
  assert.equal(count, 8); assert.ok(clock.alpha < 1);
  clock.advance(60001, () => count++); assert.equal(count, 8);
  clock.advance(70000, () => count++, false); clock.advance(80000, () => count++); assert.equal(count, 8);
  clock.advance(NaN, () => count++); assert.equal(clock.last, null);
  clock.advance(0, () => count++); clock.advance(100, () => { count++; return false; });
  assert.equal(count, 9); assert.equal(clock.accumulator, 0); assert.equal(clock.last, null);
});

// Deterministic state-reading driver: equivalent to choosing held keys. No
// teleport, geometry edits, invincibility, checkpoint changes, or direct writes.
function traversal() {
  const g = fresh(), keys = new Controls();
  let jumpTicks = 0, landingTarget = null, crossingGap = false;
  let lastLevel = 0, lastX = 0, stuck = 0;
  const visited = new Set([0]);
  for (let n = 0; n < 6000 && g.state !== 'victory'; n++) {
    if (g.state === 'transition') { keys.clear(); g.step(keys.sample()); continue; }
    assert.equal(g.state, 'play');
    const p = g.player, { x, y } = p, level = g.level;
    if (g.levelIndex !== lastLevel) {
      visited.add(g.levelIndex); lastLevel = g.levelIndex;
      jumpTicks = 0; landingTarget = null; crossingGap = false;
    }
    let jump = false;
    if (p.grounded && !keys.sample().jump) {
      landingTarget = null;
      const gap = level.gaps.find(([left]) => left - x < 28 && left - x > -10);
      jump = Boolean(gap); crossingGap = Boolean(gap);
      if (gap && level.spikes.some(s => s.x >= gap[1] && s.x - gap[1] <= 96)) landingTarget = gap[1] + 12;
      jump ||= level.spikes.some(s => s.x - x < 48 && s.x - x > -32 && y < s.y + 20);
      jump ||= level.enemies.some(e => e.state === 1 && e.x - x < 56 && e.x - x > -12 && y < e.y + 24);
      jump ||= level.geometry.some(r => ['platform', 'bonus_block'].includes(r.kind) && r.x - x < 48 &&
        r.x - x > 0 && y < r.y + r.h && r.y + r.h - y <= 101);
    }
    if (jump) jumpTicks = 38;
    else if (p.grounded && jumpTicks < 25) jumpTicks = 0;
    if (jumpTicks-- > 0) keys.press('Space'); else keys.release('Space');
    const waitBeforeGap = !crossingGap && !p.grounded && level.gaps.some(([left]) => left - x < 44 && left - x > 0);
    const waitBeforePlatform = !p.grounded && p.vy < 0 && level.geometry.some(r => r.kind === 'platform' &&
      r.x - x < 44 && r.x - x > 0 && r.y + r.h > y && r.y + r.h <= -11);
    if (!waitBeforeGap && !waitBeforePlatform && (landingTarget === null || x < landingTarget - 12)) keys.press('KeyD');
    else keys.release('KeyD');
    g.step(keys.sample());
    assert.equal(g.lives, 3, `Traversal damage: level=${lastLevel + 1} x=${x} y=${y} tick=${g.frame}`);
    assert.equal(g.player.invulnerable, 0, 'Traversal never needs damage protection');
    stuck = Math.abs(x - lastX) < .1 ? stuck + 1 : 0;
    assert.ok(stuck < 100, `Traversal stuck at level=${lastLevel + 1} x=${x} y=${y}`);
    lastX = x;
  }
  assert.deepEqual([...visited], [0, 1, 2]); assert.equal(g.state, 'victory'); assert.equal(g.lives, 3);
  return { ticks: g.frame, coins: g.coins, score: g.score, lives: g.lives, state: g.state };
}
test('input-only traversal crosses all three real layouts without teleports or invincibility', t => {
  const result = traversal(); assert.deepEqual(traversal(), result);
  t.diagnostic(JSON.stringify(result));
});
