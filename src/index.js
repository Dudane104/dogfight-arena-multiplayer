import { DurableObject } from "cloudflare:workers";

const WORLD_W = 1600;
const GROUND = 790;
const RUNWAY_LEFT = 48;
const RUNWAY_RIGHT = 1552;
const STARTS = [
  { x: 120,  y: 755, a: 0,       face: 1 },
  { x: 1480, y: 755, a: Math.PI, face: -1 },
  { x: 560,  y: 755, a: Math.PI, face: -1 },
  { x: 1040, y: 755, a: 0,       face: 1 }
];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const angle = a => Math.atan2(Math.sin(a), Math.cos(a));

export class DogfightRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.players = new Map();
    this.bullets = [];
    this.running = false;
    this.lastTick = Date.now();
    this.timer = null;
    this.winner = null;
    this.allowOverheat = true;
    this.tickId = 0;
  }

  makePlayer(slot) {
    const s = STARTS[slot];
    return {
      slot,
      x: s.x, y: s.y, a: s.a, face: s.face,
      v: 0, grounded: true, alive: true,
      lives: 3, hp: 4, spawn: 1.6,
      input: { l: false, r: false, f: false }, lastSeq: -1,
      fireCD: 0, heat: 0, over: false
    };
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Dogfight Arena multiplayer V16", { status: 200 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const sockets = this.ctx.getWebSockets();

    if (sockets.length >= 4) return new Response("Room full", { status: 409 });

    const used = new Set(sockets.map(w => w.deserializeAttachment()?.slot));
    const slot = [0,1,2,3].find(n => !used.has(n));
    const id = crypto.randomUUID();
    const host = sockets.length === 0;

    server.serializeAttachment({ id, slot, host });
    this.ctx.acceptWebSocket(server);
    this.players.set(slot, this.makePlayer(slot));

    server.send(JSON.stringify({ type: "welcome", id, slot, host, serverVersion: 16 }));
    this.broadcastLobby();

    return new Response(null, { status: 101, webSocket: client });
  }

  broadcast(message) {
    const data = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(data); } catch {}
    }
  }

  broadcastLobby() {
    const players = this.ctx.getWebSockets().map(ws => {
      const a = ws.deserializeAttachment();
      return { id: a.id, slot: a.slot, host: a.host };
    });
    this.broadcast({ type: "lobby", players, serverVersion: 16, rules: { overheat: this.allowOverheat } });
  }

  startMatch() {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length < 2) return;

    this.bullets = [];
    this.winner = null;
    this.players.clear();

    for (const ws of sockets) {
      const a = ws.deserializeAttachment();
      this.players.set(a.slot, this.makePlayer(a.slot));
    }

    this.running = true;
    this.lastTick = Date.now();

    this.broadcast({
      type: "start",
      count: sockets.length,
      slots: sockets.map(ws => ws.deserializeAttachment().slot),
      serverVersion: 16,
      rules: { overheat: this.allowOverheat }
    });

    // 30 Hz authoritative simulation/snapshots for smoother phones/tablets.
    if (!this.timer) this.timer = setInterval(() => this.tick(), 33);
  }

  tick() {
    if (!this.running) return;
    this.tickId++;

    const now = Date.now();
    const dt = clamp((now - this.lastTick) / 1000, 0.015, 0.055);
    this.lastTick = now;

    for (const p of this.players.values()) this.stepPlayer(p, dt);

    // Same mid-air collision rule as offline.
    const aircraft=[...this.players.values()];
    for(let i=0;i<aircraft.length;i++)for(let j=i+1;j<aircraft.length;j++){
      const a=aircraft[i],b=aircraft[j];
      if(a.alive&&b.alive&&!a.grounded&&!b.grounded&&a.spawn<=0&&b.spawn<=0&&Math.hypot(a.x-b.x,a.y-b.y)<42){
        this.killPlayer(a);this.killPlayer(b);
      }
    }

    for (const b of this.bullets) {
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.life -= dt;

      for (const p of this.players.values()) {
        if (!p.alive || p.slot === b.owner || p.spawn > 0) continue;
        if (Math.hypot(p.x - b.x, p.y - b.y) < 28) {
          b.life = 0;
          p.hp--;
          if (p.hp <= 0) this.killPlayer(p);
          break;
        }
      }
    }

    this.bullets = this.bullets.filter(
      b => b.life > 0 && b.x > -100 && b.x < WORLD_W + 100 && b.y > -100 && b.y < 1000
    );

    const contenders = [...this.players.values()].filter(p => p.alive || p.lives > 0);
    if (contenders.length <= 1 && this.players.size > 1) {
      this.running = false;
      this.winner = contenders[0]?.slot ?? 0;
    }

    this.broadcast({
      type: "snapshot", serverVersion: 16, tick: this.tickId,
      players: [...this.players.values()].map(p => ({
        slot: p.slot, x: p.x, y: p.y, a: p.a, v: p.v,
        grounded: p.grounded, alive: p.alive,
        lives: p.lives, hp: p.hp, spawn: p.spawn,
        heat: p.heat, over: p.over, lastSeq: p.lastSeq
      })),
      bullets: this.bullets.map(b => ({
        x: b.x, y: b.y, vx: b.vx, vy: b.vy, owner: b.owner
      })),
      winner: this.winner
    });
  }

  stepPlayer(p, dt) {
    if (!p.alive) return;

    const I = p.input;
    const turn = 2.25;
    p.fireCD -= dt;
    if (!p.grounded) p.spawn = Math.max(0, p.spawn - dt);

    if (p.grounded) {
      p.v = Math.min(250, p.v + 175 * dt);
      p.x += p.face * p.v * dt;

      const liftInput = p.face === 1 ? I.l : I.r;
      // Multiplayer safety: if a player forgets to rotate for takeoff, gently force
      // the nose up before the runway ends rather than letting the aircraft vanish.
      const nearRunwayEnd = (p.face === 1 && p.x > RUNWAY_RIGHT - 210) ||
                            (p.face === -1 && p.x < RUNWAY_LEFT + 210);
      const lift = liftInput || nearRunwayEnd;
      if (lift && p.v > 72) {
        const target = p.face === 1 ? -0.42 : Math.PI + 0.42;
        const err = angle(target - p.a);
        p.a += Math.sign(err) * Math.min(Math.abs(err), turn * (nearRunwayEnd ? 1.18 : 0.72) * dt);
      }

      if (p.v > 150 && Math.sin(p.a) < -0.16) {
        p.grounded = false;
        p.y = GROUND - 38;
        p.v = 270;
      }

      // Absolute failsafe: a grounded aircraft can never leave the playable arena.
      if (p.grounded && (p.x < RUNWAY_LEFT || p.x > RUNWAY_RIGHT)) {
        p.x = clamp(p.x, RUNWAY_LEFT, RUNWAY_RIGHT);
        p.v = 0;
      }
    } else {
      if (I.l) p.a -= turn * dt;
      if (I.r) p.a += turn * dt;

      p.v += (300 - p.v) * 1.4 * dt;
      p.x += Math.cos(p.a) * p.v * dt;
      p.y += Math.sin(p.a) * p.v * dt;

      if (p.x < -55) p.x = WORLD_W + 55;
      if (p.x > WORLD_W + 55) p.x = -55;

      if (p.y < 50) {
        p.y = 50;
        if (Math.sin(p.a) < 0) p.a += 0.6;
      }

      // Tower is intentionally NOT a collision object in V9.
      // Aircraft are drawn in front of it on the client.
      if (p.y > GROUND - 20) { this.killPlayer(p); return; }
    }

    if (!this.allowOverheat) {
      p.over = false;
      p.heat = 0;
    } else if (p.over) {
      p.heat = Math.max(0, p.heat - 0.62 * dt);
      if (p.heat <= 0.03) {
        p.heat = 0;
        p.over = false;
      }
    } else if (!I.f) {
      p.heat = Math.max(0, p.heat - 0.48 * dt);
    }

    if (I.f && !p.over && p.fireCD <= 0 && !p.grounded) {
      p.fireCD = 0.225;
      if (this.allowOverheat) p.heat += 0.155;

      this.bullets.push({
        x: p.x + Math.cos(p.a) * 35,
        y: p.y + Math.sin(p.a) * 35,
        vx: Math.cos(p.a) * 720,
        vy: Math.sin(p.a) * 720,
        life: 1.15,
        owner: p.slot
      });

      if (this.allowOverheat && p.heat >= 1) {
        p.heat = 1;
        p.over = true;
        p.fireCD = 1.55;
      }
    }
  }

  killPlayer(p) {
    if (!p.alive) return;
    p.alive = false;
    p.lives--;

    if (p.lives > 0) {
      const slot = p.slot;
      const lives = p.lives;
      setTimeout(() => {
        const fresh = this.makePlayer(slot);
        fresh.lives = lives;
        this.players.set(slot, fresh);
      }, 1700);
    }
  }

  async webSocketMessage(ws, raw) {
    let message;
    try {
      message = JSON.parse(
        typeof raw === "string" ? raw : new TextDecoder().decode(raw)
      );
    } catch {
      return;
    }

    const attachment = ws.deserializeAttachment();
    const p = this.players.get(attachment.slot);

    if (message.type === "input" && p) {
      const seq = Number.isFinite(message.seq) ? message.seq : ((p.lastSeq ?? -1) + 1);
      if (seq >= (p.lastSeq ?? -1)) {
        p.lastSeq = seq;
        p.input = { l: !!message.l, r: !!message.r, f: !!message.f };
      }
    }

    if (message.type === "rules" && attachment.host) {
      this.allowOverheat = message.rules?.overheat !== false;
      this.broadcastLobby();
    }

    if ((message.type === "start" || message.type === "rematch") && attachment.host) {
      const sockets = this.ctx.getWebSockets();
      if (sockets.length < 2) {
        try { ws.send(JSON.stringify({type:"start_error", message:"Need at least 2 connected players", serverVersion:16})); } catch {}
        return;
      }
      this.allowOverheat = message.rules?.overheat !== false;
      this.startMatch();
    }

    if (message.type === "ping") {
      try {
        ws.send(JSON.stringify({
          type: "pong",
          clientTime: message.clientTime,
          serverVersion: 16
        }));
      } catch {}
    }
  }

  async webSocketClose(ws) {
    const a = ws.deserializeAttachment();
    this.players.delete(a?.slot);
    this.broadcastLobby();

    if (this.ctx.getWebSockets().length === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.running = false;
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/room\/([A-Z0-9]{5})$/i);

    if (!match) return new Response("Dogfight Arena multiplayer V16");

    const id = env.DOGFIGHT_ROOMS.idFromName(match[1].toUpperCase());
    return env.DOGFIGHT_ROOMS.get(id).fetch(request);
  }
};
