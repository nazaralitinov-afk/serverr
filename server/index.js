// Авторитетный игровой сервер: проверяет все ходы, клиенты только показывают состояние.
const http = require('http');
const { WebSocketServer } = require('ws');
const { Chess } = require('chess.js');
const arena = require('./arena');

const server = http.createServer((q, r) => { r.writeHead(200); r.end('gambit ok'); });
const wss = new WebSocketServer({ server });
const rooms = new Map();
const send = (ws, o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
const newCode = () => { let c; do c = Math.random().toString(36).slice(2, 6).toUpperCase(); while (rooms.has(c)); return c; };

// Каждая игра: init / move (true если ход принят) / view (что видит клиент)
const games = {
  chess: {
    init: () => ({ chess: new Chess(), last: null, over: null }),
    move(s, seat, m) {
      if (s.over || s.chess.turn() !== (seat === 0 ? 'w' : 'b')) return false;
      try { const r = s.chess.move({ from: m.from, to: m.to, promotion: 'q' }); s.last = { from: r.from, to: r.to }; }
      catch { return false; }
      const c = s.chess;
      if (c.isCheckmate()) s.over = { winner: seat, reason: 'мат' };
      else if (c.isDraw()) s.over = { winner: null, reason: c.isStalemate() ? 'пат' : 'ничья' };
      return true;
    },
    view: s => ({
      fen: s.chess.fen(), turn: s.chess.turn() === 'w' ? 0 : 1, check: s.chess.isCheck(),
      last: s.last, over: s.over, san: s.chess.history(),
      legal: s.over ? [] : s.chess.moves({ verbose: true }).map(m => [m.from, m.to]),
    }),
  },
  c4: {
    init: () => ({ b: Array.from({ length: 6 }, () => Array(7).fill(null)), turn: 0, last: null, line: null, over: null }),
    move(s, seat, m) {
      const c = m.col;
      if (s.over || s.turn !== seat || !Number.isInteger(c) || c < 0 || c > 6) return false;
      let r = 5; while (r >= 0 && s.b[r][c] !== null) r--;
      if (r < 0) return false;
      s.b[r][c] = seat; s.last = [r, c];
      for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
        const line = [[r, c]];
        for (const k of [1, -1]) {
          let y = r + dr * k, x = c + dc * k;
          while (s.b[y]?.[x] === seat) { line.push([y, x]); y += dr * k; x += dc * k; }
        }
        if (line.length >= 4) { s.line = line; s.over = { winner: seat, reason: 'четыре в ряд' }; break; }
      }
      if (!s.over && s.b[0].every(v => v !== null)) s.over = { winner: null, reason: 'доска заполнена' };
      if (!s.over) s.turn = 1 - seat;
      return true;
    },
    view: s => ({ b: s.b, turn: s.turn, last: s.last, line: s.line, over: s.over }),
  },
};

function push(room) {
  const names = room.players.map(p => p.name);
  room.players.forEach((p, i) => send(p.ws, {
    t: 'state', room: room.id, game: room.game, you: i, names,
    waiting: room.players.length < 2, ...games[room.game].view(room.state),
  }));
}

wss.on('connection', ws => {
  ws.alive = true; ws.on('pong', () => (ws.alive = true));
  let room = null;
  const seat = () => room.players.findIndex(p => p.ws === ws);

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const name = String(m.name || 'Игрок').slice(0, 16);
    if (m.t === 'a_join') { if (!ws.arena && !room) arena.join(ws, name); return; }
    if (m.t === 'a_in') return arena.input(ws, m);
    if (m.t === 'create' && games[m.game] && !room) {
      room = { id: newCode(), game: m.game, players: [{ ws, name }], state: games[m.game].init(), rematch: new Set() };
      rooms.set(room.id, room); push(room);
    } else if (m.t === 'join' && !room) {
      const r = rooms.get(String(m.room).toUpperCase());
      if (!r) return send(ws, { t: 'error', msg: 'Комната не найдена. Проверьте код.' });
      if (r.players.length >= 2) return send(ws, { t: 'error', msg: 'В комнате уже двое игроков.' });
      r.players.push({ ws, name }); room = r; push(r);
    } else if (room && room.players.length === 2) {
      if (m.t === 'move' && games[room.game].move(room.state, seat(), m)) push(room);
      else if (m.t === 'resign' && !room.state.over) { room.state.over = { winner: 1 - seat(), reason: 'сдача' }; push(room); }
      else if (m.t === 'rematch' && room.state.over) {
        room.rematch.add(ws);
        if (room.rematch.size === 2) { room.players.reverse(); room.state = games[room.game].init(); room.rematch.clear(); }
        push(room);
      }
    }
  });

  ws.on('close', () => {
    arena.leave(ws);
    if (!room) return;
    rooms.delete(room.id);
    room.players.filter(p => p.ws !== ws).forEach(p => send(p.ws, { t: 'left' }));
  });
});

setInterval(() => wss.clients.forEach(ws => { if (!ws.alive) return ws.terminate(); ws.alive = false; ws.ping(); }), 30000);
server.listen(process.env.PORT || 8080, () => console.log('Gambit server on', process.env.PORT || 8080));
