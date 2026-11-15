import { createRequire } from 'node:module';
import path from 'node:path';
import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';
import { fmt, rand } from './util.js';

const require = createRequire(import.meta.url);
const fontDir = path.join(path.dirname(require.resolve('dejavu-fonts-ttf/package.json')), 'ttf');
// Bundled so cards render the same on Render's Linux, which ships with almost no fonts.
GlobalFonts.registerFromPath(path.join(fontDir, 'DejaVuSans.ttf'), 'CardRegular');
GlobalFonts.registerFromPath(path.join(fontDir, 'DejaVuSans-Bold.ttf'), 'CardBold');

// ELEVATE brand: the three chevron purples from the logo on a deep night background.
const INK = '#110e22';
const PANEL = '#1c1838';
const TRACK = '#2e2950';
const TEXT = '#f4f2ff';
const MUTED = '#b9b3da';
const ACCENT = '#8f7eff';
const ACCENT_2 = '#dcd6fe';

async function fetchImage(source) {
  if (!source) return null;
  try {
    if (Buffer.isBuffer(source)) return await loadImage(source);
    const res = await fetch(source, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    return await loadImage(Buffer.from(await res.arrayBuffer()));
  } catch {
    return null;
  }
}

function fitText(ctx, text, weight, maxWidth, startSize, minSize = 16) {
  let size = startSize;
  ctx.font = `${size}px ${weight}`;
  while (ctx.measureText(text).width > maxWidth && size > minSize) {
    size -= 2;
    ctx.font = `${size}px ${weight}`;
  }
  let output = text;
  while (ctx.measureText(output).width > maxWidth && output.length > 1) output = output.slice(0, -1);
  return output === text ? text : `${output.slice(0, -1)}…`;
}

function drawCover(ctx, image, w, h) {
  const scale = Math.max(w / image.width, h / image.height);
  ctx.drawImage(image, (w - image.width * scale) / 2, (h - image.height * scale) / 2, image.width * scale, image.height * scale);
}

function drawAvatar(ctx, image, x, y, size, ring = ACCENT) {
  const r = size / 2;
  ctx.save();
  ctx.beginPath();
  ctx.arc(x + r, y + r, r + 6, 0, Math.PI * 2);
  ctx.fillStyle = ring;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x + r, y + r, r, 0, Math.PI * 2);
  ctx.clip();
  if (image) ctx.drawImage(image, x, y, size, size);
  else {
    ctx.fillStyle = TRACK;
    ctx.fillRect(x, y, size, size);
  }
  ctx.restore();
}

function drawBar(ctx, x, y, w, h, ratio) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, h / 2);
  ctx.fillStyle = TRACK;
  ctx.fill();
  const fill = Math.max(h, w * Math.min(1, Math.max(0, ratio)));
  const gradient = ctx.createLinearGradient(x, 0, x + w, 0);
  gradient.addColorStop(0, ACCENT);
  gradient.addColorStop(1, ACCENT_2);
  ctx.beginPath();
  ctx.roundRect(x, y, fill, h, h / 2);
  ctx.fillStyle = gradient;
  ctx.fill();
}

function frame(w, h) {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = INK;
  ctx.fillRect(0, 0, w, h);
  return { canvas, ctx };
}

export async function welcomeCard({ avatarUrl, title, name, subtitle, background }) {
  const w = 1000;
  const h = 340;
  const { canvas, ctx } = frame(w, h);
  const [bg, avatar] = await Promise.all([fetchImage(background), fetchImage(avatarUrl)]);
  if (bg) {
    drawCover(ctx, bg, w, h);
    const shade = ctx.createLinearGradient(0, 0, w, 0);
    shade.addColorStop(0, 'rgba(15,17,23,0.92)');
    shade.addColorStop(1, 'rgba(15,17,23,0.45)');
    ctx.fillStyle = shade;
    ctx.fillRect(0, 0, w, h);
  } else {
    const glow = ctx.createRadialGradient(150, 170, 40, 150, 170, 620);
    glow.addColorStop(0, '#2a2160');
    glow.addColorStop(1, INK);
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.fillStyle = ACCENT;
  ctx.fillRect(0, 0, 10, h);
  drawAvatar(ctx, avatar, 70, 70, 200);

  const textX = 320;
  const maxWidth = w - textX - 50;
  ctx.fillStyle = ACCENT;
  ctx.fillText(fitText(ctx, title.toUpperCase(), 'CardBold', maxWidth, 26), textX, 120);
  ctx.fillStyle = TEXT;
  ctx.fillText(fitText(ctx, name, 'CardBold', maxWidth, 60, 26), textX, 195);
  ctx.fillStyle = '#d6d9e2';
  ctx.fillText(fitText(ctx, subtitle, 'CardRegular', maxWidth, 28), textX, 248);
  return canvas.encode('png');
}

export async function rankCard({ avatarUrl, name, rank, level, current, needed, voiceLevel }) {
  const w = 900;
  const h = 260;
  const { canvas, ctx } = frame(w, h);
  ctx.fillStyle = PANEL;
  ctx.beginPath();
  ctx.roundRect(16, 16, w - 32, h - 32, 18);
  ctx.fill();
  drawAvatar(ctx, await fetchImage(avatarUrl), 50, 60, 140);

  const x = 235;
  const right = w - 55;
  ctx.fillStyle = TEXT;
  ctx.fillText(fitText(ctx, name, 'CardBold', 330, 38, 20), x, 105);

  ctx.textAlign = 'right';
  ctx.fillStyle = ACCENT;
  ctx.font = '40px CardBold';
  ctx.fillText(String(level), right, 105);
  const levelWidth = ctx.measureText(String(level)).width;
  ctx.fillStyle = MUTED;
  ctx.font = '20px CardRegular';
  ctx.fillText('LEVEL', right - levelWidth - 12, 105);
  const levelLabel = ctx.measureText('LEVEL').width;
  ctx.fillStyle = TEXT;
  ctx.font = '40px CardBold';
  const rankText = `#${rank}`;
  ctx.fillText(rankText, right - levelWidth - levelLabel - 34, 105);
  const rankWidth = ctx.measureText(rankText).width;
  ctx.fillStyle = MUTED;
  ctx.font = '20px CardRegular';
  ctx.fillText('RANK', right - levelWidth - levelLabel - rankWidth - 46, 105);
  ctx.textAlign = 'left';

  drawBar(ctx, x, 132, right - x, 30, needed ? current / needed : 0);
  ctx.fillStyle = MUTED;
  ctx.font = '20px CardRegular';
  ctx.fillText(`Voice level ${voiceLevel}`, x, 198);
  ctx.textAlign = 'right';
  ctx.fillStyle = TEXT;
  ctx.fillText(`${fmt(current)} / ${fmt(needed)} XP`, right, 198);
  ctx.textAlign = 'left';
  return canvas.encode('png');
}

export async function profileCard({ avatarUrl, name, bio, level, rank, credits, currency, rep }) {
  const w = 860;
  const h = 400;
  const { canvas, ctx } = frame(w, h);
  ctx.fillStyle = PANEL;
  ctx.beginPath();
  ctx.roundRect(16, 16, w - 32, h - 32, 18);
  ctx.fill();
  const band = ctx.createLinearGradient(0, 0, w, 0);
  band.addColorStop(0, ACCENT);
  band.addColorStop(1, ACCENT_2);
  ctx.fillStyle = band;
  ctx.beginPath();
  ctx.roundRect(16, 16, w - 32, 110, [18, 18, 0, 0]);
  ctx.fill();
  drawAvatar(ctx, await fetchImage(avatarUrl), 55, 55, 140, PANEL);

  ctx.fillStyle = TEXT;
  ctx.fillText(fitText(ctx, name, 'CardBold', w - 300, 38, 20), 225, 170);
  ctx.fillStyle = MUTED;
  ctx.fillText(fitText(ctx, bio || 'No bio yet. Set one with /bio.', 'CardRegular', w - 110, 22), 55, 245);

  const stats = [['LEVEL', fmt(level)], ['RANK', `#${fmt(rank)}`], [currency.toUpperCase(), fmt(credits)], ['REP', fmt(rep)]];
  const cell = (w - 110) / stats.length;
  stats.forEach(([label, value], index) => {
    const x = 55 + cell * index;
    ctx.fillStyle = MUTED;
    ctx.font = '18px CardRegular';
    ctx.fillText(fitText(ctx, label, 'CardRegular', cell - 20, 18, 12), x, 310);
    ctx.fillStyle = TEXT;
    ctx.fillText(fitText(ctx, value, 'CardBold', cell - 20, 34, 18), x, 352);
  });
  return canvas.encode('png');
}

export async function captchaImage(code) {
  const w = 320;
  const h = 110;
  const { canvas, ctx } = frame(w, h);
  ctx.fillStyle = '#eef0f4';
  ctx.fillRect(0, 0, w, h);
  for (let n = 0; n < 7; n += 1) {
    ctx.strokeStyle = `hsl(${rand(0, 360)} 60% 55%)`;
    ctx.lineWidth = rand(1, 3);
    ctx.beginPath();
    ctx.moveTo(rand(0, w), rand(0, h));
    ctx.bezierCurveTo(rand(0, w), rand(0, h), rand(0, w), rand(0, h), rand(0, w), rand(0, h));
    ctx.stroke();
  }
  [...code].forEach((char, index) => {
    ctx.save();
    ctx.translate(38 + index * 56, 72 + rand(-8, 8));
    ctx.rotate((rand(-22, 22) * Math.PI) / 180);
    ctx.font = `${rand(46, 58)}px CardBold`;
    ctx.fillStyle = `hsl(${rand(200, 300)} 70% 30%)`;
    ctx.fillText(char, 0, 0);
    ctx.restore();
  });
  for (let n = 0; n < 180; n += 1) {
    ctx.fillStyle = `rgba(0,0,0,${rand(1, 4) / 10})`;
    ctx.fillRect(rand(0, w), rand(0, h), 2, 2);
  }
  return canvas.encode('png');
}

export async function lineChart({ title, labels, values }) {
  const w = 900;
  const h = 400;
  const { canvas, ctx } = frame(w, h);
  ctx.fillStyle = TEXT;
  ctx.font = '26px CardBold';
  ctx.fillText(title, 40, 50);

  const area = { x: 80, y: 80, w: w - 120, h: h - 140 };
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? area.w / (values.length - 1) : 0;
  const px = (index) => area.x + step * index;
  const py = (value) => area.y + area.h - (value / max) * area.h;

  ctx.font = '16px CardRegular';
  for (let n = 0; n <= 4; n += 1) {
    const y = area.y + (area.h / 4) * n;
    ctx.strokeStyle = TRACK;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(area.x, y);
    ctx.lineTo(area.x + area.w, y);
    ctx.stroke();
    ctx.fillStyle = MUTED;
    ctx.textAlign = 'right';
    ctx.fillText(fmt(Math.round(max - (max / 4) * n)), area.x - 12, y + 6);
  }
  ctx.textAlign = 'left';

  if (values.length) {
    ctx.beginPath();
    ctx.moveTo(px(0), py(values[0]));
    values.forEach((v, index) => ctx.lineTo(px(index), py(v)));
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.lineTo(px(values.length - 1), area.y + area.h);
    ctx.lineTo(px(0), area.y + area.h);
    ctx.closePath();
    const fill = ctx.createLinearGradient(0, area.y, 0, area.y + area.h);
    fill.addColorStop(0, 'rgba(143,126,255,0.35)');
    fill.addColorStop(1, 'rgba(143,126,255,0)');
    ctx.fillStyle = fill;
    ctx.fill();

    ctx.fillStyle = MUTED;
    const every = Math.max(1, Math.ceil(labels.length / 7));
    labels.forEach((label, index) => {
      if (index % every === 0) ctx.fillText(label, px(index) - 22, area.y + area.h + 30);
    });
  }
  return canvas.encode('png');
}
