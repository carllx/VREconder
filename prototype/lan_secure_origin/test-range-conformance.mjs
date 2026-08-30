import assert from 'node:assert';
import { parseByteRange } from './src/media/video-streamer.mjs';

console.log('--- Running HTTP Range Conformance Tests ---');

const fileSize = 1000;

// Test 1: bytes=0-1 -> 206, exactly 2 bytes
{
  const res = parseByteRange('bytes=0-1', fileSize);
  assert.strictEqual(res.type, 'single');
  assert.strictEqual(res.start, 0);
  assert.strictEqual(res.end, 1);
  assert.strictEqual(res.contentLength, 2);
  console.log('✔ Test 1 PASS: bytes=0-1 served exactly 2 bytes');
}

// Test 2: bytes=100- -> 206, byte 100 through EOF (999)
{
  const res = parseByteRange('bytes=100-', fileSize);
  assert.strictEqual(res.type, 'single');
  assert.strictEqual(res.start, 100);
  assert.strictEqual(res.end, 999);
  assert.strictEqual(res.contentLength, 900);
  console.log('✔ Test 2 PASS: bytes=100- served through EOF (999)');
}

// Test 3: bytes=100-199 -> 206, exactly 100 bytes
{
  const res = parseByteRange('bytes=100-199', fileSize);
  assert.strictEqual(res.type, 'single');
  assert.strictEqual(res.start, 100);
  assert.strictEqual(res.end, 199);
  assert.strictEqual(res.contentLength, 100);
  console.log('✔ Test 3 PASS: bytes=100-199 served exactly 100 bytes');
}

// Test 4: valid start with requested end >= fileSize -> clamp to fileSize - 1, 206 (NOT 416)
{
  const res = parseByteRange('bytes=100-5000', fileSize);
  assert.strictEqual(res.type, 'single');
  assert.strictEqual(res.start, 100);
  assert.strictEqual(res.end, 999);
  assert.strictEqual(res.contentLength, 900);
  console.log('✔ Test 4 PASS: bytes=100-5000 clamped to EOF without 416 error');
}

// Test 5: start >= fileSize -> 416 unsatisfiable
{
  const res = parseByteRange('bytes=1000-', fileSize);
  assert.strictEqual(res.type, 'unsatisfiable');
  assert.strictEqual(res.start, 1000);
  console.log('✔ Test 5 PASS: bytes=1000- returns unsatisfiable (416)');
}

// Test 6: suffix: bytes=-500 -> final 500 bytes (500-999)
{
  const res = parseByteRange('bytes=-500', fileSize);
  assert.strictEqual(res.type, 'single');
  assert.strictEqual(res.start, 500);
  assert.strictEqual(res.end, 999);
  assert.strictEqual(res.contentLength, 500);
  console.log('✔ Test 6 PASS: bytes=-500 served final 500 bytes');
}

// Suffix larger than fileSize -> clamp to whole file (0-999)
{
  const res = parseByteRange('bytes=-2000', fileSize);
  assert.strictEqual(res.type, 'single');
  assert.strictEqual(res.start, 0);
  assert.strictEqual(res.end, 999);
  assert.strictEqual(res.contentLength, 1000);
  console.log('✔ Test 6b PASS: bytes=-2000 clamped to entire file');
}

// Test 7: invalid / NaN / start > end -> deterministic safe handling
{
  const res1 = parseByteRange('bytes=abc-def', fileSize);
  assert.strictEqual(res1.type, 'invalid');

  const res2 = parseByteRange('bytes=500-100', fileSize);
  assert.strictEqual(res2.type, 'invalid');

  const res3 = parseByteRange('not-a-range', fileSize);
  assert.strictEqual(res3.type, 'invalid');
  console.log('✔ Test 7 PASS: invalid/NaN/start>end rejected safely');
}

// Test 8: multiple ranges -> explicit detection
{
  const res = parseByteRange('bytes=0-10, 20-30', fileSize);
  assert.strictEqual(res.type, 'multiple');
  console.log('✔ Test 8 PASS: multiple ranges detected explicitly');
}

console.log('\nALL 8 HTTP RANGE CONFORMANCE TESTS PASSED DETERMINISTICALLY!\n');