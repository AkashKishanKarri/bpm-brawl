import { useEffect, useRef, useState } from 'react';
import * as E from '../game/engine.js';
import { useEngine } from '../game/useEngine.js';

const { SIDES, COL, MAX_ROUNDS, PICK_TIME } = E;

export function Art({ t, className = 'art' }){
  if (t.art) return <img className={className} src={t.art} alt="" loading="lazy" />;
  return <div className={`${className} synth`} style={{ '--h': t.hue ?? 280 }}>{(t.genre || t.name)[0]}</div>;
}

/* ---------------- title ---------------- */
const loadNames = () => { try { return JSON.parse(localStorage.getItem('bpmBrawl.names') || '[]'); } catch { return []; } };
export function Title(){
  const [names, setNames] = useState(() => { const n = loadNames(); return [n[0] || '', n[1] || '']; });
  const go = mode => {
    const clean = names.map(E.cleanName);
    try { localStorage.setItem('bpmBrawl.names', JSON.stringify(clean)); } catch {}
    E.startMatch(mode, clean);
  };
  const field = (i, label) => (
    <label className={`n${i + 1}`}><span>{label}</span>
      <input value={names[i]} maxLength={12} placeholder={`Player ${i + 1} name`} autoComplete="off" spellCheck={false}
        onChange={e => setNames(n => { const c = [...n]; c[i] = e.target.value; return c; })}
        onKeyDown={e => { if (e.key === 'Enter') go('2p'); }} />
    </label>
  );
  return (
    <section id="title" className="ov">
      <div className="wrap">
        <h1 className="logo">BPM<br />BRAWL<small>THE HEAVIER SONG WINS</small></h1>
        <p className="tag">You don't fight. <b>Your song does.</b> Every round, pick a real song. Your fighter throws a hit on every beat it hears, and <b>the heavier the song, the harder it hits.</b> Big bass and big drops win.</p>
        <div className="names">{field(0, 'Magenta · left ear')}{field(1, 'Cyan · right ear')}</div>
        <div className="modes">
          <button className="btn p1" onClick={() => go('2p')}>2 Players</button>
          <button className="btn p2" onClick={() => go('cpu')}>Vs CPU</button>
        </div>
        <div className="ctrls">
          <div className="c1"><h4>How it works</h4>
            <dl><dt><kbd>1</kbd></dt><dd>Each player picks a song</dd><dt><kbd>2</kbd></dt><dd>Every beat in it is a hit</dd><dt><kbd>3</kbd></dt><dd>Drops land as big kicks</dd></dl>
          </div>
          <div className="c2"><h4>Song mass</h4>
            <dl><dt><kbd>Bass</kbd></dt><dd>Low end weight</dd><dt><kbd>Loud</kbd></dt><dd>How hot it's mastered</dd><dt><kbd>Punch</kbd></dt><dd>How hard the beat slams</dd></dl>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ---------------- song picker ---------------- */
function Row({ t, hl, playing, locked }){
  const ref = useRef(null);
  useEffect(() => { if (hl) ref.current?.scrollIntoView({ block:'nearest' }); }, [hl]);
  const real = t.kind !== 'synth' && t.bpm;
  return (
    <div ref={ref} className={`row${hl ? ' hl' : ''}`}>
      <Art t={t} />
      <div className="meta"><div className="t">{t.name}</div><div className="a">{t.artist}{t.genre ? ' · ' + t.genre : ''}</div></div>
      {t.bpm ? (
        <div className="bpmw">
          <div className="bpmc mass" title="Song mass: how hard it hits">{E.massPct(t)}<small>MASS</small></div>
          <div className="bpmc">{t.bpm}<small>BPM</small></div>
          {real && <div className="oct">
            <button disabled={locked || !E.canHalf(t)} onClick={() => E.setOctave(t, 0.5)} aria-label="Half time" title="Feels slower? Use half time">½</button>
            <button disabled={locked || !E.canDouble(t)} onClick={() => E.setOctave(t, 2)} aria-label="Double time" title="Feels faster? Use double time">×2</button>
          </div>}
        </div>
      ) : t.failed ? <div className="bpmc wait fail">Can't read</div> : <div className="bpmc wait">BPM</div>}
      <button className={`ibtn${playing ? ' on' : ''}`} disabled={locked} onClick={() => E.togglePreview(t)} aria-label={`${playing ? 'Stop preview' : 'Preview'} ${t.name}`}>{playing ? '■' : '▶'}</button>
      <button className="pbtn" disabled={locked || (t.failed && !t.bpm)} onClick={() => E.lockPick(t)}>Pick</button>
    </div>
  );
}
const Empty = ({ children }) => <div className="empty">{children}</div>;

export function Picker(){
  const { G, PK, lib, fighters } = useEngine();
  const who = E.pickWho(), opp = 1 - who, cpu = PK.cpu, col = SIDES[who].c;
  const rows = list => list.map(t => <Row key={t.id} t={t} hl={PK.hl === t.id} playing={lib.previewId === t.id} locked={cpu} />);
  const lastOpp = fighters[opp].track, last = fighters[who].track;
  const peek = G.mode === '2p' && !cpu ? ` ${E.nameOf(opp)}, look away!` : '';
  const ring = (1 - Math.max(0, Math.min(1, PK.shown/PICK_TIME)))*163.4;
  const fileRef = useRef(null);
  const TABS = [['hits', 'Hit list'], ['search', 'Search songs'], ['studio', 'Studio beats'], ['files', 'My files']];

  return (
    <section id="pick" className={`ov${cpu ? ' cpu' : ''}`}>
      <div className="pk">
        <header className="pk-head">
          <div>
            <div className="eyebrow">ROUND {G.round} OF {MAX_ROUNDS}</div>
            <h2 style={{ color: col }}>{cpu ? 'CPU IS PICKING A SONG' : `${E.nameOf(who)} (${E.sideOf(who)}), PICK YOUR SONG`}</h2>
            <p>{G.pickIdx === 0 ? <>{G.firstReason}: <b>{E.nameOf(who)}</b> picks first.</> : <><b>{E.nameOf(opp)}</b> has locked in a secret pick.</>} Picks stay hidden until the VS screen.{peek}</p>
          </div>
          <div className="vsbox">
            {G.picks[opp] ? <>
              <div className="art synth" style={{ '--h': opp ? 190 : 330 }}>?</div>
              <div><div className="lab" style={{ color: SIDES[opp].c }}>{E.nameOf(opp)} LOCKED IN</div><div className="tt">Secret until the reveal</div></div>
            </> : lastOpp ? <>
              <Art t={lastOpp} />
              <div><div className="lab" style={{ color: SIDES[opp].c }}>THEIR LAST SONG</div><div className="tt">{lastOpp.name}</div><div className="bb">{lastOpp.bpm} BPM</div></div>
            </> : <div><div className="lab" style={{ color: SIDES[opp].c }}>{E.nameOf(opp)}</div><div className="tt">Picks after you, blind</div></div>}
          </div>
          <div className="ring" aria-label="Time left to pick">
            <svg viewBox="0 0 60 60"><circle className="bg" cx="30" cy="30" r="26" /><circle className="fg" cx="30" cy="30" r="26" strokeDasharray="163.4" strokeDashoffset={ring} style={{ stroke: PK.shown < 10 ? COL.gold : COL.text }} /></svg>
            <span>{cpu ? '…' : PK.shown}</span>
          </div>
        </header>

        <div className="tabs" role="tablist">
          {TABS.map(([k, label]) => <button key={k} className={`tab${PK.tab === k ? ' on' : ''}`} role="tab" aria-selected={PK.tab === k} onClick={() => E.setTab(k)}>{label}</button>)}
          <span className="spacer" /><span className="note">Real songs, 20-second rounds, one song per round</span>
        </div>

        {PK.tab === 'hits' && <div className="pane"><div className="results">
          {lib.hitsState === 'ok' ? lib.sections.map(([key, title, sub]) => {
            const list = lib.hitTracks.filter(t => t.sec === key);
            return list.length ? [<div key={`s-${key}`} className="sec">{title}<small>{sub}</small></div>, ...rows(list)] : null;
          }) : <Empty>{lib.hitsState === 'error' ? <>Couldn't load the hit list. Check your internet connection, or pick from <b>Studio beats</b> and <b>My files</b>.</> : 'Loading the hit list…'}</Empty>}
        </div></div>}

        {PK.tab === 'search' && <div className="pane">
          <form className="sform" autoComplete="off" onSubmit={e => { e.preventDefault(); const q = PK.query.trim(); if (q) E.doSearch(q); }}>
            <input type="search" value={PK.query} onChange={e => E.setQuery(e.target.value)} placeholder="Search any song or artist" aria-label="Search songs" spellCheck={false} autoFocus={!cpu} readOnly={cpu} />
            <button type="submit" disabled={cpu}>Search</button>
          </form>
          <div className="chips">{E.CHIPS.map(c => <button key={c} type="button" className="chip" disabled={cpu} onClick={() => E.doSearch(c)}>{c}</button>)}</div>
          <div className="results">
            {lib.searchState === 'loading' ? <Empty>Searching for <b>{lib.lastQuery}</b>…</Empty>
              : lib.searchState === 'error' ? <Empty>{lib.searchError}</Empty>
              : !lib.lastResults.length ? (lib.searchState === 'ok'
                ? <Empty>No songs found for <b>{lib.lastQuery}</b>. Try an artist name.</Empty>
                : <Empty>Type any song or artist above, or tap a suggestion.<br />Each result shows its <b>BPM</b> once it's measured.</Empty>)
              : rows(lib.lastResults)}
          </div>
        </div>}

        {PK.tab === 'studio' && <div className="pane"><div className="results">{rows(lib.studio)}</div></div>}

        {PK.tab === 'files' && <div className="pane">
          <div className="upl">
            <button className="btn gold" type="button" disabled={cpu} onClick={() => fileRef.current?.click()}>Add song files</button>
            <input ref={fileRef} type="file" accept="audio/*" multiple hidden onChange={e => { const f = [...e.target.files]; e.target.value = ''; E.addFiles(f); }} />
            <span className="note">MP3, WAV or M4A from your computer. Mass and BPM are measured automatically.</span>
          </div>
          <div className="results">{lib.uploads.length ? rows(lib.uploads) : <Empty>Add MP3 or WAV files from your computer. They stay on this device.</Empty>}</div>
        </div>}

        <footer className="pk-foot">
          <p>{PK.hint}</p>
          {last && !cpu && <button className="btn ghost" onClick={E.keepLast}>Keep {last.name.length > 22 ? last.name.slice(0, 21) + '…' : last.name}</button>}
        </footer>
      </div>
    </section>
  );
}

/* ---------------- VS splash ---------------- */
export function Versus(){
  const { G } = useEngine();
  const side = (i, cls) => {
    const t = G.picks[i]; if (!t) return null;
    const bg = t.art ? `url("${t.art}")` : `linear-gradient(135deg,hsl(${t.hue} 80% 40%),#000)`;
    return (
      <div className={`vside ${cls}`} style={{ '--art': bg }}>
        <div className="who">{E.nameOf(i)}</div><Art t={t} />
        <div className="song">{t.name}</div><div className="art2">{t.artist}</div>
        <div className="big">{E.massPct(t)}<small>MASS</small></div>
        <div className="art2">{E.classOf(E.massOf(t))} · {t.bpm} BPM</div>
      </div>
    );
  };
  return <section id="vs" className="ov">{side(0, 'a')}{side(1, 'b')}<div className="vsmark">VS</div><div className="vsflash" /></section>;
}

/* ---------------- result ---------------- */
export function Result(){
  const { G, fighters, result, mix } = useEngine();
  const [a, b] = fighters, win = result.win;
  const rows = [['HP left', f => Math.ceil(f.hp)], ['Damage dealt', f => Math.round(f.stats.dmg)], ['Hits landed', f => f.stats.hits],
    ['Drops', f => f.stats.crits], ['Best combo', f => f.stats.maxCombo], ['Beats swung', f => f.stats.swings]];
  return (
    <section id="result" className="ov dim">
      <div className="box">
        <div className="how">{result.ko ? `KNOCKOUT · ROUND ${G.round}` : `DECISION AFTER ${MAX_ROUNDS} ROUNDS`}</div>
        <h2 className="winner" style={{ color: win < 0 ? COL.gold : SIDES[win].c }}>{win < 0 ? 'DRAW' : `${E.nameOf(win)} WINS`}</h2>
        <div id="rstats">{rows.map(([k, fn], i) => [
          <span key={`a${i}`} className="a" style={{ '--d': `${i*70}ms` }}>{fn(a)}</span>,
          <span key={`k${i}`} className="k" style={{ '--d': `${i*70}ms` }}>{k}</span>,
          <span key={`b${i}`} className="b" style={{ '--d': `${i*70}ms` }}>{fn(b)}</span>])}</div>
        <div className="songs">{[0, 1].map(i => <ol key={i}>{G.history[i].map((t, j) => <li key={j}><span>{t.name}</span><b>{E.massPct(t)}</b></li>)}</ol>)}</div>
        <div className="rowb">
          <button className="btn p1" onClick={E.rematch}>Rematch</button>
          {mix.url && <a className="btn gold" href={mix.url} download={mix.name}>Save the mix</a>}
          <button className="btn ghost" onClick={E.toMenu}>Menu</button>
        </div>
      </div>
    </section>
  );
}

export function Pause(){
  return (
    <section id="pause" className="ov dim">
      <div className="box"><h2>PAUSED</h2>
        <div className="rowb">
          <button className="btn p2" onClick={E.togglePause}>Resume</button>
          <button className="btn ghost" onClick={E.toMenu}>Quit to menu</button>
        </div>
      </div>
    </section>
  );
}

export function Toast(){
  const { toastState } = useEngine();
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!toastState.id) return;
    setOn(true); const t = setTimeout(() => setOn(false), 2600); return () => clearTimeout(t);
  }, [toastState.id]);
  return <div id="toast" className={on ? 'on' : ''} role="status">{toastState.msg}</div>;
}
