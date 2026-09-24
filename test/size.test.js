import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULTS, LEVEL, describe, levelOf, sessionSeq } from '../src/size.js';

test('默认阈值来自实测标定，且危险线高于提醒线', () => {
  assert.equal(DEFAULTS.warnSeq, 40_000);
  assert.equal(DEFAULTS.dangerSeq, 80_000);
  assert.ok(DEFAULTS.dangerSeq > DEFAULTS.warnSeq);
  assert.ok(DEFAULTS.minGrowthSeq > 0, '反抖动必须有正的最小增长量');
});

test('levelOf 分级覆盖边界值', () => {
  assert.equal(levelOf(0), LEVEL.OK);
  assert.equal(levelOf(DEFAULTS.warnSeq - 1), LEVEL.OK);
  assert.equal(levelOf(DEFAULTS.warnSeq), LEVEL.WARN);
  assert.equal(levelOf(DEFAULTS.dangerSeq - 1), LEVEL.WARN);
  assert.equal(levelOf(DEFAULTS.dangerSeq), LEVEL.DANGER);
  assert.equal(levelOf(516_712), LEVEL.DANGER); // 本机实测的真实规模
});

test('levelOf 对未知 seq 一律 OK：信息不足时绝不动别人的会话', () => {
  for (const bad of [undefined, null, NaN, Infinity, '123', {}]) {
    assert.equal(levelOf(bad), LEVEL.OK, `seq=${String(bad)} 应为 OK`);
  }
});

test('sessionSeq 只接受有限数', () => {
  assert.equal(sessionSeq({ seq: 0 }), 0);
  assert.equal(sessionSeq({ seq: 123 }), 123);
  assert.equal(sessionSeq({ seq: NaN }), null);
  assert.equal(sessionSeq({ seq: undefined }), null);
  assert.equal(sessionSeq(null), null);
  assert.equal(sessionSeq(undefined), null);
});

test('describe 给出可读分级，未知规模不伪装成正常', () => {
  assert.match(describe(10), /正常/);
  assert.match(describe(50_000), /提醒/);
  assert.match(describe(200_000), /危险/);
  assert.equal(describe(undefined), 'seq=?');
});
