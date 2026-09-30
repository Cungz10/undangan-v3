/**
 * List of bad words to filter from comments (basic Indonesian + English).
 */
const badWords = [
    'anjing', 'bangsat', 'babi', 'kontol', 'memek', 'ngentot', 'tolol',
    'goblok', 'idiot', 'bajingan', 'keparat', 'brengsek', 'setan',
    'fuck', 'shit', 'damn', 'bitch', 'asshole', 'bastard', 'dick',
    'pussy', 'cunt', 'whore', 'slut', 'penis', 'vagina',
];

/**
 * Check if text contains bad words.
 * @param {string} text
 * @returns {boolean}
 */
function containsBadWords(text) {
    if (!text) return false;
    const lower = text.toLowerCase();
    return badWords.some((word) => lower.includes(word));
}

/**
 * Filter bad words from text by replacing with asterisks.
 * @param {string} text
 * @returns {string}
 */
function filterBadWords(text) {
    if (!text) return text;
    let filtered = text;
    badWords.forEach((word) => {
        const regex = new RegExp(word, 'gi');
        filtered = filtered.replace(regex, '*'.repeat(word.length));
    });
    return filtered;
}

module.exports = {
    containsBadWords,
    filterBadWords,
};
