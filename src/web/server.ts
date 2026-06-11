/**
 * Web server for Skyloom — HTTP API + 水墨气象台 chat UI.
 */

import { createServer, IncomingMessage, ServerResponse } from "http";
import { createSystemContext } from "../core/factory";
import { getLogger } from "../core/logger";

const log = getLogger("web-server");

/* ── Agent personalities: pigment + atmosphere + motion ── */
const PIGMENTS: Record<string, {
  color: string; nameZH: string; kanji: string; poem: string;
  ambient: string;   // CSS for ambient layer
  msgStyle: string;  // CSS for message treatment
  dotPulse: string;  // animation name for dot
  kanjiAnim: string; // kanji decoration animation
}> = {
  fog: {
    color: "#4a4a44", nameZH: "松烟墨", kanji: "霧",
    poem: "山色有无中",
    ambient: `background:radial-gradient(ellipse at 30% 60%,rgba(180,175,165,.18) 0%,transparent 70%),
                        radial-gradient(ellipse at 70% 30%,rgba(190,185,175,.10) 0%,transparent 55%);`,
    msgStyle: `border-style:dashed;border-color:rgba(140,135,125,.25);`,
    dotPulse: "fog-pulse", kanjiAnim: "fog-drift",
  },
  rain: {
    color: "#2a5c8a", nameZH: "石青", kanji: "雨",
    poem: "一蓑烟雨任平生",
    ambient: `background:radial-gradient(ellipse at 50% 20%,rgba(42,92,138,.10) 0%,transparent 50%),
                        repeating-linear-gradient(175deg,transparent,transparent 3px,rgba(42,92,138,.02) 3px,rgba(42,92,138,.02) 6px);`,
    msgStyle: `border-style:solid;border-color:rgba(42,92,138,.18);box-shadow:inset 0 -1px 0 rgba(42,92,138,.06);`,
    dotPulse: "rain-ripple", kanjiAnim: "rain-fall",
  },
  frost: {
    color: "#3a7a6e", nameZH: "石绿", kanji: "霜",
    poem: "月落乌啼霜满天",
    ambient: `background:radial-gradient(ellipse at 60% 40%,rgba(58,122,110,.09) 0%,transparent 55%),
                        conic-gradient(from 0deg at 75% 25%,transparent 0deg,rgba(58,122,110,.03) 2deg,transparent 4deg,transparent 180deg);`,
    msgStyle: `border-style:solid;border-color:rgba(58,122,110,.20);border-radius:2px 8px 8px 2px;`,
    dotPulse: "frost-glint", kanjiAnim: "frost-sparkle",
  },
  snow: {
    color: "#8a8a82", nameZH: "铅白", kanji: "雪",
    poem: "千树万树梨花开",
    ambient: `background:radial-gradient(circle at 25% 70%,rgba(210,208,200,.10) 0%,transparent 50%),
                        radial-gradient(circle at 80% 35%,rgba(220,218,210,.07) 0%,transparent 45%);`,
    msgStyle: `border-style:solid;border-color:rgba(180,178,170,.15);border-radius:8px 8px 8px 2px;`,
    dotPulse: "snow-float", kanjiAnim: "snow-fall",
  },
  dew: {
    color: "#8b6914", nameZH: "赭石", kanji: "露",
    poem: "金风玉露一相逢",
    ambient: `background:radial-gradient(ellipse at 50% 90%,rgba(139,105,20,.08) 0%,transparent 55%),
                        radial-gradient(ellipse at 80% 95%,rgba(139,105,20,.04) 0%,transparent 40%);`,
    msgStyle: `border-style:solid;border-color:rgba(139,105,20,.22);border-width:0 0 2px 2px;`,
    dotPulse: "dew-bead", kanjiAnim: "dew-still",
  },
  fair: {
    color: "#b3342d", nameZH: "朱砂", kanji: "晴",
    poem: "道是无晴却有晴",
    ambient: `background:radial-gradient(ellipse at 80% 15%,rgba(179,52,45,.12) 0%,transparent 60%),
                        radial-gradient(ellipse at 30% 40%,rgba(200,100,50,.05) 0%,transparent 50%);`,
    msgStyle: `border-style:solid;border-color:rgba(179,52,45,.20);box-shadow:0 0 1px rgba(179,52,45,.04);`,
    dotPulse: "fair-glow", kanjiAnim: "fair-warm",
  },
};

/* ──────────────────────────────────────────────
   Server
   ────────────────────────────────────────────── */
export async function startWebServer(port: number = 3000): Promise<void> {
  const ctx = createSystemContext();

  // Bind to loopback by default: the chat API drives the agent (and its tools)
  // with no authentication, so it must not be exposed to the network unless the
  // operator explicitly opts in via SKYLOOM_WEB_HOST=0.0.0.0.
  const host = process.env.SKYLOOM_WEB_HOST || "127.0.0.1";
  const loopbackOnly = host === "127.0.0.1" || host === "localhost" || host === "::1";

  // Reject cross-origin / rebound Host headers when bound to loopback. Without
  // this, a malicious web page could POST to http://localhost:<port>/api/chat
  // from the victim's browser and execute agent tools (CORS does not block the
  // side effect, only the response read).
  const hostAllowed = (h: string | undefined): boolean => {
    if (!loopbackOnly) return true;
    const name = (h || "").split(":")[0].toLowerCase();
    return name === "localhost" || name === "127.0.0.1" || name === "[::1]" || name === "::1" || name === "";
  };

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (!hostAllowed(req.headers.host)) {
      res.writeHead(403, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Forbidden host" }));
      return;
    }
    // Same-origin only when loopback-bound (no wildcard CORS that would invite
    // cross-site requests to a credential-less, tool-executing endpoint).
    if (loopbackOnly) {
      res.setHeader("Access-Control-Allow-Origin", `http://${req.headers.host || `localhost:${port}`}`);
      res.setHeader("Vary", "Origin");
    } else {
      res.setHeader("Access-Control-Allow-Origin", "*");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    try {
      if (url.pathname === "/api/chat" && req.method === "POST") await handleChat(req, res, ctx);
      else if (url.pathname === "/api/agents" && req.method === "GET") handleAgents(res, ctx);
      else if (url.pathname === "/api/status" && req.method === "GET") handleStatus(res, ctx);
      else if (url.pathname.startsWith("/api/")) res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Not found" }));
      else serveInkWashUI(res);
    } catch (e) { res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: String(e) })); }
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const shown = loopbackOnly ? "localhost" : host;
      console.log(`\n  水墨气象台  ·  Skyloom\n  http://${shown}:${port}${loopbackOnly ? "  (仅本机 · 设 SKYLOOM_WEB_HOST=0.0.0.0 可对外开放)" : "  ⚠ 已对外开放 · 无鉴权"}\n`);
      resolve();
    });
  });
}

async function handleChat(req: IncomingMessage, res: ServerResponse, ctx: ReturnType<typeof createSystemContext>) {
  const buffers: Buffer[] = [];
  for await (const chunk of req) buffers.push(chunk as Buffer);
  const { message, agent: agentName = "fog" } = JSON.parse(Buffer.concat(buffers).toString("utf-8"));
  if (!message) { res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "message is required" })); return; }
  const agent = ctx.agentMap.get(agentName);
  if (!agent) { res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: `Agent '${agentName}' not found` })); return; }
  await agent.init();

  // Real streaming over SSE — tokens, reasoning, and tool events as they happen.
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (ev: Record<string, unknown>) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  try {
    for await (const ev of agent.chatStream(message)) send(ev as Record<string, unknown>);
  } catch (e) {
    send({ type: "error", text: String(e) });
  }
  send({ type: "end" });
  res.end();
}

function handleAgents(res: ServerResponse, ctx: ReturnType<typeof createSystemContext>) {
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
    agents: [...ctx.agentMap.entries()].map(([n, a]) => ({ name: n, displayName: a.displayName, emoji: a.emoji, specialty: a.specialty, state: a.state })),
  }));
}
function handleStatus(res: ServerResponse, ctx: ReturnType<typeof createSystemContext>) {
  const s: Record<string, any> = {}; for (const [n, a] of ctx.agentMap) s[n] = a.getStatus();
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ agents: s, workspace: ctx.workspacePath }));
}

/* ──────────────────────────────────────────────
   水墨气象台 · Ink Wash Weather Station
   ────────────────────────────────────────────── */
function serveInkWashUI(res: ServerResponse): void {
  const html = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>水墨气象台 · Skyloom</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@300;400;600;700&family=Noto+Serif:ital,wght@0,400;0,600;1,400&display=swap" rel="stylesheet">
<style>
/* ═══════════════════════════════════
   水墨气象台 · 全局
   ═══════════════════════════════════ */
:root{
  --paper:#f8f4ec;
  --paper-warm:#f3ede2;
  --paper-edge:rgba(180,160,130,.06);
  --ink-deep:#1a1614;
  --ink-mid:#3d3833;
  --ink-light:#8c8680;
  --ink-faint:#c4bfb8;
  --pigment:#4a4a44;
  --pigment-soft:rgba(74,74,68,.12);
  --pigment-seal:#4a4a44;
  --dot-anim:fog-pulse;
  --kanji-anim:fog-drift;
  --gutter:clamp(24px,5vw,56px);
  --sidebar-w:200px;
}
*,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%;overflow:hidden}
body{
  font-family:'Noto Serif SC','Noto Serif',Georgia,serif;
  background:var(--paper);
  color:var(--ink-deep);
  display:flex;height:100vh;font-weight:400;font-size:16px;line-height:1.8;
  -webkit-font-smoothing:antialiased;
}

/* ── Aged paper texture with vignette edges ── */
#paper-grain{
  position:fixed;inset:0;z-index:0;pointer-events:none;opacity:.28;
  background:
    repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(139,119,90,.02) 2px,rgba(139,119,90,.02) 4px),
    repeating-linear-gradient(90deg,transparent,transparent 3px,rgba(139,119,90,.012) 3px,rgba(139,119,90,.012) 6px),
    linear-gradient(135deg,rgba(80,60,30,.04) 0%,transparent 15%,transparent 85%,rgba(80,60,30,.04) 100%),
    linear-gradient(225deg,rgba(80,60,30,.03) 0%,transparent 10%,transparent 90%,rgba(80,60,30,.03) 100%);
}
/* Ink wash mountain silhouette at top */
#paper-grain::before{
  content:'';position:fixed;top:0;left:0;right:0;height:clamp(80px,12vh,160px);z-index:0;pointer-events:none;opacity:.12;
  background:
    radial-gradient(ellipse 120% 100% at 25% 100%,rgba(60,55,50,.5) 0%,transparent 45%),
    radial-gradient(ellipse 80% 70% at 55% 100%,rgba(50,45,40,.4) 0%,transparent 55%),
    radial-gradient(ellipse 100% 60% at 70% 100%,rgba(70,65,60,.3) 0%,transparent 60%),
    radial-gradient(ellipse 60% 80% at 40% 100%,rgba(55,50,45,.25) 0%,transparent 50%),
    radial-gradient(ellipse 140% 90% at 60% 100%,rgba(65,60,55,.15) 0%,transparent 70%);
  mask:linear-gradient(0deg,transparent 0%,#000 100%);
  -webkit-mask:linear-gradient(0deg,transparent 0%,#000 100%);
}

/* ── Ambient layer — agent-specific atmosphere ── */
#ambient-layer{position:fixed;inset:0;z-index:0;pointer-events:none;opacity:.7;transition:background .8s ease;background:var(--ambient-bg)}

/* ═══════════════════════════════════
   雾 Fog · 松烟墨 · mist particles
   ═══════════════════════════════════ */
.mist-particles{position:absolute;inset:0;overflow:hidden;pointer-events:none}
.mist-particles i{
  position:absolute;border-radius:50%;background:rgba(160,155,145,.10);
  animation:fog-drift var(--dur,8s) linear infinite;
  animation-delay:var(--delay,0s);
  width:var(--w,120px);height:var(--h,40px);left:var(--x,10%);top:var(--y,30%);
  filter:blur(20px);
}
@keyframes fog-drift{0%{transform:translateX(-30px);opacity:.3}50%{transform:translateX(40px);opacity:.7}100%{transform:translateX(-30px);opacity:.3}}

/* ═══════════════════════════════════
   雨 Rain · 石青 · falling streaks
   ═══════════════════════════════════ */
.rain-streaks{position:absolute;inset:0;overflow:hidden;pointer-events:none}
.rain-streaks i{
  position:absolute;width:1px;height:var(--h,40px);
  background:linear-gradient(0deg,rgba(42,92,138,.12),transparent);
  left:var(--x,15%);top:-10%;
  animation:rain-fall var(--dur,1.2s) linear infinite;
  animation-delay:var(--delay,0s);
}
@keyframes rain-fall{0%{transform:translateY(-10vh)}100%{transform:translateY(110vh)}}

/* ═══════════════════════════════════
   霜 Frost · 石绿 · crystalline sparks
   ═══════════════════════════════════ */
.frost-crystals{position:absolute;inset:0;overflow:hidden;pointer-events:none}
.frost-crystals i{
  position:absolute;
  width:var(--w,4px);height:var(--h,4px);
  background:rgba(58,122,110,.15);
  left:var(--x,20%);top:var(--y,30%);
  clip-path:polygon(50% 0%,100% 50%,50% 100%,0% 50%);
  animation:frost-glint var(--dur,3s) ease-in-out infinite;
  animation-delay:var(--delay,0s);
}
@keyframes frost-glint{0%,100%{opacity:.1;transform:scale(.8) rotate(0deg)}50%{opacity:.6;transform:scale(1.4) rotate(45deg)}}

/* ═══════════════════════════════════
   雪 Snow · 铅白 · gentle snowfall
   ═══════════════════════════════════ */
.snow-particles{position:absolute;inset:0;overflow:hidden;pointer-events:none}
.snow-particles i{
  position:absolute;border-radius:50%;background:rgba(190,188,180,.14);
  width:var(--w,6px);height:var(--w,6px);
  left:var(--x,20%);top:-5%;
  animation:snow-fall var(--dur,10s) linear infinite;
  animation-delay:var(--delay,0s);
}
@keyframes snow-fall{0%{transform:translateY(-5vh) translateX(0)}25%{transform:translateY(25vh) translateX(15px)}50%{transform:translateY(50vh) translateX(-10px)}75%{transform:translateY(75vh) translateX(8px)}100%{transform:translateY(110vh) translateX(-5px)}}

/* ═══════════════════════════════════
   露 Dew · 赭石 · morning dew beads
   ═══════════════════════════════════ */
.dew-beads{position:absolute;inset:0;overflow:hidden;pointer-events:none}
.dew-beads i{
  position:absolute;border-radius:50%;
  background:radial-gradient(circle at 40% 35%,rgba(200,170,100,.10),rgba(139,105,20,.06));
  width:var(--w,8px);height:var(--w,8px);
  left:var(--x,25%);bottom:var(--y,15%);
  animation:dew-bead var(--dur,4s) ease-in-out infinite;
  animation-delay:var(--delay,0s);
}
@keyframes dew-bead{0%,100%{opacity:.3;transform:scale(1)}50%{opacity:.7;transform:scale(1.5)}}

/* ═══════════════════════════════════
   晴 Fair · 朱砂 · sun motes rising
   ═══════════════════════════════════ */
.sun-motes{position:absolute;inset:0;overflow:hidden;pointer-events:none}
.sun-motes i{
  position:absolute;border-radius:50%;
  background:rgba(200,120,50,.06);
  width:var(--w,3px);height:var(--w,3px);
  left:var(--x,50%);bottom:-5%;
  animation:fair-warm var(--dur,7s) ease-in infinite;
  animation-delay:var(--delay,0s);
}
@keyframes fair-warm{0%{transform:translateY(0) translateX(0);opacity:0}20%{opacity:.8}80%{opacity:.4}100%{transform:translateY(-100vh) translateX(var(--drift,20px));opacity:0}}

/* ═══════════════════════════════════
   Layout — scroll aesthetic
   ═══════════════════════════════════ */
#sidebar{
  width:var(--sidebar-w);flex-shrink:0;position:relative;z-index:1;
  padding:var(--gutter) clamp(20px,3vw,32px);
  display:flex;flex-direction:column;gap:0;
  background:linear-gradient(90deg,rgba(0,0,0,.015),transparent 40%);
}

/* Logo: vertical seal style */
#logo-block{margin-bottom:clamp(28px,7vh,56px);text-align:center}
#logo{
  font-size:clamp(1.5rem,2.5vw,2rem);font-weight:700;
  letter-spacing:.2em;color:var(--ink-deep);line-height:1.2;
  writing-mode:horizontal-tb;
}
#logo small{
  display:block;font-weight:300;font-size:.7rem;color:var(--ink-light);
  letter-spacing:.2em;margin-top:4px;
}

#agents-list{display:flex;flex-direction:column;gap:2px;flex:1;overflow-y:auto}

.agent-item{
  display:flex;align-items:center;gap:12px;
  padding:11px 14px;cursor:pointer;
  border-radius:4px;position:relative;transition:all .4s ease;
  border-left:2px solid transparent;
}
.agent-item:hover{background:var(--paper-edge)}
.agent-item.active{background:var(--pigment-soft);border-left-color:var(--pigment)}

/* Seal stamp effect for active agent */
.agent-item.active::after{
  content:attr(data-seal);
  position:absolute;right:10px;top:50%;transform:translateY(-50%);
  font-size:1.3rem;font-weight:700;color:var(--pigment);
  opacity:.55;font-family:'Noto Serif SC',serif;
  letter-spacing:0;
}

.agent-dot{display:none}

.agent-info{display:flex;flex-direction:column;gap:1px}
.agent-label{font-size:.92rem;font-weight:600;color:var(--ink-mid);letter-spacing:.04em;transition:color .35s;line-height:1.3}
.agent-item.active .agent-label{color:var(--ink-deep)}
.agent-sublabel{font-size:.7rem;color:var(--ink-light);font-weight:300;letter-spacing:.04em}
.agent-item.active .agent-sublabel{color:var(--pigment)}

#sidebar-verse{margin-top:auto;padding-top:20px;text-align:center}
#sidebar-verse p{font-size:.72rem;color:var(--ink-light);font-style:italic;line-height:2.2;letter-spacing:.05em;font-weight:300}

/* ── Main chat ── */
#main{flex:1;display:flex;flex-direction:column;position:relative;z-index:1;min-width:0}
#chat-strip{
  display:flex;align-items:center;gap:10px;
  padding:clamp(12px,3vh,18px) var(--gutter);
}
.strip-dot{
  width:6px;height:6px;border-radius:50%;background:var(--pigment);
  flex-shrink:0;animation:var(--dot-anim) 2s ease-in-out infinite;
  transition:background .5s;
}
#strip-name{font-weight:600;font-size:.95rem;color:var(--ink-deep);letter-spacing:.06em}
#strip-pigment{font-size:.75rem;color:var(--ink-light);font-weight:300}

/* ── Divider line with brush feel ── */
#chat-strip::after{
  content:'';position:absolute;bottom:0;left:var(--gutter);right:var(--gutter);
  height:1px;background:linear-gradient(90deg,transparent,var(--ink-faint) 20%,var(--ink-faint) 80%,transparent);
}

/* ── Messages ── */
#messages{
  flex:1;overflow-y:auto;padding:var(--gutter);
  display:flex;flex-direction:column;gap:clamp(18px,3.5vh,32px);
  scroll-behavior:smooth;
}
#messages::-webkit-scrollbar{width:4px}
#messages::-webkit-scrollbar-track{background:transparent}
#messages::-webkit-scrollbar-thumb{background:var(--ink-faint);border-radius:2px}

.msg{max-width:66%;line-height:1.85;animation:msg-in .5s ease both;position:relative}
@keyframes msg-in{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}

.msg.user{align-self:flex-end;margin-right:clamp(0px,5vw,60px)}
.msg.user .msg-body{padding-right:18px;border-right:2px solid var(--pigment);text-align:right;color:var(--ink-deep);transition:border-color .5s}

.msg.assistant{align-self:flex-start;margin-left:clamp(0px,3vw,36px)}
.msg.assistant .msg-body{
  padding:14px 18px;color:var(--ink-mid);
  background:linear-gradient(135deg,rgba(255,255,255,.35),rgba(255,255,255,.15));
  border-left:3px solid var(--pigment);
  border-radius:0 6px 6px 0;
  transition:border-color .5s,background .5s;
  box-shadow:1px 1px 3px rgba(0,0,0,.03);
}

.msg.system{align-self:center;max-width:88%}
.msg.system .msg-body{color:var(--ink-light);font-size:.76rem;text-align:center;font-style:italic;border:none;padding:0}

.msg-time{font-size:.65rem;color:var(--ink-faint);margin-top:5px;letter-spacing:.08em;display:block}
.msg.typing .msg-body{animation:ink-bleed 2s infinite}
@keyframes ink-bleed{0%,100%{opacity:.28}50%{opacity:.6}}

/* ── Input ── */
#input-area{
  padding:14px var(--gutter) clamp(18px,3.5vh,28px);
  background:linear-gradient(0deg,var(--paper-warm),transparent 40%);
}
#input-wrap{
  display:flex;gap:0;align-items:stretch;
  border-bottom:1.5px solid var(--ink-faint);
  transition:border-color .4s ease;padding-bottom:4px;
}
#input-wrap:focus-within{border-bottom-color:var(--pigment)}
#input-wrap textarea{
  flex:1;background:transparent;border:none;outline:none;color:var(--ink-deep);
  font-family:inherit;font-size:.95rem;font-weight:300;padding:8px 0;
  resize:none;min-height:24px;max-height:140px;line-height:1.7;
}
#input-wrap textarea::placeholder{color:var(--ink-faint);font-style:italic}
#send-btn{
  background:none;border:none;color:var(--ink-light);cursor:pointer;
  padding:8px 14px;font-size:1.1rem;transition:all .3s ease;
  font-family:inherit;display:flex;align-items:center;opacity:.45;
}
#send-btn:hover{opacity:1;color:var(--pigment)}
#send-btn:disabled{opacity:.12}
#input-hint{font-size:.66rem;color:var(--ink-faint);margin-top:8px;letter-spacing:.06em;text-align:right}

/* ── Kanji seal stamp ── */
#kanji-decoration{position:fixed;right:clamp(20px,5vw,56px);bottom:clamp(80px,14vh,140px);z-index:0;pointer-events:none
  ;font-size:clamp(2.5rem,6vw,4.5rem);font-weight:700;font-family:'Noto Serif SC',serif;user-select:none;
  color:var(--pigment);opacity:.05;animation:var(--kanji-anim) 8s ease-in-out infinite;
  transition:color .8s ease;
  border:2px solid var(--pigment);border-radius:4px;padding:clamp(4px,1vw,10px) clamp(6px,1.5vw,16px);
  writing-mode:vertical-rl;letter-spacing:.1em;
}

/* Dot animations for header indicator */
@keyframes fog-pulse{0%,100%{opacity:.4;transform:scale(1)}50%{opacity:1;transform:scale(1.8)}}
@keyframes rain-ripple{0%,100%{opacity:.5;transform:scale(1)}30%{opacity:1;transform:scale(1.6)}60%{opacity:.5;transform:scale(1)}90%{opacity:1;transform:scale(1.4)}}
@keyframes frost-glint{0%,100%{opacity:1;transform:scale(1)}45%{opacity:.2;transform:scale(.5)}50%{opacity:1;transform:scale(1.7)}55%{opacity:.2;transform:scale(.5)}}
@keyframes snow-float{0%,100%{transform:translateY(0);opacity:.6}50%{transform:translateY(-4px);opacity:1}}
@keyframes dew-bead{0%,100%{transform:scale(1);opacity:.5}50%{transform:scale(1.6);opacity:1}}
@keyframes fair-glow{0%,100%{opacity:.5;transform:scale(1)}50%{opacity:1;transform:scale(1.5)}}

.agent-label{font-size:.95rem;font-weight:600;color:var(--ink-mid);letter-spacing:.02em;transition:color .35s}
.agent-item.active .agent-label{color:var(--ink-deep)}
.agent-sublabel{font-size:.72rem;color:var(--ink-light);font-weight:300;letter-spacing:.04em}
.agent-item.active .agent-sublabel{color:var(--pigment)}

#sidebar-verse{margin-top:auto;padding-top:24px}
#sidebar-verse p{font-size:.75rem;color:var(--ink-light);font-style:italic;line-height:2;letter-spacing:.03em;font-weight:300}

/* ── Main chat ── */
#main{flex:1;display:flex;flex-direction:column;position:relative;z-index:1;min-width:0}
#chat-strip{display:flex;align-items:center;gap:12px;padding:clamp(12px,3vh,20px) var(--gutter);border-bottom:1px solid var(--ink-faint)}
.strip-dot{width:7px;height:7px;border-radius:50%;background:var(--pigment);flex-shrink:0;animation:var(--dot-anim) 2s ease-in-out infinite;transition:background .5s}
#strip-name{font-weight:600;font-size:1rem;color:var(--ink-deep);letter-spacing:.04em}
#strip-pigment{font-size:.78rem;color:var(--ink-light);font-weight:300}

/* ── Messages ── */
#messages{flex:1;overflow-y:auto;padding:var(--gutter);display:flex;flex-direction:column;gap:clamp(16px,3vh,28px);scroll-behavior:smooth}
#messages::-webkit-scrollbar{width:3px}
#messages::-webkit-scrollbar-track{background:transparent}
#messages::-webkit-scrollbar-thumb{background:var(--ink-faint);border-radius:2px}

.msg{max-width:68%;line-height:1.8;animation:msg-in .5s ease both;position:relative}
@keyframes msg-in{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}

.msg.user{align-self:flex-end;margin-right:clamp(0px,4vw,40px)}
.msg.user .msg-body{padding-right:16px;border-right:2px solid var(--pigment);text-align:right;color:var(--ink-deep);transition:border-color .5s}

.msg.assistant{align-self:flex-start;margin-left:clamp(0px,2vw,24px)}
.msg.assistant .msg-body{
  padding:12px 16px;color:var(--ink-mid);
  border:1px solid var(--ink-faint);border-left:3px solid var(--pigment);
  background:rgba(255,255,255,.25);
  transition:border-color .5s,background .5s;
}

.msg.system{align-self:center;max-width:90%}
.msg.system .msg-body{color:var(--ink-light);font-size:.78rem;text-align:center;font-style:italic;border:none;padding:0}

.msg-time{font-size:.67rem;color:var(--ink-faint);margin-top:6px;letter-spacing:.06em;display:block}
.msg.typing .msg-body{animation:ink-bleed 2s infinite}
@keyframes ink-bleed{0%,100%{opacity:.3}50%{opacity:.65}}

/* ── Input ── */
#input-area{padding:16px var(--gutter) clamp(16px,3vh,28px);border-top:1px solid var(--ink-faint);background:linear-gradient(0deg,var(--paper-warm),var(--paper))}
#input-wrap{display:flex;gap:0;align-items:stretch;border-bottom:1px solid var(--ink-faint);transition:border-color .4s ease;padding-bottom:0}
#input-wrap:focus-within{border-bottom-color:var(--pigment)}
#input-wrap textarea{
  flex:1;background:transparent;border:none;outline:none;color:var(--ink-deep);
  font-family:inherit;font-size:.95rem;font-weight:300;padding:10px 0;
  resize:none;min-height:26px;max-height:140px;line-height:1.7;
}
#input-wrap textarea::placeholder{color:var(--ink-faint);font-style:italic}
#send-btn{background:none;border:none;color:var(--ink-light);cursor:pointer;padding:8px 12px;font-size:1.2rem;transition:all .3s ease;font-family:inherit;display:flex;align-items:center;opacity:.5}
#send-btn:hover{opacity:1;color:var(--pigment)}
#send-btn:disabled{opacity:.15}
#input-hint{font-size:.68rem;color:var(--ink-faint);margin-top:6px;letter-spacing:.04em}

/* ── Kanji decoration ── */
#kanji-decoration{
  position:fixed;right:clamp(16px,4vw,48px);bottom:clamp(80px,15vh,140px);
  font-size:clamp(3.5rem,8vw,6rem);z-index:0;pointer-events:none;
  color:var(--pigment);opacity:.06;font-weight:700;
  font-family:'Noto Serif SC',serif;user-select:none;
  animation:var(--kanji-anim) 8s ease-in-out infinite;
  transition:color .8s ease,animation .8s ease;
}

@keyframes fog-drift{0%,100%{opacity:.04;transform:translateX(0)}50%{opacity:.09;transform:translateX(-8px)}}
@keyframes rain-fall{0%,100%{opacity:.04;transform:translateY(0)}50%{opacity:.1;transform:translateY(5px)}}
@keyframes frost-sparkle{0%{opacity:.04;transform:scale(1) rotate(0deg)}45%{opacity:.12;transform:scale(1.04) rotate(1.5deg)}50%{opacity:.04;transform:scale(1) rotate(0deg)}100%{opacity:.04;transform:scale(1) rotate(0deg)}}
@keyframes snow-fall{0%,100%{opacity:.04;transform:translateY(0) rotate(0deg)}50%{opacity:.08;transform:translateY(6px) rotate(.5deg)}}
@keyframes dew-still{0%,100%{opacity:.05;transform:scale(1)}}
@keyframes fair-warm{0%,100%{opacity:.04;transform:scale(1)}50%{opacity:.1;transform:scale(1.02)}}

/* ── Mobile ── */
@media(max-width:720px){
  body{flex-direction:column}
  #sidebar{width:100%;flex-direction:row;align-items:center;gap:4px;padding:8px 12px;overflow-x:auto;flex-shrink:0;background:var(--paper-warm)}
  #logo-block{display:none}#sidebar-verse{display:none}
  .agent-item{border-left:none;border-bottom:2px solid transparent;border-radius:0;padding:8px 12px;white-space:nowrap}
  .agent-item.active{border-bottom-color:var(--pigment);border-left-color:transparent;background:transparent}
  .agent-item.active::after{display:none}
  .agent-sublabel{display:none}
  .msg{max-width:90%}
  #kanji-decoration{right:8px;bottom:40px;font-size:1.8rem;border-width:1px;padding:4px 6px;opacity:.06}
  #messages{padding:16px 12px}#chat-strip{padding:8px 12px}#input-area{padding:10px 12px}
}
</style>
</head>
<body>

<div id="paper-grain"></div>
<div id="ambient-layer"><div class="mist-particles"></div></div>
<div id="kanji-decoration">霧</div>

<div id="sidebar">
  <div id="logo-block"><div id="logo">气象台<small>skyloom</small></div></div>
  <div id="agents-list"></div>
  <div id="sidebar-verse"><p id="verse-text">山色有无中</p></div>
</div>

<div id="main">
  <div id="chat-strip">
    <div class="strip-dot"></div>
    <span id="strip-name">雾 Fog</span>
    <span id="strip-pigment">· 松烟墨</span>
  </div>
  <div id="messages"></div>
  <div id="input-area">
    <div id="input-wrap">
      <textarea id="chat-input" rows="1" placeholder="写下你想说的话…" autofocus></textarea>
      <button id="send-btn" aria-label="发送">→</button>
    </div>
    <div id="input-hint">enter 发送 · shift+enter 换行 · ⌘1-6 切换灵</div>
  </div>
</div>

<script>
const PIGMENTS = ${JSON.stringify(PIGMENTS)};
const AGENTS = [
  {name:'fog',  label:'雾 Fog',   sub:'松烟墨 · 探索洞察', pigment:PIGMENTS.fog,  particles:'mist-particles', count:8,  nameZH:'松烟墨',kanji:'霧'},
  {name:'rain', label:'雨 Rain',  sub:'石青 · 创造产出',    pigment:PIGMENTS.rain,  particles:'rain-streaks',   count:20, nameZH:'石青',kanji:'雨'},
  {name:'frost',label:'霜 Frost', sub:'石绿 · 精炼品质',    pigment:PIGMENTS.frost, particles:'frost-crystals', count:14, nameZH:'石绿',kanji:'霜'},
  {name:'snow', label:'雪 Snow',  sub:'铅白 · 架构规划',    pigment:PIGMENTS.snow,  particles:'snow-particles', count:12, nameZH:'铅白',kanji:'雪'},
  {name:'dew',  label:'露 Dew',   sub:'赭石 · 可靠守护',    pigment:PIGMENTS.dew,   particles:'dew-beads',     count:10, nameZH:'赭石',kanji:'露'},
  {name:'fair', label:'晴 Fair',  sub:'朱砂 · 情感陪伴',    pigment:PIGMENTS.fair,  particles:'sun-motes',     count:16, nameZH:'朱砂',kanji:'晴'},
];

const root=document.documentElement;
const ambientLayer=document.getElementById('ambient-layer');
const kanjiEl=document.getElementById('kanji-decoration');
let currentAgent=AGENTS[0],isStreaming=false;

/* Build ambient particles */
const particleMap=new Map();
AGENTS.forEach(a=>{
  const container=document.createElement('div');container.className=a.particles;
  for(let i=0;i<a.count;i++){
    const el=document.createElement('i');
    const seed=Math.random();
    el.style.cssText='--x:'+(8+seed*84)+'%;--y:'+(5+seed*90)+'%;--dur:'+(2+seed*8)+'s;--delay:'+(seed*-6)+'s;--w:'+(4+seed*10)+'px;--h:'+(3+seed*8)+'px;--drift:'+((seed-.5)*40)+'px';
    container.appendChild(el);
  }
  ambientLayer.appendChild(container);
});

function applyTheme(agent){
  if(currentAgent===agent)return;currentAgent=agent;
  const p=agent.pigment;
  root.style.setProperty('--pigment',p.color);
  root.style.setProperty('--ambient-bg',p.ambient);
  root.style.setProperty('--msg-border',p.msgStyle);
  root.style.setProperty('--dot-anim',p.dotPulse);
  root.style.setProperty('--kanji-anim',p.kanjiAnim);

  /* Show only this agent's particles */
  ambientLayer.querySelectorAll('div').forEach(d=>d.style.display=d.classList.contains(agent.particles)?'block':'none');
  kanjiEl.textContent=agent.kanji;
  kanjiEl.style.animation='none';void kanjiEl.offsetWidth;kanjiEl.style.animation=p.kanjiAnim+' 8s ease-in-out infinite';

  document.querySelectorAll('.agent-item').forEach(e=>e.classList.remove('active'));
  const card=document.querySelector('[data-agent="'+agent.name+'"]');if(card)card.classList.add('active');
  document.getElementById('strip-name').textContent=agent.label;
  document.getElementById('strip-pigment').textContent='· '+agent.nameZH;
  document.getElementById('verse-text').textContent=agent.pigment.poem;
}

/* Build sidebar */
const list=document.getElementById('agents-list');
AGENTS.forEach((a,i)=>{
  const el=document.createElement('div');el.className='agent-item';el.dataset.agent=a.name;el.dataset.seal=a.kanji;
  el.innerHTML='<span class="agent-info"><span class="agent-label">'+a.label+'</span><span class="agent-sublabel">'+a.sub+'</span></span>';
  el.addEventListener('click',()=>applyTheme(a));
  list.appendChild(el);
});
applyTheme(AGENTS[0]);

/* ── Chat ── */
const msgsEl=document.getElementById('messages'),input=document.getElementById('chat-input'),sendBtn=document.getElementById('send-btn');

function addMsg(role,text){
  const w=document.createElement('div');w.className='msg '+role;
  w.innerHTML='<div class="msg-body">'+text+'</div><span class="msg-time">'+new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})+'</span>';
  msgsEl.appendChild(w);scrollBottom();return w;
}
function addSys(t){addMsg('system',t)}
function scrollBottom(){msgsEl.scrollTop=msgsEl.scrollHeight}

function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function render(s){return esc(s).replace(/\\n/g,'<br>')}

/* Consume the SSE stream: tokens render live, tool calls appear as weather events. */
async function sendMessage(){
  const text=input.value.trim();if(!text||isStreaming)return;
  input.value='';input.style.height='auto';isStreaming=true;sendBtn.disabled=true;
  addMsg('user',esc(text));
  const el=addMsg('assistant','<span class="typing">…</span>');
  const body=el.querySelector('.msg-body');
  let content='',started=false;
  try{
    const resp=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:text,agent:currentAgent.name})});
    const reader=resp.body.getReader(),dec=new TextDecoder();let buf='';
    while(true){
      const {done,value}=await reader.read();if(done)break;
      buf+=dec.decode(value,{stream:true});
      const parts=buf.split('\\n\\n');buf=parts.pop();
      for(const p of parts){
        const line=p.replace(/^data: /,'').trim();if(!line)continue;
        let ev;try{ev=JSON.parse(line)}catch{continue}
        if(ev.type==='content'){if(!started){started=true;body.innerHTML=''}content+=ev.text;body.innerHTML=render(content);scrollBottom()}
        else if(ev.type==='tool_status'){addSys(currentAgent.kanji+' '+esc(ev.tool_name)+' …')}
        else if(ev.type==='tool_done'){addSys((ev.success?'✓ ':'× ')+esc(ev.tool_name))}
        else if(ev.type==='error'){addSys('× '+esc(ev.text||'出错了'))}
        else if(ev.type==='truncated'){addSys('⚠ '+esc(ev.reason||'截断'))}
      }
    }
    if(!content.trim())body.innerHTML='<span style="opacity:.5">（无回复）</span>';
  }catch(e){body.innerHTML='';addSys('× 连接中断')}
  isStreaming=false;sendBtn.disabled=false;input.focus();
}

input.addEventListener('input',()=>{input.style.height='auto';input.style.height=Math.min(input.scrollHeight,140)+'px'});
input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage()}});
sendBtn.addEventListener('click',sendMessage);
document.addEventListener('keydown',e=>{if(e.ctrlKey||e.metaKey){const n=parseInt(e.key);if(n>=1&&n<=6){e.preventDefault();applyTheme(AGENTS[n-1])}}});
addSys('气象台已就绪 · ⌘1-6 唤灵 · enter 传讯');
</script>
</body>
</html>`;

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}
