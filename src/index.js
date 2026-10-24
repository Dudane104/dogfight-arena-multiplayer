import { DurableObject } from "cloudflare:workers";

export class DogfightRoom extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.ctx=ctx; }
  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("WebSocket required",{status:426});
    const pair=new WebSocketPair(); const [client,server]=Object.values(pair);
    const existing=this.ctx.getWebSockets();
    if(existing.length>=4) return new Response("Room full",{status:409});
    const id=crypto.randomUUID(); const slot=[0,1,2,3].find(s=>!existing.some(w=>{try{return w.deserializeAttachment()?.slot===s}catch{return false}}));
    const host=existing.length===0;
    server.serializeAttachment({id,slot,host});
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({type:"welcome",id,slot,host}));
    this.broadcastLobby();
    return new Response(null,{status:101,webSocket:client});
  }
  broadcast(obj){const s=JSON.stringify(obj);for(const ws of this.ctx.getWebSockets())try{ws.send(s)}catch{}}
  broadcastLobby(){
    const players=this.ctx.getWebSockets().map(ws=>{const a=ws.deserializeAttachment()||{};return {id:a.id,slot:a.slot,host:!!a.host}});
    this.broadcast({type:"lobby",players});
  }
  async webSocketMessage(ws,msg){
    let m;try{m=JSON.parse(typeof msg==="string"?msg:new TextDecoder().decode(msg))}catch{return}
    const a=ws.deserializeAttachment()||{};
    if(m.type==="input") this.broadcast({type:"input",slot:a.slot,l:!!m.l,r:!!m.r,f:!!m.f});
    if(m.type==="start"&&a.host) this.broadcast({type:"start",count:this.ctx.getWebSockets().length});
  }
  async webSocketClose(ws){try{ws.close(1000,"bye")}catch{};this.broadcastLobby()}
}

export default {
  async fetch(request,env){
    const u=new URL(request.url);
    const m=u.pathname.match(/^\/room\/([A-Z0-9]{5})$/i);
    if(!m) return new Response("Dogfight Arena multiplayer service");
    const id=env.DOGFIGHT_ROOMS.idFromName(m[1].toUpperCase());
    return env.DOGFIGHT_ROOMS.get(id).fetch(request);
  }
};
