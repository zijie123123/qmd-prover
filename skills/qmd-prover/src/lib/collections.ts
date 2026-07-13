export function uniqueSorted<T>(values: Iterable<T>, compare?: (left: T, right: T) => number): T[] {
  const unique = [...new Set(values)];
  return compare ? unique.sort(compare) : unique.sort() as T[];
}

export function indexBy<T, K>(values: Iterable<T>, key: (value: T) => K): Map<K, T> {
  return new Map([...values].map((value) => [key(value), value]));
}

export function pushToMap<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const values = map.get(key);
  if (values) values.push(value);
  else map.set(key, [value]);
}
