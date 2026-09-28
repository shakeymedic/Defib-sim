// link.js - connects the simulator window to a separate instructor window
//
// The simulator window stays in charge: it runs the ECG, the device and every
// timer, sends a snapshot of what is happening ("state") and carries out the
// instructor's requests ("command"). The instructor window only shows that
// snapshot and sends commands, so the two windows can never disagree.
//
// Windows find each other with a six-character session code (no look-alike
// characters such as 0/O or 1/I/L), passed as ?session=CODE or typed in.
//
// Messages: { v, type, from, role, ...data }
//   hello     - a window has joined (the other side replies with hello/state)
//   heartbeat - an instructor window is still open
//   bye       - a window is closing
//   state     - simulator -> instructor: { state: <snapshot> }
//   command   - instructor -> simulator: { name, args }
//
// Transport: this version uses BroadcastChannel, which links windows and tabs
// of the same browser on the same computer. A transport is any function
// code => { post(msg), onMessage(fn), close() }. A Firebase transport for
// joining from another computer would implement the same three functions over
// the Realtime Database (for example posting state to sessions/<CODE>/... and
// pushing commands to a list the simulator listens to), without changes to
// the simulator or instructor code.
(function(){'use strict';

    const PROTOCOL = 1;
    const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const CODE_LENGTH = 6;

    function randomIndex(n) {
        if (window.crypto && window.crypto.getRandomValues) {
            const buf = new Uint32Array(1);
            window.crypto.getRandomValues(buf);
            return buf[0] % n;
        }
        return Math.floor(Math.random() * n);
    }

    function newCode() {
        let code = '';
        for (let i = 0; i < CODE_LENGTH; i++) code += CODE_CHARS[randomIndex(CODE_CHARS.length)];
        return code;
    }

    // Upper-case and strip spaces/punctuation from a typed or pasted code
    function normaliseCode(text) {
        return String(text || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    }

    function isValidCode(code) {
        return typeof code === 'string' && code.length === CODE_LENGTH &&
            code.split('').every(c => CODE_CHARS.includes(c));
    }

    function clientId() {
        let id = '';
        for (let i = 0; i < 12; i++) id += CODE_CHARS[randomIndex(CODE_CHARS.length)];
        return id;
    }

    function broadcastTransport(code) {
        const channel = new BroadcastChannel('defib-sim-' + code);
        let handler = null;
        channel.onmessage = e => { if (handler) handler(e.data); };
        return {
            post(msg) { channel.postMessage(msg); },
            onMessage(fn) { handler = fn; },
            close() { channel.close(); }
        };
    }

    // options: { code, role: 'simulator' | 'instructor', onMessage, transport }
    function connect(options) {
        if (!isValidCode(options.code)) throw new Error('Invalid session code');
        const id = clientId();
        const transport = (options.transport || broadcastTransport)(options.code);
        let open = true;
        transport.onMessage(msg => {
            if (!open || !msg || typeof msg !== 'object' || msg.v !== PROTOCOL || msg.from === id) return;
            if (typeof msg.type !== 'string' || typeof msg.from !== 'string') return;
            options.onMessage(msg);
        });
        return {
            id,
            code: options.code,
            role: options.role,
            send(type, data) {
                if (!open) return;
                transport.post(Object.assign({}, data, { v: PROTOCOL, type, from: id, role: options.role }));
            },
            close() {
                if (!open) return;
                open = false;
                transport.close();
            }
        };
    }

    window.SimLink = {
        supported: typeof BroadcastChannel === 'function',
        PROTOCOL,
        newCode,
        normaliseCode,
        isValidCode,
        connect
    };
})();
