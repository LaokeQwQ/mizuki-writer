import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveTwikooAdminToken, getTwikooResponseError, toTwikooPage } from '../lib/twikoo.js';

test('Twikoo admin token is derived from the admin password', () => {
    assert.equal(deriveTwikooAdminToken('test'), '098f6bcd4621d373cade4e832627b4f6');
    assert.throws(() => deriveTwikooAdminToken(''), /未配置/);
});

test('Twikoo admin pagination is one-based while the admin UI is zero-based', () => {
    assert.equal(toTwikooPage(0), 1);
    assert.equal(toTwikooPage(1), 2);
    assert.equal(toTwikooPage(99), 100);
    assert.equal(toTwikooPage(-1), 1);
    assert.equal(toTwikooPage('not-a-page'), 1);
});

test('Twikoo business errors are detected even though HTTP status is 200', () => {
    assert.equal(getTwikooResponseError({ code: 0, data: [] }), null);
    assert.equal(getTwikooResponseError({ id: 'comment-id' }), null);
    assert.match(getTwikooResponseError({ code: 1003, message: '请先登录' }), /请先登录/);
    assert.match(getTwikooResponseError({ message: '密码错误' }), /密码错误/);
    assert.match(getTwikooResponseError(null), /响应无效/);
});
