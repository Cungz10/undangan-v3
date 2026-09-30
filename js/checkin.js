import { Html5Qrcode } from 'html5-qrcode';

const tokenKey = 'invitation-checkin-token';
const loginPanel = document.getElementById('staff-login');
const workspace = document.getElementById('scanner-workspace');
const loginError = document.getElementById('staff-login-error');
const resultPanel = document.getElementById('scan-result');
const startButton = document.getElementById('start-camera');
const nextButton = document.getElementById('next-scan');
const scanner = new Html5Qrcode('qr-reader');
let active = false;

const apiUrl = (path) => new URL(path, document.body.getAttribute('data-url') || `${window.location.origin}/`);

async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    const token = sessionStorage.getItem(tokenKey);
    if (token) {
        headers.set('Authorization', `Bearer ${token}`);
    }
    if (options.body) {
        headers.set('Content-Type', 'application/json');
    }

    const response = await fetch(apiUrl(path), { ...options, headers });
    const body = await response.json();
    if (!response.ok) {
        throw new Error(body?.error?.[0] || `Request failed (${response.status})`);
    }
    return body.data;
}

function showResult(status, title, detail, guestName = '') {
    resultPanel.className = `scan-result ${status}`;
    resultPanel.querySelector('.result-mark').textContent = status === 'success' ? '\u2713' : '!';
    resultPanel.querySelector('strong').textContent = title;
    resultPanel.querySelector('p').textContent = guestName ? `${guestName} - ${detail}` : detail;
}

function showWorkspace(username) {
    loginPanel.hidden = true;
    workspace.hidden = false;
    document.getElementById('staff-label').textContent = `Petugas: ${username}`;
}

async function login(event) {
    event.preventDefault();
    loginError.textContent = '';
    const button = event.currentTarget.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
        const { token, username } = await api('/api/checkin/staff/session', {
            method: 'POST',
            body: JSON.stringify({
                username: document.getElementById('staff-username').value,
                password: document.getElementById('staff-password').value,
            }),
        });
        sessionStorage.setItem(tokenKey, token);
        sessionStorage.setItem('invitation-checkin-user', username);
        showWorkspace(username);
    } catch (error) {
        loginError.textContent = error.message;
    } finally {
        button.disabled = false;
    }
}

async function handleScan(decodedText) {
    if (!active) {
        return;
    }
    active = false;
    try {
        await scanner.stop();
    } catch (error) {
        console.warn('Could not stop scanner after decode:', error);
    }

    try {
        let token = decodedText.trim();
        const match = token.match(/[#&?]t=([a-f0-9]{64})/i) || token.match(/([a-f0-9]{64})/i);
        if (match) {
            token = match[1];
        }

        const data = await api('/api/checkin/scan', {
            method: 'POST',
            body: JSON.stringify({ token }),
        });

        const paxNote = data.guest?.pax > 1 ? ` Rombongan ${data.guest.pax} orang.` : '';

        if (data.status === 'checked_in') {
            showResult('success', 'Check-in berhasil', `Tamu tercatat masuk.${paxNote}`, data.guest.name);
        } else if (data.status === 'already_checked_in') {
            const time = data.checked_in_at ? new Date(data.checked_in_at).toLocaleTimeString('id-ID') : '';
            const detail = (time ? `Sudah check-in pukul ${time}.` : 'Tiket ini sudah pernah dipakai.') + paxNote;
            showResult('error', 'QR sudah digunakan', detail, data.guest.name);
        } else if (data.status === 'revoked') {
            showResult('error', 'Undangan dicabut', 'Hubungi admin acara.', data.guest?.name || '');
        } else {
            showResult('error', 'QR tidak valid', 'Tidak ditemukan di daftar undangan.');
        }
    } catch (error) {
        if (/401|Unauthorized|Token/i.test(error.message)) {
            sessionStorage.removeItem(tokenKey);
            sessionStorage.removeItem('invitation-checkin-user');
            workspace.hidden = true;
            loginPanel.hidden = false;
            loginError.textContent = 'Sesi petugas berakhir. Silakan masuk lagi.';
        } else {
            showResult('error', 'Gagal memeriksa QR', error.message);
        }
    }

    startButton.hidden = true;
    nextButton.hidden = false;
}

async function startCamera() {
    startButton.disabled = true;
    try {
        await scanner.start(
            { facingMode: 'environment' },
            { fps: 10, qrbox: { width: 250, height: 250 }, aspectRatio: 1 },
            handleScan,
            () => undefined
        );
        active = true;
        startButton.hidden = true;
        nextButton.hidden = true;
        showResult('', 'Siap scan', 'Arahkan kamera ke QR undangan.');
    } catch (error) {
        showResult('error', 'Kamera tidak tersedia', error.message || 'Izinkan akses kamera lalu coba lagi.');
        startButton.hidden = false;
    } finally {
        startButton.disabled = false;
    }
}

async function logout() {
    if (active) {
        try {
            await scanner.stop();
        } catch (error) {
            console.warn('Could not stop scanner on logout:', error);
        }
        active = false;
    }
    sessionStorage.removeItem(tokenKey);
    sessionStorage.removeItem('invitation-checkin-user');
    workspace.hidden = true;
    loginPanel.hidden = false;
}

document.getElementById('staff-login-form').addEventListener('submit', login);
startButton.addEventListener('click', startCamera);
nextButton.addEventListener('click', startCamera);
document.getElementById('staff-logout').addEventListener('click', logout);

const storedToken = sessionStorage.getItem(tokenKey);
if (storedToken) {
    showWorkspace(sessionStorage.getItem('invitation-checkin-user') || 'Petugas');
} else {
    loginPanel.hidden = false;
}
