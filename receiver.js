// Runs on the TV. The iPad listens and sends audio analysis; the visuals are drawn here,
// so there is no video stream and only network delay between the music and the picture.
'use strict';

const NAMESPACE = 'urn:x-cast:com.klenke.graphomat';
const params = new URLSearchParams(location.search);
const isDemo = params.has('demo');

const PALETTES = {
  paper: { background: [0.875, 0.860, 0.830], line: [0.13, 0.13, 0.13] },
  dark: { background: [0.055, 0.055, 0.06], line: [0.88, 0.87, 0.84] },
};
const SILENCE = { bands: new Array(16).fill(0), bass: 0, mid: 0, high: 0, energy: 0, onset: 0, onsetCount: 0, tempoBPM: 0, tempoConfidence: 0, state: 'idle' };

const canvas = document.getElementById('stage');
const captionEl = document.getElementById('caption');
const lyricEl = document.getElementById('lyric');
const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'high-performance' });

const config = {
  preset: params.get('preset') || 'hommage',
  appearance: params.get('appearance') || 'paper',
  plotter: false,
  captions: true,
  seed: 1965,
};
let audio = SILENCE;
let lastAudioTime = 0;
let song = null;
let captionTimer = null;
let lyricsData = null;
let outlineWords = [];
let lyricPosition = null;

function compile(type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
  return shader;
}

const program = gl.createProgram();
gl.attachShader(program, compile(gl.VERTEX_SHADER, `
  attribute vec2 corner;
  attribute vec2 a;
  attribute vec2 b;
  attribute float alpha;
  attribute float lineWidth;
  attribute vec4 tint;
  uniform vec2 viewport;
  uniform float halfWidth;
  uniform vec3 color;
  varying vec2 local;
  varying float len;
  varying float light;
  varying float lineHalfWidth;
  varying vec3 shade;
  void main() {
    vec2 delta = b - a;
    len = max(length(delta), 0.0001);
    vec2 dir = delta / len;
    vec2 normal = vec2(-dir.y, dir.x);
    lineHalfWidth = halfWidth * lineWidth;
    float reach = lineHalfWidth + 1.0;
    shade = tint.a > 0.5 ? tint.rgb : color;
    local = vec2(corner.x * (len + 2.0 * reach) - reach, corner.y * reach);
    vec2 pixel = a + dir * local.x + normal * local.y;
    light = alpha;
    gl_Position = vec4(pixel.x / viewport.x * 2.0 - 1.0, 1.0 - pixel.y / viewport.y * 2.0, 0.0, 1.0);
  }`));
gl.attachShader(program, compile(gl.FRAGMENT_SHADER, `
  precision highp float;
  varying vec2 local;
  varying float len;
  varying float light;
  varying float lineHalfWidth;
  varying vec3 shade;
  void main() {
    float h = clamp(local.x, 0.0, len);
    float c = clamp(lineHalfWidth + 0.5 - length(local - vec2(h, 0.0)), 0.0, 1.0) * light;
    gl_FragColor = vec4(shade * c, c);
  }`));
gl.linkProgram(program);
if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
gl.useProgram(program);

const uniform = name => gl.getUniformLocation(program, name);
const cornerBuffer = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuffer);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 1, -1, 0, 1, 1, 1]), gl.STATIC_DRAW);
const cornerLocation = gl.getAttribLocation(program, 'corner');
gl.enableVertexAttribArray(cornerLocation);
gl.vertexAttribPointer(cornerLocation, 2, gl.FLOAT, false, 0, 0);

const lines = new LineBuffer(40000);
const lineBuffer = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, lineBuffer);
gl.bufferData(gl.ARRAY_BUFFER, lines.data.byteLength, gl.DYNAMIC_DRAW);
const LINE_BYTES = LINE_WORDS * 4;
for (const [name, size, offset, type, normalized] of [
  ['a', 2, 0, gl.FLOAT, false], ['b', 2, 8, gl.FLOAT, false], ['alpha', 1, 16, gl.FLOAT, false],
  ['lineWidth', 1, 20, gl.FLOAT, false], ['tint', 4, 24, gl.UNSIGNED_BYTE, true],
]) {
  const location = gl.getAttribLocation(program, name);
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, size, type, normalized, LINE_BYTES, offset);
  gl.vertexAttribDivisor(location, 1);
}
gl.enable(gl.BLEND);
gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

let preset = null;
let width = 0, height = 0;

function rebuild() {
  width = canvas.width = Math.round(innerWidth * Math.min(devicePixelRatio || 1, 2));
  height = canvas.height = Math.round(innerHeight * Math.min(devicePixelRatio || 1, 2));
  gl.viewport(0, 0, width, height);
  gl.uniform2f(uniform('viewport'), width, height);
  preset = new (PRESETS[config.preset] || Hommage)(config.seed, width, height);
  plotterProgress = 0;
}

let plotterProgress = 0;
// Eases detail down if the TV falls behind, and back up when it recovers.
let frameAverage = 16.7;
let last = 0;

const INTRO_SECONDS = MARK_DURATION + 0.5, INTRO_FADE = 0.6;
const skipIntro = params.has('nointro');
let firstFrame = 0;

function draw(now) {
  if (!firstFrame) firstFrame = now;
  const elapsed = last ? now - last : 16.7;
  last = now;
  const dt = Math.min(elapsed / 1000, 0.1);

  frameAverage += (elapsed - frameAverage) * 0.02;
  if (frameAverage > 21) lines.detail = Math.max(0.5, lines.detail - 0.001);
  else if (frameAverage < 17.5) lines.detail = Math.min(1, lines.detail + 0.0002);

  if (isDemo) audio = demoFeatures(now / 1000);
  // A lost iPad must leave the visual drifting calmly, not frozen on its last loud frame.
  else if (now - lastAudioTime > 3000) audio = { ...SILENCE, onsetCount: audio.onsetCount };

  if (preset.updateLyrics) {
    const age = (now - lastAudioTime) / 1000;
    preset.updateLyrics(lyricsData, isDemo ? demoLyricTime(now) : lyricPosition === null ? null : lyricPosition + age);
  }
  preset.update(dt, audio, song);
  lines.clear();
  // The pen plots the logo first, then it fades as the visual fades in, both on the paper color.
  const introTime = (now - firstFrame) / 1000;
  const inIntro = !skipIntro && introTime < INTRO_SECONDS + INTRO_FADE;
  const fade = clamp((introTime - INTRO_SECONDS) / INTRO_FADE, 0, 1);
  if (inIntro) {
    emitMark(lines, width, height, introTime);
    for (let i = 0, n = lines.count * LINE_WORDS; i < n; i += LINE_WORDS) lines.data[i + 4] *= 1 - fade;
  }
  const markCount = lines.count;
  if (!inIntro || fade > 0) preset.emit(lines);
  if (inIntro) for (let i = markCount * LINE_WORDS, n = lines.count * LINE_WORDS; i < n; i += LINE_WORDS) lines.data[i + 4] *= fade;
  if (config.plotter) {
    plotterProgress = Math.min(1, plotterProgress + dt / 25);
    lines.truncate(plotterProgress);
  }

  const palette = inIntro ? PALETTES.paper : PALETTES[config.appearance] || PALETTES.paper;
  const halfWidth = Math.max(0.6, Math.min(width, height) / (inIntro && fade === 0 ? 390 : 1050));
  gl.uniform1f(uniform('halfWidth'), halfWidth);
  gl.uniform3fv(uniform('color'), palette.line);
  gl.clearColor(palette.background[0], palette.background[1], palette.background[2], 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, lines.data.subarray(0, lines.count * LINE_WORDS));
  gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, lines.count);

  styleCaption(palette, config.appearance === 'dark');
  window.lastLineCount = lines.count;
  requestAnimationFrame(draw);
}

// The plate uses the visual's own background color, so the caption reads like a label on a print.
let captionPalette = null;
function styleCaption(palette, isDark) {
  if (palette === captionPalette) return;
  captionPalette = palette;
  const [r, g, b] = palette.background.map(value => Math.round(value * 255));
  captionEl.style.background = `rgba(${r},${g},${b},0.92)`;
  captionEl.style.color = isDark ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.85)';
  lyricEl.style.background = captionEl.style.background;
  lyricEl.style.color = captionEl.style.color;
}

function showCaption(next) {
  song = next;
  // The lyrics screen writes the title itself.
  if (config.preset === 'lyrik') { captionEl.style.opacity = 0; return; }
  captionEl.textContent = next.title;
  const artist = document.createElement('small');
  artist.textContent = next.artist;
  captionEl.appendChild(artist);
  captionEl.style.opacity = config.captions ? 1 : 0;
  clearTimeout(captionTimer);
  captionTimer = setTimeout(() => { captionEl.style.opacity = 0; }, 12000);
}

function showLyric(line, next) {
  lyricEl.textContent = line;
  if (next) {
    const nextEl = document.createElement('small');
    nextEl.textContent = next;
    lyricEl.appendChild(nextEl);
  }
  lyricEl.style.opacity = line || next ? 1 : 0;
}

function handle(message, reply) {
  switch (message.t) {
    case 'lyric':
      showLyric(message.line, message.next);
      break;
    case 'outlines':
      if (message.start === 0) outlineWords = [];
      message.words.forEach((word, index) => { outlineWords[message.start + index] = decodeOutlineWord(word); });
      break;
    case 'lyrics':
      message.words = outlineWords;
      lyricsData = message;
      break;
    case 'f':
      audio = {
        bands: message.b, bass: message.ba, mid: message.m, high: message.h, energy: message.e,
        onset: message.o, onsetCount: message.c, tempoBPM: message.bpm, tempoConfidence: message.conf, state: message.s,
      };
      lastAudioTime = performance.now();
      lyricPosition = message.lp >= 0 ? message.lp : null;
      break;
    case 'config': {
      const changed = message.preset !== config.preset;
      Object.assign(config, message);
      if (!config.plotter) plotterProgress = 0;
      if (!config.captions) captionEl.style.opacity = 0;
      if (changed) {
        rebuild();
        if (song) showCaption(song);
      }
      break;
    }
    case 'song':
      showCaption({ id: `${message.title}|${message.artist}`.toLowerCase(), title: message.title, artist: message.artist });
      break;
    case 'ping':
      reply({ t: 'pong', id: message.id, lines: lines.count, detail: lines.detail, frameMs: frameAverage, awake: awakeStatus() });
      break;
  }
}

function demoLyricTime(now) { return now / 1000; }

function demoFeatures(time) {
  const beat = time * 2, phase = beat - Math.floor(beat);
  const kick = Math.exp(-phase * 5);
  const bands = [];
  for (let i = 0; i < 16; i++) bands.push(Math.max(0, (i < 5 ? kick : 0.35 + 0.3 * Math.sin(time * 0.7 + i))));
  return {
    bands, bass: kick, mid: 0.45 + 0.25 * Math.sin(time * 0.4), high: 0.3 + 0.2 * Math.sin(time * 1.3), energy: 0.35 + 0.2 * kick,
    onset: kick, onsetCount: Math.floor(beat), tempoBPM: 120, tempoConfidence: 1, state: 'music',
  };
}

// Google TV's screensaver starts after inactivity unless media is playing or the page holds the
// screen awake. No Cast document says which works for a receiver, so this does both and reports them.
let wakeLock = null;
let wakeLockError = 'not requested';
let keepAwakeVideo = null;
let keepAwakeError = '';

async function requestWakeLock() {
  if (!navigator.wakeLock) { wakeLockError = 'unsupported'; return; }
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLockError = '';
    wakeLock.addEventListener('release', () => { wakeLock = null; wakeLockError = 'released'; });
  } catch (error) {
    wakeLockError = error.name;
  }
}

function startKeepAwakeVideo() {
  const source = document.createElement('canvas');
  source.width = source.height = 2;
  const context2d = source.getContext('2d');
  let tick = 0;
  // A captured stream only produces frames while its canvas changes.
  setInterval(() => {
    context2d.fillStyle = tick++ % 2 ? '#000' : '#010101';
    context2d.fillRect(0, 0, 2, 2);
  }, 1000);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = source.captureStream(1);
  video.style.cssText = 'position:fixed;right:0;bottom:0;width:2px;height:2px;opacity:0.01';
  document.body.appendChild(video);
  video.play().catch(error => { keepAwakeError = error.name; });
  keepAwakeVideo = video;
}

function awakeStatus() {
  const lock = wakeLock && !wakeLock.released ? 'lock on' : `lock off (${wakeLockError})`;
  const video = keepAwakeVideo && !keepAwakeVideo.paused ? 'video playing' : `video off (${keepAwakeError || 'paused'})`;
  return `${lock}, ${video}`;
}
window.awakeStatus = awakeStatus;

// A wake lock is dropped whenever the page is hidden, so take it again on return.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !wakeLock) requestWakeLock();
});
requestWakeLock();
startKeepAwakeVideo();
setInterval(() => {
  if (!wakeLock) requestWakeLock();
  if (keepAwakeVideo && keepAwakeVideo.paused) keepAwakeVideo.play().catch(error => { keepAwakeError = error.name; });
}, 30000);

window.addEventListener('resize', rebuild);

if (window.cast && cast.framework && !isDemo) {
  const context = cast.framework.CastReceiverContext.getInstance();
  context.addCustomMessageListener(NAMESPACE, event => {
    handle(event.data, data => context.sendCustomMessage(NAMESPACE, event.senderId, data));
  });
  const options = new cast.framework.CastReceiverOptions();
  options.disableIdleTimeout = true;
  options.customNamespaces = { [NAMESPACE]: cast.framework.system.MessageType.JSON };
  context.addEventListener(cast.framework.system.EventType.SENDER_DISCONNECTED, event => {
    // Stop only when asked to. A dropped iPad leaves the visual running on the wall.
    if (event.reason === cast.framework.system.DisconnectReason.REQUESTED_BY_SENDER && context.getSenders().length === 0) {
      context.stop();
    }
  });
  context.start(options);
}

rebuild();
requestAnimationFrame(draw);
