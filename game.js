'use strict';
/* =====================================================================
   ЛОГИКА ИГРЫ «Белоснежка и гномы» (без интерфейса и без сети).
   Работает только с объектом состояния. Запускается на сервере.
   ===================================================================== */
const GEMS = ['topaz', 'ruby', 'emerald', 'sapphire'];
const POINTS = { single: 1, ring: 5, chest: 10, jewel: 3, chestAll: 20 };
/* Состав стопки (на каждый вид камня) и размер поля. Меняй как хочешь. */
const CONFIG = { single: 8, ring: 4, chest: 2, jewel: 6, chestAll: 2, field: 16 };

const rnd = n => Math.floor(Math.random() * n);
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function makeDeck() {
  const d = []; let id = 0;
  for (const g of GEMS) for (const k of ['single', 'ring', 'chest']) for (let n = 0; n < CONFIG[k]; n++) d.push({ id: id++, kind: k, gem: g });
  for (let n = 0; n < CONFIG.jewel; n++) d.push({ id: id++, kind: 'jewel' });
  for (let n = 0; n < CONFIG.chestAll; n++) d.push({ id: id++, kind: 'chestAll' });
  return shuffle(d);
}

const Game = {
  create(names) {
    const s = {
      players: names.map(n => ({ name: n, score: 0 })), current: 0, deck: makeDeck(),
      field: [], open: [], allowed: [], forbidden: [], collapses: 0, pending: [], over: false
    };
    for (let i = 0; i < CONFIG.field; i++) { s.field.push(s.deck.pop()); s.open.push(false); }
    Game.resetLists(s);
    return s;
  },
  resetLists(s) {
    const g = shuffle(GEMS.slice());
    s.allowed = [g[0]]; s.forbidden = [g[1]]; s.collapses = 0;
  },
  isForbidden(s, c) { return !!c.gem && s.forbidden.includes(c.gem); },
  isScoring(s, c) { return c.kind === 'jewel' || c.kind === 'chestAll' || s.allowed.includes(c.gem); },

  /* Переворот карты. Возвращает 'collapse' | 'good' | 'neutral' | null */
  flip(s, i) {
    if (s.over || !s.field[i] || s.open[i]) return null;
    s.open[i] = true;
    const c = s.field[i];
    if (Game.isForbidden(s, c)) return 'collapse';
    if (Game.isScoring(s, c)) { s.pending.push(i); return 'good'; }
    return 'neutral';
  },
  pendingPoints(s) { return s.pending.reduce((a, i) => a + POINTS[s.field[i].kind], 0); },

  /* Обвал: карты закрываются на тех же местах, очки хода сгорают,
     1-й обвал добавляет желаемый камень, 2-й добавляет нежелаемый */
  collapse(s) {
    s.open = s.open.map(() => false); s.pending = []; s.collapses++;
    const neutral = GEMS.filter(g => !s.allowed.includes(g) && !s.forbidden.includes(g));
    if (s.collapses === 1 && neutral.length) s.allowed.push(neutral[rnd(neutral.length)]);
    else if (s.collapses === 2 && neutral.length) s.forbidden.push(neutral[0]);
    Game.nextPlayer(s);
  },

  /* Забрать очки: забранные карты уходят с поля, списки обновляются */
  take(s) {
    if (!s.pending.length) return null;
    const gained = Game.pendingPoints(s);
    s.players[s.current].score += gained;
    const removed = s.pending.slice();
    removed.forEach(i => { s.field[i] = null; });
    s.open = s.open.map(() => false); s.pending = [];
    Game.resetLists(s);
    return { gained, removed };
  },

  /* Новые карты на освободившиеся места. Если стопка уже была пуста, игра окончена */
  refill(s, removed) {
    const wasEmpty = s.deck.length === 0;
    if (!wasEmpty) removed.forEach(i => { if (s.deck.length) s.field[i] = s.deck.pop(); });
    if (wasEmpty || s.field.every(c => !c)) s.over = true;
    if (!s.over) Game.nextPlayer(s);
  },

  /* Пропуск хода (например, если игрок пропал со связи) */
  pass(s) {
    s.open = s.open.map(() => false); s.pending = [];
    Game.nextPlayer(s);
  },
  nextPlayer(s) { s.current = (s.current + 1) % s.players.length; }
};

module.exports = { Game, GEMS, POINTS, CONFIG };
