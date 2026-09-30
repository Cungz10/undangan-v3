import { drawQr, renderCard, downloadBlob } from '../../common/qrcard.js';

/**
 * Personal QR section of the invitation.
 * The link carries the token in the URL *fragment*: https://host/#t=<64 hex>.
 * A fragment is never sent to the server / logs / Referer; we POST it to /api/checkin/lookup.
 */
export const qr = (() => {
    const TOKEN_RE = /^[a-f0-9]{64}$/i;
    const CACHE_KEY = 'invitation-qr-cache';

    const apiBase = () => document.body.getAttribute('data-url') || `${window.location.origin}/`;

    /** @returns {string|null} */
    const tokenFromHash = () => {
        const t = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('t');
        return t && TOKEN_RE.test(t.trim()) ? t.trim().toLowerCase() : null;
    };

    const readCache = () => {
        try {
            return JSON.parse(window.localStorage.getItem(CACHE_KEY) || 'null');
        } catch {
            return null;
        }
    };
    const writeCache = (value) => {
        try {
            if (value) {window.localStorage.setItem(CACHE_KEY, JSON.stringify(value));}
            else {window.localStorage.removeItem(CACHE_KEY);}
        } catch { /* storage unavailable (private mode) */ }
    };

    /**
     * @param {string} token
     * @returns {Promise<{ status: 'ok', data: object } | { status: 'invalid' } | { status: 'offline' }>}
     */
    const lookup = async (token) => {
        try {
            const res = await fetch(new URL('/api/checkin/lookup', apiBase()), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token }),
            });
            if (res.status === 404) {return { status: 'invalid' };}
            if (!res.ok) {return { status: 'offline' };}
            const json = await res.json();
            return json?.data ? { status: 'ok', data: json.data } : { status: 'offline' };
        } catch {
            return { status: 'offline' };
        }
    };

    /** Greeting comes from the server, so it can't be edited through ?to=. */
    const setGreeting = (name) => {
        const el = document.getElementById('guest-name');
        if (!el) {return;}

        const wrap = document.createElement('div');
        wrap.classList.add('m-2');
        const small = document.createElement('small');
        small.className = 'mt-0 mb-1 mx-0 p-0';
        small.textContent = el.getAttribute('data-message') || '';
        const p = document.createElement('p');
        p.className = 'm-0 p-0';
        p.style.fontSize = '1.25rem';
        p.textContent = name;
        wrap.append(small, p);
        el.replaceChildren(wrap);

        const form = document.getElementById('form-name');
        if (form && !form.value) {form.value = name;}
    };

    const show = async (token, data, note = '') => {
        const section = document.getElementById('qr-section');
        const canvas = document.getElementById('invite-qr-canvas');
        if (!section || !canvas) {return;}

        document.getElementById('qr-name').textContent = data.name;
        const group = document.getElementById('qr-group');
        group.textContent = data.group_name || '';
        group.hidden = !data.group_name;

        const pax = document.getElementById('qr-pax');
        pax.textContent = `Berlaku untuk ${data.pax} orang`;
        pax.hidden = !(data.pax > 1);

        const status = document.getElementById('qr-status');
        status.textContent = data.checked_in ? 'Sudah check-in' : note;
        status.hidden = !status.textContent;
        status.classList.toggle('text-success', Boolean(data.checked_in));

        await drawQr(canvas, token, 280);
        canvas.style.opacity = data.checked_in ? '0.3' : '1';
        section.hidden = false;

        const save = document.getElementById('qr-save');
        save.onclick = async () => {
            const card = await renderCard(token, {
                name: data.name,
                subtitle: data.pax > 1 ? `Rombongan ${data.pax} orang` : (data.group_name || ''),
            });
            card.toBlob((blob) => blob && downloadBlob(blob, 'qr-undangan.png'), 'image/png');
        };
    };

    /** @returns {Promise<void>} */
    const init = async () => {
        const token = tokenFromHash();
        if (!token) {return;} // generic link: show nothing

        const result = await lookup(token);
        if (result.status === 'ok') {
            writeCache({ token, ...result.data });
            setGreeting(result.data.name);
            await show(token, result.data);
            return;
        }

        if (result.status === 'invalid') {
            const cached = readCache();
            if (cached?.token === token) {writeCache(null);}
            return; // wrong or revoked link: hide section, no hint why
        }

        // Network trouble (bad signal at the venue): fall back to the last good copy.
        const cached = readCache();
        if (cached?.token === token) {
            setGreeting(cached.name);
            await show(token, cached, 'Mode offline: status terakhir yang tersimpan');
        }
    };

    return { init };
})();
