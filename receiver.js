// Runs on the TV. The iPad listens and sends audio analysis; the visuals are drawn here,
// so there is no video stream and only network delay between the music and the picture.
'use strict';

const NAMESPACE = 'urn:x-cast:com.klenke.graphomat';
const params = new URLSearchParams(location.search);
const isDemo = params.has('demo');

const PALETTES = {
  paper: { background: [0.875, 0.860, 0.830], line: [0.13, 0.13, 0.13] },
  dark: { background: [0.055, 0.055, 0.06], line: [0.88, 0.87, 0.84] },
  phosphor: { background: [0.10, 0.115, 0.11], line: [0.96, 0.97, 0.88] },
};
const SILENCE = { bands: new Array(16).fill(0), bass: 0, mid: 0, high: 0, energy: 0, onset: 0, onsetCount: 0, tempoBPM: 0, tempoConfidence: 0, state: 'idle' };

const canvas = document.getElementById('stage');
const captionEl = document.getElementById('caption');
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
  uniform vec2 viewport;
  uniform float reach;
  uniform float cap;
  varying vec2 local;
  varying float len;
  varying float light;
  void main() {
    vec2 delta = b - a;
    len = max(length(delta), 0.0001);
    vec2 dir = delta / len;
    vec2 normal = vec2(-dir.y, dir.x);
    local = vec2(corner.x * (len + 2.0 * cap) - cap, corner.y * reach);
    vec2 pixel = a + dir * local.x + normal * local.y;
    light = alpha;
    gl_Position = vec4(pixel.x / viewport.x * 2.0 - 1.0, 1.0 - pixel.y / viewport.y * 2.0, 0.0, 1.0);
  }`));
gl.attachShader(program, compile(gl.FRAGMENT_SHADER, `
  precision highp float;
  uniform float halfWidth;
  uniform float penTip;
  uniform vec3 color;
  varying vec2 local;
  varying float len;
  varying float light;
  void main() {
    float c;
    if (penTip > 0.5) {
      float h = clamp(local.x, 0.0, len);
      c = clamp(halfWidth + 0.5 - length(local - vec2(h, 0.0)), 0.0, 1.0);
    } else {
      c = exp(-2.5 * local.y * local.y / (halfWidth * halfWidth));
    }
    c *= light;
    gl_FragColor = vec4(color * c, c);
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
for (const [name, size, offset] of [['a', 2, 0], ['b', 2, 8], ['alpha', 1, 16]]) {
  const location = gl.getAttribLocation(program, name);
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, size, gl.FLOAT, false, 20, offset);
  gl.vertexAttribDivisor(location, 1);
}
gl.enable(gl.BLEND);

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

function draw(now) {
  const elapsed = last ? now - last : 16.7;
  last = now;
  const dt = Math.min(elapsed / 1000, 0.1);

  frameAverage += (elapsed - frameAverage) * 0.02;
  if (frameAverage > 21) lines.detail = Math.max(0.5, lines.detail - 0.001);
  else if (frameAverage < 17.5) lines.detail = Math.min(1, lines.detail + 0.0002);

  if (isDemo) audio = demoFeatures(now / 1000);
  // A lost iPad must leave the visual drifting calmly, not frozen on its last loud frame.
  else if (now - lastAudioTime > 3000) audio = { ...SILENCE, onsetCount: audio.onsetCount };

  preset.update(dt, audio, song);
  lines.clear();
  preset.emit(lines);
  if (config.plotter) {
    plotterProgress = Math.min(1, plotterProgress + dt / 25);
    lines.truncate(plotterProgress);
  }

  const isInk = preset.style === 'ink';
  const palette = isInk ? (PALETTES[config.appearance] || PALETTES.paper) : PALETTES.phosphor;
  const minimumSide = Math.min(width, height);
  const halfWidth = Math.max(0.6, minimumSide / (isInk ? 1050 : 700));
  gl.uniform1f(uniform('halfWidth'), halfWidth);
  gl.uniform1f(uniform('reach'), halfWidth + 1);
  gl.uniform1f(uniform('cap'), isInk ? halfWidth + 1 : 0);
  gl.uniform1f(uniform('penTip'), isInk ? 1 : 0);
  gl.uniform3fv(uniform('color'), palette.line);
  if (isInk) gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  else gl.blendFunc(gl.ONE, gl.ONE);
  gl.clearColor(palette.background[0], palette.background[1], palette.background[2], 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, lines.data.subarray(0, lines.count * 5));
  gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, lines.count);

  captionEl.style.color = !isInk || config.appearance === 'dark' ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.8)';
  window.lastLineCount = lines.count;
  requestAnimationFrame(draw);
}

function showCaption(next) {
  song = next;
  captionEl.textContent = next.title;
  const artist = document.createElement('small');
  artist.textContent = next.artist;
  captionEl.appendChild(artist);
  captionEl.style.opacity = config.captions ? 1 : 0;
  clearTimeout(captionTimer);
  captionTimer = setTimeout(() => { captionEl.style.opacity = 0; }, 12000);
}

function handle(message, reply) {
  switch (message.t) {
    case 'f':
      audio = {
        bands: message.b, bass: message.ba, mid: message.m, high: message.h, energy: message.e,
        onset: message.o, onsetCount: message.c, tempoBPM: message.bpm, tempoConfidence: message.conf, state: message.s,
      };
      lastAudioTime = performance.now();
      break;
    case 'config': {
      const changed = message.preset !== config.preset;
      Object.assign(config, message);
      if (!config.plotter) plotterProgress = 0;
      if (!config.captions) captionEl.style.opacity = 0;
      if (changed) rebuild();
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
