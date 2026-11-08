
/* BPM Brawl game engine: audio, beat analysis, song library, combat and the 2D fighter layer.
   React renders the menus from the state exported here and calls the exported actions. */
export const W = 1280, H = 720, GROUND = 612, HORIZON = 430;
export const COL = { p1:'#ff2f92', p2:'#19e3ff', gold:'#ffd23f', ink:'#06020c', text:'#f6efff', muted:'#a395c4' };
export const SIDES = [
  { c:'#ff2f92', suit:'#3a0f31', suitB:'#170614', rim:'#ff9ccc', lit:'#7a1f63', glow:'255,47,146' },
  { c:'#19e3ff', suit:'#0b2c40', suitB:'#04121d', rim:'#a5f5ff', lit:'#16607e', glow:'25,227,255' },
];
export const ROUND_LEN = 20, MAX_ROUNDS = 5, MAX_HP = 100, PICK_TIME = 20;
const clamp = (v,a,b) => Math.max(a, Math.min(b, v));
const lerp = (a,b,t) => a + (b-a)*t;
const rand = (a,b) => a + Math.random()*(b-a);
const pickOne = arr => arr[Math.floor(Math.random()*arr.length)];
const mtof = m => 440*Math.pow(2,(m-69)/12);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const frac1 = x => ((x % 1) + 1) % 1;

/* =====================================================================
   CANVASES: main, bloom chain, grain, vignette, LED wall
   ===================================================================== */
let cv = null, ctx = null, grainPat = null, ledPat = null;
let dpr = 1;
// quality steps down on its own if frames run slow: canvas width cap, then bloom, grain and motes go
const RES_CAP = [1600, 1280, 1024, 800];
let quality = 0;
function resize(){
  const css = cv.getBoundingClientRect().width || W;
  dpr = clamp(Math.min(css*(window.devicePixelRatio || 1), RES_CAP[quality])/W, 0.6, 1.25);
  const w = Math.round(W*dpr), h = Math.round(H*dpr);
  if (cv.width !== w || cv.height !== h){ cv.width = w; cv.height = h; }
  ctx.imageSmoothingQuality = 'high';
}
const mk = (w,h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return [c, c.getContext('2d')]; };
const [b1, b1x] = mk(320,180), [b2, b2x] = mk(160,90), [b3, b3x] = mk(80,45);
// glow buffers big enough that Chrome keeps them on the GPU (tiny canvases live on the CPU,
// and copying the stage into one every frame forced a GPU read-back that stalled the whole machine)
const [g1, g1x] = mk(400,225), [g2, g2x] = mk(400,225);
const canBlur = typeof g2x.filter === 'string';
const [grainC, grainX] = mk(256,256);
{ const id = grainX.createImageData(256,256); for (let i=0;i<id.data.length;i+=4){ const v = Math.random()*255; id.data[i]=id.data[i+1]=id.data[i+2]=v; id.data[i+3]=255; } grainX.putImageData(id,0,0); }
const [vigC, vigX] = mk(W,H);
{ const g = vigX.createRadialGradient(W/2,H*0.48,H*0.35,W/2,H*0.5,H*0.95); g.addColorStop(0,'rgba(0,0,0,0)'); g.addColorStop(1,'rgba(0,0,0,.6)'); vigX.fillStyle = g; vigX.fillRect(0,0,W,H); }
const LEDW = 64, LEDH = 30;
const [ledC, ledX] = mk(LEDW, LEDH);
const [ledMask, ledMaskX] = mk(8,8);
{ ledMaskX.fillStyle = 'rgba(4,1,8,.9)'; ledMaskX.fillRect(0,0,8,8); ledMaskX.globalCompositeOperation = 'destination-out'; ledMaskX.beginPath(); ledMaskX.arc(4,4,2.9,0,Math.PI*2); ledMaskX.fill(); }

/* =====================================================================
   UI BRIDGE: React re-renders when bump() is called
   ===================================================================== */
let version = 0;
const listeners = new Set();
export const subscribe = fn => { listeners.add(fn); return () => listeners.delete(fn); };
export const getVersion = () => version;
let bumpQueued = false;
function bump(){
  if (bumpQueued) return; bumpQueued = true;
  queueMicrotask(() => { bumpQueued = false; version++; listeners.forEach(fn => fn()); });
}

/* =====================================================================
   AUDIO ENGINE
   ===================================================================== */
let mixDest = null, mixRec = null, mixChunks = [], mixUrl = null;
let AC = null, master, sfxBus, musicBus, analyser, freqData, noiseBuf, distCurve;
function initAudio(){
  if (AC){ if (AC.state === 'suspended' && G.state !== 'paused') AC.resume(); return; }
  AC = new (window.AudioContext || window.webkitAudioContext)();
  master = AC.createGain(); master.gain.value = 0.8;
  const comp = AC.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.2;
  analyser = AC.createAnalyser(); analyser.fftSize = 256; analyser.smoothingTimeConstant = 0.75;
  musicBus = AC.createGain(); musicBus.connect(master); musicBus.connect(analyser);
  master.connect(comp); comp.connect(AC.destination);
  sfxBus = AC.createGain(); sfxBus.gain.value = 0.85; sfxBus.connect(comp);
  freqData = new Uint8Array(analyser.frequencyBinCount);
  if (window.MediaRecorder && AC.createMediaStreamDestination){ mixDest = AC.createMediaStreamDestination(); musicBus.connect(mixDest); }
  noiseBuf = AC.createBuffer(1, AC.sampleRate, AC.sampleRate);
  const d = noiseBuf.getChannelData(0); for (let i=0;i<d.length;i++) d[i] = Math.random()*2-1;
  distCurve = new Float32Array(1024); for (let i=0;i<1024;i++){ const x = i/512-1; distCurve[i] = Math.tanh(x*6); }
}
const audioNow = () => AC ? AC.currentTime - (AC.outputLatency || AC.baseLatency || 0) : performance.now()/1000;

function kick(dest,t,v=1,hard=false){
  const o = AC.createOscillator(), g = AC.createGain();
  o.frequency.setValueAtTime(hard?260:165, t); o.frequency.exponentialRampToValueAtTime(44, t+(hard?0.08:0.13));
  g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.001, t+(hard?0.3:0.4));
  if (hard){ const ws = AC.createWaveShaper(); ws.curve = distCurve; o.connect(ws); ws.connect(g); } else o.connect(g);
  g.connect(dest); o.start(t); o.stop(t+0.45);
}
function noise(dest,t,dur,v,type,freq,q=0.7){
  const s = AC.createBufferSource(); s.buffer = noiseBuf;
  const f = AC.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
  const g = AC.createGain(); g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.001, t+dur);
  s.connect(f); f.connect(g); g.connect(dest); s.start(t, Math.random()*0.5); s.stop(t+dur+0.02);
}
function tone(dest,t,freq,dur,v,type='sine'){
  const o = AC.createOscillator(), g = AC.createGain(); o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(v, t+0.004); g.gain.exponentialRampToValueAtTime(0.0001, t+dur);
  o.connect(g); g.connect(dest); o.start(t); o.stop(t+dur+0.02);
}
const snare = (d,t,v=0.5) => { noise(d,t,0.17,v,'highpass',1400); tone(d,t,185,0.08,v*0.7,'triangle'); };
const clap  = (d,t,v=0.5) => { for (let i=0;i<3;i++) noise(d,t+i*0.011,i===2?0.15:0.025,v,'bandpass',1350,1.1); };
const hat   = (d,t,v=0.15,open=false) => noise(d,t,open?0.2:0.04,v,'highpass',open?6500:8200);
function synth(dest,t,m,dur,v,type,cut,{res=3,detune=0,attack=0.006}={}){
  const g = AC.createGain(), f = AC.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = res;
  f.frequency.setValueAtTime(cut*2.6, t); f.frequency.exponentialRampToValueAtTime(cut, t+Math.max(0.05,dur*0.7));
  g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(v, t+attack);
  g.gain.setValueAtTime(v, t+Math.max(attack, dur*0.55)); g.gain.exponentialRampToValueAtTime(0.0001, t+dur);
  for (const dt of detune ? [-detune, detune] : [0]){
    const o = AC.createOscillator(); o.type = type; o.detune.value = dt; o.frequency.value = mtof(m);
    o.connect(f); o.start(t); o.stop(t+dur+0.05);
  }
  f.connect(g); g.connect(dest);
}
function sub808(dest,t,m,dur,v,glideFrom){
  const o = AC.createOscillator(), g = AC.createGain(), ws = AC.createWaveShaper(); ws.curve = distCurve;
  const pre = AC.createGain(); pre.gain.value = 0.35;
  o.frequency.setValueAtTime(mtof(glideFrom ?? m+12), t); o.frequency.exponentialRampToValueAtTime(mtof(m), t+(glideFrom!=null?0.12:0.04));
  g.gain.setValueAtTime(v, t); g.gain.setValueAtTime(v, t+dur*0.5); g.gain.exponentialRampToValueAtTime(0.001, t+dur);
  o.connect(pre); pre.connect(ws); ws.connect(g); g.connect(dest); o.start(t); o.stop(t+dur+0.05);
}
const CH = { m:[0,3,7,10], M:[0,4,7,11], d:[0,4,7,10] };
const PENTA = [0,3,5,7,10,12,15];
// Original studio grooves, synthesized live. Patterns are 16 sixteenth-note steps per bar.
const STUDIO = [
  { id:'s-lofi', name:'Lantern Rain', genre:'Lo-fi', bpm:82, hue:28, key:50, swing:.22, prog:[[0,'M'],[-3,'m'],[5,'M'],[-5,'d']],
    kick:'x......x..x.....', snare:'....x.......x...', hat:'x.x.x.x.x.x.x.x.', hatV:.06,
    bass:{pat:'x.........x..x..',type:'sine',cut:500,oct:-1,v:.55,len:5},
    lead:{pat:'..x....x...x.x..',type:'triangle',cut:2400,oct:1,v:.11,len:3,mode:'penta',from:2}, pad:.045 },
  { id:'s-boom', name:'Concrete Bounce', genre:'Boom bap', bpm:92, hue:40, key:45, swing:.16, prog:[[0,'m'],[0,'m'],[-4,'M'],[-2,'d']],
    kick:'x..x..x...x..x..', snare:'....x.......x...', hat:'x.x.x.x.x.x.x.x.', hatV:.08, fill:1,
    bass:{pat:'x..x..x...x.....',type:'sawtooth',cut:350,oct:-1,v:.42,len:2},
    lead:{pat:'x.....x.....x...',type:'square',cut:1400,oct:1,v:.06,len:3,mode:'arp',from:4}, pad:.03 },
  { id:'s-dembow', name:'Malecón Heat', genre:'Reggaeton', bpm:98, hue:12, key:47, prog:[[0,'m'],[-4,'M'],[-2,'M'],[3,'M']],
    kick:'x...x...x...x...', snare:'...x..x....x..x.', hat:'..x...x...x...x.', hatV:.1,
    bass:{pat:'x..x..x.x..x..x.',type:'sine',cut:600,oct:-1,v:.5,len:2},
    lead:{pat:'x..x..x...x.x...',type:'square',cut:2200,oct:1,v:.07,len:1,mode:'arp',from:2}, pad:.035 },
  { id:'s-wave', name:'Chrome Overpass', genre:'Synthwave', bpm:112, hue:290, key:40, prog:[[0,'m'],[-4,'M'],[-7,'M'],[-2,'M']],
    kick:'x...x...x...x...', snare:'....x.......x...', hat:'..x...x...x...x.', hatV:.1, fill:1,
    bass:{pat:'xxxxxxxxxxxxxxxx',type:'sawtooth',cut:420,oct:-1,v:.25,len:1,mode:'oct'},
    lead:{pat:'x.x.x.x.x.x.x.x.',type:'sawtooth',cut:2600,oct:1,v:.06,len:2,mode:'arp',detune:9,from:4}, pad:.04 },
  { id:'s-house', name:'Basement Glow', genre:'House', bpm:124, hue:200, key:44, prog:[[0,'m'],[0,'m'],[-2,'M'],[-4,'M']],
    kick:'x...x...x...x...', clap:'....x.......x...', ohat:'..x...x...x...x.', hat:'x.x.x.x.x.x.x.x.', hatV:.06,
    bass:{pat:'..x...x...x...xx',type:'sawtooth',cut:500,oct:-1,v:.4,len:2},
    lead:{pat:'x..x..x.....x.x.',type:'square',cut:1800,oct:1,v:.06,len:1,mode:'chord',from:2}, pad:.03 },
  { id:'s-techno', name:'Iron Lung', genre:'Techno', bpm:132, hue:170, key:41, prog:[[0,'m'],[0,'m'],[1,'M'],[0,'m']],
    kick:'x...x...x...x...', clap:'....x.......x...', hat:'xxxxxxxxxxxxxxxx', hatV:.07, ohat:'..x...x...x...x.',
    bass:{pat:'.xxx.xxx.xxx.xxx',type:'sawtooth',cut:260,oct:-1,v:.3,len:1},
    lead:{pat:'x.....x.....x...',type:'square',cut:1100,oct:1,v:.07,len:2,mode:'arp',from:4} },
  { id:'s-trap', name:'Smoke Signal', genre:'Trap', bpm:142, hue:260, key:42, prog:[[0,'m'],[0,'m'],[-4,'M'],[-5,'M']],
    kick:'x......x..x.....', snare:'........x.......', hat:'x.x.x.xrx.x.xRx.', hatV:.09,
    bass:{pat:'x......x..x.....',type:'808',oct:-1,v:.6,len:6},
    lead:{pat:'x...x...x..x..x.',type:'triangle',cut:3000,oct:2,v:.08,len:2,mode:'penta',from:2}, pad:.035 },
  { id:'s-trance', name:'Afterburner', genre:'Trance', bpm:150, hue:220, key:45, prog:[[0,'m'],[-4,'M'],[-9,'M'],[-2,'M']],
    kick:'x...x...x...x...', clap:'....x.......x...', ohat:'..x...x...x...x.', hat:'x.x.x.x.x.x.x.x.', hatV:.05, fill:1,
    bass:{pat:'.xx.xxx..xx.xxx.',type:'sawtooth',cut:450,oct:-1,v:.3,len:1},
    lead:{pat:'xxxxxxxxxxxxxxxx',type:'sawtooth',cut:3200,oct:1,v:.045,len:1,mode:'arp',detune:12,from:4}, pad:.035 },
  { id:'s-dnb', name:'Liquid Voltage', genre:'Drum & bass', bpm:174, hue:150, key:43, prog:[[0,'m'],[-4,'M'],[-2,'M'],[-7,'m']],
    kick:'x.........x.....', snare:'....x.......x...', hat:'x.x.x.x.x.x.x.x.', hatV:.08, fill:1,
    bass:{pat:'x.......x.x.....',type:'sawtooth',cut:300,oct:-1,v:.38,len:6,detune:18},
    lead:{pat:'x.....x...x.....',type:'triangle',cut:3400,oct:2,v:.09,len:3,mode:'penta',from:4}, pad:.04 },
  { id:'s-gabber', name:'Riot Siren', genre:'Hardcore', bpm:186, hue:0, key:46, prog:[[0,'m'],[0,'m'],[-2,'M'],[1,'M']],
    kick:'x...x...x...x...', kickHard:1, hat:'..x...x...x...x.', hatV:.11, clap:'....x.......x...',
    lead:{pat:'x..x..x.x..x..x.',type:'sawtooth',cut:1800,oct:1,v:.06,len:2,mode:'arp',detune:20,from:2}, pad:.025 },
].map(t => ({ ...t, kind:'synth', artist:'BPM Brawl studio', bpmExact:t.bpm,
  mass:{ 's-lofi':.22, 's-boom':.5, 's-dembow':.55, 's-wave':.45, 's-house':.6, 's-techno':.72, 's-trap':.86, 's-trance':.52, 's-dnb':.68, 's-gabber':.95 }[t.id] }));

class SynthPlayer {
  constructor(track, dest){ this.t = track; this.out = AC.createGain(); this.out.connect(dest); this.counter = 0; }
  get period(){ return 60/this.t.bpm; }
  start(when){ this.t0 = when; this.next = when; this.step = 0; this.timer = setInterval(() => this.tick(), 25); this.tick(); }
  tick(){ const sd = this.period/4; while (this.next < AC.currentTime + 0.14){ this.play(this.step, this.next, sd); this.step++; this.next += sd; } }
  beatPos(now){ return (now - this.t0)/this.period; }
  play(s, time, sd){
    const T = this.t, i = s % 16, bar = Math.floor(s/16), o = this.out;
    const t = time + (i%2 ? (T.swing||0)*sd : 0);
    const [deg, q] = T.prog[bar % T.prog.length], root = T.key + deg, tones = CH[q];
    const on = p => p && p[i] && p[i] !== '.';
    if (on(T.kick)) kick(o, t, 0.95, T.kickHard);
    if (on(T.snare)) snare(o, t, 0.45);
    if (on(T.clap)) clap(o, t, 0.5);
    if (T.fill && bar%4 === 3 && i >= 12){ snare(o, t, 0.12+0.06*(i-12)); snare(o, t+sd/2, 0.14+0.06*(i-12)); }
    if (on(T.hat)){ const c = T.hat[i], v = T.hatV ?? 0.08; hat(o, t, v);
      if (c === 'r') hat(o, t+sd/2, v*0.8);
      if (c === 'R'){ hat(o, t+sd/3, v*0.8); hat(o, t+2*sd/3, v*0.9); } }
    if (on(T.ohat)) hat(o, t, 0.08, true);
    const B = T.bass;
    if (B && on(B.pat)){
      const m = root + 12*(B.oct||0) + (B.mode === 'oct' && i%2 ? 12 : 0);
      if (B.type === '808') sub808(o, t, m-12, sd*B.len, B.v, i === 10 ? m-5 : null);
      else synth(o, t, m, sd*B.len*0.95, B.v, B.type, B.cut, { detune:B.detune||0, res:2 });
    }
    const L = T.lead;
    if (L && on(L.pat) && (bar % 8) >= (L.from||0)){
      const base = root + 12*(L.oct||0);
      if (L.mode === 'chord') tones.slice(0,3).forEach(n => synth(o, t, base+n, sd*L.len, L.v*0.7, L.type, L.cut));
      else {
        let n;
        if (L.mode === 'penta'){ const h = Math.abs(Math.sin((bar%4)*12.9898 + i*78.233)*43758.5453); n = PENTA[Math.floor((h%1)*PENTA.length)]; }
        else n = tones[this.counter % tones.length] + (Math.floor(this.counter/4)%2 ? 12 : 0);
        this.counter++;
        synth(o, t, base+n, sd*L.len, L.v, L.type, L.cut, { detune:L.detune||0 });
      }
    }
    if (T.pad && i === 0) tones.forEach(n => synth(o, t, root+12+n, sd*15.5, T.pad, 'sawtooth', 900, { detune:8, attack:sd*4, res:1 }));
  }
  stop(){ clearInterval(this.timer); const g = this.out.gain, n = AC.currentTime;
    g.setValueAtTime(g.value, n); g.linearRampToValueAtTime(0, n+0.25); setTimeout(() => this.out.disconnect(), 600); }
}
class BufferPlayer {
  constructor(track, dest){ this.t = track; this.out = AC.createGain(); this.out.gain.value = track.gain || 0.85; this.out.connect(dest); }
  get period(){ return 60/this.t.bpmExact; }
  start(when){
    this.src = AC.createBufferSource(); this.src.buffer = this.t.buffer; this.src.loop = true;
    this.src.connect(this.out); this.off = (this.t.cursor || 0) % this.t.buffer.duration; this.t0 = when;
    this.src.start(when, this.off);
  }
  beatPos(now){ return (this.off + (now - this.t0) - this.t.phase)/this.period; }
  stop(){
    const n = AC.currentTime;
    this.t.cursor = (this.off + Math.max(0, n - this.t0)) % this.t.buffer.duration;
    const g = this.out.gain; g.setValueAtTime(g.value, n); g.linearRampToValueAtTime(0, n+0.25);
    try { this.src.stop(n+0.3); } catch {}
    setTimeout(() => this.out.disconnect(), 600);
  }
}
const makePlayer = (track, dest) => track.kind === 'synth' ? new SynthPlayer(track, dest) : new BufferPlayer(track, dest);

/* ---------- tempo detection: low-pass onset envelope, autocorrelation, then beat phase ---------- */
async function detectTempo(buf, hint=0){
  const sr = buf.sampleRate, dur = buf.duration;
  const segStart = dur > 60 ? dur*0.2 : 0, segLen = Math.min(45, dur - segStart);
  const off = new OfflineAudioContext(1, Math.ceil(segLen*sr), sr);
  const src = off.createBufferSource(); src.buffer = buf;
  const lp = off.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 180;
  src.connect(lp); lp.connect(off.destination); src.start(0, segStart, segLen);
  const data = (await off.startRendering()).getChannelData(0);
  const hop = Math.round(sr*0.005), n = Math.floor(data.length/hop), fps = sr/hop;
  const env = new Float32Array(n), nov = new Float32Array(n);
  let peak = 0;
  for (let k=0;k<n;k++){ let s=0; for (let j=0;j<hop;j++){ const x = data[k*hop+j]; s += x*x; } env[k] = Math.sqrt(s/hop); peak = Math.max(peak, env[k]); }
  for (let k=1;k<n;k++) nov[k] = Math.max(0, env[k]-env[k-1]);
  let best = 120, bestS = -1;
  // a known tempo narrows the search so we never land on half or double time
  const lo = hint ? Math.max(55, hint/1.12) : 80, hi = hint ? Math.min(220, hint*1.12) : 190;
  for (let bpm=lo, step=0; bpm<=hi; bpm+=0.5, step++){
    if (step % 24 === 23) await new Promise(r => setTimeout(r, 0)); // let the game draw between chunks
    const lag = fps*60/bpm; let s = 0;
    for (const mult of [1,2,4]){
      const L = lag*mult, Li = Math.floor(L), fr = L-Li; let c = 0;
      for (let k=0; k+Li+1<n; k++) c += nov[k]*(nov[k+Li]*(1-fr) + nov[k+Li+1]*fr);
      s += c/mult;
    }
    s *= Math.exp(-0.5*Math.pow(Math.log2(bpm/(hint || 125))/(hint ? 0.15 : 0.9), 2));
    if (s > bestS){ bestS = s; best = bpm; }
  }
  const P = fps*60/best; let bp = 0, bv = -1;
  for (let ph=0; ph<P; ph++){ let s=0; for (let x=ph; x<n; x+=P) s += nov[Math.round(x)] || 0; if (s > bv){ bv = s; bp = ph; } }
  // rough loudness match so quiet and loud songs sit at a similar level
  let rms = 0; const ch = buf.getChannelData(0); for (let i=0;i<ch.length;i+=64) rms += ch[i]*ch[i]; rms = Math.sqrt(rms/(ch.length/64));
  return { bpm:best, phase:segStart + bp/fps, cursor:segStart, gain: clamp(0.2/(rms||0.2), 0.45, 1.3), mass: songMass(buf, data, env, segStart, segLen, rms) };
}
// how heavy a song is: bass weight, raw loudness, and how hard the low end punches
function songMass(buf, low, env, segStart, segLen, rmsAll){
  const ch = buf.getChannelData(0), sr = buf.sampleRate, i0 = Math.floor(segStart*sr), i1 = Math.min(ch.length, i0 + Math.floor(segLen*sr));
  let full = 0, lo = 0, nf = 0, nl = 0;
  for (let i=i0;i<i1;i+=32){ full += ch[i]*ch[i]; nf++; }
  for (let i=0;i<low.length;i+=32){ lo += low[i]*low[i]; nl++; }
  full = Math.sqrt(full/(nf||1)); lo = Math.sqrt(lo/(nl||1));
  let m = 0; for (const v of env) m += v; m /= env.length || 1;
  let sd = 0; for (const v of env) sd += (v-m)*(v-m); sd = Math.sqrt(sd/(env.length||1));
  const bass = clamp((lo/(full||1) - 0.45)/0.5, 0, 1), loud = clamp((rmsAll - 0.12)/0.25, 0, 1), punch = clamp((sd/(m||1) - 0.3)/0.7, 0, 1);
  return clamp(0.5*bass + 0.3*loud + 0.2*punch, 0.08, 1);
}
const massOf = t => t && t.mass != null ? t.mass : 0.5;
const massPct = t => Math.round(massOf(t)*100);

/* =====================================================================
   MUSIC LIBRARY: song search, analysis queue, previews, uploads
   ===================================================================== */
const REG = new Map(STUDIO.map(t => [t.id, t]));
const uploads = [];
let searchState = 'idle'; // idle | loading | ok | error
let searchError = '';
let lastResults = [];
let lastQuery = '';

function jsonp(url){
  return new Promise((res, rej) => {
    const cb = '__bpm' + Math.random().toString(36).slice(2);
    const s = document.createElement('script');
    const done = () => { clearTimeout(to); delete window[cb]; s.remove(); };
    const to = setTimeout(() => { done(); rej(new Error('timeout')); }, 9000);
    window[cb] = d => { done(); res(d); };
    s.onerror = () => { done(); rej(new Error('blocked')); };
    s.src = url + '&callback=' + cb; document.head.appendChild(s);
  });
}
async function searchSongs(term){
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&entity=song&limit=24`;
  let data;
  try { const r = await fetch(url); if (!r.ok) throw new Error(r.status); data = await r.json(); }
  catch { data = await jsonp(url); }
  return (data.results || []).filter(r => r.previewUrl && r.kind === 'song').map(r => {
    const id = 'it' + r.trackId;
    if (REG.has(id)) return REG.get(id);
    const t = { id, kind:'remote', name:r.trackName, artist:r.artistName, genre:r.primaryGenreName || '',
      art:(r.artworkUrl100 || '').replace('100x100bb', '300x300bb'), preview:r.previewUrl };
    REG.set(id, t); return fromCache(t);
  });
}
// real songs that load without typing. iTunes track id, known tempo (0 = measure it), section
const HIT_SECTIONS = [
  ['telugu', 'TELUGU HITS', 'Tollywood mass beats · measured live'],
  ['heavy', 'SLOW TEMPO', 'Fewer beats, each one counts'],
  ['mid', 'MID TEMPO', 'A bit of everything'],
  ['fast', 'FAST TEMPO', 'Rapid beats, lots of small hits'],
  ['desi', 'BOLLYWOOD & PUNJABI', 'Measured live'],
];
const HITS = [
  [1594544794,0,'telugu'],[1600014695,0,'telugu'],[1723602835,0,'telugu'],[1766487491,0,'telugu'],[1744162427,0,'telugu'],[1782763234,0,'telugu'],
  [1781534087,0,'telugu'],[1592966284,0,'telugu'],[1485104774,0,'telugu'],[1492854573,0,'telugu'],[1747191476,0,'telugu'],[1761152593,0,'telugu'],
  [1489938568,0,'telugu'],[1107092914,0,'telugu'],[337856270,0,'telugu'],[923079986,0,'telugu'],[1590091435,0,'telugu'],[1481685076,0,'telugu'],
  [1410298479,0,'telugu'],
  [1406109863,77,'heavy'],[6781080737,81,'heavy'],[1440903439,86,'heavy'],[1447401620,89,'heavy'],[1196294581,90,'heavy'],
  [1193701392,96,'heavy'],[786489670,100,'heavy'],[1538003843,103,'heavy'],
  [590431785,105,'mid'],[254685026,109,'mid'],[590423552,110,'mid'],[6781076397,110,'mid'],[1440821643,112,'mid'],[1596532400,114,'mid'],
  [943946671,115,'mid'],[617154366,116,'mid'],[269573364,117,'mid'],[1440783625,117,'mid'],[1476095084,119,'mid'],[697195462,123,'mid'],
  [1533513537,124,'mid'],[1440872929,124,'mid'],[1411628233,125,'mid'],[1440787349,126,'mid'],[693226464,126,'mid'],[1670593167,128,'mid'],
  [1440861976,128,'mid'],[1445144527,132,'mid'],[575998661,134,'mid'],[338349243,136,'mid'],[269573341,139,'mid'],[409001935,140,'mid'],
  [500162235,141,'mid'],[1110087159,142,'mid'],
  [560097694,146,'fast'],[1440891171,148,'fast'],[1440882165,150,'fast'],[1577414972,150,'fast'],[6781079518,156,'fast'],[1411629089,168,'fast'],
  [1574968888,170,'fast'],[1499378607,171,'fast'],[1615585008,174,'fast'],[369711557,174,'fast'],[1698551200,174,'fast'],[1440870375,186,'fast'],
  [1648663570,0,'desi'],[1073359419,0,'desi'],[1588418743,0,'desi'],[1531596345,0,'desi'],[1581006912,0,'desi'],[1659644978,0,'desi'],
];
let hitsState = 'idle'; // idle | loading | ok | error
let hitTracks = [];
async function loadHits(){
  if (hitsState === 'loading' || hitsState === 'ok') return;
  hitsState = 'loading'; bump();
  const url = `https://itunes.apple.com/lookup?id=${HITS.map(h => h[0]).join(',')}&entity=song`;
  try {
    let data;
    try { const r = await fetch(url); if (!r.ok) throw new Error(r.status); data = await r.json(); }
    catch { data = await jsonp(url); }
    const byId = new Map((data.results || []).filter(r => r.previewUrl).map(r => [r.trackId, r]));
    hitTracks = HITS.filter(([id]) => byId.has(id)).map(([id, hint, sec]) => {
      const r = byId.get(id), key = 'it' + id;
      const t = REG.get(key) || { id:key, kind:'remote', name:r.trackName, artist:r.artistName, genre:r.primaryGenreName || '',
        art:(r.artworkUrl100 || '').replace('100x100bb', '300x300bb'), preview:r.previewUrl };
      if (hint) t.hint = hint;
      t.sec = sec; REG.set(key, t); return fromCache(t);
    });
    hitsState = hitTracks.length ? 'ok' : 'error';
  } catch { hitsState = 'error'; }
  bump(); queueHits();
}
function queueHits(){ hitTracks.forEach(t => { if (!t.bpm && !t.failed) ensureAnalyzed(t); }); }

// one queue so a search doesn't fire 20 downloads at once; picked songs jump the line
const queue = []; let running = 0;
function ensureAnalyzed(t, priority=false){
  if (t.bpm) return Promise.resolve(t);
  if (t.job){ if (priority && !t.job.started){ queue.splice(queue.indexOf(t.job),1); queue.unshift(t.job); } return t.job.promise; }
  const job = { t, started:false }; t.job = job;
  job.promise = new Promise((res, rej) => { job.res = res; job.rej = rej; });
  job.promise.catch(() => {});
  priority ? queue.unshift(job) : queue.push(job);
  pump(); return job.promise;
}
async function fetchBuffer(t){
  const r = await fetch(t.preview); if (!r.ok) throw new Error('fetch ' + r.status);
  return AC.decodeAudioData(await r.arrayBuffer());
}
function dropQueued(keep){
  for (let i=queue.length-1;i>=0;i--){ const j = queue[i]; if (!keep.has(j.t)){ queue.splice(i,1); j.t.job = null; j.rej(new Error('dropped')); } }
}
async function pump(){
  // heavy work: never during a round, and only two songs at a time
  if (['vs','countdown','fight','ko','roundEnd'].includes(G.state)) return;
  while (running < 2 && queue.length){
    const job = queue.shift(); job.started = true; running++;
    (async () => {
      const t = job.t;
      try {
        initAudio();
        const buf = t.buffer || await fetchBuffer(t);
        const res = await detectTempo(buf, t.hint);
        Object.assign(t, { bpm:Math.round(res.bpm), bpmExact:res.bpm, phase:res.phase, cursor:res.cursor, gain:res.gain, mass:res.mass, failed:false });
        if (t.kind === 'remote') saveAnalysis(t);
        // a decoded preview is ~10 MB, so remote songs drop it and reload from the HTTP cache when picked
        if (t.kind === 'file' || G.picks.includes(t)) t.buffer = buf;
        job.res(t);
      } catch (e){ t.failed = true; t.job = null; job.rej(e); }
      finally { running--; refreshRow(t); pump(); }
    })();
  }
}
// measured songs are remembered, so the hit list doesn't re-download and re-measure every visit
const AKEY = 'bpmBrawl.analysis.v1';
let acache = {};
try { acache = JSON.parse(localStorage.getItem(AKEY) || '{}') || {}; } catch {}
function saveAnalysis(t){
  acache[t.id] = { bpm:t.bpm, bpmExact:t.bpmExact, phase:t.phase, cursor:t.cursor, gain:t.gain, mass:t.mass };
  try { localStorage.setItem(AKEY, JSON.stringify(acache)); } catch {}
}
const fromCache = t => { if (!t.bpm && acache[t.id]) Object.assign(t, acache[t.id]); return t; };
const art = {};
function artImg(url){
  if (!url) return null;
  if (!art[url]){ const im = new Image(); im.crossOrigin = 'anonymous'; im.decoding = 'async'; im.src = url; art[url] = im; } // CORS so the LED wall texture stays usable in WebGL
  return art[url].complete && art[url].naturalWidth ? art[url] : null;
}
let previewNow = null;
function stopPreview(){
  if (!previewNow) return;
  if (previewNow.audio){ previewNow.audio.pause(); previewNow.audio.src = ''; }
  if (previewNow.player) previewNow.player.stop();
  const id = previewNow.id; previewNow = null; refreshRowById(id);
}
function togglePreview(t){
  initAudio();
  const same = previewNow && previewNow.id === t.id;
  stopPreview(); if (same) return;
  if (t.kind === 'remote'){ const a = new Audio(t.preview); a.volume = 0.8; a.play().catch(() => {}); a.onended = () => stopPreview(); previewNow = { id:t.id, audio:a }; }
  else { const p = makePlayer(t, musicBus); p.start(AC.currentTime + 0.05); previewNow = { id:t.id, player:p }; }
  refreshRowById(t.id);
}

/* =====================================================================
   GAME STATE
   ===================================================================== */
const G = {
  state:'title', mode:'2p', round:0, timer:ROUND_LEN, banner:null, hitstop:0, slowmo:1, shake:0, flash:0, impact:0, impactAt:null,
  mix:0, mixTarget:0, owner:0, picks:[null,null], pickOrder:[0,1], pickIdx:0, endT:0, koSide:-1, clockT:0, prevState:null,
  hype:0, zoomPunch:0, lastFirst:null, history:[[],[]], pickToken:0, strobe:0,
};
const cam = { x:W/2, z:1 };
let particles = [], texts = [], rings = [], lines = [], pyros = [], flares = [];
const fighters = [makeFighter(0), makeFighter(1)];
function makeFighter(side){
  return { side, x: side ? 860 : 420, y: GROUND, vx:0, kvx:0, vy:0, face: side ? -1 : 1, hp:MAX_HP, hpLag:MAX_HP,
    state:'idle', st:0, atk:null, cd:0, hitstun:0, blocking:false, walk:0, flash:0, combo:0, comboT:0, land:0,
    track:null, player:null, vol:null, pulse:0, P:null, sk:null, trail:[], trailT:0, scarf:null, judge:null,
    ear:{ prev:null, fast:0, slow:0, peak:0, last:0, lastV:0, rising:false, beat:null, hist:[] }, pending:null, lastSwing:0,
    stats:{ hits:0, crits:0, dmg:0, maxCombo:0, swings:0 } };
}
// hit strength: heavier songs do far more damage per second of music, whatever the tempo
const dpsFor = m => (0.3 + 3.2*Math.pow(m, 2.5))*30/ROUND_LEN;
const classOf = m => m >= 0.7 ? 'HEAVYWEIGHT' : m >= 0.45 ? 'MIDDLEWEIGHT' : 'LIGHTWEIGHT';
// fast songs: quicker, lighter hits and a tight beat window. slow songs: heavy hits and big crits.
// tuned so a mashing fast song and a well-timed slow song come out roughly even.
function statsFor(bpm){
  const p = bpm/120, heavy = Math.pow(p, -0.4);
  return { p, speed: 320*(0.72+0.28*p), slapDmg: 4.2*heavy, kickDmg: 9*heavy,
    slapCd: 0.46/Math.pow(p,0.65), kickCd: 0.95/Math.pow(p,0.65), kickStartup: 0.25/Math.pow(p,0.45),
    crit: clamp(1.3 + (165-bpm)/110, 1.3, 2.3), critWin: 0.13*60/bpm,
    style: bpm < 105 ? 'HEAVY HITTER' : bpm < 145 ? 'ALL-ROUNDER' : 'SPEED DEMON' };
}
const fBpm = f => f.track ? f.track.bpm : (f.side ? 150 : 128);
function beatPos(f){
  if (f.player && AC) return f.player.beatPos(audioNow());
  return (performance.now()/1000)*fBpm(f)/60 + f.side*0.37;
}
// names are letters, digits, spaces and . _ - only, so they are safe to drop into HTML
export const NAMES = ['', ''];
export const cleanName = v => String(v || '').replace(/[^\p{L}\p{M}\p{N} ._-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 12).toUpperCase();
export function setNames(a, b){ NAMES[0] = cleanName(a); NAMES[1] = cleanName(b); }
export const nameOf = s => s === 0 ? (NAMES[0] || 'MAGENTA') : (G.mode === 'cpu' ? 'CPU' : (NAMES[1] || 'CYAN'));
export const sideOf = s => s === 0 ? 'MAGENTA · LEFT' : 'CYAN · RIGHT';
export const isCPU = s => s === 1 && (G.mode === 'cpu' || G.state === 'title');

/* ---------------- keys: only pause and rematch. the songs do the fighting ---------------- */
addEventListener('keydown', e => {
  if (e.code === 'Escape'){ togglePause(); return; }
  if (e.target instanceof HTMLInputElement) return;
  if (e.code === 'KeyF') toggleFull();
  if (e.code === 'Enter' && G.state === 'result') rematch();
});

/* ---------------- the ear: each fighter listens to its own song ----------------
   spectral flux over the low and mid bins of that song alone (tapped before the speaker
   mute), peak-picked against a running average. every peak is a swing; bigger peaks swing harder. */
let spec = null;
function listen(f, dt){
  const E = f.ear; E.last += dt;
  if (!(f.an && f.player && AC && AC.state === 'running')){
    // no song (title screen demo): swing on a steady fake beat
    const b = Math.floor(beatPos(f));
    if (E.beat !== null && b !== E.beat && E.last > 0.2){ E.last = 0; f.pending = { str: b % 4 === 0 ? 1.6 : rand(0.8, 1.2), t:0 }; }
    E.beat = b; return;
  }
  if (!spec) spec = new Float32Array(f.an.frequencyBinCount);
  f.an.getFloatFrequencyData(spec);
  if (!E.prev) E.prev = new Float32Array(spec.length);
  let flux = 0;
  for (let k=1;k<48;k++){
    const m = spec[k] > -140 ? Math.pow(10, spec[k]/20) : 0, d = m - E.prev[k];
    if (d > 0) flux += d*(k < 6 ? 3 : 1);
    E.prev[k] = m;
  }
  E.fast += (flux - E.fast)*Math.min(1, dt*3);
  E.slow += (flux - E.slow)*Math.min(1, dt*0.4);
  const thr = Math.max(E.fast*1.35, E.slow*0.7, 1e-5);
  const ratio = flux/(E.slow || 1e-5);
  E.hist.push(Math.min(4, ratio)*0.8); if (E.hist.length > 120) E.hist.shift();
  // a peak is the frame where flux stops rising while above threshold
  if (E.rising && flux < E.lastV && E.lastV > thr && E.last > 0.14){
    E.last = 0;
    // strength is relative to this song's own typical beat, so only real drops stand out
    E.peak = E.peak ? E.peak + (E.lastV - E.peak)*0.12 : E.lastV;
    f.pending = { str: clamp(E.lastV/E.peak, 0.5, 2.5), t:0 };
    const h = E.hist, v = Math.max(1.2, h[h.length-1]); h[h.length-1] = f.pending.str >= 1.5 ? -(10 + v) : -v;
  }
  E.rising = flux >= E.lastV; E.lastV = flux;
}
// walking only: close in, keep a little space
function approach(f, o){
  const dist = Math.abs(o.x - f.x), dir = Math.sign(o.x - f.x) || 1;
  return dist > 112 ? dir : dist < 70 ? -dir : 0;
}

/* ---------------- combat ---------------- */
function startAttack(f, type, str){
  const S = statsFor(fBpm(f)), m = massOf(f.track);
  const live = G.state === 'fight';
  const drop = str >= 1.5;
  const slap = type === 'slap';
  f.atk = { type, t:0, startup: slap ? 0.07 : Math.min(0.16, S.kickStartup), active: slap ? 0.08 : 0.1, recovery: slap ? 0.1 : 0.16,
    dmg: dpsFor(m)*clamp(str, 0.6, 1.8), crit:drop, hit:false, whiffed:false };
  f.cd = 0.12;
  if (live){ f.stats.swings++; if (drop) f.judge = { text:'DROP', crit:true, t:0 }; }
  if (drop) spawnRing(f.x, GROUND, COL.gold, 1.2, false);
  // out of reach when the beat lands: lunge in
  const o = fighters[1 - f.side];
  if (Math.abs(o.x - f.x) > (slap ? 120 : 145)) f.kvx = f.face*(slap ? 520 : 640);
}
function tryHit(a, b){
  const A = a.atk, slap = A.type === 'slap', range = slap ? 128 : 152;
  const dx = (b.x - a.x)*a.face;
  if (dx < 5 || dx > range || Math.abs(a.y - b.y) > 120 || b.state === 'ko') return false;
  A.hit = true;
  // damage covers the music since the last landed hit, so busy songs don't win by swinging more
  const now = performance.now()/1000;
  A.dmg *= clamp(now - (a.lastSwing || now - 0.5), 0.15, 1.0); a.lastSwing = now;
  const cx = a.x + a.face*Math.min(dx, range)*0.62, cy = a.y - (slap ? 160 : 112);
  a.stats.dmg += A.dmg; a.stats.hits++; if (A.crit) a.stats.crits++;
  a.combo = a.comboT > 0 ? a.combo+1 : 1; a.comboT = 1.1; a.stats.maxCombo = Math.max(a.stats.maxCombo, a.combo);
  b.combo = 0;
  b.hitstun = slap ? 0.1 : 0.2; b.state = 'hit'; b.st = 0; b.flash = 0.12;
  b.kvx = a.face*(slap ? 280 : 640)*(A.crit ? 1.3 : 1);
  if (!slap && b.y >= GROUND) b.vy = A.crit ? -520 : -260;
  const col = A.crit ? COL.gold : SIDES[a.side].c;
  burst(cx, cy, col, A.crit ? 34 : 18, A.crit ? 900 : 600, 'spark');
  burst(cx, cy, '#ffffff', A.crit ? 10 : 5, 300, 'dot');
  spawnRing(cx, cy, col, slap ? 0.6 : 0.9, true);
  flares.push({ x:cx, y:cy, t:0, col:A.crit ? '255,210,63' : SIDES[a.side].glow, big:A.crit ? 1.7 : slap ? 0.8 : 1.1 });
  spawnText(cx, cy-34, (A.crit ? 'DROP ' : '') + A.dmg.toFixed(1), col, A.crit ? 40 : 30);
  if (a.combo >= 3) spawnText(a.x, a.y-260, a.combo + ' HIT COMBO', SIDES[a.side].c, 24);
  sfx(slap ? 'slap' : 'kick', cx); if (A.crit) sfx('crit', cx);
  G.hitstop = (slap ? 0.05 : 0.09) + (A.crit ? 0.04 : 0);
  G.shake = Math.max(G.shake, slap ? 7 : 15) * (A.crit ? 1.4 : 1);
  if ((A.crit || !slap) && G.state === 'fight'){ G.impact = A.crit ? 0.1 : 0.06; G.impactAt = { x:cx, y:cy, a:a.side }; lines.push({ x:cx, y:cy, t:0, col }); }
  // the 3D layer reads these for chromatic kick and shockwaves
  G.kick = Math.max(G.kick || 0, A.crit ? 1 : slap ? 0.35 : 0.6);
  if (A.crit) G.wave = { x:cx, y:cy, seq:(G.wave ? G.wave.seq : 0) + 1 };
  if (A.crit && G.state === 'fight'){ G.flash = 0.1; G.zoomPunch = 0.07; G.hype = 1; G.strobe = 0.25; }
  G.hype = Math.min(1, G.hype + 0.25);
  G.mixTarget = clamp(G.mixTarget + (a.side ? 1 : -1)*(A.crit ? 0.45 : 0.25), -1, 1);
  damage(b, A.dmg, a);
  return true;
}
function damage(b, amt, a){
  if (G.state === 'title') return;
  b.hp = Math.max(0, b.hp - amt);
  if (b.hp <= 0 && G.state === 'fight') knockout(b, a);
}
function knockout(b, a){
  G.state = 'ko'; G.endT = 0; G.koSide = b.side; G.slowmo = 0.25; G.koT = performance.now(); bump();
  b.state = 'ko'; b.st = 0; b.vy = -620; b.kvx = a.face*520; b.atk = null;
  setBanner('K.O.', COL.gold, 2.4); sfx('ko', b.x);
  burst(b.x, b.y-120, COL.gold, 70, 1000, 'spark'); confetti(160);
  pyros.push({ x:170, t:0 }, { x:W-170, t:0 });
  G.shake = 26; G.flash = 0.3; G.hype = 1; G.zoomPunch = 0.1; G.impact = 0.14; G.impactAt = { x:b.x, y:b.y-120, a:a.side };
  G.mixTarget = a.side ? 1 : -1;
}

function poseOf(f){
  const GF = [0.5, 2.45], GB = [0.25, 2.25], SF = [0.28, 0.05], SB = [-0.28, -0.12];
  const mixA = (a,b,t) => [lerp(a[0],b[0],t), lerp(a[1],b[1],t)];
  const P = { lean:0.1, crouch:f.pulse*5 + f.land*14, fa:[GF[0], GF[1] - f.pulse*0.15], ba:GB, fl:SF, bl:SB, palm:false, trail:0 };
  if (f.state === 'walk'){ const s = Math.sin(f.walk); P.fl = [0.1 + s*0.5, -0.05 + Math.max(0,s)*-0.6]; P.bl = [-0.1 - s*0.5, -0.05 + Math.max(0,-s)*-0.6]; P.lean = 0.16; }
  if (f.y < GROUND - 2 && !f.atk){ P.fl = [0.9, -0.3]; P.bl = [0.35, -0.9]; P.fa = [1.4, 2.9]; P.ba = [-0.6, 2.4]; }
  if (f.state === 'block'){ P.fa = [1.05, 3.0]; P.ba = [0.9, 2.9]; P.crouch = 14; P.lean = 0.2; P.fl = [0.4, -0.1]; }
  if (f.atk){
    const A = f.atk, t = A.t;
    if (A.type === 'slap'){
      const WIND = [3.4, 3.7], HIT = [1.6, 1.52];
      if (t < A.startup){ const u = t/A.startup; P.fa = mixA(GF, WIND, u); P.lean = lerp(0.1, -0.12, u); }
      else if (t < A.startup + A.active){ P.fa = HIT; P.lean = 0.32; P.palm = true; P.trail = 1 - (t - A.startup)/A.active; }
      else { const u = (t - A.startup - A.active)/A.recovery; P.fa = mixA(HIT, GF, u); P.lean = lerp(0.32, 0.1, u); P.palm = u < 0.3; P.trail = Math.max(0, 0.4 - u); }
      P.ba = [-0.4, 0.5];
    } else {
      const KNEE = [1.5, -0.2], OUT = [1.62, 1.6];
      if (t < A.startup){ const u = t/A.startup; P.fl = mixA(SF, KNEE, u); P.lean = lerp(0.1, -0.2, u); }
      else if (t < A.startup + A.active){ P.fl = OUT; P.lean = -0.38; P.trail = 1 - (t - A.startup)/A.active; }
      else { const u = (t - A.startup - A.active)/A.recovery; P.fl = mixA(OUT, SF, u); P.lean = lerp(-0.38, 0.1, u); P.trail = Math.max(0, 0.4 - u); }
      P.fa = [-0.5, 0.4]; P.ba = [-0.9, -0.2]; P.bl = [-0.05, -0.05];
    }
  }
  if (f.state === 'hit'){ P.lean = -0.5; P.fa = [-0.7, -0.3]; P.ba = [-1.0, -0.5]; P.fl = [0.5, 0.2]; }
  if (f.state === 'ko'){ P.lean = 0; P.fa = [2.6, 2.8]; P.ba = [-2.4, -2.6]; P.fl = [0.3, 0.3]; P.bl = [-0.3, -0.3]; P.crouch = 0; }
  return P;
}
const segP = (o, a, len) => ({ x:o.x + Math.sin(a)*len, y:o.y + Math.cos(a)*len });
function skeleton(P){
  const hip = { x:0, y:-96 + P.crouch };
  const up = (o, d) => ({ x:o.x + Math.sin(P.lean)*d, y:o.y - Math.cos(P.lean)*d });
  const sh = up(hip, 68), neck = up(sh, 10), head = up(neck, 20);
  const hf = { x:hip.x+4, y:hip.y }, hb = { x:hip.x-5, y:hip.y };
  const sf = { x:sh.x+5, y:sh.y+4 }, sb = { x:sh.x-7, y:sh.y+5 };
  const kf = segP(hf, P.fl[0], 48), ff = segP(kf, P.fl[1], 48);
  const kb = segP(hb, P.bl[0], 48), fb = segP(kb, P.bl[1], 48);
  const ef = segP(sf, P.fa[0], 38), wf = segP(ef, P.fa[1], 38);
  const eb = segP(sb, P.ba[0], 38), wb = segP(eb, P.ba[1], 38);
  return { hip, sh, neck, head, hf, hb, sf, sb, kf, ff, kb, fb, ef, wf, eb, wb };
}

function updateFighter(f, o, dt){
  const S = statsFor(fBpm(f));
  f.st += dt; f.flash = Math.max(0, f.flash - dt); f.cd -= dt; f.land = Math.max(0, f.land - dt*5);
  if (f.judge) f.judge.t += dt;
  if (f.comboT > 0){ f.comboT -= dt; if (f.comboT <= 0) f.combo = 0; }
  f.pulse = Math.max(Math.exp(-frac1(beatPos(f))*5)*0.6, f.pulse - dt*5);
  f.kvx *= Math.exp(-7*dt);
  const wasAir = f.y < GROUND - 1;
  f.vy += 2600*dt; f.y += f.vy*dt;
  const grounded = f.y >= GROUND;
  if (grounded){ f.y = GROUND; if (wasAir && f.vy > 400){ f.land = 1; burst(f.x, GROUND, '#8f78c4', 8, 200, 'dust'); } f.vy = 0; }
  if (f.state === 'ko'){ f.pending = null; f.x = clamp(f.x + f.kvx*dt, 70, W-70); finishFighter(f, dt); return; }
  const live = G.state === 'fight' || G.state === 'title';
  if (f.hitstun > 0) f.hitstun -= dt;
  if (f.pending && (f.pending.t += dt) > 0.25) f.pending = null;
  // the song swings, even mid-flinch: both fighters trade on their own beats
  if (f.atk){
    const A = f.atk; A.t += dt;
    if (live && A.t >= A.startup && A.t <= A.startup + A.active && !A.hit){
      if (!tryHit(f, o) && !A.whiffed && A.t > A.startup + A.active*0.5){ A.whiffed = true; sfx('whiff', f.x); }
    }
    if (f.atk && A.t >= A.startup + A.active + A.recovery) f.atk = null;
  }
  if (live && f.pending && !f.atk && f.cd <= 0){
    const p = f.pending; f.pending = null; f.pulse = 1;
    startAttack(f, p.str >= 1.15 ? 'kick' : 'slap', p.str);
  }
  const move = live && f.hitstun <= 0 && (!f.atk || !grounded) ? approach(f, o) : 0;
  if (!f.atk) f.face = o.x >= f.x ? 1 : -1;
  f.blocking = false;
  f.state = f.atk ? f.atk.type : f.hitstun > 0 ? 'hit' : !grounded ? 'jump' : move ? 'walk' : 'idle';
  f.vx = move*S.speed*(f.atk ? 0.4 : 1);
  if (move) f.walk += dt*S.speed/38*move*f.face;
  f.x = clamp(f.x + (f.vx + f.kvx)*dt, 90, W-90);
  finishFighter(f, dt);
}
// pose, afterimages and scarf physics, all derived after movement
function finishFighter(f, dt){
  f.P = poseOf(f); f.sk = skeleton(f.P);
  const fast = (f.atk && f.atk.t >= f.atk.startup && f.atk.t < f.atk.startup + f.atk.active + 0.05) || Math.abs(f.kvx) > 380 || f.state === 'ko';
  f.trailT -= dt;
  if (fast && f.trailT <= 0){ f.trail.push({ x:f.x, y:f.y, face:f.face, sk:f.sk, P:f.P, rot:koRot(f), life:0.2 }); f.trailT = 0.022; }
  f.trail = f.trail.filter(t => (t.life -= dt) > 0);
  const ax = f.x + (f.sk.neck.x - 4)*f.face, ay = f.y + f.sk.neck.y + 4;
  if (!f.scarf) f.scarf = Array.from({ length:7 }, (_, i) => ({ x:ax - f.face*i*9, y:ay + i*2, px:ax - f.face*i*9, py:ay + i*2 }));
  const s = f.scarf; s[0].x = ax; s[0].y = ay; s[0].px = ax; s[0].py = ay;
  const wind = -f.face*260 - (f.vx + f.kvx)*0.6;
  for (let i=1;i<s.length;i++){
    const p = s[i], vx = (p.x - p.px)*0.9, vy = (p.y - p.py)*0.9;
    p.px = p.x; p.py = p.y;
    p.x += vx + wind*dt*dt*8 + Math.sin(performance.now()/180 + i)*0.4; p.y += vy + 500*dt*dt;
  }
  for (let k=0;k<2;k++) for (let i=1;i<s.length;i++){
    const a = s[i-1], b = s[i], dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1, r = 10/d;
    b.x = a.x + dx*r; b.y = a.y + dy*r;
  }
}
const koRot = f => f.state === 'ko' ? -f.face*Math.min(1, f.st*2.5)*1.42 : 0;
// magenta (a) always stays left of cyan (b), so fighters never swap sides mid-round and
// always match their health bar, their name and their ear
function separate(a, b){
  const min = 74, d = b.x - a.x;
  if (d < min){
    const mid = clamp((a.x + b.x)/2, 90 + min/2, W - 90 - min/2);
    a.x = mid - min/2; b.x = mid + min/2;
  }
  a.face = 1; b.face = -1;
}

/* ---------------- effects ---------------- */
function burst(x, y, color, n, spd, type='dot'){
  for (let i=0;i<n;i++){
    const a = type === 'dust' ? Math.PI + Math.random()*Math.PI : Math.random()*Math.PI*2, v = spd*rand(0.25,1);
    particles.push({ type, x, y, vx:Math.cos(a)*v, vy:Math.sin(a)*v - (type === 'dust' ? 20 : 120), life:rand(0.3,0.7), max:0.7, color, size: type === 'dust' ? rand(8,16) : rand(2,5) });
  }
}
function confetti(n){
  const cols = [COL.p1, COL.p2, COL.gold, '#ffffff', '#9b6bff'];
  for (let i=0;i<n;i++) particles.push({ type:'confetti', x:rand(0,W), y:rand(-200,-10), vx:rand(-60,60), vy:rand(80,220), life:rand(2.5,4), max:4,
    color:pickOne(cols), size:rand(6,11), rot:rand(0,6), vr:rand(-8,8) });
}
function spawnRing(x, y, color, scale, air){ rings.push({ x, y, color, t:0, scale, air }); }
function spawnText(x, y, text, color, size){ texts.push({ x, y, text, color, size, t:0 }); }
function setBanner(text, color, dur, sub=''){ G.banner = { text, color, t:0, dur, sub }; }
export const toastState = { msg:'', id:0 };
function toast(msg){ toastState.msg = msg; toastState.id++; bump(); }

function sfx(type, x=W/2){
  if (!AC || G.state === 'title') return;
  const t = AC.currentTime, p = AC.createStereoPanner(); p.pan.value = clamp((x/W)*2-1, -1, 1)*0.6; p.connect(sfxBus);
  switch(type){
    case 'slap': noise(p,t,0.07,1.0,'bandpass',2600,0.8); noise(p,t,0.025,0.7,'highpass',5000); tone(p,t,130,0.06,0.5); break;
    case 'kick': tone(p,t,85,0.18,1.0); noise(p,t,0.13,0.7,'lowpass',900); noise(p,t,0.05,0.5,'bandpass',2000); break;
    case 'crit': tone(p,t,1568,0.3,0.16,'triangle'); tone(p,t+0.04,2349,0.3,0.12,'triangle'); break;
    case 'block': noise(p,t,0.06,0.6,'bandpass',700,2); tone(p,t,320,0.05,0.2,'square'); break;
    case 'whiff': noise(p,t,0.09,0.18,'bandpass',1100,1.5); break;
    case 'ko': tone(p,t,55,1.2,1.0); noise(p,t,0.6,0.5,'lowpass',400); tone(p,t,880,0.6,0.1,'triangle'); break;
    case 'tick': tone(p,t,880,0.08,0.15,'square'); break;
    case 'go': tone(p,t,1320,0.25,0.2,'square'); tone(p,t,660,0.25,0.2,'square'); noise(p,t,0.5,0.3,'highpass',3000); break;
    case 'pick': tone(p,t,660,0.06,0.15,'triangle'); tone(p,t+0.06,990,0.1,0.15,'triangle'); break;
    case 'swap': noise(p,t,0.35,0.25,'bandpass',900,0.6); tone(p,t,440,0.2,0.08,'sawtooth'); break;
  }
}

/* =====================================================================
   FLOW: title → pick (search) → VS → countdown → fight 20s → pick … → result
   ===================================================================== */
export function startMatch(mode, names){
  initAudio(); mixDiscard(); if (names) setNames(names[0], names[1]);
  G.mode = mode; G.round = 0; G.history = [[],[]]; G.koSide = -1; G.lastFirst = null;
  fighters.forEach((f,i) => Object.assign(f, makeFighter(i), { vol:f.vol, pre:f.pre, an:f.an }));
  fighters.forEach((f,i) => {
    if (f.vol) return;
    f.vol = AC.createGain(); f.vol.gain.value = 0;
    const pan = AC.createStereoPanner(); pan.pan.value = i ? 1 : -1; // earbuds: magenta left ear, cyan right ear
    f.vol.connect(pan); pan.connect(musicBus);
    f.pre = AC.createGain(); f.pre.connect(f.vol);
    f.an = AC.createAnalyser(); f.an.fftSize = 1024; f.an.smoothingTimeConstant = 0; f.pre.connect(f.an);
  });
  startPickPhase();
}
export const mix = { url:null, name:'' };
function mixStart(){
  if (!mixDest) return;
  try {
    if (!mixRec){ mixChunks = []; mixRec = new MediaRecorder(mixDest.stream); mixRec.ondataavailable = e => { if (e.data.size) mixChunks.push(e.data); }; mixRec.start(1000); }
    else if (mixRec.state === 'paused') mixRec.resume();
  } catch { mixRec = null; }
}
function mixPause(){ try { if (mixRec && mixRec.state === 'recording') mixRec.pause(); } catch {} }
function mixFinish(){
  mix.url = null;
  if (!mixRec) return;
  const rec = mixRec; mixRec = null;
  rec.onstop = () => {
    if (!mixChunks.length) return;
    if (mixUrl) URL.revokeObjectURL(mixUrl);
    const type = rec.mimeType || 'audio/webm';
    mixUrl = URL.createObjectURL(new Blob(mixChunks, { type }));
    mix.url = mixUrl; mix.name = `${nameOf(0)} vs ${nameOf(1)} - BPM Brawl mix.${type.includes('mp4') ? 'm4a' : 'webm'}`;
    bump();
  };
  try { rec.stop(); } catch {}
}
function mixDiscard(){ mix.url = null; if (mixRec){ mixRec.onstop = null; try { mixRec.stop(); } catch {} mixRec = null; } }
function stopMusic(){ fighters.forEach(f => { if (f.player){ f.player.stop(); f.player = null; } }); }

function startPickPhase(){
  stopMusic(); mixPause();
  G.round++; G.state = 'pick'; G.picks = [null,null];
  let first, reason;
  if (G.round === 1){ first = Math.random() < 0.5 ? 0 : 1; reason = 'Coin flip'; }
  else { first = G.lastFirst === 0 ? 1 : 0; reason = 'Turns alternate'; }
  G.lastFirst = first; G.firstReason = reason;
  G.pickOrder = [first, 1-first]; G.pickIdx = 0;
  openPickTurn(); pump();
}
// everything the song picker shows
export const PK = { timer:PICK_TIME, shown:PICK_TIME, tab:'hits', hl:null, locking:false, query:'', hint:'', cpu:false };
export const pickWho = () => G.pickOrder[G.pickIdx];
function openPickTurn(){
  const who = pickWho(), cpu = isCPU(who);
  const tok = ++G.pickToken;
  PK.timer = PICK_TIME; PK.shown = PICK_TIME; PK.hl = null; PK.locking = false; PK.cpu = cpu;
  stopPreview();
  // wipe the last picker's search so the next player can't see what they looked at
  lastResults = []; lastQuery = ''; searchState = 'idle'; PK.query = ''; PK.tab = 'hits';
  PK.hint = cpu ? 'Watch the CPU dig through the crates…' : 'Press ▶ to preview a song, then Pick to lock it in.';
  loadHits(); queueHits();
  if (cpu) cpuPick(tok);
  bump();
}
export function setTab(tab){
  PK.tab = tab;
  if (tab === 'hits') queueHits();
  bump();
}
export function setQuery(q){ PK.query = q; bump(); }

export const CHIPS = ['Devi Sri Prasad','Thaman S','Anirudh Ravichander','Sid Sriram','Daft Punk','The Weeknd','Skrillex','Arijit Singh','Diljit Dosanjh','AP Dhillon','Eminem','Drake','Phonk','Avicii','Pendulum','Bad Bunny','BTS','Linkin Park'];
const CPU_SEEDS = ['Devi Sri Prasad','Thaman S','Skrillex','Pendulum','The Prodigy','Martin Garrix','Phonk','Noisia','Knife Party','Calvin Harris','Daft Punk','Eminem','Avicii','Marshmello'];

export async function doSearch(q){
  initAudio();
  lastQuery = q; PK.query = q; searchState = 'loading'; bump();
  try {
    const res = await searchSongs(q);
    if (q !== lastQuery) return;
    lastResults = res; searchState = 'ok';
    dropQueued(new Set(res.slice(0, 12)));
    res.slice(0, 12).forEach(t => ensureAnalyzed(t));
  } catch (e){
    if (q !== lastQuery) return;
    searchState = 'error';
    searchError = "Couldn't reach the music search. Check your internet connection and try again, or pick from Studio beats.";
  }
  bump();
}
// studio beats are synthesized at their BPM, so only real audio can be re-read at half or double time
export const canHalf = t => t.kind !== 'synth' && t.bpm && t.bpm/2 >= 60;
export const canDouble = t => t.kind !== 'synth' && t.bpm && t.bpm*2 <= 210;
export const library = () => ({ hitsState, hitTracks, searchState, searchError, lastResults, lastQuery, uploads, studio:STUDIO, sections:HIT_SECTIONS, previewId: previewNow ? previewNow.id : null });
function refreshRow(){ bump(); }
function refreshRowById(){ bump(); }
// beat phase stays valid: double time adds beats between the old ones, half time keeps every other one
export function setOctave(t, k){
  if (k > 1 ? !canDouble(t) : !canHalf(t)) return;
  t.bpmExact *= k; t.bpm = Math.round(t.bpmExact); sfx('pick'); bump();
}
export function keepLast(){ const t = fighters[pickWho()].track; if (t) lockPick(t); }
export async function addFiles(files){
  initAudio();
  for (const file of files){
    const t = { id:'u' + Math.random().toString(36).slice(2), kind:'file', name:file.name.replace(/\.[^.]+$/,'').slice(0,60), artist:'Your file', genre:'', hue:48 };
    REG.set(t.id, t); uploads.push(t); bump();
    try { t.buffer = await AC.decodeAudioData(await file.arrayBuffer()); await ensureAnalyzed(t); }
    catch { t.failed = true; toast(`${file.name} could not be read. Try an MP3 or WAV.`); }
    bump();
  }
}

export async function lockPick(t){
  if (PK.locking || G.state !== 'pick') return;
  const who = pickWho();
  const tok = G.pickToken;
  PK.locking = true; PK.hl = t.id; bump();
  const fail = () => { PK.locking = false; if (tok === G.pickToken){ toast("Couldn't load this song. Pick another one."); PK.hint = 'Pick another song.'; bump(); } };
  if (!t.bpm){
    PK.hint = `Measuring the beat of ${t.name}…`; bump();
    try { await ensureAnalyzed(t, true); } catch { fail(); return; }
  }
  if (!t.buffer && t.kind === 'remote'){
    PK.hint = `Loading ${t.name}…`; bump();
    try { t.buffer = await fetchBuffer(t); } catch { fail(); return; }
  }
  if (tok !== G.pickToken || G.state !== 'pick') return;
  stopPreview();
  G.picks[who] = t; G.history[who].push(t); sfx('pick');
  G.pickIdx++;
  if (G.pickIdx >= 2) showVS();
  else { if (!isCPU(who)) toast(`${nameOf(who)} locked in. ${nameOf(1-who)}'s turn.`); openPickTurn(); }
}
function autoPick(){
  const who = pickWho(), last = fighters[who].track;
  const ok = t => t.bpm;
  const cand = lastResults.filter(ok), hits = hitTracks.filter(ok);
  const t = cand[0] || (last && ok(last) ? last : null) || (hits.length ? pickOne(hits) : pickOne(STUDIO));
  toast(`Time's up. ${nameOf(who)} gets ${t.name}.`);
  lockPick(t);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function cpuPick(tok){
  setTab('search');
  const alive = () => tok === G.pickToken && G.state === 'pick';
  let pool = [];
  const q = pickOne(CPU_SEEDS);
  PK.query = '';
  for (const ch of q){ await sleep(70); if (!alive()) return; PK.query += ch; bump(); }
  await sleep(250); if (!alive()) return;
  await doSearch(q); if (!alive()) return;
  if (searchState === 'ok' && lastResults.length){
    const top = lastResults.slice(0, 6);
    await Promise.race([Promise.allSettled(top.map(t => ensureAnalyzed(t))), sleep(9000)]);
    if (!alive()) return;
    pool = top.filter(t => t.bpm);
  }
  if (!pool.length){ setTab('studio'); pool = STUDIO.slice(); }
  const t = pickOne(pool);
  PK.hl = t.id; bump();
  await sleep(900); if (!alive()) return;
  lockPick(t);
}

function showVS(){
  G.state = 'vs'; sfx('swap'); bump();
  setTimeout(() => { if (G.state === 'vs'){ beginRound(); bump(); } }, 2300);
}
function beginRound(){
  const [a,b] = fighters;
  a.track = G.picks[0]; b.track = G.picks[1];
  a.x = 420; b.x = 860; a.y = b.y = GROUND;
  [a,b].forEach(f => { f.vy = 0; f.kvx = 0; f.atk = null; f.hitstun = 0; f.state = 'idle'; f.cd = 0; f.combo = 0; f.scarf = null; f.trail = []; f.judge = null; f.pending = null; f.ear = makeFighter(f.side).ear; });
  const when = AC.currentTime + 0.12;
  fighters.forEach(f => { f.player = makePlayer(f.track, f.pre); f.player.start(when); });
  mixStart();
  G.owner = Math.round(a.hp) === Math.round(b.hp) ? (a.track.bpm <= b.track.bpm ? 0 : 1) : (a.hp < b.hp ? 0 : 1);
  G.mix = G.mixTarget = G.owner ? 0.6 : -0.6;
  G.state = 'countdown'; G.clockT = 0; G.timer = ROUND_LEN; G.lastTick = 4;
}
function endRound(){
  G.state = 'roundEnd'; G.endT = 0;
  setBanner('TIME!', COL.text, 2.0, G.round >= MAX_ROUNDS ? 'FINAL DECISION' : 'PICK YOUR NEXT SONG');
}
export const result = { win:-1, ko:false };
function showResult(){
  stopMusic(); mixFinish(); G.state = 'result';
  const [a,b] = fighters, ko = G.koSide >= 0;
  result.ko = ko;
  result.win = ko ? 1 - G.koSide : (Math.round(a.hp) === Math.round(b.hp) ? -1 : (a.hp > b.hp ? 0 : 1));
  if (result.win >= 0) confetti(220);
  bump();
}
export function rematch(){ startMatch(G.mode); }
export function toMenu(){
  stopMusic(); stopPreview(); mixDiscard(); G.pickToken++;
  if (AC && AC.state === 'suspended') AC.resume();
  G.state = 'title'; G.banner = null; G.koSide = -1;
  fighters.forEach((f,i) => Object.assign(f, makeFighter(i), { vol:f.vol, pre:f.pre, an:f.an }));
  bump();
}
export function togglePause(){
  if (G.state === 'paused'){ G.state = G.prevState; AC && AC.resume(); }
  else if (['fight','countdown'].includes(G.state)){ G.prevState = G.state; G.state = 'paused'; AC && AC.suspend(); }
  bump();
}
export function toggleFull(){
  const d = document;
  if (d.fullscreenElement || d.webkitFullscreenElement) (d.exitFullscreen || d.webkitExitFullscreen).call(d);
  else { const el = d.documentElement; (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el); }
}
export { togglePreview };

/* =====================================================================
   MAIN LOOP
   ===================================================================== */
let last = performance.now();
const perf = { ema:1/60, slowT:0 };
function frame(now){
  const raw = (now - last)/1000, dt = Math.min(0.05, raw); last = now;
  if (!document.hidden && raw < 0.5){
    perf.ema += (raw - perf.ema)*0.05;
    perf.slowT = perf.ema > 1/45 ? perf.slowT + raw : 0;
    if (perf.slowT > 1.5 && quality < RES_CAP.length - 1){ quality++; perf.slowT = 0; perf.ema = 1/60; resize(); bump(); }
  }
  if (G.state !== 'paused') update(dt);
  render(now/1000);
  requestAnimationFrame(frame);
}
function update(rdt){
  if (G.state === 'pick' && !isCPU(G.pickOrder[G.pickIdx]) && !PK.locking){
    PK.timer -= rdt;
    const shown = Math.max(0, Math.ceil(PK.timer));
    if (shown !== PK.shown){ PK.shown = shown; bump(); }
    if (PK.timer <= 0) autoPick();
  }
  G.impact = Math.max(0, G.impact - rdt);
  // ears run in real time, even through hit-stop, so no beat is missed
  if (['fight','countdown','title'].includes(G.state)) fighters.forEach(f => { listen(f, rdt); if (G.state === 'countdown') f.pending = null; });
  if (G.hitstop > 0){ G.hitstop -= rdt; tickFx(rdt*0.2); return; }
  if (G.state === 'ko') G.slowmo = Math.min(1, G.slowmo + rdt*0.5);
  const dt = rdt*(G.state === 'ko' ? G.slowmo : 1);
  const [a,b] = fighters;
  if (G.state === 'countdown'){
    G.clockT += dt; const n = 3 - Math.floor(G.clockT);
    if (n !== G.lastTick && n >= 1){ G.lastTick = n; setBanner(String(n), COL.text, 0.9); sfx('tick'); }
    if (G.clockT >= 3){ bump(); G.state = 'fight'; fighters.forEach(f => f.lastSwing = performance.now()/1000); setBanner('BRAWL!', COL.gold, 0.9); sfx('go'); pyros.push({ x:170, t:0 }, { x:W-170, t:0 }); G.hype = 1; }
  }
  updateFighter(a, b, dt);
  updateFighter(b, a, dt);
  separate(a, b);
  if (G.state === 'title') fighters.forEach(f => f.hp = MAX_HP);
  if (G.state === 'fight'){ G.timer -= dt; if (G.timer <= 0){ G.timer = 0; endRound(); } }
  if (G.state === 'roundEnd'){ G.endT += rdt; if (G.endT > 2.0){ if (G.round >= MAX_ROUNDS) showResult(); else startPickPhase(); } }
  if (G.state === 'ko'){ G.endT += rdt; if (G.endT > 3.4) showResult(); }
  fighters.forEach(f => { f.hpLag = f.hpLag > f.hp ? Math.max(f.hp, f.hpLag - rdt*(f.hpLag - f.hp < 3 ? 6 : 22)) : f.hp; });
  // speaker takeover: one song plays at a time; landing hits wins the speakers
  G.mix += (G.mixTarget - G.mix)*Math.min(1, rdt*3);
  if (['fight','countdown'].includes(G.state)){
    const prev = G.owner;
    if (G.owner === 0 && G.mix > 0.3) G.owner = 1; else if (G.owner === 1 && G.mix < -0.3) G.owner = 0;
    if (prev !== G.owner){ spawnText(W/2, 200, `${nameOf(G.owner)} LEADS THE CROWD`, SIDES[G.owner].c, 30); sfx('swap'); G.strobe = 0.3; }
  }
  // both songs play together, each in its own ear. only touch the gain when it changes
  if (AC && fighters[0].vol){
    const v = ['countdown','fight','ko','roundEnd'].includes(G.state) ? 0.8 : 0;
    fighters.forEach(f => { if (f.volOn !== v){ f.volOn = v; f.vol.gain.setTargetAtTime(v, AC.currentTime, 0.12); } });
  }
  // camera frames both fighters and leans in when they're close
  const mid = (a.x + b.x)/2, dist = Math.abs(a.x - b.x);
  G.zoomPunch *= Math.exp(-rdt*6);
  const tz = clamp(1.2 - dist/1500, 1, 1.16) + G.zoomPunch;
  cam.z += (tz - cam.z)*Math.min(1, rdt*3);
  const half = W/2/cam.z;
  cam.x += (clamp(mid, half, W - half) - cam.x)*Math.min(1, rdt*4);
  G.hype = Math.max(0, G.hype - rdt*0.35);
  G.strobe = Math.max(0, G.strobe - rdt);
  tickFx(rdt);
}
function tickFx(dt){
  G.shake = Math.max(0, G.shake - dt*60); G.flash = Math.max(0, G.flash - dt);
  for (const p of pyros){ p.t += dt; if (p.t < 0.7) for (let k=0;k<4;k++) particles.push({ type:'flame', x:p.x + rand(-14,14), y:GROUND+40, vx:rand(-40,40), vy:rand(-900,-600), life:rand(0.4,0.8), max:0.8, color:pickOne(['#ffd23f','#ff8a1f','#ff4a1f']), size:rand(10,22) }); }
  pyros = pyros.filter(p => p.t < 1.6);
  particles = particles.filter(p => (p.life -= dt) > 0);
  for (const p of particles){
    p.x += p.vx*dt; p.y += p.vy*dt;
    if (p.type === 'spark'){ p.vy += 1500*dt; p.vx *= 0.97; }
    else if (p.type === 'dot'){ p.vy += 900*dt; p.vx *= 0.98; }
    else if (p.type === 'dust'){ p.vx *= 0.9; p.vy *= 0.9; p.size += dt*20; }
    else if (p.type === 'flame'){ p.vy *= 0.96; p.size *= 0.985; }
    else if (p.type === 'confetti'){ p.vx += Math.sin(p.life*6 + p.size)*20*dt; p.rot += p.vr*dt; }
  }
  if (particles.length > 450) particles.splice(0, particles.length - 450);
  rings = rings.filter(r => (r.t += dt) < 0.5*r.scale + 0.2);
  texts = texts.filter(t => (t.t += dt) < 1.0);
  lines = lines.filter(l => (l.t += dt) < 0.28);
  flares = flares.filter(f => (f.t += dt) < 0.24);
  if (G.banner && (G.banner.t += dt) > G.banner.dur) G.banner = null;
}

/* =====================================================================
   RENDER
   ===================================================================== */
const FONT = s => `${s}px Bungee, Impact, "Arial Black", sans-serif`;
const BODY = (s,w=700) => `${w} ${s}px "Chakra Petch", "Segoe UI", sans-serif`;
function domSide(){ return ['fight','countdown','ko','roundEnd'].includes(G.state) ? G.owner : (G.mix > 0 ? 1 : 0); }
let stage3d = null, frameNo = 0;
export function attachStage(s){ stage3d = s; return () => { if (stage3d === s) stage3d = null; }; }
function render(time){
  if (AC) analyser.getByteFrequencyData(freqData);
  frameNo++;
  const use3d = !!(stage3d && !stage3d.dead);
  ctx.setTransform(1,0,0,1,0,0);
  if (use3d) ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
  const sx = G.shake ? rand(-G.shake, G.shake)*0.6 : 0, sy = G.shake ? rand(-G.shake, G.shake)*0.6 : 0;
  // behind menus the stage only needs 30 fps
  if (use3d && !(['pick','vs','result'].includes(G.state) && frameNo % 2)){
    G.sx = sx; G.sy = sy;
    try { stage3d.draw(time, sx, sy); } catch (e){ stage3d.dead = true; console.warn('3D stage off:', e); bump(); }
  }
  if (G.impact > 0 && G.impactAt){ drawImpactFrame(time); }
  else {
    ctx.save(); ctx.translate(sx, sy);
    if (!use3d) drawFar(time);
    ctx.save(); worldTransform();
    if (!use3d) drawFloor(time);
    drawReflections(use3d);
    if (!use3d) drawSpeakers(time);
    fighters.forEach(drawShadow);
    rings.filter(r => !r.air).forEach(drawRing);
    fighters.forEach(drawBeatRing);
    [...fighters].sort((x,y) => (x.state === 'ko') - (y.state === 'ko') || (x.atk ? 1 : 0) - (y.atk ? 1 : 0)).forEach(f => { drawTrail(f); drawFighter(f, 'full'); });
    rings.filter(r => r.air).forEach(drawRing);
    drawLines(); drawFlares(); drawParticles(); drawTexts();
    ctx.restore();
    drawCrowd(time);
    ctx.restore();
    if (quality < 2) bloom();
  }
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.drawImage(vigC, 0, 0, W, H);
  if (quality < 1){ ctx.save(); ctx.globalAlpha = 0.022; ctx.translate(rand(0,256), rand(0,256)); ctx.fillStyle = grainPat; ctx.fillRect(-256,-256,W+512,H+512); ctx.restore(); }
  if (G.flash > 0){ ctx.fillStyle = `rgba(255,244,214,${Math.min(0.8, G.flash*1.8)})`; ctx.fillRect(0,0,W,H); }
  if (!['title','pick','vs'].includes(G.state)) drawHUD(time);
  drawBanner();
  if (G.state === 'paused'){ ctx.fillStyle = 'rgba(6,2,12,.5)'; ctx.fillRect(0,0,W,H); }
}
function worldTransform(){
  const py = GROUND - 120;
  ctx.translate(W/2, py); ctx.scale(cam.z, cam.z); ctx.translate(-cam.x, -py);
}
function bloom(){
  if (canBlur){
    g1x.clearRect(0, 0, 400, 225);
    g1x.globalCompositeOperation = 'source-over'; g1x.drawImage(cv, 0, 0, 400, 225);
    g1x.globalCompositeOperation = 'multiply'; g1x.drawImage(g1, 0, 0); // squaring keeps only bright areas
    g1x.globalCompositeOperation = 'source-over';
    g2x.clearRect(0, 0, 400, 225); g2x.filter = 'blur(6px)'; g2x.drawImage(g1, 0, 0); g2x.filter = 'none';
    ctx.setTransform(1,0,0,1,0,0); ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 1; ctx.drawImage(g2, 0, 0, cv.width, cv.height);
    ctx.globalAlpha = 0.35; ctx.drawImage(g1, 0, 0, cv.width, cv.height);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.setTransform(dpr,0,0,dpr,0,0);
    return;
  }
  // clear first: over the 3D stage the main canvas is transparent and would otherwise smear
  b1x.clearRect(0, 0, 320, 180); b2x.clearRect(0, 0, 160, 90); b3x.clearRect(0, 0, 80, 45);
  b1x.globalCompositeOperation = 'source-over'; b1x.drawImage(cv, 0, 0, 320, 180);
  b1x.globalCompositeOperation = 'multiply'; b1x.drawImage(b1, 0, 0); // squaring keeps only bright areas
  b1x.globalCompositeOperation = 'source-over';
  b2x.drawImage(b1, 0, 0, 160, 90); b3x.drawImage(b2, 0, 0, 80, 45);
  ctx.setTransform(1,0,0,1,0,0);
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.55; ctx.drawImage(b2, 0, 0, cv.width, cv.height);
  ctx.globalAlpha = 0.75; ctx.drawImage(b3, 0, 0, cv.width, cv.height);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  ctx.setTransform(dpr,0,0,dpr,0,0);
}

/* ---------- far layer: sky, LED wall, towers, truss, beams ---------- */
function drawFar(time){
  ctx.save();
  const par = 0.3;
  ctx.translate(W/2, HORIZON); ctx.scale(1 + (cam.z-1)*par, 1 + (cam.z-1)*par); ctx.translate(-W/2 - (cam.x - W/2)*par, -HORIZON);
  const g = ctx.createLinearGradient(0,0,0,HORIZON); g.addColorStop(0,'#040108'); g.addColorStop(1,'#170828');
  ctx.fillStyle = g; ctx.fillRect(-200,-100,W+400,HORIZON+100);
  const ds = domSide(), dcol = SIDES[ds].c, df = fighters[ds], dpulse = df.pulse;
  // haze
  ctx.globalCompositeOperation = 'lighter';
  for (let i=0;i<3;i++){
    const hx = W/2 + Math.sin(time*0.13 + i*2.1)*420, hy = 250 + Math.cos(time*0.1 + i)*60;
    const hg = ctx.createRadialGradient(hx,hy,0,hx,hy,380);
    hg.addColorStop(0, i === 1 ? 'rgba(25,227,255,.07)' : 'rgba(255,47,146,.07)'); hg.addColorStop(1,'rgba(0,0,0,0)');
    ctx.fillStyle = hg; ctx.fillRect(hx-380,hy-380,760,760);
  }
  ctx.globalCompositeOperation = 'source-over';
  // LED wall
  const wx = 380, wy = 64, ww = 520, wh = 244;
  ctx.fillStyle = '#020005'; ctx.fillRect(wx-10, wy-10, ww+20, wh+20);
  drawLedContent(time, ds);
  ctx.imageSmoothingEnabled = false;
  ctx.globalAlpha = 0.72 + dpulse*0.28;
  ctx.drawImage(ledC, wx, wy, ww, wh);
  ctx.imageSmoothingEnabled = true; ctx.globalAlpha = 1;
  ctx.save(); ctx.translate(wx, wy); ctx.fillStyle = ledPat; ctx.scale(ww/LEDW/8, wh/LEDH/8); ctx.fillRect(0,0,LEDW*8,LEDH*8); ctx.restore();
  ctx.strokeStyle = '#2a1840'; ctx.lineWidth = 3; ctx.strokeRect(wx-10, wy-10, ww+20, wh+20);
  // now-playing marquee
  const tr = df.track, label = tr ? `CROWD FAVOURITE ✦ ${tr.name.toUpperCase()} ✦ ${tr.artist.toUpperCase()} ✦ MASS ${massPct(tr)} ✦ ` : 'BPM BRAWL ✦ THE HEAVIER SONG WINS ✦ PICK A SONG ✦ LET IT FIGHT ✦ ';
  ctx.save(); ctx.beginPath(); ctx.rect(wx, wy+wh+16, ww, 26); ctx.clip();
  ctx.fillStyle = '#0a0414'; ctx.fillRect(wx, wy+wh+16, ww, 26);
  ctx.font = FONT(15); ctx.fillStyle = dcol; ctx.textBaseline = 'middle';
  const tw = ctx.measureText(label).width, off = (time*90) % tw;
  for (let x = wx - off; x < wx + ww; x += tw) ctx.fillText(label, x, wy+wh+30);
  ctx.restore();
  // side towers with each fighter's BPM
  fighters.forEach((f,i) => {
    const tx = i ? 935 : 205, col = SIDES[i].c;
    ctx.fillStyle = '#07030d'; ctx.fillRect(tx, 140, 140, 230);
    ctx.strokeStyle = '#24143a'; ctx.lineWidth = 2; ctx.strokeRect(tx, 140, 140, 230);
    ctx.textAlign = 'center'; ctx.fillStyle = col; ctx.globalAlpha = 0.55 + f.pulse*0.45;
    ctx.font = FONT(54); ctx.fillText(fBpm(f), tx+70, 204);
    ctx.font = FONT(14); ctx.globalAlpha = 0.8; ctx.fillText('BPM', tx+70, 228);
    // VU ladder
    const lvl = freqData && AC && ['fight','countdown','ko','roundEnd'].includes(G.state) ? (i === G.owner ? (freqData[4]/255) : 0.12) : 0.25 + f.pulse*0.5;
    for (let k=0;k<8;k++){
      const on = k/8 < lvl*(0.75 + f.pulse*0.35);
      ctx.globalAlpha = on ? 0.95 : 0.12; ctx.fillStyle = k > 6 ? '#ffffff' : col;
      ctx.fillRect(tx+30, 350 - k*14, 80, 9);
    }
    ctx.globalAlpha = 1;
  });
  // backline riser
  ctx.fillStyle = '#0b0517'; ctx.fillRect(-200, 352, W+400, HORIZON-352);
  for (let i=0;i<34;i++){ ctx.fillStyle = i%2 ? SIDES[1].c : SIDES[0].c; ctx.globalAlpha = 0.25 + 0.5*Math.max(0, Math.sin(time*4 + i*0.7)); ctx.fillRect(-120 + i*45, 372, 6, 3); }
  ctx.globalAlpha = 1;
  // truss + moving heads + beams
  ctx.fillStyle = '#120a1e'; ctx.fillRect(-200, 18, W+400, 16);
  ctx.strokeStyle = '#2a1a40'; ctx.lineWidth = 1.5; ctx.beginPath();
  for (let x=-200;x<W+200;x+=24){ ctx.moveTo(x,18); ctx.lineTo(x+12,34); ctx.lineTo(x+24,18); } ctx.stroke();
  ctx.globalCompositeOperation = 'lighter';
  for (let i=0;i<8;i++){
    const side = i < 4 ? 0 : 1, f = fighters[side], lx = 120 + i*148;
    const sweep = Math.sin(time*0.8 + i*1.3)*0.38 + (side ? -0.12 : 0.12);
    const owner = ['fight','countdown','ko','roundEnd'].includes(G.state) ? (side === G.owner ? 1 : 0.35) : 0.7;
    const inten = (0.05 + f.pulse*0.08)*owner + G.strobe*0.25;
    const len = 560, ang = Math.PI/2 + sweep, sp = 0.11;
    const ex1 = lx + Math.cos(ang - sp)*len, ey1 = 30 + Math.sin(ang - sp)*len;
    const ex2 = lx + Math.cos(ang + sp)*len, ey2 = 30 + Math.sin(ang + sp)*len;
    const bg = ctx.createLinearGradient(lx, 30, (ex1+ex2)/2, (ey1+ey2)/2);
    const c = G.strobe > 0.15 ? '255,255,255' : side ? '25,227,255' : '255,47,146';
    bg.addColorStop(0, `rgba(${c},${Math.min(0.6, inten*3)})`); bg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = bg; ctx.beginPath(); ctx.moveTo(lx, 30); ctx.lineTo(ex1, ey1); ctx.lineTo(ex2, ey2); ctx.closePath(); ctx.fill();
    ctx.fillStyle = `rgba(${c},${0.5 + f.pulse*0.5})`; ctx.beginPath(); ctx.arc(lx, 36, 5, 0, Math.PI*2); ctx.fill();
  }
  if (quality < 2) for (const m of MOTES){
    const x = ((m.x + time*m.vx) % (W+400) + W+400) % (W+400) - 200, y = m.y + Math.sin(time*m.f + m.ph)*18;
    ctx.globalAlpha = (0.18 + 0.22*Math.sin(time*2 + m.ph)**2)*(0.6 + G.hype*0.6);
    ctx.fillStyle = m.c; ctx.beginPath(); ctx.arc(x, y, m.s, 0, Math.PI*2); ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.restore();
}
const MOTES = Array.from({ length:40 }, () => ({ x:rand(0,W+400), y:rand(40,420), vx:rand(-14,14), f:rand(0.3,0.9), ph:rand(0,6.28), s:rand(0.8,2.2), c:pickOne(['#ffffff','#ffb3d8','#b6f6ff','#ffe7a1']) }));
function drawLedContent(time, ds){
  const f = fighters[ds], t = f.track, img = t && artImg(t.art);
  ledX.fillStyle = '#000'; ledX.fillRect(0,0,LEDW,LEDH);
  if (img){
    const s = LEDW/img.naturalWidth, h = img.naturalHeight*s;
    ledX.drawImage(img, 0, (LEDH - h)/2 - Math.sin(time*0.2)*4, LEDW, h);
    ledX.fillStyle = SIDES[ds].c; ledX.globalAlpha = 0.12 + f.pulse*0.12; ledX.fillRect(0,0,LEDW,LEDH); ledX.globalAlpha = 1;
  } else {
    // spectrum + tempo rings when there is no album art
    const cx = LEDW/2, cy = LEDH/2, ph = frac1(beatPos(f));
    ledX.strokeStyle = SIDES[ds].c; ledX.lineWidth = 1.5;
    for (let k=0;k<3;k++){ const r = ((ph + k/3) % 1)*36; ledX.globalAlpha = 1 - r/36; ledX.beginPath(); ledX.arc(cx, cy, r, 0, Math.PI*2); ledX.stroke(); }
    ledX.globalAlpha = 1;
    for (let i=0;i<LEDW;i++){
      const v = freqData && AC ? freqData[Math.floor(2 + (i/LEDW)*60)]/255 : (Math.sin(time*3 + i*0.4)*0.5+0.5)*0.4;
      const h = v*LEDH*0.9; ledX.fillStyle = i < LEDW/2 ? SIDES[0].c : SIDES[1].c; ledX.globalAlpha = 0.85;
      ledX.fillRect(i, LEDH - h, 1, h);
    }
    ledX.globalAlpha = 1;
    ledX.fillStyle = '#fff'; ledX.font = '700 9px "Chakra Petch", sans-serif'; ledX.textAlign = 'center'; ledX.textBaseline = 'middle';
    ledX.fillText(t ? t.genre.toUpperCase() : 'BPM BRAWL', cx, 8);
  }
}

/* ---------- floor, reflections, speakers ---------- */
function drawFloor(time){
  const g = ctx.createLinearGradient(0,HORIZON,0,H+80);
  g.addColorStop(0,'#1a0a2e'); g.addColorStop(0.35,'#0c0518'); g.addColorStop(1,'#030106');
  ctx.fillStyle = g; ctx.fillRect(-300,HORIZON,W+600,H-HORIZON+120);
  const vx = W/2, vy = HORIZON - 160;
  ctx.save(); ctx.beginPath(); ctx.rect(-300,HORIZON,W+600,H-HORIZON+120); ctx.clip();
  ctx.lineWidth = 1.2;
  for (let i=-18;i<=18;i++){
    const xb = W/2 + i*95;
    ctx.strokeStyle = i < 0 ? SIDES[0].c : i > 0 ? SIDES[1].c : '#8a6bc9'; ctx.globalAlpha = 0.14;
    ctx.beginPath(); ctx.moveTo(vx + (xb - vx)*((HORIZON - vy)/(H + 60 - vy)), HORIZON); ctx.lineTo(xb, H + 60); ctx.stroke();
  }
  const df = fighters[domSide()], fr = frac1(beatPos(df));
  ctx.strokeStyle = '#c9a8ff';
  for (let k=0;k<9;k++){
    const z = (k + fr)/9, y = HORIZON + Math.pow(z, 2.2)*(H + 60 - HORIZON);
    ctx.globalAlpha = 0.04 + z*0.2; ctx.beginPath(); ctx.moveTo(-300,y); ctx.lineTo(W+300,y); ctx.stroke();
  }
  const sheen = ctx.createLinearGradient(0, GROUND - 30, 0, GROUND + 50);
  sheen.addColorStop(0, 'rgba(200,170,255,0)'); sheen.addColorStop(0.5, `rgba(200,170,255,${0.05 + df.pulse*0.04})`); sheen.addColorStop(1, 'rgba(200,170,255,0)');
  ctx.globalAlpha = 1; ctx.fillStyle = sheen; ctx.fillRect(-300, GROUND - 30, W+600, 80);
  // spotlight pools on the floor under each fighter
  ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 1;
  fighters.forEach((f,i) => {
    const pg = ctx.createRadialGradient(f.x, GROUND+6, 0, f.x, GROUND+6, 190);
    const a = 0.1 + f.pulse*0.1;
    pg.addColorStop(0, i ? `rgba(25,227,255,${a})` : `rgba(255,47,146,${a})`); pg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = pg; ctx.save(); ctx.translate(f.x, GROUND+6); ctx.scale(1, 0.28); ctx.translate(-f.x, -(GROUND+6));
    ctx.fillRect(f.x - 190, GROUND - 184, 380, 380); ctx.restore();
  });
  ctx.restore();
  ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
  // stage lip LED chase
  const ly = 664;
  ctx.fillStyle = '#05020a'; ctx.fillRect(-300, ly, W+600, 10);
  for (let x=-280; x<W+300; x+=16){
    const k = (x + 300)/(W+600), c = k < 0.5 ? SIDES[0].c : SIDES[1].c;
    const ch = Math.max(0, Math.sin(x*0.05 - time*8));
    ctx.fillStyle = c; ctx.globalAlpha = 0.25 + ch*0.75; ctx.fillRect(x, ly+3, 9, 4);
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = 'rgba(246,239,255,.18)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(-300,HORIZON); ctx.lineTo(W+300,HORIZON); ctx.stroke();
}
function drawReflections(over3d){
  ctx.save();
  ctx.beginPath(); ctx.rect(-300, GROUND, W+600, 60); ctx.clip();
  ctx.translate(0, GROUND*2); ctx.scale(1, -1);
  ctx.globalAlpha = over3d ? 0.3 : 0.22;
  fighters.forEach(f => drawFighter(f, 'reflect'));
  ctx.restore();
  if (over3d){
    // fade the mirror image out by erasing it, so the 3D floor shows through
    const eg = ctx.createLinearGradient(0, GROUND, 0, GROUND+60);
    eg.addColorStop(0, 'rgba(0,0,0,0)'); eg.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.save(); ctx.globalCompositeOperation = 'destination-out'; ctx.fillStyle = eg; ctx.fillRect(-300, GROUND, W+600, 61); ctx.restore();
    return;
  }
  const fg = ctx.createLinearGradient(0, GROUND, 0, GROUND+60);
  fg.addColorStop(0, 'rgba(12,5,24,0)'); fg.addColorStop(1, 'rgba(10,4,20,1)');
  ctx.fillStyle = fg; ctx.fillRect(-300, GROUND, W+600, 61);
}
function drawSpeakers(time){
  fighters.forEach((f,i) => {
    const cx = i ? W + 10 : -10, col = SIDES[i].c;
    for (let k=0;k<2;k++){
      const w = 150, h = 150, y = GROUND - 2 - (k+1)*h;
      ctx.fillStyle = '#0c0616'; ctx.fillRect(cx - w/2, y, w, h);
      ctx.strokeStyle = '#2b1a42'; ctx.lineWidth = 3; ctx.strokeRect(cx - w/2, y, w, h);
      const on = ['fight','countdown','ko','roundEnd'].includes(G.state) ? (i === G.owner ? 1 : 0.2) : 0.6;
      const r = 48*(1 + f.pulse*0.1*on);
      ctx.fillStyle = '#05020a'; ctx.beginPath(); ctx.arc(cx, y + h/2 + 8, r, 0, Math.PI*2); ctx.fill();
      ctx.strokeStyle = col; ctx.globalAlpha = 0.35 + f.pulse*0.6*on; ctx.lineWidth = 3; ctx.stroke();
      ctx.beginPath(); ctx.arc(cx, y + h/2 + 8, r*0.4, 0, Math.PI*2); ctx.fillStyle = col; ctx.globalAlpha = 0.15 + f.pulse*0.5*on; ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#05020a'; ctx.beginPath(); ctx.arc(cx, y + 26, 13, 0, Math.PI*2); ctx.fill();
    }
  });
}

/* ---------- foreground crowd ---------- */
const CROWD = Array.from({ length:58 }, (_, i) => ({ x: -40 + i*24 + rand(-8,8), s: rand(0.75,1.05), ph: rand(0,6.28), arms: Math.random() < 0.4, phone: Math.random() < 0.18, row: Math.random() < 0.5 ? 0 : 1 }));
function drawCrowd(time){
  ctx.save();
  const par = 1.12;
  ctx.translate(W/2, H); ctx.scale(1 + (cam.z-1)*par, 1 + (cam.z-1)*par); ctx.translate(-W/2 - (cam.x - W/2)*par, -H);
  const df = fighters[domSide()], fr = frac1(beatPos(df)), bounce = Math.pow(1 - fr, 3);
  for (const p of [...CROWD].sort((a,b) => a.row - b.row)){
    const base = H + 70 + p.row*22, jump = (bounce*10 + G.hype*18*Math.abs(Math.sin(time*7 + p.ph)))*p.s;
    const hx = p.x, hy = base - 92*p.s - jump;
    const rim = p.x < W/2 ? SIDES[0].c : SIDES[1].c;
    ctx.fillStyle = p.row ? '#030106' : '#07030d';
    ctx.beginPath(); ctx.ellipse(hx, hy + 52*p.s, 26*p.s, 40*p.s, 0, 0, Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(hx, hy, 15*p.s, 0, Math.PI*2); ctx.fill();
    if (p.arms || G.hype > 0.5){
      ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 8*p.s; ctx.lineCap = 'round';
      const wave = Math.sin(time*6 + p.ph)*0.3;
      ctx.beginPath(); ctx.moveTo(hx - 14*p.s, hy + 30*p.s); ctx.lineTo(hx - 26*p.s + wave*20, hy - 32*p.s); ctx.stroke();
      if (p.phone){ ctx.fillStyle = '#fffbe6'; ctx.globalAlpha = 0.9; ctx.fillRect(hx - 30*p.s + wave*20, hy - 46*p.s, 7, 11); ctx.globalAlpha = 1; }
    }
    ctx.strokeStyle = rim; ctx.globalAlpha = 0.5; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(hx, hy, 15*p.s, Math.PI*1.15, Math.PI*1.85); ctx.stroke(); ctx.globalAlpha = 1;
  }
  ctx.restore();
}

/* ---------- fighters ---------- */
function capsule(ax, ay, bx, by, ra, rb){
  const a = Math.atan2(by - ay, bx - ax);
  ctx.beginPath(); ctx.arc(ax, ay, ra, a + Math.PI/2, a - Math.PI/2); ctx.arc(bx, by, rb, a - Math.PI/2, a + Math.PI/2); ctx.closePath();
}
function drawFighter(f, mode){
  if (!f.sk) return;
  if (mode === 'full'){
    const hy = f.y - 110, r = 170 + f.pulse*20, hg = ctx.createRadialGradient(f.x, hy, 10, f.x, hy, r);
    hg.addColorStop(0, `rgba(${SIDES[f.side].glow},${0.2 + f.pulse*0.12})`); hg.addColorStop(1, `rgba(${SIDES[f.side].glow},0)`);
    ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = hg; ctx.fillRect(f.x - r, hy - r, r*2, r*2); ctx.restore();
  }
  if (mode === 'full' && f.scarf) drawScarf(f);
  ctx.save(); ctx.translate(f.x, f.y); ctx.rotate(koRot(f)); ctx.scale(f.face, 1);
  ctx.scale(1 + f.pulse*0.02, 1 - f.pulse*0.02);
  drawBody(f, f.sk, f.P, mode);
  ctx.restore();
}
function drawScarf(f){
  const s = f.scarf; ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = f.flash > 0 ? '#fff' : SIDES[f.side].c; ctx.lineWidth = 8;
  ctx.beginPath(); ctx.moveTo(s[0].x, s[0].y); for (let i=1;i<s.length;i++) ctx.lineTo(s[i].x, s[i].y); ctx.stroke();
  ctx.strokeStyle = SIDES[f.side].rim; ctx.lineWidth = 2; ctx.globalAlpha = 0.7; ctx.stroke();
  ctx.restore();
}
function drawBody(f, k, P, mode){
  const S = SIDES[f.side], flat = mode === 'flat';
  const hit = f.flash > 0 && mode !== 'reflect';
  const main = hit ? '#ffffff' : S.c;
  let suit = flat ? ctx.fillStyle : hit ? '#ffffff' : S.suit;
  const suitB = flat ? ctx.fillStyle : hit ? '#f0e6ff' : S.suitB;
  if (!flat && !hit){ const sg = ctx.createLinearGradient(0, -200, 0, 0); sg.addColorStop(0, S.lit); sg.addColorStop(0.5, S.suit); sg.addColorStop(1, S.suitB); suit = sg; }
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const part = (draw, fill, outline, lw=3.2) => { draw(); ctx.fillStyle = fill; ctx.fill(); if (!flat && outline){ ctx.strokeStyle = outline; ctx.lineWidth = lw; ctx.stroke(); } };
  const leg = (h, kn, ft, fill, back) => {
    part(() => capsule(h.x, h.y, kn.x, kn.y, 14, 11), fill, back ? null : main);
    part(() => capsule(kn.x, kn.y, ft.x, ft.y, 11, 8), fill, back ? null : main);
    if (!flat){ ctx.fillStyle = back ? 'rgba(255,255,255,.08)' : main; ctx.beginPath(); ctx.arc(kn.x, kn.y, 6, 0, Math.PI*2); ctx.fill(); }
    // sneaker
    const a = Math.atan2(ft.y - kn.y, ft.x - kn.x) - Math.PI/2;
    ctx.save(); ctx.translate(ft.x, ft.y); ctx.rotate(a*0.6);
    ctx.fillStyle = flat ? ctx.fillStyle : back ? '#1b1028' : '#efe6ff'; ctx.beginPath(); ctx.ellipse(8, 2, 17, 8, 0, 0, Math.PI*2); ctx.fill();
    if (!flat){ ctx.fillStyle = back ? S.suitB : main; ctx.fillRect(-6, 4, 30, 4); }
    ctx.restore();
  };
  const arm = (s, e, w, fill, back, palm) => {
    part(() => capsule(s.x, s.y, e.x, e.y, 11, 9), fill, back ? null : main);
    part(() => capsule(e.x, e.y, w.x, w.y, 8, 7), fill, back ? null : main);
    if (palm && !flat){
      const a = Math.atan2(w.y - e.y, w.x - e.x);
      ctx.save(); ctx.translate(w.x, w.y); ctx.rotate(a);
      ctx.fillStyle = main; ctx.beginPath(); ctx.ellipse(10, 0, 16, 19, 0, 0, Math.PI*2); ctx.fill();
      ctx.strokeStyle = main; ctx.lineWidth = 6;
      for (let i=-2;i<=1;i++){ ctx.beginPath(); ctx.moveTo(16, i*7 + 3); ctx.lineTo(32, i*9 + 4); ctx.stroke(); }
      ctx.fillStyle = '#fff'; ctx.globalAlpha = 0.6; ctx.beginPath(); ctx.ellipse(8, -4, 6, 8, 0, 0, Math.PI*2); ctx.fill(); ctx.globalAlpha = 1;
      ctx.restore();
    } else {
      ctx.fillStyle = flat ? ctx.fillStyle : back ? suitB : main; ctx.beginPath(); ctx.arc(w.x, w.y, back ? 9 : 11, 0, Math.PI*2); ctx.fill();
      if (!flat && !back){ ctx.fillStyle = 'rgba(255,255,255,.55)'; ctx.beginPath(); ctx.arc(w.x - 3, w.y - 3, 4, 0, Math.PI*2); ctx.fill(); }
    }
  };
  // smear arcs behind the striking limb
  if (!flat && mode !== 'reflect' && P.trail > 0){
    ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.strokeStyle = f.atk && f.atk.crit ? COL.gold : main; ctx.lineCap = 'round';
    ctx.globalAlpha = 0.55*P.trail;
    if (f.atk && f.atk.type === 'slap'){ ctx.lineWidth = 26*P.trail + 4; ctx.beginPath(); ctx.arc(k.sf.x, k.sf.y, 74, -1.9, 0.05); ctx.stroke(); }
    else { ctx.lineWidth = 22*P.trail + 4; ctx.beginPath(); ctx.arc(k.hip.x, k.hip.y, 94, Math.PI/2, 0.02, true); ctx.stroke(); }
    ctx.restore();
  }
  leg(k.hb, k.kb, k.fb, suitB, true);
  arm(k.sb, k.eb, k.wb, suitB, true, false);
  // torso: tapered chest with a beat-reactive emblem
  const lean = P.lean, nx = Math.cos(lean), ny = Math.sin(lean);
  const hw = 17, cw = 27;
  ctx.beginPath();
  ctx.moveTo(k.hip.x - nx*hw, k.hip.y - ny*hw);
  ctx.lineTo(k.hip.x + nx*hw, k.hip.y + ny*hw);
  ctx.quadraticCurveTo(k.sh.x + nx*(cw+6) + Math.sin(lean)*-20, k.sh.y + ny*(cw+6) + 20, k.sh.x + nx*cw, k.sh.y + ny*cw);
  ctx.quadraticCurveTo(k.sh.x, k.sh.y - 12, k.sh.x - nx*cw, k.sh.y - ny*cw);
  ctx.closePath();
  ctx.fillStyle = suit; ctx.fill();
  if (!flat){
    ctx.strokeStyle = main; ctx.lineWidth = 3.2; ctx.stroke();
    ctx.strokeStyle = S.rim; ctx.globalAlpha = 0.6; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(k.hip.x + nx*hw, k.hip.y + ny*hw); ctx.lineTo(k.sh.x + nx*cw, k.sh.y + ny*cw); ctx.stroke(); ctx.globalAlpha = 1;
    ctx.strokeStyle = COL.gold; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(k.hip.x - nx*hw, k.hip.y - ny*hw + 4); ctx.lineTo(k.hip.x + nx*hw, k.hip.y + ny*hw + 4); ctx.stroke();
    const mx = lerp(k.hip.x, k.sh.x, 0.62), my = lerp(k.hip.y, k.sh.y, 0.62);
    ctx.fillStyle = main; ctx.globalAlpha = 0.35 + f.pulse*0.65;
    ctx.beginPath(); ctx.moveTo(mx - 8, my - 6); ctx.lineTo(mx + 2, my); ctx.lineTo(mx - 8, my + 6); ctx.lineTo(mx - 4, my); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(mx + 2, my - 6); ctx.lineTo(mx + 12, my); ctx.lineTo(mx + 2, my + 6); ctx.lineTo(mx + 6, my); ctx.closePath(); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = main; ctx.beginPath(); ctx.arc(k.sh.x + 4, k.sh.y + 4, 9, 0, Math.PI*2); ctx.fill();
  }
  // head: helmet, glowing visor, headphones, crest
  const hx = k.head.x, hy = k.head.y;
  ctx.fillStyle = suit; ctx.beginPath(); ctx.arc(hx, hy, 21, 0, Math.PI*2); ctx.fill();
  if (!flat){
    ctx.strokeStyle = main; ctx.lineWidth = 3.2; ctx.stroke();
    if (f.side === 0){ ctx.fillStyle = main; for (let i=0;i<3;i++){ const a = -2.3 + i*0.42; ctx.beginPath(); ctx.moveTo(hx + Math.cos(a)*18, hy + Math.sin(a)*18); ctx.lineTo(hx + Math.cos(a+0.2)*34, hy + Math.sin(a+0.2)*34); ctx.lineTo(hx + Math.cos(a+0.34)*19, hy + Math.sin(a+0.34)*19); ctx.fill(); } }
    else { ctx.strokeStyle = main; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(hx - 4, hy - 20); ctx.lineTo(hx - 12, hy - 38); ctx.stroke(); ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(hx - 12, hy - 39, 4, 0, Math.PI*2); ctx.fill(); }
    ctx.fillStyle = main; ctx.beginPath(); ctx.ellipse(hx + 9, hy - 1, 13, 7.5, -0.08, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#ffffff'; ctx.globalAlpha = 0.85; ctx.fillRect(hx + 3, hy - 2.5, 16, 2.5); ctx.globalAlpha = 1;
    ctx.strokeStyle = COL.gold; ctx.lineWidth = 5; ctx.beginPath(); ctx.arc(hx - 2, hy - 2, 26, Math.PI*1.1, Math.PI*1.95); ctx.stroke();
    ctx.fillStyle = COL.gold; ctx.beginPath(); ctx.ellipse(hx - 7, hy + 4, 8, 12, 0.15, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = suit; ctx.beginPath(); ctx.ellipse(hx - 7, hy + 4, 3.5, 6, 0.15, 0, Math.PI*2); ctx.fill();
  }
  leg(k.hf, k.kf, k.ff, suit, false);
  arm(k.sf, k.ef, k.wf, suit, false, P.palm);
}
function drawTrail(f){
  if (!f.trail.length) return;
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  for (const t of f.trail){
    ctx.globalAlpha = (t.life/0.2)*0.28;
    ctx.save(); ctx.translate(t.x, t.y); ctx.rotate(t.rot); ctx.scale(t.face, 1);
    ctx.fillStyle = SIDES[f.side].c; drawBody(f, t.sk, t.P, 'flat'); ctx.restore();
  }
  ctx.restore();
}
function drawShadow(f){
  const sh = clamp(1 - (GROUND - f.y)/400, 0.3, 1);
  ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.beginPath(); ctx.ellipse(f.x, GROUND + 4, 58*sh, 12*sh, 0, 0, Math.PI*2); ctx.fill();
}
function drawBeatRing(f){
  const bp = beatPos(f), fr = frac1(bp), col = SIDES[f.side].c;
  ctx.save(); ctx.strokeStyle = col; ctx.lineWidth = 3; ctx.globalAlpha = (1 - fr)*0.8;
  ctx.beginPath(); ctx.ellipse(f.x, GROUND + 4, 40 + fr*120, (40 + fr*120)*0.2, 0, 0, Math.PI*2); ctx.stroke();
  ctx.restore();
}
function drawRing(r){
  const k = r.t/(0.5*r.scale + 0.2);
  ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.strokeStyle = r.color; ctx.globalAlpha = 1 - k;
  ctx.lineWidth = 8*(1-k) + 1; ctx.beginPath();
  if (r.air){ ctx.arc(r.x, r.y, 20 + k*120*r.scale, 0, Math.PI*2); ctx.stroke(); ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(r.x, r.y, 10 + k*70*r.scale, 0, Math.PI*2); }
  else ctx.ellipse(r.x, r.y + 4, 30 + k*200*r.scale, (30 + k*200*r.scale)*0.2, 0, 0, Math.PI*2);
  ctx.stroke(); ctx.restore();
}
function drawLines(){
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  for (const l of lines){
    const k = l.t/0.28; ctx.fillStyle = l.col; ctx.globalAlpha = (1-k)*0.8;
    for (let i=0;i<22;i++){
      const a = i/22*Math.PI*2 + l.x, r0 = 40 + k*140, r1 = r0 + 80 + (i%3)*40, w = 0.03;
      ctx.beginPath(); ctx.moveTo(l.x + Math.cos(a)*r0, l.y + Math.sin(a)*r0);
      ctx.lineTo(l.x + Math.cos(a-w)*r1, l.y + Math.sin(a-w)*r1); ctx.lineTo(l.x + Math.cos(a+w)*r1, l.y + Math.sin(a+w)*r1); ctx.fill();
    }
  }
  ctx.restore();
}
function drawFlares(){
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  for (const f of flares){
    const k = f.t/0.24, r = (40 + k*110)*f.big, g = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, r);
    g.addColorStop(0, `rgba(255,255,255,${0.9*(1-k)})`); g.addColorStop(0.25, `rgba(${f.col},${0.7*(1-k)})`); g.addColorStop(1, `rgba(${f.col},0)`);
    ctx.fillStyle = g; ctx.fillRect(f.x - r, f.y - r, r*2, r*2);
    // horizontal anamorphic streak
    ctx.globalAlpha = 0.8*(1-k); ctx.fillStyle = `rgb(${f.col})`;
    ctx.beginPath(); ctx.ellipse(f.x, f.y, r*2.2, 3 + 4*(1-k)*f.big, 0, 0, Math.PI*2); ctx.fill(); ctx.globalAlpha = 1;
  }
  ctx.restore();
}
function drawParticles(){
  ctx.save();
  for (const p of particles){
    const a = clamp(p.life/p.max, 0, 1);
    if (p.type === 'confetti'){ ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = Math.min(1, p.life);
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.scale(1, Math.sin(p.rot*2)); ctx.fillStyle = p.color; ctx.fillRect(-p.size/2, -p.size/4, p.size, p.size/2); ctx.restore(); continue; }
    ctx.globalCompositeOperation = p.type === 'dust' ? 'source-over' : 'lighter';
    if (p.type === 'spark'){ ctx.globalAlpha = a; ctx.strokeStyle = p.color; ctx.lineWidth = p.size*0.7; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx*0.035, p.y - p.vy*0.035); ctx.stroke(); }
    else if (p.type === 'dust'){ ctx.globalAlpha = a*0.35; ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI*2); ctx.fill(); }
    else if (p.type === 'flame'){ ctx.globalAlpha = a*0.8; ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(p.x, p.y, p.size*a + 2, 0, Math.PI*2); ctx.fill(); }
    else { ctx.globalAlpha = a; ctx.fillStyle = p.color; ctx.fillRect(p.x - p.size/2, p.y - p.size/2, p.size, p.size); }
  }
  ctx.restore();
}
function drawTexts(){
  ctx.save(); ctx.textAlign = 'center';
  for (const t of texts){
    const k = t.t/1.0, s = t.size*(k < 0.12 ? 0.6 + k*3.4 : 1);
    ctx.globalAlpha = 1 - Math.pow(k, 3); ctx.font = FONT(s);
    ctx.lineWidth = 7; ctx.strokeStyle = '#06020c'; ctx.strokeText(t.text, t.x, t.y - k*50);
    ctx.fillStyle = t.color; ctx.fillText(t.text, t.x, t.y - k*50);
  }
  ctx.restore();
}
// manga-style impact frame: two flashes of pure silhouette on big hits
function drawImpactFrame(time){
  const firstHalf = G.impact > 0.05;
  ctx.fillStyle = firstHalf ? '#fff6fb' : '#06020c'; ctx.fillRect(0,0,W,H);
  ctx.save(); worldTransform();
  const at = G.impactAt;
  ctx.fillStyle = firstHalf ? '#06020c' : SIDES[at.a].c;
  for (let i=0;i<40;i++){
    const a = i/40*Math.PI*2 + time, r0 = 30, r1 = 1400, w = 0.012 + (i%4)*0.008;
    ctx.beginPath(); ctx.moveTo(at.x + Math.cos(a)*r0, at.y + Math.sin(a)*r0);
    ctx.lineTo(at.x + Math.cos(a-w)*r1, at.y + Math.sin(a-w)*r1); ctx.lineTo(at.x + Math.cos(a+w)*r1, at.y + Math.sin(a+w)*r1); ctx.fill();
  }
  fighters.forEach(f => { ctx.fillStyle = firstHalf ? '#06020c' : '#fff6fb'; ctx.save(); ctx.translate(f.x, f.y); ctx.rotate(koRot(f)); ctx.scale(f.face, 1); drawBody(f, f.sk, f.P, 'flat'); ctx.restore(); });
  ctx.restore();
}

/* ---------- HUD ---------- */
function drawArtBox(t, x, y, s, side){
  ctx.save();
  ctx.fillStyle = '#12081f'; ctx.fillRect(x, y, s, s);
  const img = t && artImg(t.art);
  if (img) ctx.drawImage(img, x, y, s, s);
  else if (t){
    const g = ctx.createLinearGradient(x, y, x+s, y+s); g.addColorStop(0, `hsl(${t.hue ?? 280} 85% 50%)`); g.addColorStop(1, `hsl(${(t.hue ?? 280) + 60} 85% 35%)`);
    ctx.fillStyle = g; ctx.fillRect(x, y, s, s);
    ctx.fillStyle = '#fff'; ctx.font = FONT(s*0.45); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText((t.genre || t.name)[0], x + s/2, y + s/2 + 2);
  }
  ctx.strokeStyle = SIDES[side].c; ctx.lineWidth = 3; ctx.strokeRect(x, y, s, s);
  ctx.restore();
}
function drawHUD(time){
  ctx.save(); ctx.textBaseline = 'alphabetic';
  const ts = ctx.createLinearGradient(0, 0, 0, 175); ts.addColorStop(0, 'rgba(6,2,12,.82)'); ts.addColorStop(1, 'rgba(6,2,12,0)');
  ctx.fillStyle = ts; ctx.fillRect(0, 0, W, 175);
  const bs = ctx.createLinearGradient(0, H - 110, 0, H); bs.addColorStop(0, 'rgba(6,2,12,0)'); bs.addColorStop(1, 'rgba(6,2,12,.8)');
  ctx.fillStyle = bs; ctx.fillRect(0, H - 110, W, 110);
  fighters.forEach((f,i) => {
    const col = SIDES[i].c, R = i === 1;
    const ax = R ? W - 24 - 76 : 24, bx = R ? W - 24 - 76 - 14 - 430 : 24 + 76 + 14, bw = 430, by = 40, bh = 24, sk = 12;
    drawArtBox(f.track, ax, 22, 76, i);
    if (['fight','countdown','ko','roundEnd'].includes(G.state)){
      ctx.fillStyle = col; ctx.font = FONT(12); ctx.textAlign = 'center'; ctx.fillText(R ? 'RIGHT EAR ▶' : '◀ LEFT EAR', ax + 38, 116);
    }
    const bar = (fr, fill) => {
      ctx.beginPath();
      if (!R){ const x1 = bx + bw*fr; ctx.moveTo(bx+sk, by); ctx.lineTo(x1+sk, by); ctx.lineTo(x1, by+bh); ctx.lineTo(bx, by+bh); }
      else { const x0 = bx + bw*(1-fr); ctx.moveTo(x0, by); ctx.lineTo(bx+bw, by); ctx.lineTo(bx+bw-sk, by+bh); ctx.lineTo(x0-sk, by+bh); }
      ctx.closePath(); if (fill){ ctx.fillStyle = fill; ctx.fill(); }
    };
    bar(1, 'rgba(18,8,31,.92)');
    bar(f.hpLag/MAX_HP, '#fff4f9');
    const low = f.hp < 25 && Math.sin(time*14) > 0;
    const hg = ctx.createLinearGradient(bx, 0, bx + bw, 0);
    hg.addColorStop(R ? 1 : 0, col); hg.addColorStop(R ? 0 : 1, i ? '#b6f6ff' : '#ffb3d8');
    bar(f.hp/MAX_HP, low ? '#ffffff' : hg);
    ctx.strokeStyle = 'rgba(246,239,255,.18)'; ctx.lineWidth = 1;
    for (let s=1;s<10;s++){ const x = bx + bw*s/10; ctx.beginPath(); ctx.moveTo(x + sk*0.5 + 6, by + 2); ctx.lineTo(x + sk*0.5 - 6, by + bh - 2); ctx.stroke(); }
    bar(1); ctx.strokeStyle = 'rgba(246,239,255,.4)'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.font = FONT(20); ctx.fillStyle = col; ctx.textAlign = R ? 'right' : 'left';
    ctx.fillText(nameOf(i), R ? bx + bw : bx, by - 8);
    ctx.font = BODY(18, 700); ctx.fillStyle = COL.text; ctx.textAlign = R ? 'left' : 'right';
    ctx.fillText(Math.ceil(f.hp), R ? bx - 2 : bx + bw + 2, by - 8);
    if (f.track){
      const tx = R ? bx + bw : bx;
      ctx.textAlign = R ? 'right' : 'left';
      ctx.font = BODY(17, 700); ctx.fillStyle = COL.text;
      const nm = f.track.name.length > 34 ? f.track.name.slice(0,33) + '…' : f.track.name;
      ctx.fillText(nm, tx, by + bh + 22);
      ctx.font = BODY(14, 600); ctx.fillStyle = '#c4b6e6';
      const ar = f.track.artist.length > 34 ? f.track.artist.slice(0,33) + '…' : f.track.artist;
      ctx.fillText(ar, tx, by + bh + 40);
      ctx.font = FONT(17); ctx.fillStyle = COL.gold; ctx.textAlign = R ? 'left' : 'right';
      ctx.fillText(`MASS ${massPct(f.track)}`, R ? bx + 4 : bx + bw - 4, by + bh + 22);
      ctx.font = BODY(14, 700); ctx.fillStyle = '#c4b6e6';
      ctx.fillText(`${classOf(massOf(f.track))} · ${f.track.bpm} BPM`, R ? bx + 4 : bx + bw - 4, by + bh + 40);
    }
    if (f.combo >= 2 && f.comboT > 0){
      ctx.font = FONT(30); ctx.textAlign = R ? 'right' : 'left'; ctx.fillStyle = col; ctx.globalAlpha = clamp(f.comboT*2, 0, 1);
      ctx.fillText(`${f.combo} HITS`, R ? W - 24 : 24, 160); ctx.globalAlpha = 1;
    }
    if (['fight','countdown','roundEnd'].includes(G.state)) drawLane(f, R ? W - 24 - 330 : 24, H - 62, 330, R);
  });
  // timer badge
  const t = Math.ceil(G.timer);
  ctx.save(); ctx.translate(W/2, 56);
  ctx.fillStyle = 'rgba(12,5,22,.9)'; ctx.beginPath();
  for (let k=0;k<6;k++){ const a = Math.PI/6 + k*Math.PI/3; ctx.lineTo(Math.cos(a)*50, Math.sin(a)*44); } ctx.closePath(); ctx.fill();
  ctx.strokeStyle = G.owner ? SIDES[1].c : SIDES[0].c; ctx.lineWidth = 2; ctx.stroke();
  ctx.strokeStyle = t <= 5 && G.state === 'fight' ? COL.gold : 'rgba(246,239,255,.85)'; ctx.lineWidth = 4; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.arc(0, 0, 55, -Math.PI/2, -Math.PI/2 + Math.PI*2*clamp(G.timer/ROUND_LEN, 0, 1)); ctx.stroke();
  ctx.textAlign = 'center'; ctx.font = FONT(40); ctx.fillStyle = t <= 5 && G.state === 'fight' ? COL.gold : COL.text;
  ctx.fillText(String(t).padStart(2,'0'), 0, 15);
  ctx.restore();
  ctx.fillStyle = 'rgba(12,5,22,.88)'; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(W/2 - 58, 113, 116, 42, 10) : ctx.rect(W/2 - 58, 113, 116, 42); ctx.fill();
  for (let r=0;r<MAX_ROUNDS;r++){
    ctx.fillStyle = r < G.round ? COL.text : '#2b1748'; ctx.beginPath(); ctx.arc(W/2 - 32 + r*16, 124, 4, 0, Math.PI*2); ctx.fill();
  }
  ctx.font = BODY(14, 700); ctx.fillStyle = '#c4b6e6'; ctx.textAlign = 'center'; ctx.fillText(`ROUND ${G.round}`, W/2, 146);
  ctx.restore();
}
// song meter: what this fighter's ear hears. tall spikes are swings, gold ones are drops
function drawLane(f, x, y, w, R){
  const col = SIDES[f.side].c, h = 34, hist = f.ear.hist, n = 120, bw = w/n;
  ctx.save();
  ctx.fillStyle = 'rgba(10,4,20,.82)'; ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = 'rgba(190,150,255,.25)'; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  for (let i=0;i<hist.length;i++){
    const v = hist[hist.length - 1 - i], hit = v < 0, drop = v <= -10, a = drop ? -v - 10 : Math.abs(v), px = R ? x + i*bw : x + w - (i+1)*bw;
    const bh = clamp(a/4, 0.04, 1)*(h - 4);
    ctx.globalAlpha = hit ? 1 : 0.45; ctx.fillStyle = hit ? (drop ? COL.gold : '#ffffff') : col;
    ctx.fillRect(px, y + h - 2 - bh, Math.max(1, bw - 0.5), bh);
  }
  ctx.globalAlpha = 1; ctx.restore();
  ctx.font = BODY(13, 700); ctx.fillStyle = '#c4b6e6'; ctx.textAlign = R ? 'right' : 'left';
  ctx.fillText(`SONG MASS ${massPct(f.track)} · HITS ON EVERY BEAT`, R ? x + w : x, y - 6);
  const J = f.judge;
  if (J && J.t < 0.6){
    ctx.font = FONT(18); ctx.globalAlpha = 1 - J.t/0.6; ctx.fillStyle = J.crit ? COL.gold : COL.text;
    ctx.textAlign = R ? 'right' : 'left'; ctx.fillText(J.text, R ? x - 12 : x + w + 12, y + 24 - J.t*10); ctx.globalAlpha = 1;
  }
}
function drawBanner(){
  const B = G.banner; if (!B) return;
  const k = B.t/B.dur, s = k < 0.15 ? 0.5 + k/0.15*0.5 : 1 + (k - 0.15)*0.06;
  ctx.save(); ctx.translate(W/2, H/2 - 50); ctx.scale(s, s); ctx.globalAlpha = k > 0.8 ? (1-k)/0.2 : 1;
  ctx.transform(1, 0, -0.14, 1, 0, 0);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = FONT(B.text.length > 2 ? 130 : 170);
  ctx.lineWidth = 16; ctx.strokeStyle = '#06020c'; ctx.strokeText(B.text, 0, 0);
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = SIDES[0].c; ctx.fillText(B.text, -6, 2);
  ctx.fillStyle = SIDES[1].c; ctx.fillText(B.text, 6, -2);
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = B.color; ctx.fillText(B.text, 0, 0);
  if (B.sub){ ctx.font = FONT(30); ctx.lineWidth = 8; ctx.strokeText(B.sub, 0, 104); ctx.fillStyle = COL.gold; ctx.fillText(B.sub, 0, 104); }
  ctx.restore();
}

export const getQuality = () => quality;
export const stageAPI = {
  W, H, GROUND, SIDES, COL, G, cam, fighters, ledC, LEDW, LEDH, FONT,
  beatPos, frac1, domSide, fBpm, massPct, drawLedContent, RES_CAP,
  get freqData(){ return AC ? freqData : null; },
  get quality(){ return quality; },
};
let mounted = false;
export function mount(canvas){
  cv = canvas; ctx = cv.getContext('2d');
  grainPat = ctx.createPattern(grainC, 'repeat');
  ledPat = ctx.createPattern(ledMask, 'repeat');
  resize();
  const ro = window.ResizeObserver ? new ResizeObserver(resize) : null; ro?.observe(cv);
  addEventListener('resize', resize);
  if (mounted) return () => { ro?.disconnect(); removeEventListener('resize', resize); };
  mounted = true;
  (document.fonts && document.fonts.load ? Promise.all([document.fonts.load('40px Bungee'), document.fonts.load('700 16px "Chakra Petch"')]).catch(()=>{}) : Promise.resolve())
  .finally(() => requestAnimationFrame(t => { last = t; frame(t); }));
  return () => { ro?.disconnect(); removeEventListener('resize', resize); };
}
export { G, fighters, massPct, massOf, classOf, STUDIO, REG };
