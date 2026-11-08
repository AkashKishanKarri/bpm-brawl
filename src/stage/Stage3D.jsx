import { useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame, useThree, advance } from '@react-three/fiber';
import { Sparkles } from '@react-three/drei';
import { EffectComposer, Bloom, ChromaticAberration, Vignette, Noise, ShockWave, Scanline } from '@react-three/postprocessing';
import { BlendFunction } from 'postprocessing';
import * as THREE from 'three';
import { stageAPI, attachStage, G } from '../game/engine.js';
import { useEngine } from '../game/useEngine.js';
import { buildStage } from './buildStage.js';

const { W, H, GROUND, cam } = stageAPI;

// the engine owns the clock: it calls advance() once per game frame, so 2D and 3D never drift
function Driver(){
  useEffect(() => attachStage({ draw: time => advance(time*1000) }), []);
  return null;
}

function Scene(){
  const stage = useMemo(() => buildStage(stageAPI), []);
  const camera = useThree(s => s.camera);
  const size = useThree(s => s.size);
  const dpr = useThree(s => s.viewport.dpr);
  useEffect(() => { stage.setPixelRatio(dpr*size.width/W); }, [stage, dpr, size.width]);
  // R3F aims a new camera at the origin; this one must look straight down -z to line up with the 2D layer
  useEffect(() => { camera.rotation.set(0, 0, 0); camera.fov = stage.FOV; camera.near = 20; camera.far = 8000; camera.updateProjectionMatrix(); }, [camera, stage]);
  useFrame(() => stage.update(performance.now()/1000, G.sx || 0, G.sy || 0, camera));
  return <primitive object={stage.scene} />;
}

// hype sparkles drifting over the crowd line
function HypeSparkles(){
  return <Sparkles count={90} scale={[1800, 380, 500]} position={[W/2, -GROUND + 240, -250]} size={60} speed={0.6} opacity={0.6} color="#ffd8f0" noise={2} />;
}

function Effects({ quality }){
  const wave = useRef(), bloom = useRef();
  const lastKO = useRef(0);
  const offset = useMemo(() => new THREE.Vector2(0, 0), []);
  const lastWave = useRef(0), tmp = useMemo(() => new THREE.Vector3(), []);
  useFrame((_, dt) => {
    // chromatic split kicks on every landed hit and fades out
    G.kick = Math.max(0, (G.kick || 0) - dt*3.5);
    // a knockout tears the picture apart for a moment
    const ko = G.koT ? Math.max(0, 1 - (performance.now() - G.koT)/900) : 0;
    const k = G.kick*0.0035 + (G.strobe || 0)*0.002 + ko*ko*0.022;
    offset.set(k, k*0.4);
    if (bloom.current) bloom.current.intensity = 0.9 + (G.hype || 0)*0.35 + (G.strobe || 0)*0.6;
    // and sends a shockwave out from the fallen fighter
    if (wave.current && G.koT && G.koT !== lastKO.current && G.impactAt){
      lastKO.current = G.koT;
      wave.current.position.set(G.impactAt.x, -G.impactAt.y, 0); wave.current.explode();
    }
    // drops send a shockwave through the whole frame from the point of impact
    if (wave.current && G.wave && G.wave.seq !== lastWave.current){
      lastWave.current = G.wave.seq;
      wave.current.position.copy(tmp.set(G.wave.x, -G.wave.y, 0));
      wave.current.explode();
    }
  });
  if (quality >= 2) return null;
  return (
    <EffectComposer multisampling={0}>
      <Bloom ref={bloom} mipmapBlur luminanceThreshold={0.16} luminanceSmoothing={0.3} intensity={0.9} radius={0.72} />
      <ShockWave ref={wave} speed={1.6} maxRadius={0.6} waveSize={0.18} amplitude={0.07} />
      <ChromaticAberration offset={offset} radialModulation modulationOffset={0.25} blendFunction={BlendFunction.NORMAL} />
      <Scanline density={1.6} opacity={0.045} />
      <Noise opacity={0.035} premultiply />
      <Vignette offset={0.32} darkness={0.55} />
    </EffectComposer>
  );
}

export default function Stage3D({ onFail }){
  const { quality } = useEngine(e => ({ quality: e.quality }));
  // same resolution cap as the 2D layer, so slow machines drop both together
  const cap = stageAPI.RES_CAP[quality] || 1024;
  const dpr = Math.min(window.devicePixelRatio || 1, cap/Math.max(1, Math.min(window.innerWidth - 32, (window.innerHeight - 20)*16/9)));
  const D0 = (H/2)/Math.tan(THREE.MathUtils.degToRad(20));
  return (
    <Canvas
      className="gl"
      frameloop="never"
      flat
      dpr={Math.max(0.5, dpr)}
      gl={{ antialias:false, powerPreference:'high-performance', stencil:false }}
      camera={{ fov:40, near:20, far:8000, position:[W/2, -360, D0] }}
      onCreated={({ gl }) => {
        gl.setClearColor(0x05010b, 1);
        gl.domElement.addEventListener('webglcontextlost', e => { e.preventDefault(); onFail?.(); });
      }}
      aria-hidden="true"
    >
      <Driver />
      <Scene />
      <HypeSparkles />
      <Effects quality={quality} />
    </Canvas>
  );
}
