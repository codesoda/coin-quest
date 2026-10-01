/* Native Web Audio effects and serial scene music lifecycle. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  class SoundBank {

    constructor() {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      try { this.context = AudioContext ? new AudioContext() : null; }
      catch (_) { this.context = null; }
      this.buffers = Object.create(null);
      this.playing = new Set();
      this.lastPlay = Object.create(null);
      this.pending = [];
      this.muted = false;
      this.gesture = false;
      this.active = false;
      this.sleeping = false;
      this.offsets = Object.create(null);
      this.theme = 'grassland';
      this.musicEpoch = 0;
      this.musicBuffers = Object.create(null);
      this.musicSource = null;
      if (this.context) {
        this.gain = this.context.createGain();
        this.gain.gain.value = 0.22;
        this.gain.connect(this.context.destination);
        this.musicGain = this.context.createGain();
        this.musicGain.gain.value = 0;
        this.musicGain.connect(this.context.destination);
      } else this.notice('Audio is unavailable in this browser. You can still play.');
    }
    notice(message) { $('audio-notice').textContent = message; $('audio-notice').hidden = false; }
    async load(sounds, music) {
      if (!this.context) return;
      const decode = async (name, sound) => {
        if (!/^data:audio\/(?:wav|x-wav|wave);base64,/.test(sound.src)) throw new Error('Invalid embedded sound: ' + name);
        const binary = atob(sound.src.slice(sound.src.indexOf(',') + 1));
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return this.context.decodeAudioData(bytes.buffer);
      };
      this.music = music;
      await Promise.all([
        ...Object.entries(sounds).map(async ([name, sound]) => { this.buffers[name] = await decode(name, sound); }),
        ...Object.entries(music.tracks).map(async ([theme, track]) => {
          this.musicBuffers[theme] = await decode('music:' + theme, track);
        })
      ]);
    }
    ramp(gain, value, duration = 0.02) {
      const now = this.context.currentTime;
      gain.gain.cancelAndHoldAtTime(now);
      gain.gain.linearRampToValueAtTime(value, now + duration);
    }
    unlock() {
      const c = this.context;
      if (!c || document.hidden) return Promise.resolve();
      this.gesture = true; this.sleeping = false;
      clearTimeout(this.sleepTimer);
      if (this.resuming) return this.resuming;
      // Await resume without delaying input or physics. Only a gesture calls this.
      this.resuming = Promise.resolve().then(() => c.state === 'running' ? undefined : c.resume()).then(() => {
        if (this.sleeping || document.hidden) { this.pending.length = 0; this.sleep(); return; }
        if (c.state !== 'running') return;
        $('audio-notice').hidden = true;
        const pending = this.pending.splice(0);
        for (const cue of pending) if (performance.now() - cue.at < 250) this.play(cue.name);
        this.syncMusic();
      }).catch(() => {
        this.pending.length = 0;
        this.notice('Sound is blocked. Use the Sound button to try again.');
      }).finally(() => { this.resuming = null; });
      return this.resuming;
    }
    stopEffects() {
      this.pending.length = 0;
      this.lastPlay = Object.create(null);
      if (!this.context) return;
      this.ramp(this.gain, 0);
      for (const source of this.playing) {
        try { source.stop(this.context.currentTime + 0.02); } catch (_) { /* Already ended. */ }
      }
    }
    setTheme(theme) {
      // Unknown scene IDs deliberately fall back to the default, never undefined.
      const next = Object.hasOwn(this.music?.tracks || {}, theme) ? theme : 'grassland';
      if (next === this.theme) return;
      this.stopMusic(false, 0.15);
      this.theme = next;
      this.musicEpoch++;
      this.offsets[next] = 0; // Entering a scene begins its arrangement, not an old visit.
      // setActive follows this call; no intermediate start with stale game state.
    }
    stopMusic(reset = false, fade = 0.02) {
      const source = this.musicSource, run = this.musicRun;
      if (source) {
        const stopAt = this.context.currentTime + fade;
        if (!this.musicStopping || stopAt < run.stopAt) {
          // A pause/mute can shorten an in-flight scene fade. Never move a stop later.
          if (run.epoch === this.musicEpoch) {
            this.offsets[run.theme] = (run.offset + stopAt - run.started) % run.duration;
          }
          run.stopAt = stopAt;
          this.musicStopping = true;
          this.ramp(this.musicGain, 0, fade);
          source.stop(stopAt);
          // Retain the slot until ended, even through rapid scene/mute/restart changes.
        }
      }
      if (reset) {
        this.musicEpoch++;
        this.offsets = Object.create(null);
        this.theme = 'grassland';
      }
    }
    stop(reset = false) {
      this.active = false;
      this.stopEffects(); this.stopMusic(reset);
    }
    suspendWhenQuiet() {
      // Stop deadlines use the audio clock, not wall time. Wait for native ended
      // events before suspending, even if the audio device takes longer than 30ms.
      if (this.sleeping && this.context && !this.musicSource && !this.playing.size) {
        this.context.suspend().catch(() => this.notice('Could not suspend audio. Sound remains muted.'));
      }
    }
    sleep() {
      this.sleeping = true; this.stop();
      clearTimeout(this.sleepTimer);
      this.sleepTimer = setTimeout(() => this.suspendWhenQuiet(), 30);
    }
    setActive(active) {
      this.active = active;
      this.syncMusic();
    }
    syncMusic() {
      const c = this.context;
      if (!this.active || this.muted || this.sleeping || document.hidden) { this.stopMusic(); return; }
      if (!c || !this.gesture || c.state !== 'running' || !this.musicBuffers[this.theme] || this.musicSource) return;
      const track = this.music.tracks[this.theme];
      const source = c.createBufferSource();
      source.buffer = this.musicBuffers[this.theme]; source.loop = true;
      source.loopStart = track.loopStart; source.loopEnd = track.loopEnd;
      source.connect(this.musicGain);
      this.musicSource = source; this.musicStopping = false;
      this.musicRun = { theme: this.theme, epoch: this.musicEpoch, started: c.currentTime,
        offset: this.offsets[this.theme] || 0, duration: track.loopEnd, stopAt: Infinity };
      source.onended = () => {
        source.disconnect();
        if (this.musicSource === source) { this.musicSource = null; this.musicRun = null; this.musicStopping = false; this.syncMusic(); }
        this.suspendWhenQuiet();
      };
      this.musicGain.gain.cancelScheduledValues(c.currentTime);
      this.musicGain.gain.setValueAtTime(0, c.currentTime);
      this.ramp(this.musicGain, 0.10, 0.15);
      source.start(this.musicRun.started, this.musicRun.offset);
    }
    toggle() {
      this.muted = !this.muted;
      if (this.muted) { this.stopEffects(); this.stopMusic(); }
      else { this.unlock(); this.syncMusic(); }
      const muteButton = document.getElementById('mute-button');
      window.CoinQuestUI.buttonLabel(muteButton, this.muted ? 'Sound off' : 'Sound on', 'M');
      muteButton.setAttribute('aria-pressed', String(this.muted));
    }
    play(name) {
      const c = this.context;
      if (!c || !this.gesture || this.sleeping || document.hidden || this.muted || !this.buffers[name]) return;
      if (c.state !== 'running') {
        // Bounded, short-lived unlock queue; stale cues never burst after a long pause.
        if (this.pending.length < 8) this.pending.push({ name, at: performance.now() });
        return;
      }
      const now = c.currentTime;
      // Catch-up steps may deliver separate pickups in one callback. Space them,
      // don't discard them based on wall-clock time. Limit latency and polyphony.
      const when = Math.max(now, (this.lastPlay[name] ?? -Infinity) + 0.04);
      if (when > now + 0.25) return;
      this.lastPlay[name] = when;
      if (this.playing.size >= 8) {
        const oldest = this.playing.values().next().value;
        oldest.stop(); this.playing.delete(oldest);
      }
      this.ramp(this.gain, 0.22);
      const source = c.createBufferSource();
      source.buffer = this.buffers[name]; source.connect(this.gain);
      source.onended = () => { this.playing.delete(source); source.disconnect(); this.suspendWhenQuiet(); };
      this.playing.add(source); source.start(when);
    }
  }

  window.CoinQuestAudio = SoundBank;
})();
