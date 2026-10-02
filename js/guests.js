import QRCode from 'qrcode';
import { renderCard, canvasToBytes, downloadBlob } from './common/qrcard.js';
import { buildZip } from './common/zip.js';
import { parseGuestText, markDuplicates, hasError, hasWarn, buildGuestCsv, cardFileName, rowKey } from './common/guestImport.js';

const tokenKey = 'invitation-admin-token';
const loginPanel = document.getElementById('admin-login');
const manager = document.getElementById('guest-manager');
const guestList = document.getElementById('guest-list');
const message = document.getElementById('guest-message');
const qrPanel = document.getElementById('qr-print');

const BULK_CHUNK = 50; // must match backend/routes/checkin.js BULK_MAX

const apiUrl = (path) => new URL(path, document.body.getAttribute('data-url') || `${window.location.origin}/`);

/** Base URL of the invitation site itself (guests.html lives next to index.html). */
const inviteBaseUrl = () => new URL('./', window.location.href);

/** @param {string} token */
function inviteLink(token) {
    const url = inviteBaseUrl();
    url.hash = `t=${token}`;
    return url.toString();
}

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

function setLoginError(text) {
    document.getElementById('login-error').textContent = text;
}

function setGuestMessage(text, isError = false) {
    message.textContent = text;
    message.classList.toggle('error-message', isError);
}

function parsePaxInput(el) {
    const raw = el.value.trim();
    if (raw === '') {return undefined;}
    return Number(raw);
}

async function showQr(guest, token) {
    document.getElementById('qr-guest-name').textContent = guest.name;
    document.getElementById('qr-group-name').textContent = guest.group_name || 'Undangan perorangan';
    qrPanel.hidden = false;
    await QRCode.toCanvas(document.getElementById('qr-canvas'), token, {
        width: 280,
        margin: 2,
        errorCorrectionLevel: 'H',
        color: { dark: '#18211d', light: '#ffffff' },
    });
    qrPanel.dataset.token = token;
    qrPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function actionButton(label, className, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = label;
    button.addEventListener('click', onClick);
    return button;
}

function guestStatus(guest) {
    const status = document.createElement('span');
    status.className = 'guest-status';
    if (guest.revoked_at) {
        status.classList.add('revoked');
        status.textContent = 'Dicabut';
    } else if (guest.checked_in_at) {
        status.classList.add('checked');
        status.textContent = 'Sudah masuk';
    } else {
        status.textContent = 'Belum hadir';
    }
    return status;
}

async function copyToClipboard(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        return false; // clipboard API unavailable (e.g. insecure context) - caller shows the link instead
    }
}

let cachedGuests = [];

function renderGuestList() {
    guestList.replaceChildren();
    
    const query = (document.getElementById('search-guest')?.value || '').toLowerCase();
    const filtered = cachedGuests.filter(g => 
        g.name.toLowerCase().includes(query) || 
        (g.group_name && g.group_name.toLowerCase().includes(query))
    );

    document.getElementById('guest-count').textContent = `${cachedGuests.length} tamu terdaftar`;
    const emptyState = document.getElementById('empty-state');
    emptyState.hidden = filtered.length > 0;
    
    if (filtered.length === 0 && cachedGuests.length > 0) {
        emptyState.textContent = 'Tidak ada tamu yang cocok dengan pencarian.';
        emptyState.hidden = false;
    } else if (cachedGuests.length === 0) {
        emptyState.textContent = 'Belum ada tamu. Tambahkan nama untuk menerbitkan QR.';
        emptyState.hidden = false;
    }

    filtered.forEach((guest) => {
        const row = document.createElement('tr');
        const nameCell = document.createElement('td');
        const groupCell = document.createElement('td');
        const paxCell = document.createElement('td');
        const statusCell = document.createElement('td');
        const actionCell = document.createElement('td');
        const actions = document.createElement('div');
        nameCell.textContent = guest.name;
        groupCell.textContent = guest.group_name || '-';
        paxCell.textContent = String(guest.pax ?? 1);
        statusCell.appendChild(guestStatus(guest));
        actions.className = 'row-actions d-flex justify-content-end gap-1 flex-wrap';

        if (guest.checked_in_at) {
            const checkinTime = document.createElement('small');
            checkinTime.className = 'd-block text-secondary mt-1';
            checkinTime.textContent = new Date(guest.checked_in_at).toLocaleString('id-ID');
            statusCell.appendChild(checkinTime);
        }

        if (guest.token && !guest.checked_in_at) {
            actions.appendChild(actionButton('Salin link', 'btn btn-outline-primary btn-sm', async (e) => {
                const ok = await copyToClipboard(inviteLink(guest.token));
                e.currentTarget.textContent = ok ? 'Tersalin!' : 'Gagal';
                setTimeout(() => { e.currentTarget.textContent = 'Salin link'; }, 1500);
            }));
            actions.appendChild(actionButton('Lihat QR', 'btn btn-outline-dark btn-sm', () => showQr(guest, guest.token)));
            
            actions.appendChild(actionButton('Kirim WA', 'btn btn-success btn-sm', () => {
                const text = `Halo ${guest.name},\n\nBerikut adalah link undangan dan tiket check-in acara pernikahan kami. Silakan buka link ini:\n${inviteLink(guest.token)}\n\nTerima kasih!`;
                window.open(`https://api.whatsapp.com/send?text=${encodeURIComponent(text)}`, '_blank');
            }));
        }

        if (!guest.checked_in_at) {
            const issueLabel = guest.needs_reissue ? 'Buat QR' : 'QR baru';
            actions.appendChild(actionButton(issueLabel, 'btn btn-outline-secondary btn-sm', async () => {
                if (!guest.needs_reissue && !window.confirm(`Terbitkan QR baru untuk ${guest.name}? QR/link sebelumnya akan tidak berlaku.`)) {
                    return;
                }
                try {
                    const result = await api(`/api/checkin/invitations/${guest.uuid}/rotate`, { method: 'POST' });
                    await showQr(result.guest, result.token);
                    setGuestMessage(`QR untuk ${guest.name} siap. Salin link atau unduh QR-nya.`);
                    await loadGuests();
                } catch (error) {
                    setGuestMessage(error.message, true);
                }
            }));

            if (!guest.revoked_at) {
                actions.appendChild(actionButton('Cabut', 'btn btn-outline-danger btn-sm', async () => {
                    if (!window.confirm(`Cabut undangan ${guest.name}?`)) {
                        return;
                    }
                    try {
                        await api(`/api/checkin/invitations/${guest.uuid}`, { method: 'DELETE' });
                        await loadGuests();
                    } catch (error) {
                        setGuestMessage(error.message, true);
                    }
                }));
            }
        }

        actionCell.className = 'text-end';
        actionCell.appendChild(actions);
        row.append(nameCell, groupCell, paxCell, statusCell, actionCell);
        guestList.appendChild(row);
    });
}

async function loadGuests() {
    guestList.replaceChildren();
    try {
        const { guests } = await api('/api/checkin/invitations');
        cachedGuests = guests;
        renderGuestList();
        return guests;
    } catch (error) {
        if (/401|Unauthorized|Token/i.test(error.message)) {
            sessionStorage.removeItem(tokenKey);
            manager.hidden = true;
            loginPanel.hidden = false;
            setLoginError('Sesi admin berakhir. Silakan masuk lagi.');
            return [];
        }
        setGuestMessage(error.message, true);
        return [];
    }
}

function showAdmin() {
    loginPanel.hidden = true;
    manager.hidden = false;
    loadGuests();
}

async function login(event) {
    event.preventDefault();
    setLoginError('');
    const button = event.currentTarget.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
        const { token } = await api('/api/session', {
            method: 'POST',
            body: JSON.stringify({
                email: document.getElementById('admin-email').value,
                password: document.getElementById('admin-password').value,
            }),
        });
        sessionStorage.setItem(tokenKey, token);
        showAdmin();
    } catch (error) {
        setLoginError(error.message);
    } finally {
        button.disabled = false;
    }
}

async function createGuest(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const button = document.getElementById('create-guest');
    button.disabled = true;
    setGuestMessage('Membuat undangan...');
    try {
        const result = await api('/api/checkin/invitations', {
            method: 'POST',
            body: JSON.stringify({
                name: document.getElementById('guest-name').value,
                group_name: document.getElementById('group-name').value,
                pax: parsePaxInput(document.getElementById('guest-pax')),
            }),
        });
        await showQr(result.guest, result.token);
        form.reset();
        setGuestMessage(`QR undangan ${result.guest.name} siap diunduh atau dicetak.`);
        await loadGuests();
    } catch (error) {
        setGuestMessage(error.message, true);
    } finally {
        button.disabled = false;
    }
}

// ---------------------------------------------------------------------------
// Impor massal
// ---------------------------------------------------------------------------

const bulkText = document.getElementById('bulk-text');
const bulkPreviewBtn = document.getElementById('bulk-preview');
const bulkImportBtn = document.getElementById('bulk-import');
const bulkMessage = document.getElementById('bulk-message');
const bulkPreviewWrap = document.getElementById('bulk-preview-wrap');
const bulkPreviewBody = document.getElementById('bulk-preview-body');
const bulkResults = document.getElementById('bulk-results');
const bulkResultsMessage = document.getElementById('bulk-results-message');

/** @type {ReturnType<typeof parseGuestText>} */
let currentPreview = [];
/** @type {{ guest: object, token: string }[]} */
let lastImportedWithTokens = [];

function renderPreview(rows) {
    bulkPreviewBody.replaceChildren();
    rows.forEach((row) => {
        const tr = document.createElement('tr');
        if (hasError(row)) {tr.className = 'table-danger';}
        else if (hasWarn(row)) {tr.className = 'table-warning';}

        const cells = [String(row.line), row.name || '(kosong)', row.group_name || '-', String(row.pax)];
        cells.forEach((text) => {
            const td = document.createElement('td');
            td.textContent = text;
            tr.appendChild(td);
        });

        const noteCell = document.createElement('td');
        noteCell.textContent = row.issues.map((i) => i.msg).join('; ');
        tr.appendChild(noteCell);

        bulkPreviewBody.appendChild(tr);
    });
    bulkPreviewWrap.hidden = rows.length === 0;
}

async function previewBulk() {
    const existing = await loadGuests();
    const existingKeys = existing.map((g) => rowKey(g.name, g.group_name || ''));
    currentPreview = markDuplicates(parseGuestText(bulkText.value), existingKeys);

    renderPreview(currentPreview);
    bulkResults.hidden = true;

    const importable = currentPreview.filter((r) => !hasError(r) && !hasWarn(r));
    if (currentPreview.length === 0) {
        bulkMessage.textContent = 'Tempel daftar tamu dulu di kotak teks.';
        bulkImportBtn.hidden = true;
        return;
    }
    const dupCount = currentPreview.filter((r) => !hasError(r) && hasWarn(r)).length;
    bulkMessage.textContent = dupCount > 0
        ? `${importable.length} dari ${currentPreview.length} baris siap diimpor (${dupCount} dobel akan dilewati).`
        : `${importable.length} dari ${currentPreview.length} baris siap diimpor.`;
    bulkImportBtn.hidden = importable.length === 0;
}

async function importBulk() {
    // Baris dengan warning (mis. nama dobel di roster/paste) di-skip demi keamanan:
    // dua tamu bernama sama tanpa disadari admin berarti dua QR untuk identitas yang
    // kelihatannya sama. Kalau memang dua orang berbeda, admin bisa tambah manual
    // lewat form satu-tamu (namanya boleh sama di situ, cuma di sini yang di-block).
    const valid = currentPreview.filter((r) => !hasError(r) && !hasWarn(r));
    const skippedDup = currentPreview.filter((r) => !hasError(r) && hasWarn(r)).length;
    if (valid.length === 0) {
        bulkMessage.textContent = skippedDup > 0
            ? `${skippedDup} baris dilewati karena terdeteksi dobel. Tidak ada yang diimpor.`
            : 'Tidak ada baris valid untuk diimpor.';
        return;
    }

    bulkImportBtn.disabled = true;
    lastImportedWithTokens = [];
    let done = 0;

    try {
        for (let i = 0; i < valid.length; i += BULK_CHUNK) {
            const chunk = valid.slice(i, i + BULK_CHUNK).map((r) => ({ name: r.name, group_name: r.group_name, pax: r.pax }));
            bulkMessage.textContent = `Mengimpor ${done + 1}-${done + chunk.length} dari ${valid.length}...`;
             
            const { guests } = await api('/api/checkin/invitations/bulk', { method: 'POST', body: JSON.stringify({ guests: chunk }) });
            lastImportedWithTokens.push(...guests);
            done += chunk.length;
        }

        bulkMessage.textContent = skippedDup > 0
            ? `${done} tamu berhasil diimpor. ${skippedDup} baris dilewati karena terdeteksi dobel.`
            : `${done} tamu berhasil diimpor.`;
        bulkText.value = '';
        currentPreview = [];
        bulkPreviewWrap.hidden = true;
        bulkImportBtn.hidden = true;

        bulkResultsMessage.textContent = `${done} QR siap diunduh sebagai ZIP, CSV link, atau lembar cetak.`;
        bulkResults.hidden = false;
        await loadGuests();
    } catch (error) {
        bulkMessage.textContent = `Impor terhenti setelah ${done} tamu: ${error.message}. Tamu yang sudah masuk tetap tersimpan.`;
    } finally {
        bulkImportBtn.disabled = false;
    }
}

async function downloadZip() {
    if (lastImportedWithTokens.length === 0) {return;}
    bulkResultsMessage.textContent = 'Menyiapkan ZIP...';
    const files = [];
    for (let i = 0; i < lastImportedWithTokens.length; i += 1) {
        const { guest, token } = lastImportedWithTokens[i];
         
        const canvas = await renderCard(token, { name: guest.name, subtitle: guest.pax > 1 ? `Rombongan ${guest.pax} orang` : (guest.group_name || '') });
        files.push({ name: cardFileName(guest.name, i), data: canvasToBytes(canvas) });
    }
    downloadBlob(new Blob([buildZip(files)], { type: 'application/zip' }), 'qr-tamu.zip');
    bulkResultsMessage.textContent = `${lastImportedWithTokens.length} QR siap diunduh sebagai ZIP, CSV link, atau lembar cetak.`;
}

function downloadCsv() {
    if (lastImportedWithTokens.length === 0) {return;}
    const rows = lastImportedWithTokens.map(({ guest, token }) => ({
        name: guest.name, group_name: guest.group_name || '', pax: guest.pax, link: inviteLink(token),
    }));
    downloadBlob(new Blob([buildGuestCsv(rows)], { type: 'text/csv;charset=utf-8' }), 'tamu-link.csv');
}

async function printSheet() {
    if (lastImportedWithTokens.length === 0) {return;}
    const container = document.getElementById('bulk-print-sheet');
    container.replaceChildren();

    for (let i = 0; i < lastImportedWithTokens.length; i += 1) {
        const { guest, token } = lastImportedWithTokens[i];
         
        const canvas = await renderCard(token, { name: guest.name, subtitle: guest.pax > 1 ? `Rombongan ${guest.pax} orang` : (guest.group_name || '') });
        const card = document.createElement('div');
        card.className = 'print-card';
        card.appendChild(canvas);
        container.appendChild(card);
    }

    container.hidden = false;
    window.print();
    container.hidden = true;
}

document.getElementById('login-form').addEventListener('submit', login);
document.getElementById('guest-form').addEventListener('submit', createGuest);
document.getElementById('refresh-guests').addEventListener('click', loadGuests);
document.getElementById('search-guest')?.addEventListener('input', renderGuestList);
document.getElementById('admin-logout').addEventListener('click', () => {
    sessionStorage.removeItem(tokenKey);
    manager.hidden = true;
    loginPanel.hidden = false;
});
document.getElementById('close-qr').addEventListener('click', () => { qrPanel.hidden = true; });
document.getElementById('print-qr').addEventListener('click', () => window.print());
document.getElementById('download-qr').addEventListener('click', () => {
    const link = document.createElement('a');
    link.download = `${document.getElementById('qr-guest-name').textContent.replace(/[^a-z0-9-_]+/gi, '-')}-qr.png`;
    link.href = document.getElementById('qr-canvas').toDataURL('image/png');
    link.click();
});

bulkPreviewBtn.addEventListener('click', previewBulk);
bulkImportBtn.addEventListener('click', importBulk);
document.getElementById('bulk-download-zip').addEventListener('click', downloadZip);
document.getElementById('bulk-download-csv').addEventListener('click', downloadCsv);
document.getElementById('bulk-print').addEventListener('click', printSheet);

if (sessionStorage.getItem(tokenKey)) {
    showAdmin();
} else {
    loginPanel.hidden = false;
}
