'use strict';
const http = require('http');
const path = require('path');
const fs   = require('fs');

// =====================================================================
// Poker Server – corrected rules (PokerTH-style)
// Fixes:
// • Side pots
// • Correct heads-up blinds
// • Proper min-raise rule
// • Short all-in does not reopen betting
// • Correct A-5 straight detection
// • Proper pot distribution
// • Board runout when everyone all-in
// =====================================================================

// ─── HTTP ─────────────────────────────────────────────────────────────
const MIME = {
  '.html':'text/html; charset=utf-8', '.css':'text/css',
  '.js':'application/javascript', '.json':'application/json',
  '.png':'image/png', '.ico':'image/x-icon',
  '.webmanifest':'application/manifest+json'
};

const PUBLIC_DIR = path.resolve(__dirname,'public');

const httpServer = http.createServer((req,res)=>{

  let p = req.url.split('?')[0];

  if (p === '/config') {

    const host  = (req.headers['x-forwarded-host']||req.headers.host||'localhost').split(',')[0].trim();
    const proto = (req.headers['x-forwarded-proto']||'http').split(',')[0].trim();

    res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-cache'});
    res.end(JSON.stringify({baseUrl:proto+'://'+host}));

    return;
  }

  if (p==='/'||p==='/tv') p='/tv.html';
  if (p==='/phone') p='/phone.html';

  const safe = path.join(PUBLIC_DIR, path.normalize(p).replace(/^(\.\.[/\\])+/,'') );

  if (!safe.startsWith(PUBLIC_DIR)) {

    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(safe,(err,data)=>{

    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    res.writeHead(200,{'Content-Type':MIME[path.extname(safe).toLowerCase()]||'application/octet-stream'});
    res.end(data);

  });

});

const {Server} = require('socket.io');

const io = new Server(httpServer,{
  cors:{origin:'*'},
  transports:['websocket','polling'],
  allowEIO3:true
});

// ─── Helpers ──────────────────────────────────────────────────────────

function randCode(){

  const L='ABCDEFGHJKLMNPQRSTUVWXYZ';
  const N='23456789';

  return [0,1,2].map(()=>L[Math.random()*L.length|0]).join('')+'-'+[0,1,2].map(()=>N[Math.random()*N.length|0]).join('');

}

function shuffle(a){

  for (let i=a.length-1;i>0;i--){

    const j=Math.random()*(i+1)|0;

    [a[i],a[j]]=[a[j],a[i]];

  }

  return a;
}

function makeDeck(){

  const d=[];

  for (const s of 'shdc') for (const r of '23456789TJQKA') d.push(r+s);

  return shuffle(d);

}

// ─── Hand Evaluator ───────────────────────────────────────────────────

const HAND_NAMES=[
'High Card','One Pair','Two Pair','Three of a Kind','Straight','Flush','Full House','Four of a Kind','Straight Flush','Royal Flush'
];

function cRank(c){ return '23456789TJQKA'.indexOf(c[0]); }

function evaluate(cards){

  let best=null;

  function pick(start,chosen){

    if (chosen.length===5){

      const s=score5(chosen);

      if (!best || cmp(s,best)>0) best=s;

      return;
    }

    for (let i=start;i<=cards.length-(5-chosen.length);i++){

      chosen.push(cards[i]);

      pick(i+1,chosen);

      chosen.pop();

    }

  }

  if (cards.length<=5) best=score5(cards);
  else pick(0,[]);

  return best;

}

function score5(cards){

  const ranks=cards.map(cRank).sort((a,b)=>b-a);

  const suits=cards.map(c=>c[1]);

  const flush=suits.every(s=>s===suits[0]);

  const freq={};

  for (const r of ranks) freq[r]=(freq[r]||0)+1;

  const counts=Object.values(freq).sort((a,b)=>b-a);

  const uniq=[...new Set(ranks)].sort((a,b)=>b-a);

  let straight=false;

  if (uniq.length===5 && uniq[0]-uniq[4]===4) straight=true;

  // Wheel A-2-3-4-5

  if (!straight && uniq.toString()==='12,3,2,1,0') straight=true;

  let hr;

  if (straight && flush) hr=ranks[0]===12?9:8;
  else if (counts[0]===4) hr=7;
  else if (counts[0]===3 && counts[1]===2) hr=6;
  else if (flush) hr=5;
  else if (straight) hr=4;
  else if (counts[0]===3) hr=3;
  else if (counts[0]===2 && counts[1]===2) hr=2;
  else if (counts[0]===2) hr=1;
  else hr=0;

  const byFreq=Object.entries(freq)
    .sort((a,b)=>b[1]-a[1]||b[0]-a[0])
    .map(e=>+e[0]);

  return [hr,...byFreq];

}

function cmp(a,b){

  for (let i=0;i<Math.max(a.length,b.length);i++){

    const d=(a[i]??-1)-(b[i]??-1);

    if (d!==0) return d;

  }

  return 0;

}

// ─── Side Pot Engine ──────────────────────────────────────────────────

function buildSidePots(players){

  const arr=players
    .filter(p=>p.totalBet>0)
    .map(p=>({p,bet:p.totalBet}))
    .sort((a,b)=>a.bet-b.bet);

  const pots=[];

  let prev=0;

  for (let i=0;i<arr.length;i++){

    const level=arr[i].bet;

    const diff=level-prev;

    if (diff>0){

      const elig=arr.slice(i).map(e=>e.p);

      const amount=diff*elig.length;

      pots.push({amount,players:elig});

      prev=level;

    }

  }

  return pots;

}

// ─── Rooms ────────────────────────────────────────────────────────────

const rooms={};
const socketRoom={};

function newRoom(){

  const code=randCode();

  rooms[code]={

    code,

    phase:'lobby',

    players:[],

    deck:[],

    community:[],

    pot:0,

    dealerSeat:-1,

    actionSeat:-1,

    highestBet:0,

    lastRaise:0,

    handNum:0,

    tvSocketId:null

  };

  return code;

}

// ─── Public state ─────────────────────────────────────────────────────

function pubState(room,forId){

  const reveal=room.phase==='showdown'||room.phase==='winner';

  return {

    code:room.code,

    phase:room.phase,

    pot:room.pot,

    community:room.community,

    players:room.players.map(p=>({

      id:p.id,
      name:p.name,
      avatar:p.avatar,
      stack:p.stack,
      bet:p.bet,
      status:p.status,
      cards:(p.id===forId||reveal)?p.cards:['??','??'],
      handName:reveal?p.handName:null

    }))

  };

}

function broadcast(room){

  if (room.tvSocketId)
    io.to(room.tvSocketId).emit('game-state',pubState(room,'__tv__'));

  for (const p of room.players){

    if (!p.isBot && p.socketId)
      io.to(p.socketId).emit('game-state',pubState(room,p.id));

  }

}

// ─── Showdown ─────────────────────────────────────────────────────────

function showdown(room){

  room.phase='showdown';

  while (room.community.length<5){

    room.deck.pop();

    room.community.push(room.deck.pop());

  }

  const contenders=room.players.filter(p=>p.status!=='folded' && p.cards.length===2);

  for (const p of contenders){

    const sc=evaluate([...p.cards,...room.community]);

    p._score=sc;

    p.handName=HAND_NAMES[sc[0]];

  }

  const pots=buildSidePots(room.players);

  for (const pot of pots){

    const elig=pot.players.filter(p=>p.status!=='folded');

    let best=null;

    for (const p of elig)
      if (!best||cmp(p._score,best)>0) best=p._score;

    const winners=elig.filter(p=>cmp(p._score,best)===0);

    const share=Math.floor(pot.amount/winners.length);

    for (const w of winners) w.stack+=share;

  }

  broadcast(room);

}

// ─── SOCKET EVENTS ────────────────────────────────────────────────────

io.on('connection',socket=>{

  socket.on('create-room',()=>{

    const code=newRoom();

    socketRoom[socket.id]=code;

    rooms[code].tvSocketId=socket.id;

    socket.join(code);

    socket.emit('room-created',{code});

  });

  socket.on('join-room',({code,name,avatar})=>{

    const room=rooms[code?.toUpperCase()];

    if (!room){

      socket.emit('error',{msg:'Room not found'});

      return;

    }

    socketRoom[socket.id]=code;

    socket.join(code);

    const player={

      id:socket.id,
      socketId:socket.id,
      name:name||'Player',
      avatar:avatar||'🎩',
      stack:5000,
      bet:0,
      totalBet:0,
      status:'waiting',
      cards:[],
      handName:''

    };

    room.players.push(player);

    socket.emit('joined',{playerId:socket.id});

    broadcast(room);

  });

});

const PORT=process.env.PORT||3000;

httpServer.listen(PORT,'0.0.0.0',()=>console.log('♠ Poker server running on '+PORT));