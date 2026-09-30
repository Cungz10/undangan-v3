export const MAX_NAME = 100;
export const MAX_PAX = 50;

/**
 * Split one line on a delimiter, honouring "double quoted" cells (CSV style).
 * @param {string} line
 * @param {string} delimiter
 * @returns {string[]}
 */
export function splitLine(line, delimiter) {
    const cells = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (quoted) {
            if (ch === '"' && line[i + 1] === '"') {
                cur += '"';
                i += 1;
            } else if (ch === '"') {
                quoted = false;
            } else {
                cur += ch;
            }
        } else if (ch === '"' && cur.trim() === '') {
            quoted = true;
            cur = '';
        } else if (ch === delimiter) {
            cells.push(cur);
            cur = '';
        } else {
            cur += ch;
        }
    }
    cells.push(cur);
    return cells;
}

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
export const rowKey = (name, group) => `${clean(name).toLowerCase()}|${clean(group).toLowerCase()}`;

/**
 * Parse pasted text: one guest per line.
 *   Nama
 *   Nama <TAB|koma> Kelompok
 *   Nama <TAB|koma> Kelompok <TAB|koma> Jumlah orang
 * An optional header line ("Nama, Kelompok") is skipped.
 * @param {string} text
 * @returns {{ line: number, name: string, group_name: string, pax: number, issues: { level: 'error'|'warn', msg: string }[] }[]}
 */
export function parseGuestText(text) {
    const rows = [];
    const lines = String(text ?? '').split(/\r?\n/);
    let seenContent = false;

    lines.forEach((raw, idx) => {
        if (raw.trim() === '') {return;}

        const delimiter = raw.includes('\t') ? '\t' : ',';
        const cells = splitLine(raw, delimiter).map(clean);

        if (!seenContent) {
            seenContent = true;
            if (/^(nama|name)( tamu)?$/i.test(cells[0]) && (cells.length === 1 || /kelompok|group|keluarga|pax|jumlah/i.test(cells[1] || ''))) {
                return; // header row
            }
        }

        const name = cells[0] || '';
        const group_name = cells[1] || '';
        const paxRaw = cells[2] || '';
        const issues = [];
        let pax = 1;

        if (!name) {issues.push({ level: 'error', msg: 'Nama kosong' });}
        if (name.length > MAX_NAME) {issues.push({ level: 'error', msg: `Nama > ${MAX_NAME} karakter` });}
        if (group_name.length > MAX_NAME) {issues.push({ level: 'error', msg: `Kelompok > ${MAX_NAME} karakter` });}
        if (paxRaw !== '') {
            if (!/^\d{1,3}$/.test(paxRaw) || Number(paxRaw) < 1 || Number(paxRaw) > MAX_PAX) {
                issues.push({ level: 'error', msg: `Jumlah orang harus 1-${MAX_PAX}` });
            } else {
                pax = Number(paxRaw);
            }
        }

        rows.push({ line: idx + 1, name, group_name, pax, issues });
    });

    return rows;
}

/**
 * Add 'warn' issues for duplicates (inside the pasted list, or already in the roster).
 * @param {ReturnType<typeof parseGuestText>} rows
 * @param {Iterable<string>} existingKeys keys from rowKey()
 */
export function markDuplicates(rows, existingKeys = []) {
    const existing = new Set(existingKeys);
    const seen = new Set();
    for (const row of rows) {
        if (!row.name) {continue;}
        const key = rowKey(row.name, row.group_name);
        if (existing.has(key)) {row.issues.push({ level: 'warn', msg: 'Sudah ada di daftar tamu' });}
        else if (seen.has(key)) {row.issues.push({ level: 'warn', msg: 'Dobel di daftar ini' });}
        seen.add(key);
    }
    return rows;
}

export const hasError = (row) => row.issues.some((i) => i.level === 'error');
export const hasWarn = (row) => row.issues.some((i) => i.level === 'warn');

/** Quote a CSV cell and neutralise spreadsheet formulas (=, +, -, @, tab, CR). */
export function csvCell(value) {
    let s = String(value ?? '');
    if (/^[=+\-@\t\r]/.test(s)) {s = `'${s}`;}
    return `"${s.replace(/"/g, '""')}"`;
}

/**
 * @param {{ name: string, group_name: string, pax: number, link: string }[]} rows
 * @returns {string} CSV with UTF-8 BOM (Excel-friendly)
 */
export function buildGuestCsv(rows) {
    const lines = [['Nama', 'Kelompok', 'Pax', 'Link'].map(csvCell).join(',')];
    for (const r of rows) {
        lines.push([r.name, r.group_name, r.pax, r.link].map(csvCell).join(','));
    }
    return `\uFEFF${lines.join('\r\n')}`;
}

/** Unique, filesystem-safe PNG name: "001-Budi-Santoso.png". */
export function cardFileName(name, index) {
    const base = String(name ?? '')
        .normalize('NFKD')
        .replace(/[^\w\- ]+/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .slice(0, 40) || 'tamu';
    return `${String(index + 1).padStart(3, '0')}-${base}.png`;
}
