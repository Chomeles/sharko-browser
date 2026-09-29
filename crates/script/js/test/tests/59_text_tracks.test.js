'use strict';
// Text tracks: HTMLTrackElement.track, media.textTracks / addTextTrack, TextTrackList,
// TextTrackCue / VTTCue / TextTrackCueList and the addtrack / removetrack / change events.
const assert = require('assert');
const { createEnv } = require('../harness');

const VIDEO = `<video id="v" muted>
  <track id="tr" kind="captions" src="/captions.vtt" srclang="en" label="English" default>
  <track id="t2" kind="bogus"><track id="t3"></video><track id="orphan">`;

test('text tracks: <track>.track and media.textTracks follow the child <track> elements', async () => {
  const e = await createEnv({ html: VIDEO });
  // the svelte.dev case: `track.cues` and `textTracks[0].mode` on a video with a <track>
  assert.strictEqual(e.run(`
    var v = document.getElementById('v'), tr = document.getElementById('tr'), tt = v.textTracks;
    [tr.track !== null, tt.length, String(tr.track.cues), tt[0].mode, tt[0] === tr.track, tt === v.textTracks].join('|')`), 'true|3|null|disabled|true|true');
  assert.strictEqual(e.run("[tr.track.kind, tr.track.label, tr.track.language, tr.track.id, tr.readyState].join()"), 'captions,English,en,tr,0');
  // kind/label/language/id follow the attributes; an invalid kind is "metadata", a missing one "subtitles"
  assert.strictEqual(e.run("[tt[1].kind, tt[2].kind, tt[2].label === '', tt[2].language === ''].join()"), 'metadata,subtitles,true,true');
  e.run("tr.setAttribute('kind', 'CHAPTERS'); tr.label = 'Kapitel'; tr.srclang = 'de'; tr.id = 'x'");
  assert.strictEqual(e.run("[tr.track.kind, tr.track.label, tr.track.language, tr.track.id, tt.getTrackById('x') === tr.track, String(tt.getTrackById('nope'))].join()"), 'chapters,Kapitel,de,x,true,null');
  // interfaces
  assert.strictEqual(e.run("[tt instanceof TextTrackList, tr.track instanceof TextTrack, tr.track instanceof EventTarget, [...tt].length, Object.prototype.toString.call(tt)].join()"), 'true,true,true,3,[object TextTrackList]');
  assert.throws(() => e.run('new TextTrack()'), /Illegal constructor/);
  // a <track> outside a media element still has a track, of its own
  assert.strictEqual(e.run("var o = document.getElementById('orphan'); [o.track.mode, o.track.cues, o.track === o.track].join()"), 'disabled,,true');
  // an element created by script
  assert.strictEqual(e.run("var m = document.createElement('audio'); m.innerHTML = '<track kind=descriptions>'; [m.textTracks.length, m.textTracks[0].kind, m.firstChild.track === m.textTracks[0]].join()"), '1,descriptions,true');
  // `mode`: only the three keywords are accepted, and cues exist once the track is not disabled
  assert.strictEqual(e.run("tt[0].mode = 'bogus'; var a = tt[0].mode; tt[0].mode = 'hidden'; [a, tt[0].mode, tt[0].cues.length, tt[0].cues === tt[0].cues, tt[0].activeCues.length].join()"), 'disabled,hidden,0,true,0');
  e.run("tt[0].mode = 'disabled'");
  assert.strictEqual(e.run('tt[0].cues'), null);
});

test('text tracks: addtrack / removetrack / change events and addTextTrack', async () => {
  const e = await createEnv({ html: VIDEO });
  e.run(`
    var v = document.getElementById('v'), tt = v.textTracks, tr = document.getElementById('tr'), log = [];
    tt.onaddtrack = (ev) => log.push('add:' + ev.track.id + ':' + (ev instanceof TrackEvent) + ':' + ev.isTrusted + ':' + ev.bubbles);
    tt.onremovetrack = (ev) => log.push('remove:' + ev.track.id);
    tt.addEventListener('change', () => log.push('change'));`);
  const flushed = async () => { await e.flush(); const l = e.run("log.join()"); e.run('log.length = 0'); return l; };
  // adding and removing <track> children queues the events (they are not synchronous)
  e.run("var n = document.createElement('track'); n.id = 'n1'; v.appendChild(n)");
  assert.strictEqual(e.run('log.length'), 0);
  assert.strictEqual(await flushed(), 'add:n1:true:true:false');
  assert.strictEqual(e.run('tt.length + "," + tt[3].id'), '4,n1');
  e.run("tr.remove(); v.insertBefore(document.getElementById('t3'), v.firstChild)");
  assert.strictEqual(await flushed(), 'remove:tr');
  assert.strictEqual(e.run("[...tt].map((t) => t.id).join()"), 't3,t2,n1');
  // the element's track survives being taken out and put back
  assert.strictEqual(e.run("var tk = tr.track; v.appendChild(tr); tt[tt.length - 1] === tk"), true);
  assert.strictEqual(await flushed(), 'add:tr:true:true:false');
  // addTextTrack: appended after the element tracks, "hidden", loaded, with its own attributes
  assert.strictEqual(e.run(`
    var at = v.addTextTrack('metadata', 'lbl', 'de');
    [at.kind, at.label, at.language, at.mode, at.id === '', at.cues.length, tt.length, tt[tt.length - 1] === at].join()`), 'metadata,lbl,de,hidden,true,0,5,true');
  assert.strictEqual(await flushed(), 'add::true:true:false');
  e.run("document.getElementById('t2').remove()");
  assert.strictEqual(e.run('tt[tt.length - 1] === at'), true);
  await flushed();
  assert.strictEqual(e.run("v.addTextTrack('captions').label + v.addTextTrack('subtitles', undefined, undefined).language"), '');
  assert.throws(() => e.run("v.addTextTrack('bogus')"), /not a valid enum value of type TextTrackKind/);
  await flushed();
  // one change event per batch of mode changes, none for a no-op or an invalid value
  e.run("at.mode = 'showing'; tt[0].mode = 'hidden'; at.mode = 'showing'; at.mode = 'nope'");
  assert.strictEqual(await flushed(), 'change');
  e.run("at.mode = 'showing'");
  assert.strictEqual(await flushed(), '');
  // a media element nobody asked textTracks of works without any of it
  assert.strictEqual(e.run("var v2 = document.createElement('video'); v2.appendChild(document.createElement('track')); v2.textTracks.length"), 1);
});

test('text tracks: cues, VTTCue, TextTrackCueList', async () => {
  const e = await createEnv({ html: VIDEO });
  e.run("var v = document.getElementById('v'); var at = v.addTextTrack('captions')");
  assert.strictEqual(e.run(`
    var c = new VTTCue(1, 3, 'hi <b>there</b> &amp; you');
    [c.startTime, c.endTime, c.text, c.id === '', c.pauseOnExit, String(c.track), c.vertical === '', c.snapToLines, c.line, c.lineAlign, c.position, c.positionAlign, c.size, c.align,
     c instanceof TextTrackCue, c instanceof EventTarget, c.getCueAsHTML().textContent].join('|')`),
  '1|3|hi <b>there</b> &amp; you|true|false|null|true|true|auto|start|auto|auto|100|center|true|true|hi there & you');
  // cues are kept in cue order: start time, then the longer cue first; equal cues in insertion order
  e.run(`
    var c2 = new VTTCue(0, 5, 'a'), c3 = new VTTCue(1, 2, 'b'), c4 = new VTTCue(1, 3, 'c');
    at.addCue(c); at.addCue(c2); at.addCue(c3); at.addCue(c4);`);
  assert.strictEqual(e.run("Array.from(at.cues, (x) => x.text).join()"), 'a,hi <b>there</b> &amp; you,c,b');
  assert.strictEqual(e.run("[at.cues.length, c.track === at, at.cues[0] === c2, at.cues[4], typeof at.cues.item].join()"), '4,true,true,,undefined');
  // the list is live, and a changed cue time re-sorts it
  e.run("c3.startTime = -1");
  assert.strictEqual(e.run("at.cues[0] === c3 && at.cues.length === 4"), true);
  e.run("c.id = 'cid'");
  assert.strictEqual(e.run("[at.cues.getCueById('cid') === c, at.cues.getCueById('zz'), at.cues.getCueById('')].join()"), 'true,,');
  // adding a cue that belongs to another track moves it; removing one that isn't listed throws
  e.run("var other = v.addTextTrack('metadata'); other.addCue(c4)");
  assert.strictEqual(e.run("[at.cues.length, other.cues.length, c4.track === other].join()"), '3,1,true');
  assert.strictEqual(e.run("try { at.removeCue(c4); 'no' } catch (x) { x.name + ':' + (x instanceof DOMException) }"), 'NotFoundError:true');
  e.run("other.removeCue(c4)");
  assert.strictEqual(e.run("[other.cues.length, c4.track].join()"), '0,');
  assert.throws(() => e.run("at.addCue({})"), /parameter 1 is not of type 'TextTrackCue'/);
  // validation, and enumerated attributes ignoring invalid values
  assert.strictEqual(e.run("c.align = 'left'; c.align = 'bogus'; c.vertical = 'rl'; c.line = 'auto'; c.line = 3; c.position = 50; c.size = 0; [c.align, c.vertical, c.line, c.position, c.size].join()"), 'left,rl,3,50,0');
  assert.strictEqual(e.run("try { c.size = 101 } catch (x) { x.name }"), 'IndexSizeError');
  assert.strictEqual(e.run("try { c.startTime = NaN } catch (x) { x.constructor.name }"), 'TypeError');
  assert.throws(() => e.run("new VTTCue(0, 1)"), /3 arguments required/);
  assert.throws(() => e.run("new TextTrackCue()"), /Illegal constructor/);
  // a <track> element's own cues, and a `src` change drops them
  e.run("var trk = document.getElementById('tr').track; trk.mode = 'hidden'; trk.addCue(new VTTCue(0, 1, 'x'))");
  assert.strictEqual(e.run('trk.cues.length'), 1);
  e.run("document.getElementById('tr').src = '/other.vtt'");
  assert.strictEqual(e.run('trk.cues.length'), 0);
  // event handler attributes
  assert.strictEqual(e.run("var f = () => {}; at.oncuechange = f; c.onenter = f; c.onexit = null; [at.oncuechange === f, c.onenter === f, c.onexit].join()"), 'true,true,');
  // many tracks: index access grows with the list
  assert.strictEqual(e.run("var m = document.createElement('video'); for (var i = 0; i < 40; i++) m.addTextTrack('metadata', 'l' + i); [m.textTracks.length, m.textTracks[39].label, m.textTracks[40]].join()"), '40,l39,');
  // TrackEvent
  assert.strictEqual(e.run("var ev = new TrackEvent('addtrack', { track: trk }); [ev.track === trk, ev.type, new TrackEvent('x').track].join()"), 'true,addtrack,');
});
