# ROCKS Game — Deployment Guide

## Folder Structure

```
rocks-game/
├── package.json
├── server/
│   └── server.js        ← Node.js + Socket.IO backend
├── public/
│   └── index.html       ← Full game frontend
└── README.md
```

---

## Local Development

### 1. Install dependencies
```bash
cd rocks-game
npm install
```

### 2. Run the server
```bash
npm start
# or for auto-reload during development:
npm run dev
```

### 3. Open the game
Visit: http://localhost:3000

---

## Deploy Backend to Render (Free)

1. Push your project to a GitHub repository

2. Go to https://render.com and sign up / log in

3. Click **New → Web Service**

4. Connect your GitHub repo

5. Configure:
   - **Name:** rocks-game
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Plan:** Free

6. Click **Create Web Service**

7. Wait for deploy. You'll get a URL like:
   `https://rocks-game-xxxx.onrender.com`

---

## Deploy Frontend to Netlify (Optional for static fallback)

> Note: For online multiplayer, the Node.js server on Render serves everything.
> Netlify is only needed if you want the offline modes hosted separately.

1. Go to https://netlify.com

2. Drag and drop the `public/` folder onto the Netlify dashboard

3. Done — you'll get a URL like `https://rocks-game.netlify.app`

> For online multiplayer on Netlify, you'd need to update the socket.io
> connection URL in index.html to point to your Render server:
> Change: `socket = io();`
> To: `socket = io('https://your-render-url.onrender.com');`

---

## Environment Variables

| Variable | Default | Description          |
|----------|---------|----------------------|
| PORT     | 3000    | Server port          |

---

## Game Modes

| Mode              | Description                              | Internet Required |
|-------------------|------------------------------------------|-------------------|
| VS AI             | Single player vs AI (Easy/Hard/Legend)   | No                |
| 2 Players Offline | Two players, same device, pass & play    | No                |
| Online Multiplayer| Two players online, real-time            | Yes               |

---

## Online Multiplayer — How It Works

1. Player 1 clicks **Online Multiplayer → Create Room**
2. A 6-character room code appears (e.g. `AB3X7K`)
3. Share the code with Player 2
4. Player 2 enters the code and clicks **JOIN**
5. Game starts automatically — moves are synchronized in real time
6. Server validates all moves to prevent cheating
7. If a player disconnects, the opponent is notified

---

Powered by **JK Technology**
