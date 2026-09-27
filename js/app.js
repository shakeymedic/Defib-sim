document.addEventListener('DOMContentLoaded', () => {

    const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
    const { scenarios, rhythmNames, guidelineData, rhythmVitals } = window.SIM_DATA;

    // --- FIX: VISIBILITY FOR DROPDOWN ---
    const toggleBtn = document.getElementById('toggleSecondaryBtn');
    const secondaryMenu = document.getElementById('secondaryRhythms');

    if(toggleBtn && secondaryMenu) {
        toggleBtn.addEventListener('click', function() {
            secondaryMenu.classList.toggle('open');
            this.textContent = secondaryMenu.classList.contains('open')
                ? "▲ Hide Rhythms"
                : "▼ Show More Rhythms";
        });
    }
    // ------------------------------------

    const APP_STATES = {
        IDLE: 'IDLE',                 // Off or Monitor Mode
        ANALYSING: 'ANALYSING',       // Hands off
        CHARGING: 'CHARGING',         // Building energy
        READY: 'READY',               // Shock button active
        DISCHARGING: 'DISCHARGING',   // Shock pressed (waiting for R-wave if synced)
        PACING: 'PACING'              // Pacer active
    };

    const ENERGY_LEVELS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20, 30, 50, 75, 100, 120, 150, 200]; // ZOLL R Series adult selections
    const ARREST_MIN_ENERGY = 150;     // RCUK 2025: first biphasic shock at least 150J
    const CARDIOVERSION_MIN_ENERGY = 70;
    const PACING_CAPABLE = ['chb', 'brady', 'sinus_brady', 'idioventricular', 'mobitz2'];
    const SHOCKABLE_ARREST = ['vfib', 'vfib_fine', 'vt_pulseless'];
    const CARDIOVERTIBLE = ['svt', 'afib', 'flutter', 'vtach'];
    const FREE_PLAY_CAPTURE_THRESHOLD = 60;   // mA
    const MECHANICAL_CAPTURE_MARGIN = 10;     // mA above electrical threshold for a palpable pulse

    const state = {
        machineState: APP_STATES.IDLE,
        sessionType: 'free',          // 'free' | 'scenario' | 'custom'
        selectedMode: null,
        selectedScenario: null,
        scenarioActive: false,
        scenarioStartTime: null,
        deviceMode: 'off',
        rhythm: 'nsr',
        hr: 75,
        spo2: 98,
        etco2: 5.1,
        bpSys: 120,
        bpDia: 80,
        energy: 120,
        energyLevels: ENERGY_LEVELS,
        charged: false,
        syncMode: false,
        shockCount: 0,
        episodeShocks: 0,             // Adequate shocks since the current rhythm started
        shockResponse: 'auto',
        pacerOutput: 0,
        pacerRate: 60,
        pacingActive: false,
        isCaptured: false,
        originalRhythm: null,
        actions: [],
        hasPulse: true,
        roscAchieved: false,
        converted: false,
        cprActive: false,
        arrestStartTime: null,
        amiodaroneDoses: 0,
        adrenalineTimes: [],
        amiodaroneTimes: [],
        arrestShocks: 0,             // Shocks delivered during the current arrest
        ecgGain: 1,
        lead: 'II',
        pacerDemand: true,
        mechanicalCapture: false,
        baseHr: 0,
        preCapture: null,
        rOnT: 'always',
        refib: 'off',
        refibDone: false,
        flashUntil: 0,
        noise: {
            movement: false,
            cpr: false,
            leadoff: false
        },
        customScenario: [],
        customScenarioActive: false,
        currentScenarioStep: 0,
        chargeTimer: null,
        dumpTimer: null,
        analyseTimer: null,
        stepTimer: null,
        chargeSound: null
    };
    window.state = state;

    // --- TIMERS ---
    let cycleTime = 120; // 2 minutes in seconds
    let cycleInterval = null;
    let metronomeTimer = null;
    let arrestTimerInterval = null;
    let countdownInterval = null;
    let etco2SettleInterval = null;

    // setTimeout wrapper so every pending scenario/device callback can be
    // cancelled on reset (prevents stale callbacks acting on a new scenario)
    const pendingTimeouts = new Set();
    function later(fn, ms) {
        const id = setTimeout(() => {
            pendingTimeouts.delete(id);
            fn();
        }, ms);
        pendingTimeouts.add(id);
        return id;
    }
    function cancelLater(id) {
        if (!id) return;
        clearTimeout(id);
        pendingTimeouts.delete(id);
    }

    // --- HELPER: Global Timer Cleanup ---
    // Note: does not stop the ECG animation - that is controlled by setMode()
    function clearAllTimers() {
        pendingTimeouts.forEach(id => clearTimeout(id));
        pendingTimeouts.clear();

        if (cycleInterval) clearInterval(cycleInterval);
        if (arrestTimerInterval) clearInterval(arrestTimerInterval);
        if (countdownInterval) clearInterval(countdownInterval);
        if (etco2SettleInterval) clearInterval(etco2SettleInterval);
        cycleInterval = null;
        arrestTimerInterval = null;
        countdownInterval = null;
        etco2SettleInterval = null;
        stopMetronome();

        state.chargeTimer = null;
        state.dumpTimer = null;
        state.analyseTimer = null;
        state.stepTimer = null;
        stopChargeSound();
        if (state.machineState !== APP_STATES.IDLE) transitionTo(APP_STATES.IDLE);
    }

    // --- STATE MACHINE LOGIC ---
    function transitionTo(newState) {
        console.log(`State Transition: ${state.machineState} -> ${newState}`);

        // Exit Logic (Clean up old state)
        if (state.machineState === APP_STATES.READY) {
            document.getElementById('shockBtn').disabled = true;
            state.charged = false;
        }

        state.machineState = newState;

        // Entry Logic (Setup new state)
        if (newState === APP_STATES.READY) {
            document.getElementById('shockBtn').disabled = false;
            playSound('charged');
            setMessage(`${state.energy}J READY - ${state.syncMode ? 'SYNC' : 'UNSYNC'}`, 'alert');
        }

        // Callers set their own message after returning to IDLE, so results
        // such as the analysis are not overwritten
        if (newState === APP_STATES.IDLE) {
            state.charged = false;
            document.getElementById('shockBtn').disabled = true;
        }
    }

    // Cancel any charge in progress or held (energy/mode change, reset)
    function disarm(reason) {
        const armed = [APP_STATES.CHARGING, APP_STATES.READY, APP_STATES.DISCHARGING].includes(state.machineState);
        if (!armed) return;
        cancelLater(state.chargeTimer);
        cancelLater(state.dumpTimer);
        state.chargeTimer = null;
        state.dumpTimer = null;
        stopChargeSound();
        transitionTo(APP_STATES.IDLE);
        logAction('Charge cancelled', reason || '');
        if (reason) setMessage(`CHARGE CANCELLED - ${reason}`, 'ready');
    }

    function cancelAnalysis() {
        if (state.machineState !== APP_STATES.ANALYSING) return;
        cancelLater(state.analyseTimer);
        state.analyseTimer = null;
        transitionTo(APP_STATES.IDLE);
    }

    let canvas, ctx, animationId;
    let lastTimestamp = 0;
    let logicalWidth = 0;

    const menuWrapper = document.getElementById('menuWrapper');
    const modeSelectScreen = document.getElementById('modeSelectScreen');
    const scenarioScreen = document.getElementById('scenarioScreen');
    const summaryScreen = document.getElementById('summaryScreen');
    const certificateScreen = document.getElementById('certificateScreen');
    const scenarioCreatorScreen = document.getElementById('scenarioCreatorScreen');
    const menuScreens = [modeSelectScreen, scenarioScreen, summaryScreen, certificateScreen, scenarioCreatorScreen];
    const simulatorContainer = document.getElementById('simulatorContainer');
    const quickRhythmPanel = document.querySelector('.quick-rhythm-panel');
    const hintsPanel = document.querySelector('.guideline-hints-panel');
    const instructorPanel = document.getElementById('instructorPanel');
    const endScenarioBtn = document.getElementById('endScenarioBtn');
    const resetScenarioBtn = document.getElementById('resetScenarioBtn');
    const cprPanel = document.getElementById('cprPanel');
    const cprMinBtn = document.getElementById('cprMinimiseBtn');

    const modalOverlay = document.getElementById('modalOverlay');
    const modalTitle = document.getElementById('modalTitle');
    const modalBody = document.getElementById('modalBody');
    const closeModalBtn = document.getElementById('closeModalBtn');
    const hintButtons = document.querySelectorAll('.hint-btn');

    function resizeCanvas() {
        if (!canvas || !ctx) return;

        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        // Hidden (e.g. a menu is open) - keep the last good size
        if (rect.width === 0 || rect.height === 0) return;

        const newWidth = Math.round(rect.width * dpr);
        const newHeight = Math.round(rect.height * dpr);

        if (canvas.width !== newWidth || canvas.height !== newHeight) {
            canvas.width = newWidth;
            canvas.height = newHeight;
            ctx.scale(dpr, dpr);

            ctx.lineJoin = 'round';
            ctx.lineCap = 'round';
            ctx.imageSmoothingEnabled = false;
        }
        logicalWidth = canvas.width / dpr;
        canvas.style.width = '100%';
        canvas.style.height = '100%';
    }

    function initCanvas() {
        canvas = document.getElementById('ecgCanvas');
        if (!canvas) {
            console.error('Canvas element not found!');
            return;
        }
        ctx = canvas.getContext('2d');
        resizeCanvas();
        if (animationId) {
            cancelAnimationFrame(animationId);
            animationId = null;
        }
        lastTimestamp = 0;
        window.waveformX = 0; // Use global
    }

    // Trace position currently being written by the sweep
    function traceNowX() {
        return window.waveformX + logicalWidth;
    }

    // What the monitor is showing now, recorded into the trace history so any
    // change sweeps in from the write position
    function traceEntry() {
        return {
            rhythm: state.isCaptured ? (state.originalRhythm || 'nsr') : state.rhythm,
            hr: state.isCaptured ? state.baseHr : state.hr,
            lead: state.lead,
            gain: state.ecgGain,
            pacing: state.pacingActive,
            pacerRate: state.pacerRate,
            demand: state.pacerDemand,
            captured: state.isCaptured
        };
    }

    function markTrace() {
        if (window.ecgTrace) window.ecgTrace.set(traceNowX(), traceEntry());
    }

    function desiredArtefacts() {
        return {
            cpr: state.cprActive || state.noise.cpr,
            movement: state.noise.movement,
            leadoff: state.noise.leadoff
        };
    }

    function syncArtefacts() {
        if (!window.ecgArtefacts) return;
        const now = traceNowX();
        const active = desiredArtefacts();
        Object.keys(active).forEach(type => window.ecgArtefacts.set(type, active[type], now));
    }

    function resetTrace() {
        lastTimestamp = 0;
        window.waveformX = 0;
        if (window.ecgArtefacts) window.ecgArtefacts.reset(desiredArtefacts());
        if (window.ecgTrace) window.ecgTrace.reset(traceEntry());
    }

    function setVitals(rhythm) {
        const vitals = rhythmVitals[rhythm] || rhythmVitals['nsr'];
        if (etco2SettleInterval) {
            clearInterval(etco2SettleInterval);
            etco2SettleInterval = null;
        }
        state.rhythm = rhythmVitals[rhythm] ? rhythm : 'nsr';
        state.hr = vitals.hr;
        state.spo2 = vitals.spo2;
        state.etco2 = vitals.etco2;
        state.bpSys = vitals.bpSys;
        state.bpDia = vitals.bpDia;
        state.hasPulse = vitals.hasPulse;
    }

    function applyVitals(vitals) {
        if (!vitals) return;
        ['hr', 'spo2', 'etco2', 'bpSys', 'bpDia'].forEach(k => {
            if (typeof vitals[k] === 'number') state[k] = vitals[k];
        });
    }

    const SWEEP_GAP = 20; // Erase bar ahead of the sweep (px)

    // Sweep-and-erase display: the trace is written left to right and wraps,
    // overwriting the oldest trace just behind a short erase gap.
    // Trace position gx is drawn at screen x = gx mod screen width.
    function animate(timestamp) {
        if (!canvas || !ctx) { animationId = requestAnimationFrame(animate); return; }

        if (lastTimestamp === 0) lastTimestamp = timestamp;
        const deltaTime = Math.min((timestamp - lastTimestamp) / 1000, 0.5);
        lastTimestamp = timestamp;

        const dpr = window.devicePixelRatio || 1;
        const logicalW = canvas.width / dpr;
        const logicalH = canvas.height / dpr;
        logicalWidth = logicalW;

        // 1. Move the sweep and advance the simulation (pacer) to it
        window.waveformX += (window.ecgSpeed || 125) * deltaTime;
        const nowX = traceNowX();
        const fromX = Math.max(0, nowX - logicalW + SWEEP_GAP);
        markTrace();
        window.ecgTrace.advance(nowX, nowX - logicalW);

        // 2. Draw Grid
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.shadowBlur = 0;
        window.drawECGGrid(ctx, logicalW, logicalH);

        const toScreen = gx => gx - Math.floor(gx / logicalW) * logicalW;
        const baselineY = logicalH / 2;

        // 3. Draw Trace
        const step = 0.5;
        ctx.strokeStyle = '#39ff14';
        ctx.lineWidth = 2.5;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.shadowBlur = 10;
        ctx.shadowColor = 'rgba(57, 255, 20, 0.8)';
        ctx.beginPath();
        let prevSx = Infinity;
        for (let gx = Math.ceil(fromX / step) * step; gx <= nowX; gx += step) {
            const sx = toScreen(gx);
            let yVal = window.ecgTrace.y(gx, logicalH);
            if (!isFinite(yVal)) yVal = baselineY;
            if (sx < prevSx) ctx.moveTo(sx, yVal); // Start, or wrapped to the left edge
            else ctx.lineTo(sx, yVal);
            prevSx = sx;
        }
        ctx.stroke();
        ctx.shadowBlur = 0;

        // 4. Pacer / pacemaker spikes (pink)
        const spikes = window.ecgTrace.spikes(fromX, nowX);
        if (spikes.length) {
            ctx.save();
            ctx.strokeStyle = '#ff00ff';
            ctx.lineWidth = 2;
            ctx.beginPath();
            spikes.forEach(p => {
                const sx = toScreen(p);
                ctx.moveTo(sx, baselineY - 60);
                ctx.lineTo(sx, baselineY + 60);
            });
            ctx.stroke();
            ctx.restore();
        }

        // 5. Sync Markers (White Bar at Top of Screen) on every detected R-wave
        if (state.syncMode) {
            ctx.save();
            ctx.fillStyle = '#ffffff'; // Pure White
            ctx.shadowBlur = 5;
            ctx.shadowColor = 'white';
            window.ecgTrace.peaks(fromX, nowX).forEach(p => ctx.fillRect(toScreen(p) - 3, 30, 6, 20));
            ctx.restore();
        }

        // 6. Shock flash
        if (performance.now() < state.flashUntil) {
            ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
            ctx.fillRect(0, 0, logicalW, logicalH);
        }

        animationId = requestAnimationFrame(animate);
    }

    function updateDisplays() {
        if (state.deviceMode === 'off') return;

        let displayHR;
        if (state.isCaptured) {
            displayHR = state.pacerRate;
        } else if (!state.hasPulse) {
            displayHR = 0;
        } else {
            displayHR = state.hr;
        }

        document.getElementById('hrDisplay').textContent = displayHR;
        document.getElementById('spo2Display').textContent = state.spo2;

        // --- ETCO2 LOGIC UPDATE ---
        let displayEtco2 = state.etco2;
        // If CPR is active and no ROSC, simulate perfusion boost (2.8 - 3.0 range)
        if (state.cprActive && !state.roscAchieved && displayEtco2 < 2.5) {
            displayEtco2 = 2.8 + (Math.random() * 0.2);
        }
        document.getElementById('etco2Display').textContent = displayEtco2.toFixed(1);
        // --------------------------

        document.getElementById('bpDisplay').textContent = `${state.bpSys}/${state.bpDia}`;
        document.getElementById('energyDisplay').textContent = state.energy;
        document.getElementById('outputDisplay').textContent = state.pacerOutput;
        document.getElementById('rateDisplay').textContent = state.pacerRate;
        document.getElementById('modeInfo').textContent = `MODE: ${state.deviceMode.toUpperCase()}`;
        document.getElementById('leadInfo').textContent = `LEAD: ${state.lead}  x${state.ecgGain}`;

        document.getElementById('syncIndicator').textContent = state.syncMode ? 'SYNC' : '';
        document.getElementById('syncIndicator').className = state.syncMode ? 'screen-info sync-indicator' : 'screen-info';

        const hrEl = document.getElementById('hrDisplay');
        hrEl.className = 'vital-value';
        if (displayHR === 0) {
            hrEl.classList.add('critical');
        }

        const spo2El = document.getElementById('spo2Display');
        spo2El.className = 'vital-value';
        if (state.spo2 === 0) {
            spo2El.classList.add('critical');
        }

        document.getElementById('shockCounter').textContent = state.shockCount;
        document.getElementById('syncStatus').textContent = state.syncMode ? 'ON' : 'OFF';
        document.getElementById('pacingStatus').textContent = state.pacingActive ? (state.isCaptured ? 'CAPTURED' : 'ACTIVE') : 'OFF';
    }

    function setMessage(text, type = 'ready') {
        if (state.deviceMode === 'off') return;
        const msgEl = document.getElementById('messageBar');
        if (!msgEl) return;
        msgEl.textContent = text;
        msgEl.className = 'message-bar ' + type;
    }

    function logAction(action, details = '') {
        const timestamp = state.scenarioStartTime ?
            Math.floor((Date.now() - state.scenarioStartTime) / 1000) : 0;
        state.actions.push({
            time: timestamp,
            action: action,
            details: details
        });
        console.log(`[${timestamp}s] ${action}${details ? ': ' + details : ''}`);

        // Update Visual Log in CPR Panel (newest entry sits at the bottom)
        const cprLog = document.getElementById('cprLog');
        if (cprLog) {
            const placeholder = cprLog.querySelector('.log-placeholder');
            if (placeholder) placeholder.remove();
            const timeStr = document.getElementById('cprTimerDisplay').textContent || "00:00";
            const entry = document.createElement('div');
            entry.className = 'log-entry';
            const timeEl = document.createElement('span');
            timeEl.className = 'log-time';
            timeEl.textContent = `[${timeStr}]`;
            const detailEl = document.createElement('span');
            detailEl.className = 'log-detail';
            detailEl.textContent = details;
            entry.append(timeEl, ` ${action} `, detailEl);
            cprLog.prepend(entry);
        }
    }

    // --- SCREEN NAVIGATION ---
    function showMenuScreen(screen) {
        menuScreens.forEach(s => s.classList.toggle('hidden', s !== screen));
        menuWrapper.classList.remove('hidden');
        simulatorContainer.classList.add('hidden');
        quickRhythmPanel.classList.add('hidden');
        hintsPanel.classList.add('hidden');
        window.scrollTo(0, 0);
    }

    function showSimulator() {
        menuScreens.forEach(s => s.classList.add('hidden'));
        menuWrapper.classList.add('hidden');
        simulatorContainer.classList.remove('hidden');
        quickRhythmPanel.classList.remove('hidden');
        hintsPanel.classList.remove('hidden');
        requestAnimationFrame(resizeCanvas);
    }

    function showInstructorPanel(subtitle) {
        const btn = document.getElementById('minimiseBtn');
        instructorPanel.classList.remove('hidden');
        instructorPanel.classList.add('minimised');
        if (btn) btn.textContent = '▼ Show';
        document.getElementById('instructorSubtitle').textContent = subtitle;
    }

    function setFreePlayUI() {
        state.sessionType = 'free';
        endScenarioBtn.classList.add('hidden');
        resetScenarioBtn.classList.add('hidden');
        showInstructorPanel('Free Play');
    }

    function sessionInProgress() {
        return state.scenarioActive || state.customScenarioActive || countdownInterval !== null;
    }

    // Returns false if the user chose to stay in the current scenario
    function leaveSession() {
        if (!sessionInProgress()) return true;
        if (!window.confirm('End the current scenario?')) return false;
        resetSessionState();
        setFreePlayUI();
        setMode('off');
        return true;
    }

    // Reset everything belonging to the current scenario / free-play session
    function resetSessionState() {
        clearAllTimers();
        endArrest();

        state.scenarioActive = false;
        state.scenarioStartTime = null;
        state.selectedScenario = null;
        state.customScenarioActive = false;
        state.currentScenarioStep = 0;

        state.syncMode = false;
        document.getElementById('syncBtn').classList.remove('active');
        state.pacingActive = false;
        state.isCaptured = false;
        state.mechanicalCapture = false;
        state.preCapture = null;
        state.originalRhythm = null;
        state.pacerOutput = 0;
        state.pacerRate = 60;
        state.pacerDemand = true;
        updatePacerModeButton();
        state.refibDone = false;
        setPacerDial('output', 0);
        setPacerDial('rate', 60);

        state.charged = false;
        state.shockCount = 0;
        state.episodeShocks = 0;
        state.roscAchieved = false;
        state.converted = false;
        state.amiodaroneDoses = 0;
        state.adrenalineTimes = [];
        state.amiodaroneTimes = [];
        state.arrestShocks = 0;
        updateAmiodaroneButton();
        updateDrugPanel();
        state.actions = [];

        // Clear the CPR panel for the new session
        document.getElementById('cprTimerDisplay').textContent = '00:00';
        document.getElementById('cycleTimerDisplay').textContent = '02:00';
        document.getElementById('cprLog').innerHTML = '<div class="log-placeholder">Waiting for start...</div>';
        document.querySelectorAll('.cause-btn.checked').forEach(b => b.classList.remove('checked'));
    }

    function selectScenario(scenarioId) {
        const scenario = scenarios[scenarioId];
        if (!scenario) return;

        const mode = state.selectedMode;
        resetSessionState();
        state.sessionType = 'scenario';
        state.selectedMode = mode;
        state.selectedScenario = scenarioId;

        // --- NEW: RANDOMISE CAPTURE THRESHOLD ---
        // Adds variance (+/- 15mA) to the scenario default so students must "hunt"
        if (scenario.captureThreshold) {
            const variance = Math.floor(Math.random() * 30) - 15;
            scenario.currentThreshold = Math.max(30, scenario.captureThreshold + variance);
            console.log("Sim Capture Threshold set to:", scenario.currentThreshold); // For debugging
        }
        // ----------------------------------------

        showSimulator();
        endScenarioBtn.classList.remove('hidden');
        resetScenarioBtn.classList.remove('hidden');

        if (state.selectedMode === 'education') {
            showInstructorPanel(scenario.name);
        } else {
            instructorPanel.classList.add('hidden');
        }

        applyRhythm(scenario.initialRhythm, { vitals: scenario.initialVitals, keepMode: true, noArrestCheck: true });
        setMode('monitor');

        let countdown = 3;
        setMessage(`SCENARIO STARTING IN ${countdown}...`, 'ready');

        countdownInterval = setInterval(() => {
            countdown--;
            if (countdown > 0) {
                setMessage(`SCENARIO STARTING IN ${countdown}...`, 'ready');
            } else {
                clearInterval(countdownInterval);
                countdownInterval = null;
                state.scenarioStartTime = Date.now();
                state.scenarioActive = true;

                const msg = scenario.description.toUpperCase();
                setMessage(msg, scenario.hasPulse ? 'ready' : 'alert');
                logAction('Scenario started', scenario.name);
                updateArrestPanel();
            }
        }, 1000);
    }

    function endScenario() {
        if (state.sessionType === 'custom') {
            if (state.customScenarioActive && !window.confirm('End the custom scenario?')) return;
            returnToMenu();
            return;
        }
        if (!state.scenarioActive) {
            returnToMenu();
            return;
        }

        if (!window.confirm('End the current scenario?')) {
             return;
        }

        state.scenarioActive = false;
        logAction('Scenario ended');
        clearAllTimers();

        if (animationId) {
            cancelAnimationFrame(animationId);
            animationId = null;
        }

        showSummary();
    }

    function resetScenario() {
        if (state.sessionType === 'custom') {
            if (!window.confirm('Reset this custom scenario?')) return;
            startCustomScenario();
        } else if (state.sessionType === 'scenario' && state.selectedScenario) {
            if (!window.confirm('Reset this scenario?')) return;
            selectScenario(state.selectedScenario);
        }
    }

    function showSummary() {
        const scenario = scenarios[state.selectedScenario];
        if (!scenario) {
            returnToMenu();
            return;
        }

        showMenuScreen(summaryScreen);

        document.getElementById('summaryScenarioName').textContent = scenario.name;
        document.getElementById('summaryScenarioDesc').textContent = scenario.description;

        let actionsHTML = '';
        if (state.actions.length > 0) {
            actionsHTML = '<div style="display: grid; gap: 8px;">';
            state.actions.forEach(action => {
                const timestamp = action.time ? `${Math.floor(action.time / 60)}:${String(action.time % 60).padStart(2, '0')}` : '0:00';
                actionsHTML += `<div style="padding: 10px; background: #34495e; border-radius: 5px;">
                    <strong style="color: #3498db;">${timestamp}</strong> - ${action.action}${action.details ? ': ' + action.details : ''}
                </div>`;
            });
            actionsHTML += '</div>';
        } else {
            actionsHTML = '<div style="color: #e74c3c;">No actions recorded</div>';
        }
        document.getElementById('summaryActions').innerHTML = actionsHTML;

        const feedback = generateFeedback(scenario);
        document.getElementById('summaryFeedback').innerHTML = feedback;

        const outcome = generateOutcome(scenario);
        document.getElementById('summaryOutcome').innerHTML = outcome;
    }

    function generateFeedback(scenario) {
        let html = '';
        const goodPoints = [];
        const improvementPoints = [];

        const modeChanges = state.actions.filter(a => a.action === 'Mode changed');
        const shocks = state.actions.filter(a => a.action.includes('delivered'));
        const syncActivated = state.actions.find(a => a.action === 'Sync mode activated');
        const pacingActions = state.actions.filter(a => a.action.includes('Pacing'));
        const pulseChecks = state.actions.filter(a => a.action === 'Pulse check performed');

        if (pulseChecks.length > 0) {
            goodPoints.push(`✓ Pulse checked ${pulseChecks.length} time(s)`);

            if (pulseChecks[0].time <= 30) {
                goodPoints.push('✓ Early pulse assessment performed');
            }
        } else {
            improvementPoints.push('⚠ No pulse check documented - critical for choosing correct intervention');
        }

        if (scenario.category === 'defibrillation') {
            const defibMode = modeChanges.find(m => m.details === 'DEFIB');
            if (defibMode) {
                goodPoints.push('✓ Defibrillator mode selected correctly');
            } else {
                improvementPoints.push('✗ Should switch to DEFIB mode for cardiac arrest');
            }

            if (syncActivated) {
                improvementPoints.push('✗ Sync mode should NOT be used for cardiac arrest (no pulse)');
            } else if (shocks.length > 0) {
                goodPoints.push('✓ Correctly used unsynchronised shocks (no sync)');
            }

            if (shocks.length > 0) {
                goodPoints.push(`✓ ${shocks.length} shock(s) delivered`);

                const firstShock = shocks[0];
                const energyUsed = parseInt(firstShock.details.match(/(\d+)J/)?.[1] || '0');
                if (energyUsed >= scenario.recommendedEnergy) {
                    goodPoints.push('✓ Appropriate energy level selected');
                } else {
                    improvementPoints.push(`⚠ Recommended energy: ${scenario.recommendedEnergy}J or higher`);
                }

                const timeToShock = firstShock.time;
                if (timeToShock <= 60) {
                    goodPoints.push(`✓ Rapid defibrillation (${timeToShock}s) - excellent`);
                } else if (timeToShock <= 180) {
                    goodPoints.push(`✓ Timely defibrillation (${timeToShock}s)`);
                } else {
                    improvementPoints.push(`⚠ Delay to first shock: ${timeToShock}s (aim for <60s in witnessed arrest)`);
                }
            } else {
                improvementPoints.push('✗ No shocks delivered - shockable rhythm requires defibrillation');
            }

        } else if (scenario.category === 'cardioversion') {
            if (syncActivated) {
                goodPoints.push('✓ Sync mode activated correctly');
            } else {
                improvementPoints.push('✗ CRITICAL: Must use SYNC mode for cardioversion (patient has pulse)');
            }

            const defibMode = modeChanges.find(m => m.details === 'DEFIB');
            if (defibMode) {
                goodPoints.push('✓ Defibrillator mode selected');
            }

            if (shocks.length > 0) {
                goodPoints.push('✓ Cardioversion attempted');

                const firstShock = shocks[0];
                const energyUsed = parseInt(firstShock.details.match(/(\d+)J/)?.[1] || '0');
                if (Math.abs(energyUsed - scenario.recommendedEnergy) <= 30) {
                    goodPoints.push(`✓ Appropriate energy used (${energyUsed}J)`);
                } else {
                    improvementPoints.push(`⚠ Recommended energy: ${scenario.recommendedEnergy}J for this rhythm`);
                }

                const timeToShock = firstShock.time;
                if (timeToShock <= 60) {
                    goodPoints.push(`✓ Rapid cardioversion (${timeToShock}s)`);
                } else {
                    improvementPoints.push(`⚠ Time to cardioversion: ${timeToShock}s (aim for <60s when unstable)`);
                }
            } else {
                improvementPoints.push('✗ No cardioversion attempted - patient has adverse features');
            }

        } else if (scenario.category === 'pacing') {
            const pacerMode = modeChanges.find(m => m.details === 'PACER');
            if (pacerMode) {
                goodPoints.push('✓ Pacing mode selected');
            } else {
                improvementPoints.push('✗ Should switch to PACER mode');
            }

            const outputAdjusted = pacingActions.find(a => a.action.includes('output'));
            if (outputAdjusted) {
                goodPoints.push('✓ Pacing output adjusted');

                const captureAchieved = pacingActions.find(a => a.action === 'Pacing capture achieved');
                const electricalOnly = state.actions.find(a => a.action === 'Electrical capture');
                if (captureAchieved) {
                    goodPoints.push('✓ Electrical and mechanical capture achieved');
                } else if (electricalOnly) {
                    improvementPoints.push('⚠ Electrical capture only - no palpable pulse at the paced rate. Increase output until mechanical capture');
                } else {
                    improvementPoints.push('⚠ Increase output until capture achieved (check for palpable pulse)');
                }
            }

            const rateAdjusted = pacingActions.find(a => a.action.includes('rate'));
            if (rateAdjusted) {
                goodPoints.push('✓ Pacing rate set appropriately');
            }
        }

        if (goodPoints.length > 0) {
            html += '<div style="background: rgba(39, 174, 96, 0.1); border-left: 4px solid #27ae60; padding: 15px; margin: 10px 0; border-radius: 5px;">';
            html += '<strong style="color: #27ae60;">Good Practice:</strong><ul style="margin: 10px 0; padding-left: 20px; color: #ecf0f1;">';
            goodPoints.forEach(p => html += `<li style="margin: 5px 0;">${p}</li>`);
            html += '</ul></div>';
        }

        if (improvementPoints.length > 0) {
            html += '<div style="background: rgba(231, 76, 60, 0.1); border-left: 4px solid #e74c3c; padding: 15px; margin: 10px 0; border-radius: 5px;">';
            html += '<strong style="color: #e74c3c;">Areas for Improvement:</strong><ul style="margin: 10px 0; padding-left: 20px; color: #ecf0f1;">';
            improvementPoints.forEach(i => html += `<li style="margin: 5px 0;">${i}</li>`);
            html += '</ul></div>';
        }

        if (html === '') {
            html = '<div style="color: #f39c12;">No device actions performed</div>';
        }

        return html;
    }

    // Current pacing outcome: capture achieved and not subsequently lost
    function captureHeld() {
        const events = state.actions.filter(a => a.action === 'Pacing capture achieved' || a.action === 'Pacing capture lost');
        return events.length > 0 && events[events.length - 1].action === 'Pacing capture achieved';
    }

    function generateOutcome(scenario) {
        let html = '';

        if (scenario.category === 'defibrillation' || scenario.category === 'cardioversion') {
            if (state.converted) {
                html = `<div style="color: #27ae60; font-size: 18px; font-weight: bold;">✓ RHYTHM CONVERTED</div>
                    <div style="color: #ecf0f1; margin-top: 10px;">Patient now in sinus rhythm. Vital signs improving.</div>`;
            } else {
                html = `<div style="color: #f39c12; font-size: 18px; font-weight: bold;">⚠ Rhythm not converted</div>
                    <div style="color: #ecf0f1; margin-top: 10px;">Patient remains in abnormal rhythm. Continue management.</div>`;
            }
        } else if (scenario.category === 'pacing') {
            if (captureHeld()) {
                html = `<div style="color: #27ae60; font-size: 18px; font-weight: bold;">✓ PACING SUCCESSFUL</div>
                    <div style="color: #ecf0f1; margin-top: 10px;">Electrical and mechanical capture achieved. Patient stabilised.</div>`;
            } else {
                html = `<div style="color: #f39c12; font-size: 18px; font-weight: bold;">⚠ Pacing not successful</div>
                    <div style="color: #ecf0f1; margin-top: 10px;">Capture not achieved or not maintained. Continue to increase output.</div>`;
            }
        }

        return html;
    }

    // Back to free play with the device switched off
    function returnToMenu() {
        resetSessionState();
        state.selectedMode = null;
        state.customScenario = [];
        showSimulator();
        setFreePlayUI();
        setMode('off');
    }

    function setMode(mode) {
        const previousMode = state.deviceMode;
        if (mode !== previousMode) {
            // A real device dumps any charge / abandons analysis when the mode changes
            disarm(mode === 'off' ? '' : 'MODE CHANGED');
            cancelAnalysis();
        }

        const labels = document.querySelectorAll('.mode-label');
        labels.forEach(l => l.classList.remove('active'));
        const activeLabel = document.querySelector(`.mode-label[data-mode="${mode}"]`);
        if(activeLabel) activeLabel.classList.add('active');

        const rotations = { monitor: 0, defib: 90, pacer: 180, off: 270 };
        document.getElementById('modeDial').style.setProperty('--dial-rotation', `${rotations[mode]}deg`);

        // NEW: Toggle Pacing Cover
        const cover = document.getElementById('pacingCover');
        if (cover) {
            cover.classList.toggle('open', mode === 'pacer');
        }

        // Leaving pacer mode: return to the underlying rhythm
        if (mode !== 'pacer') {
            state.pacingActive = false;
            if (state.isCaptured) releaseCapture();
        }

        const screenEl = document.querySelector('.screen');
        state.deviceMode = mode;

        if (mode === 'off') {
            if (animationId) {
                cancelAnimationFrame(animationId);
                animationId = null;
            }
            state.syncMode = false;
            document.getElementById('syncBtn').classList.remove('active');
            screenEl.classList.add('screen-off');
            document.getElementById('hrDisplay').textContent = '--';
            document.getElementById('spo2Display').textContent = '--';
            document.getElementById('etco2Display').textContent = '--';
            document.getElementById('bpDisplay').textContent = '--/--';
            document.getElementById('messageBar').textContent = '';
            document.getElementById('messageBar').className = 'message-bar';
            document.getElementById('leadInfo').textContent = `LEAD: ${state.lead}`;
            document.getElementById('syncIndicator').textContent = '';
            document.getElementById('modeInfo').textContent = 'MODE: OFF';

            if (ctx) {
                const dpr = window.devicePixelRatio || 1;
                ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
            }
            logAction('Mode changed', 'OFF');
        } else {
            screenEl.classList.remove('screen-off');
            logAction('Mode changed', mode.toUpperCase());
            if (!animationId) {
                resetTrace();
                animationId = requestAnimationFrame(animate);
            }
            if (previousMode === 'off') setMessage('SIMULATOR READY', 'ready');
        }

        if (mode === 'pacer') {
            state.pacingActive = true;
            if (!state.isCaptured) state.originalRhythm = state.rhythm;
            evaluateCapture();
        }
        updateDisplays();
    }

    function toggleSync() {
        if (state.deviceMode === 'off') return;
        state.syncMode = !state.syncMode;
        const btn = document.getElementById('syncBtn');
        if (state.syncMode) {
            btn.classList.add('active');
            setMessage('SYNC MODE ON - SYNCHRONISED CARDIOVERSION', 'ready');
            logAction('Sync mode activated');
        } else {
            btn.classList.remove('active');
            setMessage('SYNC MODE OFF', 'ready');
            logAction('Sync mode deactivated');
        }
        updateDisplays();
    }

    function adjustEnergy(dir) {
        if (state.deviceMode === 'off') return;
        const levels = state.energyLevels;
        let idx = levels.indexOf(state.energy);
        if (idx === -1) idx = levels.indexOf(120);
        const newIdx = clamp(idx + (dir > 0 ? 1 : -1), 0, levels.length - 1);
        if (levels[newIdx] === state.energy) return;
        state.energy = levels[newIdx];
        disarm('ENERGY CHANGED');
        logAction('Energy adjusted', `${state.energy}J`);
        updateDisplays();
    }

    function stopChargeSound() {
        if (state.chargeSound) {
            try { state.chargeSound.stop(); } catch (e) { /* already stopped */ }
            state.chargeSound = null;
        }
    }

    function chargeDefib() {
        if (state.deviceMode !== 'defib') {
            setMessage('SWITCH TO DEFIB MODE', '');
            return;
        }
        if (state.machineState !== APP_STATES.IDLE) return;

        transitionTo(APP_STATES.CHARGING);
        setMessage('CHARGING...', 'alert');
        logAction('Charge initiated', `${state.energy}J`);
        state.chargeSound = playSound('charging');

        state.chargeTimer = later(() => {
            state.chargeTimer = null;
            state.chargeSound = null;
            state.charged = true;
            transitionTo(APP_STATES.READY);
            logAction('Charged', `${state.energy}J ready`);

            // --- SAFETY DUMP TIMER ---
            // Auto-disarm after 60 seconds if shock not delivered
            state.dumpTimer = later(() => {
                state.dumpTimer = null;
                if (state.machineState === APP_STATES.READY) {
                    transitionTo(APP_STATES.IDLE);
                    setMessage('CHARGE DUMPED - SAFETY TIMEOUT', 'ready');
                    logAction('Safety', 'Charge dumped (Timeout)');
                    playSound('alarm');
                }
            }, 60000);
            // -------------------------

        }, 2000);
    }

    // Milliseconds until the next R-wave reaches the "live" edge of the trace,
    // or null if there is no R-wave to synchronise to (e.g. VF, asystole)
    function msToNextRWave() {
        markTrace();
        const now = traceNowX();
        const speed = window.ecgSpeed || 125;
        const peaks = window.ecgTrace.peaks(now, now + 3 * speed);
        if (!peaks.length) return null;
        return Math.max(0, (peaks[0] - now) / speed * 1000);
    }

    function deliverShock() {
        if (state.machineState !== APP_STATES.READY || !state.charged || state.deviceMode !== 'defib') return;

        const energy = state.energy;
        const sync = state.syncMode;
        const rhythm = state.rhythm;

        // --- REALISTIC SYNC DELAY ---
        // In SYNC mode the shock is delivered on the next detected R-wave only
        let delay = 0;
        if (sync) {
            const toR = msToNextRWave();
            if (toR === null) {
                setMessage('SYNC: NO R-WAVE DETECTED - SHOCK NOT DELIVERED', 'alert');
                logAction('Sync shock not delivered', 'No R-wave detected');
                return;
            }
            delay = toR;
            setMessage('SYNC... WAITING FOR R-WAVE...', 'alert');
        }

        // Clear safety timer
        cancelLater(state.dumpTimer);
        state.dumpTimer = null;
        transitionTo(APP_STATES.DISCHARGING);

        later(() => {
            if (state.machineState !== APP_STATES.DISCHARGING) return; // Cancelled
            state.shockCount++;
            if (state.arrestStartTime) state.arrestShocks++;
            playSound('shock');
            logAction(`Shock ${state.shockCount} delivered`, `${energy}J (${sync ? 'SYNC' : 'UNSYNC'})`);
            transitionTo(APP_STATES.IDLE);
            state.flashUntil = performance.now() + 150;
            setMessage('SHOCK DELIVERED', 'alert');
            updateDisplays();

            // --- AUTO-RESET CYCLE TIMER ---
            if (state.arrestStartTime) {
                startCycleCountdown();
                logAction('Shock Delivered', 'Cycle Timer Reset');
            }

            later(() => resolveShockOutcome(rhythm, energy, sync), 2000);
        }, delay);
    }

    // How many adequate shocks the current rhythm needs before it converts
    function shocksRequired(isArrest) {
        const setting = state.shockResponse;
        if (setting === 'never') return null;
        if (setting !== 'auto') return parseInt(setting, 10);
        if (state.sessionType === 'scenario' && scenarios[state.selectedScenario]) {
            return scenarios[state.selectedScenario].shockToConvert || 1;
        }
        if (state.sessionType === 'custom') return 1;
        return isArrest ? 3 : 1;
    }

    // --- SMART ALS LOGIC ---
    function resolveShockOutcome(rhythm, energy, sync) {
        if (state.rhythm !== rhythm) return; // Rhythm changed by the instructor meanwhile

        const isArrest = SHOCKABLE_ARREST.includes(rhythm);
        const isTachy = CARDIOVERTIBLE.includes(rhythm) && state.hasPulse;
        let failReason = '';

        // Unsynchronised shock on a perfusing rhythm can land on the T wave
        if (!sync && state.hasPulse && window.rhythmPeaks(rhythm, 0, 2000, state.hr).length && causesROnT()) {
            setMessage('UNSYNCHRONISED SHOCK ON T WAVE - VF', 'alert');
            later(() => {
                applyRhythm('vfib', { keepMode: true });
                logAction('VF induced', 'Unsynchronised shock (R-on-T)');
            }, 800);
            return;
        }

        if (isArrest) {
            if (energy < ARREST_MIN_ENERGY) failReason = `ENERGY TOO LOW (<${ARREST_MIN_ENERGY}J)`;
        } else if (isTachy) {
            if (!sync) failReason = 'R-ON-T HAZARD (NO SYNC)';
            else if (energy < CARDIOVERSION_MIN_ENERGY) failReason = 'ENERGY TOO LOW';
        } else {
            setMessage('SHOCK DELIVERED - NO CHANGE', 'ready');
            return;
        }

        if (failReason) {
            setMessage(`SHOCK FAILED: ${failReason}`, 'alert');
            return;
        }

        state.episodeShocks++;
        const noChangeMsg = isArrest ? 'NO CHANGE - RESUME CPR' : 'SHOCK DELIVERED - NO CHANGE';

        // Custom scenarios: the instructor's sequence decides what happens next
        if (state.customScenarioActive) {
            const step = state.customScenario[state.currentScenarioStep];
            if (!step || step.trigger !== 'shock') {
                setMessage(noChangeMsg, isArrest ? 'alert' : 'ready');
                return;
            }
            const nextIndex = state.currentScenarioStep + 1;
            setMessage('RHYTHM CHANGING...', 'ready');
            later(() => {
                if (nextIndex >= state.customScenario.length) convertRhythm(isArrest);
                activateScenarioStep(nextIndex);
            }, 1000);
            return;
        }

        const required = shocksRequired(isArrest);
        if (required === null || state.episodeShocks < required) {
            setMessage(noChangeMsg, isArrest ? 'alert' : 'ready');
            return;
        }

        setMessage('RHYTHM CONVERTING...', 'ready');
        later(() => convertRhythm(isArrest), 1000);
    }

    function causesROnT() {
        if (state.rOnT === 'always') return true;
        if (state.rOnT === 'sometimes') return Math.random() < 1 / 3;
        return false;
    }

    function currentScenario() {
        return state.sessionType === 'scenario' ? scenarios[state.selectedScenario] : null;
    }

    function convertRhythm(isArrest) {
        const scenario = currentScenario();
        applyRhythm((scenario && scenario.successRhythm) || 'nsr', {
            vitals: scenario && scenario.successVitals,
            rosc: isArrest,
            keepMode: true
        });
        state.converted = true;
        logAction('Rhythm converted', rhythmNames[state.rhythm]);
        setMessage(isArrest ? 'ORGANISED RHYTHM - CHECK FOR PULSE' : 'RHYTHM CONVERTED', 'ready');

        // Optional refibrillation: VF returns once, 30-90s after ROSC
        if (isArrest && state.refib === 'once' && !state.refibDone && !state.customScenarioActive) {
            state.refibDone = true;
            const convertedTo = state.rhythm;
            later(() => {
                if (state.rhythm !== convertedTo) return;
                applyRhythm('vfib', { keepMode: true });
                logAction('VF recurred', 'Refibrillation');
                setMessage('VF - REFIBRILLATION', 'alert');
            }, 30000 + Math.random() * 60000);
        }
    }

    function analyseRhythm() {
        if (state.deviceMode === 'off') return;
        if (state.machineState !== APP_STATES.IDLE) return;

        // Custom scenario: "On Analyse" steps move on at the rhythm check
        if (state.customScenarioActive) {
            const step = state.customScenario[state.currentScenarioStep];
            if (step && step.trigger === 'manual') activateScenarioStep(state.currentScenarioStep + 1);
        }

        transitionTo(APP_STATES.ANALYSING);
        setMessage('ANALYSING... STAND CLEAR', 'alert');
        logAction('Rhythm analysed');

        state.analyseTimer = later(() => {
            state.analyseTimer = null;
            transitionTo(APP_STATES.IDLE);
            const r = state.rhythm;
            const shockable = SHOCKABLE_ARREST.includes(r) || (r === 'vtach' && !state.hasPulse);
            if (shockable) {
                setMessage('SHOCKABLE RHYTHM DETECTED', 'alert');
                logAction('Analysis result', 'Shockable');
            } else {
                setMessage('NO SHOCK ADVISED', 'ready');
                logAction('Analysis result', 'Non-shockable');
            }
        }, 2500);
    }

    function setPacerDial(param, value) {
        const dial = document.querySelector(`.pacer-dial[data-pacer-dial="${param}"]`);
        if (!dial) return;
        const rotation = param === 'output' ? (value / 140) * 270 : ((value - 30) / 150) * 270;
        dial.style.setProperty('--dial-rotation', `${rotation}deg`);
    }

    function captureThreshold() {
        const scenario = currentScenario();
        if (scenario && scenario.requiresPacing) return scenario.currentThreshold || scenario.captureThreshold;
        return FREE_PLAY_CAPTURE_THRESHOLD;
    }

    // Work out whether the current output captures the underlying rhythm.
    // Electrical capture (broad complex after every spike) comes first; mechanical
    // capture (a palpable pulse at the paced rate) needs a little more output.
    function evaluateCapture() {
        if (state.deviceMode !== 'pacer') return;
        const scenario = currentScenario();
        const base = state.originalRhythm || state.rhythm;
        const threshold = captureThreshold();
        const electrical = PACING_CAPABLE.includes(base) && state.pacerOutput >= threshold;
        const mechanical = electrical && state.pacerOutput >= threshold + MECHANICAL_CAPTURE_MARGIN;
        const wasElectrical = state.isCaptured;
        const wasMechanical = state.mechanicalCapture;
        if (electrical === wasElectrical && mechanical === wasMechanical) return;

        if (electrical && !wasElectrical) {
            state.preCapture = { hr: state.hr, spo2: state.spo2, etco2: state.etco2, bpSys: state.bpSys, bpDia: state.bpDia, hasPulse: state.hasPulse };
            state.baseHr = state.hr;
            state.isCaptured = true;
            state.rhythm = 'paced';
            state.hr = state.pacerRate;
            logAction('Electrical capture', `at ${state.pacerOutput}mA`);
            setMessage(`ELECTRICAL CAPTURE AT ${state.pacerOutput}mA - CHECK PULSE`, 'ready');
        }

        if (mechanical && !wasMechanical) {
            const successVitals = (scenario && scenario.requiresPacing) ? scenario.successVitals : rhythmVitals['paced'];
            state.mechanicalCapture = true;
            state.hasPulse = true;
            applyVitals({ spo2: successVitals.spo2, etco2: successVitals.etco2, bpSys: successVitals.bpSys, bpDia: successVitals.bpDia });
            logAction('Pacing capture achieved', `Mechanical capture at ${state.pacerOutput}mA`);
            if (state.customScenarioActive) advanceCustomScenario('pacing');
        } else if (!mechanical && wasMechanical) {
            state.mechanicalCapture = false;
            if (state.preCapture) applyVitals({ spo2: state.preCapture.spo2, etco2: state.preCapture.etco2, bpSys: state.preCapture.bpSys, bpDia: state.preCapture.bpDia });
            logAction('Pacing capture lost', 'Mechanical capture lost');
        }

        if (!electrical && wasElectrical) {
            releaseCapture();
            logAction('Electrical capture lost');
            setMessage('CAPTURE LOST', 'alert');
        }
        updateDisplays();
    }

    // Return to the underlying rhythm and its vitals
    function releaseCapture() {
        const base = state.originalRhythm || 'nsr';
        const before = state.preCapture;
        state.isCaptured = false;
        state.mechanicalCapture = false;
        state.preCapture = null;
        setVitals(base);
        if (before) {
            applyVitals(before);
            state.hasPulse = before.hasPulse;
        }
    }

    function adjustPacer(param, change) {
        if (state.deviceMode === 'off') return;
        if (state.deviceMode !== 'pacer') {
            setMessage('Switch to PACER mode to adjust pacing', '');
            return;
        }

        if (param === 'output') {
            state.pacerOutput = clamp(state.pacerOutput + change, 0, 140);
            logAction('Pacing output adjusted', `${state.pacerOutput}mA`);
            setPacerDial('output', state.pacerOutput);
            evaluateCapture();
        } else if (param === 'rate') {
            state.pacerRate = clamp(state.pacerRate + change, 30, 180);
            logAction('Pacing rate adjusted', `${state.pacerRate}ppm`);
            setPacerDial('rate', state.pacerRate);
            if (state.isCaptured) {
                state.hr = state.pacerRate;
            }
        }
        updateDisplays();
    }

    // Central rhythm change used by the instructor buttons, scenarios and conversions
    function applyRhythm(rhythm, opts = {}) {
        if (!rhythmVitals[rhythm]) return;

        setVitals(rhythm);
        applyVitals(opts.vitals);
        state.originalRhythm = rhythm;
        state.isCaptured = false;
        state.mechanicalCapture = false;
        state.preCapture = null;
        state.episodeShocks = 0;
        state.roscAchieved = !!opts.rosc;
        if (opts.rosc) state.hasPulse = true;

        if (state.deviceMode === 'off' && !opts.keepMode) {
            setMode('monitor');
        } else {
            updateDisplays();
        }

        document.querySelectorAll('.rhythm-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.rhythm === rhythm);
        });

        if (state.deviceMode === 'pacer') evaluateCapture();
        if (!opts.noArrestCheck) updateArrestPanel();
    }

    function quickSetRhythm(rhythm) {
        if (state.scenarioActive || state.customScenarioActive) {
            logAction('Instructor changed rhythm', rhythmNames[rhythm] || rhythm);
        }
        applyRhythm(rhythm);
    }

    function toggleInstructorPanel() {
        if (!instructorPanel) return;
        const btn = document.getElementById('minimiseBtn');

        instructorPanel.classList.toggle('minimised');
        if (instructorPanel.classList.contains('minimised')) {
            btn.textContent = '▼ Show';
        } else {
            btn.textContent = '▲ Hide';
        }
    }

    function toggleArtefact(type, isOn) {
        if (!state.noise.hasOwnProperty(type)) return;
        state.noise[type] = isOn;
        syncArtefacts();
        logAction('Artefact', `${type} ${isOn ? 'ON' : 'OFF'}`);
    }

    function checkPulse() {
        if (state.deviceMode === 'off') return;

        const currentPulseState = state.hasPulse;
        const captured = state.isCaptured;
        const electricalOnly = captured && !state.mechanicalCapture;
        const pacedRate = state.pacerRate;

        logAction('Pulse check performed');
        setMessage('CHECKING FOR PULSE...', '');

        later(() => {
            if (electricalOnly) {
                setMessage(`PULSE DOES NOT MATCH PACED RATE (${pacedRate}/MIN) - NO MECHANICAL CAPTURE`, 'alert');
                logAction('Pulse check result', 'Electrical capture only - no mechanical capture');
            } else if (captured) {
                setMessage(`PULSE PRESENT - MATCHES PACED RATE (${pacedRate}/MIN)`, 'ready');
                logAction('Pulse check result', 'Pulse matches paced rate');
            } else if (currentPulseState) {
                setMessage('PULSE PRESENT - CAROTID PULSE PALPABLE', 'ready');
                logAction('Pulse check result', 'Pulse present');
            } else {
                setMessage('NO PULSE DETECTED - CARDIAC ARREST CONFIRMED', 'alert');
                logAction('Pulse check result', 'No pulse - cardiac arrest');
            }
        }, 1500);
    }

    function tryAgain() {
        const scenarioId = state.selectedScenario;
        if (!scenarioId) {
            returnToMenu();
            return;
        }
        selectScenario(scenarioId);
    }

    function printCertificate() {
        const scenario = scenarios[state.selectedScenario];
        if (!scenario) return;

        showMenuScreen(certificateScreen);

        document.getElementById('certScenarioName').textContent = scenario.name;

        const now = new Date();
        document.getElementById('certDate').textContent = now.toLocaleDateString('en-GB', {
            day: 'numeric',
            month: 'long',
            year: 'numeric'
        });

        let perfHTML = '<div style="display: grid; gap: 10px;">';

        const shocks = state.actions.filter(a => a.action.includes('delivered'));
        const syncUsed = state.actions.find(a => a.action === 'Sync mode activated');
        const pulseChecks = state.actions.filter(a => a.action === 'Pulse check performed');
        const pacingActions = state.actions.filter(a => a.action.includes('Pacing'));

        if (shocks.length > 0) {
            perfHTML += `<div><strong>Shocks Delivered:</strong> ${shocks.length}</div>`;
        }

        if (scenario.requiresSync) {
            perfHTML += `<div><strong>Sync Mode:</strong> ${syncUsed ? '✓ Used correctly' : '✗ Not used'}</div>`;
        }

        if (pulseChecks.length > 0) {
            perfHTML += `<div><strong>Pulse Checks:</strong> ${pulseChecks.length} performed</div>`;
        }

        if (scenario.category === 'pacing') {
            perfHTML += `<div><strong>Pacing:</strong> ${captureHeld() ? '✓ Capture achieved' : 'Attempted'}</div>`;
        }

        if (scenario.category === 'defibrillation' || scenario.category === 'cardioversion') {
            perfHTML += `<div><strong>Outcome:</strong> ${state.converted ? '✓ Rhythm converted' : 'Rhythm not converted'}</div>`;
        }

        perfHTML += `<div><strong>Total Actions:</strong> ${state.actions.length}</div>`;

        let firstIntervention = null;
        if (shocks.length > 0) {
            firstIntervention = shocks[0];
        } else if (pacingActions.length > 0) {
            firstIntervention = pacingActions[0];
        }

        if (firstIntervention) {
            const timeToIntervention = firstIntervention.time;
            const minutes = Math.floor(timeToIntervention / 60);
            const seconds = timeToIntervention % 60;
            perfHTML += `<div><strong>Time to First Intervention:</strong> ${minutes}:${String(seconds).padStart(2, '0')}</div>`;
        }

        perfHTML += '</div>';

        document.getElementById('certPerformance').innerHTML = perfHTML;
    }

    function backToSummary() {
        showMenuScreen(summaryScreen);
    }

    // --- AUDIO CONTEXT MANAGER ---
    let audioCtx;
    function getAudioContext() {
        if (!audioCtx) {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (AudioCtx) {
                audioCtx = new AudioCtx();
            }
        }
        if (audioCtx && audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
        return audioCtx;
    }

    function playSound(type) {
        const ctx = getAudioContext();
        if (!ctx) return null;

        const oscillator = ctx.createOscillator();
        const gainNode = ctx.createGain();

        oscillator.connect(gainNode);
        gainNode.connect(ctx.destination);

        const now = ctx.currentTime;

        switch(type) {
            case 'charging':
                oscillator.frequency.setValueAtTime(400, now);
                oscillator.frequency.linearRampToValueAtTime(800, now + 2);
                gainNode.gain.setValueAtTime(0.3, now);
                oscillator.start(now);
                oscillator.stop(now + 2);
                break;

            case 'charged':
                oscillator.frequency.setValueAtTime(1000, now);
                gainNode.gain.setValueAtTime(0.4, now);
                gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.5);
                oscillator.start(now);
                oscillator.stop(now + 0.5);
                break;

            case 'shock':
                oscillator.frequency.setValueAtTime(800, now);
                gainNode.gain.setValueAtTime(0.5, now);
                gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
                oscillator.start(now);
                oscillator.stop(now + 0.3);
                break;

            case 'alarm':
                oscillator.frequency.setValueAtTime(1200, now);
                oscillator.type = 'square';
                gainNode.gain.setValueAtTime(0.1, now);
                oscillator.start(now);
                oscillator.stop(now + 0.3);
                break;
        }
        return oscillator;
    }

    function cycleMode() {
        const order = ['monitor', 'defib', 'pacer', 'off'];
        let idx = order.indexOf(state.deviceMode);
        if (idx === -1) idx = 0;
        const next = order[(idx + 1) % order.length];
        setMode(next);
    }

    // --- Keyboard Shortcuts ---
    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
        // Don't hijack typing, open dialogs or the menu screens
        if (e.target.closest && e.target.closest('input, select, textarea, [contenteditable="true"]')) return;
        if (!modalOverlay.classList.contains('hidden') || simulatorContainer.classList.contains('hidden')) return;

        const key = e.key.toLowerCase();

        if (key === 'c') {
            e.preventDefault();
            chargeDefib();
        } else if (key === 's') {
            e.preventDefault();
            deliverShock();
        } else if (key === 'p') {
            e.preventDefault();
            checkPulse();
        } else if (key === 'm') {
            e.preventDefault();
            cycleMode();
        } else if (state.deviceMode === 'defib' && e.key === 'ArrowUp') {
            e.preventDefault();
            adjustEnergy(1);
        } else if (state.deviceMode === 'defib' && e.key === 'ArrowDown') {
            e.preventDefault();
            adjustEnergy(-1);
        }
    });

    // --- Timers ---
    setInterval(() => {
        const now = new Date();
        const timeEl = document.getElementById('timeInfo');
        if (timeEl) {
            timeEl.textContent = now.toTimeString().split(' ')[0];
        }
        // Keep vitals (e.g. ETCO2 during CPR / after ROSC) and drug timers live
        if (state.deviceMode !== 'off') updateDisplays();
        updateDrugPanel();
    }, 1000);

    // --- EVENT LISTENERS ---

    // --- Guideline Modal (dialog) ---
    let modalReturnFocus = null;

    function openModal(title, html) {
        modalReturnFocus = document.activeElement;
        modalTitle.textContent = title;
        modalBody.innerHTML = html;
        modalOverlay.classList.remove('hidden');
        closeModalBtn.focus();
    }

    function closeModal() {
        if (modalOverlay.classList.contains('hidden')) return;
        modalOverlay.classList.add('hidden');
        if (modalReturnFocus && typeof modalReturnFocus.focus === 'function') modalReturnFocus.focus();
        modalReturnFocus = null;
    }

    hintButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const data = guidelineData[btn.dataset.guideline];
            if (data) openModal(data.title, data.content);
        });
    });

    closeModalBtn.addEventListener('click', closeModal);

    modalOverlay.addEventListener('click', (e) => {
        if (e.target === modalOverlay) closeModal();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeModal();
    });
    // --- End of Modal Listeners ---

    // --- Scenario / Mode Select Navigation ---
    document.getElementById('openScenariosBtn').addEventListener('click', () => {
        if (!leaveSession()) return;
        showMenuScreen(modeSelectScreen);
    });
    document.querySelectorAll('#modeSelectScreen [data-select-mode]').forEach(btn => {
        btn.addEventListener('click', () => {
            state.selectedMode = btn.dataset.selectMode;
            document.getElementById('modeTitle').textContent =
                state.selectedMode === 'education' ? 'Education Mode' : 'Assessment Mode';
            showMenuScreen(scenarioScreen);
        });
    });
    // Leave the menus: resume free play, or reset if a finished scenario is still loaded
    function backToFreePlay() {
        state.selectedMode = null;
        if (state.sessionType !== 'free') {
            returnToMenu();
        } else {
            showSimulator();
        }
    }
    document.getElementById('backToFreePlayBtn').addEventListener('click', backToFreePlay);
    document.getElementById('backToModeSelectBtn').addEventListener('click', () => showMenuScreen(modeSelectScreen));

    // --- New Scenario Creator Listeners ---
    document.getElementById('openScenarioCreatorBtn').addEventListener('click', () => {
        if (!leaveSession()) return;
        showMenuScreen(scenarioCreatorScreen);
    });
    document.getElementById('cancelCustomScenarioBtn').addEventListener('click', backToFreePlay);

    // Quick Rhythm Panel
    document.querySelectorAll('.quick-rhythm-panel .rhythm-btn').forEach(btn => {
        btn.addEventListener('click', () => quickSetRhythm(btn.dataset.rhythm));
    });

    // Scenario Screen
    document.querySelectorAll('#scenarioScreen [data-scenario]').forEach(btn => {
        btn.addEventListener('click', () => selectScenario(btn.dataset.scenario));
    });

    // Summary Screen
    document.getElementById('tryAgainBtn').addEventListener('click', tryAgain);
    document.getElementById('printCertBtn').addEventListener('click', printCertificate);
    document.getElementById('returnToMenuBtn').addEventListener('click', returnToMenu);

    // Certificate Screen
    document.getElementById('printBtn').addEventListener('click', () => window.print());
    document.getElementById('backToSummaryBtn').addEventListener('click', backToSummary);

    // Simulator Container Buttons
    endScenarioBtn.addEventListener('click', endScenario);
    resetScenarioBtn.addEventListener('click', resetScenario);

    // Instructor Panel
    document.getElementById('minimiseBtn').addEventListener('click', toggleInstructorPanel);
    document.querySelectorAll('#instructorPanel .rhythm-btn').forEach(btn => {
        btn.addEventListener('click', () => quickSetRhythm(btn.dataset.rhythm));
    });
    document.querySelectorAll('#instructorPanel input[type="checkbox"]').forEach(box => {
        box.addEventListener('change', (e) => toggleArtefact(e.target.dataset.artefact, e.target.checked));
    });
    document.getElementById('shockResponseSelect').addEventListener('change', (e) => {
        state.shockResponse = e.target.value;
        logAction('Shock response set', e.target.options[e.target.selectedIndex].text);
    });
    document.getElementById('rOnTSelect').addEventListener('change', (e) => {
        state.rOnT = e.target.value;
        logAction('Unsynchronised shock setting', e.target.options[e.target.selectedIndex].text);
    });
    document.getElementById('refibSelect').addEventListener('change', (e) => {
        state.refib = e.target.value;
        state.refibDone = false;
        logAction('Refibrillation setting', e.target.options[e.target.selectedIndex].text);
    });

    // Device Controls - Softkeys
    document.getElementById('checkPulseBtn').addEventListener('click', checkPulse);
    document.getElementById('markerBtn').addEventListener('click', () => {
        if (state.deviceMode === 'off') return;
        logAction('Event marker');
        setMessage('EVENT MARKER RECORDED', 'ready');
    });

    // Device Controls - Side buttons
    document.getElementById('sizeBtn').addEventListener('click', () => {
        if (state.deviceMode === 'off') return;
        const gains = [0.5, 1, 2, 4];
        state.ecgGain = gains[(gains.indexOf(state.ecgGain) + 1) % gains.length];
        setMessage(`ECG SIZE x${state.ecgGain}`, 'ready');
        updateDisplays();
    });
    document.getElementById('leadBtn').addEventListener('click', () => {
        if (state.deviceMode === 'off') return;
        const leads = ['PADS', 'I', 'II', 'III'];
        state.lead = leads[(leads.indexOf(state.lead) + 1) % leads.length];
        logAction('Lead changed', state.lead);
        setMessage(`LEAD ${state.lead}`, 'ready');
        updateDisplays();
    });
    document.getElementById('recorderBtn').addEventListener('click', () => {
        if (state.deviceMode === 'off') return;
        logAction('Recorder', 'ECG strip printed');
        setMessage('RECORDING ECG STRIP...', 'ready');
    });

    // Device Controls - Main Buttons
    document.getElementById('syncBtn').addEventListener('click', toggleSync);
    document.getElementById('shockBtn').addEventListener('click', deliverShock);
    document.getElementById('analyseBtn').addEventListener('click', analyseRhythm);
    document.getElementById('chargeBtn').addEventListener('click', chargeDefib);

    // Device Controls - Energy
    document.querySelectorAll('.energy-arrow').forEach(btn => {
        btn.addEventListener('click', () => adjustEnergy(parseInt(btn.dataset.energyDir)));
    });

    // Device Controls - Mode Dial
    document.querySelectorAll('.mode-label').forEach(label => {
        label.addEventListener('click', () => setMode(label.dataset.mode));
    });

    // Device Controls - Pacer
    document.querySelectorAll('.pacer-btn').forEach(btn => {
        btn.addEventListener('click', () => adjustPacer(btn.dataset.pacerParam, parseInt(btn.dataset.pacerDir)));
    });
    document.getElementById('pacerModeBtn').addEventListener('click', () => {
        if (state.deviceMode !== 'pacer') return;
        state.pacerDemand = !state.pacerDemand;
        updatePacerModeButton();
        logAction('Pacer mode', state.pacerDemand ? 'Demand' : 'Asynchronous (fixed rate)');
        setMessage(state.pacerDemand ? 'DEMAND PACING' : 'ASYNCHRONOUS PACING', 'ready');
        updateDisplays();
    });

    function updatePacerModeButton() {
        document.getElementById('pacerModeBtn').textContent = state.pacerDemand ? 'MODE: DEMAND' : 'MODE: ASYNC';
    }

    // --- Custom Scenario Logic ---
    const MAX_CUSTOM_STEPS = 5;
    const STEP_TRIGGERS = {
        manual: 'On Analyse (rhythm check)',
        shock: 'On Shock Success',
        pacing: 'On Pacing Capture',
        timer_30: 'Timer: 30s',
        timer_60: 'Timer: 60s',
        timer_120: 'Timer: 2m'
    };
    const STORAGE_KEY = 'defibSim.customScenarios';
    const stepsContainer = document.getElementById('customScenarioSteps');
    const addStepBtn = document.getElementById('addStepBtn');

    function getScenarioStepHTML(index) {
        const rhythmOpts = Object.keys(rhythmNames)
            .map(key => `<option value="${key}">${rhythmNames[key]}</option>`)
            .join('');
        const triggerOpts = Object.keys(STEP_TRIGGERS)
            .map(key => `<option value="${key}">${STEP_TRIGGERS[key]}</option>`)
            .join('');

        return `
        <div class="scenario-step-card" id="step-${index}">
            <div class="step-header">
                <h5>Step ${index + 1}</h5>
                <button type="button" class="remove-step-btn" aria-label="Remove step ${index + 1}">×</button>
            </div>
            <div>
                <label>Rhythm</label>
                <select class="scenario-rhythm-select step-rhythm">
                    ${rhythmOpts}
                </select>
            </div>
            <div>
                <label>Trigger to Next</label>
                <select class="scenario-rhythm-select step-trigger">
                    ${triggerOpts}
                </select>
            </div>
        </div>`;
    }

    function stepCards() {
        return [...stepsContainer.querySelectorAll('.scenario-step-card')];
    }

    // Keep step numbers, ids and the Add button in step with the cards
    function refreshStepCards() {
        const cards = stepCards();
        cards.forEach((card, i) => {
            card.id = `step-${i}`;
            card.querySelector('h5').textContent = `Step ${i + 1}`;
            card.querySelector('.remove-step-btn').setAttribute('aria-label', `Remove step ${i + 1}`);
        });
        if (!cards.length && !stepsContainer.querySelector('.steps-placeholder')) {
            stepsContainer.innerHTML = '<div class="steps-placeholder">Click "Add Step" to begin</div>';
        }
        const full = cards.length >= MAX_CUSTOM_STEPS;
        addStepBtn.disabled = full;
        addStepBtn.textContent = full ? `Maximum ${MAX_CUSTOM_STEPS} steps` : '+ Add Step';
    }

    function addStep(step) {
        const count = stepCards().length;
        if (count >= MAX_CUSTOM_STEPS) return;
        const placeholder = stepsContainer.querySelector('.steps-placeholder');
        if (placeholder) placeholder.remove();
        stepsContainer.insertAdjacentHTML('beforeend', getScenarioStepHTML(count));
        if (step) {
            const card = stepCards()[count];
            card.querySelector('.step-rhythm').value = step.rhythm;
            card.querySelector('.step-trigger').value = step.trigger;
        }
        refreshStepCards();
    }

    function readSteps() {
        return stepCards().map(card => ({
            rhythm: card.querySelector('.step-rhythm').value,
            trigger: card.querySelector('.step-trigger').value
        }));
    }

    function loadSteps(steps) {
        stepCards().forEach(card => card.remove());
        steps.slice(0, MAX_CUSTOM_STEPS).forEach(step => addStep(step));
        refreshStepCards();
    }

    // Only accept steps that use known rhythms and triggers
    function validSteps(steps) {
        return Array.isArray(steps) && steps.length > 0 && steps.every(s =>
            s && Object.prototype.hasOwnProperty.call(rhythmNames, s.rhythm) &&
            Object.prototype.hasOwnProperty.call(STEP_TRIGGERS, s.trigger));
    }

    addStepBtn.addEventListener('click', () => addStep());

    stepsContainer.addEventListener('click', (e) => {
        const btn = e.target.closest('.remove-step-btn');
        if (!btn) return;
        btn.closest('.scenario-step-card').remove();
        refreshStepCards();
    });

    // --- Saved scenarios (stored in this browser only) ---
    function readSaved() {
        try {
            const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
            return (saved && typeof saved === 'object') ? saved : {};
        } catch (e) {
            return {};
        }
    }

    function writeSaved(saved) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
            return true;
        } catch (e) {
            window.alert('Could not save in this browser (storage unavailable). Use "Export file" instead.');
            return false;
        }
    }

    function refreshSavedList(selectName) {
        const select = document.getElementById('savedScenarioSelect');
        const names = Object.keys(readSaved()).sort();
        select.innerHTML = names.length
            ? names.map(n => `<option></option>`).join('')
            : '<option value="">- None saved -</option>';
        names.forEach((n, i) => { select.options[i].value = n; select.options[i].textContent = n; });
        if (selectName) select.value = selectName;
    }

    document.getElementById('saveScenarioBtn').addEventListener('click', () => {
        const steps = readSteps();
        if (!steps.length) {
            window.alert('Add at least one step first.');
            return;
        }
        const name = (window.prompt('Name for this scenario:') || '').trim();
        if (!name) return;
        const saved = readSaved();
        if (saved[name] && !window.confirm(`Replace the saved scenario "${name}"?`)) return;
        saved[name] = steps;
        if (writeSaved(saved)) refreshSavedList(name);
    });

    document.getElementById('loadScenarioBtn').addEventListener('click', () => {
        const name = document.getElementById('savedScenarioSelect').value;
        const steps = readSaved()[name];
        if (!name || !validSteps(steps)) return;
        loadSteps(steps);
    });

    document.getElementById('deleteScenarioBtn').addEventListener('click', () => {
        const name = document.getElementById('savedScenarioSelect').value;
        if (!name || !window.confirm(`Delete the saved scenario "${name}"?`)) return;
        const saved = readSaved();
        delete saved[name];
        if (writeSaved(saved)) refreshSavedList();
    });

    document.getElementById('exportScenarioBtn').addEventListener('click', () => {
        const steps = readSteps();
        if (!steps.length) {
            window.alert('Add at least one step first.');
            return;
        }
        const blob = new Blob([JSON.stringify({ app: 'defib-sim', version: 1, steps }, null, 2)], { type: 'application/json' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = 'defib-scenario.json';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    });

    const importInput = document.getElementById('importScenarioInput');
    document.getElementById('importScenarioBtn').addEventListener('click', () => importInput.click());
    importInput.addEventListener('change', () => {
        const file = importInput.files[0];
        importInput.value = '';
        if (!file) return;
        file.text().then(text => {
            const data = JSON.parse(text);
            const steps = Array.isArray(data) ? data : data && data.steps;
            if (!validSteps(steps)) throw new Error('invalid');
            loadSteps(steps);
        }).catch(() => window.alert('That file is not a valid scenario file.'));
    });

    refreshSavedList();

    function startCustomScenario() {
        if (state.customScenario.length === 0) return;
        resetSessionState();
        state.sessionType = 'custom';
        state.customScenarioActive = true;
        state.scenarioStartTime = Date.now();

        showSimulator();
        showInstructorPanel('Custom Scenario');
        endScenarioBtn.classList.remove('hidden');
        resetScenarioBtn.classList.remove('hidden');

        logAction('Custom scenario started', `${state.customScenario.length} step(s)`);
        activateScenarioStep(0);
    }

    document.getElementById('startCustomScenarioBtn').addEventListener('click', () => {
        const steps = readSteps();
        if (steps.length === 0) {
            window.alert('Add at least one step first.');
            return;
        }
        state.customScenario = steps;
        startCustomScenario();
    });

    function activateScenarioStep(index) {
        cancelLater(state.stepTimer);
        state.stepTimer = null;
        state.currentScenarioStep = index;

        if (index >= state.customScenario.length) {
            if (state.customScenarioActive) {
                state.customScenarioActive = false;
                logAction('Custom scenario complete');
                setMessage('CUSTOM SCENARIO COMPLETE', 'ready');
            }
            return;
        }
        const step = state.customScenario[index];
        applyRhythm(step.rhythm);
        logAction(`Custom scenario: step ${index + 1}/${state.customScenario.length}`, rhythmNames[step.rhythm]);
        setMessage(`SCENARIO STEP ${index + 1}/${state.customScenario.length}`, 'ready');

        if (step.trigger.startsWith('timer_')) {
            const seconds = parseInt(step.trigger.split('_')[1]);
            state.stepTimer = later(() => {
                if (state.customScenarioActive && state.currentScenarioStep === index) {
                    activateScenarioStep(index + 1);
                }
            }, seconds * 1000);
        }
    }

    function advanceCustomScenario(trigger) {
        if (!state.customScenarioActive) return;
        const step = state.customScenario[state.currentScenarioStep];
        if (step && step.trigger === trigger) {
            activateScenarioStep(state.currentScenarioStep + 1);
        }
    }

    // --- INSTRUCTOR / ASSESSOR PANEL LOGIC ---
    function startCycleCountdown() {
        if (cycleInterval) clearInterval(cycleInterval);
        cycleTime = 120;

        const display = document.getElementById('cycleTimerDisplay');
        const container = document.getElementById('cycleTimerContainer');
        const nextBtn = document.getElementById('nextCycleBtn');

        // Reset visuals
        container.classList.remove('cycle-warning');
        nextBtn.classList.remove('highlight-btn');
        display.textContent = "02:00";

        cycleInterval = setInterval(() => {
            cycleTime--;

            // Format MM:SS
            const m = Math.floor(cycleTime / 60);
            const s = cycleTime % 60;
            display.textContent = `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;

            // Warning at 10 seconds
            if (cycleTime <= 10) {
                container.classList.add('cycle-warning');
            }

            // Time Up
            if (cycleTime <= 0) {
                clearInterval(cycleInterval);
                cycleInterval = null;
                nextBtn.classList.add('highlight-btn');
                playSound('alarm'); // Use existing beep
                logAction('CYCLE ENDED', 'Assess Rhythm');
            }
        }, 1000);
    }

    const METRONOME_BPM = 110;
    let nextClickTime = 0;

    function stopMetronome() {
        if (metronomeTimer) {
            clearInterval(metronomeTimer);
            metronomeTimer = null;
        }
        const btn = document.getElementById('metronomeBtn');
        if (btn) btn.style.background = "#2c3e50";
    }

    function toggleMetronome() {
        const btn = document.getElementById('metronomeBtn');

        if (metronomeTimer) {
            stopMetronome();
            logAction('Metronome', 'OFF');
            return;
        }
        const ctx = getAudioContext();
        if (!ctx) {
            logAction('Metronome', 'Audio not available in this browser');
            return;
        }
        logAction('Metronome', `ON (${METRONOME_BPM} bpm)`);
        btn.style.background = "#27ae60";
        nextClickTime = ctx.currentTime + 0.05;
        scheduleMetronome();
        metronomeTimer = setInterval(scheduleMetronome, 25);
    }

    // Clicks are scheduled slightly ahead on the audio clock, so the beat stays
    // exactly 110/min even when the browser delays timers
    function scheduleMetronome() {
        const ctx = audioCtx;
        if (!ctx) return;
        if (nextClickTime < ctx.currentTime) nextClickTime = ctx.currentTime + 0.02; // Resume after the tab was asleep
        while (nextClickTime < ctx.currentTime + 0.12) {
            playMetronomeClick(nextClickTime);
            nextClickTime += 60 / METRONOME_BPM;
        }
    }

    function playMetronomeClick(when) {
        const ctx = getAudioContext();
        if (!ctx) return;

        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.frequency.value = 1000;
        osc.type = 'square';
        gain.gain.value = 0.05;

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(when);
        osc.stop(when + 0.05);
    }

    // LISTENERS
    document.getElementById('nextCycleBtn').addEventListener('click', function() {
        startCycleCountdown();
        logAction('CYCLE RESET', '2 Minutes');
    });

    document.getElementById('metronomeBtn').addEventListener('click', toggleMetronome);

    document.querySelectorAll('.cause-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            this.classList.toggle('checked');
            const causeName = this.dataset.cause;
            const status = this.classList.contains('checked') ? 'CONSIDERED' : 'UNCHECKED';
            logAction('Differential', `${causeName} ${status}`);
        });
    });

    // --- OPTIMISED ROSC LISTENER ---
    document.getElementById('roscBtn').addEventListener('click', () => {
        const scenario = currentScenario();
        applyRhythm((scenario && scenario.successRhythm) || 'nsr', {
            vitals: scenario && scenario.successVitals,
            rosc: true
        });
        state.converted = true;

        // ROSC SPIKE LOGIC (Simulate CO2 washout)
        const settledEtco2 = state.etco2;
        state.etco2 = 6.8;
        logAction('ROSC CONFIRMED', 'ETCO2 Spike > 6.0kPa');

        // Settle ETCO2 logic
        etco2SettleInterval = setInterval(() => {
            if (state.etco2 > settledEtco2) {
                state.etco2 = Math.max(settledEtco2, state.etco2 - 0.05);
            } else {
                clearInterval(etco2SettleInterval);
                etco2SettleInterval = null;
            }
        }, 200);

        setMessage('ROSC ACHIEVED - START POST-RESUS CARE', 'ready');
        updateDisplays();
    });
    // ------------------------------------------

    // --- IMPROVED ARREST LOGIC ---

    // 1. Check for Arrest on Rhythm Change
    function updateArrestPanel() {
        const vitals = rhythmVitals[state.rhythm];
        const inArrest = vitals && vitals.hasPulse === false && !state.roscAchieved;

        if (inArrest) {
            cprPanel.classList.remove('hidden');

            // Add active class slightly later for CSS transition
            later(() => {
                cprPanel.classList.add('active');
            }, 50);

            if (!state.arrestStartTime) {
                state.arrestStartTime = Date.now();
                state.arrestShocks = 0;
                logAction('Cardiac Arrest Detected', 'Timer Started');

                // --- AUTO-START CYCLE TIMER ---
                startCycleCountdown();
                logAction('CPR Cycle', '2 Minute Timer Auto-Started');
            }

            if (!arrestTimerInterval) {
                startArrestTimer();
            }
        } else if (state.arrestStartTime) {
            endArrest();
        } else {
            cprPanel.classList.remove('active');
        }
    }

    // Arrest over (ROSC / organised rhythm) or session reset
    function endArrest() {
        if (cycleInterval) clearInterval(cycleInterval);
        if (arrestTimerInterval) clearInterval(arrestTimerInterval);
        cycleInterval = null;
        arrestTimerInterval = null;
        stopMetronome();

        state.arrestStartTime = null;
        if (state.cprActive) {
            state.cprActive = false;
            logAction('CPR Stopped', 'Arrest ended');
        }
        updateCprButton();
        syncArtefacts();

        cprPanel.classList.remove('active', 'minimised');
        cprMinBtn.textContent = '▶';
        document.getElementById('cycleTimerContainer').classList.remove('cycle-warning');
        document.getElementById('nextCycleBtn').classList.remove('highlight-btn');
    }

    // 2. Timer Logic (Timestamp based)
    function startArrestTimer() {
        if (arrestTimerInterval) clearInterval(arrestTimerInterval);

        const timerDisplay = document.getElementById('cprTimerDisplay');

        arrestTimerInterval = setInterval(() => {
            if (!state.arrestStartTime) return;

            const diff = Date.now() - state.arrestStartTime;
            const totalSeconds = Math.floor(diff / 1000);

            const m = Math.floor(totalSeconds / 60);
            const s = totalSeconds % 60;

            // Format: 02:30
            timerDisplay.textContent = `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
        }, 100); // Update frequently for accuracy
    }

    function updateCprButton() {
        const btn = document.getElementById('cprToggleBtn');
        const span = btn.querySelector('span');
        if (state.cprActive) {
            btn.style.background = "#e74c3c"; // Red for STOP
            btn.style.borderColor = "#c0392b";
            span.textContent = "STOP CPR";
        } else {
            btn.style.background = ""; // Default
            btn.style.borderColor = "";
            span.textContent = "START CPR";
        }
    }

    function formatElapsed(ms) {
        const s = Math.max(0, Math.floor(ms / 1000));
        return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    }

    // Drug timers are always shown; prompts are hidden in assessment mode
    function drugPromptsAllowed() {
        return !(state.sessionType === 'scenario' && state.selectedMode === 'assessment');
    }

    // RCUK ALS drug timing: adrenaline ASAP (non-shockable) or after the 3rd
    // shock, then every 3-5 min; amiodarone 300mg after 3 shocks, 150mg after 5
    function updateDrugPanel() {
        const now = Date.now();
        const adr = state.adrenalineTimes;
        const amio = state.amiodaroneTimes;

        document.getElementById('adrenalineStatus').textContent = adr.length
            ? `${adr.length} dose${adr.length > 1 ? 's' : ''}, last ${formatElapsed(now - adr[adr.length - 1])} ago`
            : 'not given';
        document.getElementById('amiodaroneStatus').textContent = amio.length
            ? `${amio.map((t, i) => i === 0 ? '300mg' : '150mg').join(' + ')}, last ${formatElapsed(now - amio[amio.length - 1])} ago`
            : 'not given';

        const prompts = [];
        if (state.arrestStartTime && drugPromptsAllowed()) {
            const shockablePath = state.arrestShocks > 0 || SHOCKABLE_ARREST.includes(state.rhythm);
            if (shockablePath) {
                if (state.arrestShocks >= 3 && !adr.length) prompts.push('Adrenaline 1mg due (after 3rd shock)');
                if (state.arrestShocks >= 3 && amio.length === 0) prompts.push('Amiodarone 300mg due (after 3rd shock)');
                if (state.arrestShocks >= 5 && amio.length === 1) prompts.push('Amiodarone 150mg due (after 5th shock)');
            } else if (!adr.length) {
                prompts.push('Adrenaline 1mg due now (non-shockable rhythm)');
            }
            if (adr.length && now - adr[adr.length - 1] >= 180000) prompts.push('Adrenaline due (3-5 min since last dose)');
        }
        const promptEl = document.getElementById('drugPrompt');
        const text = prompts.join(' • ');
        if (promptEl.textContent !== text) promptEl.textContent = text;
        promptEl.classList.toggle('hidden', !prompts.length);
    }

    function updateAmiodaroneButton() {
        const btn = document.querySelector('.cpr-action-btn[data-action="amiodarone"]');
        if (!btn) return;
        btn.querySelector('.btn-subtext').textContent = state.amiodaroneDoses === 0 ? '300mg IV/IO' : '150mg IV/IO';
    }

    // --- NEW: CPR Panel Minimise Logic ---
    cprMinBtn.addEventListener('click', () => {
        cprPanel.classList.toggle('minimised');
        const isMin = cprPanel.classList.contains('minimised');
        cprMinBtn.textContent = isMin ? "◀" : "▶";
    });

    // 3. New Listeners for Panel Buttons
    document.getElementById('cprToggleBtn').addEventListener('click', () => {
        const time = document.getElementById('cprTimerDisplay').textContent;
        state.cprActive = !state.cprActive;
        updateCprButton();
        syncArtefacts();
        updateDisplays();
        logAction(`CPR ${state.cprActive ? "Started" : "Stopped"}`, `Time: ${time}`);
    });

    document.querySelectorAll('.cpr-action-btn[data-action="adrenaline"], .cpr-action-btn[data-action="amiodarone"]').forEach(btn => {
        btn.addEventListener('click', function() {
            const action = this.dataset.action;
            const time = document.getElementById('cprTimerDisplay').textContent;

            // Visual click feedback for momentary buttons
            const span = this.querySelector('span');
            const originalText = span.textContent;
            span.textContent = "DONE";
            this.style.background = "#27ae60";
            setTimeout(() => {
                span.textContent = originalText;
                this.style.background = "";
            }, 800);

            if (action === 'adrenaline') {
                state.adrenalineTimes.push(Date.now());
                logAction(`Adrenaline 1mg Given`, `Time: ${time}`);
            } else if (action === 'amiodarone') {
                // RCUK: 300mg after 3 shocks, further 150mg after 5 shocks
                const dose = state.amiodaroneDoses === 0 ? '300mg' : '150mg';
                state.amiodaroneDoses++;
                state.amiodaroneTimes.push(Date.now());
                logAction(`Amiodarone ${dose} Given`, `Time: ${time}`);
                updateAmiodaroneButton();
            }
            updateDrugPanel();
        });
    });

    // --- INITIALISATION ---
    initCanvas();
    if ('ResizeObserver' in window) {
        new ResizeObserver(() => resizeCanvas()).observe(canvas);
    }
    window.addEventListener('resize', resizeCanvas);

    setFreePlayUI();
    setMode('off');

}); // End of DOMContentLoaded
