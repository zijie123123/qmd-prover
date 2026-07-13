export function uniqueSorted(values, compare) {
    const unique = [...new Set(values)];
    return compare ? unique.sort(compare) : unique.sort();
}
export function indexBy(values, key) {
    return new Map([...values].map((value) => [key(value), value]));
}
export function pushToMap(map, key, value) {
    const values = map.get(key);
    if (values)
        values.push(value);
    else
        map.set(key, [value]);
}
