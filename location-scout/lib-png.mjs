/**
 * lib-png.mjs — dependency-free PNG writer + procedural scouting-photo generator.
 * Pure Node built-ins (zlib only). Produces a distinct, recognisable plate per
 * location so the gallery is readable instead of 190 identical grey squares.
 */
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

export function encodePNG(w, h, rgb) {
  // rgb: Buffer of w*h*3. Prepend a zero filter byte per scanline.
  const raw = Buffer.alloc(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const FONT = {
  A:['01110','10001','10001','11111','10001','10001','10001'],B:['11110','10001','10001','11110','10001','10001','11110'],
  C:['01110','10001','10000','10000','10000','10001','01110'],D:['11110','10001','10001','10001','10001','10001','11110'],
  E:['11111','10000','10000','11110','10000','10000','11111'],F:['11111','10000','10000','11110','10000','10000','10000'],
  G:['01110','10001','10000','10111','10001','10001','01111'],H:['10001','10001','10001','11111','10001','10001','10001'],
  I:['11111','00100','00100','00100','00100','00100','11111'],J:['00111','00010','00010','00010','00010','10010','01100'],
  K:['10001','10010','10100','11000','10100','10010','10001'],L:['10000','10000','10000','10000','10000','10000','11111'],
  M:['10001','11011','10101','10101','10001','10001','10001'],N:['10001','11001','10101','10011','10001','10001','10001'],
  O:['01110','10001','10001','10001','10001','10001','01110'],P:['11110','10001','10001','11110','10000','10000','10000'],
  Q:['01110','10001','10001','10001','10101','10010','01101'],R:['11110','10001','10001','11110','10100','10010','10001'],
  S:['01111','10000','10000','01110','00001','00001','11110'],T:['11111','00100','00100','00100','00100','00100','00100'],
  U:['10001','10001','10001','10001','10001','10001','01110'],V:['10001','10001','10001','10001','10001','01010','00100'],
  W:['10001','10001','10001','10101','10101','11011','10001'],X:['10001','10001','01010','00100','01010','10001','10001'],
  Y:['10001','10001','01010','00100','00100','00100','00100'],Z:['11111','00001','00010','00100','01000','10000','11111'],
  0:['01110','10001','10011','10101','11001','10001','01110'],1:['00100','01100','00100','00100','00100','00100','01110'],
  2:['01110','10001','00001','00010','00100','01000','11111'],3:['11111','00010','00100','00010','00001','10001','01110'],
  4:['00010','00110','01010','10010','11111','00010','00010'],5:['11111','10000','11110','00001','00001','10001','01110'],
  6:['00110','01000','10000','11110','10001','10001','01110'],7:['11111','00001','00010','00100','01000','01000','01000'],
  8:['01110','10001','10001','01110','10001','10001','01110'],9:['01110','10001','10001','01111','00001','00010','01100'],
  '-':['00000','00000','00000','11111','00000','00000','00000'],'.':['00000','00000','00000','00000','00000','01100','01100'],
  '/':['00001','00010','00010','00100','01000','01000','10000'],':':['00000','01100','01100','00000','01100','01100','00000'],
  "'":['00100','00100','00000','00000','00000','00000','00000'],',':['00000','00000','00000','00000','01100','00100','01000'],
  ' ':['00000','00000','00000','00000','00000','00000','00000'],
};

export function makeCanvas(w, h) {
  const buf = Buffer.alloc(w * h * 3);
  // Coordinates MUST be integers: a float index into the Buffer is silently
  // discarded, which drops the write with no error.
  const px = (x, y, r, g, b) => {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 3;
    buf[i] = r & 255; buf[i + 1] = g & 255; buf[i + 2] = b & 255;
  };
  const blend = (x, y, r, g, b, a) => {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 3;
    buf[i] = buf[i] * (1 - a) + r * a;
    buf[i + 1] = buf[i + 1] * (1 - a) + g * a;
    buf[i + 2] = buf[i + 2] * (1 - a) + b * a;
  };
  const rect = (x0, y0, x1, y1, r, g, b, a = 1) => {
    const ya = Math.max(0, Math.round(y0)), yb = Math.min(h, Math.round(y1));
    const xa = Math.max(0, Math.round(x0)), xb = Math.min(w, Math.round(x1));
    for (let y = ya; y < yb; y++)
      for (let x = xa; x < xb; x++) a >= 1 ? px(x, y, r, g, b) : blend(x, y, r, g, b, a);
  };
  const tri = (cx, baseY, halfW, topY, r, g, b) => {
    baseY = Math.round(baseY); topY = Math.round(topY);
    const H = baseY - topY;
    for (let y = topY; y < baseY; y++) {
      const t = (y - topY) / H, hw = halfW * t;
      for (let x = Math.round(cx - hw); x <= Math.round(cx + hw); x++) px(x, y, r, g, b);
    }
  };
  const text = (str, x, y, scale, r, g, b) => {
    let cx = x;
    for (const chRaw of String(str).toUpperCase()) {
      const glyph = FONT[chRaw] || FONT[' '];
      for (let gy = 0; gy < 7; gy++)
        for (let gx = 0; gx < 5; gx++)
          if (glyph[gy][gx] === '1') rect(cx + gx * scale, y + gy * scale, cx + (gx + 1) * scale, y + (gy + 1) * scale, r, g, b);
      cx += 6 * scale;
    }
    return cx;
  };
  return { buf, w, h, px, blend, rect, tri, text };
}

const SKY = {
  'Morning':      [[176, 200, 224], [236, 214, 200]],
  'Midday':       [[104, 156, 214], [196, 218, 236]],
  'Afternoon':    [[122, 162, 206], [216, 210, 190]],
  'Golden Hour':  [[196, 132, 74], [246, 202, 126]],
  'Blue Hour':    [[38, 52, 92], [110, 122, 160]],
  'Night':        [[10, 14, 30], [30, 38, 64]],
};
const GROUND = {
  'Winter': [232, 236, 242], 'Spring': [96, 128, 74], 'Summer': [62, 104, 56], 'Fall': [150, 108, 52],
};

/** Deterministic per-photo RNG so reruns produce byte-identical images. */
function rngFrom(seedStr) {
  let s = 2166136261;
  for (let i = 0; i < seedStr.length; i++) { s ^= seedStr.charCodeAt(i); s = Math.imul(s, 16777619); }
  return () => { s = Math.imul(s ^ (s >>> 15), 2246822507); s ^= s >>> 13; return ((s >>> 0) % 100000) / 100000; };
}

export function renderPhoto({ code, name, shotType, setting, timeOfDay, season, category, city }) {
  const W = 640, H = 428;
  const c = makeCanvas(W, H);
  const rnd = rngFrom(code + name + shotType);
  const night = timeOfDay === 'Night' || timeOfDay === 'Blue Hour';

  if (setting === 'Interior') {
    // Interior plate: wall wash, floor line, window light pools.
    const wall = night ? [52, 50, 58] : [148, 140, 128];
    for (let y = 0; y < H; y++) {
      const t = y / H;
      for (let x = 0; x < W; x++) {
        const vig = 1 - 0.35 * Math.abs(x / W - 0.5) * 2;
        const k = (0.75 + 0.35 * (1 - t)) * vig;
        c.px(x, y, wall[0] * k, wall[1] * k, wall[2] * k);
      }
    }
    const floorY = Math.round(H * 0.70);
    c.rect(0, floorY, W, H, night ? 34 : 96, night ? 32 : 86, night ? 36 : 78);
    c.rect(0, floorY - 2, W, floorY, night ? 70 : 180, night ? 66 : 172, night ? 70 : 160);
    // Windows throwing light
    const nWin = 2 + Math.floor(rnd() * 3);
    for (let i = 0; i < nWin; i++) {
      const wx = Math.round(40 + i * (W - 90) / nWin + rnd() * 20);
      const wy = Math.round(H * 0.16), ww = 60, wh = Math.round(H * 0.34);
      c.rect(wx, wy, wx + ww, wy + wh, night ? 60 : 236, night ? 68 : 240, night ? 96 : 228);
      c.rect(wx - 3, wy - 3, wx + ww + 3, wy, 40, 38, 36);
      c.rect(wx - 3, wy + wh, wx + ww + 3, wy + wh + 3, 40, 38, 36);
      // light pool on the floor
      if (!night) for (let y = floorY; y < H; y++) {
        const spread = (y - floorY) * 0.9;
        c.rect(wx - spread, y, wx + ww + spread, y + 1, 250, 244, 214, 0.16 * (1 - (y - floorY) / (H - floorY)));
      }
    }
  } else {
    // Exterior plate: sky gradient -> horizon -> ground, with category silhouettes.
    const [top, bot] = SKY[timeOfDay] || SKY['Midday'];
    const horizon = Math.round(H * (0.52 + rnd() * 0.1));
    for (let y = 0; y < horizon; y++) {
      const t = y / horizon;
      const r = top[0] + (bot[0] - top[0]) * t, g = top[1] + (bot[1] - top[1]) * t, b = top[2] + (bot[2] - top[2]) * t;
      for (let x = 0; x < W; x++) c.px(x, y, r, g, b);
    }
    if (timeOfDay === 'Night') for (let i = 0; i < 130; i++) {
      const sx = Math.floor(rnd() * W), sy = Math.floor(rnd() * horizon * 0.8);
      c.px(sx, sy, 240, 240, 250);
    }
    if (timeOfDay === 'Golden Hour') {
      const sunX = Math.round(W * (0.2 + rnd() * 0.6)), sunY = horizon - 30;
      for (let r0 = 46; r0 > 0; r0--) {
        const a = 0.03 + 0.5 * (1 - r0 / 46);
        for (let a2 = 0; a2 < 360; a2 += 3) {
          const x = Math.round(sunX + Math.cos(a2 * Math.PI / 180) * r0), y = Math.round(sunY + Math.sin(a2 * Math.PI / 180) * r0);
          c.blend(x, y, 255, 236, 180, a * 0.25);
        }
      }
    }
    const g0 = GROUND[season] || GROUND['Summer'];
    const water = ['Waterfront', 'Recreation'].includes(category);
    if (water) {
      c.rect(0, horizon, W, H, night ? 22 : 58, night ? 34 : 92, night ? 58 : 120);
      for (let i = 0; i < 90; i++) {
        const y = horizon + Math.floor(rnd() * (H - horizon)), x = Math.floor(rnd() * W);
        const len = 6 + Math.floor(rnd() * 40);
        c.rect(x, y, x + len, y + 1, 200, 220, 235, 0.18);
      }
    } else {
      for (let y = horizon; y < H; y++) {
        const t = (y - horizon) / (H - horizon), k = night ? 0.35 : 0.8 + 0.4 * t;
        for (let x = 0; x < W; x++) c.px(x, y, g0[0] * k, g0[1] * k, g0[2] * k);
      }
    }

    const dark = night ? [12, 14, 24] : [38, 42, 48];
    const D = (x0, y0, x1, y1) => c.rect(x0, y0, x1, y1, dark[0], dark[1], dark[2]);
    if (category === 'Forest / Wilderness') {
      for (let i = 0; i < 16; i++) {
        const x = Math.round(rnd() * W), hh = 70 + rnd() * 130;
        c.tri(x, horizon + 12, 16 + rnd() * 12, horizon - hh, dark[0], dark[1], dark[2]);
      }
    } else if (category === 'Industrial') {
      for (let i = 0; i < 5; i++) {
        const x = 40 + i * 120 + rnd() * 30, wd = 30 + rnd() * 50, hh = 70 + rnd() * 140;
        D(x, horizon - hh, x + wd, horizon);
        if (rnd() > 0.5) D(x + wd * 0.3, horizon - hh - 60, x + wd * 0.55, horizon - hh);
      }
    } else if (category === 'Rural / Farm') {
      const bx = W * 0.25, bw = 150, bh = 90;
      D(bx, horizon - bh, bx + bw, horizon);
      c.tri(bx + bw / 2, horizon - bh, bw / 2 + 8, horizon - bh - 46, dark[0], dark[1], dark[2]);
      D(bx + bw + 40, horizon - 140, bx + bw + 78, horizon);
    } else if (['Urban Street', 'Commercial', 'Historic', 'Institutional', 'Residential', 'Interior Studio'].includes(category)) {
      let x = 10;
      while (x < W) {
        const wd = 50 + rnd() * 70, hh = 80 + rnd() * 170;
        D(x, horizon - hh, x + wd, horizon);
        for (let wy = horizon - hh + 12; wy < horizon - 14; wy += 22)
          for (let wx = x + 8; wx < x + wd - 10; wx += 18)
            if (rnd() > 0.45) c.rect(wx, wy, wx + 8, wy + 11, night ? 236 : 120, night ? 214 : 130, night ? 140 : 140);
        x += wd + 6 + rnd() * 14;
      }
    } else if (category === 'Roadway') {
      const cx = W / 2;
      for (let y = horizon; y < H; y++) {
        const t = (y - horizon) / (H - horizon), hw = 12 + t * 300;
        c.rect(cx - hw, y, cx + hw, y + 1, 54, 54, 58);
        if (Math.floor(y / 14) % 2 === 0) c.rect(cx - 2 - t * 4, y, cx + 2 + t * 4, y + 1, 226, 214, 120);
      }
    } else if (category === 'Waterfront') {
      // lighthouse / dock structure on the shoreline
      const lx = W * (0.15 + rnd() * 0.6);
      D(lx, horizon - 120, lx + 26, horizon);
      c.rect(lx - 5, horizon - 138, lx + 31, horizon - 120, dark[0], dark[1], dark[2]);
      if (night) c.rect(lx + 2, horizon - 134, lx + 24, horizon - 124, 250, 230, 150);
    }
    // Horizon haze
    c.rect(0, horizon - 3, W, horizon + 1, 255, 255, 255, night ? 0.06 : 0.18);
  }

  // Vignette
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const dx = (x / W - 0.5) * 2, dy = (y / H - 0.5) * 2;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > 0.75) c.blend(x, y, 0, 0, 0, Math.min(0.42, (d - 0.75) * 0.7));
  }

  // Caption bar
  c.rect(0, H - 46, W, H, 12, 14, 18, 0.68);
  c.rect(0, H - 46, W, H - 43, 243, 108, 36);
  c.text(`${code}  ${String(name).slice(0, 30)}`, 12, H - 36, 2, 245, 245, 245);
  c.text(`${shotType} / ${timeOfDay} / ${season} / ${String(city).slice(0, 18)}`, 12, H - 16, 1, 186, 192, 200);

  return encodePNG(W, H, c.buf);
}
