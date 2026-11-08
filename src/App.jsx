import { Component, useEffect, useRef, useState } from 'react';
import * as E from './game/engine.js';
import { useEngine } from './game/useEngine.js';
import Stage3D from './stage/Stage3D.jsx';
import { Title, Picker, Versus, Result, Pause, Toast } from './ui/Screens.jsx';

// if WebGL can't start, render nothing here and the engine keeps its 2D stage
class Guard extends Component {
  state = { failed:false };
  static getDerivedStateFromError(){ return { failed:true }; }
  componentDidCatch(e){ console.warn('3D stage unavailable:', e); }
  render(){ return this.state.failed ? null : this.props.children; }
}
const hasWebGL = () => { try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch { return false; } };

export default function App(){
  const cv = useRef(null);
  const [gl, setGl] = useState(hasWebGL);
  const { G } = useEngine();
  useEffect(() => E.mount(cv.current), []);
  const s = G.state;
  return (
    <div id="stage" className={`st-${s}`}>
      {gl && <Guard><Stage3D onFail={() => setGl(false)} /></Guard>}
      <canvas id="cv" ref={cv} aria-label="BPM Brawl arena" />
      {s === 'title' && <Title />}
      {s === 'pick' && <Picker />}
      {s === 'vs' && <Versus />}
      {s === 'result' && <Result />}
      {s === 'paused' && <Pause />}
      <button className="fsbtn" type="button" aria-label="Toggle full screen" title="Full screen (F)" onClick={e => { e.currentTarget.blur(); E.toggleFull(); }}>⛶</button>
      <Toast />
    </div>
  );
}
