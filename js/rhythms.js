// ECG rhythm engine: waveforms, R-wave positions, artefacts and grid
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

function narrowBeat(s, rr, opts) {
    var y = 0;
    if (!opts.hideP) y += gaussian(s, 0.12, 0.032, mv(0.15));   // P
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

function rateOf(hr, fallback) { return hr > 0 ? hr : fallback; }

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
            var cyclePx = rr * window.ecgSpeed;
            var off = rPeak * window.ecgSpeed;
            var out = [];
            for (var n = Math.floor((x0 - off) / cyclePx); ; n++) {
                var p = n * cyclePx + off;
                if (p > x1) break;
                if (p >= x0) out.push(p);
            }
            return out;
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
            var off = VT_PEAK_T * cyclePx;
            var out = [];
            for (var n = Math.floor((x0 - off) / cyclePx); ; n++) {
                var p = n * cyclePx + off;
                if (p > x1) break;
                if (p >= x0) out.push(p);
            }
            return out;
        }
    };
}

// VF: Coarse, chaotic, no identifiable QRS complexes
var vfib = {
    y: function(x) {
        var s = x / window.ecgSpeed;
        var amp = 0.45 + 0.2 * Math.sin(TWO_PI * 0.13 * s) + 0.12 * Math.sin(TWO_PI * 0.31 * s + 1.7);
        var v = Math.sin(TWO_PI * 4.6 * s + 1.4 * Math.sin(TWO_PI * 0.53 * s))
              + 0.55 * Math.sin(TWO_PI * 6.7 * s + 0.9 * Math.sin(TWO_PI * 0.37 * s + 2.1))
              + 0.3 * Math.sin(TWO_PI * 9.3 * s + 0.4);
        return -v * mv(amp) * 0.6;
    },
    peaks: function() { return []; }
};

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
        var sa = s % 0.8;
        return gaussian(sa, 0.12, 0.032, mv(0.15)) + chbVentricle.y(x, hr);
    },
    peaks: chbVentricle.peaks
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
    paced:           periodic(70,  function(s, rr) { return wideBeat(s, rr, PACED_R); }, PACED_R),
    vtach:           ventricularTachy(180),
    vt_pulseless:    ventricularTachy(180),
    vfib:            vfib,
    afib:            afib,
    chb:             chb,
    asystole:        asystole
};

// --- ARTEFACT LOGIC ---
// Each artefact is stored as a list of trace segments [start, end) in trace
// x-coordinates, so an artefact switched on now scrolls in from the right-hand
// edge rather than instantly changing the part of the trace already drawn.
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
        // Drop segments that have scrolled off the left of the screen
        artefactSegments[type] = segs.filter(function(s) { return s.end === null || s.end >= window.waveformX; });
    },
    reset: function(active) {
        Object.keys(artefactSegments).forEach(function(type) {
            artefactSegments[type] = active[type] ? [{ start: 0, end: null }] : [];
        });
    }
};

function withArtefacts(rhythm){
    return function(x, hr, tSeconds, canvasInfo){
        var baseline = (canvasInfo.height || 300) / 2;
        var y = rhythm.y(x, hr);
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

        // SIZE (ECG gain)
        var gain = (window.state && window.state.ecgGain) || 1;
        return baseline + y * gain;
    }
}

var wrapped = {};
Object.keys(rhythms).forEach(function(k){ wrapped[k] = withArtefacts(rhythms[k]); });

window.rhythms = wrapped;
window.__setECGSpeed = setSpeed;

// R-wave positions between x0 and x1 (used for sync markers and synchronised shocks)
window.rhythmPeaks = function(key, x0, x1, hr) {
    var r = rhythms[key];
    return r ? r.peaks(Math.max(0, x0), x1, hr) : [];
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
