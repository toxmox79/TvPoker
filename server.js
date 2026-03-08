const http = require('http');
const path = require('path');
const fs   = require('fs');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

const PUBLIC_DIR = path.resolve(__dirname, 'public');
console.log('Public dir:', PUBLIC_DIR);
try { console.log('Files:', fs.readdirSync(PUBLIC_DIR).join(', ')); }
catch(e) { console.error('Cannot read public dir:', e.message); }

const httpServer = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/config') {
    const host  = (req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
    const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify({ baseUrl: proto + '://' + host }));
    return;
  }
  if (urlPath === '/' || urlPath === '/tv') urlPath = '/tv.html';
  if (urlPath === '/phone')                 urlPath = '/phone.html';
  const safePath = path.normalize(urlPath).replace(/^(\.\.[\/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  const ext = path.extname(filePath).toLowerCase();
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, {'Content-Type':'text/plain'}); res.end('Not found: '+urlPath); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

const { Server } = require('socket.io');
const io = new Server(httpServer, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling'],
  allowEIO3: true
});

// ── Utilities ──────────────────────────────────────────────────────────
function randCode() {
  const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const N = '23456789';
  return [0,1,2].map(()=>L[Math.floor(Math.random()*L.length)]).join('')+'-'+
         [0,1,2].map(()=>N[Math.floor(Math.random()*N.length)]).join('');
}
function shuffle(arr) {
  for (let i = arr.length-1; i > 0; i--) {
    const j = Math.floor(Math.random()*(i+1)); [arr[i],arr[j]]=[arr[j],arr[i]];
  }
  return arr;
}
function makeDeck() {
  const s=['s','h','d','c'], r=['2','3','4','5','6','7','8','9','T','J','Q','K','A'], d=[];
  for(const suit of s) for(const rank of r) d.push(rank+suit);
  return shuffle(d);
}

// ── Hand Evaluator ─────────────────────────────────────────────────────
const HAND_NAMES=['High Card','One Pair','Two Pair','Three of a Kind','Straight','Flush','Full House','Four of a Kind','Straight Flush','Royal Flush'];
function cardRank(c){ return '23456789TJQKA'.indexOf(c[0]); }
function cardSuit(c){ return c[1]; }
function evaluateHand(cards) {
  let best=null;
  function pick(start,chosen){
    if(chosen.length===5){const sc=score5(chosen);if(!best||compareScore(sc,best.score)>0)best={score:sc};return;}
    for(let i=start;i<=cards.length-(5-chosen.length);i++){chosen.push(cards[i]);pick(i+1,chosen);chosen.pop();}
  }
  if(cards.length<=5) best={score:score5(cards)};
  else pick(0,[]);
  return best;
}
function score5(cards){
  const ranks=cards.map(cardRank).sort((a,b)=>b-a);
  const suits=cards.map(cardSuit);
  const flush=suits.every(s=>s===suits[0]);
  const rc={};for(const r of ranks)rc[r]=(rc[r]||0)+1;
  const counts=Object.values(rc).sort((a,b)=>b-a);
  const uniq=[...new Set(ranks)].sort((a,b)=>b-a);
  let straight=uniq.length===5&&(ranks[0]-ranks[4]===4);
  if(!straight&&uniq.join(',')===('12,3,2,1,0'))straight=true;
  let hr;
  if(straight&&flush)hr=ranks[0]===12?9:8;
  else if(counts[0]===4)hr=7;
  else if(counts[0]===3&&counts[1]===2)hr=6;
  else if(flush)hr=5;
  else if(straight)hr=4;
  else if(counts[0]===3)hr=3;
  else if(counts[0]===2&&counts[1]===2)hr=2;
  else if(counts[0]===2)hr=1;
  else hr=0;
  const byFreq=Object.entries(rc).sort((a,b)=>b[1]-a[1]||b[0]-a[0]).map(e=>parseInt(e[0]));
  return [hr,...byFreq];
}
function compareScore(a,b){
  for(let i=0;i<Math.max(a.length,b.length);i++){const av=a[i]??-1,bv=b[i]??-1;if(av!==bv)return av-bv;}return 0;
}

// ── Rooms ──────────────────────────────────────────────────────────────
const rooms={}, socketRoom={};

function createRoom(){
  const code=randCode();
  rooms[code]={
    code, phase:'lobby', players:[], communityCards:[], pot:0, deck:[],
    handNumber:0, dealerSeat:-1, actionSeat:-1, lastAggressorSeat:-1,
    highestBet:0, lastRaiseAmount:0,
    settings:{startStack:5000,smallBlind:25,bigBlind:50,blindRaiseEvery:5,maxBlind:800,botCount:0,botDifficulty:'medium',timer:30,showCards:true},
    timerInterval:null, timerLeft:0, handsSinceBlindRaise:0, tvSocketId:null
  };
  return code;
}

// ── Seat navigation ────────────────────────────────────────────────────
// Nächster Seat in room.players[] NACH fromSeat mit einem der angegebenen Status
function nextSeat(room, fromSeat, statusSet){
  const n=room.players.length; if(n===0)return -1;
  for(let i=1;i<=n;i++){const s=(fromSeat+i)%n;if(statusSet.has(room.players[s].status))return s;}
  return -1;
}
function countStatus(room,statusSet){return room.players.filter(p=>statusSet.has(p.status)).length;}

// ── Public state ────────────────────────────────────────────────────────
function getPublicState(room,forId){
  const showAll=room.phase==='showdown'||room.phase==='winner';
  return{
    code:room.code,phase:room.phase,pot:room.pot,communityCards:room.communityCards,
    handNumber:room.handNumber,settings:room.settings,actionSeat:room.actionSeat,
    dealerSeat:room.dealerSeat,highestBet:room.highestBet,timerLeft:room.timerLeft,
    players:room.players.map((p,i)=>({
      id:p.id,name:p.name,avatar:p.avatar,stack:p.stack,bet:p.bet,status:p.status,
      isDealer:i===room.dealerSeat,isSB:p.isSB,isBB:p.isBB,isMaster:p.isMaster,
      isBot:p.isBot,isActive:i===room.actionSeat,lastAction:p.lastAction||null,
      handName:showAll?p.handName:null,
      cards:(p.id===forId||showAll)?p.cards:(p.cards?.length?['??','??']:[])
    }))
  };
}

function broadcastState(room){
  if(room.tvSocketId) io.to(room.tvSocketId).emit('game-state',getPublicState(room,'__tv__'));
  for(const p of room.players) if(!p.isBot&&p.socketId) io.to(p.socketId).emit('game-state',getPublicState(room,p.id));
}

function clearTimer(room){
  if(room.timerInterval){clearInterval(room.timerInterval);room.timerInterval=null;}
  room.timerLeft=0;
}

// ── Bots ───────────────────────────────────────────────────────────────
const BOT_NAMES=['Dealer Dan','Lucky Lou','Ace Annie','Bluff Bill','Sharp Sid'];
const BOT_AVATARS=['🤖','🎲','💀','👾','🃏'];

function addBots(room){
  for(let i=0;i<room.settings.botCount;i++){
    room.players.push({id:'bot_'+i,socketId:null,name:BOT_NAMES[i]||'Bot '+(i+1),avatar:BOT_AVATARS[i]||'🤖',
      stack:room.settings.startStack,bet:0,status:'active',cards:[],isBot:true,isMaster:false,
      isSB:false,isBB:false,handName:'',lastAction:null});
  }
}

// ── Start Game ─────────────────────────────────────────────────────────
function startGame(room){
  addBots(room);
  room.phase='dealing';
  broadcastState(room);
  setTimeout(()=>startHand(room),800);
}

// ── Start Hand ─────────────────────────────────────────────────────────
function startHand(room){
  clearTimer(room);
  for(const p of room.players)if(p.stack<=0)p.status='out';
  const playable=room.players.filter(p=>p.stack>0);
  if(playable.length<2){endGame(room);return;}

  room.handNumber++;
  room.deck=makeDeck();
  room.communityCards=[];
  room.pot=0;
  room.highestBet=0;
  room.lastRaiseAmount=room.settings.bigBlind;
  room.actionSeat=-1;
  room.lastAggressorSeat=-1;
  room.phase='preflop';

  for(const p of room.players){
    p.bet=0;p.cards=[];p.isSB=false;p.isBB=false;p.handName='';p.lastAction=null;
    p.status=p.stack>0?'active':'out';
  }

  // Dealer rückt weiter (unter aktiven Spielern)
  if(room.dealerSeat<0||room.players[room.dealerSeat]?.status==='out'){
    // Erster Dealer oder alter Dealer ausgeschieden → nächsten nehmen
    room.dealerSeat=nextSeat(room,room.dealerSeat<0?room.players.length-1:room.dealerSeat,new Set(['active']));
  } else {
    room.dealerSeat=nextSeat(room,room.dealerSeat,new Set(['active']));
  }

  // Karten austeilen
  for(const p of room.players)if(p.status==='active')p.cards=[room.deck.pop(),room.deck.pop()];

  // SB & BB
  const sbSeat=nextSeat(room,room.dealerSeat,new Set(['active']));
  const bbSeat=nextSeat(room,sbSeat,new Set(['active']));
  const sb=room.players[sbSeat], bb=room.players[bbSeat];
  sb.isSB=true; bb.isBB=true;
  const sbAmt=Math.min(sb.stack,room.settings.smallBlind);
  const bbAmt=Math.min(bb.stack,room.settings.bigBlind);
  sb.bet=sbAmt; sb.stack-=sbAmt;
  bb.bet=bbAmt; bb.stack-=bbAmt;
  if(sb.stack===0)sb.status='allIn';
  if(bb.stack===0)bb.status='allIn';
  room.pot=sbAmt+bbAmt;
  room.highestBet=bbAmt;
  // BB hat die Option → er ist der letzte Aggressor
  room.lastAggressorSeat=bbSeat;

  // Karten senden
  for(const p of room.players)if(!p.isBot&&p.socketId&&p.cards.length)io.to(p.socketId).emit('deal-cards',{cards:p.cards});

  broadcastState(room);

  // Pre-Flop startet nach BB
  room.actionSeat=nextSeat(room,bbSeat,new Set(['active']));
  scheduleAction(room);
}

// ── Schedule Action ────────────────────────────────────────────────────
function scheduleAction(room){
  clearTimer(room);
  if(room.actionSeat<0)return;
  const player=room.players[room.actionSeat];
  if(!player||player.status!=='active'){advanceAction(room);return;}

  const callAmt=Math.min(player.stack,room.highestBet-player.bet);
  const validActions=getValidActions(player,room);

  if(player.isBot){
    setTimeout(()=>{
      if(room.actionSeat>=0&&room.players[room.actionSeat]?.id===player.id)botAct(room,player);
    },800+Math.random()*1200);
    return;
  }

  if(player.socketId){
    io.to(player.socketId).emit('your-turn',{
      callAmount:callAmt,validActions,
      minRaise:Math.max(room.settings.bigBlind,room.lastRaiseAmount),
      timerLeft:room.settings.timer
    });
  }
  broadcastState(room);

  if(room.settings.timer>0){
    room.timerLeft=room.settings.timer;
    room.timerInterval=setInterval(()=>{
      room.timerLeft=Math.max(0,room.timerLeft-1);
      broadcastState(room);
      if(room.timerLeft<=0){
        clearTimer(room);
        handleAction(room,player.id,callAmt===0?'check':'fold',0);
      }
    },1000);
  }
}

function getValidActions(p,room){
  const ca=room.highestBet-p.bet;
  const acts=['fold'];
  if(ca<=0)acts.push('check');
  else if(p.stack>0)acts.push('call');
  if(p.stack>ca){acts.push('raise');acts.push('allIn');}
  else if(p.stack>0)acts.push('allIn');
  return acts;
}

// ── Handle Action ──────────────────────────────────────────────────────
function handleAction(room,playerId,action,amount){
  clearTimer(room);
  if(room.actionSeat<0)return;
  const player=room.players[room.actionSeat];
  if(!player||player.id!==playerId||player.status!=='active')return;

  player.lastAction=action.toUpperCase();

  if(action==='fold'){
    player.status='folded';
  } else if(action==='check'){
    // nothing
  } else if(action==='call'){
    const ca=Math.min(player.stack,room.highestBet-player.bet);
    player.stack-=ca; player.bet+=ca; room.pot+=ca;
    if(player.stack===0)player.status='allIn';
  } else if(action==='raise'){
    const minR=Math.max(room.settings.bigBlind,room.lastRaiseAmount);
    const raiseTo=Math.max(room.highestBet+minR,amount);
    const toAdd=Math.min(player.stack,raiseTo-player.bet);
    room.lastRaiseAmount=(player.bet+toAdd)-room.highestBet;
    room.highestBet=player.bet+toAdd;
    room.lastAggressorSeat=room.actionSeat;
    player.stack-=toAdd; player.bet+=toAdd; room.pot+=toAdd;
    if(player.stack===0)player.status='allIn';
  } else if(action==='allIn'){
    const toAdd=player.stack;
    if(player.bet+toAdd>room.highestBet){
      room.lastRaiseAmount=(player.bet+toAdd)-room.highestBet;
      room.highestBet=player.bet+toAdd;
      room.lastAggressorSeat=room.actionSeat;
    }
    player.stack=0; player.bet+=toAdd; room.pot+=toAdd; player.status='allIn';
  }

  broadcastState(room);
  advanceAction(room);
}

// ── Advance Action ─────────────────────────────────────────────────────
function advanceAction(room){
  const ACTIVE=new Set(['active']);
  const IN_HAND=new Set(['active','allIn']);

  // Wenn nur noch einer im Spiel → Ende
  if(countStatus(room,IN_HAND)<=1){nextPhase(room);return;}
  // Wenn kein Aktiver mehr → alle allIn → Showdown
  if(countStatus(room,ACTIVE)===0){nextPhase(room);return;}

  // Nächsten aktiven Spieler finden
  const nextS=nextSeat(room,room.actionSeat,ACTIVE);
  if(nextS<0){nextPhase(room);return;}

  // Ist die Setzrunde vorbei?
  // → Wir kommen beim lastAggressor an UND alle haben gleich viel gesetzt
  const allActEqualBet=room.players.filter(p=>p.status==='active').every(p=>p.bet===room.highestBet);

  if(allActEqualBet&&nextS===room.lastAggressorSeat){
    // BB hatte seine Option (lastAggressor=BB), jetzt kommt er nochmal → Runde vorbei
    nextPhase(room);
  } else if(allActEqualBet&&room.lastAggressorSeat===-1){
    // Check-Runde (niemand hat erhöht)
    nextPhase(room);
  } else {
    room.actionSeat=nextS;
    scheduleAction(room);
  }
}

// ── Next Phase ─────────────────────────────────────────────────────────
function nextPhase(room){
  clearTimer(room);
  const IN_HAND=new Set(['active','allIn']);
  const ACTIVE=new Set(['active']);

  const inHand=room.players.filter(p=>IN_HAND.has(p.status));

  // Nur noch einer übrig (alle anderen gefoldet)
  if(inHand.length<=1){
    if(inHand.length===1){
      inHand[0].stack+=room.pot;
      io.to(room.code).emit('winner',{
        winners:[{id:inHand[0].id,name:inHand[0].name,avatar:inHand[0].avatar,handName:'',amount:room.pot}],
        pot:room.pot
      });
    }
    room.phase='winner'; room.actionSeat=-1;
    broadcastState(room);
    scheduleNextHand(room);
    return;
  }

  // Bets resetten für neue Runde
  for(const p of room.players)if(p.status!=='out')p.bet=0;
  room.highestBet=0;
  room.lastRaiseAmount=room.settings.bigBlind;
  room.lastAggressorSeat=-1;
  room.actionSeat=-1;

  const phases=['preflop','flop','turn','river'];
  const ci=phases.indexOf(room.phase);

  // River war letzte Phase oder nur AllIn-Spieler → Showdown
  if(room.phase==='river'||!room.players.some(p=>p.status==='active')){
    showdown(room); return;
  }

  room.phase=phases[ci+1];

  if(room.phase==='flop'){
    room.deck.pop();
    room.communityCards.push(room.deck.pop(),room.deck.pop(),room.deck.pop());
  } else {
    room.deck.pop();
    room.communityCards.push(room.deck.pop());
  }

  broadcastState(room);

  // Nach Dealer anfangen
  const first=nextSeat(room,room.dealerSeat,ACTIVE);
  if(first<0){showdown(room);return;}
  room.actionSeat=first;
  scheduleAction(room);
}

// ── Showdown ───────────────────────────────────────────────────────────
function showdown(room){
  clearTimer(room);
  room.phase='showdown'; room.actionSeat=-1;
  const IN_HAND=new Set(['active','allIn']);
  const inHand=room.players.filter(p=>IN_HAND.has(p.status));

  // Community-Karten auffüllen
  while(room.communityCards.length<5){
    room.deck.pop();
    if(room.communityCards.length<3)room.communityCards.push(room.deck.pop(),room.deck.pop(),room.deck.pop());
    else room.communityCards.push(room.deck.pop());
  }

  // Hände bewerten
  for(const p of inHand){
    if(p.cards.length===2&&!p.cards.includes('??')){
      const r=evaluateHand([...p.cards,...room.communityCards]);
      p.handName=r?HAND_NAMES[r.score[0]]:'High Card';
    }
  }

  broadcastState(room);

  // Gewinner
  let best=null; const winners=[];
  for(const p of inHand){
    if(!p.cards.length||p.cards.includes('??'))continue;
    const r=evaluateHand([...p.cards,...room.communityCards]);
    if(!r)continue;
    if(!best||compareScore(r.score,best.score)>0){best=r;winners.length=0;winners.push(p);}
    else if(compareScore(r.score,best.score)===0)winners.push(p);
  }

  const share=winners.length?Math.floor(room.pot/winners.length):0;
  for(const w of winners)w.stack+=share;

  io.to(room.code).emit('winner',{
    winners:winners.map(w=>({id:w.id,name:w.name,avatar:w.avatar,handName:w.handName,amount:share})),
    pot:room.pot
  });
  room.phase='winner';
  broadcastState(room);
  scheduleNextHand(room);
}

// ── Schedule Next Hand ─────────────────────────────────────────────────
function scheduleNextHand(room){
  room.handsSinceBlindRaise=(room.handsSinceBlindRaise||0)+1;
  if(room.settings.blindRaiseEvery>0&&room.handsSinceBlindRaise>=room.settings.blindRaiseEvery){
    room.handsSinceBlindRaise=0;
    room.settings.smallBlind=Math.min(room.settings.smallBlind*2,room.settings.maxBlind);
    room.settings.bigBlind=room.settings.smallBlind*2;
    io.to(room.code).emit('blind-raise',{small:room.settings.smallBlind,big:room.settings.bigBlind});
  }
  setTimeout(()=>{
    for(const p of room.players)if(p.stack<=0)p.status='out';
    const playable=room.players.filter(p=>p.stack>0);
    if(playable.length<2){endGame(room);return;}
    startHand(room);
  },5000);
}

// ── End Game ───────────────────────────────────────────────────────────
function endGame(room){
  clearTimer(room);
  const winner=[...room.players].sort((a,b)=>b.stack-a.stack)[0];
  room.phase='gameover'; room.actionSeat=-1;
  io.to(room.code).emit('game-over',{winner,players:room.players});
  broadcastState(room);
}

// ════════════════════════════════════════════════════════════════════════
// BOT AI  —  Chen Formula + Monte Carlo Equity + Pot Odds + Position
// ════════════════════════════════════════════════════════════════════════

// ── Chen Formula: Pre-Flop Handstärke (0..1) ─────────────────────────
// Basiert auf der klassischen Chen-Formel aus "How Good Is Your Hold'em Hand?"
function chenScore(cards){
  if(!cards||cards.length<2)return 0;
  const r1=cardRank(cards[0]), r2=cardRank(cards[1]);
  const hi=Math.max(r1,r2), lo=Math.min(r1,r2);
  const suited=cards[0][1]===cards[1][1];
  const gap=hi-lo;

  // Basiswert des höchsten Kartenwerts (A=10,K=8,Q=7,J=6,10=5, sonst rank/2)
  const baseScore=[0,0,1,1.5,2,2.5,3,3.5,4,4.5,5,6,7,8,10];
  let score=baseScore[hi]||hi/2;

  // Pair-Bonus
  if(gap===0){score=Math.max(score*2,5);return Math.min(score/20,1);}

  // Suited-Bonus
  if(suited)score+=2;

  // Gap-Penalty
  if(gap===1)score-=0;
  else if(gap===2)score-=1;
  else if(gap===3)score-=2;
  else if(gap>=4)score-=4;

  // Connector-Bonus (beide Karten ≤ J, gap ≤ 1)
  if(hi<=9&&gap<=1)score+=1;

  return Math.min(Math.max(score,0)/20,1);
}

// ── Monte Carlo Equity (schnell, ~200 Simulationen) ───────────────────
// Schätzt die Gewinnwahrscheinlichkeit gegen N Gegner
function mcEquity(holeCards, community, numOpponents, simCount){
  if(!holeCards||holeCards.length<2)return 0.3;
  numOpponents=Math.max(1,numOpponents);
  simCount=simCount||200;

  // Bekannte Karten aus dem Deck entfernen
  const known=new Set([...holeCards,...community].filter(c=>c&&c!=='??'));
  const deck=[];
  for(const s of['s','h','d','c'])for(const r of'23456789TJQKA')deck.push(r+s);
  const avail=deck.filter(c=>!known.has(c));

  let wins=0, ties=0;
  const toFill=5-community.length;

  for(let sim=0;sim<simCount;sim++){
    // Deck mischen (Fisher-Yates, nur was wir brauchen)
    const d=avail.slice();
    for(let i=d.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[d[i],d[j]]=[d[j],d[i]];}

    // Community-Karten auffüllen
    const board=[...community,...d.slice(0,toFill)];
    let ptr=toFill;

    // Gegner-Karten austeilen
    const oppHands=[];
    for(let o=0;o<numOpponents;o++){
      oppHands.push([d[ptr++],d[ptr++]]);
    }

    // Eigene Hand bewerten
    const myResult=evaluateHand([...holeCards,...board]);
    if(!myResult)continue;

    // Gegen alle Gegner vergleichen
    let best=true, tie=false;
    for(const opp of oppHands){
      const oppResult=evaluateHand([...opp,...board]);
      if(!oppResult)continue;
      const cmp=compareScore(myResult.score,oppResult.score);
      if(cmp<0){best=false;break;}
      if(cmp===0)tie=true;
    }
    if(best&&tie)ties++;
    else if(best)wins++;
  }
  return (wins+ties*0.5)/simCount;
}

// ── Outs zählen (Draw-Stärke) ─────────────────────────────────────────
function countOuts(holeCards, community){
  if(community.length<3)return 0;
  const known=new Set([...holeCards,...community]);
  const deck=[];
  for(const s of['s','h','d','c'])for(const r of'23456789TJQKA')deck.push(r+s);
  const avail=deck.filter(c=>!known.has(c));

  const currentBest=evaluateHand([...holeCards,...community]);
  const currentRank=currentBest?currentBest.score[0]:0;

  let outs=0;
  for(const card of avail){
    const testResult=evaluateHand([...holeCards,...community,card]);
    if(testResult&&testResult.score[0]>currentRank)outs++;
  }
  return outs;
}

// ── Positions-Bonus ───────────────────────────────────────────────────
// Wie viele Spieler handeln noch NACH diesem Bot?
function positionBonus(room, botSeat){
  const ACTIVE=new Set(['active']);
  let after=0;
  let seat=botSeat;
  for(let i=0;i<room.players.length-1;i++){
    seat=(seat+1)%room.players.length;
    if(ACTIVE.has(room.players[seat].status))after++;
  }
  // Weniger Spieler nach uns → bessere Position → kleiner Bonus
  const total=countStatus(room,ACTIVE);
  return total>1?(total-1-after)/(total-1)*0.08:0;
}

// ── Stack-zu-Pot Ratio ────────────────────────────────────────────────
function spr(bot, room){
  return room.pot>0?bot.stack/room.pot:999;
}

// ── Raise-Größe berechnen ────────────────────────────────────────────
function calcRaiseAmount(room, bot, equity, diff){
  const bb=room.settings.bigBlind;
  const pot=room.pot;
  const minRaise=Math.max(bb,room.lastRaiseAmount);

  let sizeMult;
  if(equity>0.80)     sizeMult=0.75+Math.random()*0.5;  // 75-125% des Pots
  else if(equity>0.65)sizeMult=0.5+Math.random()*0.3;   // 50-80%
  else                sizeMult=0.3+Math.random()*0.2;   // 30-50% (Bluff-Bet)

  // Hard-Bots variieren Sizing stärker (weniger lesbares Muster)
  if(diff==='hard')sizeMult*=(0.85+Math.random()*0.3);

  const potBet=Math.floor(pot*sizeMult);
  const raiseTo=Math.max(room.highestBet+minRaise, room.highestBet+potBet);
  return Math.min(raiseTo, bot.stack+bot.bet);
}

// ── Haupt-Bot-Entscheidung ────────────────────────────────────────────
function botAct(room, bot){
  if(room.actionSeat<0||room.players[room.actionSeat]?.id!==bot.id)return;
  if(bot.status!=='active')return;

  const diff=room.settings.botDifficulty;
  const phase=room.phase;
  const ca=Math.min(bot.stack, room.highestBet-bot.bet);  // Call-Betrag
  const pot=room.pot;
  const bb=room.settings.bigBlind;
  const numOpponents=countStatus(room,new Set(['active','allIn']))-1;

  // ── Handstärke ermitteln ──────────────────────────────────────────
  let equity;
  if(phase==='preflop'){
    // Pre-Flop: Chen Formula, leicht durch MC verfeinert
    const chen=chenScore(bot.cards);
    // Easy: nur Chen; Medium/Hard: kombinieren
    if(diff==='easy'){
      equity=chen;
    } else {
      // Schnelle MC mit weniger Simulationen
      const mc=mcEquity(bot.cards,[],numOpponents,diff==='hard'?120:60);
      equity=diff==='hard'?(chen*0.3+mc*0.7):(chen*0.5+mc*0.5);
    }
  } else {
    // Post-Flop: Monte Carlo
    const sims=diff==='hard'?300:diff==='medium'?200:100;
    equity=mcEquity(bot.cards,room.communityCards,numOpponents,sims);
  }

  // Positions-Bonus addieren
  equity+=positionBonus(room,room.actionSeat);
  equity=Math.min(equity,0.99);

  // ── Pot Odds berechnen ────────────────────────────────────────────
  // Pot Odds = callAmount / (pot + callAmount)
  const potOdds=ca>0?ca/(pot+ca):0;

  // ── Draws berücksichtigen (nur Medium/Hard Post-Flop) ─────────────
  let drawBonus=0;
  if(diff!=='easy'&&phase!=='preflop'&&phase!=='river'){
    const outs=countOuts(bot.cards,room.communityCards);
    // Faustregel: 1 Out ≈ 2% pro verbleibender Karte
    const cardsLeft=phase==='flop'?2:1;
    drawBonus=(outs*0.02*cardsLeft)*0.5; // abgezinst, nicht voll gewichten
  }
  const effectiveEquity=Math.min(equity+drawBonus,0.99);

  // ── Bluff-Wahrscheinlichkeit ──────────────────────────────────────
  const bluffRate=diff==='hard'?0.12:diff==='medium'?0.06:0.02;
  const isBluff=Math.random()<bluffRate&&ca<=pot*0.4; // Bluff nur bei vertretbarem Preis

  // ── SPR-basierte Aggressivitätsschwelle ───────────────────────────
  const sprVal=spr(bot,room);
  // Niedriger SPR → eher All-In spielen
  const lowSpr=sprVal<4;

  // ── Entscheidungslogik ────────────────────────────────────────────
  let action='fold', amount=0;

  // Schwellen je nach Schwierigkeit
  const foldThresh  =diff==='hard'?0.30:diff==='medium'?0.35:0.40;
  const callThresh  =diff==='hard'?0.45:diff==='medium'?0.50:0.55;
  const raiseThresh =diff==='hard'?0.60:diff==='medium'?0.65:0.70;
  const reraiseTh   =diff==='hard'?0.78:diff==='medium'?0.82:0.88;

  if(ca===0){
    // Keine Kosten → Check oder Raise
    if(effectiveEquity>raiseThresh||isBluff){
      action='raise';
      amount=calcRaiseAmount(room,bot,effectiveEquity,diff);
    } else {
      action='check';
    }
  } else {
    // Muss bezahlen
    if(effectiveEquity<foldThresh&&!isBluff&&potOdds>effectiveEquity){
      action='fold';
    } else if(effectiveEquity<callThresh&&!isBluff){
      // Nur callen wenn Pot Odds stimmen
      if(potOdds<effectiveEquity+0.05) action='call';
      else action='fold';
    } else if(effectiveEquity>reraiseTh||isBluff){
      action='raise';
      amount=calcRaiseAmount(room,bot,effectiveEquity,diff);
    } else {
      // Call oder Raise bei mittlerer Stärke
      if(effectiveEquity>raiseThresh&&Math.random()<0.6){
        action='raise';
        amount=calcRaiseAmount(room,bot,effectiveEquity,diff);
      } else {
        action='call';
      }
    }
  }

  // ── All-In Checks ────────────────────────────────────────────────
  if(action==='raise'){
    if(lowSpr&&effectiveEquity>0.65){
      action='allIn'; amount=0;
    } else if(amount>=bot.stack+bot.bet){
      action='allIn'; amount=0;
    }
  }
  // Kurzer Stack → All-In statt Call wenn starke Hand
  if(action==='call'&&lowSpr&&effectiveEquity>0.70){
    action='allIn'; amount=0;
  }

  // ── Easy-Bots machen mehr Fehler ─────────────────────────────────
  if(diff==='easy'&&Math.random()<0.15){
    // Zufälliger Fehler: fold statt call, oder call statt raise
    if(action==='call')action='fold';
    else if(action==='raise'){action='call';amount=0;}
  }

  handleAction(room,bot.id,action,amount);
}

// ── Socket Events ──────────────────────────────────────────────────────
io.on('connection',(socket)=>{

  socket.on('create-room',()=>{
    const code=createRoom();
    socketRoom[socket.id]=code;
    rooms[code].tvSocketId=socket.id;
    socket.join(code);
    socket.emit('room-created',{code});
  });

  socket.on('join-room',({code,name,avatar})=>{
    const room=rooms[code?.toUpperCase()];
    if(!room){socket.emit('error',{msg:'Raum nicht gefunden'});return;}
    if(room.phase!=='lobby'&&room.phase!=='setup'){socket.emit('error',{msg:'Spiel bereits gestartet'});return;}
    const cu=code.toUpperCase();
    socketRoom[socket.id]=cu; socket.join(cu);
    const isMaster=room.players.filter(p=>!p.isBot).length===0;
    const player={id:socket.id,socketId:socket.id,name:name||'Spieler',avatar:avatar||'🎩',
      stack:room.settings.startStack,bet:0,status:'waiting',cards:[],isBot:false,
      isMaster,isSB:false,isBB:false,handName:'',lastAction:null};
    room.players.push(player);
    if(isMaster)room.phase='setup';
    socket.emit('joined',{playerId:socket.id,isMaster});
    if(room.tvSocketId)io.to(room.tvSocketId).emit('player-joined',{player:{id:player.id,name:player.name,avatar:player.avatar}});
    broadcastState(room);
  });

  socket.on('update-settings',(settings)=>{
    const room=rooms[socketRoom[socket.id]];
    if(!room)return;
    const p=room.players.find(p=>p.id===socket.id);
    if(!p?.isMaster)return;
    Object.assign(room.settings,settings);
    if(room.phase==='setup')for(const pl of room.players)pl.stack=room.settings.startStack;
    broadcastState(room);
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
    const active=room.actionSeat>=0?room.players[room.actionSeat]:null;
    if(!active||active.id!==socket.id)return;
    handleAction(room,socket.id,action,amount||0);
  });

  socket.on('new-game',()=>{
    const code=socketRoom[socket.id];
    const room=rooms[code];
    if(!room)return;
    const isTv=room.tvSocketId===socket.id;
    const p=room.players.find(p=>p.socketId===socket.id);
    if(!isTv&&!p?.isMaster)return;
    clearTimer(room);
    room.phase='lobby'; room.players=[]; room.communityCards=[]; room.pot=0;
    room.actionSeat=-1; room.dealerSeat=-1; room.lastAggressorSeat=-1;
    room.deck=[]; room.handNumber=0; room.highestBet=0;
    room.lastRaiseAmount=room.settings.bigBlind; room.handsSinceBlindRaise=0;
    io.to(code).emit('new-game-started');
    broadcastState(room);
  });

  socket.on('disconnect',()=>{
    const code=socketRoom[socket.id];
    if(!code||!rooms[code]){delete socketRoom[socket.id];return;}
    const room=rooms[code];
    delete socketRoom[socket.id];
    if(room.tvSocketId===socket.id){room.tvSocketId=null;return;}
    const pidx=room.players.findIndex(p=>p.socketId===socket.id);
    if(pidx<0)return;
    const p=room.players[pidx];
    if(['preflop','flop','turn','river'].includes(room.phase)){
      p.status='folded'; p.lastAction='FOLD';
      if(room.actionSeat===pidx){broadcastState(room);advanceAction(room);}
      else broadcastState(room);
    }
    if(p.isMaster){
      const next=room.players.find(pp=>!pp.isBot&&pp.id!==p.id&&pp.socketId);
      if(next){next.isMaster=true;io.to(next.socketId).emit('master-assigned');}
    }
  });
});

const PORT=process.env.PORT||3000;
httpServer.listen(PORT,'0.0.0.0',()=>{console.log('\n♠ Royal Poker gestartet auf Port '+PORT);});
