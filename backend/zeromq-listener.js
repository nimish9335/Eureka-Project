const zmq = require('zeromq');

async function startZMQ() {
  const pullSock = new zmq.Pull();
  await pullSock.bind('tcp://127.0.0.1:5555');
  console.log('ZeroMQ PULL ready on port 5555');

  for await (const [msg] of pullSock) {
    const entity = JSON.parse(msg.toString());
    console.log('Received from AutoCAD:', entity);
  }
}

startZMQ();
module.exports = { startZMQ };