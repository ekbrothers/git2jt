// Generates 4 sample GIFs into public/ using raw GIF89a encoding.
// No npm dependencies. Run: node make-samples.js
const fs = require('fs');
const path = require('path');

const W = 64, H = 24;

// ─── Minimal GIF89a encoder ───────────────────────────────────────────────────

function encodeGif(frames, delayCs) {
  // frames: array of Uint8Array(W*H) palette indices
  // All frames share one global palette (256 colors max)
  // We build the palette from the union of all frames' colors then encode.

  const bytes = [];
  const push = (...args) => args.forEach(b => bytes.push(b));
  const pushStr = s => { for (let i = 0; i < s.length; i++) push(s.charCodeAt(i)); };
  const pushU16LE = n => push(n & 0xff, (n >> 8) & 0xff);

  // Collect all unique RGB triples
  const colorMap = new Map(); // 'r,g,b' -> index
  const palette = [];
  for (const { pixels, colors } of frames) {
    for (const [r, g, b] of colors) {
      const key = `${r},${g},${b}`;
      if (!colorMap.has(key)) {
        colorMap.set(key, palette.length);
        palette.push([r, g, b]);
      }
    }
  }
  // Pad palette to next power of 2, minimum 4
  let palSize = 4;
  while (palSize < palette.length) palSize *= 2;
  if (palSize > 256) palSize = 256;
  // palBits N such that 2^(N+1) = palSize — use integer log2
  let palBits = 1;
  while ((2 << palBits) < palSize) palBits++;

  // Header
  pushStr('GIF89a');
  pushU16LE(W); pushU16LE(H);
  push(0x80 | palBits, 0, 0); // GCT flag + palBits, bgcolor=0, aspect=0

  // Global Color Table
  for (let i = 0; i < palSize; i++) {
    const c = palette[i] || [0, 0, 0];
    push(c[0], c[1], c[2]);
  }

  // Netscape loop extension (loop forever)
  push(0x21, 0xff, 0x0b);
  pushStr('NETSCAPE2.0');
  push(0x03, 0x01, 0x00, 0x00, 0x00);

  for (const { pixels, colors } of frames) {
    // Graphic control extension (delay)
    push(0x21, 0xf9, 0x04, 0x00);
    pushU16LE(delayCs);
    push(0x00, 0x00);

    // Image descriptor
    push(0x2c);
    pushU16LE(0); pushU16LE(0); // left, top
    pushU16LE(W); pushU16LE(H);
    push(0x00); // no local color table

    // Build index stream: map each pixel's RGB back to palette index
    const indices = new Uint8Array(W * H);
    for (let i = 0; i < pixels.length; i++) {
      const [r, g, b] = colors[pixels[i]];
      indices[i] = colorMap.get(`${r},${g},${b}`);
    }

    // LZW compress
    const lzwData = lzwEncode(indices, palBits + 1);
    push(...lzwData);
  }

  push(0x3b); // trailer
  return Buffer.from(bytes);
}

// Minimal LZW encoder for GIF
function lzwEncode(indices, minCodeSize) {
  if (minCodeSize < 2) minCodeSize = 2;
  const clearCode = 1 << minCodeSize;
  const eofCode = clearCode + 1;

  let codeSize = minCodeSize + 1;
  let nextCode = eofCode + 1;
  const table = new Map();
  const resetTable = () => {
    table.clear();
    for (let i = 0; i < clearCode; i++) table.set(String(i), i);
    codeSize = minCodeSize + 1;
    nextCode = eofCode + 1;
  };

  const bits = [];
  const emitCode = code => {
    for (let i = 0; i < codeSize; i++) bits.push((code >> i) & 1);
  };

  resetTable();
  emitCode(clearCode);

  let str = String(indices[0]);
  for (let i = 1; i < indices.length; i++) {
    const next = str + ',' + indices[i];
    if (table.has(next)) {
      str = next;
    } else {
      emitCode(table.get(str));
      if (nextCode < 4096) {
        table.set(next, nextCode++);
        if (nextCode > (1 << codeSize)) codeSize++;
      } else {
        emitCode(clearCode);
        resetTable();
      }
      str = String(indices[i]);
    }
  }
  emitCode(table.get(str));
  emitCode(eofCode);

  // Pack bits into bytes
  const byteArr = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b |= ((bits[i + j] || 0) << j);
    byteArr.push(b);
  }

  // Wrap in sub-blocks with minCodeSize prefix
  const result = [minCodeSize];
  for (let i = 0; i < byteArr.length; i += 255) {
    const chunk = byteArr.slice(i, i + 255);
    result.push(chunk.length, ...chunk);
  }
  result.push(0x00); // block terminator
  return result;
}

// ─── Frame builders ───────────────────────────────────────────────────────────

function makeFrame(colorFn) {
  // colorFn(x, y, t) -> [r, g, b]  (t is ignored here, used per-frame by caller)
  const colorSet = new Map();
  const pixelColorIdx = new Uint8Array(W * H);
  const colors = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [r, g, b] = colorFn(x, y);
      const key = `${r},${g},${b}`;
      if (!colorSet.has(key)) { colorSet.set(key, colors.length); colors.push([r, g, b]); }
      pixelColorIdx[y * W + x] = colorSet.get(key);
    }
  }
  return { pixels: pixelColorIdx, colors };
}

// 🔥 Fire — rising heat map columns
function makeFire() {
  const frames = [];
  const NFRAMES = 16;
  // persistent heat buffer
  const heat = new Float32Array(W * H);
  for (let f = 0; f < NFRAMES; f++) {
    // seed bottom row
    for (let x = 0; x < W; x++) heat[(H - 1) * W + x] = Math.random() > 0.3 ? 0.8 + Math.random() * 0.2 : 0.3 + Math.random() * 0.3;
    // propagate upward
    for (let y = 0; y < H - 1; y++) {
      for (let x = 0; x < W; x++) {
        const below = heat[(y + 1) * W + x];
        const bl = heat[(y + 1) * W + Math.max(0, x - 1)];
        const br = heat[(y + 1) * W + Math.min(W - 1, x + 1)];
        heat[y * W + x] = Math.max(0, (below + bl + br) / 3 - 0.03 - Math.random() * 0.02);
      }
    }
    frames.push(makeFrame((x, y) => {
      const t = heat[y * W + x];
      if (t < 0.05) return [0, 0, 0];
      if (t < 0.35) return [Math.round(t / 0.35 * 180), 0, 0];
      if (t < 0.65) return [180 + Math.round((t - 0.35) / 0.3 * 75), Math.round((t - 0.35) / 0.3 * 80), 0];
      return [255, 80 + Math.round((t - 0.65) / 0.35 * 175), Math.round((t - 0.65) / 0.35 * 60)];
    }));
  }
  return frames;
}

// 🌈 Rainbow — horizontal bands scrolling left
function makeRainbow() {
  const NFRAMES = 20;
  return Array.from({ length: NFRAMES }, (_, f) => makeFrame((x, y) => {
    const hue = ((x / W * 360) + f * 18) % 360;
    return hslToRgb(hue, 1, 0.5);
  }));
}

// 💻 Matrix — falling green characters (columns of brightness)
function makeMatrix() {
  const NFRAMES = 20;
  const cols = Array.from({ length: W }, () => ({ head: Math.floor(Math.random() * H), speed: 1 + Math.random() }));
  const brightness = new Float32Array(W * H);
  return Array.from({ length: NFRAMES }, () => {
    // move heads
    cols.forEach((c, x) => {
      c.head = (c.head + c.speed) % (H + 8);
      // set head bright, fade trail
      for (let y = 0; y < H; y++) {
        const dist = c.head - y;
        if (dist >= 0 && dist < 6) brightness[y * W + x] = Math.max(brightness[y * W + x], 1 - dist / 6);
        brightness[y * W + x] *= 0.85;
      }
    });
    return makeFrame((x, y) => {
      const b = Math.min(1, brightness[y * W + x]);
      if (b < 0.05) return [0, 0, 0];
      return [0, Math.round(b * 255), Math.round(b * 60)];
    });
  });
}

// ✨ Pulse — concentric rings expanding from center
function makePulse() {
  const NFRAMES = 16;
  const CX = W / 2, CY = H / 2;
  return Array.from({ length: NFRAMES }, (_, f) => makeFrame((x, y) => {
    const dist = Math.sqrt((x - CX) ** 2 + (y - CY) ** 2);
    const phase = (dist - f * 2) * 0.5;
    const v = (Math.sin(phase) + 1) / 2;
    const hue = (dist * 6 + f * 10) % 360;
    const [r, g, b] = hslToRgb(hue, 1, 0.5);
    return [Math.round(r * v), Math.round(g * v), Math.round(b * v)];
  }));
}

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60)       { r=c; g=x; }
  else if (h < 120) { r=x; g=c; }
  else if (h < 180) { g=c; b=x; }
  else if (h < 240) { g=x; b=c; }
  else if (h < 300) { r=x; b=c; }
  else              { r=c; b=x; }
  return [Math.round((r+m)*255), Math.round((g+m)*255), Math.round((b+m)*255)];
}

// ─── Write GIFs ───────────────────────────────────────────────────────────────

const outDir = path.join(__dirname, 'public');
const gifs = [
  { name: 'fire.gif',    frames: makeFire(),    delay: 6  },
  { name: 'rainbow.gif', frames: makeRainbow(), delay: 5  },
  { name: 'matrix.gif',  frames: makeMatrix(),  delay: 5  },
  { name: 'pulse.gif',   frames: makePulse(),   delay: 6  },
];

for (const { name, frames, delay } of gifs) {
  const buf = encodeGif(frames, delay);
  const p = path.join(outDir, name);
  fs.writeFileSync(p, buf);
  console.log(`wrote ${name}  (${buf.length} bytes, ${frames.length} frames)`);
}
