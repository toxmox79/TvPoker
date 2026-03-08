const http = require('http');
const path = require('path');
const fs   = require('fs');

// ─── MIME Types ────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

// ─── Public directory ─────────────────────────────────────────────────
const PUBLIC_DIR = path.resolve(__dirname, 'public');
console.log('Public dir:', PUBLIC_DIR);
try { console.log('Files:', fs.readdirSync(PUBLIC_DIR).join(', ')); }
catch(e) { console.error('Cannot read public dir:', e.message); }

// ─── HTTP Server ──────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];

  // /config – returns the correct public base URL for QR code generation
  if (urlPath === '/config') {
    const host  = (req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
    const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify({ baseUrl: proto + '://' + host }));
    return;
  }

  // Route aliases
  if (urlPath === '/' || urlPath === '/tv')    urlPath = '/tv.html';
  if (urlPath === '/phone')                    urlPath = '/phone.html';

  // Security: prevent path traversal
  const safePath = path.normalize(urlPath).replace(/^(\.\.[\/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  const ext = path.extname(filePath).toLowerCase();
  fs.readFile(filePath, (err, data) => {
    if (err) {
      console.error('404:', filePath);
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found: ' + urlPath);
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// ─── Socket.IO ────────────────────────────────────────────────────────
const { Server } = require('socket.io');
const io = new Server(httpServer, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling'],
  allowEIO3: true
});

// ─── Utility ──────────────────────────────────────────────────────────
function randCode() {
  const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const N = '23456789';
  return [0,1,2].map(()=>L[Math.floor(Math.random()*L.length)]).join('') + '-' +
         [0,1,2].map(()=>N[Math.floor(Math.random()*N.length)]).join('');
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function makeDeck() {
  const suits = ['s','h','d','c'];
  const ranks = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
  const deck = [];
  for (const s of suits) for (const r of ranks) deck.push(r+s);
  return shuffle(deck);
}

// ─── Hand Evaluator ───────────────────────────────────────────────────
const HAND_NAMES = [
  'High Card','One Pair','Two Pair','Three of a Kind',
  'Straight','Flush','Full House','Four of a Kind','Straight Flush','Royal Flush'
];

function cardRank(c) { return '23456789TJQKA'.indexOf(c[0]); }
function cardSuit(c) { return c[1]; }

function evaluateHand(cards) {
  const combos = combinations(cards, Math.min(5, cards.length));
  let best = null;
  for (const combo of combos) {
    const score = score5(combo);
    if (!best || compareScore(score, best.score) > 0) best = { score, cards: combo };
  }
  return best;
}

function combinations(arr, k) {
  if (k === arr.length) return [arr];
  if (k === 5 && arr.length > 5) {
    const result = [];
    function pick(start, chosen) {
      if (chosen.length === 5) { result.push([...chosen]); return; }
      for (let i = start; i <= arr.length - (5 - chosen.length); i++) {
        chosen.push(arr[i]); pick(i+1, chosen); chosen.pop();
      }
    }
    pick(0, []);
    return result;
  }
  return [arr.slice(0, k)];
}

function score5(cards) {
  const ranks = cards.map(cardRank).sort((a,b)=>b-a);
  const suits = cards.map(cardSuit);
  const flush = suits.every(s => s === suits[0]);
  const rankCounts = {};
  for (const r of ranks) rankCounts[r] = (rankCounts[r]||0)+1;
  const counts = Object.values(rankCounts).sort((a,b)=>b-a);
  const uniqueRanks = [...new Set(ranks)].sort((a,b)=>b-a);
  let straight = uniqueRanks.length === 5 && (ranks[0] - ranks[4] === 4);
  if (!straight && uniqueRanks.join(',') === '12,3,2,1,0') straight = true;

  let handRank;
  if (straight && flush) handRank = ranks[0] === 12 ? 9 : 8;
  else if (counts[0] === 4) handRank = 7;
  else if (counts[0] === 3 && counts[1] === 2) handRank = 6;
  else if (flush) handRank = 5;
  else if (straight) handRank = 4;
  else if (counts[0] === 3) handRank = 3;
  else if (counts[0] === 2 && counts[1] === 2) handRank = 2;
  else if (counts[0] === 2) handRank = 1;
  else handRank = 0;

  const byFreq = Object.entries(rankCounts)
    .sort((a,b) => b[1]-a[1] || b[0]-a[0])
    .map(e => parseInt(e[0]));
  return [handRank, ...byFreq];
}

function compareScore(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] ?? -1, bv = b[i] ?? -1;
    if (av !== bv) return av - bv;
  }
  return 0;
}

// ─── Rooms ────────────────────────────────────────────────────────────
const rooms = {};
const socketRoom = {};

function createRoom() {
  const code = randCode();
  rooms[code] = {
    code, phase: 'lobby', players: [], communityCards: [],
    pot: 0, currentIdx: 0, dealerIdx: 0, deck: [],
    handNumber: 0, lastRaiseAmount: 0, highestBet: 0,
    settings: {
      startStack: 5000, smallBlind: 25, bigBlind: 50,
      blindRaiseEvery: 5, maxBlind: 800, botCount: 0,
      botDifficulty: 'medium', timer: 30, showCards: true
    },
    timerInterval: null, timerLeft: 30,
    handsSinceBlindRaise: 0, tvSocketId: null,
  };
  return code;
}

function getPublicState(room, forPlayerId) {
  return {
    code: room.code, phase: room.phase, pot: room.pot,
    communityCards: room.communityCards, handNumber: room.handNumber,
    settings: room.settings, currentIdx: room.currentIdx,
    dealerIdx: room.dealerIdx, highestBet: room.highestBet,
    timerLeft: room.timerLeft,
    players: room.players.map(p => ({
      id: p.id, name: p.name, avatar: p.avatar, stack: p.stack,
      bet: p.bet, status: p.status, isDealer: p.isDealer,
      isSB: p.isSB, isBB: p.isBB, isMaster: p.isMaster,
      isBot: p.isBot, isActive: p.isActive,
      handName: (room.phase === 'showdown' || room.phase === 'winner') ? p.handName : null,
      cards: (p.id === forPlayerId || room.phase === 'showdown' || room.phase === 'winner')
        ? p.cards : (p.cards?.length ? ['??','??'] : []),
    }))
  };
}

// ─── Game Logic ───────────────────────────────────────────────────────
function addBots(room) {
  const BOT_NAMES = ['Dealer Dan','Lucky Lou','Ace Annie','Bluff Bill','Sharp Sid'];
  const BOT_AVATARS = ['🤖','🎲','💀','👾','🃏'];
  for (let i = 0; i < room.settings.botCount; i++) {
    room.players.push({
      id: 'bot_'+i, name: BOT_NAMES[i]||'Bot '+(i+1),
      avatar: BOT_AVATARS[i]||'🤖',
      stack: room.settings.startStack, bet: 0,
      status: 'active', cards: [], isBot: true, isMaster: false,
      isDealer: false, isSB: false, isBB: false, isActive: false, handName: ''
    });
  }
}

function startGame(room) {
  addBots(room);
  room.phase = 'dealing';
  broadcastState(room);
  setTimeout(() => startHand(room), 1000);
}

function startHand(room) {
  room.handNumber++;
  room.deck = makeDeck();
  room.communityCards = [];
  room.pot = 0;
  room.highestBet = 0;
  room.lastRaiseAmount = room.settings.bigBlind;
  room.phase = 'preflop';

  const active = room.players.filter(p => p.stack > 0);
  if (active.length < 2) { endGame(room); return; }

  for (const p of room.players) {
    p.bet = 0; p.cards = []; p.status = p.stack > 0 ? 'active' : 'out';
    p.isDealer = false; p.isSB = false; p.isBB = false; p.isActive = false; p.handName = '';
  }

  const activePlayers = room.players.filter(p => p.status === 'active');
  room.dealerIdx = (room.dealerIdx + 1) % activePlayers.length;
  activePlayers[room.dealerIdx % activePlayers.length].isDealer = true;

  for (const p of activePlayers) p.cards = [room.deck.pop(), room.deck.pop()];

  const sbIdx = (room.dealerIdx + 1) % activePlayers.length;
  const bbIdx = (room.dealerIdx + 2) % activePlayers.length;
  const sb = activePlayers[sbIdx];
  const bb = activePlayers[bbIdx];

  sb.isSB = true; bb.isBB = true;
  const sbAmount = Math.min(sb.stack, room.settings.smallBlind);
  const bbAmount = Math.min(bb.stack, room.settings.bigBlind);
  sb.bet = sbAmount; sb.stack -= sbAmount;
  bb.bet = bbAmount; bb.stack -= bbAmount;
  room.highestBet = bbAmount;
  room.pot = sbAmount + bbAmount;
  room.currentIdx = (bbIdx + 1) % activePlayers.length;

  for (const p of activePlayers) {
    if (!p.isBot && p.socketId) {
      io.to(p.socketId).emit('deal-cards', { cards: p.cards });
    }
  }

  broadcastState(room);
  scheduleAction(room);
}

function scheduleAction(room) {
  clearTimer(room);
  const actives = room.players.filter(p => p.status === 'active');
  if (!actives.length) return;
  const player = actives[room.currentIdx % actives.length];
  if (!player) return;

  player.isActive = true;
  const callAmount = Math.min(player.stack, room.highestBet - player.bet);
  const validActions = getValidActions(player, room);

  if (!player.isBot && player.socketId) {
    io.to(player.socketId).emit('your-turn', {
      callAmount, validActions,
      minRaise: Math.max(room.settings.bigBlind, room.lastRaiseAmount),
      timerLeft: room.settings.timer
    });
  }

  broadcastState(room);

  if (player.isBot) {
    const delay = 800 + Math.random() * 1500;
    setTimeout(() => botAct(room, player), delay);
    return;
  }

  if (room.settings.timer > 0) {
    room.timerLeft = room.settings.timer;
    room.timerInterval = setInterval(() => {
      room.timerLeft--;
      broadcastState(room);
      if (room.timerLeft <= 0) {
        clearTimer(room);
        const action = callAmount === 0 ? 'check' : 'fold';
        handleAction(room, player.id, action, 0);
      }
    }, 1000);
  }
}

function clearTimer(room) {
  if (room.timerInterval) { clearInterval(room.timerInterval); room.timerInterval = null; }
}

function getValidActions(player, room) {
  const callAmount = room.highestBet - player.bet;
  const actions = ['fold'];
  if (callAmount <= 0) actions.push('check'); else actions.push('call');
  if (player.stack > callAmount) { actions.push('raise'); actions.push('allIn'); }
  else actions.push('allIn');
  return actions;
}

function handleAction(room, playerId, action, amount) {
  clearTimer(room);
  const actives = room.players.filter(p => p.status === 'active');
  const player = actives.find(p => p.id === playerId);
  if (!player || !player.isActive) return;

  player.isActive = false;

  if (action === 'fold') {
    player.status = 'folded';
  } else if (action === 'check') {
    // nothing
  } else if (action === 'call') {
    const ca = Math.min(player.stack, room.highestBet - player.bet);
    player.stack -= ca; player.bet += ca; room.pot += ca;
    if (player.stack === 0) player.status = 'allIn';
  } else if (action === 'raise') {
    const minRaise = Math.max(room.settings.bigBlind, room.lastRaiseAmount);
    const raiseTo = Math.max(room.highestBet + minRaise, Math.min(amount, player.stack + player.bet));
    const toAdd = Math.min(player.stack, raiseTo - player.bet);
    room.lastRaiseAmount = raiseTo - room.highestBet;
    room.highestBet = raiseTo;
    player.stack -= toAdd; player.bet += toAdd; room.pot += toAdd;
    if (player.stack === 0) player.status = 'allIn';
  } else if (action === 'allIn') {
    const toAdd = player.stack;
    if (player.bet + toAdd > room.highestBet) {
      room.lastRaiseAmount = (player.bet + toAdd) - room.highestBet;
      room.highestBet = player.bet + toAdd;
    }
    player.bet += toAdd; room.pot += toAdd; player.stack = 0; player.status = 'allIn';
  }

  const stillActive = room.players.filter(p => p.status === 'active');
  const allCalled = stillActive.every(p => p.bet === room.highestBet);
  const onlyOne = room.players.filter(p => p.status === 'active' || p.status === 'allIn').length <= 1;

  if (onlyOne || (stillActive.length <= 1 && allCalled)) { nextPhase(room); return; }
  if (allCalled) { nextPhase(room); return; }

  room.currentIdx = (room.currentIdx + 1) % actives.length;
  let safety = 0;
  while (actives[room.currentIdx % actives.length]?.status === 'folded' && safety++ < actives.length) {
    room.currentIdx = (room.currentIdx + 1) % actives.length;
  }

  broadcastState(room);
  scheduleAction(room);
}

function nextPhase(room) {
  for (const p of room.players) p.bet = 0;
  room.highestBet = 0;
  room.lastRaiseAmount = room.settings.bigBlind;

  const inHand = room.players.filter(p => p.status === 'active' || p.status === 'allIn');
  if (inHand.filter(p=>p.status==='active').length <= 1 || room.phase === 'river') {
    showdown(room); return;
  }

  const phases = ['preflop','flop','turn','river'];
  const idx = phases.indexOf(room.phase);
  room.phase = phases[idx+1] || 'showdown';

  if (room.phase === 'flop') {
    room.deck.pop();
    room.communityCards.push(room.deck.pop(), room.deck.pop(), room.deck.pop());
  } else if (room.phase === 'turn' || room.phase === 'river') {
    room.deck.pop();
    room.communityCards.push(room.deck.pop());
  }

  const actives = room.players.filter(p => p.status === 'active');
  room.currentIdx = 0;
  broadcastState(room);
  if (actives.length > 0) scheduleAction(room); else showdown(room);
}

function showdown(room) {
  room.phase = 'showdown';
  const inHand = room.players.filter(p => p.status === 'active' || p.status === 'allIn');

  for (const p of inHand) {
    if (p.cards.length === 2 && !p.cards.includes('??')) {
      const result = evaluateHand([...p.cards, ...room.communityCards]);
      p.handName = result ? HAND_NAMES[result.score[0]] : 'High Card';
    }
  }
  broadcastState(room);

  let best = null;
  const winners = [];
  for (const p of inHand) {
    if (p.cards.includes('??')) continue;
    const result = evaluateHand([...p.cards, ...room.communityCards]);
    if (!result) continue;
    if (!best || compareScore(result.score, best.score) > 0) {
      best = result; winners.length = 0; winners.push(p);
    } else if (compareScore(result.score, best.score) === 0) {
      winners.push(p);
    }
  }

  const share = winners.length ? Math.floor(room.pot / winners.length) : 0;
  for (const w of winners) w.stack += share;

  io.to(room.code).emit('winner', {
    winners: winners.map(w => ({ id: w.id, name: w.name, avatar: w.avatar, handName: w.handName, amount: share })),
    pot: room.pot
  });

  room.phase = 'winner';
  broadcastState(room);

  room.handsSinceBlindRaise = (room.handsSinceBlindRaise||0) + 1;
  if (room.settings.blindRaiseEvery > 0 && room.handsSinceBlindRaise >= room.settings.blindRaiseEvery) {
    room.handsSinceBlindRaise = 0;
    room.settings.smallBlind = Math.min(room.settings.smallBlind * 2, room.settings.maxBlind);
    room.settings.bigBlind = room.settings.smallBlind * 2;
    io.to(room.code).emit('blind-raise', { small: room.settings.smallBlind, big: room.settings.bigBlind });
  }

  setTimeout(() => {
    const remaining = room.players.filter(p => p.stack > 0 && p.status !== 'out');
    if (remaining.length < 2) { endGame(room); return; }
    for (const p of room.players) if (p.stack <= 0) p.status = 'out';
    startHand(room);
  }, 5000);
}

function endGame(room) {
  const winner = [...room.players].sort((a,b)=>b.stack-a.stack)[0];
  room.phase = 'gameover';
  io.to(room.code).emit('game-over', { winner });
  broadcastState(room);
}

// ─── Bot AI ───────────────────────────────────────────────────────────
function botAct(room, bot) {
  if (!bot.isActive) return;
  const callAmount = Math.min(bot.stack, room.highestBet - bot.bet);
  const potOdds = callAmount / (room.pot + callAmount + 1);
  const strength = estimateBotStrength(bot.cards, room.communityCards);
  const diff = room.settings.botDifficulty;
  const bluff = Math.random() < (diff === 'hard' ? 0.15 : diff === 'medium' ? 0.07 : 0.03);

  let action, amount = 0;
  if (callAmount === 0) {
    if (strength > 0.65 || bluff) {
      action = 'raise';
      amount = room.highestBet + Math.floor(room.pot * (0.3 + Math.random() * 0.4));
    } else { action = 'check'; }
  } else if (strength > 0.75 || bluff) {
    action = 'raise';
    amount = room.highestBet + Math.floor(room.pot * (0.5 + Math.random() * 0.5));
  } else if (strength > potOdds + (diff === 'easy' ? 0.1 : 0)) {
    action = 'call';
  } else { action = 'fold'; }

  if (amount > bot.stack + bot.bet) { action = 'allIn'; amount = 0; }
  handleAction(room, bot.id, action, amount);
}

function estimateBotStrength(hand, community) {
  if (!hand || hand.length < 2) return 0.3;
  const r1 = cardRank(hand[0]), r2 = cardRank(hand[1]);
  const suited = hand[0][1] === hand[1][1];
  const paired = r1 === r2;
  let base = (r1 + r2) / 26;
  if (paired) base += 0.25;
  if (suited) base += 0.08;
  for (const c of community) {
    if (cardRank(c) === r1 || cardRank(c) === r2) base += 0.15;
  }
  return Math.min(base, 1);
}

// ─── Broadcast ────────────────────────────────────────────────────────
function broadcastState(room) {
  if (room.tvSocketId) {
    io.to(room.tvSocketId).emit('game-state', getPublicState(room, '__tv__'));
  }
  for (const p of room.players) {
    if (!p.isBot && p.socketId) {
      io.to(p.socketId).emit('game-state', getPublicState(room, p.id));
    }
  }
}

// ─── Socket Events ────────────────────────────────────────────────────
io.on('connection', (socket) => {

  socket.on('create-room', () => {
    const code = createRoom();
    socketRoom[socket.id] = code;
    rooms[code].tvSocketId = socket.id;
    socket.join(code);
    socket.emit('room-created', { code });
  });

  socket.on('join-room', ({ code, name, avatar }) => {
    const room = rooms[code.toUpperCase()];
    if (!room) { socket.emit('error', { msg: 'Raum nicht gefunden' }); return; }
    if (room.phase !== 'lobby' && room.phase !== 'setup') {
      socket.emit('error', { msg: 'Spiel bereits gestartet' }); return;
    }

    socketRoom[socket.id] = code.toUpperCase();
    socket.join(code.toUpperCase());

    const isMaster = room.players.filter(p=>!p.isBot).length === 0;
    const player = {
      id: socket.id, socketId: socket.id,
      name: name || 'Spieler', avatar: avatar || '🎩',
      stack: room.settings.startStack, bet: 0,
      status: 'waiting', cards: [], isBot: false,
      isMaster, isDealer: false, isSB: false, isBB: false, isActive: false, handName: ''
    };
    room.players.push(player);
    if (isMaster) room.phase = 'setup';

    socket.emit('joined', { playerId: socket.id, isMaster });
    if (room.tvSocketId) {
      io.to(room.tvSocketId).emit('player-joined', { player: { id: player.id, name: player.name, avatar: player.avatar } });
    }
    broadcastState(room);
  });

  socket.on('update-settings', (settings) => {
    const code = socketRoom[socket.id];
    const room = rooms[code];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player?.isMaster) return;
    Object.assign(room.settings, settings);
    // Update all player stacks to new startStack (pre-game)
    if (room.phase === 'setup') {
      for (const p of room.players) p.stack = room.settings.startStack;
    }
    broadcastState(room);
  });

  socket.on('start-game', () => {
    const code = socketRoom[socket.id];
    const room = rooms[code];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player?.isMaster) return;
    startGame(room);
  });

  socket.on('player-action', ({ action, amount }) => {
    const code = socketRoom[socket.id];
    const room = rooms[code];
    if (!room) return;
    handleAction(room, socket.id, action, amount);
  });

  // ── Neue Runde starten (TV-Button) ──
  socket.on('new-game', () => {
    const code = socketRoom[socket.id];
    const room = rooms[code];
    if (!room) return;
    // Only TV socket (no player entry) or master can restart
    const isTv = room.tvSocketId === socket.id;
    const player = room.players.find(p => p.socketId === socket.id);
    if (!isTv && !player?.isMaster) return;

    clearTimer(room);

    // Reset room to lobby state, keep same code & settings
    room.phase = 'lobby';
    room.players = [];
    room.communityCards = [];
    room.pot = 0;
    room.currentIdx = 0;
    room.dealerIdx = 0;
    room.deck = [];
    room.handNumber = 0;
    room.highestBet = 0;
    room.lastRaiseAmount = room.settings.bigBlind;
    room.handsSinceBlindRaise = 0;

    // Tell everyone to go back to join screen
    io.to(code).emit('new-game-started');
    broadcastState(room);
  });

  socket.on('disconnect', () => {
    const code = socketRoom[socket.id];
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    delete socketRoom[socket.id];
    const pidx = room.players.findIndex(p => p.socketId === socket.id);
    if (pidx >= 0) {
      const p = room.players[pidx];
      if (['preflop','flop','turn','river'].includes(room.phase)) {
        p.status = 'folded';
        if (p.isActive) handleAction(room, p.id, 'fold', 0);
      }
      if (p.isMaster) {
        const next = room.players.find(pp => !pp.isBot && pp.id !== p.id);
        if (next) { next.isMaster = true; io.to(next.socketId).emit('master-assigned'); }
      }
      room.players.splice(pidx, 1);
      broadcastState(room);
    }
    if (room.tvSocketId === socket.id) room.tvSocketId = null;
  });
});

// ─── Start ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log('\n♠ Royal Poker gestartet auf Port ' + PORT);
});
