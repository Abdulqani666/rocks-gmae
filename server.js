const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(express.static(path.join(__dirname, '/public')));

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
  const roomId = String(Math.floor(100000 + Math.random() * 900000));
  const room = {
    id: roomId,
    players: { W: hostSocketId, B: null },
    spectators: [],
    board: initBoardState(),
    currentPlayer: 'W',
    isFirstMove: true,
    forcedRetaliation: false,
    retaliationTarget: null,
    chainMode: false,
    chainRock: null,
    lastMove: null,
    gameOver: false,
    createdAt: Date.now(),
    undoStack: [],
    undoCount: { W: 1, B: 1 },
    pendingUndo: null,
    rematchRequest: null
  };
  rooms.set(roomId, room);
  return room;
}

function snapshotRoom(room) {
  return {
    board: room.board.map(r => [...r]),
    currentPlayer: room.currentPlayer,
    isFirstMove: room.isFirstMove,
    forcedRetaliation: room.forcedRetaliation,
    retaliationTarget: room.retaliationTarget ? {...room.retaliationTarget} : null,
    chainMode: room.chainMode,
    chainRock: room.chainRock ? {...room.chainRock} : null,
    lastMove: room.lastMove ? {...room.lastMove} : null,
    undoCount: {...room.undoCount}
  };
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
    gameOver: room.gameOver,
    players: { W: !!room.players.W, B: !!room.players.B },
    undoCount: room.undoCount,
    spectatorCount: room.spectators ? room.spectators.length : 0
  };
  io.to(room.id).emit('gameState', state);
  if (room.spectators) room.spectators.forEach(sid => io.to(sid).emit('gameState', state));
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
    if (room.players.B) {
      if (!room.spectators) room.spectators = [];
      room.spectators.push(socket.id);
      socket.join(room.id);
      socket.emit('joinedAsSpectator', { roomId: room.id });
      broadcastRoom(room);
      return;
    }
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
    room.undoStack.push(snapshotRoom(room));
    if (room.undoStack.length > 10) room.undoStack.shift();
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
  });

  socket.on('stopChain', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    room.chainMode = false; room.chainRock = null;
    room.currentPlayer = room.currentPlayer === 'W' ? 'B' : 'W';
    broadcastRoom(room);
  });

  socket.on('requestRematch', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const color = room.players.W === socket.id ? 'W' : 'B';
    const opponent = color === 'W' ? 'B' : 'W';
    room.rematchRequest = { requestedBy: color };
    if (room.players[opponent]) {
      io.to(room.players[opponent]).emit('rematchRequested', { by: color });
    } else {
      doRematch(room);
    }
  });

  socket.on('acceptRematch', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || !room.rematchRequest) return;
    room.rematchRequest = null;
    doRematch(room);
  });

  socket.on('declineRematch', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const color = room.players.W === socket.id ? 'W' : 'B';
    const requester = room.rematchRequest ? room.rematchRequest.requestedBy : null;
    room.rematchRequest = null;
    if (requester && room.players[requester]) {
      io.to(room.players[requester]).emit('rematchDeclined');
    }
  });

  socket.on('requestUndo', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.gameOver) return;
    const color = room.players.W === socket.id ? 'W' : 'B';
    if (room.undoCount[color] <= 0) { socket.emit('undoError', 'No undos remaining.'); return; }
    if (room.undoStack.length === 0) { socket.emit('undoError', 'Nothing to undo.'); return; }
    if (room.pendingUndo) { socket.emit('undoError', 'Undo already pending.'); return; }
    const justMoved = color === 'W' ? room.currentPlayer === 'B' : room.currentPlayer === 'W';
    if (!justMoved) { socket.emit('undoError', 'You can only undo your own last move.'); return; }
    applyUndo(room, color);
  });

  socket.on('acceptUndo', () => {});
  socket.on('declineUndo', () => {});

  socket.on('rejoinRoom', ({ roomId, color }) => {
    const room = rooms.get(roomId);
    if (!room) { socket.emit('roomExpired', { roomId }); return; }

    room.players[color] = socket.id;
    room.aiControlling = null;

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
      if (room.spectators) {
        const si = room.spectators.indexOf(socket.id);
        if (si !== -1) { room.spectators.splice(si, 1); broadcastRoom(room); continue; }
      }
      const color = room.players.W === socket.id ? 'W'
                  : room.players.B === socket.id ? 'B' : null;
      if (!color) continue;

      room.players[color] = null;
      if (!room.disconnectTimers) room.disconnectTimers = {};
      if (!room.aiControlling) room.aiControlling = null;

      io.to(id).emit('opponentDisconnected', { color });

      room.disconnectTimers[color] = setTimeout(() => {
        if (!room.players[color]) {
          room.gameOver = true;
          io.to(id).emit('opponentLeft', { color });
          console.log(`Player ${color} never rejoined room ${id} — game ended`);
        }
      }, 5 * 60 * 1000);
    }
  });
});

// ---- SERVER DEPLOYMENT FIXED ----
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`ROCKS server on port ${PORT}`));

// ---- HELPERS ----
function doRematch(room) {
  room.board = initBoardState();
  room.currentPlayer = 'W'; room.isFirstMove = true;
  room.forcedRetaliation = false; room.retaliationTarget = null;
  room.chainMode = false; room.chainRock = null;
  room.lastMove = null; room.gameOver = false;
  room.aiControlling = null;
  room.undoStack = [];
  room.undoCount = { W: 1, B: 1 };
  room.pendingUndo = null;
  room.rematchRequest = null;
  room.createdAt = Date.now();
  broadcastRoom(room);
  io.to(room.id).emit('rematchStarted');
}

function applyUndo(room, color) {
  if (room.undoStack.length === 0) return;
  const snap = room.undoStack.pop();
  room.board          = snap.board.map(r => [...r]);
  room.currentPlayer  = snap.currentPlayer;
  room.isFirstMove    = snap.isFirstMove;
  room.forcedRetaliation = snap.forcedRetaliation;
  room.retaliationTarget = snap.retaliationTarget;
  room.chainMode      = snap.chainMode;
  room.chainRock      = snap.chainRock;
  room.lastMove       = snap.lastMove;
  room.undoCount[color]--;
  broadcastRoom(room);
  io.to(room.id).emit('undoApplied', { by: color, remaining: room.undoCount });
}
