import * as http from "http";
import * as fs from "fs";
import * as WebSocket from "ws";
import * as yaml from "js-yaml";

const serverNodeID = 0; // Server always has node ID 0

// Use "No Server" mode to create two WebSocket servers on single HTTP server
//  https://github.com/websockets/ws/tree/d09daaf67c282e301eeebe21797215ddffd819c5#multiple-servers-sharing-a-single-https-server

class Session {
  wssForServer: WebSocket.Server;
  wssForClient: WebSocket.Server;
  serverWS: WebSocket | null;
  clients: Map<number, WebSocket>;
  nextNodeID: number;

  iceServerUrl: string;

  constructor(iceServerUrl: string) {
    this.iceServerUrl = iceServerUrl;

    this.wssForServer = new WebSocket.Server({ noServer: true });
    this.wssForClient = new WebSocket.Server({ noServer: true });

    this.serverWS = null;
    this.clients = new Map<number, WebSocket>();
    this.nextNodeID = serverNodeID + 1; // Client node ID start from 0
  }

  start() {
    // Note: To pass a method as callback, "bind" is required.
    //  http://dqn.sakusakutto.jp/2012/05/javascript_bind_this_callback_method.html
    //  https://developer.mozilla.org/ja/docs/Web/JavaScript/Reference/Global_Objects/Function/bind
    this.wssForServer.on('connection', this.handleServerConnection.bind(this));
    this.wssForClient.on('connection', this.handleClientConnection.bind(this));
  }

  handleServerConnection(ws: WebSocket) {
    if (this.serverWS !== null) {
      // only one server can connect
      console.log('Server is already connected!');
      ws.send(JSON.stringify({ type: 'error' }));
      return;
    }

    console.log('Server connected');
    this.serverWS = ws;

    ws.on('message', this.handleServerMessage.bind(this));
    ws.on('close', (code, reason) => {
      console.log('Server disconnected');
      this.serverWS = null;
    });

    // Server has always node ID 0
    ws.send(JSON.stringify({ type: 'hello', nodeID: serverNodeID, iceServerUrl: iceServerUrl }));
  }

  handleServerMessage(data: string) {
    console.log(`From server: ${data}`);
    try {
      const { nodeID: nodeID, ...rest } = JSON.parse(data);
      if (this.clients.has(nodeID)) {
        this.clients.get(nodeID)?.send(JSON.stringify(rest));
      } else {
        console.log(`Client ${nodeID} not found`);
      }
    } catch (e) {
      console.log(`Invalid message from server: ${e}`);
    }
  }
  
  handleClientConnection(ws: WebSocket) {
    if (this.serverWS === null) {
      // no server
      console.log('Server is not ready!');
      ws.send(JSON.stringify({ type: 'error' }));
      return;
    }

    // Assign node ID to the new client
    const nodeID = this.nextNodeID;
    this.clients.set(nodeID, ws);
    this.nextNodeID++;

    console.log(`Client ${nodeID} connected`);

    ws.send(JSON.stringify({ type: 'hello', nodeID: nodeID, iceServerUrl: this.iceServerUrl }));

    this.serverWS.send(JSON.stringify({ type: 'clientConnected', nodeID: nodeID }));

    ws.on('message', (data) => this.handleClientMessage(nodeID, data.toString()));
    ws.on('close', (code, reason) => {
      this.clients.delete(nodeID);
      console.log(`Client ${nodeID} disconnected`);
    });
  }

  handleClientMessage(nodeID: number, data: string) {
    console.log(`From client ${nodeID}: ${data}`);
    try {
      const msg = JSON.parse(data);
      if (msg["nodeID"] !== undefined) {
        console.log(`Warning: message from client ${nodeID} already have nodeID ${msg["nodeID"]}. Rewriting to actual nodeID.`);
      }
      msg["nodeID"] = nodeID;
      this.serverWS?.send(JSON.stringify(msg));
    } catch (e) {
      console.log(`Invalid message from client ${nodeID}: ${e}`);
    }
  }
}

// Load settings from YAML
const configText = fs.readFileSync("config.yml", { "encoding": "utf-8" });
const config: any = yaml.safeLoad(configText);
// TODO: type and error check
const host = config["host"] as string;
const port = config["port"] as number;
const pathForServer = config["pathForServer"] as string;
const pathForClient = config["pathForClient"] as string;
const iceServerUrl = config["iceServerUrl"] as string;

const httpServer = new http.Server();

const session = new Session(iceServerUrl);
session.start();

httpServer.on('upgrade', (req, sock, head) => {
  // HTTP UPGRADE
  //  https://nodejs.org/api/http.html#http_event_upgrade_1
  //  https://github.com/websockets/ws/blob/0954abcebe027aa10eb4cb203fc717291e1b3dbd/doc/ws.md#serverhandleupgraderequest-socket-head-callback
  // Note: "connection" event have to be called manually!
  //  https://github.com/websockets/ws/tree/d09daaf67c282e301eeebe21797215ddffd819c5#multiple-servers-sharing-a-single-https-server
  // Switch by requested path (does not work with reverse proxy)
  if (req.url === "/" + pathForServer) {
    session.wssForServer.handleUpgrade(req, sock, head, (ws) => {
      session.wssForServer.emit('connection', ws, req);
    });
  } else if (req.url === "/" + pathForClient) {
    session.wssForClient.handleUpgrade(req, sock, head, (ws) => {
      session.wssForClient.emit('connection', ws, req);
    });
  }
});

httpServer.listen(port, host);

console.log(`Server: ws://${host}:${port}/${pathForServer}`);
console.log(`Client: ws://${host}:${port}/${pathForClient}`);