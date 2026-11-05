// The visuals, ported from Packages/Presets. Geometry only; receiver.js draws it.
'use strict';

class SeededRandom {
  constructor(seed) { this.state = seed >>> 0; }
  unit() {
    this.state = (this.state + 0x6D2B79F5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(low, high) { return low + (high - low) * this.unit(); }
  int(low, high) { return low + Math.floor(this.unit() * (high - low + 1)); }
}

function driftNoise(t, seed) {
  const hash = i => {
    let x = Math.imul(i, 0x9E3779B1) ^ Math.imul(seed, 0x85EBCA77);
    x ^= x >>> 15;
    x = Math.imul(x, 0xC2B2AE3D);
    x ^= x >>> 13;
    return (x & 0xFFFF) / 32767.5 - 1;
  };
  const floorT = Math.floor(t);
  const f = t - floorT;
  const s = f * f * (3 - 2 * f);
  return hash(floorT) * (1 - s) + hash(floorT + 1) * s;
}

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

// Words per line: a, b, alpha, width, then a color packed with red in the low byte.
const LINE_WORDS = 7;
const lineColor = hex => (((hex >> 16) & 0xFF) | (hex & 0xFF00) | ((hex & 0xFF) << 16) | 0xFF000000) >>> 0;

class LineBuffer {
  constructor(capacity) {
    this.data = new Float32Array(capacity * LINE_WORDS);
    this.packed = new Uint32Array(this.data.buffer);
    this.capacity = capacity;
    this.count = 0;
    this.detail = 1;
  }
  clear() { this.count = 0; }
  line(ax, ay, bx, by, alpha = 1, color = 0, width = 1) {
    if (alpha <= 0.001 || this.count >= this.capacity) return;
    const n = this.count++ * LINE_WORDS, d = this.data;
    d[n] = ax; d[n + 1] = ay; d[n + 2] = bx; d[n + 3] = by; d[n + 4] = alpha; d[n + 5] = width;
    this.packed[n + 6] = color;
  }
  stroke(ax, ay, bx, by, reveal, alpha = 1) {
    if (reveal <= 0) return;
    if (reveal >= 1) this.line(ax, ay, bx, by, alpha);
    else this.line(ax, ay, ax + (bx - ax) * reveal, ay + (by - ay) * reveal, alpha);
  }
  circle(cx, cy, radius, alpha = 1, sides = 72) {
    let px = cx + radius, py = cy;
    for (let i = 1; i <= sides; i++) {
      const angle = i / sides * 2 * Math.PI;
      const nx = cx + Math.cos(angle) * radius, ny = cy + Math.sin(angle) * radius;
      this.line(px, py, nx, ny, alpha);
      px = nx; py = ny;
    }
  }
  truncate(fraction) {
    if (fraction >= 1) return;
    const exact = this.count * Math.max(0, fraction);
    const whole = Math.floor(exact);
    if (whole >= this.count) return;
    const n = whole * LINE_WORDS, d = this.data, partial = exact - whole;
    d[n + 2] = d[n] + (d[n + 2] - d[n]) * partial;
    d[n + 3] = d[n + 1] + (d[n + 3] - d[n + 1]) * partial;
    this.count = whole + 1;
  }
}

class Schotter {
  constructor(seed, width, height) {
    this.random = new SeededRandom(seed);
    const landscape = width >= height;
    this.columns = landscape ? 22 : 12;
    this.rows = landscape ? 12 : 22;
    this.cell = Math.min(width * 0.86 / this.columns, height * 0.86 / this.rows);
    this.startX = (width - this.cell * this.columns) / 2;
    this.startY = (height - this.cell * this.rows) / 2;
    this.disorder = 0.3;
    this.lastOnset = 0;
    this.squares = [];
    for (let i = 0; i < this.columns * this.rows; i++) {
      const ox = this.random.range(-1, 1), oy = this.random.range(-1, 1), turn = this.random.range(-1, 1);
      this.squares.push({ ox, oy, turn, tx: ox, ty: oy, tt: turn });
    }
  }
  update(dt, audio) {
    const reach = 0.18 + audio.energy * 1.5 + audio.bass * 0.5;
    this.disorder += (reach - this.disorder) * (1 - Math.exp(-dt / (reach > this.disorder ? 0.05 : 0.6)));
    if (audio.onsetCount !== this.lastOnset) {
      this.lastOnset = audio.onsetCount;
      for (let i = 0, n = 4 + Math.floor(audio.onset * 24); i < n; i++) {
        const s = this.squares[this.random.int(0, this.squares.length - 1)];
        s.tx = this.random.range(-1, 1); s.ty = this.random.range(-1, 1); s.tt = this.random.range(-1, 1);
      }
    }
    const follow = 1 - Math.exp(-dt / 0.18);
    for (const s of this.squares) {
      s.ox += (s.tx - s.ox) * follow; s.oy += (s.ty - s.oy) * follow; s.turn += (s.tt - s.turn) * follow;
    }
  }
  emit(lines) {
    const count = this.squares.length, radius = this.cell * 0.5 * Math.SQRT2;
    this.squares.forEach((s, index) => {
      const column = Math.floor(index / this.rows), row = index % this.rows;
      const progress = index / count * this.disorder;
      const cx = this.startX + (column + 0.5) * this.cell + s.ox * this.cell * 0.5 * progress;
      const cy = this.startY + (row + 0.5) * this.cell + s.oy * this.cell * 0.5 * progress;
      let angle = Math.PI / 4 * (1 + s.turn * progress);
      let px = cx + Math.cos(angle) * radius, py = cy + Math.sin(angle) * radius;
      for (let i = 0; i < 4; i++) {
        angle += Math.PI / 2;
        const nx = cx + Math.cos(angle) * radius, ny = cy + Math.sin(angle) * radius;
        lines.line(px, py, nx, ny);
        px = nx; py = ny;
      }
    });
  }
}

class Hommage {
  constructor(seed, width, height) {
    this.width = width; this.height = height;
    this.margin = Math.min(width, height) * 0.035;
    this.bandCount = 9;
    this.minimumWidth = 0.022;
    this.columnCount = 5 + Math.round(width / height * 4);
    this.random = new SeededRandom(seed);
    const widthCount = this.bandCount * (this.columnCount + 1);
    this.buckle = new Float32Array(widthCount);
    this.buckleSpeed = new Float32Array(widthCount);
    this.targetColumnX = this.makeColumns();
    this.columnX = this.targetColumnX.slice();
    this.targetWidth = this.makeWidths();
    this.baseWidth = this.targetWidth.slice();
    this.cells = [];
    for (let i = 0; i < this.bandCount * this.columnCount; i++) this.cells.push(this.rollCell(1));
    this.circles = [];
    for (let i = 0, n = this.random.int(4, 7); i < n; i++) this.addCircle(1);
    this.time = 0; this.density = 0.5; this.shiver = 0; this.pulse = 0;
    this.lastOnset = 0; this.quietTime = 0; this.hasRecomposed = false; this.songID = null;
  }
  makeColumns() {
    const steps = [];
    for (let i = 0; i < this.columnCount; i++) steps.push(Math.pow(this.random.unit(), 1.6) + 0.12);
    const total = steps.reduce((a, b) => a + b, 0);
    let x = 0;
    const result = [0];
    for (const step of steps) { x += step / total; result.push(x); }
    result[this.columnCount] = 1;
    return result;
  }
  makeWidths() {
    const widths = new Array(this.bandCount * (this.columnCount + 1));
    for (let band = 0; band < this.bandCount; band++) {
      const base = this.random.range(0.05, 0.19);
      for (let column = 0; column <= this.columnCount; column++) {
        widths[band * (this.columnCount + 1) + column] = base + this.random.range(-0.018, 0.018);
      }
    }
    return widths;
  }
  rollCell(reveal) {
    const r = this.random, roll = r.unit();
    const cell = { fill: roll < 0.3 ? 0 : roll < 0.62 ? 1 : 2, marks: [], reveal, delay: 0 };
    const center = r.range(0.25, 0.75), spread = r.range(0.2, 0.5);
    if (cell.fill === 1) {
      for (let i = 0, n = r.int(8, 20); i < n; i++) cell.marks.push({ x: r.unit(), y: 0, z: 0, top: true });
      cell.marks.sort((a, b) => a.x - b.x);
    } else if (cell.fill === 2) {
      for (let i = 0, n = r.int(5, 13); i < n; i++) {
        const apex = clamp(center + r.range(-spread, spread), 0, 1);
        const base = center + r.range(-spread, spread) * 0.8;
        const foot = clamp(base + r.range(-spread, spread), 0, 1);
        cell.marks.push({ x: apex, y: clamp(base, 0, 1), z: foot, top: r.unit() < 0.5 });
      }
    }
    return cell;
  }
  addCircle(alpha) {
    const r = this.random, side = Math.min(this.width, this.height);
    const radius = side * (r.unit() < 0.2 ? r.range(0.004, 0.012) : r.range(0.03, 0.11));
    const inset = radius * 1.16 + this.margin;
    this.circles.push({ x: r.range(inset, this.width - inset), y: r.range(inset, this.height - inset), radius, alpha, targetAlpha: 1 });
  }
  recompose() {
    this.targetColumnX = this.makeColumns();
    this.targetWidth = this.makeWidths();
    for (const cell of this.cells) cell.delay = this.random.range(0.01, 9);
  }
  update(dt, audio, song) {
    this.time += dt;
    const follow = 1 - Math.exp(-dt / 4);
    this.columnX.forEach((x, i) => { this.columnX[i] = x + (this.targetColumnX[i] - x) * follow; });
    this.baseWidth.forEach((w, i) => { this.baseWidth[i] = w + (this.targetWidth[i] - w) * follow; });
    this.density += (0.35 + audio.mid - this.density) * (1 - Math.exp(-dt / 0.12));
    this.shiver = audio.high;
    this.pulse *= Math.exp(-dt / 0.22);
    for (let i = 0; i < this.buckle.length; i++) {
      const drift = driftNoise(this.time * 0.11 + i * 0.37, i) * 0.018;
      const push = driftNoise(this.time * 0.45 + i * 1.3, i + 91) * audio.bass * 0.05;
      const force = 38 * (drift + push - this.buckle[i]) - 5.5 * this.buckleSpeed[i];
      this.buckleSpeed[i] += force * dt;
      this.buckle[i] += this.buckleSpeed[i] * dt;
    }
    if (audio.onsetCount !== this.lastOnset) {
      this.lastOnset = audio.onsetCount;
      for (let i = 0, n = 1 + Math.floor(audio.onset * 3); i < n; i++) {
        this.cells[this.random.int(0, this.cells.length - 1)] = this.rollCell(0);
      }
      for (let i = 0; i < this.buckleSpeed.length; i++) {
        this.buckleSpeed[i] += this.random.range(-1, 1) * audio.bass * audio.onset * 0.35;
      }
      if (audio.onset > 0.6) {
        this.pulse = 1;
        if (this.random.unit() < 0.12) {
          if (this.circles.length < 8) this.addCircle(0);
          else this.circles[this.random.int(0, this.circles.length - 1)].targetAlpha = 0;
        }
      }
    }
    this.cells.forEach((cell, i) => {
      if (cell.delay > 0) {
        cell.delay -= dt;
        if (cell.delay <= 0) { this.cells[i] = cell = this.rollCell(0); }
      }
      if (cell.reveal < 1) cell.reveal = Math.min(1, cell.reveal + dt / 0.7);
    });
    for (const c of this.circles) c.alpha += (c.targetAlpha - c.alpha) * (1 - Math.exp(-dt / 0.8));
    this.circles = this.circles.filter(c => !(c.targetAlpha === 0 && c.alpha < 0.01));

    this.quietTime = audio.state === 'music' ? 0 : this.quietTime + dt;
    if (audio.state === 'music') this.hasRecomposed = false;
    if (this.quietTime > 8 && !this.hasRecomposed) { this.hasRecomposed = true; this.recompose(); }
    if (song && song.id !== this.songID) {
      if (this.songID !== null) this.recompose();
      this.songID = song.id;
    }
  }
  // Widths stay positive and rescale to fill the frame, so bands can't cross.
  boundaries(column) {
    const edges = new Array(this.bandCount + 1);
    edges[0] = 0;
    for (let band = 0; band < this.bandCount; band++) {
      const i = band * (this.columnCount + 1) + column;
      edges[band + 1] = edges[band] + Math.max(this.minimumWidth, this.baseWidth[i] + this.buckle[i]);
    }
    const total = edges[this.bandCount], height = this.height - this.margin * 2;
    return edges.map(e => this.margin + e / total * height);
  }
  emit(lines) {
    const { margin, columnCount, bandCount } = this;
    const width = this.width - margin * 2, bottomY = this.height - margin;
    const xs = this.columnX.map(x => margin + x * width);
    const edges = [];
    for (let column = 0; column <= columnCount; column++) edges.push(this.boundaries(column));
    for (let column = 0; column < columnCount; column++) {
      for (let b = 0; b <= bandCount; b++) lines.line(xs[column], edges[column][b], xs[column + 1], edges[column + 1][b]);
    }
    lines.line(xs[0], margin, xs[0], bottomY);
    lines.line(xs[columnCount], margin, xs[columnCount], bottomY);

    const markScale = this.density * lines.detail;
    for (let band = 0; band < bandCount; band++) {
      for (let column = 0; column < columnCount; column++) {
        const cell = this.cells[band * columnCount + column];
        if (cell.fill === 0) continue;
        const lx = xs[column], rx = xs[column + 1];
        const tl = edges[column][band], tr = edges[column + 1][band];
        const bl = edges[column][band + 1], br = edges[column + 1][band + 1];
        const px = u => lx + (rx - lx) * u;
        const ty = u => tl + (tr - tl) * u;
        const by = u => bl + (br - bl) * u;
        lines.line(lx, tl, lx, bl);
        lines.line(rx, tr, rx, br);
        const count = Math.max(1, Math.min(cell.marks.length, Math.floor(cell.marks.length * markScale + 0.5)));
        for (let i = 0; i < count; i++) {
          const mark = cell.marks[i];
          const reveal = clamp((cell.reveal - i / count * 0.7) / 0.3, 0, 1);
          if (cell.fill === 1) {
            lines.stroke(px(mark.x), ty(mark.x), px(mark.x), by(mark.x), reveal);
          } else {
            const apex = mark.x + driftNoise(this.time * 9 + i, band * 31 + column) * this.shiver * 0.035;
            const tipY = mark.top ? ty(apex) : by(apex);
            const foot = mark.top ? by : ty;
            lines.stroke(px(apex), tipY, px(mark.y), foot(mark.y), reveal);
            lines.stroke(px(apex), tipY, px(mark.z), foot(mark.z), reveal);
          }
        }
      }
    }
    for (const c of this.circles) lines.circle(c.x, c.y, c.radius * (1 + this.pulse * 0.16), c.alpha);
  }
}

class Korridor {
  constructor(seed, width, height) {
    this.seed = seed;
    this.chunkLength = 2; this.chunkCount = 11; this.beatSpacing = 0.5;
    // Grids laid over each other. Their cells don't line up, so the outlines cross. The finer ones appear later.
    this.wallGrids = [[17, 14], [23, 19], [31, 25]]; this.layerDelay = 0.12; this.bandReach = 0.22;
    // Only the first grid continues past this depth, so the distance doesn't fill up with ink.
    this.detailDepth = 9; this.detailFade = 3;
    this.near = 0.18; this.railCount = 8; this.boxStretch = 1.7;
    this.floorDepth = 6; this.floorFade = 1;
    // How much narrower the floor gets per unit ahead, on top of the perspective. Its rails lean inwards.
    this.floorTaper = 0.08;
    this.cx = width / 2; this.cy = height * 0.54;
    const aspect = width / height;
    // The print is portrait. Landscape canvases get a somewhat wider corridor, not a stretched one.
    this.halfWidth = aspect >= 1 ? Math.sqrt(aspect) : 1;
    this.halfHeight = aspect >= 1 ? 1 : 1 / aspect;
    this.focal = Math.min(width / this.halfWidth, height / this.halfHeight) * 0.42;
    this.cameraZ = 0; this.speed = 0.1; this.corrosion = 0.25; this.branch = 0;
    this.bands = new Array(16).fill(0);
    this.lastOnset = 0; this.onsets = 0;
    this.chunks = [];
    this.refreshChunks();
  }
  refreshChunks() {
    const first = Math.floor(this.cameraZ / this.chunkLength);
    // The chunk just passed stays, because its boxes can reach into the next one.
    this.chunks = this.chunks.filter(c => c.index >= first - 1 && c.index < first + this.chunkCount);
    for (let index = first; index < first + this.chunkCount; index++) {
      if (!this.chunks.some(c => c.index === index)) this.chunks.push(this.makeChunk(index));
    }
  }
  makeChunk(index) {
    const r = new SeededRandom((this.seed + Math.imul(index, 0x01B3)) | 0);
    const boxes = [];
    for (let i = 0, n = r.int(6, 11); i < n; i++) {
      // Mostly small, sometimes tall. Some sit against the previous box, so they gather in groups.
      const tall = r.unit();
      const sx = r.range(0.05, 0.22), sy = 0.06 + tall * tall * 0.5, sz = r.range(0.08, 0.5);
      let x = r.range(-0.65, 0.65) * this.halfWidth;
      let y = this.halfHeight * r.range(0.3, 0.95);
      let z = (index + r.unit()) * this.chunkLength;
      const last = boxes[boxes.length - 1];
      if (r.unit() < 0.4 && last) {
        x = last.x + r.range(-0.2, 0.2); y = last.y + r.range(-0.25, 0.25); z = last.z + r.range(-0.3, 0.3);
      }
      // High enough that the band stretch never brings it down to the floor grid's level.
      y = Math.max(y, sy * this.boxStretch / 2 + 0.03);
      boxes.push({ x, y, z, sx, sy, sz, band: r.int(0, 15) });
    }
    const wall = side => this.wallGrids.map(([rows, columns], layer) => ({
      rows, columns, order: this.corrode(r, rows, columns, this.wallMask(rows, columns, index, layer, side)),
    }));
    const left = wall(0);
    return { index, boxes, left, right: wall(1) };
  }
  // 0...1, drifting smoothly along a position. The same anywhere for the same key, so it joins up across chunks.
  wander(position, spacing, key) {
    const knot = i => new SeededRandom((this.seed + Math.imul(key, 0x9E3779B1) + Math.imul(i, 0x01B3)) | 0).unit();
    const index = Math.floor(position / spacing), t = position / spacing - index;
    return knot(index) + (knot(index + 1) - knot(index)) * (t * t * (3 - 2 * t));
  }
  // Where a wall grid may erode. The rows have no fixed limits: their edges drift along the corridor, and
  // differently on each grid and wall, so outlines don't line up. A bare band always stays around eye level.
  // Heights are -1...1, floor to ceiling.
  wallMask(rows, columns, chunk, layer, side) {
    const key = layer * 8 + side * 32 + 64;
    const startZ = chunk * this.chunkLength;
    const open = new Array(rows * columns).fill(false);
    const cuts = [];
    for (let row = 0; row < rows; row++) {
      const y = (row + 0.5) / rows * 2 - 1, cut = columns * 0.25;
      cuts.push([Math.floor(this.wander(y, 0.25, key + 4) * cut), Math.floor(this.wander(y, 0.25, key + 5) * cut)]);
    }
    for (let column = 0; column < columns; column++) {
      const z = startZ + (column + 0.5) / columns * this.chunkLength;
      const floorEdge = -1 + 0.22 * this.wander(z, 0.7, key);
      const lowerTop = -0.28 + 0.28 * this.wander(z, 0.5, key + 1);
      const upperBottom = 0.16 + 0.32 * this.wander(z, 0.5, key + 2);
      const ceiling = 1 - 0.22 * this.wander(z, 0.7, key + 3);
      for (let row = 0; row < rows; row++) {
        if (column < cuts[row][0] || column >= columns - cuts[row][1]) continue;
        const y = (row + 0.5) / rows * 2 - 1;
        open[row * columns + column] = (y >= floorEdge && y <= lowerTop) || (y >= upperBottom && y <= ceiling);
      }
    }
    return open;
  }
  // Each cell records how soon the erosion reached it, from 0 to 1 over the whole wall,
  // so the full range of corrosion levels changes something.
  corrode(r, rows, columns, open) {
    const order = new Float32Array(rows * columns).fill(Infinity);
    const frontier = [];
    // Both rows start somewhere, so neither can come out empty.
    const cells = [];
    for (let i = 0; i < open.length; i++) if (open[i]) cells.push(i);
    const middle = Math.floor(rows / 2);
    for (const group of [cells.filter(c => Math.floor(c / columns) < middle), cells.filter(c => Math.floor(c / columns) >= middle)]) {
      if (!group.length) continue;
      for (let i = 0, n = r.int(1, 2); i < n; i++) {
        const cell = group[r.int(0, group.length - 1)];
        order[cell] = 0;
        frontier.push(cell);
      }
    }
    let step = 0;
    while (frontier.length && step < rows * columns) {
      const cell = frontier.splice(r.int(0, frontier.length - 1), 1)[0];
      const row = Math.floor(cell / columns), column = cell % columns;
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (r.unit() >= 0.62) continue;
        const nr = row + dr, nc = column + dc;
        if (nr < 0 || nr >= rows || nc < 0 || nc >= columns || !open[nr * columns + nc]) continue;
        const neighbor = nr * columns + nc;
        if (order[neighbor] !== Infinity) continue;
        step++;
        order[neighbor] = step;
        frontier.push(neighbor);
      }
    }
    if (step > 0) for (let i = 0; i < order.length; i++) if (order[i] !== Infinity) order[i] /= step;
    return order;
  }
  update(dt, audio) {
    const target = audio.state === 'music'
      ? (audio.tempoConfidence > 0.3 ? audio.tempoBPM / 60 : 1.2 + audio.energy) * this.beatSpacing
      : audio.state === 'quiet' ? 0.05 : 0.02;
    this.speed += (target - this.speed) * (1 - Math.exp(-dt / 1.2));
    this.cameraZ += this.speed * dt;
    // Stays well below 1: fully grown, the erosion closes into one plain outline.
    const corrosion = 0.2 + audio.energy * 0.35;
    this.corrosion += (corrosion - this.corrosion) * (1 - Math.exp(-dt / (corrosion > this.corrosion ? 0.25 : 1.2)));
    this.branch *= Math.exp(-dt / 0.5);
    const follow = 1 - Math.exp(-dt / 0.14);
    for (let i = 0; i < 16; i++) this.bands[i] += (audio.bands[i] - this.bands[i]) * follow;
    if (audio.onsetCount !== this.lastOnset) {
      this.lastOnset = audio.onsetCount;
      this.onsets++;
      this.branch = Math.max(this.branch, audio.onset * 0.15);
    }
    this.refreshChunks();
  }
  // Clips against the near plane, projects, and fades lines into the distance.
  draw(lines, ax, ay, az, bx, by, bz, fade = 1) {
    const plane = this.cameraZ + this.near;
    if (az < plane && bz < plane) return;
    if (az < plane) { const t = (plane - az) / (bz - az); ax += (bx - ax) * t; ay += (by - ay) * t; az = plane; }
    else if (bz < plane) { const t = (plane - bz) / (az - bz); bx += (ax - bx) * t; by += (ay - by) * t; bz = plane; }
    const far = (this.chunkCount - 1) * this.chunkLength;
    const alpha = clamp((1 - (Math.min(az, bz) - this.cameraZ) / far) * 3, 0, 1) * fade;
    const da = az - this.cameraZ, db = bz - this.cameraZ;
    lines.line(this.cx + ax / da * this.focal, this.cy - ay / da * this.focal,
               this.cx + bx / db * this.focal, this.cy - by / db * this.focal, alpha);
  }
  emit(lines) {
    const far = this.cameraZ + (this.chunkCount - 1) * this.chunkLength;
    const floorY = -this.halfHeight, floorX = this.halfWidth * 0.86;
    // The floor ends well before the vanishing point, and new cross lines fade in there.
    const floorEnd = this.cameraZ + this.floorDepth;
    for (let rail = 0; rail < this.railCount; rail++) {
      const x = (rail / (this.railCount - 1) * 2 - 1) * floorX;
      this.draw(lines, x, floorY, this.cameraZ, x * (1 - this.floorTaper * this.floorDepth), floorY, floorEnd);
    }
    // Each cross line runs past the rails by its own amount, which keeps the edge of the floor rough.
    const railGap = 2 * floorX / (this.railCount - 1);
    for (let z = Math.ceil(this.cameraZ / this.beatSpacing) * this.beatSpacing; z < floorEnd; z += this.beatSpacing) {
      const r = new SeededRandom((this.seed + 0x5851 + Math.imul(Math.round(z / this.beatSpacing), 0x01B3)) | 0);
      const left = railGap * r.range(0.2, 0.9), right = railGap * r.range(0.2, 0.9);
      const taper = 1 - this.floorTaper * (z - this.cameraZ);
      const fade = Math.min(1, (floorEnd - z) / this.floorFade);
      this.draw(lines, (-floorX - left) * taper, floorY, z, (floorX + right) * taper, floorY, z, fade);
    }
    for (const chunk of this.chunks) {
      for (const box of chunk.boxes) this.drawBox(lines, box);
      const flicker = (chunk.index + this.onsets) % 3 === 0 ? this.branch : 0;
      // Each stretch of wall also follows its own band, so the sound moves along the corridor.
      const band = ((chunk.index * 5) % 16 + 16) % 16, opposite = (band + 8) % 16;
      this.drawWall(lines, chunk.left, chunk.index, -this.halfWidth,
        (this.corrosion + this.bands[band] * this.bandReach) * lines.detail + flicker);
      this.drawWall(lines, chunk.right, chunk.index, this.halfWidth,
        (this.corrosion + this.bands[opposite] * this.bandReach) * lines.detail + flicker);
    }
  }
  drawBox(lines, box) {
    const hx = box.sx / 2, hy = box.sy * (1 + this.bands[box.band] * (this.boxStretch - 1)) / 2, hz = box.sz / 2;
    const { x, y, z } = box;
    for (const dz of [-hz, hz]) {
      this.draw(lines, x - hx, y - hy, z + dz, x + hx, y - hy, z + dz);
      this.draw(lines, x + hx, y - hy, z + dz, x + hx, y + hy, z + dz);
      this.draw(lines, x + hx, y + hy, z + dz, x - hx, y + hy, z + dz);
      this.draw(lines, x - hx, y + hy, z + dz, x - hx, y - hy, z + dz);
    }
    for (const [dx, dy] of [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]]) {
      this.draw(lines, x + dx, y + dy, z - hz, x + dx, y + dy, z + hz);
    }
  }
  // Outlines each corroded region: an edge is drawn only where a cell and its neighbor differ.
  drawWall(lines, layers, chunk, x, level) {
    const startZ = chunk * this.chunkLength;
    layers.forEach((layer, index) => {
      if (index > 0 && startZ - this.cameraZ > this.detailDepth) return;
      const { rows, columns, order } = layer;
      const layerLevel = level - index * this.layerDelay;
      const cellZ = this.chunkLength / columns, cellY = this.halfHeight * 2 / rows;
      const on = (r, c) => r >= 0 && r < rows && c >= 0 && c < columns && order[r * columns + c] <= layerLevel;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < columns; c++) {
          if (!on(r, c)) continue;
          const y0 = -this.halfHeight + r * cellY, y1 = y0 + cellY;
          const z0 = startZ + c * cellZ, z1 = z0 + cellZ;
          let fade = 1;
          // The lower row ends with the floor, fading in the same way.
          if (y0 < 0) fade = Math.min(1, (this.cameraZ + this.floorDepth - z1) / this.floorFade);
          if (index > 0) fade = Math.min(fade, (this.cameraZ + this.detailDepth - z1) / this.detailFade);
          if (fade <= 0) continue;
          if (!on(r - 1, c)) this.draw(lines, x, y0, z0, x, y0, z1, fade);
          if (!on(r + 1, c)) this.draw(lines, x, y1, z0, x, y1, z1, fade);
          if (!on(r, c - 1)) this.draw(lines, x, y0, z0, x, y1, z0, fade);
          if (!on(r, c + 1)) this.draw(lines, x, y0, z1, x, y1, z1, fade);
        }
      }
    });
  }
}

// After Paul Brown, Untitled, Computer Assisted Drawing, 1975. Tile shapes are worked out from the print.
class Kacheln {
  constructor(seed, width, height) {
    this.seed = seed;
    this.random = new SeededRandom(seed);
    const margin = Math.min(width, height) * 0.035;
    this.size = (Math.min(width, height) - margin * 2) / 16;
    this.columns = Math.floor((width - margin * 2) / this.size);
    this.rows = Math.floor((height - margin * 2) / this.size);
    this.originX = (width - this.columns * this.size) / 2;
    this.originY = (height - this.rows * this.size) / 2;
    this.spread = 0.16; this.lastOnset = 0; this.elapsed = 0; this.pending = 0;
    // Loudness over the last moment, and over the last while, to notice a section getting bigger.
    this.recent = 0; this.usual = 0.3;
    this.power = 0;
    // 1 for a picture of closed rings, 0 for tiles at random.
    this.order = 0.7;
    this.tiles = [];
    for (let i = 0; i < this.columns * this.rows; i++) {
      this.tiles.push({ form: 0, turn: 0, previousForm: 0, progress: 1 });
    }
    for (let i = 0; i < this.tiles.length; i++) {
      this.settle(i);
      this.tiles[i].progress = 1;
    }
  }
  rollForm() {
    const roll = this.random.unit();
    return roll < 0.76 ? 0 : roll < 0.88 ? 1 : 2;
  }
  // 0...1, varying smoothly over the grid and slowly over time, so the picture changes in patches.
  field(x, y, key) {
    const px = x / 6 + this.elapsed * 0.03, py = y / 6 + this.elapsed * 0.02;
    const ix = Math.floor(px), iy = Math.floor(py), tx = px - ix, ty = py - iy;
    const knot = (a, b) => new SeededRandom((this.seed + Math.imul(key, 0x9E3779B1)
      + Math.imul(a, 0x01B3) + Math.imul(b, 0x5851F42D)) | 0).unit();
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const top = knot(ix, iy) + (knot(ix + 1, iy) - knot(ix, iy)) * sx;
    const bottom = knot(ix, iy + 1) + (knot(ix + 1, iy + 1) - knot(ix, iy + 1)) * sx;
    return top + (bottom - top) * sy;
  }
  // Looks at one tile again. Depending on the order here, it joins a ring or turns to anything.
  // Arc tiles on a checkerboard of orientations close into rings. Where the board is offset, the
  // rings give way to a ribbon running along the seam.
  settle(index) {
    const tile = this.tiles[index];
    if (tile.progress < 1) return;
    const x = index % this.columns, y = Math.floor(index / this.columns);
    let form, parity;
    if (this.random.unit() < this.order + (this.field(x, y, 1) - 0.5) * 0.7) {
      form = 0;
      parity = (x + y + (this.field(x, y, 2) > 0.5 ? 1 : 0)) % 2;
    } else {
      form = this.rollForm();
      parity = this.random.int(0, 1);
    }
    if (form === tile.form && parity === tile.turn % 2) return;
    tile.previousForm = tile.form;
    tile.form = form;
    tile.turn += (tile.turn + 1) % 2 === parity ? 1 : 2;
    tile.progress = 0;
  }
  // Looks at a small neighborhood, because the patterns live in how neighbors connect.
  settleCluster(count) {
    const r = this.random, cx = r.int(0, this.columns - 1), cy = r.int(0, this.rows - 1);
    for (let i = 0; i < count; i++) {
      const x = cx + r.int(-2, 2), y = cy + r.int(-2, 2);
      if (x >= 0 && x < this.columns && y >= 0 && y < this.rows) this.settle(y * this.columns + x);
    }
  }
  update(dt, audio) {
    this.elapsed += dt;
    const target = 0.16 + audio.bass * 0.035;
    this.spread += (target - this.spread) * (1 - Math.exp(-dt / (target > this.spread ? 0.05 : 0.35)));
    this.recent += (audio.energy - this.recent) * (1 - Math.exp(-dt / (audio.energy > this.recent ? 0.35 : 1.2)));
    this.usual += (this.recent - this.usual) * (1 - Math.exp(-dt / 18));
    let powerTarget = 0;
    if (audio.state === 'music') {
      const eased = (low, high, value) => { const t = clamp((value - low) / (high - low), 0, 1); return t * t * (3 - 2 * t); };
      powerTarget = Math.min(1, eased(0.02, 0.2, this.recent - this.usual) * 0.9 + eased(0.3, 0.7, this.recent) * 0.6);
    }
    this.power += (powerTarget - this.power) * (1 - Math.exp(-dt / (powerTarget > this.power ? 0.25 : 0.8)));
    // Order breaks quickly and comes back slowly.
    const orderTarget = 1 - Math.min(1, this.power * 1.3);
    this.order += (orderTarget - this.order) * (1 - Math.exp(-dt / (orderTarget < this.order ? 0.4 : 4)));
    if (audio.onsetCount !== this.lastOnset) {
      this.lastOnset = audio.onsetCount;
      this.settleCluster(Math.floor((2 + Math.floor(audio.onset * 10)) * (1 + this.power * 2)));
    }
    const rate = audio.state === 'music' ? 10 + audio.energy * 25 + this.power * 40 : audio.state === 'quiet' ? 3 : 0.5;
    this.pending += rate * dt;
    while (this.pending >= 1) {
      this.pending -= 1;
      this.settle(this.random.int(0, this.tiles.length - 1));
    }
    const step = dt / (0.45 - this.power * 0.25);
    for (const tile of this.tiles) if (tile.progress < 1) tile.progress = Math.min(1, tile.progress + step);
  }
  emit(lines) {
    const x0 = this.originX, y0 = this.originY, x1 = x0 + this.columns * this.size, y1 = y0 + this.rows * this.size;
    lines.line(x0, y0, x1, y0); lines.line(x1, y0, x1, y1); lines.line(x1, y1, x0, y1); lines.line(x0, y1, x0, y0);
    const sides = Math.max(5, Math.floor(9 * lines.detail));
    this.tiles.forEach((tile, index) => {
      const cx = x0 + (index % this.columns + 0.5) * this.size;
      const cy = y0 + (Math.floor(index / this.columns) + 0.5) * this.size;
      const p = tile.progress, eased = p * p * (3 - 2 * p);
      const angle = (tile.turn - (1 - eased)) * Math.PI / 2;
      if (p >= 1 || tile.form === tile.previousForm) {
        this.draw(lines, tile.form, cx, cy, angle, 1, sides);
      } else {
        this.draw(lines, tile.previousForm, cx, cy, angle, 1 - eased, sides);
        this.draw(lines, tile.form, cx, cy, angle, eased, sides);
      }
    });
  }
  draw(lines, form, cx, cy, angle, alpha, sides) {
    const half = this.size / 2, gap = this.size * this.spread;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const arc = (x, y, radius, from, count) => {
      let px = 0, py = 0;
      for (let i = 0; i <= count; i++) {
        const a = from + i / count * Math.PI / 2;
        const lx = x + radius * Math.cos(a), ly = y + radius * Math.sin(a);
        const qx = cx + lx * cos - ly * sin, qy = cy + lx * sin + ly * cos;
        if (i > 0) lines.line(px, py, qx, qy, alpha);
        px = qx; py = qy;
      }
    };
    // Closes a band arriving at an edge, rounding it off with a ring and a small dot.
    const cap = (x, y, from) => {
      for (const radius of [gap, gap * 0.3]) {
        arc(x, y, radius, from, 3);
        arc(x, y, radius, from + Math.PI / 2, 3);
      }
    };
    if (form === 0) {
      for (const radius of [half - gap, half, half + gap]) {
        arc(-half, -half, radius, 0, sides);
        arc(half, half, radius, Math.PI, sides);
      }
    } else if (form === 1) {
      for (const x of [-gap, 0, gap]) {
        lines.line(cx + x * cos + half * sin, cy + x * sin - half * cos, cx + x * cos - half * sin, cy + x * sin + half * cos, alpha);
      }
      cap(-half, 0, -Math.PI / 2);
      cap(half, 0, Math.PI / 2);
    } else {
      cap(-half, 0, -Math.PI / 2);
      cap(half, 0, Math.PI / 2);
      cap(0, -half, 0);
      cap(0, half, Math.PI);
    }
  }
}

// Sets text as pen strokes in the Hershey Simplex font. See hershey.js.
const HERSHEY = HERSHEY_GLYPHS.map(data => {
  const origin = 'R'.charCodeAt(0);
  const strokes = [];
  let stroke = [];
  for (let i = 2; i + 1 < data.length; i += 2) {
    if (data[i] === ' ') {
      if (stroke.length > 1) strokes.push(stroke);
      stroke = [];
    } else {
      stroke.push([data.charCodeAt(i) - origin, data.charCodeAt(i + 1) - origin]);
    }
  }
  if (stroke.length > 1) strokes.push(stroke);
  return { left: data.charCodeAt(0) - origin, right: data.charCodeAt(1) - origin, strokes };
});

function hersheyCharacters(text) {
  const replaced = text.replace(/ß/g, 'ss').replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-').replace(/\u2026/g, '...').normalize('NFD');
  const result = [];
  for (const ch of replaced) {
    const code = ch.codePointAt(0);
    if (code === 0x308 && result.length) result[result.length - 1].dots = true;
    else if (code >= 32 && code <= 126) result.push({ code, dots: false });
  }
  return result;
}

function hersheyRows(text, scale, maxWidth) {
  const all = hersheyCharacters(text), rows = [];
  let start = 0, lastSpace = -1, used = 0, index = 0;
  while (index < all.length) {
    const glyph = HERSHEY[all[index].code - 32], advance = (glyph.right - glyph.left) * scale;
    if (all[index].code === 32) lastSpace = index;
    if (used + advance > maxWidth && index > start) {
      const end = lastSpace > start ? lastSpace : index;
      rows.push(all.slice(start, end));
      start = all[end].code === 32 ? end + 1 : end;
      index = start; used = 0; lastSpace = -1;
      continue;
    }
    used += advance;
    index++;
  }
  if (start < all.length) rows.push(all.slice(start));
  return rows;
}

// Text the Hershey font can't draw arrives as outlines from the iPad, which has the fonts. See OutlineText.swift.
const OUTLINE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const OUTLINE_VALUES = Object.fromEntries([...OUTLINE_ALPHABET].map((ch, index) => [ch, index]));

function decodeOutlineWord([advance, encoded]) {
  const value = (text, i) => (OUTLINE_VALUES[text[i]] * 64 + OUTLINE_VALUES[text[i + 1]]) / 4 - 64;
  const contours = encoded.split(' ').map(text => {
    const contour = [];
    for (let i = 0; i + 3 < text.length; i += 4) contour.push([value(text, i), value(text, i + 2)]);
    return contour;
  });
  return { advance, contours };
}

function outlineRows(words, scale, maxWidth) {
  const rows = [];
  let row = [], used = 0;
  for (const word of words) {
    const advance = word.advance * scale;
    if (used + advance > maxWidth && row.length) { rows.push(row); row = []; used = 0; }
    row.push(word);
    used += advance;
  }
  if (row.length) rows.push(row);
  return rows;
}

// Lyrics written by a pen plotter on a roll of paper. Ported from Packages/Presets/Sources/Lyrik.swift.
class Lyrik {
  constructor(seed, width, height) {
    this.width = width; this.height = height;
    this.margin = Math.min(width, height) * 0.07;
    this.rowHeight = Math.min(width, height) / 13;
    this.scale = this.rowHeight / 36;
    this.blocks = []; this.revision = -1; this.position = null;
    this.scroll = 0; this.time = 0; this.headerAge = 0; this.bass = 0;
    this.updateLyrics(null, null);
  }
  updateLyrics(data, position) {
    this.position = position;
    const revision = data ? data.revision : 0;
    if (revision === this.revision) return;
    this.revision = revision;
    this.layOut(data || { title: '', artist: '', lines: [], message: 'Listening' });
  }
  layOut(data) {
    this.blocks = []; this.scroll = 0; this.headerAge = 0;
    let y = this.margin + this.rowHeight * 0.6;
    const make = (text, scale, start, duration) => {
      const maxWidth = this.width - this.margin * 2, top = y, segments = [];
      const outlined = data.outlined && data.outlined[text];
      if (outlined) {
        const words = outlined.slice(1).map(index => data.words[index]).filter(Boolean);
        const rows = outlineRows(words, scale, maxWidth);
        if (!rows.length) return null;
        for (const row of rows) {
          this.outlineStrokes(row, outlined[0] === 1, maxWidth, y, scale, segments);
          y += this.rowHeight * scale / this.scale;
        }
      } else {
        const rows = hersheyRows(text, scale, maxWidth);
        if (!rows.length) return null;
        for (const row of rows) {
          this.strokes(row, this.margin, y, scale, segments);
          y += this.rowHeight * scale / this.scale;
        }
      }
      let total = 0;
      for (const s of segments) { s[4] = Math.hypot(s[2] - s[0], s[3] - s[1]); total += s[4]; }
      return { start, duration, segments, total, top, bottom: y };
    };
    const add = block => { if (block) this.blocks.push(block); };
    if (data.title) add(make(data.title, this.scale, null, 3));
    if (data.artist) add(make(data.artist, this.scale * 0.62, null, 2));
    if (data.message) { const block = make(data.message, this.scale * 0.62, null, 2); y += this.rowHeight * 0.3; add(block); }
    y += this.rowHeight * 0.5;
    data.lines.forEach(([time, text], index) => {
      if (!text) { y += this.rowHeight * 0.5; return; }
      const gap = index + 1 < data.lines.length ? data.lines[index + 1][0] - time : 4;
      add(make(text, this.scale, time, Math.min(6, Math.max(0.6, gap * 0.85))));
    });
  }
  outlineStrokes(row, isRightToLeft, maxWidth, y, scale, out) {
    let penX = isRightToLeft ? this.margin + maxWidth : this.margin;
    for (const word of row) {
      if (isRightToLeft) penX -= word.advance * scale;
      for (const contour of word.contours) {
        for (let i = 0; i + 1 < contour.length; i++) {
          out.push([penX + contour[i][0] * scale, y + contour[i][1] * scale,
                    penX + contour[i + 1][0] * scale, y + contour[i + 1][1] * scale, 0]);
        }
      }
      if (!isRightToLeft) penX += word.advance * scale;
    }
  }
  strokes(row, x, baseline, scale, out) {
    let penX = x;
    for (const ch of row) {
      const glyph = HERSHEY[ch.code - 32], originX = penX - glyph.left * scale;
      for (const stroke of glyph.strokes) {
        for (let i = 0; i + 1 < stroke.length; i++) {
          out.push([originX + stroke[i][0] * scale, baseline + stroke[i][1] * scale,
                    originX + stroke[i + 1][0] * scale, baseline + stroke[i + 1][1] * scale, 0]);
        }
      }
      if (ch.dots) {
        const dotY = baseline + (ch.code < 97 ? -15 : -9) * scale;
        for (const offset of [-2.5, 2.5]) out.push([originX + (offset - 0.5) * scale, dotY, originX + (offset + 0.5) * scale, dotY, 0]);
      }
      penX += (glyph.right - glyph.left) * scale;
    }
  }
  update(dt, audio) {
    this.time += dt;
    this.headerAge += dt;
    this.bass += (audio.bass - this.bass) * (1 - Math.exp(-dt / (audio.bass > this.bass ? 0.04 : 0.3)));
    let target = 0;
    if (this.position !== null) {
      let current = null;
      for (const block of this.blocks) if (block.start !== null && block.start <= this.position) current = block;
      if (current) target = Math.max(0, current.bottom - this.height * 0.62);
    }
    this.scroll += (target - this.scroll) * (1 - Math.exp(-dt / 0.7));
  }
  emit(lines) {
    for (const block of this.blocks) {
      if (block.bottom - this.scroll <= -this.rowHeight || block.top - this.scroll >= this.height + this.rowHeight) continue;
      let reveal, tremble = 0;
      if (block.start !== null) {
        if (this.position === null || this.position < block.start) continue;
        const elapsed = this.position - block.start;
        reveal = Math.min(1, elapsed / block.duration);
        tremble = clamp(1 - (elapsed - block.duration) / 1.5, 0, 1) * this.scale * (0.5 + this.bass * 3.5);
      } else {
        reveal = Math.min(1, this.headerAge / block.duration);
      }
      this.draw(lines, block, reveal, tremble);
    }
  }
  draw(lines, block, reveal, tremble) {
    const fadeHeight = this.height * 0.16, scroll = this.scroll, margin = this.margin, time = this.time;
    const px = (x, y) => tremble > 0 ? x + driftNoise(x * 0.02 + y * 0.013 + time * 2.3, 7) * tremble : x;
    const py = (x, y) => tremble > 0 ? y - scroll + driftNoise(y * 0.02 + x * 0.011 + time * 1.9, 19) * tremble : y - scroll;
    let remaining = block.total * reveal;
    for (const s of block.segments) {
      if (remaining <= 0) return;
      const fraction = s[4] > 0 ? Math.min(1, remaining / s[4]) : 1;
      remaining -= s[4];
      const alpha = scroll > 0 ? clamp((s[1] - scroll - margin * 0.3) / fadeHeight, 0, 1) : 1;
      const ex = s[0] + (s[2] - s[0]) * fraction, ey = s[1] + (s[3] - s[1]) * fraction;
      lines.line(px(s[0], s[1]), py(s[0], s[1]), px(ex, ey), py(ex, ey), alpha);
    }
  }
}

// The Rapport logo and name, plotted at startup. Ported from Packages/Presets/Sources/RapportMark.swift.
const MARK_DURATION = 2.2, MARK_NAME_START = 1.5, MARK_NAME_SECONDS = 0.6;

function markLogo(cx, cy, size, settle) {
  const unit = size / 2, half = 0.5, gap = 0.17, result = [];
  [[-0.5, -0.5, 0], [0.5, -0.5, Math.PI / 2], [-0.5, 0.5, Math.PI / 2], [0.5, 0.5, 0]].forEach(([tx, ty, base], index) => {
    const progress = clamp(settle * 1.6 - index * 0.2, 0, 1), eased = progress * progress * (3 - 2 * progress);
    const angle = base + (1 - eased) * (index % 2 ? -1 : 1) * Math.PI / 2;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    for (const radius of [half - gap, half, half + gap]) {
      for (const [ox, oy, from] of [[-half, -half, 0], [half, half, Math.PI]]) {
        const line = [];
        for (let step = 0; step <= 18; step++) {
          const a = from + step / 18 * Math.PI / 2;
          const x = ox + Math.cos(a) * radius, y = oy + Math.sin(a) * radius;
          line.push([cx + (tx + x * cos - y * sin) * unit, cy + (ty + x * sin + y * cos) * unit]);
        }
        result.push(line);
      }
    }
  });
  return result;
}

function emitMark(lines, width, height, t) {
  const side = Math.min(width, height);
  const plot = (polylines, reveal) => {
    let total = 0;
    for (const l of polylines) for (let i = 1; i < l.length; i++) total += Math.hypot(l[i][0] - l[i - 1][0], l[i][1] - l[i - 1][1]);
    let remaining = total * reveal;
    for (const l of polylines) {
      for (let i = 1; i < l.length; i++) {
        if (remaining <= 0) return;
        const d = Math.hypot(l[i][0] - l[i - 1][0], l[i][1] - l[i - 1][1]);
        lines.stroke(l[i - 1][0], l[i - 1][1], l[i][0], l[i][1], d > 0 ? remaining / d : 1);
        remaining -= d;
      }
    }
  };
  const plotted = clamp(t, 0, 1);
  plot(markLogo(width / 2, height * 0.42, side * 0.35, clamp((t - 0.7) / 1.1, 0, 1)), plotted * plotted * (3 - 2 * plotted));
  const scale = side * 0.0039, row = hersheyCharacters('RAPPORT');
  let textWidth = 0;
  for (const ch of row) { const g = HERSHEY[ch.code - 32]; textWidth += (g.right - g.left) * scale; }
  const segments = [];
  Lyrik.prototype.strokes.call(null, row, (width - textWidth) / 2, height * 0.76, scale, segments);
  const reveal = clamp((t - MARK_NAME_START) / MARK_NAME_SECONDS, 0, 1);
  // One pen works rightwards to the center. The other retraces the rest backwards, from the last letter.
  const isLeft = s => (s[0] + s[2]) / 2 < width / 2;
  plot(segments.filter(isLeft).map(s => [[s[0], s[1]], [s[2], s[3]]]), reveal);
  plot(segments.filter(s => !isLeft(s)).reverse().map(s => [[s[2], s[3]], [s[0], s[1]]]), reveal);
}

// After Zdeněk Sýkora, Lines (Linie), from 1973. Ported from Linie.swift.
class Linie {
  constructor(seed, width, height) {
    this.random = new SeededRandom(seed);
    this.width = width; this.height = height;
    this.unit = Math.min(width, height) / 11;
    this.spacing = this.unit / 7;
    this.strokes = [];
    this.lastOnset = 0; this.sinceSpawn = 0; this.boost = 0;
    for (let i = 0; i < 3; i++) this.spawnBundle(3);
    // The picture is already under way when it first appears.
    for (const stroke of this.strokes) stroke.head = stroke.points.length / 2 * this.random.range(0.4, 1);
  }
  spawnBundle(size) {
    const columns = Math.floor(this.width / this.unit), rows = Math.floor(this.height / this.unit);
    const nodeX = this.random.int(1, Math.max(1, columns - 1)) * this.unit;
    const nodeY = this.random.int(1, Math.max(1, rows - 1)) * this.unit;
    const first = this.random.int(0, 3);
    for (let i = 0; i < size && this.strokes.length < Linie.MOST; i++) this.strokes.push(this.makeStroke(nodeX, nodeY, first + i));
  }
  makeStroke(startX, startY, firstHeading) {
    const random = this.random, roll = random.unit();
    let lineWidth, band;
    if (roll < 0.35) { lineWidth = 2.5; band = random.int(10, 15); }
    else if (roll < 0.7) { lineWidth = 5; band = random.int(5, 9); }
    else if (roll < 0.9) { lineWidth = 9; band = random.int(1, 4); }
    else { lineWidth = 15; band = random.int(0, 2); }

    const points = [startX, startY];
    let x = startX, y = startY, heading = firstHeading & 3;
    const unit = this.unit, spacing = this.spacing, D = Linie.DIRECTIONS;
    for (let move = 0, moves = random.int(5, 14); move < moves; move++) {
      const [dx, dy] = D[heading];
      if (random.unit() < 0.3) {
        const length = unit * random.int(1, 3), count = Math.max(1, Math.floor(length / spacing));
        for (let step = 1; step <= count; step++) points.push(x + dx * length * step / count, y + dy * length * step / count);
        x += dx * length; y += dy * length;
      } else {
        // A quarter circle, turning back toward the middle more often than not near an edge.
        let turn = random.unit() < 0.5 ? 1 : -1;
        const outX = x - this.width / 2, outY = y - this.height / 2;
        const nearEdge = Math.abs(outX) > this.width * 0.3 || Math.abs(outY) > this.height * 0.3;
        if (nearEdge && random.unit() < 0.7) {
          const [nx, ny] = D[(heading + turn + 4) & 3];
          if (nx * outX + ny * outY > 0) turn = -turn;
        }
        const radius = unit * random.int(1, 2);
        const [sx, sy] = D[(heading + turn + 4) & 3];
        const count = Math.max(2, Math.floor(radius * Math.PI / 2 / spacing));
        for (let step = 1; step <= count; step++) {
          const angle = step / count * Math.PI / 2, s = Math.sin(angle) * radius, c = (1 - Math.cos(angle)) * radius;
          points.push(x + dx * s + sx * c, y + dy * s + sy * c);
        }
        x += (dx + sx) * radius; y += (dy + sy) * radius;
        heading = (heading + turn + 4) & 3;
      }
      const beyond = unit * 1.5;
      if (x < -beyond || y < -beyond || x > this.width + beyond || y > this.height + beyond) break;
    }
    return {
      points, color: Linie.COLORS[random.int(0, Linie.COLORS.length - 1)], width: lineWidth, band,
      head: 0, tail: 0, hold: random.range(5, 14), swell: 0,
    };
  }
  update(dt, audio) {
    this.sinceSpawn += dt;
    this.boost *= Math.exp(-dt / 0.35);
    if (audio.onsetCount !== this.lastOnset) {
      this.lastOnset = audio.onsetCount;
      this.boost = Math.min(2, this.boost + audio.onset * 1.2);
      if (this.sinceSpawn > 0.18) {
        this.sinceSpawn = 0;
        // A full picture makes room by letting its oldest line go.
        if (this.strokes.length >= Linie.MOST) {
          const oldest = this.strokes.find(stroke => stroke.hold > 0);
          if (oldest) oldest.hold = 0;
        }
        this.spawnBundle(1 + Math.floor(Math.min(1, audio.onset) * 3));
      }
    }
    if (this.strokes.length < Linie.FEWEST && this.sinceSpawn > 2.5) {
      this.sinceSpawn = 0;
      this.spawnBundle(2);
    }
    const pace = audio.state === 'music' ? 18 + audio.energy * 55 : audio.state === 'quiet' ? 8 : 5;
    const speed = pace * (1 + this.boost), waiting = audio.state === 'music' ? dt : dt * 0.4;
    for (const stroke of this.strokes) {
      const count = stroke.points.length / 2;
      if (stroke.head < count) stroke.head = Math.min(count, stroke.head + speed * dt);
      else if (stroke.hold > 0) stroke.hold -= waiting;
      else stroke.tail += speed * dt;
      const level = audio.bands[stroke.band] || 0;
      const rate = level > stroke.swell ? 0.04 : 0.28;
      stroke.swell += (level - stroke.swell) * (1 - Math.exp(-dt / rate));
    }
    this.strokes = this.strokes.filter(stroke => stroke.tail < stroke.points.length / 2 - 1);
  }
  emit(lines) {
    const skip = lines.detail < 0.75 ? 2 : 1;
    // Widest first, so thin lines stay visible where they cross.
    for (const widthClass of [15, 9, 5, 2.5]) {
      for (const stroke of this.strokes) if (stroke.width === widthClass) this.emitStroke(stroke, skip, lines);
    }
  }
  emitStroke(stroke, skip, lines) {
    const points = stroke.points, last = points.length / 2 - 1;
    if (last <= 0) return;
    const at = place => {
      const clamped = clamp(place, 0, last), index = Math.min(Math.floor(clamped), last - 1), f = clamped - index;
      return [points[index * 2] + (points[index * 2 + 2] - points[index * 2]) * f, points[index * 2 + 1] + (points[index * 2 + 3] - points[index * 2 + 1]) * f];
    };
    const lineWidth = stroke.width * (1 + stroke.swell * 0.7);
    let [px, py] = at(stroke.tail);
    let place = Math.floor(stroke.tail) + skip;
    const end = Math.min(stroke.head, last);
    while (place < end) {
      const nx = points[place * 2], ny = points[place * 2 + 1];
      lines.line(px, py, nx, ny, 1, stroke.color, lineWidth);
      px = nx; py = ny;
      place += skip;
    }
    if (stroke.head > stroke.tail) {
      const [hx, hy] = at(stroke.head);
      lines.line(px, py, hx, hy, 1, stroke.color, lineWidth);
    }
  }
}
Linie.MOST = 28;
Linie.FEWEST = 7;
Linie.DIRECTIONS = [[1, 0], [0, 1], [-1, 0], [0, -1]];
Linie.COLORS = [0xE8321E, 0x1446C8, 0x0A9A5B, 0xF2B705, 0xD6126E, 0x6A2BB8, 0xF5741F, 0x12A7E0].map(lineColor);

const PRESETS = { hommage: Hommage, korridor: Korridor, kacheln: Kacheln, schotter: Schotter, linie: Linie, lyrik: Lyrik };
