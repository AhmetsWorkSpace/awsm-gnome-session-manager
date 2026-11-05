// A fuzzy match is accepted only when one candidate has a distinctive,
// shared title prefix. Ambiguous results are left for the timeout fallback.
export function selectTitleMatch(title, records, allowFuzzy = true) {
    if (typeof title !== 'string' || !title.trim()) return null;
    const exact = records.find(record => record.window_title === title);
    if (exact) return {record: exact, matchType: 'EXACT'};
    if (!allowFuzzy) return null;
    const normalize = value => (value ?? '').normalize('NFKC').toLocaleLowerCase()
        .replace(/[\p{N}]+/gu, ' ').replace(/[^\p{L}]+/gu, ' ').trim().replace(/\s+/g, ' ');
    const text = normalize(title);
    if (!text) return null;
    const candidates = records.filter(record => {
        const saved = normalize(record.window_title);
        let length = 0;
        while (length < text.length && length < saved.length && text[length] === saved[length]) length++;
        const prefix = text.slice(0, length).trim();
        return prefix.length >= 12 && prefix.split(' ').filter(word => word.length >= 3).length >= 2;
    });
    return candidates.length === 1 ? {record: candidates[0], matchType: 'FUZZY_SUBSTRING'} : null;
}
