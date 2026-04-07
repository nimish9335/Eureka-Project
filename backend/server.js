const express = require('express');
const cors = require('cors');
const zmq = require('zeromq');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// ZeroMQ PUSH socket - sends results back to AutoCAD plugin
let pushSock;
async function startPushSocket() {
  pushSock = new zmq.Push();
  await pushSock.bind('tcp://127.0.0.1:5556');
  console.log('ZeroMQ PUSH ready on port 5556');
}

// Start ZeroMQ listener
require('./zeromq-listener');

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// POST /validate endpoint
app.post('/validate', (req, res) => {
  res.json({ status: 'ok', violations: [] });
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, async () => {
  await startPushSocket();
  console.log(`Backend running on port ${PORT}`);
});