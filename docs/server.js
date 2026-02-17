const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const http = createServer(app);
const io = new Server(http, { cors: { origin: '*' } });

// Generate a secret + socketId pair on startup
const SECRET = crypto.randomBytes(16).toString('hex');
const SOCKET_ID = crypto.randomBytes(8).toString('hex');

// Serve speaker.html with multiplex config injected
app.get('/speaker.html', (_req, res) => {
  const html = fs.readFileSync(path.join(__dirname, 'speaker.html'), 'utf-8');
  const inject = `<script>window.MULTIPLEX_SECRET="${SECRET}";window.MULTIPLEX_ID="${SOCKET_ID}";</script>`;
  res.type('html').send(html.replace('</head>', inject + '\n</head>'));
});

// Serve index.html (audience) with socketId only — but not for embedded iframes
app.get(['/', '/index.html'], (req, res) => {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8');
  // If loaded as embedded iframe from speaker view, skip multiplex to avoid loops
  if (req.query.embedded) {
    res.type('html').send(html);
  } else {
    const inject = `<script>window.MULTIPLEX_ID="${SOCKET_ID}";</script>`;
    res.type('html').send(html.replace('</head>', inject + '\n</head>'));
  }
});

// Serve other static files
app.use(express.static(path.join(__dirname)));

// Token endpoint
app.get('/token', (_req, res) => {
  res.json({ secret: SECRET, socketId: SOCKET_ID });
});

// Socket.io multiplex relay
io.on('connection', (socket) => {
  socket.on('multiplex-statechanged', (data) => {
    if (data.secret === SECRET) {
      socket.broadcast.emit(data.socketId, data);
    }
  });
});

// Find local IP
const nets = require('os').networkInterfaces();
let localIP = 'localhost';
for (const iface of Object.values(nets)) {
  for (const cfg of iface) {
    if (cfg.family === 'IPv4' && !cfg.internal) {
      localIP = cfg.address;
      break;
    }
  }
}

const PORT = 8080;
http.listen(PORT, '0.0.0.0', () => {
  console.log('\n=== Mu Presentation — Multiplex Server ===\n');
  console.log(`  Audience (projector):  http://${localIP}:${PORT}/`);
  console.log(`  Speaker  (iPad):      http://${localIP}:${PORT}/speaker.html`);
  console.log(`\n  iPad: tap Previous/Next or swipe on the notes area.`);
  console.log(`  The projector follows automatically.\n`);
});
