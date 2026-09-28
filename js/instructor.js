// instructor.js - the separate instructor window
// Shows what the simulator window is doing and sends it commands (js/link.js).
// The simulator stays in charge, so nothing here changes the simulation directly.
(function(){'use strict';

    const { scenarios, rhythmNames } = window.SIM_DATA;
    const HEARTBEAT_MS = 2000;
    const STALE_MS = 5000;       // No snapshot for this long: warn the instructor

    const RHYTHM_BUTTONS = [
        ['nsr', 'NSR'], ['vfib', 'VF'], ['vt_pulseless', 'VT (Pulseless)'], ['vtach', 'VT (Pulsed)'],
        ['svt', 'SVT'], ['afib', 'AF'], ['sinus_brady', 'SB'], ['sinus_tach', 'ST'],
        ['asystole', 'ASY'], ['chb', 'CHB'], ['paced', 'PACED'], ['idioventricular', 'IVR'],
        ['vfib_fine', 'Fine VF'], ['pea', 'PEA'], ['flutter', 'Flutter'], ['mobitz2', 'Mobitz II'],
        ['brady', 'JUNCT']
    ];
    const CAUSES = [
        ['Hypoxia', 'Hypoxia'], ['Hypovolaemia', 'Hypovolaemia'], ['Hypo/hyperthermia', 'Hypo/hyperthermia'],
        ['Hyper/hypokalaemia / metabolic', 'K+ / metabolic'], ['Toxins', 'Toxins'],
        ['Tamponade (cardiac)', 'Tamponade'], ['Tension Pneumo', 'Tension PTX'],
        ['Thrombosis (coronary/pulmonary)', 'Thrombosis']
    ];
    const CATEGORY_NAMES = { defibrillation: 'Defibrillation (cardiac arrest)', cardioversion: 'Cardioversion (with pulse)', pacing: 'Transcutaneous pacing' };
    const MACHINE_NAMES = { IDLE: 'Ready', ANALYSING: 'Analysing', CHARGING: 'Charging', READY: 'Charged', DISCHARGING: 'Shocking', PACING: 'Pacing' };

    const $ = id => document.getElementById(id);
    const controls = $('controls');
    const statusEl = $('connectionStatus');

    let link = null;
    let latest = null;
    let lastStateAt = 0;
    let lastLogKey = '';

    // --- Build the buttons ---
    RHYTHM_BUTTONS.forEach(([rhythm, label]) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'rhythm-btn';
        btn.dataset.rhythm = rhythm;
        btn.textContent = label;
        btn.title = rhythmNames[rhythm] || label;
        btn.addEventListener('click', () => send('setRhythm', { rhythm }));
        $('rhythmButtons').appendChild(btn);
    });

    CAUSES.forEach(([cause, label]) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'cause-btn';
        btn.dataset.cause = cause;
        btn.textContent = label;
        btn.addEventListener('click', () => send('cause', { cause }));
        $('causeButtons').appendChild(btn);
    });

    const scenarioSelect = $('scenarioSelect');
    Object.keys(CATEGORY_NAMES).forEach(category => {
        const group = document.createElement('optgroup');
        group.label = CATEGORY_NAMES[category];
        Object.keys(scenarios).filter(id => scenarios[id].category === category).forEach(id => {
            const opt = document.createElement('option');
            opt.value = id;
            opt.textContent = scenarios[id].name;
            group.appendChild(opt);
        });
        if (group.children.length) scenarioSelect.appendChild(group);
    });

    // --- Controls -> commands ---
    function send(name, args) {
        if (link) link.send('command', { name, args: args || {} });
    }

    document.querySelectorAll('[data-command]').forEach(btn => {
        btn.addEventListener('click', () => send(btn.dataset.command));
    });
    document.querySelectorAll('[data-drug]').forEach(btn => {
        btn.addEventListener('click', () => send('drug', { drug: btn.dataset.drug }));
    });
    document.querySelectorAll('select[data-setting]').forEach(select => {
        select.addEventListener('change', () => send('setting', { setting: select.dataset.setting, value: select.value }));
    });
    document.querySelectorAll('input[data-artefact]').forEach(box => {
        box.addEventListener('change', () => send('artefact', { type: box.dataset.artefact, on: box.checked }));
    });

    $('startScenarioBtn').addEventListener('click', () => {
        const id = scenarioSelect.value;
        if (!scenarios[id]) return;
        if (latest && latest.session.running && !window.confirm(`End the current scenario and start "${scenarios[id].name}"?`)) return;
        send('startScenario', { scenario: id, mode: $('scenarioModeSelect').value });
    });
    $('endScenarioBtn').addEventListener('click', () => {
        if (!window.confirm('End the current scenario? The summary will be shown on the simulator screen.')) return;
        send('endScenario');
    });
    $('resetScenarioBtn').addEventListener('click', () => {
        if (!window.confirm('Reset this scenario?')) return;
        send('resetScenario');
    });
    $('tryAgainBtn').addEventListener('click', () => send('tryAgain'));
    $('freePlayBtn').addEventListener('click', () => {
        if (!window.confirm('Return to free play? This resets the simulator and switches the device off.')) return;
        send('freePlay');
    });

    // --- Snapshot -> screen ---
    function setText(id, text) {
        const el = $(id);
        const value = String(text);
        if (el.textContent !== value) el.textContent = value;
    }

    function render(s) {
        // Monitor
        setText('rhythmName', s.rhythmName);
        setText('underlyingRhythm', s.underlying ? `(underlying: ${s.underlying})` : '');
        setText('hrValue', s.monitor.hr);
        setText('spo2Value', s.monitor.spo2);
        setText('etco2Value', s.monitor.etco2);
        setText('bpValue', s.monitor.bp);
        setText('messageMirror', s.monitor.message);
        $('messageMirror').className = 'message-bar ' + s.monitor.messageType;

        const d = s.device;
        setText('deviceMode', d.mode.toUpperCase());
        setText('deviceEnergy', `${d.energy}J`);
        setText('deviceState', d.mode === 'off' ? 'Off' : (MACHINE_NAMES[d.machine] || d.machine));
        setText('shockCount', d.shocks);
        setText('syncState', d.sync ? 'ON' : 'OFF');
        let pacing = 'OFF';
        if (d.pacing) {
            pacing = `${d.pacerOutput}mA ${d.pacerRate}ppm ${d.pacerDemand ? 'demand' : 'async'}`;
            if (d.mechanical) pacing += ' - mechanical capture';
            else if (d.captured) pacing += ' - electrical capture only';
        }
        setText('pacingState', pacing);
        setText('pulseState', s.hasPulse ? 'Present' : 'None');

        // Session
        setText('sessionName', s.session.name);
        let detail = '';
        if (s.session.type === 'scenario' && s.session.mode) detail = `(${s.session.mode === 'education' ? 'Education' : 'Assessment'})`;
        if (s.session.step) detail = `(step ${s.session.step})`;
        if (s.view === 'summary' || s.view === 'certificate') detail = '- summary on the simulator screen';
        else if (s.view === 'menu') detail = '- a menu is open on the simulator';
        setText('sessionDetail', detail);
        const inSimulator = s.view === 'simulator';
        $('endScenarioBtn').disabled = !(inSimulator && s.session.type !== 'free');
        $('resetScenarioBtn').disabled = !(inSimulator && (s.session.type === 'custom' || (s.session.type === 'scenario' && s.session.scenario)));
        $('tryAgainBtn').disabled = !(s.session.type === 'scenario' && s.session.scenario && !inSimulator);

        // Rhythm
        document.querySelectorAll('#rhythmButtons .rhythm-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.rhythm === s.rhythm);
        });

        // Arrest
        const a = s.arrest;
        $('arrestSection').classList.toggle('ic-inactive', !a.active);
        $('arrestIdle').classList.toggle('hidden', a.active);
        $('arrestSection').querySelectorAll('button').forEach(btn => { btn.disabled = !a.active; });
        setText('downtime', a.downtime);
        setText('cycleTime', a.cycle);
        $('cycleBox').classList.toggle('cycle-warning', a.cycleWarning);
        $('nextCycleBtn').classList.toggle('highlight-btn', a.cycleEnded);
        setText('cprBtn', a.cpr ? 'Stop CPR' : 'Start CPR');
        $('cprBtn').classList.toggle('ic-on', a.cpr);
        setText('metronomeBtn', a.metronome ? 'Metronome ON' : 'Metronome 110');
        $('metronomeBtn').classList.toggle('ic-on', a.metronome);
        document.querySelectorAll('#causeButtons .cause-btn').forEach(btn => {
            btn.classList.toggle('checked', a.causes.includes(btn.dataset.cause));
        });
        setText('amiodaroneBtn', `Amiodarone ${a.amiodaroneDose}`);
        setText('adrenalineStatus', a.adrenaline);
        setText('amiodaroneStatus', a.amiodarone);
        setText('drugPrompt', a.prompts.join(' • '));
        $('drugPrompt').classList.toggle('hidden', !a.prompts.length);

        // Settings and artefacts (left alone while being changed here)
        document.querySelectorAll('select[data-setting]').forEach(select => {
            const value = s.settings[select.dataset.setting];
            if (document.activeElement !== select && select.value !== value) select.value = value;
        });
        document.querySelectorAll('input[data-artefact]').forEach(box => {
            box.checked = !!s.artefacts[box.dataset.artefact];
        });

        renderLog(s.log, s.logCount);
    }

    function renderLog(entries, count) {
        const key = `${count}`;
        if (key === lastLogKey) return;
        lastLogKey = key;
        const log = $('eventLog');
        log.textContent = '';
        if (!entries.length) {
            const empty = document.createElement('div');
            empty.className = 'log-placeholder';
            empty.textContent = 'No events yet';
            log.appendChild(empty);
            return;
        }
        entries.slice().reverse().forEach(e => {
            const row = document.createElement('div');
            row.className = 'log-entry';
            const time = document.createElement('span');
            time.className = 'log-time';
            time.textContent = `[${e.time}]`;
            const detail = document.createElement('span');
            detail.className = 'log-detail';
            detail.textContent = e.details;
            row.append(time, ` ${e.action} `, detail);
            log.appendChild(row);
        });
    }

    // --- Connection ---
    function setStatus(kind, text) {
        statusEl.className = 'ic-status ' + kind;
        statusEl.textContent = text;
        controls.disabled = kind !== 'ok';
    }

    function checkStale() {
        if (!link) return;
        if (!lastStateAt) {
            setStatus('waiting', 'Waiting for the simulator window...');
        } else if (Date.now() - lastStateAt > STALE_MS) {
            setStatus('lost', 'No response from the simulator - is it still open?');
        }
    }

    function onMessage(msg) {
        if (msg.role !== 'simulator') return;
        if (msg.type === 'hello') {
            link.send('hello');
        } else if (msg.type === 'state' && msg.state && typeof msg.state === 'object') {
            try {
                render(msg.state);
            } catch (e) {
                console.warn('Could not show simulator state', e);
                return;
            }
            latest = msg.state;
            lastStateAt = Date.now();
            setStatus('ok', 'Connected to the simulator');
        } else if (msg.type === 'bye') {
            lastStateAt = 0;
            latest = null;
            setStatus('lost', 'The simulator window was closed');
        }
    }

    function start(code) {
        link = window.SimLink.connect({ code, role: 'instructor', onMessage });
        setText('codeDisplay', code);
        document.title = `Instructor ${code} - ZOLL R Series Simulator`;
        $('joinPanel').classList.add('hidden');
        controls.classList.remove('hidden');
        setStatus('waiting', 'Waiting for the simulator window...');
        link.send('hello');
        setInterval(() => link.send('heartbeat'), HEARTBEAT_MS);
        setInterval(checkStale, 1000);
        window.addEventListener('pagehide', () => link.send('bye'));
    }

    function showJoin(message) {
        $('joinPanel').classList.remove('hidden');
        if (message) {
            $('joinError').textContent = message;
            $('joinError').classList.remove('hidden');
        }
    }

    if (!window.SimLink.supported) {
        showJoin('This browser cannot link windows. Please use an up-to-date version of Chrome, Edge, Firefox or Safari.');
        $('joinForm').classList.add('hidden');
        return;
    }

    $('joinForm').addEventListener('submit', e => {
        e.preventDefault();
        const code = window.SimLink.normaliseCode($('joinCode').value);
        if (!window.SimLink.isValidCode(code)) {
            showJoin('That is not a valid session code. It has six letters and numbers.');
            return;
        }
        history.replaceState(null, '', `?session=${code}`);
        start(code);
    });

    const fromUrl = window.SimLink.normaliseCode(new URLSearchParams(location.search).get('session'));
    if (window.SimLink.isValidCode(fromUrl)) {
        start(fromUrl);
    } else {
        showJoin(fromUrl ? 'The session code in the link is not valid. Please type it in.' : '');
        $('joinCode').focus();
    }
})();
