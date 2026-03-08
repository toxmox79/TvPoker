'use strict'

const http = require('http')
const path = require('path')
const fs = require('fs')
const {Server} = require('socket.io')

const PORT = process.env.PORT || 3000

const MIME = {
  '.html':'text/html; charset=utf-8', '.css':'text/css',
  '.js':'application/javascript', '.json':'application/json',
  '.png':'image/png', '.ico':'image/x-icon',
}

const PUBLIC_DIR = path.resolve(__dirname, 'public')

const httpServer = http.createServer((req, res) => {
  let p = req.url.split('?')[0]
  if (p === '/config') {
    const host = (req.headers['x-forwarded-host']||req.headers.host||'localhost').split(',')[0].trim()
    const proto = (req.headers['x-forwarded-proto']||'http').split(',')[0].trim()
    res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-cache'})
    res.end(JSON.stringify({baseUrl: proto+'://'+host}))
    return
  }
  if (p==='/'||p==='/tv') p='/tv.html'
  if (p==='/phone') p='/phone.html'
  const safe = path.join(PUBLIC_DIR, path.normalize(p).replace(/^(\.\.[\/\\])+/,''))
  if (!safe.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return }
  fs.readFile(safe, (err,data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return }
    res.writeHead(200,{'Content-Type': MIME[path.extname(safe).toLowerCase()]||'application/octet-stream'})
    res.end(data)
  })
})

const io = new Server(httpServer,{cors:{origin:'*'}})

/* =========================================================
CARD SYSTEM
========================================================= */

const HAND_NAMES=['High Card','One Pair','Two Pair','Three of a Kind','Straight','Flush','Full House','Four of a Kind','Straight Flush','Royal Flush']

function cRank(c){ return '23456789TJQKA'.indexOf(c[0]) }

function shuffle(a){
  for(let i=a.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1))
    ;[a[i],a[j]]=[a[j],a[i]]
  }
  return a
}

function makeDeck(){
  const d=[]
  for(const s of 'shdc')
    for(const r of '23456789TJQKA')
      d.push(r+s)
  return shuffle(d)
}

/* =========================================================
HAND EVALUATOR (7 card)
========================================================= */

function evaluate(cards){
  let best=null

  function pick(start,chosen){
    if(chosen.length===5){
      const s=score5(chosen)
      if(!best || cmp(s,best)>0) best=s
      return
    }
    for(let i=start;i<=cards.length-(5-chosen.length);i++){
      chosen.push(cards[i])
      pick(i+1,chosen)
      chosen.pop()
    }
  }

  pick(0,[])
  return best
}

function score5(cards){
  const ranks=cards.map(cRank).sort((a,b)=>b-a)
  const suits=cards.map(c=>c[1])
  const flush=suits.every(s=>s===suits[0])

  const freq={}
  for(const r of ranks) freq[r]=(freq[r]||0)+1

  const counts=Object.values(freq).sort((a,b)=>b-a)
  const uniq=[...new Set(ranks)].sort((a,b)=>b-a)

  let straight=false
  if(uniq.length===5 && uniq[0]-uniq[4]===4) straight=true
  
  const wheelRanks=[12,4,3,2,1]
  let isWheel=!straight && uniq.length===5 && uniq.every((r,i)=>r===wheelRanks[i])
  if(isWheel) straight=true

  let hr

  if(straight && flush) hr = isWheel ? 8 : 9
  else if(counts[0]===4) hr=7
  else if(counts[0]===3 && counts[1]===2) hr=6
  else if(flush) hr=5
  else if(straight) hr=4
  else if(counts[0]===3) hr=3
  else if(counts[0]===2 && counts[1]===2) hr=2
  else if(counts[0]===2) hr=1
  else hr=0

  let tiebreakers=[]
  if(hr===6){
    const three=Object.entries(freq).find(e=>+e[1]===3)
    const pair=Object.entries(freq).find(e=>+e[1]===2)
    tiebreakers=[+three[0],+pair[0]]
  }else if(hr===2){
    const pairs=Object.entries(freq).filter(e=>+e[1]===2).map(e=>+e[0]).sort((a,b)=>b-a)
    const kicker=Object.entries(freq).find(e=>+e[1]===1)
    tiebreakers=[...pairs,kicker?+kicker[0]:0]
  }else if(hr===1){
    const pair=Object.entries(freq).find(e=>+e[1]===2)
    const kickers=Object.entries(freq).filter(e=>+e[1]===1).map(e=>+e[0]).sort((a,b)=>b-a)
    tiebreakers=[+pair[0],...kickers]
  }else if(hr===0){
    tiebreakers=isWheel?[4,3,2,1,0]:ranks
  }else{
    const byFreq=Object.entries(freq).sort((a,b)=>b[1]-a[1]||b[0]-a[0]).map(e=>+e[0])
    tiebreakers=isWheel && straight?[4,3,2,1,0]:byFreq
  }

  return [hr,...tiebreakers]
}

function cmp(a,b){
  for(let i=0;i<Math.max(a.length,b.length);i++){
    const d=(a[i]??-1)-(b[i]??-1)
    if(d!==0) return d
  }
  return 0
}

/* =========================================================
TABLE / ROOM SYSTEM
========================================================= */

const rooms={}, socketRoom={}

function newRoom(){
  const code=''+Math.random().toString(36).substring(2,7).toUpperCase()
  rooms[code]={
    code, phase:'lobby',
    players:[], deck:[], community:[],
    pot:0, highestBet:0, lastRaise:0,
    dealerSeat:-1, actionSeat:-1, lastToAct:-1,
    handNum:0,
    playerContributions:{},
    settings:{
      startStack:5000, smallBlind:25, bigBlind:50,
      blindRaiseEvery:5, maxBlind:800, botCount:0,
      botDifficulty:'medium', timer:30
    },
    timerInterval:null, timerLeft:0, handsSinceBlind:0,
    tvSocketId:null,
  }
  return code
}

/* =========================================================
PLAYER MODEL
========================================================= */

function createPlayer(socket, name){
  return{
    id:socket.id, socketId:socket.id, name:name||'Player',
    stack:5000, bet:0, totalBet:0, cards:[], status:'waiting',
    isSB:false, isBB:false, isBot:false, isMaster:false,
    handName:'', lastAction:null, avatar:'🎩'
  }
}

/* =========================================================
HELPERS
========================================================= */

function nextActive(players, from, statusSet){
  const n=players.length
  for(let i=1;i<=n;i++){
    const s=(from+i)%n
    if(statusSet.has(players[s].status)) return s
  }
  return -1
}

function countStatus(players, set){
  return players.filter(p=>set.has(p.status)).length
}

function clearTimer(room){
  if(room.timerInterval){ clearInterval(room.timerInterval); room.timerInterval=null }
  room.timerLeft=0
}

function broadcast(room){
  for(const p of room.players){
    if(!p.isBot && p.socketId)
      io.to(p.socketId).emit('game-state', pubState(room, p.id))
  }
}

function pubState(room, forId){
  const reveal = room.phase==='showdown' || room.phase==='winner'
  return {
    code: room.code, phase: room.phase, pot: room.pot,
    community: room.community, handNum: room.handNum,
    settings: room.settings, actionSeat: room.actionSeat,
    dealerSeat: room.dealerSeat, highestBet: room.highestBet,
    timerLeft: room.timerLeft,
    players: room.players.map((p,i)=>({
      id: p.id, name: p.name, avatar: p.avatar,
      stack: p.stack, bet: p.bet, status: p.status,
      isDealer: i===room.dealerSeat, isSB: p.isSB, isBB: p.isBB,
      isMaster: p.isMaster, isBot: p.isBot, isActive: i===room.actionSeat,
      lastAction: p.lastAction, handName: reveal ? p.handName : null,
      cards: (p.id===forId || reveal) ? p.cards : (p.cards.length ? ['??','??'] : []),
    }))
  }
}

/* =========================================================
HAND START
========================================================= */

const BOT_NAMES=['Dealer Dan','Lucky Lou','Ace Annie','Bluff Bill','Sharp Sid']
const BOT_AVATARS=['🤖','🎲','💀','👾','🃏']

function startGame(room){
  for(let i=0;i<room.settings.botCount;i++){
    room.players.push({
      id:'bot_'+i, socketId:null,
      name:BOT_NAMES[i]||'Bot '+(i+1), avatar:BOT_AVATARS[i]||'🤖',
      stack:room.settings.startStack, bet:0,
      status:'waiting', cards:[], isBot:true, isMaster:false,
      isSB:false, isBB:false, handName:'', lastAction:null, totalBet:0
    })
  }
  room.phase='dealing'
  broadcast(room)
  setTimeout(()=>startHand(room), 800)
}

function startHand(room){
  clearTimer(room)

  for(const p of room.players) if(p.stack<=0) p.status='out'
  if(countStatus(room.players,new Set(['active','waiting','out']))<2 ||
     room.players.filter(p=>p.stack>0).length<2){ endGame(room); return }

  room.handNum++
  room.deck=makeDeck()
  room.community=[]
  room.pot=0
  room.playerContributions={}
  room.highestBet=0
  room.lastRaise=room.settings.bigBlind
  room.actionSeat=-1
  room.lastToAct=-1
  room.phase='preflop'

  for(const p of room.players){
    p.bet=0; p.cards=[]; p.isSB=false; p.isBB=false
    p.handName=''; p.lastAction=null; p.totalBet=0
    p.status = p.stack>0 ? 'active' : 'out'
    room.playerContributions[p.id]=0
  }

  room.dealerSeat=nextActive(room.players,
    room.dealerSeat<0 ? room.players.length-1 : room.dealerSeat,
    new Set(['active']))

  for(const p of room.players)
    if(p.status==='active') p.cards=[room.deck.pop(),room.deck.pop()]

  const sbSeat=nextActive(room.players,room.dealerSeat,new Set(['active']))
  const bbSeat=nextActive(room.players,sbSeat,new Set(['active']))

  const sb=room.players[sbSeat]
  const bb=room.players[bbSeat]
  sb.isSB=true; bb.isBB=true

  const sbAmt=Math.min(sb.stack, room.settings.smallBlind)
  const bbAmt=Math.min(bb.stack, room.settings.bigBlind)
  blind(room, sbSeat, sbAmt)
  blind(room, bbSeat, bbAmt)

  for(const p of room.players){
    if(!p.isBot && p.socketId && p.cards.length)
      io.to(p.socketId).emit('deal-cards', {cards:p.cards})
  }
  broadcast(room)

  room.lastToAct=bbSeat
  room.actionSeat=nextActive(room.players, bbSeat, new Set(['active']))
  scheduleAction(room)
}

/* =========================================================
BLINDS
========================================================= */

function blind(room, seat, amt){
  const p=room.players[seat]
  const bet=Math.min(amt, p.stack)
  p.stack-=bet
  p.bet+=bet
  p.totalBet+=bet
  room.pot+=bet
  room.playerContributions[p.id]=(room.playerContributions[p.id]||0)+bet
  room.highestBet=Math.max(room.highestBet, p.bet)
  if(p.stack===0) p.status='allin'
}

/* =========================================================
ACTION SCHEDULING
========================================================= */

function scheduleAction(room){
  clearTimer(room)
  if(room.actionSeat<0) return

  const player=room.players[room.actionSeat]
  if(!player || player.status!=='active'){ nextAction(room, room.actionSeat); return }

  const callAmt=Math.min(player.stack, room.highestBet-player.bet)
  const valid=validActions(player, room)

  if(player.isBot){
    setTimeout(()=>{
      if(room.actionSeat>=0 && room.players[room.actionSeat]?.id===player.id)
        botDecide(room, player)
    }, 1000+Math.random()*1500)
    return
  }

  if(player.socketId)
    io.to(player.socketId).emit('your-turn',{
      callAmount:callAmt, validActions:valid,
      minRaise:Math.max(room.settings.bigBlind, room.lastRaise),
      timerLeft:room.settings.timer,
    })
  broadcast(room)

  if(room.settings.timer>0){
    room.timerLeft=room.settings.timer
    room.timerInterval=setInterval(()=>{
      room.timerLeft=Math.max(0,room.timerLeft-1)
      broadcast(room)
      if(room.timerLeft<=0){
        clearTimer(room)
        applyAction(room, player.id, callAmt===0?'check':'fold', 0)
      }
    }, 1000)
  }
}

function validActions(p, room){
  const call=room.highestBet-p.bet
  const acts=['fold']
  if(call<=0) acts.push('check')
  else if(p.stack>0) acts.push('call')
  if(p.stack>call){ acts.push('raise'); acts.push('allin') }
  else if(p.stack>0) acts.push('allin')
  return acts
}

/* =========================================================
ACTION ENGINE
========================================================= */

function applyAction(room, playerId, action, amount=0){
  clearTimer(room)
  if(room.actionSeat<0) return

  const seat=room.actionSeat
  const p=room.players[seat]

  if(!p || p.id!==playerId || p.status!=='active') return

  p.lastAction=action.toUpperCase()

  switch(action){
    case 'fold':
      p.status='folded'
      break

    case 'check':
      break

    case 'call':{
      let call=room.highestBet-p.bet
      call=Math.min(call, p.stack)
      p.stack-=call
      p.bet+=call
      p.totalBet+=call
      room.pot+=call
      room.playerContributions[p.id]=(room.playerContributions[p.id]||0)+call
      if(p.stack===0) p.status='allin'
      break
    }

    case 'raise':{
      const minRaise=room.lastRaise
      const target=Math.max(room.highestBet+minRaise, amount)
      const add=target-p.bet
      const bet=Math.min(add, p.stack)

      p.stack-=bet
      p.bet+=bet
      p.totalBet+=bet
      room.pot+=bet
      room.playerContributions[p.id]=(room.playerContributions[p.id]||0)+bet

      const raise=p.bet-room.highestBet
      if(raise>=room.lastRaise){
        room.lastRaise=raise
        room.lastToAct=seat
      }
      room.highestBet=Math.max(room.highestBet, p.bet)

      if(p.stack===0) p.status='allin'
      break
    }

    case 'allin':{
      const all=p.stack
      p.bet+=all
      p.totalBet+=all
      p.stack=0
      room.pot+=all
      room.playerContributions[p.id]=(room.playerContributions[p.id]||0)+all

      const r=p.bet-room.highestBet
      if(r>=room.lastRaise){
        room.lastRaise=r
        room.lastToAct=seat
      }
      room.highestBet=Math.max(room.highestBet, p.bet)
      p.status='allin'
      break
    }
  }

  broadcast(room)
  nextAction(room, seat)
}

/* =========================================================
ACTION FLOW
========================================================= */

function nextAction(room, seat){
  const active=room.players.filter(p=>p.status==='active')
  const inHand=room.players.filter(p=>p.status==='active'||p.status==='allin')

  if(inHand.length<=1){ closeHand(room); return }
  if(active.length===0){ nextStreet(room); return }

  const equal=active.every(p=>p.bet===room.highestBet)
  if(equal && seat===room.lastToAct){ nextStreet(room); return }

  room.actionSeat=nextActive(room.players, seat, new Set(['active']))
  scheduleAction(room)
}

/* =========================================================
STREETS
========================================================= */

function nextStreet(room){
  for(const p of room.players) p.bet=0
  room.highestBet=0
  room.lastRaise=room.settings.bigBlind

  if(room.phase==='preflop'){
    room.phase='flop'
    room.deck.pop()
    room.community.push(room.deck.pop(), room.deck.pop(), room.deck.pop())
  }
  else if(room.phase==='flop'){
    room.phase='turn'
    room.deck.pop()
    room.community.push(room.deck.pop())
  }
  else if(room.phase==='turn'){
    room.phase='river'
    room.deck.pop()
    room.community.push(room.deck.pop())
  }
  else{
    showdown(room)
    return
  }

  const active=room.players.filter(p=>p.status==='active')
  if(active.length===0){ showdown(room); return }

  room.actionSeat=nextActive(room.players, room.dealerSeat, new Set(['active']))
  room.lastToAct=nextActive(room.players, room.dealerSeat, new Set(['active']))

  broadcast(room)
  scheduleAction(room)
}

/* =========================================================
SIDE POT ENGINE
========================================================= */

function createSidePots(room){
  const pots=[]
  const levels=[...new Set(room.players.map(p=>p.totalBet).filter(v=>v>0))]
    .sort((a,b)=>a-b)

  let prev=0
  for(const lvl of levels){
    const contrib=room.players.filter(p=>p.totalBet>=lvl)
    const amount=(lvl-prev)*contrib.length
    const eligible=contrib.filter(p=>p.status!=='folded')
    pots.push({amount, players:eligible})
    prev=lvl
  }
  return pots.length>0 ? pots : [{amount:room.pot, players:room.players.filter(p=>p.status!=='folded')}]
}

/* =========================================================
SHOWDOWN
========================================================= */

function showdown(room){
  clearTimer(room)
  room.phase='showdown'
  room.actionSeat=-1

  while(room.community.length<5){
    room.deck.pop()
    if(room.community.length<3)
      room.community.push(room.deck.pop(), room.deck.pop(), room.deck.pop())
    else
      room.community.push(room.deck.pop())
  }

  const contenders=room.players.filter(p=>(p.status==='active'||p.status==='allin') && p.cards.length===2)
  for(const p of contenders){
    const sc=evaluate([...p.cards, ...room.community])
    p.handName=sc ? HAND_NAMES[sc[0]] : 'High Card'
    p._score=sc
  }

  broadcast(room)

  const pots=createSidePots(room)
  const potWinnings={}
  for(const p of room.players) potWinnings[p.id]=0

  const allWinners=[]
  for(const pot of pots){
    let best=null
    const potContenders=contenders.filter(p=>pot.players.includes(p))

    for(const p of potContenders){
      if(!p._score) continue
      if(!best || cmp(p._score,best)>0) best=p._score
    }

    if(best){
      const potWinners=potContenders.filter(p=>p._score && cmp(p._score,best)===0)
      const baseShare=Math.floor(pot.amount/potWinners.length)
      const remainder=pot.amount%potWinners.length

      for(let i=0;i<potWinners.length;i++){
        const share=baseShare+(i<remainder?1:0)
        potWinnings[potWinners[i].id]+=share
        allWinners.push({id:potWinners[i].id, name:potWinners[i].name, avatar:potWinners[i].avatar, handName:potWinners[i].handName, amount:share})
      }
    }
  }

  for(const p of room.players){
    if(potWinnings[p.id]) p.stack+=potWinnings[p.id]
  }

  io.to(room.code).emit('winner', {winners:allWinners, pot:room.pot})
  room.phase='winner'
  broadcast(room)
  scheduleNextHand(room)
}

function closeHand(room){
  clearTimer(room)
  const inHand=room.players.filter(p=>p.status==='active'||p.status==='allin')
  const last=inHand[0]
  if(last){
    last.stack+=room.pot
    io.to(room.code).emit('winner',{
      winners:[{id:last.id, name:last.name, avatar:last.avatar, handName:'(everyone folded)', amount:room.pot}],
      pot:room.pot,
    })
  }
  room.phase='winner'
  room.actionSeat=-1
  broadcast(room)
  scheduleNextHand(room)
}

function scheduleNextHand(room){
  room.handsSinceBlind=(room.handsSinceBlind||0)+1
  if(room.settings.blindRaiseEvery>0 && room.handsSinceBlind>=room.settings.blindRaiseEvery){
    room.handsSinceBlind=0
    room.settings.smallBlind=Math.min(room.settings.smallBlind*2, room.settings.maxBlind)
    room.settings.bigBlind=room.settings.smallBlind*2
    io.to(room.code).emit('blind-raise', {small:room.settings.smallBlind, big:room.settings.bigBlind})
  }
  setTimeout(()=>{
    for(const p of room.players) if(p.stack<=0) p.status='out'
    if(room.players.filter(p=>p.stack>0).length<2){ endGame(room); return }
    startHand(room)
  }, 5000)
}

function endGame(room){
  clearTimer(room)
  const winner=[...room.players].sort((a,b)=>b.stack-a.stack)[0]
  room.phase='gameover'
  room.actionSeat=-1
  io.to(room.code).emit('game-over', {winner, players:room.players})
  broadcast(room)
}

/* =========================================================
BOT AI
========================================================= */

function chenScore(cards){
  if(!cards||cards.length<2) return 0
  const r1=cRank(cards[0]), r2=cRank(cards[1])
  const hi=Math.max(r1,r2), lo=Math.min(r1,r2), gap=hi-lo
  const suited=cards[0][1]===cards[1][1]
  const tbl=[0,0,1,1.5,2,2.5,3,3.5,4,4.5,5,6,7,8,10]
  let score=tbl[hi]||hi/2
  if(gap===0){ score=Math.max(score*2,5); return Math.min(score/20,1) }
  if(suited) score+=2
  if(gap===2) score-=1; else if(gap===3) score-=2; else if(gap>=4) score-=4
  if(hi<=9&&gap<=1) score+=1
  return Math.min(Math.max(score,0)/20,1)
}

function mcEquity(hole, community, numOpp, sims){
  if(!hole||hole.length<2) return 0.3
  numOpp=Math.max(1,numOpp); sims=sims||200
  const known=new Set([...hole,...community].filter(c=>c&&c!=='??'))
  const avail=[]
  for(const s of 'shdc') for(const r of '23456789TJQKA'){ const c=r+s; if(!known.has(c)) avail.push(c) }
  const toFill=5-community.length
  let wins=0, ties=0
  for(let sim=0;sim<sims;sim++){
    const d=avail.slice()
    for(let i=d.length-1;i>0;i--){ const j=Math.random()*(i+1)|0; [d[i],d[j]]=[d[j],d[i]] }
    const board=[...community,...d.slice(0,toFill)]
    let ptr=toFill
    const opps=[]; for(let o=0;o<numOpp;o++) opps.push([d[ptr++],d[ptr++]])
    const mine=evaluate([...hole,...board])
    if(!mine) continue
    let best=true, tie=false
    for(const opp of opps){
      const os=evaluate([...opp,...board])
      if(!os) continue
      const c=cmp(mine,os)
      if(c<0){ best=false; break }
      if(c===0) tie=true
    }
    if(best&&tie) ties++; else if(best) wins++
  }
  return (wins+ties*0.5)/sims
}

function posBonusCalc(room, seat){
  const ACTIVE=new Set(['active'])
  let after=0, s=seat
  for(let i=0;i<room.players.length-1;i++){
    s=(s+1)%room.players.length
    if(ACTIVE.has(room.players[s].status)) after++
  }
  const tot=countStatus(room.players,ACTIVE)
  return tot>1 ? (tot-1-after)/(tot-1)*0.07 : 0
}

function calcRaise(room, bot, equity, diff){
  const minRaise=Math.max(room.settings.bigBlind, room.lastRaise)
  const mult=equity>0.80 ? 0.75+Math.random()*0.5
             : equity>0.65 ? 0.50+Math.random()*0.3
             :                0.30+Math.random()*0.2
  const potBet=Math.floor(room.pot*mult)
  const raiseTo=Math.max(room.highestBet+minRaise, room.highestBet+potBet)
  return Math.min(raiseTo, bot.stack+bot.bet)
}

function botDecide(room, bot){
  if(room.actionSeat<0 || room.players[room.actionSeat]?.id!==bot.id) return
  if(bot.status!=='active') return

  const diff=room.settings.botDifficulty
  const numOpp=countStatus(room.players,new Set(['active','allin']))-1
  const ca=Math.min(bot.stack, room.highestBet-bot.bet)
  const pot=room.pot
  const spr=pot>0 ? bot.stack/pot : 999
  const lowSpr=spr<4

  let eq
  if(room.phase==='preflop'){
    const chen=chenScore(bot.cards)
    if(diff==='easy') eq=chen
    else{ const mc=mcEquity(bot.cards,[],numOpp,diff==='hard'?120:60); eq=diff==='hard'?chen*0.3+mc*0.7:chen*0.5+mc*0.5 }
  }else{
    eq=mcEquity(bot.cards,room.community,numOpp,diff==='hard'?300:diff==='medium'?200:100)
  }
  eq=Math.min(eq+posBonusCalc(room,room.actionSeat), 0.99)

  const potOdds=ca>0 ? ca/(pot+ca) : 0
  const bluff=Math.random()<(diff==='hard'?0.12:diff==='medium'?0.06:0.02) && ca<=pot*0.4

  const foldTh=diff==='hard'?0.30:diff==='medium'?0.35:0.40
  const callTh=diff==='hard'?0.45:diff==='medium'?0.50:0.55
  const raiseTh=diff==='hard'?0.60:diff==='medium'?0.65:0.70
  const reraiseTh=diff==='hard'?0.78:diff==='medium'?0.82:0.88

  let action='fold', amount=0

  if(ca===0){
    if(eq>raiseTh||bluff){ action='raise'; amount=calcRaise(room,bot,eq,diff) }
    else action='check'
  }else{
    if(eq<foldTh&&!bluff&&potOdds>eq) action='fold'
    else if(eq<callTh&&!bluff){ action=potOdds<eq+0.05?'call':'fold' }
    else if(eq>reraiseTh||bluff){ action='raise'; amount=calcRaise(room,bot,eq,diff) }
    else{ action=(eq>raiseTh&&Math.random()<0.6)?'raise':'call'; if(action==='raise') amount=calcRaise(room,bot,eq,diff) }
  }

  if(action==='raise'){
    if(lowSpr&&eq>0.65){ action='allin'; amount=0 }
    else if(amount>=bot.stack+bot.bet){ action='allin'; amount=0 }
  }
  if(action==='call'&&lowSpr&&eq>0.70){ action='allin'; amount=0 }
  if(diff==='easy'&&Math.random()<0.15){ if(action==='call') action='fold'; else if(action==='raise'){action='call';amount=0;} }

  applyAction(room, bot.id, action, amount)
}

/* =========================================================
SOCKET API
========================================================= */

io.on('connection', socket=>{

  socket.on('create-room', ()=>{
    const code=newRoom()
    socketRoom[socket.id]=code
    rooms[code].tvSocketId=socket.id
    socket.join(code)
    socket.emit('room-created', {code})
  })

  socket.on('join-room', ({code, name, avatar})=>{
    const room=rooms[code?.toUpperCase()]
    if(!room){ socket.emit('error',{msg:'Raum nicht gefunden'}); return }
    if(room.phase!=='lobby'&&room.phase!=='setup'){ socket.emit('error',{msg:'Spiel bereits gestartet'}); return }
    const cu=code.toUpperCase()
    socketRoom[socket.id]=cu
    socket.join(cu)
    const isMaster=room.players.filter(p=>!p.isBot).length===0
    const player={
      id:socket.id, socketId:socket.id, name:name||'Spieler', avatar:avatar||'🎩',
      stack:room.settings.startStack, bet:0, status:'waiting', cards:[],
      isBot:false, isMaster, isSB:false, isBB:false, handName:'', lastAction:null, totalBet:0
    }
    room.players.push(player)
    if(isMaster) room.phase='setup'
    socket.emit('joined', {playerId:socket.id, isMaster})
    if(room.tvSocketId) io.to(room.tvSocketId).emit('player-joined', {player:{id:player.id, name:player.name, avatar:player.avatar}})
    broadcast(room)
  })

  socket.on('update-settings', settings=>{
    const room=rooms[socketRoom[socket.id]]
    if(!room) return
    const p=room.players.find(p=>p.id===socket.id)
    if(!p?.isMaster) return
    Object.assign(room.settings, settings)
    if(room.phase==='setup') for(const pl of room.players) pl.stack=room.settings.startStack
    broadcast(room)
  })

  socket.on('start-game', ()=>{
    const room=rooms[socketRoom[socket.id]]
    if(!room) return
    const p=room.players.find(p=>p.id===socket.id)
    if(!p?.isMaster) return
    startGame(room)
  })

  socket.on('player-action', ({action, amount})=>{
    const room=rooms[socketRoom[socket.id]]
    if(!room) return
    const active=room.actionSeat>=0 ? room.players[room.actionSeat] : null
    if(!active || active.id!==socket.id) return
    applyAction(room, socket.id, action, amount||0)
  })

  socket.on('new-game', ()=>{
    const code=socketRoom[socket.id]
    const room=rooms[code]
    if(!room) return
    const isTv=room.tvSocketId===socket.id
    const p=room.players.find(p=>p.socketId===socket.id)
    if(!isTv && !p?.isMaster) return
    clearTimer(room)
    Object.assign(room, {
      phase:'lobby', players:[], community:[], pot:0,
      actionSeat:-1, dealerSeat:-1, lastToAct:-1,
      deck:[], handNum:0, highestBet:0,
      lastRaise:room.settings.bigBlind, handsSinceBlind:0, playerContributions:{},
    })
    io.to(code).emit('new-game-started')
    broadcast(room)
  })

  socket.on('disconnect', ()=>{
    const code=socketRoom[socket.id]
    delete socketRoom[socket.id]
    if(!code||!rooms[code]) return
    const room=rooms[code]
    if(room.tvSocketId===socket.id){ room.tvSocketId=null; return }
    const pidx=room.players.findIndex(p=>p.socketId===socket.id)
    if(pidx<0) return
    const p=room.players[pidx]
    if(['preflop','flop','turn','river'].includes(room.phase)){
      p.status='folded'; p.lastAction='FOLD'
      if(room.actionSeat===pidx){ broadcast(room); nextAction(room, pidx) }
      else broadcast(room)
    }
    if(p.isMaster){
      const next=room.players.find(pp=>!pp.isBot&&pp.id!==p.id&&pp.socketId)
      if(next){ next.isMaster=true; io.to(next.socketId).emit('master-assigned') }
    }
  })
})

httpServer.listen(PORT, '0.0.0.0', ()=>console.log('\n♠ Royal Poker auf Port '+PORT))
