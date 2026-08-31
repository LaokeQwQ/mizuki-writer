import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { renderSafeMarkdown } from '../lib/markdown.js';
import { parseArrayLiteral } from '../lib/safe-literal.js';
import { getClientIp, parsePage, parsePageSize } from '../lib/http.js';
import { findPostFilePath, sanitizeSlug } from '../routes/posts.js';

test('safe markdown escapes raw HTML and removes dangerous links', () => {
    const html = renderSafeMarkdown([
        '<script>alert(1)</script>',
        '[danger](javascript:alert(1))',
        '[obfuscated](java\tscript:alert(1))',
        '[credentials](https://user:pass@example.com)',
        '[safe](https://example.com)',
        '![bad](javascript:alert(1))',
    ].join('\n\n'));

    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(html, /javascript:/i);
    assert.match(html, /href="https:\/\/example\.com"/);
    assert.doesNotMatch(html, /<script/i);
});

test('safe literal parser accepts data literals without executing code', () => {
    const value = parseArrayLiteral(`[
        // comments are allowed in existing data files
        { id: 1, title: 'First', active: true, tags: ['a', 'b'], missing: undefined },
    ]`);

    assert.equal(value.length, 1);
    assert.equal(value[0].title, 'First');
    assert.deepEqual(value[0].tags, ['a', 'b']);
    assert.equal(value[0].missing, undefined);
    assert.throws(() => parseArrayLiteral('[process.exit(1)]'), /不支持的数据值|标识符格式无效/);
});

test('request helpers apply bounded pagination and use configured client IP', () => {
    assert.equal(getClientIp({ ip: '127.0.0.1', socket: { remoteAddress: '10.0.0.1' } }), '127.0.0.1');
    assert.equal(getClientIp({ socket: { remoteAddress: '10.0.0.1' } }), '10.0.0.1');
    assert.equal(parsePage('-1', 2), 2);
    assert.equal(parsePage('not-a-page', 3), 3);
    assert.equal(parsePage('1abc', 3), 3);
    assert.equal(parsePage('999999999999999999999', 4), 4);
    assert.equal(parsePageSize('1000', 30, 100), 100);
    assert.equal(parsePageSize('0', 30, 100), 30);
    assert.equal(parsePageSize('1abc', 30, 100), 30);
});

test('post slugs cannot escape the posts directory', () => {
    assert.equal(sanitizeSlug('../secrets'), null);
    assert.equal(sanitizeSlug('/absolute/path'), null);
    assert.equal(sanitizeSlug('nested//post'), null);
    assert.equal(sanitizeSlug('nested/post'), 'nested/post');
    assert.equal(sanitizeSlug('a'.repeat(257)), null);
});

test('post lookup rejects symlinked files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-writer-'));
    try {
        const postsDir = path.join(root, 'posts');
        const outsidePath = path.join(root, 'outside.md');
        fs.mkdirSync(postsDir);
        fs.writeFileSync(outsidePath, 'private');
        fs.symlinkSync(outsidePath, path.join(postsDir, 'linked.md'));

        assert.equal(findPostFilePath(postsDir, 'linked'), null);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
