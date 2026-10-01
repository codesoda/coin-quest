/* Coin Quest native simulation. Coordinates are world pixels, +Y up.
 * Velocities retain the original per-tick constants at a fixed 60 Hz.
 * No DOM, rendering, wall clock, or random numbers in this module. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CoinQuestCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const STEP = 1 / 60;
  const EPS = 1e-7;
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const overlaps = (x, y, half, height, rect) =>
    x + half > rect.x + EPS && x - half < rect.x + rect.w - EPS &&
    y + height > rect.y + EPS && y < rect.y + rect.h - EPS;
  const horizontal = (x, half, rect) =>
    x + half > rect.x + EPS && x - half < rect.x + rect.w - EPS;

  // Timestamp is requestAnimationFrame's milliseconds. Never feed variable dt
  // into physics. Dropped stall time cannot become a later catch-up backlog.
  class FixedClock {
    constructor(maxSteps = 8) {
      this.maxSteps = maxSteps;
      this.reset();
    }
    reset() { this.last = null; this.accumulator = 0; this.alpha = 0; }
    advance(timestamp, tick, active = true) {
      if (!active || !Number.isFinite(timestamp)) { this.reset(); return 0; }
      if (this.last === null) { this.last = timestamp; return 0; }
      const elapsed = clamp((timestamp - this.last) / 1000, 0, STEP * this.maxSteps);
      this.last = timestamp;
      this.accumulator = Math.min(this.accumulator + elapsed, STEP * this.maxSteps);
      let steps = 0;
      while (this.accumulator + EPS >= STEP && steps < this.maxSteps) {
        this.accumulator = Math.max(0, this.accumulator - STEP);
        steps++;
        // Returning false stops immediately on a menu/pause boundary.
        if (tick() === false) { this.reset(); return steps; }
      }
      this.alpha = this.accumulator / STEP;
      return steps;
    }
  }

  class Controls {
    constructor() {
      this.held = new Set();
      this.input = { left: false, right: false, jump: false };
    }
    press(code) {
      if (this.held.has(code)) return false;
      this.held.add(code);
      return true;
    }
    release(code) { this.held.delete(code); }
    clear() { this.held.clear(); this.sample(); }
    sample() {
      const h = this.held, i = this.input;
      i.left = h.has('ArrowLeft') || h.has('KeyA') || h.has('TouchLeft');
      i.right = h.has('ArrowRight') || h.has('KeyD') || h.has('TouchRight');
      i.jump = h.has('Space') || h.has('ArrowUp') || h.has('TouchJump');
      return i;
    }
  }

  class Game {
    constructor(data) {
      if (!data || data.version !== 1 || !Array.isArray(data.levels) || !data.levels.length) {
        throw new Error('Missing or unsupported Coin Quest level data.');
      }
      this.data = data;
      this.events = [];
      this.restart();
      this.state = 'title';
    }
    emit(name) { if (this.events.length < 64) this.events.push(name); }
    restart() {
      this.lives = 3;
      this.coins = 0;
      this.score = 0;
      this.frame = 0;
      this.events.length = 0;
      this.loadLevel(0);
      this.player.jumpHeld = false;
      this.state = 'play';
    }
    loadLevel(index) {
      this.levelIndex = index;
      // Direct, mutable objects; the exported source data is never modified.
      this.level = JSON.parse(JSON.stringify(this.data.levels[index]));
      this.checkpointActive = false;
      this.checkpoint = { ...this.level.spawn };
      this.player = { x: 0, y: 0, prevX: 0, prevY: 0, vx: 0, vy: 0,
        half: 10, height: 28, grown: false, grounded: false, face: 1,
        coyote: 0, jumpBuffer: 0, jumpHeld: true, invulnerable: 0 };
      this.respawn();
      this.player.invulnerable = 0;
      for (const e of this.level.enemies) { e.prevX = e.x; e.prevY = e.y; }
      for (const p of this.level.powers) { p.prevX = p.x; p.prevY = p.y; }
      this.transitionTicks = 0;
    }
    followCamera() {
      this.camera = clamp(this.player.x - 180, 0, Math.max(0, this.level.length - 480));
    }
    snap() {
      const p = this.player;
      p.prevX = p.x; p.prevY = p.y;
      this.followCamera(); this.prevCamera = this.camera;
      for (const entity of this.level.enemies) { entity.prevX = entity.x; entity.prevY = entity.y; }
      for (const entity of this.level.powers) { entity.prevX = entity.x; entity.prevY = entity.y; }
    }
    respawn() {
      const p = this.player;
      Object.assign(p, { x: this.checkpoint.x, y: this.checkpoint.y, vx: 0, vy: 0,
        half: 10, height: 28, grown: false, grounded: false, face: 1,
        coyote: 0, jumpBuffer: 0, jumpHeld: true, invulnerable: 60 });
      this.snap();
      this.respawned = true;
    }
    loseLife() {
      this.lives--;
      this.player.grown = false; this.player.half = 10; this.player.height = 28;
      this.emit('damage');
      if (this.lives <= 0) {
        this.state = 'gameover';
        this.player.vx = this.player.vy = 0;
        this.emit('gameover');
      } else this.respawn();
    }
    damage() {
      const p = this.player;
      if (p.invulnerable) return;
      if (p.grown) {
        p.grown = false; p.half = 10; p.height = 28;
        p.invulnerable = 60; p.vy = 4; p.vx = -2 * p.face;
        this.emit('damage');
      } else this.loseLife();
    }
    pause() {
      if (this.state !== 'play' && this.state !== 'transition') return false;
      this.resumeState = this.state;
      this.state = 'paused';
      this.player.jumpBuffer = 0;
      this.player.jumpHeld = true;
      this.snap();
      return true;
    }
    resume() {
      if (this.state !== 'paused') return false;
      this.state = this.resumeState;
      // The UI clears held controls on pause/resume. A new press can jump on
      // the very first resumed tick, rather than waiting for a release tick.
      this.player.jumpHeld = false;
      return true;
    }
    instructions() {
      if (this.state === 'play' || this.state === 'transition') this.pause();
      if (this.state !== 'instructions') {
        this.instructionsReturn = this.state;
        this.state = 'instructions';
      }
    }
    closeInstructions() {
      if (this.state === 'instructions') this.state = this.instructionsReturn || 'title';
    }
    activateBlock(g) {
      if (g.kind !== 'bonus_block' || g.state !== 0) return;
      g.state = 1;
      const power = this.level.powers[g.power - 1];
      if (power) { power.state = 1; power.vy = 3; }
      this.score += 50;
      this.emit('powerup');
    }
    moveX() {
      const p = this.player, old = p.x, target = p.x + p.vx;
      let next = target;
      for (const g of this.level.geometry) {
        if (p.y + p.height <= g.y + EPS || p.y >= g.y + g.h - EPS) continue;
        if (p.vx > 0 && old + p.half <= g.x + EPS && target + p.half > g.x) {
          next = Math.min(next, g.x - p.half);
        } else if (p.vx < 0 && old - p.half >= g.x + g.w - EPS && target - p.half < g.x + g.w) {
          next = Math.max(next, g.x + g.w + p.half);
        }
      }
      p.x = clamp(next, p.half, this.level.length - p.half);
      if (Math.abs(p.x - target) > EPS) p.vx = 0;
    }
    moveY() {
      const p = this.player, old = p.y, target = old + p.vy;
      let next = target, hit = null;
      p.grounded = false;
      for (const g of this.level.geometry) {
        if (!horizontal(p.x, p.half, g)) continue;
        const top = g.y + g.h;
        if (p.vy < 0 && old >= top - EPS && target <= top && top >= next) {
          next = top; hit = g;
        } else if (p.vy > 0 && old + p.height <= g.y + EPS && target + p.height >= g.y && g.y - p.height <= next) {
          next = g.y - p.height; hit = g;
        }
      }
      p.y = next;
      if (hit) {
        if (p.vy < 0) p.grounded = true;
        else this.activateBlock(hit);
        p.vy = 0;
      }
    }
    moveEnemies() {
      const p = this.player;
      for (const e of this.level.enemies) {
        e.prevX = e.x; e.prevY = e.y;
        if (e.state !== 1) continue;
        e.x += e.dir * 1.1;
        if (e.x >= e.hi) { e.x = e.hi; e.dir = -1; }
        if (e.x <= e.lo) { e.x = e.lo; e.dir = 1; }
        if (Math.abs(p.x - e.x) >= p.half + 12 || p.y + p.height <= e.y) continue;
        const top = e.y + 24;
        if (p.vy < 0 && p.prevY >= top - EPS && p.y <= top) {
          e.state = 0;
          p.y = top; p.vy = 7.5; p.grounded = false;
          this.score += 100; this.emit('stomp');
        } else if (p.y < top) this.damage();
        if (this.respawned || this.state !== 'play') return;
      }
    }
    pickups() {
      const p = this.player;
      for (const coin of this.level.coins) {
        if (coin.state === 1 && Math.abs(p.x - coin.x) < p.half + 8 &&
            p.y + p.height > coin.y && p.y < coin.y + 16) {
          coin.state = 0; this.coins++; this.score += 10; this.emit('coin');
        }
      }
      for (const power of this.level.powers) {
        power.prevX = power.x; power.prevY = power.y;
        if (power.state !== 1) continue;
        power.x += power.dir * 1.2;
        power.vy = Math.max(-10, power.vy - 0.5);
        let next = power.y + power.vy;
        if (power.vy < 0) {
          for (const g of this.level.geometry) {
            const top = g.y + g.h;
            if (horizontal(power.x, 10, g) && power.y >= top - EPS && next <= top) {
              next = top;
            }
          }
          if (next > power.y + power.vy) power.vy = 0;
        }
        power.y = next;
        if (power.y < -230) { power.state = 0; continue; }
        if (Math.abs(p.x - power.x) < p.half + 10 && p.y + p.height > power.y && p.y < power.y + 20 &&
            !this.level.geometry.some(g => overlaps(p.x, p.y, 14, 42, g))) {
          power.state = 0; p.grown = true; p.half = 14; p.height = 42;
          this.score += 200; this.emit('grow');
        }
      }
    }
    step(input = {}) {
      if (this.state === 'transition') {
        // A held jump must be released before the next level starts.
        this.player.jumpHeld = !!input.jump;
        if (--this.transitionTicks <= 0) this.state = 'play';
        return;
      }
      if (this.state !== 'play') return;
      const p = this.player;
      this.respawned = false;
      this.frame++;
      this.prevCamera = this.camera;
      p.prevX = p.x; p.prevY = p.y;
      if (p.invulnerable > 0) p.invulnerable--;
      const direction = Number(!!input.right) - Number(!!input.left);
      if (direction) { p.vx += direction * 0.65; p.face = direction; }
      else p.vx *= 0.75;
      p.vx = clamp(p.vx, -4, 4);
      if (Math.abs(p.vx) < 0.08) p.vx = 0;
      p.coyote = p.grounded ? 4 : Math.max(0, p.coyote - 1);
      p.jumpBuffer = Math.max(0, p.jumpBuffer - 1);
      if (input.jump && !p.jumpHeld) p.jumpBuffer = 4;
      if (p.jumpBuffer > 0 && p.coyote > 0) {
        p.vy = 11.8; p.grounded = false; p.coyote = 0; p.jumpBuffer = 0;
        this.emit('jump');
      }
      if (!input.jump && p.vy > 4) p.vy = 4;
      p.jumpHeld = !!input.jump;
      p.vy = Math.max(-12, p.vy - 0.65);
      this.moveX();
      this.moveY();
      if (p.y < -230) { this.loseLife(); return; }
      this.moveEnemies();
      if (this.respawned || this.state !== 'play') return;
      this.pickups();
      for (const spike of this.level.spikes) {
        if (overlaps(p.x, p.y, p.half, p.height, spike)) this.damage();
        if (this.respawned || this.state !== 'play') return;
      }
      if (!this.checkpointActive && p.x > this.level.checkpoint.x) {
        this.checkpointActive = true;
        Object.assign(this.checkpoint, this.level.checkpoint);
        this.score += 100; this.emit('checkpoint');
      }
      if (p.x > this.level.flag.x) {
        this.score += 500;
        if (this.levelIndex + 1 < this.data.levels.length) {
          this.loadLevel(this.levelIndex + 1);
          this.state = 'transition'; this.transitionTicks = 75;
          this.emit('checkpoint');
        } else { this.state = 'victory'; this.emit('victory'); }
      }
      this.followCamera();
    }
  }
  return { Game, FixedClock, Controls, STEP, overlaps };
});
