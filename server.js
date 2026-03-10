'use strict';
const http = require('http');
const path = require('path');
const fs   = require('fs');

// ─── HTTP ─────────────────────────────────────────────────────────────────────
const MIME = {
  '.html':'text/html; charset=utf-8', '.css':'text/css',
  '.js':'application/javascript',     '.json':'application/json',
  '.png':'image/png',                 '.ico':'image/x-icon',
  '.webmanifest':'application/manifest+json'
};
const PUBLIC_DIR = path.resolve(__dirname, 'public');
try { console.log('Files:', fs.readdirSync(PUBLIC_DIR).join(', ')); } catch(e) {}

const httpServer = http.createServer((req, res) => {
  let p = req.url.split('?')[0];
  if (p === '/config') {
    const host  = (req.headers['x-forwarded-host']||req.headers.host||'localhost').split(',')[0].trim();
    const proto = (req.headers['x-forwarded-proto']||'http').split(',')[0].trim();
    res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-cache'});
    res.end(JSON.stringify({baseUrl: proto+'://'+host})); return;
  }
  if (p==='/'||p==='/tv') p='/tv.html';
  if (p==='/phone')       p='/phone.html';
  const safe = path.join(PUBLIC_DIR, path.normalize(p).replace(/^(\.\.[\/\\])+/,''));
  if (!safe.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(safe, (err,data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200,{'Content-Type':MIME[path.extname(safe).toLowerCase()]||'application/octet-stream'});
    res.end(data);
  });
});

const { Server } = require('socket.io');
const io = new Server(httpServer, {
  cors:{origin:'*'}, transports:['websocket','polling'], allowEIO3:true
});

// ─── Utilities ────────────────────────────────────────────────────────────────
function randCode() {
  const L='ABCDEFGHJKLMNPQRSTUVWXYZ', N='23456789';
  return [0,1,2].map(()=>L[Math.random()*L.length|0]).join('')+'-'+
         [0,1,2].map(()=>N[Math.random()*N.length|0]).join('');
}
function shuffle(a) {
  for (let i=a.length-1;i>0;i--) { const j=Math.random()*(i+1)|0;[a[i],a[j]]=[a[j],a[i]]; }
  return a;
}
function makeDeck() {
  const d=[];
  for (const s of 'shdc') for (const r of '23456789TJQKA') d.push(r+s);
  return shuffle(d);
}

// ─── Hand Evaluator ───────────────────────────────────────────────────────────
const HAND_NAMES=['High Card','One Pair','Two Pair','Three of a Kind',
                  'Straight','Flush','Full House','Four of a Kind',
                  'Straight Flush','Royal Flush'];
function cRank(c){ return '23456789TJQKA'.indexOf(c[0]); }

function evaluate(cards) {
  let best=null;
  function pick(i,chosen){
    if(chosen.length===5){const s=score5(chosen);if(!best||scoreCmp(s,best)>0)best=s;return;}
    for(let j=i;j<=cards.length-(5-chosen.length);j++){chosen.push(cards[j]);pick(j+1,chosen);chosen.pop();}
  }
  if(cards.length<=5) best=score5(cards); else pick(0,[]);
  return best;
}
function score5(cards){
  const ranks=cards.map(cRank).sort((a,b)=>b-a);
  const suits=cards.map(c=>c[1]);
  const flush=suits.every(s=>s===suits[0]);
  const freq={};for(const r of ranks)freq[r]=(freq[r]||0)+1;
  const counts=Object.values(freq).sort((a,b)=>b-a);
  const uniq=[...new Set(ranks)].sort((a,b)=>b-a);
  let straight=uniq.length===5&&ranks[0]-ranks[4]===4;
  if(!straight&&ranks.join()===('12,3,2,1,0'))straight=true;
  let hr;
  if(straight&&flush) hr=ranks[0]===12?9:8;
  else if(counts[0]===4) hr=7;
  else if(counts[0]===3&&counts[1]===2) hr=6;
  else if(flush) hr=5;
  else if(straight) hr=4;
  else if(counts[0]===3) hr=3;
  else if(counts[0]===2&&counts[1]===2) hr=2;
  else if(counts[0]===2) hr=1;
  else hr=0;
  const byFreq=Object.entries(freq).sort((a,b)=>b[1]-a[1]||b[0]-a[0]).map(e=>+e[0]);
  return [hr,...byFreq];
}
function scoreCmp(a,b){
  for(let i=0;i<Math.max(a.length,b.length);i++){
    const d=(a[i]??-1)-(b[i]??-1); if(d!==0)return d;
  }
  return 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  BETTING ROUND ENGINE  v14
//
//  Konzept: _closingPlayer  (der Spieler, der die Runde schließt)
//
//  Pre-Flop:
//    firstToAct    = UTG  (Spieler links vom BB)
//    _closingPlayer = BB  ← BB hat die Option als letzter (check oder raise)
//    Heads-Up Pre-Flop:
//    firstToAct    = SB/Dealer  (handelt zuerst)
//    _closingPlayer = BB         (hat Option zuletzt)
//
//  Post-Flop (Flop/Turn/River):
//    firstToAct    = erster aktiver Spieler links vom Dealer
//    _closingPlayer = letzter aktiver Spieler vor firstToAct
//                    (= Dealer oder nächster davor, wenn Dealer gefoldet)
//    Heads-Up Post-Flop:
//    firstToAct    = BB  (handelt zuerst)
//    _closingPlayer = Dealer/SB (handelt zuletzt)
//
//  Nach Raise/Bet:
//    _closingPlayer = Raiser selbst
//    → alle anderen handeln, Raiser schließt als letzter
//
//  Wenn _closingPlayer foldet:
//    _closingPlayer = vorheriger aktiver Spieler (_prevActive)
//
//  inProgress():
//    numActive > 1  UND  (ersteAktion ODER pointer != _closingPlayer)
//    → Runde endet genau NACHDEM _closingPlayer seine Aktion ausgeführt hat
// ═══════════════════════════════════════════════════════════════════════════════
class BettingRound {
  // activePlayers  : boolean[]  — true = sitzt noch in dieser Straße
  // firstToAct     : Seat-Index des ersten Akteurs
  // closingPlayer  : Seat-Index des letzten Akteurs (schließt die Runde)
  //   Pre-Flop     : closingPlayer = bbSeat
  //   Post-Flop    : closingPlayer = dealerSeat (Dealer agiert zuletzt)
  //   Nach Raise   : closingPlayer = Raiser
  // biggestBet     : bereits geposteter Höchsteinsatz
  // minRaise       : Mindest-Erhöhungsinkrement
  constructor(activePlayers, firstToAct, closingPlayer, biggestBet, minRaise, allInMask) {
    this._active        = activePlayers.slice();
    this._allIn         = (allInMask||activePlayers).map(Boolean);
    this._acted         = new Array(activePlayers.length).fill(false);
    for (let i=0;i<this._allIn.length;i++) if (this._allIn[i]) this._acted[i]=true;

    this._firstToAct    = firstToAct;   // Startpunkt der Spielreihenfolge
    this._playerToAct   = firstToAct;
    this._closingPlayer = closingPlayer;
    this._biggestBet    = biggestBet;
    this._minRaise      = minRaise;
    this._done          = false;
    this._numActive     = activePlayers.filter(Boolean).length;

    this._advanceToNext();
  }

  playerToAct() { return this._playerToAct; }
  biggestBet()  { return this._biggestBet; }
  minRaise()    { return this._minRaise; }
  numActive()   { return this._numActive; }

  inProgress()  { return !this._done && this._numActive > 1; }

  // RAISE/BET: Raiser wird neuer closingPlayer, alle _acted zurücksetzen
  aggressive(newTotalBet) {
    this._minRaise        = Math.max(newTotalBet - this._biggestBet, this._minRaise);
    this._biggestBet      = newTotalBet;
    this._closingPlayer   = this._playerToAct;
    // Neuer Startpunkt = nächster Spieler nach Raiser (in Spielreihenfolge)
    this._firstToAct      = this._nextInOrder(this._playerToAct);
    this._acted           = this._active.map((_,i)=>this._allIn[i]);
    this._acted[this._playerToAct] = true;
    this._advanceToNext();
  }

  // CHECK/CALL
  passive() {
    this._acted[this._playerToAct] = true;
    const wasClosure = (this._playerToAct === this._closingPlayer);
    this._advanceToNext();
    if (wasClosure) this._done = true;
  }

  // FOLD
  leave() {
    const folded = this._playerToAct;
    this._active[folded] = false;
    this._acted[folded]  = true;
    this._numActive = Math.max(0, this._numActive - 1);
    if (this._numActive <= 1) { this._done = true; return; }
    if (folded === this._closingPlayer) {
      // closingPlayer foldet → vorheriger aktiver Spieler in der Reihenfolge übernimmt
      const prev = this._prevInOrder(folded);
      this._closingPlayer = prev;
      if (this._acted[prev]) { this._done = true; return; }
    }
    this._advanceToNext();
  }

  // Nächsten Spieler in der SPIELREIHENFOLGE finden (ab firstToAct, aufsteigend mod n)
  // der noch nicht gehandelt hat
  _advanceToNext() {
    const n = this._active.length;
    // Iteriere in Spielreihenfolge: firstToAct, firstToAct+1, ..., closingPlayer
    // Finde den ersten der noch active && !acted ist
    for (let i = 0; i < n; i++) {
      const s = (this._firstToAct + i) % n;
      if (this._active[s] && !this._acted[s]) {
        this._playerToAct = s;
        return;
      }
      if (s === this._closingPlayer) break; // closingPlayer ist der letzte — danach Ende
    }
    this._done = true;
  }

  // Nächster aktiver Seat nach `seat` in Spielreihenfolge (+1 mod n)
  _nextInOrder(seat) {
    const n = this._active.length;
    for (let i = 1; i <= n; i++) {
      const s = (seat + i) % n;
      if (this._active[s]) return s;
    }
    return seat;
  }

  // Vorheriger aktiver Seat vor `seat` in Spielreihenfolge (-1 mod n)
  _prevInOrder(seat) {
    const n = this._active.length;
    for (let i = 1; i <= n; i++) {
      const s = (seat - i + n) % n;
      if (this._active[s] && s !== seat) return s;
    }
    return seat;
  }
}

// ─── Room factory ─────────────────────────────────────────────────────────────
const rooms = {}, socketRoom = {};

function newRoom() {
  const code = randCode();
  rooms[code] = {
    code, phase:'lobby',
    players:[], deck:[], community:[],
    pot:0, dealerSeat:-1,
    bettingRound:null,
    handNum:0,
    settings:{
      startStack:5000, smallBlind:25, bigBlind:50,
      blindRaiseEvery:5, maxBlind:800, botCount:0,
      botDifficulty:'medium', timer:30
    },
    timerInterval:null, timerLeft:0,
    handsSinceBlind:0, tvSocketId:null,
  };
  return code;
}

// ─── State broadcast ──────────────────────────────────────────────────────────
function pubState(room, forId) {
  const reveal = room.phase==='showdown'||room.phase==='winner';
  const br     = room.bettingRound;
  const actSeat= (br&&br.inProgress()) ? br.playerToAct() : -1;
  return {
    code:room.code, phase:room.phase, pot:room.pot,
    community:room.community, handNum:room.handNum,
    settings:room.settings, actionSeat:actSeat,
    dealerSeat:room.dealerSeat,
    highestBet: br ? br.biggestBet() : 0,
    timerLeft:room.timerLeft,
    players:room.players.map((p,i)=>({
      id:p.id, name:p.name, avatar:p.avatar,
      stack:p.stack, bet:p.bet, status:p.status,
      isDealer:i===room.dealerSeat,
      isSB:p.isSB, isBB:p.isBB,
      isMaster:p.isMaster, isBot:p.isBot,
      isActive:i===actSeat,
      lastAction:p.lastAction,
      handName:reveal?(p.handName||''):'',
      cards:(p.id===forId||reveal)?p.cards:(p.cards.length?['??','??']:[]),
    })),
  };
}

function broadcast(room) {
  if (room.tvSocketId) io.to(room.tvSocketId).emit('game-state',pubState(room,'__tv__'));
  for (const p of room.players)
    if (!p.isBot&&p.socketId) io.to(p.socketId).emit('game-state',pubState(room,p.id));
}

function clearTimer(room) {
  if (room.timerInterval){clearInterval(room.timerInterval);room.timerInterval=null;}
  room.timerLeft=0;
}

// ─── Start game (add bots, kick off first hand) ───────────────────────────────
const BOT_NAMES=['Dealer Dan','Lucky Lou','Ace Annie','Bluff Bill','Sharp Sid'];
const BOT_AVS  =['🤖','🎲','💀','👾','🃏'];

function startGame(room) {
  for (let i=0;i<room.settings.botCount;i++) {
    room.players.push({
      id:'bot_'+i, socketId:null,
      name:BOT_NAMES[i]||'Bot '+(i+1), avatar:BOT_AVS[i]||'🤖',
      stack:room.settings.startStack, bet:0, status:'waiting',
      cards:[], isBot:true, isMaster:false,
      isSB:false, isBB:false, handName:'', lastAction:null,
    });
  }
  room.phase='dealing';
  broadcast(room);
  setTimeout(()=>startHand(room),800);
}

// ─── Start hand ───────────────────────────────────────────────────────────────
function startHand(room) {
  clearTimer(room);
  for (const p of room.players) if (p.stack<=0) p.status='out';
  if (room.players.filter(p=>p.stack>0).length<2) { endGame(room); return; }

  room.handNum++;
  room.deck=makeDeck(); room.community=[]; room.pot=0; room.bettingRound=null;
  room.phase='preflop';

  for (const p of room.players) {
    p.bet=0; p.cards=[]; p.isSB=false; p.isBB=false;
    p.handName=''; p.lastAction=null;
    p.status=p.stack>0?'active':'out';
  }

  // Advance dealer
  const n=room.players.length;
  let d=room.dealerSeat<0?n-1:room.dealerSeat;
  for (let i=1;i<=n;i++){const s=(d+i)%n;if(room.players[s].status==='active'){room.dealerSeat=s;break;}}

  // ── Blind & Positions-Zuweisung (offizielle Texas Hold'em Regeln) ─────────
  // Uhrzeigersinn = aufsteigende Seat-Indizes auf dem TV
  //
  // SB  = direkt LINKS vom Dealer  = nextAfter(dealer)
  // BB  = direkt LINKS vom SB      = nextAfter(SB)
  // UTG = direkt LINKS vom BB      = nextAfter(BB)  → handelt PRE-FLOP ZUERST
  // BB  handelt PRE-FLOP ZULETZT   = closingPlayer pre-flop (BB-Option!)
  //
  // POST-FLOP: SB handelt ZUERST, Dealer (BTN) handelt ZULETZT
  //
  // HEADS-UP (2 Spieler):
  //   Dealer = SB, handelt pre-flop ZUERST
  //   BB = anderer Spieler, handelt pre-flop ZULETZT (Option)
  //   Post-flop: BB zuerst, Dealer/SB zuletzt

  const inHandPlayers = room.players.filter(p=>p.status==='active'||p.status==='allIn');
  const headsUp = inHandPlayers.length === 2;

  let sbSeat, bbSeat, firstToAct;
  if (headsUp) {
    sbSeat     = room.dealerSeat;                // Dealer = SB heads-up
    bbSeat     = nextAfter(room, sbSeat);        // anderer Spieler = BB
    firstToAct = sbSeat;                         // SB/Dealer handelt zuerst pre-flop
  } else {
    sbSeat     = nextAfter(room, room.dealerSeat); // SB links vom Dealer
    bbSeat     = nextAfter(room, sbSeat);           // BB links vom SB
    firstToAct = nextAfter(room, bbSeat);           // UTG links vom BB = erster pre-flop
  }

  room.players[sbSeat].isSB=true;
  room.players[bbSeat].isBB=true;

  placeBet(room,sbSeat,Math.min(room.players[sbSeat].stack,room.settings.smallBlind));
  placeBet(room,bbSeat,Math.min(room.players[bbSeat].stack,room.settings.bigBlind));

  for (const p of room.players)
    if (p.status==='active') p.cards=[room.deck.pop(),room.deck.pop()];

  for (const p of room.players)
    if (!p.isBot&&p.socketId&&p.cards.length)
      io.to(p.socketId).emit('deal-cards',{cards:p.cards});

  // Pre-Flop BettingRound:
  //   firstToAct    = UTG = nextAfter(dealer)
  //   closingPlayer = Dealer (agiert zuletzt pre-flop)
  //   Reihenfolge:  UTG→UTG+1→...→SB→BB→Dealer(closing)
  //   Heads-Up:     SB/Dealer zuerst, BB closing
  // Pre-Flop: BB schließt die Runde (hat die Option als letzter)
  // Reihenfolge: UTG → UTG+1 → ... → Dealer → SB → BB (closing)
  // Heads-Up:   SB/Dealer zuerst → BB (closing)
  const activeArr=room.players.map(p=>p.status==='active'||p.status==='allIn');
  const allInMask=room.players.map(p=>p.status==='allIn');
  // DEBUG
  console.log("=== startHand DEBUG ===");
  console.log("dealer="+room.dealerSeat+"("+room.players[room.dealerSeat]?.name+") sb="+sbSeat+"("+room.players[sbSeat]?.name+") bb="+bbSeat+"("+room.players[bbSeat]?.name+") first="+firstToAct+"("+room.players[firstToAct]?.name+")");
  console.log("activeArr="+activeArr.map((a,i)=>i+":"+room.players[i]?.name+"="+a).join(","));
  console.log("======================");
  const bbAmt=Math.max(room.players[sbSeat].bet, room.players[bbSeat].bet);
  room.bettingRound=new BettingRound(activeArr, firstToAct, bbSeat, bbAmt, room.settings.bigBlind, allInMask);

  broadcast(room);
  scheduleAction(room);
}

function nextAfter(room,seat){
  const n=room.players.length;
  for(let i=1;i<=n;i++){const s=(seat+i)%n;if(room.players[s].status==='active' || room.players[s].status==='allIn')return s;}
  return seat;
}

// Nächster aktiver Seat VOR seat (rückwärts im Uhrzeigersinn)
// Für Blind-Vergabe: BB = prevBefore(dealer), SB = prevBefore(BB)
function prevBefore(room,seat){
  const n=room.players.length;
  for(let i=1;i<=n;i++){const s=(seat-i+n)%n;if(room.players[s].status==='active' || room.players[s].status==='allIn')return s;}
  return seat;
}

// Letzter aktiver Spieler VOR seat (rückwärts) — für closingPlayer post-flop
function prevActiveSeat(room,seat){
  const n=room.players.length;
  for(let i=1;i<=n;i++){const s=(seat-i+n)%n;if(room.players[s].status==='active' || room.players[s].status==='allIn')return s;}
  return seat;
}

function placeBet(room,seat,amount){
  const p=room.players[seat];
  p.stack-=amount; p.bet+=amount; room.pot+=amount;
  if(p.stack===0) p.status='allIn';
}

// ─── Schedule action ──────────────────────────────────────────────────────────
function scheduleAction(room) {
  clearTimer(room);
  const br=room.bettingRound;

  // Status-Sync: In-Hand-Spieler (active/allIn) behalten, Fold/Out entfernen
  if (br) {
    let activeCount=0;
    for (let i=0;i<room.players.length;i++) {
      const st=room.players[i].status;
      const inHand = st==='active' || st==='allIn';
      br._active[i]=inHand;
      br._allIn[i]=st==='allIn';
      if (!inHand) {
        br._acted[i]=true;
      } else if (br._allIn[i]) {
        br._acted[i]=true;
        activeCount++;
      } else {
        activeCount++;
      }
    }
    br._numActive=activeCount;
    if (!br._active[br._playerToAct] || br._acted[br._playerToAct]) br._advanceToNext();
  }

  if (!br||!br.inProgress()) { endStreet(room); return; }

  const seat  =br.playerToAct();
  const player=room.players[seat];

  if (!player||player.status!=='active') {
    // Diesen Seat überspringen (allIn oder out — sollte durch sync oben nicht mehr vorkommen)
    br._active[seat]=false; br._acted[seat]=true;
    br._numActive=Math.max(0,br._numActive-1);
    br._advanceToNext();
    scheduleAction(room); return;
  }

  const callAmt=Math.min(player.stack, br.biggestBet()-player.bet);

  if (player.isBot) {
    setTimeout(()=>{
      const br2=room.bettingRound;
      if (br2?.inProgress()&&br2.playerToAct()===seat) botDecide(room,seat);
    },1000+Math.random()*1500);
    return;
  }

  broadcast(room);
  if (player.socketId) {
    io.to(player.socketId).emit('your-turn',{
      callAmount:callAmt,
      validActions:legalActions(player,br),
      minRaise:br.biggestBet()+br.minRaise(),
      timerLeft:room.settings.timer,
    });
  }
  if (room.settings.timer>0) {
    room.timerLeft=room.settings.timer;
    room.timerInterval=setInterval(()=>{
      room.timerLeft=Math.max(0,room.timerLeft-1);
      broadcast(room);
      if (room.timerLeft<=0){clearTimer(room);applyAction(room,player.id,callAmt===0?'check':'fold',0);}
    },1000);
  }
}

function legalActions(player,br){
  const call=br.biggestBet()-player.bet;
  const acts=['fold'];
  if(call<=0)acts.push('check');
  else if(player.stack>0)acts.push('call');
  if(player.stack>call){acts.push('raise');acts.push('allIn');}
  else if(player.stack>0)acts.push('allIn');
  return acts;
}

// ─── Apply action ─────────────────────────────────────────────────────────────
function applyAction(room,playerId,action,amount) {
  clearTimer(room);
  const br=room.bettingRound;
  if (!br||!br.inProgress()) return;

  const seat  =br.playerToAct();
  const player=room.players[seat];
  if (!player||player.id!==playerId) return;

  player.lastAction=action.toUpperCase();

  switch(action) {
    case 'fold':
      player.status='folded';
      br.leave();
      break;

    case 'check':
      br.passive();
      break;

    case 'call': {
      const ca=Math.min(player.stack,br.biggestBet()-player.bet);
      placeBet(room,seat,ca);
      if(player.status==='allIn') br._allIn[seat]=true;
      br.passive();
      break;
    }

    case 'raise': {
      const minTotal=br.biggestBet()+br.minRaise();
      const maxTotal=player.stack+player.bet;
      const total=Math.max(minTotal,Math.min(amount,maxTotal));
      const toAdd=Math.min(player.stack,total-player.bet);
      placeBet(room,seat,toAdd);
      if(player.stack===0) { player.status='allIn'; br._allIn[seat]=true; }
      br.aggressive(player.bet);
      break;
    }

    case 'allIn': {
      const toAdd=player.stack;
      placeBet(room,seat,toAdd);
      player.status='allIn';
      br._allIn[seat]=true;
      if(player.bet>br.biggestBet()) br.aggressive(player.bet);
      else br.passive();
      break;
    }
  }

  broadcast(room);

  const inHand=room.players.filter(p=>p.status==='active'||p.status==='allIn');
  if (inHand.length<=1){closeHand(room);return;}
  if (!br.inProgress()) endStreet(room);
  else scheduleAction(room);
}

// ─── End of betting street ────────────────────────────────────────────────────
function endStreet(room) {
  clearTimer(room);
  for (const p of room.players) p.bet=0;
  room.bettingRound=null;

  const inHand=room.players.filter(p=>p.status==='active'||p.status==='allIn');
  if (inHand.length<=1){closeHand(room);return;}

  const phases=['preflop','flop','turn','river'];
  const idx=phases.indexOf(room.phase);
  if (idx<0||room.phase==='river'){showdown(room);return;}

  room.phase=phases[idx+1];
  room.deck.pop(); // burn
  if (room.phase==='flop') room.community.push(room.deck.pop(),room.deck.pop(),room.deck.pop());
  else room.community.push(room.deck.pop());

  // Clear last actions for new street
  for (const p of room.players) p.lastAction=null;

  broadcast(room);

  if (room.players.filter(p=>p.status==='active').length===0){showdown(room);return;}

  // Post-Flop Reihenfolge:
  //   firstToAct    = UTG = nextAfter(dealer) — erster im Uhrzeigersinn nach Dealer
  //   closingPlayer = Dealer = prevActiveSeat(firstToAct) — Dealer agiert zuletzt
  //
  // Heads-Up Post-Flop: BB zuerst, Dealer/SB zuletzt (umgekehrt zu Pre-Flop)
  const activeArr=room.players.map(p=>p.status==='active'||p.status==='allIn');
  const allInMask=room.players.map(p=>p.status==='allIn');
  const activeCnt=activeArr.filter(Boolean).length;

  let postFirst, postClose;
  if (activeCnt === 2) {
    // Heads-Up: BB handelt zuerst, Dealer zuletzt
    const bbIdx=room.players.findIndex(p=>p.isBB&&p.status==='active');
    const dlrActive=room.players[room.dealerSeat]?.status==='active';
    if (bbIdx>=0 && dlrActive) {
      postFirst = bbIdx;
      postClose = room.dealerSeat;
    } else {
      postFirst = nextAfter(room, room.dealerSeat);
      postClose = prevActiveSeat(room, postFirst);
    }
  } else {
    // Standard: UTG (nextAfter dealer) zuerst, Dealer zuletzt
    postFirst = nextAfter(room, room.dealerSeat);
    postClose = prevActiveSeat(room, postFirst); // = Dealer wenn noch aktiv
  }

  room.bettingRound=new BettingRound(activeArr, postFirst, postClose, 0, room.settings.bigBlind, allInMask);
  scheduleAction(room);
}

// ─── Showdown ─────────────────────────────────────────────────────────────────
function showdown(room) {
  clearTimer(room);
  room.phase='showdown'; room.bettingRound=null;

  while (room.community.length<5){
    room.deck.pop();
    if(room.community.length<3) room.community.push(room.deck.pop(),room.deck.pop(),room.deck.pop());
    else room.community.push(room.deck.pop());
  }

  const inHand=room.players.filter(p=>(p.status==='active'||p.status==='allIn')&&p.cards.length===2);
  for (const p of inHand){
    const sc=evaluate([...p.cards,...room.community]);
    p.handName=sc?HAND_NAMES[sc[0]]:'High Card'; p._score=sc;
  }
  broadcast(room);

  let best=null;
  for (const p of inHand) if(p._score&&(!best||scoreCmp(p._score,best)>0)) best=p._score;
  const winners=inHand.filter(p=>p._score&&scoreCmp(p._score,best)===0);
  const share=winners.length?Math.floor(room.pot/winners.length):0;
  for (const w of winners) w.stack+=share;

  io.to(room.code).emit('winner',{
    winners:winners.map(w=>({id:w.id,name:w.name,avatar:w.avatar,handName:w.handName,amount:share})),
    pot:room.pot,
  });
  room.phase='winner';
  broadcast(room);
  nextHandTimer(room);
}

// ─── Close hand (last player wins uncontested) ────────────────────────────────
function closeHand(room) {
  clearTimer(room);
  room.bettingRound=null;
  const last=room.players.find(p=>p.status==='active'||p.status==='allIn');
  if (last){
    last.stack+=room.pot;
    io.to(room.code).emit('winner',{
      winners:[{id:last.id,name:last.name,avatar:last.avatar,handName:'',amount:room.pot}],
      pot:room.pot,
    });
  }
  room.phase='winner';
  broadcast(room);
  nextHandTimer(room);
}

function nextHandTimer(room) {
  room.handsSinceBlind=(room.handsSinceBlind||0)+1;
  if(room.settings.blindRaiseEvery>0&&room.handsSinceBlind>=room.settings.blindRaiseEvery){
    room.handsSinceBlind=0;
    room.settings.smallBlind=Math.min(room.settings.smallBlind*2,room.settings.maxBlind);
    room.settings.bigBlind=room.settings.smallBlind*2;
    io.to(room.code).emit('blind-raise',{small:room.settings.smallBlind,big:room.settings.bigBlind});
  }
  setTimeout(()=>{
    for(const p of room.players) if(p.stack<=0) p.status='out';
    if(room.players.filter(p=>p.stack>0).length<2){endGame(room);return;}
    startHand(room);
  },5000);
}

function endGame(room) {
  clearTimer(room);
  const winner=[...room.players].sort((a,b)=>b.stack-a.stack)[0];
  room.phase='gameover'; room.bettingRound=null;
  io.to(room.code).emit('game-over',{winner,players:room.players});
  broadcast(room);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  BOT AI
// ═══════════════════════════════════════════════════════════════════════════════
function chenScore(cards){
  if(!cards||cards.length<2)return 0;
  const r1=cRank(cards[0]),r2=cRank(cards[1]);
  const hi=Math.max(r1,r2),lo=Math.min(r1,r2),gap=hi-lo;
  const suited=cards[0][1]===cards[1][1];
  const tbl=[0,0,1,1.5,2,2.5,3,3.5,4,4.5,5,6,7,8,10];
  let score=tbl[hi]??hi/2;
  if(gap===0){score=Math.max(score*2,5);return Math.min(score/20,1);}
  if(suited)score+=2;
  if(gap===2)score-=1;else if(gap===3)score-=2;else if(gap>=4)score-=4;
  if(hi<=9&&gap<=1)score+=1;
  return Math.min(Math.max(score,0)/20,1);
}

function mcEquity(hole,community,numOpp,sims){
  if(!hole||hole.length<2)return 0.3;
  numOpp=Math.max(1,numOpp);sims=sims||200;
  const known=new Set([...hole,...community].filter(c=>c&&c!=='??'));
  const avail=[];
  for(const s of 'shdc')for(const r of '23456789TJQKA'){const c=r+s;if(!known.has(c))avail.push(c);}
  const fill=5-community.length;
  let wins=0,ties=0;
  for(let sim=0;sim<sims;sim++){
    const d=avail.slice();
    for(let i=d.length-1;i>0;i--){const j=Math.random()*(i+1)|0;[d[i],d[j]]=[d[j],d[i]];}
    const board=[...community,...d.slice(0,fill)];
    let ptr=fill;
    const opps=[];for(let o=0;o<numOpp;o++)opps.push([d[ptr++],d[ptr++]]);
    const mine=evaluate([...hole,...board]);
    if(!mine)continue;
    let best=true,tie=false;
    for(const opp of opps){
      const os=evaluate([...opp,...board]);
      if(!os)continue;
      const cv=scoreCmp(mine,os);
      if(cv<0){best=false;break;}if(cv===0)tie=true;
    }
    if(best&&tie)ties++;else if(best)wins++;
  }
  return(wins+ties*0.5)/sims;
}

function botDecide(room,seat){
  const br=room.bettingRound;
  if(!br||!br.inProgress())return;
  const bot=room.players[seat];
  if(!bot||bot.status!=='active')return;

  const diff=room.settings.botDifficulty;
  const numOpp=room.players.filter(p=>p.status==='active'||p.status==='allIn').length-1;
  const callAmt=Math.min(bot.stack,br.biggestBet()-bot.bet);

  let eq;
  if(room.phase==='preflop'){
    const chen=chenScore(bot.cards);
    if(diff==='easy')eq=chen;
    else{const mc=mcEquity(bot.cards,[],numOpp,diff==='hard'?120:60);eq=diff==='hard'?chen*0.3+mc*0.7:chen*0.5+mc*0.5;}
  }else{
    eq=mcEquity(bot.cards,room.community,numOpp,diff==='hard'?300:diff==='medium'?200:100);
  }
  eq=Math.min(eq,0.99);

  const potOdds=callAmt>0?callAmt/(room.pot+callAmt):0;
  const bluff=Math.random()<(diff==='hard'?0.10:diff==='medium'?0.05:0.02)&&callAmt<=room.pot*0.35;
  const foldTh =diff==='hard'?0.28:diff==='medium'?0.33:0.40;
  const raiseTh=diff==='hard'?0.58:diff==='medium'?0.63:0.70;
  const rrTh   =diff==='hard'?0.75:diff==='medium'?0.80:0.87;

  let action='fold',amount=0;
  if(callAmt===0){
    if(eq>raiseTh||bluff){
      action='raise';
      amount=Math.floor(br.biggestBet()+Math.max(br.minRaise(),room.pot*(0.5+Math.random()*0.5)));
      amount=Math.min(amount,bot.stack+bot.bet);
    }else action='check';
  }else{
    if(eq<foldTh&&!bluff&&potOdds>eq)action='fold';
    else if(eq>rrTh||bluff){
      action='raise';
      amount=Math.floor(br.biggestBet()+Math.max(br.minRaise(),room.pot*(0.6+Math.random()*0.6)));
      amount=Math.min(amount,bot.stack+bot.bet);
    }else if(eq>raiseTh&&Math.random()<0.55){
      action='raise';
      amount=Math.floor(br.biggestBet()+Math.max(br.minRaise(),room.pot*0.5));
      amount=Math.min(amount,bot.stack+bot.bet);
    }else{
      action=potOdds<eq+0.06?'call':'fold';
    }
  }
  if(action==='raise'&&amount>=bot.stack+bot.bet)action='allIn';
  if(action==='call'&&bot.stack<=callAmt)action='allIn';
  if(diff==='easy'&&Math.random()<0.12){if(action==='call')action='fold';else if(action==='raise'){action='call';amount=0;}}

  applyAction(room,bot.id,action,amount);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SOCKET EVENTS
// ═══════════════════════════════════════════════════════════════════════════════
io.on('connection',socket=>{

  socket.on('create-room',()=>{
    const code=newRoom();
    socketRoom[socket.id]=code;
    rooms[code].tvSocketId=socket.id;
    socket.join(code);
    socket.emit('room-created',{code});
  });

  socket.on('join-room',({code,name,avatar})=>{
    const cu=(code||'').toUpperCase();
    const room=rooms[cu];
    if(!room){socket.emit('error',{msg:'Raum nicht gefunden'});return;}
    if(room.phase!=='lobby'&&room.phase!=='setup'){socket.emit('error',{msg:'Spiel bereits gestartet'});return;}
    socketRoom[socket.id]=cu;
    socket.join(cu);
    const isMaster=room.players.filter(p=>!p.isBot).length===0;
    room.players.push({
      id:socket.id,socketId:socket.id,
      name:name||'Spieler',avatar:avatar||'🎩',
      stack:room.settings.startStack,bet:0,
      status:'waiting',cards:[],isBot:false,isMaster,
      isSB:false,isBB:false,handName:'',lastAction:null,
    });
    if(isMaster)room.phase='setup';
    socket.emit('joined',{playerId:socket.id,isMaster});
    if(room.tvSocketId)io.to(room.tvSocketId).emit('player-joined',{player:{id:socket.id,name:name||'Spieler',avatar:avatar||'🎩'}});
    broadcast(room);
  });

  socket.on('update-settings',settings=>{
    const room=rooms[socketRoom[socket.id]];
    if(!room)return;
    const p=room.players.find(p=>p.id===socket.id);
    if(!p?.isMaster)return;
    Object.assign(room.settings,settings);
    if(room.phase==='setup')for(const pl of room.players)pl.stack=room.settings.startStack;
    broadcast(room);
  });

  socket.on('start-game',()=>{
    const room=rooms[socketRoom[socket.id]];
    if(!room)return;
    const p=room.players.find(p=>p.id===socket.id);
    if(!p?.isMaster)return;
    startGame(room);
  });

  socket.on('player-action',({action,amount})=>{
    const room=rooms[socketRoom[socket.id]];
    if(!room)return;
    const br=room.bettingRound;
    if(!br||!br.inProgress())return;
    const actSeat=br.playerToAct();
    if(room.players[actSeat]?.id!==socket.id)return;
    applyAction(room,socket.id,action,amount||0);
  });

  socket.on('new-game',()=>{
    const code=socketRoom[socket.id];
    const room=rooms[code];
    if(!room)return;
    const isTv=room.tvSocketId===socket.id;
    const p=room.players.find(p=>p.socketId===socket.id);
    if(!isTv&&!p?.isMaster)return;
    clearTimer(room);
    Object.assign(room,{
      phase:'lobby',players:[],community:[],pot:0,
      bettingRound:null,deck:[],handNum:0,handsSinceBlind:0,dealerSeat:-1,
    });
    io.to(code).emit('new-game-started');
    broadcast(room);
  });

  socket.on('disconnect',()=>{
    const code=socketRoom[socket.id];
    delete socketRoom[socket.id];
    if(!code||!rooms[code])return;
    const room=rooms[code];
    if(room.tvSocketId===socket.id){room.tvSocketId=null;return;}
    const pidx=room.players.findIndex(p=>p.socketId===socket.id);
    if(pidx<0)return;
    const p=room.players[pidx];
    if(['preflop','flop','turn','river'].includes(room.phase)){
      const br=room.bettingRound;
      if(br&&br.inProgress()&&br.playerToAct()===pidx){
        applyAction(room,p.id,'fold',0);
      }else{
        p.status='folded';p.lastAction='FOLD';
        if(br){br._active[pidx]=false;br._numActive=Math.max(0,br._numActive-1);}
        broadcast(room);
      }
    }
    if(p.isMaster){
      const next=room.players.find(pp=>!pp.isBot&&pp.id!==p.id&&pp.socketId);
      if(next){next.isMaster=true;io.to(next.socketId).emit('master-assigned');}
    }
  });
});

const PORT=process.env.PORT||3000;
httpServer.listen(PORT,'0.0.0.0',()=>console.log(`\n♠ Royal Poker auf Port ${PORT}`));
