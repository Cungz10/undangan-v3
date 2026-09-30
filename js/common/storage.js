export const storage = (table) => {

    /**
     * @param {string|null} [key=null]
     * @returns {any}
     */
    const get = (key = null) => {
        const raw = localStorage.getItem(table);
        let data = null;

        try {
            data = JSON.parse(raw);
        } catch {
            data = null;
        }

        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            data = {};
            if (table === 'theme' && (raw === 'light' || raw === 'dark')) {
                data.active = raw;
            }
            localStorage.setItem(table, JSON.stringify(data));
        }

        return key ? data[String(key)] : data;
    };

    /**
     * @param {string} key
     * @param {any} value
     * @returns {void}
     */
    const set = (key, value) => {
        const data = get();
        data[String(key)] = value;
        localStorage.setItem(table, JSON.stringify(data));
    };

    /**
     * @param {string} key
     * @returns {boolean}
     */
    const has = (key) => {
        const data = get();
        return Boolean(data && Object.prototype.hasOwnProperty.call(data, String(key)));
    };

    /**
     * @param {string} key
     * @returns {void}
     */
    const unset = (key) => {
        if (!has(key)) {
            return;
        }

        const data = get();
        delete data[String(key)];
        localStorage.setItem(table, JSON.stringify(data));
    };

    /**
     * @returns {void}
     */
    const clear = () => localStorage.setItem(table, '{}');

    // Ensure valid storage table exists and is valid JSON
    get();

    return {
        set,
        get,
        has,
        clear,
        unset,
    };
};