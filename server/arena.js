// Реалтайм-арена: сервер считает движение, пули и урон; клиенты шлют только ввод.
const W = 1280, H = 768, R = 12, TICK = 30, DT = 1 / TICK, MAXP = 6, WIN = 20;
const WP = [
  { n: 'Пистолет', dmg: 22, cd: .3, spd: 760, spread: .02, mag: 12, rl: 1.1, pel: 1 },
  { n: 'Автомат', dmg: 13, cd: .1, spd: 820, spread: .07, mag: 30, rl: 1.7, pel: 1 },
  { n: 'Дробовик', dmg: 9, cd: .75, spd: 700, spread: .2, mag: 6, rl: 2.1, pel: 6 },
];
const rects = [[0, 0, 40, 1], [0, 23, 40, 1], [0, 0, 1, 24], [39, 0, 1, 24], [14, 10, 3, 4], [23, 10, 3, 4]];
[[8, 3, 2, 6], [8, 15, 2, 6], [5, 10, 2, 4], [11, 0, 2, 4], [11, 20, 2, 4]].forEach(([x, y, w, h]) => rects.push([x, y, w, h], [40 - x - w, y, w, h]));
rects.forEach(r => r.forEach((v, i) => (r[i] = v * 32)));

const arenas = [];
const send = (ws, o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
const cl = v => Math.max(-1, Math.min(1, +v || 0));
const blocked = (x, y, r) => rects.some(([a, b, w, h]) => {
  const cx = Math.max(a, Math.min(x, a + w)), cy = Math.max(b, Math.min(y, b + h));
  return (x - cx) ** 2 + (y - cy) ** 2 < r * r;
});
const los = (x1, y1, x2, y2) => { for (let s = 0; s <= 20; s++) if (blocked(x1 + (x2 - x1) * s / 20, y1 + (y2 - y1) * s / 20, 3)) return false; return true; };

function step(p, ix, iy, dt) {
  const n = Math.hypot(ix, iy); if (!n) return;
  const vx = ix / n * 200 * dt, vy = iy / n * 200 * dt;
  if (!blocked(p.x + vx, p.y, R)) p.x += vx;
  if (!blocked(p.x, p.y + vy, R)) p.y += vy;
}
function spawn(p) {
  p.x = p.team ? W - 70 - Math.random() * 60 : 70 + Math.random() * 60;
  p.y = 100 + Math.random() * (H - 200);
  Object.assign(p, { hp: 100, alive: true, inv: 2, ammo: WP[p.w].mag, rl: 0, cd: 0 });
}
const mk = (id, name, team, ws, bot) => { const p = { id, name, team, ws, bot, w: 1, k: 0, d: 0, a: 0, respawn: 0, in: { x: 0, y: 0, a: 0, f: false } }; spawn(p); return p; };

function fill(a) { // до 4 игроков: недостающих заменяют боты
  const hum = a.ps.filter(p => !p.bot).length, want = Math.max(0, 4 - hum);
  const cnt = t => a.ps.filter(p => p.team === t).length, bots = () => a.ps.filter(p => p.bot).length;
  while (bots() < want) a.ps.push(mk(a.nid++, 'Бот ' + a.nid, cnt(0) <= cnt(1) ? 0 : 1, null, true));
  while (bots() > want) { const t = cnt(0) > cnt(1) ? 0 : 1; let i = a.ps.findIndex(p => p.bot && p.team === t); if (i < 0) i = a.ps.findIndex(p => p.bot); a.ps.splice(i, 1); }
}
const roster = a => a.ps.forEach(p => p.ws && send(p.ws, { t: 'a_r', r: a.ps.map(q => [q.id, q.name, q.team]) }));

function join(ws, name) {
  let a = arenas.find(a => a.ps.filter(p => !p.bot).length < MAXP);
  if (!a) arenas.push(a = { ps: [], bullets: [], sc: [0, 0], nid: 1, bid: 0, ev: [], over: 0, win: 0 });
  const cnt = t => a.ps.filter(p => p.team === t).length;
  const p = mk(a.nid++, name, cnt(0) <= cnt(1) ? 0 : 1, ws, false);
  a.ps.push(p); ws.arena = a; ws.pid = p.id; fill(a);
  send(ws, { t: 'a_init', id: p.id, rects, W, H, WP: WP.map(w => ({ n: w.n, mag: w.mag })) });
  roster(a);
}
function leave(ws) {
  const a = ws.arena; if (!a) return;
  a.ps = a.ps.filter(p => p.id !== ws.pid); ws.arena = null;
  if (!a.ps.some(p => !p.bot)) arenas.splice(arenas.indexOf(a), 1); else { fill(a); roster(a); }
}
function input(ws, m) {
  const p = ws.arena?.ps.find(p => p.id === ws.pid); if (!p) return;
  p.in = { x: cl(m.x), y: cl(m.y), a: Number.isFinite(m.a) ? m.a : 0, f: !!m.f };
  if (WP[m.w] && m.w !== p.w) { p.w = m.w; p.ammo = WP[m.w].mag; p.rl = 0; p.cd = .6; }
  if (m.r && p.rl <= 0 && p.ammo < WP[p.w].mag) p.ammo = 0;
}

function shoot(a, p) {
  const w = WP[p.w]; p.cd = w.cd; p.ammo--;
  for (let k = 0; k < w.pel; k++) {
    const an = p.a + (Math.random() - .5) * 2 * w.spread;
    a.bullets.push({ id: ++a.bid, o: p.id, t: p.team, x: p.x + Math.cos(p.a) * 18, y: p.y + Math.sin(p.a) * 18, vx: Math.cos(an) * w.spd, vy: Math.sin(an) * w.spd, life: p.w === 2 ? .38 : .7, dmg: w.dmg, w: p.w });
  }
  a.ev.push(['s', p.id, p.w]);
}
function hit(a, b, v) {
  v.hp -= b.dmg; a.ev.push(['h', v.id]);
  if (v.hp > 0) return;
  v.alive = false; v.respawn = 3; v.d++;
  const k = a.ps.find(p => p.id === b.o);
  if (k) { k.k++; a.sc[k.team]++; a.ev.push(['k', k.id, v.id, b.w]); if (a.sc[k.team] >= WIN && a.over <= 0) { a.over = 6; a.win = k.team; } }
}
function think(a, p) { // простой бот: бежит к ближайшему врагу, обходит укрытия, стреляет при видимости
  const i = p.in; i.f = false; if (!p.alive) return;
  let t = null, bd = 1e9;
  for (const q of a.ps) if (q.alive && q.team !== p.team) { const d = Math.hypot(q.x - p.x, q.y - p.y); if (d < bd) { bd = d; t = q; } }
  if (!t) { i.x = i.y = 0; return; }
  const want = Math.atan2(t.y - p.y, t.x - p.x), see = los(p.x, p.y, t.x, t.y);
  if ((p.bt = (p.bt || 0) - DT) <= 0) { p.bt = .5 + Math.random(); p.sd = Math.random() < .5 ? 1 : -1; }
  if (bd < 240 && see) { i.x = -Math.sin(want) * p.sd; i.y = Math.cos(want) * p.sd; }
  else { const d = want + (see ? 0 : p.sd * .9); i.x = Math.cos(d); i.y = Math.sin(d); }
  i.a = want + (Math.random() - .5) * .25; i.f = see && bd < 520 && Math.random() < .5;
}

function tick(a) {
  a.ev = [];
  if (a.over > 0 && (a.over -= DT) <= 0) { a.sc = [0, 0]; a.ps.forEach(p => { p.k = p.d = 0; spawn(p); }); }
  for (const p of a.ps) {
    if (p.bot) think(a, p);
    if (!p.alive) { if (a.over <= 0 && (p.respawn -= DT) <= 0) spawn(p); continue; }
    const i = p.in; p.inv = Math.max(0, p.inv - DT); p.cd -= DT; p.a = i.a;
    step(p, i.x, i.y, DT);
    if (p.rl > 0) { if ((p.rl -= DT) <= 0) p.ammo = WP[p.w].mag; }
    else if (i.f && p.cd <= 0 && a.over <= 0) shoot(a, p);
    if (p.ammo <= 0 && p.rl <= 0) p.rl = WP[p.w].rl;
  }
  a.bullets = a.bullets.filter(b => {
    for (let s = 0; s < 3; s++) {
      b.x += b.vx * DT / 3; b.y += b.vy * DT / 3;
      if (blocked(b.x, b.y, 2)) { a.ev.push(['w', b.x | 0, b.y | 0]); return false; }
      const v = a.ps.find(p => p.alive && !p.inv && p.team !== b.t && (p.x - b.x) ** 2 + (p.y - b.y) ** 2 < (R + 3) ** 2);
      if (v) { hit(a, b, v); return false; }
    }
    return (b.life -= DT) > 0;
  });
  const r = n => Math.round(n * 10) / 10;
  const snap = { t: 'a_s', sc: a.sc, ev: a.ev, over: a.over > 0 ? a.win : -1,
    p: a.ps.map(p => [p.id, r(p.x), r(p.y), r(p.a), p.hp, p.alive ? 1 : 0, p.w, p.inv > 0 ? 1 : 0, p.k, p.d]),
    b: a.bullets.map(b => [b.id, r(b.x), r(b.y), b.w]) };
  for (const p of a.ps) if (p.ws) send(p.ws, { ...snap, me: [p.ammo, r(Math.max(0, p.rl)), r(Math.max(0, p.respawn))] });
}
setInterval(() => arenas.forEach(tick), 1000 / TICK);
module.exports = { join, leave, input };
