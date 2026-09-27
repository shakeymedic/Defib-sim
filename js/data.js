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
            initialVitals: { hr: 180, spo2: 0, etco2: 0, bpSys: 0, bpDia: 0 },
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
            energyRange: [120, 150],
            energyAdvice: '120-150J initial shock for VT with a pulse',
            successRhythm: 'nsr',
            successVitals: { hr: 76, spo2: 97, etco2: 4.8, bpSys: 118, bpDia: 74 },
            requiresSync: true,
            shockToConvert: 1
        },
        'unstable-svt': {
            name: 'SVT with Life-Threatening Features',
            description: 'Patient with palpitations and chest pain. Narrow complex tachycardia at 190/min. BP 80/54. Requires SYNCHRONISED cardioversion.',
            category: 'cardioversion',
            initialRhythm: 'svt',
            initialVitals: { hr: 190, spo2: 90, etco2: 3.5, bpSys: 80, bpDia: 54 },
            hasPulse: true,
            shockable: true,
            recommendedEnergy: 100,
            successEnergy: 100,
            energyRange: [70, 120],
            energyAdvice: '70-120J initial shock for SVT',
            successRhythm: 'nsr',
            successVitals: { hr: 74, spo2: 98, etco2: 4.8, bpSys: 120, bpDia: 76 },
            requiresSync: true,
            shockToConvert: 1
        },
        'fast-af': {
            name: 'Fast AF with Life-Threatening Features',
            description: 'Patient with fast irregular rhythm. Atrial fibrillation at 155/min. BP 82/48, pulmonary oedema developing. Requires SYNCHRONISED cardioversion.',
            category: 'cardioversion',
            initialRhythm: 'afib',
            initialVitals: { hr: 155, spo2: 88, etco2: 4.0, bpSys: 82, bpDia: 48 },
            hasPulse: true,
            shockable: true,
            recommendedEnergy: 200,
            successEnergy: 200,
            energyRange: [200, 200],
            energyAdvice: 'maximum output (200J on the R Series) for AF',
            successRhythm: 'nsr',
            successVitals: { hr: 80, spo2: 96, etco2: 4.7, bpSys: 118, bpDia: 72 },
            requiresSync: true,
            shockToConvert: 1
        },
        'complete-hb': {
            name: 'Complete Heart Block',
            description: 'Patient syncopal and hypotensive. Complete dissociation between P waves and broad QRS complexes. HR 32/min. BP 86/50. High risk of asystole - atropine not recommended with a broad QRS. Requires transcutaneous pacing as a bridge to transvenous pacing.',
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

    // Hint text follows RCUK Adult ALS Guidelines (Oct 2025) and the RCUK adult ALS,
    // bradyarrhythmia (2025) and tachyarrhythmia (V3, March 2026) algorithms
    const guidelineData = {
        'shockable': {
            title: 'Shockable Arrest (VF / pVT)',
            content: `
                <ul>
                    <li><strong>1.</strong> Confirm arrest. Start CPR 30:2, attach the defibrillator and call the resuscitation team.</li>
                    <li><strong>2.</strong> Assess rhythm. If VF/pVT (VF of any amplitude, even fine VF), continue compressions while charging.</li>
                    <li><strong>3.</strong> Deliver <strong>1 shock</strong>, aiming for a pause in compressions of <strong>less than 5 s</strong>. Biphasic first shock <strong>at least 150 J</strong>; if unsuccessful, it is reasonable to increase the energy for later shocks.</li>
                    <li><strong>4.</strong> Immediately resume CPR for <strong>2 minutes</strong>, then reassess the rhythm.</li>
                    <li><strong>5.</strong> After <strong>3 shocks</strong>: give <strong>adrenaline 1 mg IV/IO</strong> and <strong>amiodarone 300 mg IV/IO</strong>. Repeat adrenaline every <strong>3-5 minutes</strong>.</li>
                    <li><strong>6.</strong> After <strong>5 shocks</strong>: give a further <strong>amiodarone 150 mg</strong> (counting all shocks, whether VF is refractory or recurrent). Lidocaine 100 mg (then 50 mg) is an alternative if amiodarone is unavailable.</li>
                    <li><strong>7.</strong> Refractory VF after 3 shocks: check pad position and consider an <strong>antero-posterior pad position</strong> (vector change).</li>
                    <li><strong>8.</strong> Identify and treat reversible causes: 4 Hs and 4 Ts.</li>
                </ul>
            `
        },
        'nonshockable': {
            title: 'Non-Shockable Arrest (Asystole / PEA)',
            content: `
                <ul>
                    <li><strong>1.</strong> Confirm arrest. Start CPR 30:2, attach the defibrillator and call the resuscitation team.</li>
                    <li><strong>2.</strong> Assess rhythm. If PEA or asystole, do <strong>NOT</strong> shock.</li>
                    <li><strong>3.</strong> Immediately resume CPR for <strong>2 minutes</strong>.</li>
                    <li><strong>4.</strong> Give <strong>adrenaline 1 mg IV/IO as soon as possible</strong>, then every <strong>3-5 minutes</strong>.</li>
                    <li><strong>5.</strong> If asystole is diagnosed, check the ECG carefully for <strong>P waves</strong>: this may respond to pacing.</li>
                    <li><strong>6.</strong> Identify and treat reversible causes: 4 Hs and 4 Ts.</li>
                </ul>
            `
        },
        'tachy': {
            title: 'Tachyarrhythmia (with a pulse)',
            content: `
                <ul>
                    <li><strong>1.</strong> ABCDE assessment. Monitor ECG, BP and SpO2, record a 12-lead ECG, give oxygen if SpO2 < 94%, obtain IV access. Not for sinus tachycardia: treat the cause.</li>
                    <li><strong>2. Life-threatening features?</strong>
                        <br>Shock; syncope with severe or ongoing hypotension; myocardial ischaemia; severe heart failure with pulmonary oedema; immediately post-ROSC.</li>
                    <li><strong>3. UNSTABLE:</strong>
                        <br>• <strong>Synchronised shock</strong>, up to 3 attempts. Consider sedation or anaesthesia if conscious.
                        <br>• Initial energy: <strong>AF</strong> - maximum defibrillator output; <strong>atrial flutter / SVT</strong> - 70-120 J, then stepwise increases; <strong>VT with a pulse</strong> - 120-150 J, consider stepwise increases.
                        <br>• If unsuccessful: <strong>amiodarone 300 mg IV over 10-20 min</strong> or procainamide 10-15 mg/kg (max 1 g) over 20 min, then repeat the synchronised shock.</li>
                    <li><strong>4. STABLE - narrow regular:</strong> vagal manoeuvres, then adenosine 6 mg, 12 mg, 18 mg rapid IV (if no pre-excitation), then verapamil or a beta-blocker, then synchronised shock.</li>
                    <li><strong>5. STABLE - narrow irregular (probable AF):</strong> rate control (EF > 40%: beta-blocker, verapamil, diltiazem or digoxin; EF < 40%: beta-blocker or digoxin). Anticoagulate if duration > 24 h.</li>
                    <li><strong>6. STABLE - broad regular:</strong> treat as VT with <strong>synchronised shock(s)</strong>. If sedation/anaesthesia risk is too high: procainamide 10-15 mg/kg over 20 min, or amiodarone 300 mg IV over 10-60 min then 900 mg over 24 h.</li>
                    <li><strong>7. STABLE - broad irregular:</strong> AF with pre-excitation - procainamide or cardioversion. Polymorphic VT with long QT - magnesium 8 mmol IV over 10 min, avoid amiodarone.</li>
                    <li>Seek expert help.</li>
                </ul>
            `
        },
        'brady': {
            title: 'Bradyarrhythmia',
            content: `
                <ul>
                    <li><strong>1.</strong> ABCDE assessment. Give oxygen if appropriate, IV access, monitor ECG, BP and SpO2, record a 12-lead ECG, treat reversible causes (e.g. electrolytes).</li>
                    <li><strong>2. Life-threatening features?</strong>
                        <br>Shock; syncope; myocardial ischaemia; severe heart failure; immediately post-ROSC.
                        <br>If yes: <strong>atropine 500 mcg IV</strong>.</li>
                    <li><strong>3. Risk of asystole?</strong> Recent asystole; <strong>Mobitz II AV block</strong>; <strong>complete heart block with broad QRS</strong>; ventricular pause > 3 s.</li>
                    <li><strong>4. Interim measures</strong> (unsatisfactory response or risk of asystole):
                        <br>• Atropine 500 mcg IV, repeat to a maximum of 3 mg
                        <br>• Isoprenaline 5 mcg/min IV, or adrenaline 2-10 mcg/min IV
                        <br>• Alternatives: aminophylline, dopamine, glucagon (beta-blocker or calcium channel blocker overdose); glycopyrrolate instead of atropine
                        <br>• and/or <strong>transcutaneous pacing</strong> (a bridge to transvenous pacing)</li>
                    <li><strong>5.</strong> Do <strong>not</strong> give atropine in high-degree AV block with a wide QRS (ineffective, may worsen the block) or after cardiac transplant (use aminophylline).</li>
                    <li><strong>6.</strong> Seek expert help and arrange transvenous pacing.</li>
                </ul>
            `
        },
        'postrosc': {
            title: 'Immediately After ROSC',
            content: `
                <ul>
                    <li><strong>1.</strong> ABCDE assessment.</li>
                    <li><strong>2.</strong> Aim for <strong>SpO2 94-98%</strong> and a <strong>normal PaCO2</strong>.</li>
                    <li><strong>3.</strong> Aim for <strong>systolic BP > 100 mmHg</strong>.</li>
                    <li><strong>4.</strong> Record a <strong>12-lead ECG</strong>.</li>
                    <li><strong>5.</strong> Identify and treat the cause.</li>
                    <li><strong>6.</strong> Temperature control.</li>
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
        vt_pulseless:    { hr: 180, spo2: 0,  etco2: 0,   bpSys: 0,   bpDia: 0,  hasPulse: false },
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
