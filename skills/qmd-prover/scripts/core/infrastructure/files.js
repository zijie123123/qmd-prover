import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { asRecord, hasErrorCode } from '../shared/core.js';
export function sha256(value) {
    return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
export function stable(value) {
    if (Array.isArray(value))
        return value.map(stable);
    if (value && typeof value === 'object') {
        const record = asRecord(value);
        return Object.fromEntries(Object.keys(record).sort().map((key) => [key, stable(record[key])]));
    }
    return value;
}
export function stableJson(value, space = 2) {
    return `${JSON.stringify(stable(value), null, space)}\n`;
}
export async function exists(file) {
    try {
        await stat(file);
        return true;
    }
    catch (error) {
        if (hasErrorCode(error, 'ENOENT'))
            return false;
        throw error;
    }
}
export async function readJson(file, fallback) {
    try {
        return JSON.parse(await readFile(file, 'utf8'));
    }
    catch (error) {
        if (hasErrorCode(error, 'ENOENT') && fallback !== undefined)
            return fallback;
        throw error;
    }
}
export async function atomicWrite(file, data) {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, data);
    await rename(temporary, file);
}
export async function atomicJson(file, value) {
    await atomicWrite(file, stableJson(value));
}
export function relativePosix(root, file) {
    return path.relative(root, file).split(path.sep).join('/');
}
export function cleanId(value) {
    return value.startsWith('@') ? value.slice(1) : value;
}
export function newId(prefix) {
    return `${prefix}-${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${randomUUID().slice(0, 8)}`;
}
