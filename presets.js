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

class LineBuffer {
  constructor(capacity) {
    this.data = new Float32Array(capacity * 5);
    this.capacity = capacity;
    this.count = 0;
    this.detail = 1;
  }
  clear() { this.count = 0; }
  line(ax, ay, bx, by, alpha = 1) {
    if (alpha <= 0.001 || this.count >= this.capacity) return;
    const n = this.count++ * 5, d = this.data;
    d[n] = ax; d[n + 1] = ay; d[n + 2] = bx; d[n + 3] = by; d[n + 4] = alpha;
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
    const n = whole * 5, d = this.data, partial = exact - whole;
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
    this.wallRows = 17; this.wallColumns = 14; this.near = 0.18;
    this.cx = width / 2; this.cy = height * 0.54;
    const aspect = width / height;
    this.halfWidth = aspect >= 1 ? aspect : 1;
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
    this.chunks = this.chunks.filter(c => c.index >= first && c.index < first + this.chunkCount);
    for (let index = first; index < first + this.chunkCount; index++) {
      if (!this.chunks.some(c => c.index === index)) this.chunks.push(this.makeChunk(index));
    }
  }
  makeChunk(index) {
    const r = new SeededRandom((this.seed + Math.imul(index, 0x01B3)) | 0);
    const boxes = [];
    for (let i = 0, n = r.int(1, 3); i < n; i++) {
      const sy = r.range(0.15, 0.6), sx = r.range(0.08, 0.26), sz = r.range(0.15, 0.6);
      boxes.push({
        x: r.range(-0.65, 0.65) * this.halfWidth,
        y: this.halfHeight * r.range(0.25, 0.9),
        z: (index + r.unit()) * this.chunkLength,
        sx, sy, sz, band: r.int(0, 15),
      });
    }
    return { index, boxes, left: this.corrode(r), right: this.corrode(r) };
  }
  corrode(r) {
    const rows = this.wallRows, columns = this.wallColumns;
    const order = new Float32Array(rows * columns).fill(1.5);
    const frontier = [];
    for (let i = 0, n = r.int(2, 4); i < n; i++) {
      const cell = r.int(0, rows * columns - 1);
      order[cell] = 0;
      frontier.push(cell);
    }
    let step = 0;
    while (frontier.length && step < rows * columns) {
      const cell = frontier.splice(r.int(0, frontier.length - 1), 1)[0];
      const row = Math.floor(cell / columns), column = cell % columns;
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (r.unit() >= 0.62) continue;
        const nr = row + dr, nc = column + dc;
        if (nr < 0 || nr >= rows || nc < 0 || nc >= columns) continue;
        const neighbor = nr * columns + nc;
        if (order[neighbor] !== 1.5) continue;
        step++;
        order[neighbor] = step / (rows * columns);
        frontier.push(neighbor);
      }
    }
    return order;
  }
  update(dt, audio) {
    const target = audio.state === 'music'
      ? (audio.tempoConfidence > 0.3 ? audio.tempoBPM / 60 : 1.2 + audio.energy) * this.beatSpacing
      : audio.state === 'quiet' ? 0.05 : 0.02;
    this.speed += (target - this.speed) * (1 - Math.exp(-dt / 1.2));
    this.cameraZ += this.speed * dt;
    const corrosion = 0.14 + audio.energy * 0.75;
    this.corrosion += (corrosion - this.corrosion) * (1 - Math.exp(-dt / (corrosion > this.corrosion ? 0.5 : 2.5)));
    this.branch *= Math.exp(-dt / 0.5);
    const follow = 1 - Math.exp(-dt / 0.14);
    for (let i = 0; i < 16; i++) this.bands[i] += (audio.bands[i] - this.bands[i]) * follow;
    if (audio.onsetCount !== this.lastOnset) {
      this.lastOnset = audio.onsetCount;
      this.onsets++;
      this.branch = Math.max(this.branch, audio.onset * 0.22);
    }
    this.refreshChunks();
  }
  // Clips against the near plane, projects, and fades lines into the distance.
  draw(lines, ax, ay, az, bx, by, bz) {
    const plane = this.cameraZ + this.near;
    if (az < plane && bz < plane) return;
    if (az < plane) { const t = (plane - az) / (bz - az); ax += (bx - ax) * t; ay += (by - ay) * t; az = plane; }
    else if (bz < plane) { const t = (plane - bz) / (az - bz); bx += (ax - bx) * t; by += (ay - by) * t; bz = plane; }
    const far = (this.chunkCount - 1) * this.chunkLength;
    const alpha = clamp((1 - (Math.min(az, bz) - this.cameraZ) / far) * 3, 0, 1);
    const da = az - this.cameraZ, db = bz - this.cameraZ;
    lines.line(this.cx + ax / da * this.focal, this.cy - ay / da * this.focal,
               this.cx + bx / db * this.focal, this.cy - by / db * this.focal, alpha);
  }
  emit(lines) {
    const far = this.cameraZ + (this.chunkCount - 1) * this.chunkLength;
    const floorY = -this.halfHeight, floorX = this.halfWidth * 0.62;
    for (let rail = 0; rail <= 8; rail++) {
      const x = (rail / 8 * 2 - 1) * floorX;
      this.draw(lines, x, floorY, this.cameraZ, x, floorY, far);
    }
    for (let z = Math.ceil(this.cameraZ / this.beatSpacing) * this.beatSpacing; z < far; z += this.beatSpacing) {
      this.draw(lines, -floorX, floorY, z, floorX, floorY, z);
    }
    for (const chunk of this.chunks) {
      for (const box of chunk.boxes) this.drawBox(lines, box);
      const flicker = (chunk.index + this.onsets) % 3 === 0 ? this.branch : 0;
      const level = this.corrosion * lines.detail + flicker;
      this.drawWall(lines, chunk.left, chunk.index, -this.halfWidth, level);
      this.drawWall(lines, chunk.right, chunk.index, this.halfWidth, level);
    }
  }
  drawBox(lines, box) {
    const hx = box.sx / 2, hy = box.sy * (1 + this.bands[box.band] * 1.6) / 2, hz = box.sz / 2;
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
  drawWall(lines, order, chunk, x, level) {
    const rows = this.wallRows, columns = this.wallColumns;
    const cellZ = this.chunkLength / columns, cellY = this.halfHeight * 2 / rows;
    const startZ = chunk * this.chunkLength;
    const on = (r, c) => r >= 0 && r < rows && c >= 0 && c < columns && order[r * columns + c] <= level;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < columns; c++) {
        if (!on(r, c)) continue;
        const y0 = -this.halfHeight + r * cellY, y1 = y0 + cellY;
        const z0 = startZ + c * cellZ, z1 = z0 + cellZ;
        if (!on(r - 1, c)) this.draw(lines, x, y0, z0, x, y0, z1);
        if (!on(r + 1, c)) this.draw(lines, x, y1, z0, x, y1, z1);
        if (!on(r, c - 1)) this.draw(lines, x, y0, z0, x, y1, z0);
        if (!on(r, c + 1)) this.draw(lines, x, y0, z1, x, y1, z1);
      }
    }
  }
}

// After Paul Brown, Untitled, Computer Assisted Drawing, 1975. Tile shapes are worked out from the print.
class Kacheln {
  constructor(seed, width, height) {
    this.random = new SeededRandom(seed);
    const margin = Math.min(width, height) * 0.035;
    this.size = (Math.min(width, height) - margin * 2) / 16;
    this.columns = Math.floor((width - margin * 2) / this.size);
    this.rows = Math.floor((height - margin * 2) / this.size);
    this.originX = (width - this.columns * this.size) / 2;
    this.originY = (height - this.rows * this.size) / 2;
    this.spread = 0.16; this.lastOnset = 0; this.sinceDrift = 0;
    this.tiles = [];
    for (let i = 0; i < this.columns * this.rows; i++) {
      const form = this.rollForm();
      this.tiles.push({ form, turn: this.random.int(0, 3), previousForm: form, progress: 1 });
    }
  }
  rollForm() {
    const roll = this.random.unit();
    return roll < 0.76 ? 0 : roll < 0.88 ? 1 : 2;
  }
  change(index) {
    const tile = this.tiles[index];
    if (tile.progress < 1) return;
    tile.previousForm = tile.form;
    tile.form = this.rollForm();
    tile.turn += 1;
    tile.progress = 0;
  }
  // Turns a small neighborhood, because the patterns live in how neighbors connect.
  changeCluster(count) {
    const r = this.random, cx = r.int(0, this.columns - 1), cy = r.int(0, this.rows - 1);
    for (let i = 0; i < count; i++) {
      const x = cx + r.int(-2, 2), y = cy + r.int(-2, 2);
      if (x >= 0 && x < this.columns && y >= 0 && y < this.rows) this.change(y * this.columns + x);
    }
  }
  update(dt, audio) {
    const target = 0.16 + audio.bass * 0.035;
    this.spread += (target - this.spread) * (1 - Math.exp(-dt / (target > this.spread ? 0.05 : 0.35)));
    if (audio.onsetCount !== this.lastOnset) {
      this.lastOnset = audio.onsetCount;
      this.changeCluster(2 + Math.floor(audio.onset * 10));
    }
    this.sinceDrift += dt;
    if (this.sinceDrift > (audio.state === 'music' ? 1.5 : audio.state === 'quiet' ? 2.5 : 6)) {
      this.sinceDrift = 0;
      this.change(this.random.int(0, this.tiles.length - 1));
    }
    const step = dt / 0.45;
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
      const rows = hersheyRows(text, scale, this.width - this.margin * 2);
      if (!rows.length) return null;
      const top = y, segments = [];
      for (const row of rows) {
        this.strokes(row, this.margin, y, scale, segments);
        y += this.rowHeight * scale / this.scale;
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

const PRESETS = { hommage: Hommage, korridor: Korridor, kacheln: Kacheln, schotter: Schotter, lyrik: Lyrik };
