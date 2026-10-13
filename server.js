'use strict';
/* =====================================================================
   Сервер игры «Белоснежка и гномы».
   Без внешних библиотек: только встроенные модули Node.js (версия 18+).
   - GET  /                 отдаёт страницу игры (index.html)
   - GET  /api/events       поток обновлений (Server-Sent Events) для телефона
   - POST /api/create       создать комнату
   - POST /api/join         войти в комнату (или вернуться после обновления страницы)
   - POST /api/action       ход: start | flip | take | end | restart
   Комнаты хранятся в памяти: если сервер перезапустится, комнаты пропадут.
   ===================================================================== */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Game } = require('./game');

const PORT = process.env.PORT || 3000;
const INDEX = fs.readFileSync(path.join(__dirname, 'index.html'));

const MAX_PLAYERS = 6;
const SKIP_AFTER_MS = 20000;   // пропустить ход игрока, который пропал со связи
const COLLAPSE_MS = Number(process.env.COLLAPSE_MS) || 1700;  // сколько показывать обвал
const TAKE_MS = Number(process.env.TAKE_MS) || 800;          // сколько показывать «забирание» карт
const ROOM_TTL_MS = 3 * 60 * 60 * 1000;

const rooms = new Map();
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

const newCode = () => {
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += LETTERS[crypto.randomInt(LETTERS.length)];
    if (!rooms.has(c)) return c;
  }
};
const newId = () => crypto.randomBytes(8).toString('hex');
const cleanName = n => String(n || '').replace(/[<>&"]/g, '').trim().slice(0, 14);

function makeRoom() {
  return {
    code: newCode(), players: [], phase: 'lobby', game: null,
    clients: new Map(), ev: { n: 0 }, lastFlip: null, taking: null,
    timer: null, skipTimer: null, touched: Date.now()
  };
}
const isOnline = (room, pid) => { const s = room.clients.get(pid); return !!(s && s.size); };
const setEv = (room, data) => { room.ev = Object.assign({ n: room.ev.n + 1 }, data); };

/* Что видит каждый телефон. Закрытые карты приходят БЕЗ значения,
   так что подсмотреть их через код страницы нельзя. */
function view(room, pid) {
  const g = room.game;
  const v = {
    code: room.code, phase: room.phase, you: pid, ev: room.ev,
    players: room.players.map((p, i) => ({
      id: p.id, name: p.name, score: g ? g.players[i].score : 0, online: isOnline(room, p.id)
    }))
  };
  if (g) {
    v.current = g.current;
    v.allowed = g.allowed;
    v.forbidden = g.forbidden;
    v.deck = g.deck.length;
    v.pts = Game.pendingPoints(g);
    v.field = g.field.map((c, i) => {
      if (room.taking && room.taking.cards[i]) {
        const t = room.taking.cards[i];
        return { s: 'open', kind: t.kind, gem: t.gem, taken: true };
      }
      if (!c) return { s: 'empty' };
      if (g.open[i]) {
        return { s: 'open', kind: c.kind, gem: c.gem, pending: g.pending.includes(i),
                 bad: room.phase === 'collapsing' && room.lastFlip === i };
      }
      return { s: 'closed' };
    });
  }
  return v;
}

function broadcast(room) {
  for (const [pid, set] of room.clients) {
    if (!set.size) continue;
    const payload = `data: ${JSON.stringify(view(room, pid))}\n\n`;
    for (const res of set) { try { res.write(payload); } catch (e) { /* соединение закрыто */ } }
  }
}

/* Если ходящий игрок пропал со связи, через 20 секунд ход переходит дальше */
function scheduleSkip(room) {
  clearTimeout(room.skipTimer);
  if (room.phase !== 'play' || !room.game) return;
  const cur = room.players[room.game.current];
  if (isOnline(room, cur.id)) return;
  if (!room.players.some(p => isOnline(room, p.id))) return;
  room.skipTimer = setTimeout(() => {
    if (room.phase !== 'play' || !room.game) return;
    const c = room.players[room.game.current];
    if (isOnline(room, c.id)) return;
    Game.pass(room.game);
    setEv(room, { type: 'skipped', who: c.name });
    afterChange(room);
  }, SKIP_AFTER_MS);
}
function afterChange(room) {
  room.touched = Date.now();
  broadcast(room);
  scheduleSkip(room);
}

const bad = msg => ({ error: msg });

function act(room, player, body) {
  const g = room.game;
  const mine = () => g && room.players[g.current].id === player.id;
  switch (body.type) {
    case 'start': {
      if (room.phase !== 'lobby') return bad('Игра уже идёт');
      if (room.players.length < 2) return bad('Нужно минимум два гнома');
      room.game = Game.create(room.players.map(p => p.name));
      room.phase = 'play'; room.lastFlip = null; room.taking = null;
      setEv(room, { type: 'started' });
      afterChange(room);
      return { ok: true };
    }
    case 'flip': {
      if (room.phase !== 'play') return bad('Подожди секунду');
      if (!mine()) return bad('Сейчас ход другого гнома');
      const i = body.i;
      if (!Number.isInteger(i) || i < 0 || i >= g.field.length) return bad('Нет такой карты');
      const out = Game.flip(g, i);
      if (!out) return bad('Эту карту нельзя перевернуть');
      room.lastFlip = i;
      const c = g.field[i];
      const card = { kind: c.kind, gem: c.gem };
      if (out === 'collapse') {
        const lost = Game.pendingPoints(g);
        room.phase = 'collapsing';
        setEv(room, { type: 'collapse', card, lost, who: player.name });
        room.touched = Date.now();
        broadcast(room);
        room.timer = setTimeout(() => {
          Game.collapse(g);
          room.phase = 'play'; room.lastFlip = null;
          setEv(room, { type: 'collapsed' });
          afterChange(room);
        }, COLLAPSE_MS);
      } else {
        setEv(room, { type: out, card, who: player.name });
        afterChange(room);
      }
      return { ok: true };
    }
    case 'take': {
      if (room.phase !== 'play') return bad('Подожди секунду');
      if (!mine()) return bad('Сейчас ход другого гнома');
      const cards = {};
      g.pending.forEach(i => { cards[i] = g.field[i]; });
      const res = Game.take(g);
      if (!res) return bad('Пока нечего забирать');
      room.taking = { cards };
      room.phase = 'taking';
      setEv(room, { type: 'take', who: player.name, gained: res.gained });
      room.touched = Date.now();
      broadcast(room);
      room.timer = setTimeout(() => {
        Game.refill(g, res.removed);
        room.taking = null;
        if (g.over) { room.phase = 'over'; setEv(room, { type: 'end' }); }
        else { room.phase = 'play'; setEv(room, { type: 'dealt' }); }
        afterChange(room);
      }, TAKE_MS);
      return { ok: true };
    }
    case 'end': {
      if (room.phase !== 'play') return bad('Сейчас нельзя');
      clearTimeout(room.timer);
      room.phase = 'over'; room.taking = null; room.lastFlip = null;
      setEv(room, { type: 'end' });
      afterChange(room);
      return { ok: true };
    }
    case 'restart': {
      if (room.phase !== 'over') return bad('Сейчас нельзя');
      room.phase = 'lobby'; room.game = null; room.taking = null; room.lastFlip = null;
      setEv(room, { type: 'lobby' });
      afterChange(room);
      return { ok: true };
    }
    default:
      return bad('Неизвестное действие');
  }
}

/* ---------- HTTP ---------- */
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', ch => { data += ch; if (data.length > 10000) { reject(new Error('too big')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
const findRoom = code => rooms.get(String(code || '').toUpperCase().trim());

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(INDEX);
    }
    if (req.method === 'GET' && url.pathname === '/healthz') { res.writeHead(200); return res.end('ok'); }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      const room = findRoom(url.searchParams.get('room'));
      const pid = url.searchParams.get('pid');
      if (!room || !room.players.some(p => p.id === pid)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'
      });
      res.write('retry: 2000\n\n');
      let set = room.clients.get(pid);
      if (!set) { set = new Set(); room.clients.set(pid, set); }
      set.add(res);
      room.touched = Date.now();
      broadcast(room);
      scheduleSkip(room);
      req.on('close', () => {
        set.delete(res);
        room.touched = Date.now();
        broadcast(room);
        scheduleSkip(room);
      });
      return;
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      const body = await readJson(req);

      if (url.pathname === '/api/create') {
        const name = cleanName(body.name);
        if (!name) return json(res, 400, bad('Введи своё имя'));
        const room = makeRoom();
        const p = { id: newId(), name };
        room.players.push(p);
        rooms.set(room.code, room);
        return json(res, 200, { room: room.code, pid: p.id });
      }

      if (url.pathname === '/api/join') {
        const room = findRoom(body.room);
        if (!room) return json(res, 404, bad('Комната не найдена. Проверь код.'));
        if (body.pid) {
          if (room.players.some(p => p.id === body.pid)) return json(res, 200, { room: room.code, pid: body.pid });
          return json(res, 404, bad('Тебя нет в этой комнате'));
        }
        if (room.phase !== 'lobby') return json(res, 403, bad('Игра уже началась'));
        if (room.players.length >= MAX_PLAYERS) return json(res, 403, bad('В комнате уже ' + MAX_PLAYERS + ' гномов'));
        const name = cleanName(body.name);
        if (!name) return json(res, 400, bad('Введи своё имя'));
        const p = { id: newId(), name };
        room.players.push(p);
        room.touched = Date.now();
        broadcast(room);
        return json(res, 200, { room: room.code, pid: p.id });
      }

      if (url.pathname === '/api/action') {
        const room = findRoom(body.room);
        if (!room) return json(res, 404, bad('Комната не найдена'));
        const player = room.players.find(p => p.id === body.pid);
        if (!player) return json(res, 403, bad('Ты не в этой комнате'));
        const out = act(room, player, body);
        return json(res, out.error ? 400 : 200, out);
      }
    }

    res.writeHead(404); res.end('Not found');
  } catch (e) {
    try { json(res, 400, bad('Некорректный запрос')); } catch (_) { /* уже закрыто */ }
  }
});

/* Пинг, чтобы соединения не закрывались прокси-серверами, и уборка старых комнат */
setInterval(() => {
  for (const room of rooms.values()) {
    for (const set of room.clients.values()) for (const res of set) { try { res.write(': ping\n\n'); } catch (e) { /* ignore */ } }
  }
}, 20000);
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const online = room.players.some(p => isOnline(room, p.id));
    if (!online && now - room.touched > ROOM_TTL_MS) {
      clearTimeout(room.timer); clearTimeout(room.skipTimer);
      rooms.delete(code);
    }
  }
}, 10 * 60 * 1000);

server.listen(PORT, () => console.log('Игра запущена: http://localhost:' + PORT));
module.exports = server;
