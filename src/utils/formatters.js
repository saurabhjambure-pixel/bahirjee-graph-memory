export function formatCategoryName(name) {
    if (!name) return '';
    return String(name)
        .replace(/_/g, ' ')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .replace(/\b\w/g, c => c.toUpperCase());
}

// One line of the "Notes on this brief" banner: what happened (reason), then what it means
// (impact). Showing only the impact hid which check failed — "Searched again and still found
// nothing" never said what was being searched for.
export function formatDegradationNote(d) {
    const reason = String(d?.reason || '').trim();
    const impact = String(d?.impact || '').trim();
    if (!reason || !impact || reason === impact) return reason || impact;
    return `${/[.!?]$/.test(reason) ? reason : `${reason}.`} ${impact}`;
}
