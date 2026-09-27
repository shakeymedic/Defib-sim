// ECG rhythm engine: waveforms, R-wave positions, pacing, artefacts and grid
(function(){'use strict';

// --- GLOBAL SETTINGS ---
// Exposed globally to prevent "variable not found" errors
window.PX_PER_BIG = 25;
window.PX_PER_MM = 5;
window.PX_PER_MV = 50;  // 10mm/mV standard calibration
window.ecgSpeed = 125;  // 25mm/sec * 5px/mm = 125 px/sec
window.waveformX = 0;   // GLOBAL X POSITION

function setSpeed(pxPerSec){ window.ecgSpeed = pxPerSec; }

// --- STABLE MATH HELPERS ---
var TWO_PI = 2 * Math.PI;

// Gaussian Bell Curve: Renders a smooth spike that never "bounces" between pixels
// (negative values are upwards on the canvas)
function gaussian(t, center, width, amp) {
    var x = (t - center);
    return -amp * Math.exp(-0.5 * (x * x) / (width * width));
}

// Deterministic pseudo-random value in [0, 1). Used instead of Math.random()
// so the same point of the trace looks the same on every frame (no flicker).
function hash(n) {
    var s = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
    return s - Math.floor(s);
}

function mv(v) { return window.PX_PER_MV * v; }

// Rate-corrected QT (Bazett-style) so T waves move closer at faster rates
function qtScale(rr) { return Math.sqrt(Math.min(Math.max(rr, 0.3), 2) / 0.8); }

// --- BEAT SHAPES ---
// Times are in seconds from the start of the beat so complex widths stay
// physiological at any rate. rr = R-R interval in seconds.
var NARROW_R = 0.2;   // R-wave peak of a supraventricular beat
var WIDE_R = 0.2;     // peak of a broad ventricular beat
var PACED_R = 0.1;    // broad paced complex, 100ms after the pacer spike

function pWave(s) { return gaussian(s, 0.12, 0.032, mv(0.15)); }

function narrowBeat(s, rr, opts) {
    var y = 0;
    if (!opts.hideP) y += pWave(s);                              // P
    y += gaussian(s, 0.184, 0.0064, -mv(0.1));                  // Q
    y += gaussian(s, NARROW_R, 0.012, mv(1.5));                 // R
    y += gaussian(s, 0.216, 0.008, -mv(0.3));                   // S
    y += gaussian(s, NARROW_R + 0.24 * qtScale(rr), 0.07, mv(opts.tAmp)); // T
    return y;
}

function wideBeat(s, rr, peak) {
    var y = gaussian(s, peak, 0.04, mv(1.2));                        // Broad QRS (~160ms)
    y += gaussian(s, peak + 0.3 * qtScale(rr), 0.08, -mv(0.35));      // Discordant T
    return y;
}

var SINUS = { hideP: false, tAmp: 0.3 };
var NO_P = { hideP: true, tAmp: 0.3 };
var SVT_BEAT = { hideP: true, tAmp: 0.2 };
var AF_BEAT = { hideP: true, tAmp: 0.15 };
var FLUTTER_BEAT = { hideP: true, tAmp: 0.1 };

function rateOf(hr, fallback) { return hr > 0 ? hr : fallback; }

// Positions n*cyclePx + off that fall within [x0, x1]
function regularPositions(x0, x1, cyclePx, off) {
    var out = [];
    for (var n = Math.floor((x0 - off) / cyclePx); ; n++) {
        var p = n * cyclePx + off;
        if (p > x1) break;
        if (p >= x0) out.push(p);
    }
    return out;
}

// A regular rhythm: one beat shape repeated every R-R interval.
// The previous beat is added too so its T wave is never cut off at fast rates.
function periodic(defaultRate, beat, rPeak) {
    return {
        y: function(x, hr) {
            var rr = 60 / rateOf(hr, defaultRate);
            var cyclePx = rr * window.ecgSpeed;
            var s = (x - Math.floor(x / cyclePx) * cyclePx) / window.ecgSpeed;
            return beat(s, rr) + beat(s + rr, rr);
        },
        peaks: function(x0, x1, hr) {
            var rr = 60 / rateOf(hr, defaultRate);
            return regularPositions(x0, x1, rr * window.ecgSpeed, rPeak * window.ecgSpeed);
        }
    };
}

// --- RHYTHMS ---

// VT: Monomorphic, broad, sinusoidal
function vtShape(t) { return Math.sin(TWO_PI * t) - 0.2 * Math.sin(2 * TWO_PI * t - 0.2); }
var VT_PEAK_T = (function() {
    var best = 0, bestVal = -Infinity;
    for (var t = 0; t < 1; t += 0.001) { var v = vtShape(t); if (v > bestVal) { bestVal = v; best = t; } }
    return best;
})();

function ventricularTachy(defaultRate) {
    return {
        y: function(x, hr) {
            var cyclePx = (60 / rateOf(hr, defaultRate)) * window.ecgSpeed;
            var t = (x % cyclePx) / cyclePx;
            return -vtShape(t) * mv(1.4);
        },
        peaks: function(x0, x1, hr) {
            var cyclePx = (60 / rateOf(hr, defaultRate)) * window.ecgSpeed;
            return regularPositions(x0, x1, cyclePx, VT_PEAK_T * cyclePx);
        }
    };
}

// VF: chaotic, no identifiable QRS complexes. Coarse and fine differ in amplitude.
function ventricularFibrillation(ampScale) {
    return {
        y: function(x) {
            var s = x / window.ecgSpeed;
            var amp = 0.45 + 0.2 * Math.sin(TWO_PI * 0.13 * s) + 0.12 * Math.sin(TWO_PI * 0.31 * s + 1.7);
            var v = Math.sin(TWO_PI * 4.6 * s + 1.4 * Math.sin(TWO_PI * 0.53 * s))
                  + 0.55 * Math.sin(TWO_PI * 6.7 * s + 0.9 * Math.sin(TWO_PI * 0.37 * s + 2.1))
                  + 0.3 * Math.sin(TWO_PI * 9.3 * s + 0.4);
            return -v * mv(amp) * 0.6 * ampScale;
        },
        peaks: function() { return []; }
    };
}

// AF: Irregularly irregular narrow complexes over a fibrillating baseline.
// Beat positions are stored in "mean beat" units so they stay put between frames.
var afBeats = [0];
function afAddBeat() {
    var k = afBeats.length;
    afBeats.push(afBeats[k - 1] + 0.55 + 0.9 * hash(k));
}
function afIndex(u) {
    while (afBeats[afBeats.length - 1] <= u + 2) afAddBeat();
    var lo = 0, hi = afBeats.length - 1;
    while (lo < hi) {
        var mid = (lo + hi + 1) >> 1;
        if (afBeats[mid] <= u) lo = mid; else hi = mid - 1;
    }
    return lo;
}
var afib = {
    y: function(x, hr) {
        var rr = 60 / rateOf(hr, 155);
        var u = Math.max(0, x / (rr * window.ecgSpeed));
        var i = afIndex(u);
        var y = narrowBeat((u - afBeats[i]) * rr, rr, AF_BEAT);
        if (i > 0) y += narrowBeat((u - afBeats[i - 1]) * rr, rr, AF_BEAT);
        var s = x / window.ecgSpeed;
        y += mv(0.06) * Math.sin(TWO_PI * 6.3 * s + 0.8 * Math.sin(TWO_PI * 0.7 * s));
        y += mv(0.035) * Math.sin(TWO_PI * 8.9 * s + 1.3);
        return y;
    },
    peaks: function(x0, x1, hr) {
        var rr = 60 / rateOf(hr, 155);
        var cyclePx = rr * window.ecgSpeed;
        var offU = NARROW_R / rr;
        var out = [];
        for (var i = afIndex(Math.max(0, x0 / cyclePx - offU)); ; i++) {
            while (afBeats.length <= i) afAddBeat();
            var p = (afBeats[i] + offU) * cyclePx;
            if (p > x1) break;
            if (p >= x0) out.push(p);
        }
        return out;
    }
};

// Atrial flutter: saw-tooth flutter waves at ~300/min with regular block
// (2:1 at a ventricular rate of 150/min)
var flutter = {
    y: function(x, hr) {
        var rr = 60 / rateOf(hr, 150);
        var block = Math.max(1, Math.round(rr / 0.2));
        var fPeriod = rr / block;
        var s = x / window.ecgSpeed;
        var f = (s / fPeriod) % 1;
        // Slow downward slope then a sharp return (inferior-lead saw-tooth)
        var saw = f < 0.8 ? (f / 0.8 - 0.5) : (0.5 - (f - 0.8) / 0.2);
        var cyclePx = rr * window.ecgSpeed;
        var sb = (x - Math.floor(x / cyclePx) * cyclePx) / window.ecgSpeed;
        return mv(0.25) * saw + narrowBeat(sb, rr, FLUTTER_BEAT) + narrowBeat(sb + rr, rr, FLUTTER_BEAT);
    },
    peaks: function(x0, x1, hr) {
        var rr = 60 / rateOf(hr, 150);
        return regularPositions(x0, x1, rr * window.ecgSpeed, NARROW_R * window.ecgSpeed);
    }
};

// Mobitz II: regular P waves at 75/min with a constant PR interval and
// every third P wave not conducted (3:2 block, ventricular rate 50/min)
var MOBITZ_PP = 0.8;
var mobitz2 = {
    y: function(x) {
        var s = x / window.ecgSpeed;
        var k = Math.floor(s / MOBITZ_PP);
        var y = 0;
        for (var j = k - 1; j <= k; j++) {
            if (j < 0) continue;
            var sj = s - j * MOBITZ_PP;
            y += (j % 3 === 2) ? pWave(sj) : narrowBeat(sj, MOBITZ_PP * 1.5, SINUS);
        }
        return y;
    },
    peaks: function(x0, x1) {
        var cyclePx = MOBITZ_PP * window.ecgSpeed;
        return regularPositions(x0, x1, cyclePx, NARROW_R * window.ecgSpeed).filter(function(p) {
            var j = Math.round((p - NARROW_R * window.ecgSpeed) / cyclePx);
            return ((j % 3) + 3) % 3 !== 2;
        });
    }
};

// Asystole: near-flat line with slight baseline wander
var asystole = {
    y: function(x) { return Math.sin(x * 0.002) * 4; },
    peaks: function() { return []; }
};

// CHB: P waves at 75/min completely dissociated from a slow broad escape rhythm
var chbVentricle = periodic(32, function(s, rr) { return wideBeat(s, rr, WIDE_R); }, WIDE_R);
var chb = {
    y: function(x, hr) {
        var s = x / window.ecgSpeed;
        return pWave(s % 0.8) + chbVentricle.y(x, hr);
    },
    peaks: chbVentricle.peaks
};

// Permanent pacemaker rhythm: pacing spike followed by a broad complex
var pacedRhythm = periodic(70, function(s, rr) { return wideBeat(s, rr, PACED_R); }, PACED_R);
pacedRhythm.spikes = function(x0, x1, hr) {
    var rr = 60 / rateOf(hr, 70);
    return regularPositions(x0, x1, rr * window.ecgSpeed, 0);
};

// --- MAPPING ---
// hr is the rate shown on the monitor, so the drawn rate always matches it
var rhythms = {
    nsr:             periodic(75,  function(s, rr) { return narrowBeat(s, rr, SINUS); }, NARROW_R),
    sinus:           periodic(75,  function(s, rr) { return narrowBeat(s, rr, SINUS); }, NARROW_R),
    pea:             periodic(70,  function(s, rr) { return narrowBeat(s, rr, SINUS); }, NARROW_R),
    sinus_brady:     periodic(45,  function(s, rr) { return narrowBeat(s, rr, SINUS); }, NARROW_R),
    sinus_tach:      periodic(120, function(s, rr) { return narrowBeat(s, rr, SINUS); }, NARROW_R),
    brady:           periodic(38,  function(s, rr) { return narrowBeat(s, rr, NO_P); }, NARROW_R), // Junctional: no P waves
    svt:             periodic(190, function(s, rr) { return narrowBeat(s, rr, SVT_BEAT); }, NARROW_R),
    idioventricular: periodic(40,  function(s, rr) { return wideBeat(s, rr, WIDE_R); }, WIDE_R),
    paced:           pacedRhythm,
    vtach:           ventricularTachy(180),
    vt_pulseless:    ventricularTachy(180),
    vfib:            ventricularFibrillation(1),
    vfib_fine:       ventricularFibrillation(0.3),
    afib:            afib,
    flutter:         flutter,
    mobitz2:         mobitz2,
    chb:             chb,
    asystole:        asystole
};

// --- LEADS ---
// Relative QRS size in each monitoring lead (PADS is roughly lead II)
var LEAD_GAIN = { PADS: 0.9, I: 0.55, II: 1, III: 0.45 };

// --- ARTEFACT LOGIC ---
// Each artefact is stored as a list of trace segments [start, end) in trace
// x-coordinates, so an artefact switched on now sweeps in from the write
// position rather than instantly changing the part of the trace already drawn.
var artefactSegments = { cpr: [], movement: [], leadoff: [] };

function artefactAt(type, x) {
    var segs = artefactSegments[type];
    for (var i = 0; i < segs.length; i++) {
        if (x >= segs[i].start && (segs[i].end === null || x < segs[i].end)) return true;
    }
    return false;
}

window.ecgArtefacts = {
    set: function(type, on, nowX) {
        var segs = artefactSegments[type];
        if (!segs) return;
        var open = segs.length > 0 && segs[segs.length - 1].end === null;
        if (on && !open) segs.push({ start: nowX, end: null });
        else if (!on && open) segs[segs.length - 1].end = nowX;
        // Drop segments that are no longer on screen
        artefactSegments[type] = segs.filter(function(s) { return s.end === null || s.end >= window.waveformX; });
    },
    reset: function(active) {
        Object.keys(artefactSegments).forEach(function(type) {
            artefactSegments[type] = active[type] ? [{ start: 0, end: null }] : [];
        });
    }
};

function applyArtefacts(y, x) {
    var s = x / window.ecgSpeed;

    // CPR artefact: broad compression waveform at ~110/min that swamps the rhythm
    if (artefactAt('cpr', x)) {
        var ang = s * 1.83 * TWO_PI;
        var cprWave = (Math.sin(ang) - 0.4 * Math.sin(2 * ang)) * mv(1.2);
        var noise = (hash(Math.floor(x * 2)) - 0.5) * mv(0.15);
        y = (y * 0.15) + cprWave + noise;
    }
    // Movement: slow baseline wander
    if (artefactAt('movement', x)) {
        y += Math.sin(TWO_PI * 0.25 * s) * (window.PX_PER_MM * 3) + Math.sin(TWO_PI * 0.9 * s + 1) * (window.PX_PER_MM * 1.5);
    }
    // Lead-off / poor contact: erratic high-frequency noise with baseline jumps
    if (artefactAt('leadoff', x)) {
        y += (hash(Math.floor(x / 1.5)) - 0.5) * (window.PX_PER_MM * 8);
        y += (hash(Math.floor(x / 40) + 0.5) - 0.5) * (window.PX_PER_MM * 6);
    }
    return y;
}

// Stand-alone rhythm samplers (rhythm + artefacts + SIZE), used by the tests
function withArtefacts(rhythm){
    return function(x, hr, tSeconds, canvasInfo){
        var baseline = (canvasInfo.height || 300) / 2;
        var gain = (window.state && window.state.ecgGain) || 1;
        return baseline + applyArtefacts(rhythm.y(x, hr), x) * gain;
    };
}

var wrapped = {};
Object.keys(rhythms).forEach(function(k){ wrapped[k] = withArtefacts(rhythms[k]); });

window.rhythms = wrapped;
window.__setECGSpeed = setSpeed;

// R-wave positions between x0 and x1 for a single rhythm
window.rhythmPeaks = function(key, x0, x1, hr) {
    var r = rhythms[key];
    return r ? r.peaks(Math.max(0, x0), x1, hr) : [];
};

// --- TRACE TIMELINE ---
// The monitor keeps a history of what was being shown at each point of the
// trace, so a rhythm/lead/pacing change only affects the trace from the write
// position onwards (as on a real monitor), and demand pacing can be simulated
// beat by beat.
//
// Timeline entry: { x, rhythm, hr, lead, gain, pacing, pacerRate, demand, captured }
var timeline = [];
var spikes = [];              // Pacer spike positions (trace x)
var pacer = { cursor: 0, lastEvent: 0, wasPacing: false };

var ENTRY_KEYS = ['rhythm', 'hr', 'lead', 'gain', 'pacing', 'pacerRate', 'demand', 'captured'];

function segmentIndexAt(x) {
    var lo = 0, hi = timeline.length - 1;
    while (lo < hi) {
        var mid = (lo + hi + 1) >> 1;
        if (timeline[mid].x <= x) lo = mid; else hi = mid - 1;
    }
    return lo;
}

function segmentEnd(i) {
    return i + 1 < timeline.length ? timeline[i + 1].x : Infinity;
}

function lastSpikeIndexAtOrBefore(x) {
    var lo = 0, hi = spikes.length - 1, found = -1;
    while (lo <= hi) {
        var mid = (lo + hi) >> 1;
        if (spikes[mid] <= x) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return found;
}

// Start of the unbroken run of captured segments containing segment i, so a
// rate/lead/size change during capture doesn't interrupt the paced complexes
function captureRunStart(i) {
    while (i > 0 && timeline[i - 1].captured) i--;
    return timeline[i].x;
}

// Is the ventricle being paced at x? (captured segment with a spike already fired)
function capturedSpikeAt(segIndex, x) {
    if (!timeline[segIndex].captured) return -1;
    var i = lastSpikeIndexAtOrBefore(x);
    return (i >= 0 && spikes[i] >= captureRunStart(segIndex)) ? i : -1;
}

// Intrinsic (non-paced) R-waves of a segment
function intrinsicPeaks(seg, x0, x1) {
    var r = rhythms[seg.rhythm];
    return r ? r.peaks(Math.max(0, x0), x1, seg.hr) : [];
}

// Generate pacer spikes up to trace position toX. In demand mode an intrinsic
// beat resets the escape interval, so the pacer is inhibited when the
// patient's own rate is above the set rate.
function advancePacer(toX) {
    var guard = 0;
    while (pacer.cursor < toX && guard++ < 10000) {
        var i = segmentIndexAt(pacer.cursor);
        var seg = timeline[i];
        var end = Math.min(segmentEnd(i), toX);

        if (!seg.pacing) {
            pacer.wasPacing = false;
            pacer.cursor = end;
            continue;
        }
        var cycle = (60 / seg.pacerRate) * window.ecgSpeed;
        if (!pacer.wasPacing) {
            // First pulse ~100ms after pacing starts
            pacer.lastEvent = pacer.cursor - cycle + 0.1 * window.ecgSpeed;
            pacer.wasPacing = true;
        }
        // Never schedule a pulse behind the cursor (e.g. after the rate is increased)
        var candidate = Math.max(pacer.lastEvent + cycle, pacer.cursor);

        if (seg.demand && !seg.captured) {
            var sensed = intrinsicPeaks(seg, pacer.cursor + 0.001, Math.min(candidate, end));
            if (sensed.length) {
                pacer.lastEvent = sensed[0];
                pacer.cursor = sensed[0];
                continue;
            }
        }
        if (candidate > end) {
            pacer.cursor = end;
            continue;
        }
        spikes.push(candidate);
        pacer.lastEvent = candidate;
        pacer.cursor = candidate;
    }
}

// Transcutaneous pacer pulses between x0 and x1: those already fired plus,
// beyond the write position, the predicted next pulses (used to time sync shocks)
function pacerSpikes(x0, x1) {
    var out = [];
    spikes.forEach(function(p) { if (p >= x0 && p <= x1) out.push(p); });
    var last = timeline[timeline.length - 1];
    if (last && last.pacing && pacer.wasPacing) {
        var cycle = (60 / last.pacerRate) * window.ecgSpeed;
        for (var p = pacer.lastEvent + cycle; p <= x1; p += cycle) {
            if (p > pacer.cursor && p >= x0) out.push(p);
        }
    }
    return out;
}

window.ecgTrace = {
    // Start a new trace (device switched on)
    reset: function(entry) {
        timeline = [Object.assign({ x: 0 }, entry)];
        spikes = [];
        pacer = { cursor: 0, lastEvent: 0, wasPacing: false };
    },

    // Record what the monitor shows from trace position x onwards
    set: function(x, entry) {
        if (!timeline.length) { this.reset(entry); return; }
        var last = timeline[timeline.length - 1];
        var changed = ENTRY_KEYS.some(function(k) { return last[k] !== entry[k]; });
        if (!changed) return;
        x = Math.max(x, last.x);
        if (x === last.x) timeline[timeline.length - 1] = Object.assign({ x: x }, entry);
        else timeline.push(Object.assign({ x: x }, entry));
    },

    // Advance the simulation (pacer) to trace position x and drop old history
    advance: function(x, visibleFromX) {
        if (!timeline.length) return;
        advancePacer(x);
        while (timeline.length > 1 && timeline[1].x <= visibleFromX) timeline.shift();
        while (spikes.length && spikes[0] < visibleFromX - 5 * window.ecgSpeed) spikes.shift();
    },

    // Screen y for trace position x
    y: function(x, height) {
        var baseline = (height || 300) / 2;
        if (!timeline.length) return baseline;
        var segIndex = segmentIndexAt(x);
        var seg = timeline[segIndex];
        var y;
        var si = capturedSpikeAt(segIndex, x);
        if (si >= 0) {
            // Paced ventricular complexes follow each spike
            var rr = 60 / seg.pacerRate;
            y = wideBeat((x - spikes[si]) / window.ecgSpeed, rr, PACED_R);
            if (si > 0 && spikes[si - 1] >= captureRunStart(segIndex)) y += wideBeat((x - spikes[si - 1]) / window.ecgSpeed, rr, PACED_R);
        } else {
            var r = rhythms[seg.rhythm];
            y = r ? r.y(x, seg.hr) : 0;
        }
        y *= LEAD_GAIN[seg.lead] || 1;
        return baseline + applyArtefacts(y, x) * (seg.gain || 1);
    },

    // R-waves between x0 and x1 (x1 may be ahead of the write position)
    peaks: function(x0, x1) {
        var out = [];
        if (!timeline.length) return out;
        for (var i = segmentIndexAt(x0); i < timeline.length; i++) {
            var seg = timeline[i];
            var a = Math.max(x0, seg.x), b = Math.min(x1, segmentEnd(i));
            if (a > b) continue;
            if (seg.captured) {
                // Each paced complex peaks PACED_R after its pacer spike
                var off = PACED_R * window.ecgSpeed;
                var runStart = captureRunStart(i);
                pacerSpikes(a - off, b - off).forEach(function(p) { if (p >= runStart) out.push(p + off); });
            } else {
                out = out.concat(intrinsicPeaks(seg, a, b));
            }
        }
        return out;
    },

    // Pacer / pacemaker spikes between x0 and x1 (including predicted pacer pulses)
    spikes: function(x0, x1) {
        var out = pacerSpikes(x0, x1);
        // Permanent pacemaker spikes
        for (var i = segmentIndexAt(x0); i < timeline.length; i++) {
            var seg = timeline[i];
            if (seg.rhythm === 'paced' && !seg.pacing) {
                var a = Math.max(x0, seg.x), b = Math.min(x1, segmentEnd(i));
                if (a <= b) out = out.concat(pacedRhythm.spikes(a, b, seg.hr));
            }
        }
        return out;
    },

    current: function() {
        return timeline.length ? timeline[timeline.length - 1] : null;
    }
};

// --- GRID DRAWER (High Visibility) ---
window.drawECGGrid = function(ctx, w, h) {
    // Force Black Background
    ctx.fillStyle = '#050505';
    ctx.fillRect(0, 0, w, h);

    // Dimmed Small Grid
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0, 255, 50, 0.07)'; // Brightness reduced
    ctx.beginPath();
    for (var x=0; x<=w; x+=window.PX_PER_MM) { ctx.moveTo(x+0.5,0); ctx.lineTo(x+0.5,h); }
    for (var y=0; y<=h; y+=window.PX_PER_MM) { ctx.moveTo(0,y+0.5); ctx.lineTo(w,y+0.5); }
    ctx.stroke();

    // Dimmed Large Grid
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(0, 255, 50, 0.12)'; // Brightness reduced
    ctx.beginPath();
    for (var x=0; x<=w; x+=window.PX_PER_BIG) { ctx.moveTo(x+0.5,0); ctx.lineTo(x+0.5,h); }
    for (var y=0; y<=h; y+=window.PX_PER_BIG) { ctx.moveTo(0,y+0.5); ctx.lineTo(w,y+0.5); }
    ctx.stroke();
};
})();
