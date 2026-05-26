const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(express.static(path.join(__dirname, '../public')));

// ---- GAME LOGIC (server-side validation) ----
const GRID = 5;

function initBoardState() {
  const board = Array.from({length: GRID}, () => Array(GRID).fill(0));
  let w = 0;
  for (let r = 0; r < GRID && w < 12; r++)
    for (let c = 0; c < GRID && w < 12; c++) { board[r][c] = 'W'; w++; }
  let b = 0;
  for (let r = GRID-1; r >= 0 && b < 12; r--)
    for (let c = GRID-1; c >= 0 && b < 12; c--)
      if (!board[r][c]) { board[r][c] = 'B'; b++; }
  return board;
}

function getEatMoves(board, r, c) {
  const v = board[r][c]; if (!v) return [];
  const isDouble = v==='WD'||v==='BD', isWhite = v==='W'||v==='WD';
  const moves = [];
  for (const {dr,dc} of [{dr:-1,dc:0},{dr:1,dc:0},{dr:0,dc:-1},{dr:0,dc:1}]) {
    const nr=r+dr, nc=c+dc;
    if (nr<0||nr>=GRID||nc<0||nc>=GRID) continue;
    const nv = board[nr][nc]; if (!nv) continue;
    const nIsWhite = nv==='W'||nv==='WD', nIsDouble = nv==='WD'||nv==='BD';
    if (nIsWhite===isWhite) continue;
    if (!isDouble&&nIsDouble) continue;
    const lr=nr+dr, lc=nc+dc;
    if (lr<0||lr>=GRID||lc<0||lc>=GRID) continue;
    if (board[lr][lc]!==0) continue;
    moves.push({r:lr, c:lc, type:'eat', eatR:nr, eatC:nc});
  }
  return moves;
}

function getNonEatMoves(board, r, c, firstMoveRestrict) {
  const v = board[r][c]; if (!v) return [];
  const isDouble = v==='WD'||v==='BD';
  const moves = [];
  const dirs = firstMoveRestrict ? [{dr:1,dc:0}]
    : [{dr:-1,dc:0},{dr:1,dc:0},{dr:0,dc:-1},{dr:0,dc:1}];
  for (const {dr,dc} of dirs) {
    const nr=r+dr, nc=c+dc;
    if (nr<0||nr>=GRID||nc<0||nc>=GRID) continue;
    const nv = board[nr][nc];
    if (nv===0) {
      moves.push({r:nr, c:nc, type:'move'});
    } else if (!firstMoveRestrict) {
      const nIsWhite = nv==='W'||nv==='WD', isWhite = v==='W'||v==='WD';
      const nIsDouble = nv==='WD'||nv==='BD';
      if (nIsWhite===isWhite) {
        if (!isDouble&&nIsDouble) continue;
        const jr=nr+dr, jc=nc+dc;
        if (jr<0||jr>=GRID||jc<0||jc>=GRID) continue;
        if (board[jr][jc]===0) moves.push({r:jr, c:jc, type:'jump'});
      }
    }
  }
  return moves;
}

function getAllMoves(board, r, c, firstMoveRestrict) {
  if (firstMoveRestrict) return getNonEatMoves(board, r, c, true);
  return [...getEatMoves(board, r, c), ...getNonEatMoves(board, r, c, false)];
}

function applyMove(board, fromR, fromC, mv) {
  const b = board.map(row => [...row]);
  const v = b[fromR][fromC];
  if (mv.type==='eat') b[mv.eatR][mv.eatC] = 0;
  b[mv.r][mv.c] = v;
  b[fromR][fromC] = 0;
  if (v==='W' && mv.r===GRID-1) b[mv.r][mv.c] = 'WD';
  if (v==='B' && mv.r===0)      b[mv.r][mv.c] = 'BD';
  return b;
}

function playerHasAnyMoves(board, player) {
  for (let r=0; r<GRID; r++) for (let c=0; c<GRID; c++) {
    const v = board[r][c];
    const belongs = player==='B' ? (v==='B'||v==='BD') : (v==='W'||v==='WD');
    if (belongs && getAllMoves(board, r, c, false).length > 0) return true;
  }
  return false;
}

function isMoveValid(board, fromR, fromC, mv, isFirstMove, currentPlayer) {
  const restrict = isFirstMove && currentPlayer==='W';
  const legal = getAllMoves(board, fromR, fromC, restrict);
  const match = legal.find(m =>
    m.r===mv.r && m.c===mv.c && m.type===mv.type &&
    (mv.type!=='eat' || (m.eatR===mv.eatR && m.eatC===mv.eatC))
  );
  if (!match) return false;
  const newBoard = applyMove(board, fromR, fromC, mv);
  const opponent = currentPlayer==='W' ? 'B' : 'W';
  if (!playerHasAnyMoves(newBoard, opponent)) {
    const hasSafe = legal.some(m => {
      const nb = applyMove(board, fromR, fromC, m);
      return playerHasAnyMoves(nb, opponent);
    });
    if (hasSafe) return false;
  }
  return true;
}

function countRocks(board, p) {
  let n = 0;
  for (let r=0; r<GRID; r++) for (let c=0; c<GRID; c++) {
    const v = board[r][c];
    if (p==='W' && (v==='W'||v==='WD')) n++;
    if (p==='B' && (v==='B'||v==='BD')) n++;
  }
  return n;
}

// ---- ROOM MANAGEMENT ----
const rooms = new Map();

function createRoom(hostSocketId) {
  const roomId = Math.random().toString(36).substr(2,6).toUpperCase();
  const room = {
    id: roomId,
    players: { W: hostSocketId, B: null },
    board: initBoardState(),
    currentPlayer: 'W',
    isFirstMove: true,
    forcedRetaliation: false,
    retaliationTarget: null,
    chainMode: false,
    chainRock: null,
    lastMove: null,
    gameOver: false,
    createdAt: Date.now()
  };
  rooms.set(roomId, room);
  return room;
}

function broadcastRoom(room) {
  const state = {
    board: room.board,
    currentPlayer: room.currentPlayer,
    isFirstMove: room.isFirstMove,
    forcedRetaliation: room.forcedRetaliation,
    retaliationTarget: room.retaliationTarget,
    chainMode: room.chainMode,
    chainRock: room.chainRock,
    lastMove: room.lastMove,
    aiControlling: room.aiControlling || null,
    gameOver: room.gameOver,
    players: { W: !!room.players.W, B: !!room.players.B }
  };
  io.to(room.id).emit('gameState', state);
}

setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms.entries()) {
    if (now - room.createdAt > 1000*60*60) rooms.delete(id);
  }
}, 1000*60*10);

// ---- SOCKET EVENTS ----
io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  socket.on('createRoom', () => {
    const room = createRoom(socket.id);
    socket.join(room.id);
    socket.emit('roomCreated', { roomId: room.id, color: 'W' });
  });

  socket.on('joinRoom', ({ roomId }) => {
    const room = rooms.get(roomId.toUpperCase().trim());
    if (!room) { socket.emit('joinError', 'Room not found. Check the code and try again.'); return; }
    if (room.players.B) { socket.emit('joinError', 'Room is full.'); return; }
    if (room.gameOver) { socket.emit('joinError', 'Game already ended.'); return; }
    room.players.B = socket.id;
    socket.join(room.id);
    socket.emit('roomJoined', { roomId: room.id, color: 'B' });
    io.to(room.players.W).emit('opponentJoined');
    broadcastRoom(room);
  });

  socket.on('makeMove', ({ roomId, fromR, fromC, mv }) => {
    const room = rooms.get(roomId);
    if (!room || room.gameOver) return;
    const playerColor = room.players.W === socket.id ? 'W' : 'B';
    if (playerColor !== room.currentPlayer) {
      socket.emit('moveError', 'Not your turn'); return;
    }
    if (room.forcedRetaliation) {
      if (playerColor !== 'W') { socket.emit('moveError', 'White must retaliate'); return; }
      if (!mv || mv.type !== 'eat' || mv.eatR !== room.retaliationTarget.r || mv.eatC !== room.retaliationTarget.c) {
        socket.emit('moveError', 'Must eat back the capturing rock'); return;
      }
    }
    if (!isMoveValid(room.board, fromR, fromC, mv, room.isFirstMove, room.currentPlayer)) {
      socket.emit('moveError', 'Invalid move'); return;
    }
    room.lastMove = { fromR, fromC, toR: mv.r, toC: mv.c, player: playerColor };
    room.board = applyMove(room.board, fromR, fromC, mv);
    if (room.isFirstMove) room.isFirstMove = false;

    if (room.forcedRetaliation) {
      room.forcedRetaliation = false; room.retaliationTarget = null;
      room.currentPlayer = 'B';
      broadcastRoom(room); return;
    }

    if (mv.type==='eat' && playerColor==='B' && countRocks(room.board,'W')===11 && countRocks(room.board,'B')===12) {
      const retMoves = [];
      for (let r=0; r<GRID; r++) for (let c=0; c<GRID; c++) {
        const v = room.board[r][c];
        if (v!=='W'&&v!=='WD') continue;
        getEatMoves(room.board, r, c).filter(m=>m.eatR===mv.r&&m.eatC===mv.c)
          .forEach(m => retMoves.push({fr:r,fc:c,mv:m}));
      }
      if (retMoves.length > 0) {
        room.forcedRetaliation = true;
        room.retaliationTarget = {r: mv.r, c: mv.c};
        room.currentPlayer = 'W';
        broadcastRoom(room);
        io.to(room.id).emit('forcedRetaliation', { target: room.retaliationTarget });
        return;
      }
    }

    if (mv.type === 'eat') {
      const chains = getEatMoves(room.board, mv.r, mv.c);
      if (chains.length > 0) {
        room.chainMode = true;
        room.chainRock = {r: mv.r, c: mv.c};
        broadcastRoom(room); return;
      }
    }

    room.chainMode = false; room.chainRock = null;
    const wc = countRocks(room.board, 'W'), bc = countRocks(room.board, 'B');
    if (wc <= 1 || bc <= 1) {
      room.gameOver = true;
      broadcastRoom(room);
      io.to(room.id).emit('gameOver', { winner: wc > 1 ? 'W' : 'B' });
      return;
    }
    room.currentPlayer = room.currentPlayer === 'W' ? 'B' : 'W';
    broadcastRoom(room);
    if (room.aiControlling === room.currentPlayer) scheduleAiMove(room);
  });

  socket.on('stopChain', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    room.chainMode = false; room.chainRock = null;
    room.currentPlayer = room.currentPlayer === 'W' ? 'B' : 'W';
    broadcastRoom(room);
    if (room.aiControlling === room.currentPlayer) scheduleAiMove(room);
  });

  socket.on('requestRematch', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    room.board = initBoardState();
    room.currentPlayer = 'W'; room.isFirstMove = true;
    room.forcedRetaliation = false; room.retaliationTarget = null;
    room.chainMode = false; room.chainRock = null;
    room.lastMove = null; room.gameOver = false;
    room.aiControlling = null;
    room.createdAt = Date.now();
    broadcastRoom(room);
    // If AI was controlling, restart AI if needed
    if (room.aiControlling) scheduleAiMove(room);
  });

  socket.on('rejoinRoom', ({ roomId, color }) => {
    const room = rooms.get(roomId);
    if (!room) { socket.emit('joinError', 'Room no longer exists.'); return; }

    // Restore player control
    room.players[color] = socket.id;
    room.aiControlling = room.aiControlling === color ? null : room.aiControlling;

    // Clear countdown timer if still running
    if (room.disconnectTimers && room.disconnectTimers[color]) {
      clearTimeout(room.disconnectTimers[color]);
      delete room.disconnectTimers[color];
    }

    socket.join(roomId);
    socket.emit('roomJoined', { roomId, color, rejoin: true });
    io.to(roomId).emit('opponentRejoined', { color });
    broadcastRoom(room);
    console.log(`Player ${color} rejoined room ${roomId}`);
  });

  socket.on('disconnect', () => {
    console.log('Disconnected:', socket.id);
    for (const [id, room] of rooms.entries()) {
      const color = room.players.W === socket.id ? 'W'
                  : room.players.B === socket.id ? 'B' : null;
      if (!color) continue;

      // Mark player as disconnected (keep slot open for rejoin)
      room.players[color] = null;
      if (!room.disconnectTimers) room.disconnectTimers = {};
      if (!room.aiControlling) room.aiControlling = null;

      // Notify opponent
      io.to(id).emit('opponentDisconnected', { color, countdown: 60 });

      // Start countdown — AI takes over immediately
      room.aiControlling = color;
      scheduleAiMove(room);

      // After 60s mark as permanent AI (player can still rejoin anytime)
      room.disconnectTimers[color] = setTimeout(() => {
        if (!room.players[color]) {
          io.to(id).emit('aiTookOver', { color });
          console.log(`AI permanently took over ${color} in room ${id}`);
        }
      }, 60000);
    }
  });
});

// ---- SERVER-SIDE AI ----
function getAiMove(board, color, isFirstMove) {
  let allMoves = [];

  if (isFirstMove && color === 'W') {
    for (let r=0; r<GRID; r++) for (let c=0; c<GRID; c++) {
      const v = board[r][c]; if (v!=='W'&&v!=='WD') continue;
      const nr = r+1; if (nr>=GRID) continue;
      if (board[nr][c]===0) allMoves.push({fr:r,fc:c,mv:{r:nr,c:c,type:'move'}});
    }
  } else {
    for (let r=0; r<GRID; r++) for (let c=0; c<GRID; c++) {
      const v = board[r][c];
      const mine = color==='W'?(v==='W'||v==='WD'):(v==='B'||v==='BD');
      if (mine) getAllMoves(board,r,c,false).forEach(m=>allMoves.push({fr:r,fc:c,mv:m}));
    }
  }

  if (!allMoves.length) return null;

  // Filter safe moves
  const opponent = color==='W'?'B':'W';
  const safe = allMoves.filter(x=>{
    const nb = applyMove(board,x.fr,x.fc,x.mv);
    return playerHasAnyMoves(nb,opponent);
  });
  const pool = safe.length>0?safe:allMoves;

  // Prefer eating
  const eats = pool.filter(x=>x.mv.type==='eat');
  return eats.length>0
    ? eats[Math.floor(Math.random()*eats.length)]
    : pool[Math.floor(Math.random()*pool.length)];
}

function scheduleAiMove(room) {
  if (!room || room.gameOver) return;
  const aiColor = room.aiControlling;
  if (!aiColor) return;
  if (room.currentPlayer !== aiColor) return; // not AI's turn yet

  const delay = 900 + Math.random()*600; // 0.9–1.5s feels natural
  room.aiMoveTimeout = setTimeout(() => {
    doAiMove(room);
  }, delay);
}

function doAiMove(room) {
  if (!room || room.gameOver) return;
  if (room.currentPlayer !== room.aiControlling) return;

  const chosen = getAiMove(room.board, room.aiControlling, room.isFirstMove);
  if (!chosen) { endAiTurn(room); return; }

  room.lastMove = { fromR:chosen.fr, fromC:chosen.fc, toR:chosen.mv.r, toC:chosen.mv.c, player:room.aiControlling };
  room.board = applyMove(room.board, chosen.fr, chosen.fc, chosen.mv);
  if (room.isFirstMove) room.isFirstMove = false;

  // Chain eat
  if (chosen.mv.type==='eat') {
    let lr=chosen.mv.r, lc=chosen.mv.c;
    let chains = getEatMoves(room.board, lr, lc);
    while (chains.length>0 && Math.random()>0.4) {
      const ce = chains[Math.floor(Math.random()*chains.length)];
      room.board = applyMove(room.board, lr, lc, ce);
      lr=ce.r; lc=ce.c;
      chains = getEatMoves(room.board, lr, lc);
    }
    room.lastMove.toR=lr; room.lastMove.toC=lc;
  }

  // Check win
  const wc=countRocks(room.board,'W'), bc=countRocks(room.board,'B');
  if (wc<=1||bc<=1) {
    room.gameOver=true;
    broadcastRoom(room);
    io.to(room.id).emit('gameOver', { winner: wc>1?'W':'B' });
    return;
  }

  endAiTurn(room);
}

function endAiTurn(room) {
  room.chainMode=false; room.chainRock=null;
  room.currentPlayer = room.currentPlayer==='W'?'B':'W';
  broadcastRoom(room);

  // If next turn is also AI, schedule again
  if (room.aiControlling === room.currentPlayer) {
    scheduleAiMove(room);
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`ROCKS server on port ${PORT}`));
