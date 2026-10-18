export function formatCategoryName(name) {
    if (!name) return '';
    return String(name)
        .replace(/_/g, ' ')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .replace(/\b\w/g, c => c.toUpperCase());
}
