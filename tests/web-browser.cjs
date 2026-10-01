/* Tests the assembled deliverable directly via file://, with networking offline.
 * Trusted Playwright keys exercise controls. Traversal uses state-reading DOM
 * key events at each real fixed tick; it never writes gameplay state. Geometry
 * fixtures are isolated and explicitly labeled. No fake/virtual clock is used.
 */
'use strict';
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'artifacts/web');
const HTML = path.join(ROOT, 'index.html');
const URL = pathToFileURL(HTML).href;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const report = { html: 'index.html', sha256: hash(fs.readFileSync(HTML)), bytes: fs.statSync(HTML).size,
  platform: `${os.platform()} ${os.release()} ${os.arch()}`, cpu: os.cpus()[0].model,
  viewport: { width: 1100, height: 940 }, headless: true, offline: true, clock: 'normal realtime; no virtual time',
  screenshots: [], checks: [], errors: [], failedRequests: [], externalRequests: [] };
let browser;
before(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  browser = await chromium.launch({ headless: true });
  report.chromium = browser.version();
});
after(async () => {
  if (browser) await browser.close();
  fs.writeFileSync(path.join(OUT, 'browser-report.json'), JSON.stringify(report, null, 2) + '\n');
});

// Observe the real asset loads and Canvas calls without changing the renderer.
function observe() {
  const o = window.__observe = { images: [], buffers: [], decoded: [], sources: [], gains: [], gainRamps: [],
    audioEvents: [], contexts: [], samples: [], recording: false, geometry: false, draws: [], lastDraws: [], current: null };
  const NativeImage = window.Image;
  window.Image = new Proxy(NativeImage, { construct(target, args) {
    const image = Reflect.construct(target, args); o.images.push(image); return image;
  } });
  const ap = AudioContext.prototype;
  const bufferNames = new WeakMap();
  const decode = ap.decodeAudioData;
  ap.decodeAudioData = async function (...args) {
    const bytes = new Uint8Array(args[0]);
    let binary = '';
    for (let i=0; i<bytes.length; i+=8192) binary += String.fromCharCode(...bytes.subarray(i,i+8192));
    const src = 'data:audio/wav;base64,' + btoa(binary);
    const tracks = Object.fromEntries(Object.entries(COIN_QUEST_DATA.music.tracks).map(([theme,track])=>['music:'+theme,track]));
    const name = Object.entries({...COIN_QUEST_DATA.sounds, ...tracks}).find(([,v])=>v.src===src)?.[0];
    const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
    const wavSha256 = await digest(bytes);
    const buffer = await decode.apply(this, args);
    const identity = {name,wavSha256,pcmSha256:await digest(buffer.getChannelData(0)),
      duration:buffer.duration,rate:buffer.sampleRate,samples:buffer.length,channels:buffer.numberOfChannels};
    bufferNames.set(buffer,identity); o.decoded.push(identity); o.buffers.push(buffer); return buffer;
  };
  for (const method of ['resume', 'suspend']) {
    const native = ap[method];
    ap[method] = function (...args) {
      o.audioEvents.push({ method, state: this.state, time: this.currentTime, at: performance.now(),
        hidden: document.hidden, focus: document.hasFocus() });
      return native.apply(this, args);
    };
  }
  const createGain = ap.createGain;
  ap.createGain = function (...args) {
    const g = createGain.apply(this, args), index=o.gains.length, ramp=g.gain.linearRampToValueAtTime;
    if (!o.contexts.includes(this)) {
      o.contexts.push(this);
      this.addEventListener('statechange', () => o.audioEvents.push({ method: 'statechange',
        state: this.state, time: this.currentTime, at: performance.now(), hidden: document.hidden, focus: document.hasFocus() }));
    }
    o.gains.push(g);
    g.gain.linearRampToValueAtTime=function(value,time) { o.gainRamps.push({gain:index,value,time,at:this.context?.currentTime ?? g.context.currentTime}); return ramp.call(this,value,time); };
    return g;
  };
  const createSource = ap.createBufferSource;
  ap.createBufferSource = function (...args) {
    const source = createSource.apply(this, args), start = source.start, connect = source.connect, stop = source.stop;
    let destination, record;
    source.connect = function (node, ...args) { destination = o.gains.indexOf(node); return connect.call(this,node,...args); };
    source.start = function (...values) {
      record = { ...bufferNames.get(this.buffer), state:this.context.state,
        theme:window.CoinQuest?.game.level.theme, gameState:window.CoinQuest?.game.state, background:o.backgroundTheme,
        loop:this.loop, loopStart:this.loopStart, loopEnd:this.loopEnd, gain:destination,
        time:this.context.currentTime, when:values[0] || this.context.currentTime, offset:values[1] || 0, ended:false };
      o.sources.push(record);
      o.maxMusic = Math.max(o.maxMusic || 0,o.sources.filter(s=>s.loop && !s.ended).length);
      return start.apply(this, values);
    };
    source.stop = function (...values) { if (record) record.stop=values[0] ?? this.context.currentTime; return stop.apply(this,values); };
    source.addEventListener('ended', () => { if(record) record.ended=true; });
    return source;
  };
  const draw = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = function (image, x, y, w, h) {
    if (this.canvas.id === 'canvas') {
      if (x===0 && y===0 && w===480 && h===360) {
        o.backgroundTheme = Object.entries(COIN_QUEST_DATA.images).find(([name,v])=>name.startsWith('backdrop_') && v.src===image.src)?.[0].slice(9);
      }
      if (o.current) o.current.draws++;
      if (o.geometry) {
        const m = this.getTransform();
        o.draws.push({ src: image.src, left: Math.min(m.a*x+m.e,m.a*(x+w)+m.e),
          right: Math.max(m.a*x+m.e,m.a*(x+w)+m.e), top: m.d*y+m.f, bottom: m.d*(y+h)+m.f, w, h });
      }
    }
    return draw.apply(this, arguments);
  };
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = callback => raf(timestamp => {
    if (callback.name !== 'frame') return callback(timestamp);
    const g = window.CoinQuest?.game;
    const sample = { timestamp, state: g?.state, level: g?.levelIndex, x: g?.player.x,
      vx: g?.player.vx, physicsFrame: g?.frame, tiles: g?.level.tiles.length, draws: 0, updateMs: 0, physicsSteps: 0 };
    o.current = sample; o.draws = [];
    const start = performance.now();
    callback(timestamp);
    sample.totalMs = performance.now() - start;
    sample.presentationMs = Math.max(0, sample.totalMs - sample.updateMs);
    if (o.recording) o.samples.push(sample);
    if (o.geometry) o.lastDraws = o.draws;
    o.current = null;
  });
}
async function open(options = {}, fixture = null) {
  const context = await browser.newContext({ viewport: report.viewport, deviceScaleFactor: 1, ...options });
  await context.setOffline(true);
  await context.route(/^(https?|wss?):/i, route => {
    report.externalRequests.push(route.request().url()); return route.abort();
  });
  await context.addInitScript(observe);
  if (fixture) await context.addInitScript(fixture);
  const page = await context.newPage();
  page.on('pageerror', e => report.errors.push(e.message));
  page.on('console', msg => { if (msg.type() === 'error') report.errors.push(msg.text()); });
  page.on('requestfailed', req => report.failedRequests.push({ url: req.url(), error: req.failure() }));
  page.on('request', req => { if (!/^(file:|data:)/.test(req.url())) report.externalRequests.push(req.url()); });
  await page.goto(URL);
  await page.waitForFunction(() => window.CoinQuest?.ready);
  return page;
}
async function audioRunning(page) {
  // Native devices can take time to resume. Prove the audio clock advances
  // before testing audible input; the separate delayed-resume tests cover queues.
  const start = await page.evaluate(() => __observe.gains[0].context.currentTime);
  await page.waitForFunction(start => {
    const c = __observe.gains[0].context;
    return !document.hidden && document.hasFocus() && c.state === 'running' && c.currentTime > start + .02;
  }, start, { timeout: 10000 });
}
async function audioTrace(page) {
  return page.evaluate(() => ({ events: __observe.audioEvents, sources: __observe.sources,
    context: __observe.gains[0].context.state, time: __observe.gains[0].context.currentTime,
    hidden: document.hidden, focus: document.hasFocus(), active: document.activeElement.id }));
}
async function state(page) {
  return page.evaluate(() => {
    const g = CoinQuest.game;
    return { state: g.state, frame: g.frame, level: g.levelIndex, x: g.player.x, y: g.player.y,
      vx: g.player.vx, vy: g.player.vy, camera: g.camera, lives: g.lives, coins: g.coins, score: g.score };
  });
}
async function frames(page, count = 3) {
  await page.evaluate(n => new Promise(resolve => {
    function next() { if (--n <= 0) resolve(); else requestAnimationFrame(next); }
    requestAnimationFrame(next);
  }), count);
}
async function screenshot(page, name, kind) {
  await page.screenshot({ path: path.join(OUT, name), fullPage: true });
  report.screenshots.push({ file: name, kind, state: await state(page) });
}
function near(a, b, label, tolerance = 1e-6) { assert.ok(Math.abs(a-b) <= tolerance, `${label}: ${a} != ${b}`); }
function distribution(values) {
  assert.ok(values.length > 0);
  const sorted = [...values].sort((a,b) => a-b);
  return { count: values.length, median: sorted[Math.floor(sorted.length*.5)], p95: sorted[Math.ceil(sorted.length*.95)-1],
    max: sorted.at(-1), mean: values.reduce((a,b) => a+b,0)/values.length };
}

test('compiled HTML matches source hashes, embeds exact data and has no runtime dependencies', async () => {
  const text = fs.readFileSync(HTML, 'utf8');
  const sources = JSON.parse(text.match(/^<!-- Native build source SHA-256: (.+) -->/)[1]);
  for (const [file, digest] of Object.entries(sources)) assert.equal(hash(fs.readFileSync(path.join(ROOT,file))), digest, `stale build: ${file}`);
  assert.ok(!/\{\{(?:STYLE|GAME_DATA|CORE_JS|UI_JS|AUDIO_JS|MAIN_JS)\}\}/.test(text));
  assert.ok(!/\bfetch\s*\(|\bXMLHttpRequest\b|<script[^>]+src=/i.test(text));
  const page = await open();
  const data = await page.evaluate(() => COIN_QUEST_DATA);
  assert.deepEqual(data, JSON.parse(fs.readFileSync(path.join(ROOT,'web/game-data.json'),'utf8')));
  assert.deepEqual(data.levels.map(l => l.theme), ['grassland','underground','castle']);
  for (const [name, meta] of Object.entries(data.provenance.images)) {
    assert.equal(hash(Buffer.from(data.images[name].src.split(',')[1],'base64')), meta.sha256);
    assert.equal(hash(fs.readFileSync(path.join(ROOT,meta.path))), meta.sha256);
  }
  const loaded = await page.evaluate(() => ({ images: __observe.images.map(i => ({ complete: i.complete, width: i.naturalWidth, height: i.naturalHeight })),
    audio: __observe.decoded,
    deps: [...document.querySelectorAll('script[src],link[href],iframe,object')].length }));
  assert.equal(loaded.images.length,25); assert.ok(loaded.images.every(i => i.complete && i.width && i.height));
  assert.equal(loaded.audio.length,12); assert.ok(loaded.audio.every(a => a.duration > 0 && a.samples > 0 && a.rate > 0 && a.channels === 1));
  assert.equal(loaded.deps,0);
  const expected = {...data.sounds,...Object.fromEntries(Object.entries(data.music.tracks).map(([theme,t])=>['music:'+theme,t]))};
  assert.deepEqual(loaded.audio.map(a=>a.name).sort(),Object.keys(expected).sort());
  assert.equal(loaded.audio.filter(a=>!a.name.startsWith('music:')).length,9);
  for(const a of loaded.audio) {
    assert.equal(a.wavSha256,expected[a.name].sha256);
    assert.equal(a.pcmSha256.length,64);
    if(a.name.startsWith('music:')) near(a.duration,expected[a.name].duration,'decoded scene duration',1/a.rate);
  }
  assert.equal(new Set(loaded.audio.filter(a=>a.name.startsWith('music:')).map(a=>a.pcmSha256)).size,3);
  report.preload = loaded;
  await screenshot(page,'01-title.png','actual title; no fixture');
  await page.close(); report.checks.push('embedded source/data/25 PNG/9 SFX + 3 scene WAV preload');
});

test('Pages subpath serves the self-contained build without external resource requests', async t => {
  const server = http.createServer((request, response) => {
    if (request.url !== '/coin-quest/') { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(fs.readFileSync(path.join(ROOT, 'dist/index.html')));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage(), requests = [];
  page.on('request', request => requests.push(request.url()));
  const url = `http://127.0.0.1:${server.address().port}/coin-quest/`;
  await page.goto(url); await page.waitForFunction(() => window.CoinQuest?.ready);
  assert.equal(await page.title(), 'Coin Quest');
  assert.equal(await page.locator('#screen-title').textContent(), 'Coin Quest');
  await page.keyboard.press('Enter');
  assert.equal((await state(page)).state, 'play');
  assert.deepEqual(requests.filter(url => !url.startsWith('data:')), [url]);
});

test('menu DOM helpers preserve keyboard hints and treat variable copy only as text', async () => {
  const page = await open();
  const copy = await page.evaluate(() => {
    const target = document.createElement('div'), button = document.createElement('button');
    window.CoinQuestUI.paragraphs(target, '<img src=x onerror=alert(1)>', 'Coins & points');
    window.CoinQuestUI.buttonLabel(button, 'Pause', 'P');
    return { text: target.textContent, tags: [...target.children].map(n => n.tagName),
      images: target.querySelectorAll('img').length, label: button.textContent, shortcut: button.querySelector('kbd').textContent };
  });
  assert.equal(copy.text, '<img src=x onerror=alert(1)>Coins & points');
  assert.deepEqual(copy.tags, ['P', 'P']); assert.equal(copy.images, 0);
  assert.equal(copy.label, 'Pause P'); assert.equal(copy.shortcut, 'P');
  await page.close();
});

test('trusted keyboard start, movement, release, Space jump, camera, sound, HUD and menu controls', async () => {
  const page = await open();
  await page.getByRole('button',{ name: 'How to play', exact: true }).click();
  assert.equal((await state(page)).state,'instructions');
  await page.getByRole('button',{ name: 'Back', exact: true }).click();
  assert.equal((await state(page)).state,'title');
  await page.locator('#game').focus(); await page.keyboard.press('Enter');
  await audioRunning(page);
  await page.waitForFunction(() => CoinQuest.game.player.grounded);
  await screenshot(page,'02-opening.png','trusted Enter; no fixture');
  await page.keyboard.down('ArrowRight');
  await page.waitForFunction(() => CoinQuest.game.player.x > 210);
  await page.keyboard.up('ArrowRight');
  await page.waitForFunction(() => CoinQuest.game.player.vx === 0);
  const stopped = await state(page); assert.ok(stopped.x > 210 && stopped.camera > 0);
  await frames(page,8); near((await state(page)).x,stopped.x,'released key stops');
  assert.equal(stopped.coins,2); assert.equal(await page.locator('#hud-coins').textContent(),'2');
  assert.equal(await page.locator('#hud-score').textContent(),'20');
  await page.keyboard.down('Space');
  await page.waitForFunction(() => CoinQuest.game.player.vy > 5);
  assert.ok((await state(page)).y > -112);
  await page.keyboard.up('Space');
  await page.waitForFunction(() => CoinQuest.game.player.grounded);
  report.trustedAudioTrace = await audioTrace(page);
  const sounds = await page.evaluate(() => __observe.sources.filter(s=>!s.loop));
  assert.equal(sounds.filter(s=>s.name==='coin').length,2);
  assert.equal(sounds.filter(s=>s.name==='jump').length,1);
  assert.ok(sounds.every(s=>s.state==='running' && s.duration>0 && s.gain===0));
  report.trustedSfx=sounds;
  await page.keyboard.press('KeyM');
  assert.equal(await page.locator('#mute-button').getAttribute('aria-pressed'),'true');
  await page.waitForFunction(()=>__observe.sources.every(s=>s.ended));
  // Dormant gains need not update .value when no sources pull the graph. Check
  // real ramp calls and ended nodes rather than requiring an idle DSP render.
  assert.deepEqual(await page.evaluate(()=>[0,1].map(i=>__observe.gainRamps.filter(r=>r.gain===i).at(-1).value)),[0,0]);
  const played = await page.evaluate(() => __observe.sources.length);
  await page.keyboard.down('Space'); await frames(page,5); await page.keyboard.up('Space');
  assert.equal(await page.evaluate(() => __observe.sources.length),played);
  await page.locator('#mute-button').click();
  assert.equal(await page.locator('#mute-button').getAttribute('aria-pressed'),'false');
  await page.keyboard.press('KeyP'); assert.equal((await state(page)).state,'paused');
  await page.getByRole('button',{ name: 'How to play', exact: true }).click();
  assert.equal((await state(page)).state,'instructions');
  await page.getByRole('button',{ name: 'Back to game', exact: true }).click();
  assert.equal((await state(page)).state,'play');
  await page.keyboard.press('KeyR');
  const restarted = await state(page);
  assert.equal(restarted.level,0); assert.equal(restarted.lives,3); assert.equal(restarted.score,0); near(restarted.x,80,'restart spawn');
  await page.close(); report.checks.push('trusted keys, release, camera, audio scheduling/mute, HUD, help/restart');
});

// Observe actual AudioBufferSourceNodes. Do not fake context state or count music as SFX.
async function musicState(page) {
  return page.evaluate(() => ({ sources:__observe.sources.filter(s=>s.loop),
    live:__observe.sources.filter(s=>s.loop && !s.ended).length, max:__observe.maxMusic || 0,
    gains:__observe.gains.map(g=>g.gain.value), context:__observe.gains[0].context.state }));
}
async function musicLive(page, count) {
  await page.waitForFunction(n=>__observe.sources.filter(s=>s.loop && !s.ended && (n===0 || s.stop===undefined)).length===n,count);
}

test('music audio lifecycle: no autoplay, one real loop, pause/help/mute/restart/blur/hidden and ending cues', async () => {
  const page=await open();
  assert.equal((await musicState(page)).sources.length,0);
  await page.waitForTimeout(100);
  assert.equal((await musicState(page)).sources.length,0);
  await page.keyboard.press('Enter'); await musicLive(page,1);
  await page.waitForTimeout(180);
  let m=await musicState(page);
  assert.equal(m.context,'running'); assert.equal(m.max,1);
  assert.equal(m.sources[0].name,'music:grassland'); assert.equal(m.sources[0].duration,16);
  assert.equal(m.sources[0].loopStart,0); assert.equal(m.sources[0].loopEnd,16);
  assert.equal(m.sources[0].gain,1); assert.equal(m.sources[0].state,'running');
  assert.ok(Math.abs(m.gains[1]-.10)<1e-6);
  await page.keyboard.down('KeyD'); await page.keyboard.down('KeyD'); await page.keyboard.up('KeyD');
  assert.equal((await musicState(page)).sources.length,1,'repeated input cannot duplicate loop');
  await page.keyboard.press('KeyP'); await musicLive(page,0);
  const paused=await musicState(page);
  await page.waitForTimeout(100); assert.equal((await musicState(page)).sources.length,paused.sources.length);
  await page.keyboard.press('Enter'); await musicLive(page,1);
  m=await musicState(page); assert.ok(m.sources.at(-1).offset>0,'resume retains the musical position');
  near(m.sources.at(-1).offset,paused.sources.at(-1).stop-paused.sources.at(-1).when,'paused offset',.001);
  await page.keyboard.press('KeyI'); await musicLive(page,0);
  await page.keyboard.press('Enter'); await musicLive(page,1);
  await page.keyboard.press('KeyM'); await musicLive(page,0);
  assert.deepEqual(await page.evaluate(()=>[0,1].map(i=>__observe.gainRamps.filter(r=>r.gain===i).at(-1).value)),[0,0]);
  await page.keyboard.press('KeyM'); await musicLive(page,1);
  // Rapid restart and mute/unmute while the 20ms release is still in flight.
  await page.keyboard.press('KeyM'); await page.keyboard.press('KeyM'); await musicLive(page,1);
  for(let i=0;i<3;i++) await page.keyboard.press('KeyR');
  await musicLive(page,1); m=await musicState(page);
  assert.equal(m.sources.at(-1).offset,0); assert.equal(m.max,1);
  await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
  await musicLive(page,0);
  await page.waitForFunction(()=>__observe.gains[0].context.state==='suspended');
  const sleeping=(await musicState(page)).sources.length;
  await page.waitForTimeout(100); assert.equal((await musicState(page)).sources.length,sleeping);
  await page.keyboard.press('Enter'); await musicLive(page,1);
  // Isolated visibility fixture exercises the browser event path, not audio state.
  await page.evaluate(()=>{ Object.defineProperty(document,'hidden',{configurable:true,value:true}); document.dispatchEvent(new Event('visibilitychange')); });
  await musicLive(page,0); await page.waitForFunction(()=>__observe.gains[0].context.state==='suspended');
  await page.evaluate(()=>{ delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
  assert.equal((await musicState(page)).live,0,'visibility alone never resumes play/music');
  await page.keyboard.press('Enter'); await musicLive(page,1);
  // State fixtures isolate transition/end rules. Full traversal below also checks victory.
  await page.evaluate(()=>{ CoinQuest.game.state='transition'; CoinQuest.game.transitionTicks=100; });
  await frames(page); assert.equal((await musicState(page)).live,1);
  for(const ending of ['gameover','victory']) {
    await page.evaluate(ending=>{ CoinQuest.game.state=ending; CoinQuest.game.emit(ending); },ending);
    await musicLive(page,0);
    const cues=await page.evaluate(()=>__observe.sources.filter(s=>!s.loop));
    assert.ok(cues.some(s=>s.name===ending && s.state==='running' && s.gain===0));
    await page.keyboard.press('KeyR'); await musicLive(page,1);
  }
  m=await musicState(page); assert.equal(m.max,1);
  report.musicLifecycle=m;
  await page.close(); report.checks.push('one real 16s loop; music lifecycle, routing, offsets, background suspend and ending SFX');
});

// These labeled state fixtures isolate audio handoffs. Input-only traversal below
// separately proves automatic scene selection through the shipped level flow.
async function sceneFixture(page, level) {
  await page.evaluate(level=>{
    const g=CoinQuest.game; g.loadLevel(level); g.state='transition'; g.transitionTicks=600;
  },level);
  const theme=['grassland','underground','castle'][level];
  await page.waitForFunction(theme=>__observe.sources.some(s=>s.name==='music:'+theme && !s.ended && s.stop===undefined),theme);
}

test('scene music matches all backgrounds during transitions and preserves each theme through pause/help/mute', async () => {
  const page=await open(); await page.keyboard.press('Enter'); await musicLive(page,1);
  const evidence=[];
  for(let level=0;level<3;level++) {
    if(level) await sceneFixture(page,level);
    await page.waitForTimeout(180);
    const theme=['grassland','underground','castle'][level];
    let m=await musicState(page), source=m.sources.at(-1);
    assert.equal(source.name,'music:'+theme); assert.equal(source.offset,0);
    assert.equal(source.theme,theme);
    assert.equal(await page.evaluate(()=>__observe.backgroundTheme),theme);
    const decoded=await page.evaluate(t=>__observe.decoded.find(a=>a.name==='music:'+t),theme);
    assert.equal(source.wavSha256,decoded.wavSha256); assert.equal(source.pcmSha256,decoded.pcmSha256);
    near(source.loopEnd,decoded.duration,'scene loop end',1/decoded.rate);
    assert.equal(m.live,1); assert.equal(m.max,1);
    if(level) {
      const old=m.sources.at(-2);
      assert.ok(old.ended && source.time>=old.stop,'serial release ends before the next source');
      const fades=await page.evaluate(()=>__observe.gainRamps.filter(r=>r.gain===1 && Math.abs(r.time-r.at-.15)<.001));
      assert.ok(fades.some(r=>r.value===0) && fades.some(r=>r.value===.10),'150ms scene fade out and fade in');
    }
    for(const key of ['KeyP','KeyI','KeyM']) {
      source=(await musicState(page)).sources.at(-1);
      await page.keyboard.press(key); await musicLive(page,0);
      const stopped=(await musicState(page)).sources.at(-1);
      const paused=await state(page), count=(await musicState(page)).sources.length;
      await page.waitForTimeout(100);
      assert.equal((await musicState(page)).sources.length,count,'no dormant source creation');
      if(key!=='KeyM') assert.equal((await state(page)).frame,paused.frame,'no physics catch-up while paused');
      // Help returns through the real button action; pause and mute toggle back.
      await page.keyboard.press(key==='KeyI'?'Enter':key); await musicLive(page,1);
      const resumed=(await musicState(page)).sources.at(-1);
      assert.equal(resumed.name,'music:'+theme);
      near(resumed.offset,(source.offset+stopped.stop-source.when)%source.loopEnd,'theme-local resumed offset',.002);
    }
    evidence.push((await musicState(page)).sources.at(-1));
  }
  await page.keyboard.press('KeyR'); await musicLive(page,1);
  const restarted=(await musicState(page)).sources.at(-1);
  assert.equal(restarted.name,'music:grassland'); assert.equal(restarted.offset,0);
  // A later visit to Underground also starts at zero, not its previous pause offset.
  await sceneFixture(page,1); assert.equal((await musicState(page)).sources.at(-1).offset,0);
  await page.evaluate(()=>{ CoinQuest.game.state='title'; }); await musicLive(page,0);
  report.sceneTransitions={evidence,final:await musicState(page)};
  await page.close();
});

test('scene music rapid changes select newest only; restart/mute loops never overlap or resurrect old scenes', async () => {
  const page=await open(); await page.keyboard.press('Enter'); await musicLive(page,1);
  await page.evaluate(async()=>{
    for(const level of [1,2,1,2]) {
      const g=CoinQuest.game; g.loadLevel(level); g.state='transition'; g.transitionTicks=600;
      await new Promise(resolve=>requestAnimationFrame(resolve));
    }
  });
  await page.waitForFunction(()=>__observe.sources.some(s=>s.name==='music:castle' && !s.ended && s.stop===undefined));
  let m=await musicState(page);
  assert.deepEqual(m.sources.map(s=>s.name),['music:grassland','music:castle']);
  assert.equal(m.sources.at(-1).offset,0); assert.equal(m.max,1);
  // Restart while a scene fade is pending, then mute before its end.
  await page.evaluate(()=>{ const g=CoinQuest.game; g.loadLevel(1); g.state='transition'; g.transitionTicks=600; });
  await frames(page,1);
  await page.keyboard.press('KeyR'); await page.keyboard.press('KeyM'); await musicLive(page,0);
  const muted=(await musicState(page)).sources.length;
  await page.waitForTimeout(250); assert.equal((await musicState(page)).sources.length,muted);
  await page.keyboard.press('KeyM'); await musicLive(page,1);
  assert.equal((await musicState(page)).sources.at(-1).name,'music:grassland');
  assert.equal((await musicState(page)).sources.at(-1).offset,0);
  for(let i=0;i<30;i++) {
    await page.keyboard.press('KeyR'); await page.keyboard.press('KeyM'); await page.keyboard.press('KeyM');
  }
  await musicLive(page,1); await page.waitForTimeout(200);
  m=await musicState(page); const count=m.sources.length;
  assert.equal(m.max,1); assert.equal(m.sources.at(-1).name,'music:grassland');
  assert.ok(count<=64,'source creation bounded by actions, not UI frames');
  await page.waitForTimeout(1000); assert.equal((await musicState(page)).sources.length,count);
  await page.keyboard.press('KeyP'); await musicLive(page,0);
  const paused=await state(page); await page.waitForTimeout(200);
  assert.deepEqual(await state(page),paused);
  assert.equal((await musicState(page)).sources.length,count);
  report.sceneRapid=await musicState(page); await page.close();
});

test('scene music late native unlock uses newest theme and respects pause after a scene change', async () => {
  const evidence=[];
  for(const pause of [false,true]) {
    const page=await open({},()=>{
      const native=AudioContext.prototype.resume;
      AudioContext.prototype.resume=function() { return new Promise((resolve,reject)=>setTimeout(()=>native.call(this).then(resolve,reject),300)); };
    });
    await page.keyboard.press('Enter');
    await page.evaluate(()=>{ const g=CoinQuest.game; g.loadLevel(2); g.state='transition'; g.transitionTicks=600; });
    await frames(page,1);
    if(pause) await page.keyboard.press('KeyP');
    assert.equal((await musicState(page)).sources.length,0,'native context has not resumed yet');
    await page.waitForTimeout(450);
    if(pause) {
      assert.equal((await state(page)).state,'paused');
      assert.equal((await musicState(page)).sources.length,0);
      await page.keyboard.press('Enter');
    }
    await musicLive(page,1);
    const m=await musicState(page);
    assert.equal(m.sources.length,1); assert.equal(m.sources[0].name,'music:castle');
    assert.equal(m.sources[0].theme,'castle'); assert.equal(m.sources[0].offset,0);
    assert.equal(m.sources[0].state,'running'); assert.equal(m.max,1);
    evidence.push({pause,music:m}); await page.close();
  }
  report.sceneLateUnlock=evidence;
});

test('scene music leaves all nine original effect buffers separately playable on the native context', async () => {
  const page=await open(); await page.keyboard.press('Enter'); await musicLive(page,1);
  const names=await page.evaluate(()=>Object.keys(COIN_QUEST_DATA.sounds));
  assert.equal(names.length,9);
  // Isolated cue fixture, not a gameplay coverage claim. Natural pickups stay tested below.
  for(const name of names) {
    await page.evaluate(name=>CoinQuest.game.emit(name),name);
    await page.waitForFunction(name=>__observe.sources.some(s=>!s.loop && s.name===name),name);
    await page.waitForTimeout(100);
  }
  const effects=await page.evaluate(()=>__observe.sources.filter(s=>!s.loop));
  assert.deepEqual(effects.map(s=>s.name).sort(),names.sort());
  assert.ok(effects.every(s=>s.state==='running' && s.gain===0));
  for(const effect of effects) assert.equal(effect.wavSha256,await page.evaluate(n=>COIN_QUEST_DATA.sounds[n].sha256,effect.name));
  assert.equal((await musicState(page)).max,1);
  report.sceneNineEffects=effects; await page.close();
});

test('audio catch-up regression schedules both real coin pickups plus jump after a 180ms stall', async () => {
  const page=await open();
  await page.evaluate(()=>{
    const g=CoinQuest.game, emit=g.emit, sample=CoinQuest.controls.sample;
    window.__cues=[]; let stalled=false;
    g.emit=function(name) { __cues.push({name,frame:g.frame,at:performance.now()}); return emit.call(this,name); };
    CoinQuest.controls.sample=function() {
      if(!stalled && g.player.x>=125) { stalled=true; const start=performance.now(); while(performance.now()-start<180) {} }
      return sample.call(this);
    };
  });
  await page.keyboard.press('Enter'); await audioRunning(page); await page.keyboard.down('ArrowRight');
  await page.waitForFunction(()=>CoinQuest.game.player.x>210); await page.keyboard.up('ArrowRight');
  await page.waitForFunction(()=>CoinQuest.game.player.vx===0);
  await page.keyboard.down('Space'); await page.waitForFunction(()=>CoinQuest.game.player.vy>5);
  await page.keyboard.up('Space'); await page.waitForFunction(()=>CoinQuest.game.player.grounded);
  const result=await page.evaluate(()=>({events:__cues,sources:__observe.sources.filter(s=>!s.loop),maxMusic:__observe.maxMusic}));
  assert.deepEqual(result.events.map(e=>e.name),['coin','coin','jump']);
  assert.deepEqual(result.sources.map(s=>s.name),['coin','coin','jump']);
  assert.ok(result.sources.every(s=>s.state==='running' && s.duration>0 && s.gain===0));
  assert.ok(result.sources[1].when-result.sources[0].when>=.0399);
  assert.equal(result.maxMusic,1);
  report.audioCatchup=result;
  await page.close(); report.checks.push('180ms real stall retains both coin cues and jump separately from music');
});

test('repeated trusted pickups and jumps keep exact SFX identities on the native audio clock', async () => {
  report.repeatedTrustedAudio = [];
  for (let run = 0; run < 5; run++) {
    const page = await open();
    await page.keyboard.press('Enter'); await audioRunning(page);
    await page.keyboard.down('ArrowRight');
    await page.waitForFunction(() => CoinQuest.game.player.x > 210);
    await page.keyboard.up('ArrowRight');
    await page.waitForFunction(() => CoinQuest.game.player.vx === 0);
    await page.keyboard.down('Space');
    await page.waitForFunction(() => CoinQuest.game.player.vy > 5);
    await page.keyboard.up('Space');
    await page.waitForFunction(() => CoinQuest.game.player.grounded);
    const trace = await audioTrace(page);
    report.repeatedTrustedAudio.push(trace);
    assert.equal((await state(page)).coins, 2);
    assert.deepEqual(trace.sources.filter(s => !s.loop).map(s => s.name), ['coin', 'coin', 'jump']);
    assert.ok(trace.sources.every(s => s.state === 'running'));
    await page.keyboard.press('KeyM');
    await page.waitForFunction(() => __observe.sources.every(s => s.ended));
    assert.equal(await page.locator('#mute-button').getAttribute('aria-pressed'), 'true');
    await page.close();
  }
});

test('focus sleep waits for real scheduled source endings before suspending the audio clock', async () => {
  // Isolated scheduling fixture: delay real native stops, never fake clock/state.
  const page = await open({}, () => {
    const create = AudioContext.prototype.createBufferSource;
    AudioContext.prototype.createBufferSource = function (...args) {
      const source = create.apply(this, args), stop = source.stop;
      source.stop = function (when = this.context.currentTime) { return stop.call(this, when + .25); };
      return source;
    };
  });
  await page.keyboard.press('Enter'); await audioRunning(page); await musicLive(page, 1);
  await page.keyboard.down('Space');
  await page.waitForFunction(() => CoinQuest.game.player.vy > 5);
  await page.keyboard.up('Space');
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.waitForTimeout(60);
  assert.equal((await state(page)).state, 'paused');
  assert.equal((await musicState(page)).context, 'running', 'scheduled stops still need the real audio clock');
  await page.waitForFunction(() => __observe.sources.every(s => s.ended) && __observe.gains[0].context.state === 'suspended');
  const count = (await musicState(page)).sources.length;
  await page.waitForTimeout(100);
  assert.equal((await musicState(page)).sources.length, count, 'sleep never resurrects a loop');
  report.delayedStops = await audioTrace(page);
  await page.keyboard.press('Enter'); await musicLive(page, 1);
  assert.equal((await musicState(page)).max, 1);
  await page.close();
});

test('audio delayed native resume queues a fresh jump without blocking gameplay', async () => {
  const page=await open({},()=>{
    const native=AudioContext.prototype.resume;
    window.__resumeCalls=0;
    AudioContext.prototype.resume=function() { __resumeCalls++; return new Promise((resolve,reject)=>setTimeout(()=>native.call(this).then(resolve,reject),200)); };
  });
  await page.evaluate(()=>{
    const emit=CoinQuest.game.emit; window.__queuedEvents=[];
    CoinQuest.game.emit=function(name) { __queuedEvents.push({name,state:__observe.gains[0].context.state}); return emit.call(this,name); };
  });
  await page.keyboard.press('Enter');
  await page.waitForFunction(()=>CoinQuest.game.player.grounded);
  await page.keyboard.down('Space'); await page.waitForFunction(()=>CoinQuest.game.player.vy>5);
  await page.keyboard.up('Space');
  await page.waitForFunction(()=>__observe.sources.some(s=>s.name==='jump'));
  const sounds=await page.evaluate(()=>__observe.sources);
  assert.equal(sounds.filter(s=>s.name==='jump').length,1);
  assert.ok(sounds.every(s=>s.state==='running'));
  assert.equal(sounds.filter(s=>s.loop).length,1);
  const queued=await page.evaluate(()=>({events:__queuedEvents,resumeCalls:__resumeCalls}));
  assert.ok(queued.events.some(e=>e.name==='jump' && e.state==='suspended'),'jump actually arrives before native resume');
  assert.equal(queued.resumeCalls,1,'concurrent gesture unlocks share one promise');
  report.delayedResume={...queued,sounds}; await page.close();
});

test('audio late unlock cannot start music or stale cues behind pause; keyboard resume button unlocks', async () => {
  const page=await open({},()=>{
    const native=AudioContext.prototype.resume;
    AudioContext.prototype.resume=function() { return new Promise((resolve,reject)=>setTimeout(()=>native.call(this).then(resolve,reject),180)); };
  });
  await page.keyboard.press('Enter');
  await page.waitForFunction(()=>CoinQuest.game.player.grounded);
  await page.keyboard.down('Space'); await page.waitForFunction(()=>CoinQuest.game.player.vy>5);
  await page.keyboard.up('Space'); await page.keyboard.press('KeyP');
  await page.waitForTimeout(300);
  assert.equal((await state(page)).state,'paused');
  assert.equal((await musicState(page)).sources.length,0);
  assert.equal(await page.evaluate(()=>__observe.sources.length),0,'pause cancels the queued jump');
  await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
  await page.waitForFunction(()=>__observe.gains[0].context.state==='suspended');
  await page.locator('#pause-button').focus(); await page.keyboard.press('Enter');
  await musicLive(page,1); assert.equal((await state(page)).state,'play');
  assert.equal((await musicState(page)).max,1);
  await page.close();
});

test('audio unavailable or rejected resume leaves gameplay usable and shows a notice', async () => {
  for(const mode of ['unavailable','rejected']) {
    const page=await open({},mode==='unavailable' ? ()=>{ window.AudioContext=window.webkitAudioContext=undefined; } : ()=>{
      window.__nativeResume=AudioContext.prototype.resume;
      AudioContext.prototype.resume=()=>Promise.reject(new Error('Simulated browser policy rejection'));
    });
    await page.keyboard.press('Enter'); await page.keyboard.down('KeyD');
    await page.waitForFunction(()=>CoinQuest.game.player.x>100); await page.keyboard.up('KeyD');
    assert.equal((await state(page)).state,'play');
    assert.equal(await page.locator('#audio-notice').isVisible(),true);
    assert.equal(await page.evaluate(()=>__observe.sources.length),0);
    if(mode==='rejected') {
      await page.evaluate(()=>{ AudioContext.prototype.resume=__nativeResume; });
      await page.keyboard.press('KeyM'); await page.keyboard.press('KeyM');
      await musicLive(page,1); assert.equal((await musicState(page)).context,'running');
    }
    await page.close();
  }
});

test('pause, focus loss and window blur clear held input and do not catch up elapsed pause time', async () => {
  const page = await open(); await page.keyboard.press('Enter');
  await page.keyboard.down('KeyD'); await frames(page,6); await page.keyboard.press('Escape');
  const paused = await state(page); assert.equal(paused.state,'paused');
  await page.waitForTimeout(500); assert.deepEqual(await state(page),paused);
  assert.equal(await page.evaluate(() => CoinQuest.controls.held.size),0);
  await page.keyboard.up('KeyD'); await page.keyboard.press('Enter');
  // Wait for physics ticks, not render frames: this host can render at 120 Hz.
  await page.waitForFunction(f => CoinQuest.game.frame >= f + 20, paused.frame);
  const resumed = await state(page);
  assert.ok(resumed.frame-paused.frame < 35,'no accumulated pause backlog'); assert.equal(resumed.vx,0);
  await page.evaluate(() => { const b = document.createElement('button'); b.id='outside'; b.textContent='Outside'; document.body.append(b); b.focus(); });
  assert.equal((await state(page)).state,'paused');
  const outside = await state(page); await page.keyboard.press('KeyR'); assert.deepEqual(await state(page),outside);
  await page.locator('#primary-button').click(); assert.equal((await state(page)).state,'play');
  await page.keyboard.down('KeyD'); await frames(page,3);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  assert.equal((await state(page)).state,'paused'); assert.equal(await page.evaluate(() => CoinQuest.controls.held.size),0);
  await page.keyboard.up('KeyD'); await page.close(); report.checks.push('pause/focus/blur input clearing');
});

test('actual Canvas draw bounds align feet, adjoining terrain and all backdrops (isolated fixtures)', async () => {
  const page = await open(); const cases = [];
  for (let level=0;level<3;level++) {
    for (const pose of ['idle','run1','run2','jump','hurt','grown']) {
      await page.evaluate(({ level, pose }) => {
        const g = CoinQuest.game;
        g.loadLevel(level); g.state='paused';
        Object.assign(g.player,{ x: 240.375, y: -112, grounded: pose !== 'jump', vx: pose.startsWith('run') ? 4 : 0,
          invulnerable: pose === 'hurt' ? 3 : 0, grown: pose === 'grown', face: pose === 'run2' ? -1 : 1 });
        g.frame=pose === 'run2' ? 8 : 0; g.snap(); __observe.geometry=true;
      },{ level, pose });
      await frames(page);
      const result = await page.evaluate(() => {
        const names = new Map(Object.entries(COIN_QUEST_DATA.images).map(([k,v]) => [v.src,k]));
        return { feet: 180-CoinQuest.game.player.y, draws: __observe.lastDraws.map(d => ({...d,src:names.get(d.src)})), smoothing: document.querySelector('canvas').getContext('2d').imageSmoothingEnabled };
      });
      assert.equal(result.smoothing,false);
      const bg=result.draws[0]; assert.equal(bg.src,`backdrop_${['grassland','underground','castle'][level]}`);
      assert.deepEqual([bg.left,bg.top,bg.right,bg.bottom],[0,0,480,360]);
      const player=result.draws.find(d => d.src.startsWith('player_'));
      assert.ok(player); near(player.bottom,result.feet,'player feet'); near(player.h,pose==='grown'?48:32,'player scale');
      assert.equal(player.src,`player_${pose==='grown'?'idle':pose}`);
      const tiles=result.draws.filter(d => d.src.startsWith('ground_') && Math.abs(d.top-292)<1e-6).sort((a,b) => a.left-b.left);
      assert.ok(tiles.length >= 15);
      for (let i=1;i<tiles.length;i++) near(tiles[i-1].right,tiles[i].left,'terrain seam');
      cases.push({level:level+1,pose,player,tiles:tiles.length,backdrop:[bg.left,bg.top,bg.right,bg.bottom]});
    }
  }
  report.geometry=cases; await page.close(); report.checks.push('18 isolated Canvas geometry fixtures');
});

// Runs within the browser. Only key events are written; every position, collision,
// gap crossing, pickup and level transition is computed by the shipped game.
function installTraversal() {
  const { game:g, controls }=CoinQuest;
  const original=controls.sample.bind(controls);
  const driver=window.__driver={ active:false, visited:[], gaps:[], damage:[], keys:0, ticks:0 };
  let jumpTicks=0, landingTarget=null, crossingGap=false, lastLevel=-1, lastX=80;
  const held={};
  function key(code,on) {
    if (!!held[code]===on) return;
    held[code]=on; driver.keys++;
    document.querySelector('#game').dispatchEvent(new KeyboardEvent(on?'keydown':'keyup',{code,bubbles:true,cancelable:true}));
  }
  controls.sample=function () {
    if (!driver.active) return original();
    if (g.state !== 'play') { key('Space',false); key('KeyD',false); return original(); }
    driver.ticks++;
    const p=g.player,{x,y}=p,level=g.level;
    if (g.levelIndex!==lastLevel) {
      driver.visited.push(g.levelIndex); lastLevel=g.levelIndex;
      jumpTicks=0; landingTarget=null; crossingGap=false; lastX=x;
    }
    for (const gap of level.gaps) if(lastX<gap[1] && x>=gap[1]) driver.gaps.push({level:g.levelIndex+1,gap,feet:y});
    lastX=x;
    if (g.lives!==3 || p.invulnerable) driver.damage.push({level:g.levelIndex,x,y,lives:g.lives});
    let jump=false;
    if (p.grounded && !held.Space) {
      landingTarget=null;
      const gap=level.gaps.find(([left])=>left-x<28 && left-x>-10);
      jump=Boolean(gap); crossingGap=Boolean(gap);
      if (gap && level.spikes.some(s=>s.x>=gap[1] && s.x-gap[1]<=96)) landingTarget=gap[1]+12;
      jump ||= level.spikes.some(s=>s.x-x<48 && s.x-x>-32 && y<s.y+20);
      jump ||= level.enemies.some(e=>e.state===1 && e.x-x<56 && e.x-x>-12 && y<e.y+24);
      jump ||= level.geometry.some(r=>['platform','bonus_block'].includes(r.kind) && r.x-x<48 && r.x-x>0 && y<r.y+r.h && r.y+r.h-y<=101);
    }
    if(jump) jumpTicks=38; else if(p.grounded && jumpTicks<25) jumpTicks=0;
    key('Space',jumpTicks-->0);
    const waitGap=!crossingGap && !p.grounded && level.gaps.some(([left])=>left-x<44 && left-x>0);
    const waitPlatform=!p.grounded && p.vy<0 && level.geometry.some(r=>r.kind==='platform' && r.x-x<44 && r.x-x>0 && r.y+r.h>y && r.y+r.h<=-11);
    key('KeyD',!waitGap && !waitPlatform && (landingTarget===null || x<landingTarget-12));
    return original();
  };
}

test('normal-clock input-only browser traversal crosses every gap and all three stages; victory restarts', {timeout:90000}, async () => {
  const page=await open();
  await page.evaluate(installTraversal);
  await page.evaluate(() => { __driver.active=true; });
  await page.keyboard.press('Enter');
  for (const [level,name] of [[0,'03-grassland-scroll.png'],[1,'04-underground.png'],[2,'05-castle.png']]) {
    await page.waitForFunction(l => CoinQuest.game.levelIndex===l && CoinQuest.game.state==='play' && CoinQuest.game.camera>650,level,{timeout:25000});
    await screenshot(page,name,'actual DOM-key-driven traversal; no gameplay fixture');
    assert.equal(await page.locator('#hud-level').textContent(),`${level+1} / 3`);
    const theme=['grassland','underground','castle'][level];
    const music=await musicState(page), source=music.sources.at(-1);
    assert.equal(source.name,'music:'+theme);
    assert.equal(source.theme,theme); assert.equal(source.offset,0);
    assert.equal(source.background,theme);
    assert.equal(source.gameState,level===0?'play':'transition');
    assert.equal(await page.evaluate(()=>__observe.backgroundTheme),theme);
    assert.equal(source.wavSha256,await page.evaluate(t=>COIN_QUEST_DATA.music.tracks[t].sha256,theme));
    assert.equal(music.live,1); assert.equal(music.max,1);
    (report.traversalMusic ||= []).push(source);
  }
  await page.waitForFunction(() => CoinQuest.game.state==='victory',null,{timeout:25000});
  await musicLive(page,0);
  assert.equal((await musicState(page)).max,1);
  assert.deepEqual((await musicState(page)).sources.map(s=>s.name),['music:grassland','music:underground','music:castle']);
  const result=await page.evaluate(() => ({...__driver,frame:CoinQuest.game.frame,score:CoinQuest.game.score,coins:CoinQuest.game.coins,lives:CoinQuest.game.lives}));
  assert.deepEqual(result.visited,[0,1,2]); assert.equal(result.gaps.length,9); assert.deepEqual(result.damage,[]);
  assert.equal(result.lives,3); assert.equal(result.score,2990); assert.equal(result.coins,54);
  assert.ok(result.keys>50); report.traversal=result;
  await screenshot(page,'06-victory.png','actual DOM-key-driven victory; no fixture');
  await page.evaluate(() => { __driver.active=false; });
  await page.getByRole('button',{name:'Play again',exact:true}).click();
  const restarted=await state(page); assert.equal(restarted.state,'play'); assert.equal(restarted.level,0);
  assert.equal(restarted.lives,3); assert.equal(restarted.score,0); assert.equal(restarted.coins,0); near(restarted.x,80,'victory restart');
  await page.close(); report.checks.push('all-stage/all-gap input-only realtime traversal and victory restart');
});

test('sustained real-clock moving scene measures rAF, update/presentation costs, draws and heap', {timeout:40000}, async () => {
  const page=await open(); const cdp=await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  await page.keyboard.press('Enter');
  // A trusted-key patrol on the opening ground avoids deaths. All terrain,
  // entities, sounds and normal rendering remain intact. No fixture or fast time.
  await page.keyboard.down('KeyD');
  await page.waitForFunction(() => CoinQuest.game.player.x>310); await page.keyboard.up('KeyD');
  await page.evaluate(() => {
    const advance=CoinQuest.clock.advance;
    CoinQuest.clock.advance=function(...args) {
      const start=performance.now(); const result=advance.apply(this,args);
      if(__observe.current) { __observe.current.updateMs=performance.now()-start; __observe.current.physicsSteps=result; }
      return result;
    };
    __observe.samples=[]; __observe.recording=true;
  });
  const heapBefore=(await cdp.send('Runtime.getHeapUsage')).usedSize;
  const wallStart=performance.now();
  // 20 wall-clock seconds; crossing x=180 in both directions scrolls the camera.
  while(performance.now()-wallStart<20000) {
    await page.keyboard.down('KeyA'); await page.waitForFunction(() => CoinQuest.game.player.x<100); await page.keyboard.up('KeyA');
    await page.keyboard.down('KeyD'); await page.waitForFunction(() => CoinQuest.game.player.x>320); await page.keyboard.up('KeyD');
  }
  await page.evaluate(() => { __observe.recording=false; });
  const wallMs=performance.now()-wallStart;
  const heapAfter=(await cdp.send('Runtime.getHeapUsage')).usedSize;
  const continuousMusic=await musicState(page);
  assert.equal(continuousMusic.sources.length,1); assert.equal(continuousMusic.live,1);
  assert.equal(continuousMusic.max,1);
  assert.ok(await page.evaluate(()=>__observe.gains[0].context.currentTime-__observe.sources.find(s=>s.loop).time>16));
  report.continuousMusic=continuousMusic;
  const samples=await page.evaluate(() => __observe.samples);
  const intervals=samples.slice(1).map((s,i)=>s.timestamp-samples[i].timestamp);
  assert.ok(wallMs>=20000 && samples.length>300);
  assert.ok(samples.every(s=>s.state==='play' && s.tiles===samples[0].tiles && s.tiles>200 && s.draws>40));
  assert.ok(samples.filter(s=>Math.abs(s.vx)>1).length/samples.length>.8);
  assert.equal((await state(page)).lives,3);
  report.performance={ wallMs, measuredRafSpanMs:samples.at(-1).timestamp-samples[0].timestamp,
    frames:samples.length, physicsTicks:samples.at(-1).physicsFrame-samples[0].physicsFrame,
    physicsHz:(samples.at(-1).physicsFrame-samples[0].physicsFrame)*1000/(samples.at(-1).timestamp-samples[0].timestamp),
    rafIntervalMs:distribution(intervals), updateMs:distribution(samples.map(s=>s.updateMs)),
    updateOnTickFramesMs:distribution(samples.filter(s=>s.physicsSteps>0).map(s=>s.updateMs)),
    presentationMs:distribution(samples.map(s=>s.presentationMs)), totalCallbackMs:distribution(samples.map(s=>s.totalMs)),
    drawImageCalls:distribution(samples.map(s=>s.draws)), movingFraction:samples.filter(s=>Math.abs(s.vx)>1).length/samples.length,
    fullTerrainTiles:samples[0].tiles, heapBeforeBytes:heapBefore, heapAfterBytes:heapAfter,
    notes:'20+ seconds of trusted-key back-and-forth movement with camera scroll, original terrain/entities and sound. Normal rAF/performance.now clocks; no virtual time. Update includes fixed-clock/input work. Presentation = full callback minus update, including Canvas submission, audio and HUD; not GPU/compositor time. Costs include observation overhead and timer quantization. Heap includes test samples; no GC forced, not a leak test. Headless Chromium is not proof of display FPS on every device.' };
  fs.writeFileSync(path.join(OUT,'performance-samples.json'),JSON.stringify(samples)+'\n');
  await page.keyboard.up('KeyD'); await page.close(); report.checks.push('20+ second realtime performance measurement');
});

test('mobile viewport, touch hold/release/cancel and resize preserve the game', async () => {
  const page=await open({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  await page.getByRole('button',{name:'Start adventure',exact:true}).tap();
  const right=page.locator('[data-control="TouchRight"]');
  assert.ok(await right.isVisible());
  const box=await right.boundingBox();
  const cdp=await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:box.x+box.width/2,y:box.y+box.height/2}]});
  await page.waitForFunction(() => CoinQuest.game.player.x>130);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await page.waitForFunction(() => CoinQuest.game.player.vx===0);
  const stopped=await state(page); await frames(page,6); near((await state(page)).x,stopped.x,'touch release');
  const jump=await page.locator('[data-control="TouchJump"]').boundingBox();
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:jump.x+jump.width/2,y:jump.y+jump.height/2}]});
  await page.waitForFunction(() => CoinQuest.game.player.vy>5);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});
  assert.equal(await page.evaluate(() => CoinQuest.controls.sample().jump),false);
  await page.waitForFunction(() => CoinQuest.game.player.grounded);
  await screenshot(page,'07-mobile.png','real emulated touch input; no fixture');
  const layouts=[];
  for(const viewport of [{width:390,height:844},{width:844,height:390},{width:320,height:568}]) {
    await page.setViewportSize(viewport); await frames(page);
    const layout=await page.evaluate(() => {
      const c=document.querySelector('canvas').getBoundingClientRect(),r=document.querySelector('#touch-controls').getBoundingClientRect();
      return {width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,
        canvas:{x:c.x,y:c.y,width:c.width,height:c.height},touchBottom:r.bottom};
    });
    assert.ok(layout.scrollWidth<=viewport.width,'no horizontal overflow'); near(layout.canvas.width/layout.canvas.height,4/3,'canvas aspect',.01);
    assert.ok(layout.canvas.x>=0 && layout.canvas.x+layout.canvas.width<=viewport.width);
    assert.ok(layout.touchBottom<=viewport.height,`controls fit viewport: ${JSON.stringify(layout)}`); layouts.push(layout);
    if(viewport.width===844) await screenshot(page,'08-mobile-landscape.png','actual resize after touch play; no fixture');
  }
  report.mobile=layouts; await page.close(); report.checks.push('mobile touch and portrait/landscape resizing');
});

test('no console/page errors, failed requests or external networking in successful game runs', () => {
  assert.deepEqual(report.errors,[]); assert.deepEqual(report.failedRequests,[]); assert.deepEqual(report.externalRequests,[]);
  report.checks.push('zero console/page errors, failed requests or external requests');
});

test('invalid embedded assets show an actionable reload screen (isolated failure fixtures)', async () => {
  report.expectedFailureFixtures=[];
  for(const mode of ['missing image','wrong dimensions','missing music','missing grassland','missing underground','missing castle']) {
    const context=await browser.newContext({viewport:report.viewport,offline:true});
    await context.addInitScript(mode => {
      let data;
      Object.defineProperty(window,'COIN_QUEST_DATA',{configurable:true,get:()=>data,set:value=>{
        data=value;
        if(mode==='missing image') delete data.images.player_idle;
        else if(mode==='wrong dimensions') data.images.player_idle.width++;
        else if(mode==='missing music') delete data.music;
        else delete data.music.tracks[mode.split(' ')[1]];
      }});
    },mode);
    const page=await context.newPage(),errors=[],exceptions=[];
    page.on('console',m=>{if(m.type()==='error') errors.push(m.text());});
    page.on('pageerror',e=>exceptions.push(e.message));
    await page.goto(URL); await page.waitForFunction(()=>document.querySelector('#game').dataset.state==='error');
    assert.equal(await page.locator('#screen-title').textContent(),'COULD NOT LOAD');
    assert.match(await page.locator('#screen-subtitle').textContent(),mode==='missing image'?/Missing embedded image: player_idle/:mode==='wrong dimensions'?/Image dimensions do not match: player_idle/:/Missing or invalid embedded music/);
    assert.equal(await page.locator('#pause-button').isDisabled(),true);
    assert.equal(await page.evaluate(()=>Boolean(window.CoinQuest?.ready)),false);
    await Promise.all([page.waitForEvent('load'),page.getByRole('button',{name:'Reload',exact:true}).click()]);
    await page.waitForFunction(()=>document.querySelector('#game').dataset.state==='error');
    assert.equal(errors.length,2); assert.deepEqual(exceptions,[]);
    report.expectedFailureFixtures.push({mode,expectedConsoleErrors:errors.length});
    await context.close();
  }
  report.checks.push('six isolated asset-failure/reload fixtures; expected errors separate from normal runs');
});

test('native asset integrity records match all published images, effects and tracks', () => {
  const integrity=JSON.parse(fs.readFileSync(path.join(ROOT,'assets/native-integrity.json'),'utf8'));
  let count=0;
  for(const group of ['images','sounds','music']) {
    for(const {path:file,sha256} of Object.values(integrity[group])) {
      assert.equal(hash(fs.readFileSync(path.join(ROOT,file))),sha256,file); count++;
    }
  }
  assert.equal(count,37);
  assert.equal(hash(fs.readFileSync(path.join(ROOT,'dist/index.html'))),report.sha256);
  report.preservedNativeAssets=count;
});
