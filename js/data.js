// Scenario, rhythm and guideline data used by the simulator
(function(){'use strict';

    const scenarios = {
        'vf-arrest': {
            name: 'Ventricular Fibrillation',
            description: 'Patient in cardiac arrest. Monitor shows coarse VF. No pulse, not breathing. Requires immediate defibrillation.',
            category: 'defibrillation',
            initialRhythm: 'vfib',
            initialVitals: { hr: 0, spo2: 0, etco2: 0, bpSys: 0, bpDia: 0 },
            hasPulse: false,
            shockable: true,
            recommendedEnergy: 150,
            successEnergy: 150,
            successRhythm: 'nsr',
            successVitals: { hr: 82, spo2: 94, etco2: 4.7, bpSys: 110, bpDia: 70 },
            requiresSync: false,
            shockToConvert: 3
        },
        'pulseless-vt': {
            name: 'Pulseless Ventricular Tachycardia',
            description: 'Patient in cardiac arrest. Monitor shows broad complex tachycardia. CONFIRM NO PULSE - this is a shockable arrest.',
            category: 'defibrillation',
            initialRhythm: 'vt_pulseless',
            initialVitals: { hr: 0, spo2: 0, etco2: 0, bpSys: 0, bpDia: 0 },
            hasPulse: false,
            shockable: true,
            recommendedEnergy: 150,
            successEnergy: 150,
            successRhythm: 'nsr',
            successVitals: { hr: 78, spo2: 93, etco2: 4.5, bpSys: 108, bpDia: 68 },
            requiresSync: false,
            shockToConvert: 3
        },
        'unstable-vt': {
            name: 'VT with Pulse - Unstable',
            description: 'Patient conscious but severely unwell. Broad complex tachycardia at 180/min. Pulse present. BP 82/48. Requires SYNCHRONISED cardioversion.',
            category: 'cardioversion',
            initialRhythm: 'vtach',
            initialVitals: { hr: 180, spo2: 88, etco2: 3.7, bpSys: 82, bpDia: 48 },
            hasPulse: true,
            shockable: true,
            recommendedEnergy: 120,
            successEnergy: 120,
            successRhythm: 'nsr',
            successVitals: { hr: 76, spo2: 97, etco2: 4.8, bpSys: 118, bpDia: 74 },
            requiresSync: true,
            shockToConvert: 1
        },
        'unstable-svt': {
            name: 'SVT with Adverse Features',
            description: 'Patient with palpitations and chest pain. Narrow complex tachycardia at 190/min. BP 80/54. Requires SYNCHRONISED cardioversion.',
            category: 'cardioversion',
            initialRhythm: 'svt',
            initialVitals: { hr: 190, spo2: 90, etco2: 3.5, bpSys: 80, bpDia: 54 },
            hasPulse: true,
            shockable: true,
            recommendedEnergy: 100,
            successEnergy: 100,
            successRhythm: 'nsr',
            successVitals: { hr: 74, spo2: 98, etco2: 4.8, bpSys: 120, bpDia: 76 },
            requiresSync: true,
            shockToConvert: 1
        },
        'fast-af': {
            name: 'Fast AF with Adverse Features',
            description: 'Patient with fast irregular rhythm. Atrial fibrillation at 155/min. BP 82/48, pulmonary oedema developing. Requires SYNCHRONISED cardioversion.',
            category: 'cardioversion',
            initialRhythm: 'afib',
            initialVitals: { hr: 155, spo2: 88, etco2: 4.0, bpSys: 82, bpDia: 48 },
            hasPulse: true,
            shockable: true,
            recommendedEnergy: 120,
            successEnergy: 120,
            successRhythm: 'nsr',
            successVitals: { hr: 80, spo2: 96, etco2: 4.7, bpSys: 118, bpDia: 72 },
            requiresSync: true,
            shockToConvert: 1
        },
        'complete-hb': {
            name: 'Complete Heart Block',
            description: 'Patient syncopal and hypotensive. Complete dissociation between P waves and QRS. HR 32/min. BP 86/50. Requires transcutaneous pacing.',
            category: 'pacing',
            initialRhythm: 'chb',
            initialVitals: { hr: 32, spo2: 92, etco2: 4.0, bpSys: 86, bpDia: 50 },
            hasPulse: true,
            shockable: false,
            captureThreshold: 60,
            successRate: 70,
            successVitals: { hr: 70, spo2: 97, etco2: 4.8, bpSys: 115, bpDia: 72 },
            requiresPacing: true
        },
        'symptomatic-brady': {
            name: 'Symptomatic Bradycardia',
            description: 'Patient unwell with dizziness and hypotension. Junctional bradycardia at 38/min. BP 84/52. Failed atropine. Requires pacing.',
            category: 'pacing',
            initialRhythm: 'brady',
            initialVitals: { hr: 38, spo2: 93, etco2: 4.1, bpSys: 84, bpDia: 52 },
            hasPulse: true,
            shockable: false,
            captureThreshold: 60,
            successRate: 70,
            successVitals: { hr: 70, spo2: 97, etco2: 4.7, bpSys: 112, bpDia: 70 },
            requiresPacing: true
        }
    };

    const rhythmNames = {
        nsr: 'Sinus Rhythm',
        sinus_brady: 'Sinus Bradycardia',
        sinus_tach: 'Sinus Tachycardia',
        brady: 'Junctional Bradycardia',
        mobitz2: 'Mobitz II AV Block',
        chb: 'Complete Heart Block',
        idioventricular: 'Idioventricular Rhythm',
        paced: 'Paced Rhythm',
        afib: 'Atrial Fibrillation',
        flutter: 'Atrial Flutter (2:1)',
        svt: 'SVT',
        vtach: 'VT (with pulse)',
        vt_pulseless: 'Pulseless VT',
        vfib: 'VF (coarse)',
        vfib_fine: 'VF (fine)',
        asystole: 'Asystole',
        pea: 'PEA'
    };

    const guidelineData = {
        'shockable': {
            title: 'Shockable Arrest (VF / pVT)',
            content: `
                <ul>
                    <li><strong>1.</strong> Confirm arrest. Start CPR (30:2) and attach pads.</li>
                    <li><strong>2.</strong> Analyse rhythm. If shockable (VF/pVT), continue CPR while charging.</li>
                    <li><strong>3.</strong> Deliver <strong>1 Shock</strong> (biphasic: first shock <strong>at least 150J</strong>).</li>
                    <li><strong>4.</strong> Immediately resume <strong>2 minutes</strong> of CPR. Do not check rhythm.</li>
                    <li><strong>5.</strong> Repeat cycle (Analyse, Shock, 2 min CPR).</li>
                    <li><strong>6.</strong> After the <strong>3rd shock</strong>: give <strong>Adrenaline 1mg IV/IO</strong> and <strong>Amiodarone 300mg IV/IO</strong>.</li>
                    <li><strong>7.</strong> Repeat Adrenaline 1mg every 3-5 minutes. Give a further <strong>Amiodarone 150mg</strong> after the <strong>5th shock</strong>.</li>
                    <li><strong>8.</strong> Search for and treat reversible causes (4 H's, 4 T's).</li>
                </ul>
            `
        },
        'nonshockable': {
            title: 'Non-Shockable Arrest (Asystole / PEA)',
            content: `
                <ul>
                    <li><strong>1.</strong> Confirm arrest. Start CPR (30:2) and attach pads.</li>
                    <li><strong>2.</strong> Analyse rhythm. If non-shockable (Asystole/PEA), do <strong>NOT</strong> shock.</li>
                    <li><strong>3.</strong> Immediately resume <strong>2 minutes</strong> of CPR.</li>
                    <li><strong>4.</strong> Give <strong>Adrenaline 1mg IV/IO</strong> as soon as possible.</li>
                    <li><strong>5.</strong> Repeat cycle (Analyse, 2 min CPR).</li>
                    <li><strong>6.</strong> Repeat Adrenaline 1mg every 3-5 minutes (every 2 cycles).</li>
                    <li><strong>7.</strong> Search for and treat reversible causes (4 H's, 4 T's).</li>
                </ul>
            `
        },
        'tachy': {
            title: 'Tachycardia Algorithm (Pulse)',
            content: `
                <ul>
                    <li><strong>1.</strong> Assess patient. Check for <strong>Adverse Features</strong>:
                        <br>(Shock, Syncope, Myocardial Ischaemia, Heart Failure)</li>
                    <li><strong>2. IF UNSTABLE (Adverse Features):</strong>
                        <br>• <strong>Synchronised DC Shock</strong> (Cardioversion).
                        <br>• Start at 100-120J (SVT/AF) or 120-150J (VT).</li>
                    <li><strong>3. IF STABLE:</strong>
                        <br>• <strong>Narrow QRS:</strong> Vagal manoeuvres, then Adenosine.
                        <br>• <strong>Broad QRS:</strong> Treat as VT. Amiodarone 300mg.</li>
                </ul>
            `
        },
        'brady': {
            title: 'Bradycardia Algorithm (Pulse)',
            content: `
                <ul>
                    <li><strong>1.</strong> Assess patient. Check for <strong>Adverse Features</strong>:
                        <br>(Shock, Syncope, Myocardial Ischaemia, Heart Failure)</li>
                    <li><strong>2. IF UNSTABLE (Adverse Features):</strong>
                        <br>• Give <strong>Atropine 500mcg IV</strong> (repeat up to 3mg).</li>
                    <li><strong>3. IF ATROPINE FAILS (or high-risk block):</strong>
                        <br>• Start <strong>Transcutaneous Pacing (TCP)</strong>.
                        <br>• Set rate to 60-70/min, increase output (mA) until capture.
                        <br>• Consider interim drugs (e.g., Adrenaline/Dopamine infusion).</li>
                    <li><strong>4. IF STABLE:</strong> Monitor and investigate.</li>
                </ul>
            `
        }
    };

    const rhythmVitals = {
        nsr:             { hr: 75,  spo2: 98, etco2: 5.1, bpSys: 120, bpDia: 80, hasPulse: true },
        pea:             { hr: 70,  spo2: 0,  etco2: 2.5, bpSys: 0,   bpDia: 0,  hasPulse: false },
        vfib:            { hr: 0,   spo2: 0,  etco2: 0,   bpSys: 0,   bpDia: 0,  hasPulse: false },
        vfib_fine:       { hr: 0,   spo2: 0,  etco2: 0,   bpSys: 0,   bpDia: 0,  hasPulse: false },
        vtach:           { hr: 180, spo2: 88, etco2: 3.7, bpSys: 82,  bpDia: 48, hasPulse: true },
        vt_pulseless:    { hr: 0,   spo2: 0,  etco2: 0,   bpSys: 0,   bpDia: 0,  hasPulse: false },
        svt:             { hr: 190, spo2: 90, etco2: 3.5, bpSys: 80,  bpDia: 54, hasPulse: true },
        afib:            { hr: 155, spo2: 88, etco2: 4.0, bpSys: 82,  bpDia: 48, hasPulse: true },
        flutter:         { hr: 150, spo2: 93, etco2: 4.2, bpSys: 92,  bpDia: 60, hasPulse: true },
        mobitz2:         { hr: 50,  spo2: 95, etco2: 4.5, bpSys: 88,  bpDia: 52, hasPulse: true },
        sinus_brady:     { hr: 45,  spo2: 96, etco2: 4.7, bpSys: 90,  bpDia: 50, hasPulse: true },
        sinus_tach:      { hr: 120, spo2: 97, etco2: 4.8, bpSys: 110, bpDia: 70, hasPulse: true },
        asystole:        { hr: 0,   spo2: 0,  etco2: 0,   bpSys: 0,   bpDia: 0,  hasPulse: false },
        chb:             { hr: 32,  spo2: 92, etco2: 4.0, bpSys: 86,  bpDia: 50, hasPulse: true },
        paced:           { hr: 70,  spo2: 97, etco2: 4.8, bpSys: 115, bpDia: 72, hasPulse: true },
        idioventricular: { hr: 40,  spo2: 93, etco2: 4.3, bpSys: 88,  bpDia: 50, hasPulse: true },
        brady:           { hr: 38,  spo2: 93, etco2: 4.1, bpSys: 84,  bpDia: 52, hasPulse: true }
    };

    window.SIM_DATA = { scenarios, rhythmNames, guidelineData, rhythmVitals };
})();
