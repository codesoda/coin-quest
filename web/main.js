/* Offline Canvas2D presentation. All assets arrive inline in COIN_QUEST_DATA. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const root = $('game'), canvas = $('canvas'), screen = $('screen');
  const title = $('screen-title'), subtitle = $('screen-subtitle');
  const copy = $('screen-copy'), hint = $('screen-hint'), kicker = $('screen-kicker');
  const primary = $('primary-button'), secondary = $('secondary-button');
  const pauseButton = $('pause-button'), muteButton = $('mute-button');
  const themeNames = { grassland: 'Grassland', underground: 'Underground', castle: 'Castle' };
  let game, clock, controls, ctx, audio, ready = false, lastState = '';
  let primaryAction = null, secondaryAction = null;
  const images = Object.create(null), sprites = Object.create(null);
  const hudKeys = ['lives', 'coins', 'score', 'level'];
  const hudValues = { lives: null, coins: null, score: null, level: null };
  const hudNodes = { lives: $('hud-lives'), coins: $('hud-coins'), score: $('hud-score'), level: $('hud-level') };
  // Bind before loading so even an early data/Canvas failure has a reload action.
  primary.addEventListener('click', () => { if (audio) audio.unlock(); if (primaryAction) primaryAction(); });
  secondary.addEventListener('click', () => { if (audio) audio.unlock(); if (secondaryAction) secondaryAction(); });

  function loadImage(name, asset) {
    return new Promise((resolve, reject) => {
      if (!asset.src.startsWith('data:image/png;base64,')) { reject(new Error('Invalid embedded image: ' + name)); return; }
      const image = new Image();
      image.onload = () => {
        if (image.naturalWidth !== asset.width || image.naturalHeight !== asset.height) {
          reject(new Error('Image dimensions do not match: ' + name)); return;
        }
        images[name] = image;
        const scale = asset.drawHeight ? asset.drawHeight / asset.height :
          asset.drawWidth ? asset.drawWidth / asset.width : 1;
        sprites[name] = { image, w: asset.width * scale, h: asset.height * scale,
          ax: asset.anchor[0] * scale, ay: asset.anchor[1] * scale };
        resolve();
      };
      image.onerror = () => reject(new Error('Could not load embedded image: ' + name));
      image.src = asset.src;
    });
  }

  function focusGame() { root.focus({ preventScroll: true }); }
  function resetInput() { controls.clear(); clock.reset(); }
  function restart() { resetInput(); audio.stop(true); game.restart(); focusGame(); updateUI(); }
  function resume() { resetInput(); game.resume(); focusGame(); updateUI(); }
  function togglePause() {
    if (!ready) return;
    resetInput();
    if (game.state === 'paused') game.resume();
    else game.pause();
    audio.stop(); focusGame(); updateUI();
  }
  function showHelp() {
    if (!ready) return;
    resetInput(); audio.stop();
    if (game.state === 'instructions') game.closeInstructions();
    else game.instructions();
    focusGame(); updateUI();
  }
  function leaveHelp() {
    game.closeInstructions();
    if (game.state === 'paused') resume();
    else restart();
  }
  function action(button, text, fn) {
    button.textContent = text; button.hidden = !fn;
    if (button === primary) primaryAction = fn;
    else secondaryAction = fn;
  }
  function updateUI() {
    audio.setTheme(game.level.theme);
    audio.setActive(game.state === 'play' || game.state === 'transition');
    const level = (game.levelIndex + 1) + ' / ' + game.data.levels.length;
    for (const key of hudKeys) {
      const value = key === 'level' ? level : game[key];
      if (hudValues[key] !== value) { hudNodes[key].textContent = value; hudValues[key] = value; }
    }
    if (lastState === game.state) return;
    lastState = game.state;
    root.dataset.state = game.state;
    screen.hidden = game.state === 'play';
    pauseButton.disabled = !['play', 'paused', 'transition'].includes(game.state);
    window.CoinQuestUI.buttonLabel(pauseButton, game.state === 'paused' ? 'Resume' : 'Pause', 'P');
    action(primary, '', null); action(secondary, '', null);
    copy.replaceChildren(); hint.textContent = ''; kicker.textContent = 'A SMALL HERO. A LONG ADVENTURE.';
    switch (game.state) {
      case 'title':
        title.textContent = 'Coin Quest';
        subtitle.textContent = 'Three familiar lands. One small hero.';
        window.CoinQuestUI.paragraphs(copy, 'Cross Grassland, Underground, and Castle.', 'Collect coins. Stomp enemies. Reach every banner.');
        action(primary, 'Start adventure', restart); action(secondary, 'How to play', showHelp);
        hint.textContent = 'ENTER / SPACE to start · I for instructions';
        break;
      case 'instructions':
        title.textContent = 'HOW TO PLAY'; subtitle.textContent = 'Same world. Native play.';
        window.CoinQuestUI.paragraphs(copy, '← → or A / D move. Space / ↑ jumps.', 'Hold jump for height. Tap for a short hop.', 'Hit STAR blocks from below. Catch the ACORN to grow.', 'Stomp enemies from above. Avoid spikes and gaps.', 'Pennants save your place. You have three lives.', 'P / Esc pauses · M mutes music and effects · R restarts everything.');
        action(primary, game.instructionsReturn === 'paused' ? 'Back to game' : 'Start adventure', leaveHelp);
        action(secondary, 'Back', showHelp);
        hint.textContent = 'ENTER to continue · I / ESC to go back';
        break;
      case 'paused':
        title.textContent = 'PAUSED'; subtitle.textContent = 'Take a breath. Your adventure can wait.';
        action(primary, 'Resume', resume); action(secondary, 'How to play', showHelp);
        hint.textContent = 'P / ESC / ENTER to resume · R to restart';
        break;
      case 'transition':
        kicker.textContent = 'ON TO THE NEXT LAND';
        title.textContent = themeNames[game.level.theme].toUpperCase();
        subtitle.textContent = 'Level ' + (game.levelIndex + 1) + ' of ' + game.data.levels.length;
        hint.textContent = 'Get ready…';
        break;
      case 'gameover':
        title.textContent = 'TRY AGAIN'; subtitle.textContent = 'Every adventure starts with a small hop.';
        window.CoinQuestUI.paragraphs(copy, 'Use full jumps to cross gaps.', 'Find a growth acorn for an extra hit.');
        action(primary, 'Try again', restart); action(secondary, 'How to play', showHelp);
        hint.textContent = 'ENTER / SPACE / R for a new adventure';
        break;
      case 'victory':
        title.textContent = 'YOU DID IT!'; subtitle.textContent = 'Three lands crossed. The banner is yours.';
        window.CoinQuestUI.paragraphs(copy, '' + game.coins + ' coins · ' + game.score + ' points · ' + game.lives + ' lives left', 'Play again to find the coins you missed.');
        action(primary, 'Play again', restart); action(secondary, 'How to play', showHelp);
        hint.textContent = 'ENTER / SPACE / R to play again';
        break;
    }
  }

  const lerp = (a, b, alpha) => a + (b - a) * alpha;
  function sprite(name, x, feet, camera, scale = 1, face = 1) {
    if (x < camera - 96 || x > camera + 576) return;
    const s = sprites[name];
    if (!s) return;
    const sx = x - camera, sy = 180 - feet;
    if (face < 0) {
      ctx.save(); ctx.translate(sx, sy); ctx.scale(-1, 1);
      ctx.drawImage(s.image, -s.ax * scale, -s.ay * scale, s.w * scale, s.h * scale);
      ctx.restore();
    } else ctx.drawImage(s.image, sx - s.ax * scale, sy - s.ay * scale, s.w * scale, s.h * scale);
  }
  function render(alpha) {
    const level = game.level, p = game.player;
    const camera = lerp(game.prevCamera, game.camera, alpha);
    ctx.drawImage(images['backdrop_' + level.theme], 0, 0, 480, 360);
    // Fewer than 60 visible tiles: cull direct objects rather than clone/list work.
    for (const tile of level.tiles) {
      if (tile.x < camera - 32 || tile.x > camera + 512) continue;
      const name = tile.kind === 'bonus_block' && level.geometry[tile.geom - 1].state ? 'used_block' : tile.kind;
      sprite(name, tile.x, tile.y, camera);
    }
    for (const spike of level.spikes) sprite('spike', spike.x + spike.w / 2, spike.y, camera);
    sprite('checkpoint', level.checkpoint.x, level.checkpoint.y, camera);
    if (game.checkpointActive && Math.abs(level.checkpoint.x - camera - 240) < 280) {
      ctx.fillStyle = '#ffe18b'; ctx.font = 'bold 8px monospace'; ctx.textAlign = 'center';
      ctx.fillText('SAVED', level.checkpoint.x - camera, 180 - level.checkpoint.y - 70);
    }
    sprite('flag', level.flag.x, level.flag.y, camera);
    const coinName = game.frame % 16 < 8 ? 'coin1' : 'coin2';
    for (const coin of level.coins) if (coin.state === 1) sprite(coinName, coin.x, coin.y, camera);
    for (const power of level.powers) if (power.state === 1) {
      sprite('powerup', lerp(power.prevX, power.x, alpha), lerp(power.prevY, power.y, alpha), camera);
    }
    for (const enemy of level.enemies) if (enemy.state === 1) {
      const name = enemy.kind + (game.frame % 20 < 10 ? '1' : '2');
      sprite(name, lerp(enemy.prevX, enemy.x, alpha), enemy.y, camera, 1, enemy.dir);
    }
    if (!p.invulnerable || p.invulnerable % 6 >= 3) {
      const name = p.invulnerable ? 'player_hurt' : !p.grounded ? 'player_jump' :
        Math.abs(p.vx) > 0.2 ? (game.frame % 12 < 6 ? 'player_run1' : 'player_run2') : 'player_idle';
      // Player frames share one canvas and anchor, including hurt and growth.
      sprite(name, lerp(p.prevX, p.x, alpha), lerp(p.prevY, p.y, alpha), camera, p.grown ? 1.5 : 1, p.face);
    }
  }

  function frame(timestamp) {
    if (!ready) return;
    try {
      const active = game.state === 'play' || game.state === 'transition';
      clock.advance(timestamp, () => {
        game.step(controls.sample());
        return game.state === 'play' || game.state === 'transition';
      }, active);
      for (const event of game.events) audio.play(event);
      game.events.length = 0;
      render(active ? clock.alpha : 1);
      updateUI();
      requestAnimationFrame(frame);
    } catch (error) { fail(error); }
  }
  function suspend() {
    if (!ready) return;
    resetInput(); game.pause(); audio.sleep(); updateUI();
  }
  function resize() {
    const touch = matchMedia('(pointer: coarse)').matches ? 72 : 0;
    const availableWidth = Math.max(240, window.innerWidth - 24);
    // Short landscape screens need compact chrome, not a minimum 240px stage
    // that pushes the touch controls below the viewport (see matching CSS).
    const compact = window.innerHeight <= 500;
    const availableHeight = Math.max(120, window.innerHeight - (compact ? 150 : 175 + touch));
    const ratio = Math.min(availableWidth / 480, availableHeight / 360, 3);
    // Prefer whole pixels at desktop sizes; shrink without cropping on phones.
    const scale = ratio >= 1 ? Math.floor(ratio) : ratio;
    root.style.setProperty('--game-width', Math.floor(480 * scale) + 'px');
  }
  function bindControls() {
    const relevant = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'Space', 'KeyA', 'KeyD',
      'Enter', 'KeyR', 'KeyI', 'KeyP', 'Escape', 'KeyM']);
    window.addEventListener('keydown', event => {
      if (!root.contains(document.activeElement) || !relevant.has(event.code) || event.ctrlKey || event.metaKey || event.altKey) return;
      // Keep native button keyboard activation accessible when tabbing the UI.
      if (event.target.tagName === 'BUTTON' && (event.code === 'Space' || event.code === 'Enter')) return;
      event.preventDefault(); audio.unlock();
      if (!ready || event.repeat || !controls.press(event.code)) return;
      switch (event.code) {
        case 'KeyR': restart(); break;
        case 'KeyM': audio.toggle(); break;
        case 'KeyI': showHelp(); break;
        case 'Escape': if (game.state === 'instructions') showHelp(); else togglePause(); break;
        case 'KeyP': togglePause(); break;
        case 'Enter':
          if (game.state === 'paused') resume();
          else if (primaryAction) primaryAction();
          break;
        case 'Space': case 'ArrowUp':
          if (['title', 'gameover', 'victory'].includes(game.state)) restart();
          break;
      }
    });
    window.addEventListener('keyup', event => { controls.release(event.code); });
    window.addEventListener('blur', suspend);
    document.addEventListener('visibilitychange', () => { if (document.hidden) suspend(); else clock.reset(); });
    root.addEventListener('focusout', event => { if (!root.contains(event.relatedTarget)) suspend(); });
    root.addEventListener('pointerdown', () => audio.unlock());
    canvas.addEventListener('pointerdown', focusGame);
    $('help-button').addEventListener('click', showHelp);
    pauseButton.addEventListener('click', () => { audio.unlock(); togglePause(); });
    muteButton.addEventListener('click', () => { audio.toggle(); focusGame(); });
    for (const button of document.querySelectorAll('[data-control]')) {
      const code = button.dataset.control;
      button.addEventListener('pointerdown', event => {
        event.preventDefault(); focusGame(); audio.unlock();
        if (!ready) return;
        button.setPointerCapture(event.pointerId); controls.press(code);
      });
      const release = () => controls.release(code);
      button.addEventListener('pointerup', release);
      button.addEventListener('pointercancel', release);
      button.addEventListener('lostpointercapture', release);
      button.addEventListener('contextmenu', event => event.preventDefault());
    }
  }
  function fail(error) {
    ready = false; root.dataset.state = 'error';
    if (audio) audio.stop();
    screen.hidden = false; title.textContent = 'COULD NOT LOAD';
    kicker.textContent = 'Coin Quest'; subtitle.textContent = error.message || String(error);
    copy.textContent = 'The game needs its original embedded data and assets. Rebuild the HTML file and open it again.';
    hint.textContent = 'No network connection is needed.';
    action(primary, 'Reload', () => location.reload()); action(secondary, '', null);
    pauseButton.disabled = true;
    console.error('Coin Quest:', error);
  }
  async function initialize() {
    let timeout;
    try {
      ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) throw new Error('Canvas2D is not available in this browser.');
      ctx.imageSmoothingEnabled = false;
      const data = window.COIN_QUEST_DATA;
      game = new window.CoinQuestCore.Game(data);
      clock = new window.CoinQuestCore.FixedClock(); controls = new window.CoinQuestCore.Controls();
      audio = new window.CoinQuestAudio(); bindControls();
      resize(); window.addEventListener('resize', resize);
      const required = ['player_idle', 'player_run1', 'player_run2', 'player_jump', 'player_hurt',
        'enemy_walker1', 'enemy_walker2', 'enemy_shell1', 'enemy_shell2', 'coin1', 'coin2', 'powerup',
        'flag', 'checkpoint', 'spike', 'platform', 'ground_grass', 'ground_dirt', 'ground_stone',
        'bonus_block', 'used_block', 'backdrop_grassland', 'backdrop_underground', 'backdrop_castle'];
      for (const name of required) if (!data.images?.[name]) throw new Error('Missing embedded image: ' + name);
      for (const name of ['jump', 'coin', 'stomp', 'damage', 'powerup', 'grow', 'checkpoint', 'gameover', 'victory']) {
        if (!data.sounds?.[name]) throw new Error('Missing embedded sound: ' + name);
      }
      if (data.music?.defaultTheme !== 'grassland') throw new Error('Missing or invalid embedded music');
      for (const theme of Object.keys(themeNames)) {
        const track = data.music.tracks?.[theme];
        if (!track?.src || track.theme !== theme || track.loopStart !== 0 || !(track.loopEnd > 0)) {
          throw new Error('Missing or invalid embedded music: ' + theme);
        }
      }
      await Promise.race([
        Promise.all([audio.load(data.sounds, data.music), ...Object.entries(data.images).map(([name, asset]) => loadImage(name, asset))]),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Embedded resources took too long to load.')), 12000); })
      ]);
      ready = true;
      // Public simulation objects support inspection and tests, not a second game.
      window.CoinQuest = Object.freeze({ game, clock, controls, ready: true });
      updateUI(); focusGame(); render(1); requestAnimationFrame(frame);
    } catch (error) { fail(error); }
    finally { clearTimeout(timeout); }
  }
  initialize();
})();
