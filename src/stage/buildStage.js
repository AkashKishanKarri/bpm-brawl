/* The concert stage as a Three.js scene graph: LED wall, BPM towers, light rig, lasers,
   neon floor, speakers, dust. The z = 0 plane lines up pixel for pixel with the 2D fighter layer. */
import * as THREE from 'three';

export function buildStage(B){
  const { W, H, GROUND, SIDES, G, cam, fighters } = B;

  const FOV = 40, D0 = (H/2)/Math.tan(THREE.MathUtils.degToRad(FOV/2)), PY = GROUND - 120;
  const scene = new THREE.Group();
  // where a point must sit at depth z to land on screen pixel (sx, sy) with the default camera
  const kz = z => D0/(D0 - z);
  const at = (sx, sy, z) => new THREE.Vector3(W/2 + (sx - W/2)/kz(z), -(H/2 + (sy - H/2)/kz(z)), z);
  const px = z => 1/kz(z); // world units per screen pixel at depth z

  const C0 = new THREE.Color(SIDES[0].c), C1 = new THREE.Color(SIDES[1].c), GOLD = new THREE.Color('#ffd23f'), WHITE = new THREE.Color('#ffffff');
  const add = (o, m) => { scene.add(o); return o; };
  const OUT = '\n#include <colorspace_fragment>\n'; // includes must sit on their own line
  const basicVS = `varying vec2 vUv; varying vec3 vW; void main(){ vUv = uv; vec4 w = modelMatrix*vec4(position,1.); vW = w.xyz; gl_Position = projectionMatrix*viewMatrix*w; }`;

  /* ---------- back wall: deep gradient with drifting haze ---------- */
  const sky = new THREE.ShaderMaterial({ uniforms:{ uTime:{ value:0 }, uC0:{ value:C0 }, uC1:{ value:C1 }, uHype:{ value:0 } }, vertexShader:basicVS,
    fragmentShader:`uniform float uTime, uHype; uniform vec3 uC0, uC1; varying vec2 vUv;
      void main(){
        vec3 c = mix(vec3(.05,.012,.09), vec3(.004,.001,.012), smoothstep(.25,.95,vUv.y));
        for (int i=0;i<3;i++){ float fi = float(i);
          vec2 p = vec2(.5 + sin(uTime*.13 + fi*2.1)*.22, .55 + cos(uTime*.1 + fi)*.08);
          float d = length((vUv - p)*vec2(2.,1.)); c += (i==1 ? uC1 : uC0)*exp(-d*d*18.)*(.05 + uHype*.05); }
        gl_FragColor = vec4(c,1.); ${OUT} }` });
  const skyM = add(new THREE.Mesh(new THREE.PlaneGeometry(9000, 4200), sky));
  skyM.position.set(W/2, 300, -1500);

  /* ---------- LED wall: album art / spectrum on a real LED dot grid ---------- */
  const ledTex = new THREE.CanvasTexture(B.ledC); ledTex.magFilter = ledTex.minFilter = THREE.NearestFilter; ledTex.colorSpace = THREE.SRGBColorSpace; ledTex.generateMipmaps = false;
  const led = new THREE.ShaderMaterial({ uniforms:{ uTex:{ value:ledTex }, uRes:{ value:new THREE.Vector2(B.LEDW, B.LEDH) }, uBright:{ value:1 } }, vertexShader:basicVS,
    fragmentShader:`uniform sampler2D uTex; uniform vec2 uRes; uniform float uBright; varying vec2 vUv;
      void main(){
        vec2 cell = (floor(vUv*uRes) + .5)/uRes;
        vec3 c = texture2D(uTex, cell).rgb;
        float d = length(fract(vUv*uRes) - .5), dotm = smoothstep(.46, .28, d);
        gl_FragColor = vec4(c*dotm*uBright*1.6 + vec3(.012,.004,.02)*dotm, 1.); ${OUT} }` });
  const ZL = -1000, ledP = at(640, 186, ZL);
  const ledFrame = add(new THREE.Mesh(new THREE.BoxGeometry(540*px(ZL), 264*px(ZL), 30), new THREE.MeshBasicMaterial({ color:0x07020e })));
  ledFrame.position.copy(ledP).add(new THREE.Vector3(0, 0, -16));
  const ledM = add(new THREE.Mesh(new THREE.PlaneGeometry(520*px(ZL), 244*px(ZL)), led)); ledM.position.copy(ledP);

  /* ---------- canvas-texture panels: marquee and the two BPM towers ---------- */
  function panel(w, h, cw, ch, pos){
    const c = document.createElement('canvas'); c.width = cw; c.height = ch;
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    const m = add(new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map:t, toneMapped:false })));
    m.position.copy(pos); return { c, x:c.getContext('2d'), t, m };
  }
  const marq = panel(520*px(ZL), 26*px(ZL), 1024, 52, at(640, 337, ZL));
  const ZT = -820;
  const towers = [0,1].map(i => panel(140*px(ZT), 230*px(ZT), 280, 460, at(i ? 1005 : 275, 255, ZT)));
  towers.forEach(tw => { const b = add(new THREE.Mesh(new THREE.BoxGeometry(150*px(ZT), 240*px(ZT), 40), new THREE.MeshBasicMaterial({ color:0x05020a }))); b.position.copy(tw.m.position).add(new THREE.Vector3(0,0,-22)); });

  /* ---------- LED strips: backline riser and the stage lip chase ---------- */
  function strip(w, h, pos, n, speed, bright){
    const mat = new THREE.ShaderMaterial({ uniforms:{ uTime:{ value:0 }, uC0:{ value:C0 }, uC1:{ value:C1 }, uN:{ value:n }, uS:{ value:speed }, uB:{ value:bright } }, vertexShader:basicVS,
      fragmentShader:`uniform float uTime, uN, uS, uB; uniform vec3 uC0, uC1; varying vec2 vUv;
        void main(){
          float cell = fract(vUv.x*uN), id = floor(vUv.x*uN);
          float m = smoothstep(.36,.18,abs(cell-.5))*smoothstep(.5,.15,abs(vUv.y-.5));
          float ch = .2 + .8*max(0., sin(id*.7 - uTime*uS));
          vec3 c = (vUv.x < .5 ? uC0 : uC1)*m*ch*uB + vec3(.01,.004,.02);
          gl_FragColor = vec4(c,1.); ${OUT} }` });
    const m = add(new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat)); m.position.copy(pos); return mat;
  }
  const riserTop = at(640, 372, ZL);
  const riser = add(new THREE.Mesh(new THREE.BoxGeometry(5200, 400, 60), new THREE.MeshBasicMaterial({ color:0x0a0416 })));
  riser.position.set(W/2, riserTop.y - 200, ZL + 30);
  const riserStrip = strip(5200, 7*px(ZL), new THREE.Vector3(W/2, riserTop.y - 6, ZL + 62), 115, 4, 1.4);
  const ZLIP = D0 - D0/((664 - H/2)/(GROUND - H/2)); // depth where the old 2D stage lip sat
  const lip = add(new THREE.Mesh(new THREE.BoxGeometry(5200, 26, 18), new THREE.MeshBasicMaterial({ color:0x040109 })));
  lip.position.set(W/2, -GROUND - 13, ZLIP);
  const lipStrip = strip(5200, 7, new THREE.Vector3(W/2, -GROUND - 12, ZLIP + 10), 330, 8, 1.7);

  /* ---------- glossy floor: neon grid that scrolls on the beat, pools of light, beam hits ---------- */
  const hits = Array.from({ length:8 }, () => new THREE.Vector4());
  const floor = new THREE.ShaderMaterial({ uniforms:{ uTime:{ value:0 }, uBeat:{ value:0 }, uC0:{ value:C0 }, uC1:{ value:C1 }, uLed:{ value:new THREE.Color() },
      uF0:{ value:new THREE.Vector3() }, uF1:{ value:new THREE.Vector3() }, uHit:{ value:hits }, uHype:{ value:0 } }, vertexShader:basicVS,
    fragmentShader:`uniform float uTime, uBeat, uHype; uniform vec3 uC0, uC1, uLed, uF0, uF1; uniform vec4 uHit[8]; varying vec3 vW;
      void main(){
        float x = vW.x, z = vW.z, near = clamp((z + 1000.)/1300., 0., 1.);
        vec3 c = mix(vec3(.010,.003,.024), vec3(.032,.012,.065), near);
        float gx = abs(fract((x - 640.)/95. + .5) - .5)*95.;
        float lx = 1. - smoothstep(0., fwidth(x)*1.5 + 1.2, gx);
        c += (x < 640. ? uC0 : uC1)*lx*(.10 + .25*near);
        float pz = (z + 1000.)/1300.*10. + uBeat, gz = abs(fract(pz) - .5);
        float lz = 1. - smoothstep(0., fwidth(pz)*1.5 + .015, gz);
        c += vec3(.55,.42,.9)*lz*(.04 + .2*near);
        vec2 d0 = vec2((x - uF0.x)/200., z/80.), d1 = vec2((x - uF1.x)/200., z/80.);
        c += uC0*exp(-dot(d0,d0)*2.2)*(.22 + uF0.z*.4) + uC1*exp(-dot(d1,d1)*2.2)*(.22 + uF1.z*.4);
        for (int i=0;i<8;i++){ vec4 h = uHit[i]; vec2 d = vec2(x - h.x, z - h.y)/vec2(130., 70.); c += (h.w < .5 ? uC0 : uC1)*exp(-dot(d,d)*2.)*h.z; }
        float rx = (x - 640.)/520., rz = (z + 960.)/420.; c += uLed*exp(-rx*rx - rz*rz)*.55;
        float sz = z/70.; c += vec3(.55,.45,.9)*exp(-sz*sz)*(.05 + uHype*.04);
        gl_FragColor = vec4(c, 1.); ${OUT} }` });
  const floorM = add(new THREE.Mesh(new THREE.PlaneGeometry(7000, 1700).rotateX(-Math.PI/2), floor));
  floorM.position.set(W/2, -GROUND, -1000 + 850);

  /* ---------- truss with moving heads and volumetric beams ---------- */
  const ZR = -600, trussY = at(640, 26, ZR).y;
  const truss = add(new THREE.Mesh(new THREE.BoxGeometry(5200, 16*px(ZR), 30), new THREE.MeshBasicMaterial({ color:0x140a22 })));
  truss.position.set(W/2, trussY, ZR);
  { const pts = []; for (let x=-1800; x<3100; x+=36){ pts.push(x, trussY + 12, ZR + 16, x + 18, trussY - 12, ZR + 16, x + 18, trussY - 12, ZR + 16, x + 36, trussY + 12, ZR + 16); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color:0x3a2658 }))); }
  const beamVS = `varying float vL; varying float vF; uniform float uLen;
    void main(){ vL = position.z/uLen; vec4 mv = modelViewMatrix*vec4(position,1.);
      vec3 n = normalize(normalMatrix*normal); vF = abs(dot(n, normalize(-mv.xyz))); gl_Position = projectionMatrix*mv; }`;
  const beamFS = `uniform vec3 uCol; uniform float uI; varying float vL; varying float vF;
    void main(){ float a = uI*pow(max(0., 1. - vL), 1.4)*pow(vF, 2.2); gl_FragColor = vec4(uCol*a, 1.); ${OUT} }`;
  const LB = 1700;
  const beamGeo = new THREE.CylinderGeometry(190, 5, LB, 40, 1, true).rotateX(Math.PI/2).translate(0, 0, LB/2);
  const heads = Array.from({ length:8 }, (_, i) => {
    const side = i < 4 ? 0 : 1, p = at(120 + i*148, 40, ZR);
    const body = add(new THREE.Mesh(new THREE.CylinderGeometry(14, 18, 34, 16), new THREE.MeshBasicMaterial({ color:0x1d1030 }))); body.position.copy(p);
    const lens = add(new THREE.Mesh(new THREE.SphereGeometry(9, 16, 12), new THREE.MeshBasicMaterial({ color:0xffffff, toneMapped:false }))); lens.position.copy(p).add(new THREE.Vector3(0, -16, 12));
    const mat = new THREE.ShaderMaterial({ uniforms:{ uCol:{ value:new THREE.Color() }, uI:{ value:0 }, uLen:{ value:LB } }, vertexShader:beamVS, fragmentShader:beamFS,
      transparent:true, depthWrite:false, blending:THREE.AdditiveBlending, side:THREE.DoubleSide });
    const beam = add(new THREE.Mesh(beamGeo, mat)); beam.position.copy(lens.position);
    return { side, i, beam, mat, lens, target:new THREE.Vector3() };
  });

  /* ---------- lasers: fan out from the LED wall when the crowd is hyped ---------- */
  const LL = 3200;
  const laserGeo = new THREE.CylinderGeometry(2.2, 2.2, LL, 6, 1, true).rotateX(Math.PI/2).translate(0, 0, LL/2);
  const lasers = Array.from({ length:14 }, (_, i) => {
    const mat = new THREE.MeshBasicMaterial({ color:[GOLD, C0, C1, WHITE][i % 4].clone(), transparent:true, opacity:0, blending:THREE.AdditiveBlending, depthWrite:false, toneMapped:false });
    const m = add(new THREE.Mesh(laserGeo, mat)); m.position.copy(at(i < 7 ? 395 : 885, 300, ZL + 40));
    return { m, mat, i };
  });

  /* ---------- speaker stacks at the stage edges ---------- */
  const ZS = -160;
  const speakers = [0,1].map(i => {
    const cones = [];
    for (let k=0;k<2;k++){
      const p = at(i ? W + 10 : -10, GROUND - 2 - (k + 0.5)*150, ZS), s = px(ZS);
      const box = add(new THREE.Mesh(new THREE.BoxGeometry(150*s, 150*s, 140), new THREE.MeshBasicMaterial({ color:0x0c0616 }))); box.position.copy(p);
      add(new THREE.LineSegments(new THREE.EdgesGeometry(box.geometry), new THREE.LineBasicMaterial({ color:0x2b1a42 }))).position.copy(p);
      const ring = add(new THREE.Mesh(new THREE.TorusGeometry(48*s, 3.2, 8, 48), new THREE.MeshBasicMaterial({ color:(i ? C1 : C0).clone(), transparent:true, toneMapped:false })));
      ring.position.copy(p).add(new THREE.Vector3(0, -8*s, 72));
      const core = add(new THREE.Mesh(new THREE.CircleGeometry(19*s, 32), new THREE.MeshBasicMaterial({ color:(i ? C1 : C0).clone(), transparent:true, blending:THREE.AdditiveBlending, toneMapped:false })));
      core.position.copy(ring.position).add(new THREE.Vector3(0, 0, 1));
      cones.push({ ring, core });
    }
    return cones;
  });

  /* ---------- floating dust in the air, lit by the rig ---------- */
  const NM = 420, mp = new Float32Array(NM*3), ms = new Float32Array(NM*4);
  for (let i=0;i<NM;i++){
    mp.set([Math.random()*2400 - 560, -(Math.random()*620), -Math.random()*1000 + 40], i*3);
    ms.set([Math.random()*6.28, 0.3 + Math.random()*0.7, (Math.random()*2 - 1)*14, 1 + Math.random()*2.2], i*4);
  }
  const mg = new THREE.BufferGeometry(); mg.setAttribute('position', new THREE.BufferAttribute(mp, 3)); mg.setAttribute('aS', new THREE.BufferAttribute(ms, 4));
  const motes = new THREE.ShaderMaterial({ uniforms:{ uTime:{ value:0 }, uPR:{ value:1 }, uHype:{ value:0 } }, transparent:true, depthWrite:false, blending:THREE.AdditiveBlending,
    vertexShader:`attribute vec4 aS; uniform float uTime, uPR; varying float vA;
      void main(){ vec3 p = position; p.x = mod(p.x + uTime*aS.z + 560., 2400.) - 560.; p.y += sin(uTime*aS.y + aS.x)*18.;
        vec4 mv = modelViewMatrix*vec4(p,1.); float tw = sin(uTime*2. + aS.x); vA = .35 + .65*tw*tw;
        gl_PointSize = aS.w*uPR*900./-mv.z; gl_Position = projectionMatrix*mv; }`,
    fragmentShader:`uniform float uHype; varying float vA;
      void main(){ float d = length(gl_PointCoord - .5); float a = smoothstep(.5, 0., d)*vA*(.35 + uHype*.5);
        gl_FragColor = vec4(vec3(1., .85, .95)*a, 1.); ${OUT} }` });
  add(new THREE.Points(mg, motes));

  /* ---------- per-frame texture painting ---------- */
  const isLive = () => ['fight','countdown','ko','roundEnd'].includes(G.state);
  function paintMarquee(time, ds){
    const { c, x } = marq, tr = fighters[ds].track;
    const label = tr ? `CROWD FAVOURITE ✦ ${tr.name.toUpperCase()} ✦ ${tr.artist.toUpperCase()} ✦ MASS ${B.massPct(tr)} ✦ ` : 'BPM BRAWL ✦ THE HEAVIER SONG WINS ✦ PICK A SONG ✦ LET IT FIGHT ✦ ';
    x.fillStyle = '#0a0414'; x.fillRect(0, 0, c.width, c.height);
    x.font = B.FONT(30); x.fillStyle = SIDES[ds].c; x.textBaseline = 'middle';
    const tw = x.measureText(label).width, off = (time*180) % tw;
    for (let p = -off; p < c.width; p += tw) x.fillText(label, p, c.height/2 + 2);
    marq.t.needsUpdate = true;
  }
  function paintTower(i, f){
    const { c, x } = towers[i], col = SIDES[i].c;
    x.fillStyle = '#07030d'; x.fillRect(0, 0, c.width, c.height);
    x.strokeStyle = '#2a1844'; x.lineWidth = 4; x.strokeRect(2, 2, c.width - 4, c.height - 4);
    x.textAlign = 'center'; x.textBaseline = 'alphabetic'; x.fillStyle = col;
    x.globalAlpha = 0.6 + f.pulse*0.4; x.font = B.FONT(108); x.fillText(B.fBpm(f), c.width/2, 130);
    x.globalAlpha = 0.85; x.font = B.FONT(28); x.fillText('BPM', c.width/2, 176);
    const fd = B.freqData, lvl = fd && isLive() ? fd[4 + i*2]/255 : 0.25 + f.pulse*0.5;
    for (let k=0;k<10;k++){
      x.globalAlpha = k/10 < lvl*(0.75 + f.pulse*0.35) ? 0.95 : 0.1; x.fillStyle = k > 7 ? '#ffffff' : col;
      x.fillRect(60, 420 - k*22, 160, 14);
    }
    x.globalAlpha = 1; towers[i].t.needsUpdate = true;
  }

  const tmp = new THREE.Vector3();
  function update(time, sx, sy, camera){
    const z = cam.z, ds = B.domSide(), df = fighters[ds];
    camera.position.set(cam.x - sx/z, -(PY + (H/2 - PY)/z) + sy/z, D0/z);
    const hype = G.hype, strobe = G.strobe, live = isLive();

    sky.uniforms.uTime.value = time; sky.uniforms.uHype.value = hype;
    B.drawLedContent(time, ds); ledTex.needsUpdate = true;
    led.uniforms.uBright.value = 0.75 + df.pulse*0.35 + strobe*0.8;
    paintMarquee(time, ds); fighters.forEach((f, i) => paintTower(i, f));
    riserStrip.uniforms.uTime.value = lipStrip.uniforms.uTime.value = time;

    // floor
    const fu = floor.uniforms;
    fu.uTime.value = time; fu.uBeat.value = B.frac1(B.beatPos(df)); fu.uHype.value = hype;
    fu.uF0.value.set(fighters[0].x, 0, fighters[0].pulse); fu.uF1.value.set(fighters[1].x, 0, fighters[1].pulse);
    fu.uLed.value.copy(ds ? C1 : C0).multiplyScalar(0.12 + df.pulse*0.12);

    // moving heads sweep across the stage and splash the floor where they land
    heads.forEach(h => {
      const f = fighters[h.side], k = h.i;
      const own = live ? (h.side === G.owner ? 1 : 0.45) : 0.75;
      const tx = 640 + Math.sin(time*0.8 + k*1.3)*560 + (h.side ? 120 : -120), tz = -120 + Math.cos(time*0.6 + k)*240;
      h.target.set(tx, -GROUND, tz); h.beam.lookAt(h.target);
      const I = (0.10 + f.pulse*0.16)*own + strobe*0.5 + hype*0.05;
      h.mat.uniforms.uI.value = I;
      h.mat.uniforms.uCol.value.copy(strobe > 0.15 ? WHITE : h.side ? C1 : C0);
      h.lens.scale.setScalar(0.8 + f.pulse*0.6);
      hits[k].set(tx, tz, I*1.6, h.side);
    });

    // lasers only when the hype is up
    const lz = (Math.max(0, hype - 0.35)*1.5 + strobe*1.5)*0.7;
    lasers.forEach(l => {
      const left = l.i < 7, j = l.i % 7, fan = (j - 3)*0.16 + Math.sin(time*1.6 + (left ? 0 : 1.7))*0.35;
      tmp.copy(l.m.position).add(new THREE.Vector3(Math.sin(fan)*1000*(left ? 1 : -1) + (left ? 300 : -300), -200 + Math.cos(time*1.1 + j)*120 - j*20, 1800));
      l.m.lookAt(tmp); l.mat.opacity = Math.min(1, lz)*(0.55 + 0.45*Math.sin(time*20 + j));
      l.m.visible = l.mat.opacity > 0.01;
    });

    // speakers thump with their own song
    speakers.forEach((cones, i) => cones.forEach(({ ring, core }) => {
      const p = fighters[i].pulse; ring.scale.setScalar(1 + p*0.12); ring.material.opacity = 0.4 + p*0.6; core.material.opacity = 0.15 + p*0.55;
    }));
    motes.uniforms.uTime.value = time; motes.uniforms.uHype.value = hype;
  }

  const setPixelRatio = pr => { motes.uniforms.uPR.value = pr; };
  return { scene, update, setPixelRatio, D0, PY, FOV };
}
