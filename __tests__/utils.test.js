'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { sanitizeName, checkCreateDir, readFile } = require('../lib/reactor-core/utils');

// ─── sanitizeName ─────────────────────────────────────────────────────────────

describe('sanitizeName', () => {
    test('strips characters unsafe for file systems', () => {
        expect(sanitizeName('Hello/World')).toBe('HelloWorld');
        expect(sanitizeName('Rule: "My Rule"')).toBe('Rule My Rule');
        expect(sanitizeName('Rule<>|?*')).toBe('Rule');
    });

    test('keeps alphanumerics, spaces and hyphens', () => {
        expect(sanitizeName('My-Rule 123')).toBe('My-Rule 123');
    });

    test('trims leading/trailing whitespace', () => {
        expect(sanitizeName('  padded name  ')).toBe('padded name');
    });

    test('empty string returns empty string', () => {
        expect(sanitizeName('')).toBe('');
    });

    test('string with only special chars returns empty string', () => {
        expect(sanitizeName('!@#$%^&*()')).toBe('');
    });

    test('unicode characters are stripped', () => {
        expect(sanitizeName('Rüle')).toBe('Rle');
    });
});

// ─── checkCreateDir ───────────────────────────────────────────────────────────

describe('checkCreateDir', () => {
    let tmpBase;

    beforeEach(() => {
        tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-test-'));
    });

    afterEach(() => {
        fs.rmSync(tmpBase, { recursive: true, force: true });
    });

    test('creates directory if it does not exist', () => {
        const target = path.join(tmpBase, 'new-dir');
        expect(fs.existsSync(target)).toBe(false);
        checkCreateDir(target);
        expect(fs.existsSync(target)).toBe(true);
    });

    test('creates nested directories recursively', () => {
        const target = path.join(tmpBase, 'a', 'b', 'c');
        checkCreateDir(target);
        expect(fs.existsSync(target)).toBe(true);
    });

    test('does not throw if directory already exists', () => {
        expect(() => checkCreateDir(tmpBase)).not.toThrow();
    });
});

// ─── readFile ─────────────────────────────────────────────────────────────────

describe('readFile', () => {
    let tmpBase;

    beforeEach(() => {
        tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-test-'));
    });

    afterEach(() => {
        fs.rmSync(tmpBase, { recursive: true, force: true });
    });

    test('reads and parses a valid JSON file', () => {
        const filePath = path.join(tmpBase, 'data.json');
        const data = { id: 'RL1', name: 'Test Rule' };
        fs.writeFileSync(filePath, JSON.stringify(data));
        expect(readFile(filePath)).toEqual(data);
    });

    test('throws an error if file does not exist', () => {
        const filePath = path.join(tmpBase, 'missing.json');
        expect(() => readFile(filePath)).toThrow(/does not exist/);
    });

    test('throws a SyntaxError for invalid JSON', () => {
        const filePath = path.join(tmpBase, 'bad.json');
        fs.writeFileSync(filePath, 'not-valid-json');
        expect(() => readFile(filePath)).toThrow(SyntaxError);
    });
});
