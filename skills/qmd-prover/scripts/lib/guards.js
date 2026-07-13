export function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function asRecord(value) {
    return isRecord(value) ? value : {};
}
export function asString(value, fallback = '') {
    return typeof value === 'string' ? value : fallback;
}
export function asStringArray(value) {
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}
export function asArray(value) {
    return Array.isArray(value) ? value : [];
}
