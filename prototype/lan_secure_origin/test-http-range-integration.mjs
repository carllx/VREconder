import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { streamVideo } from './src/media/video-streamer.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const testFile = path.join(__dirname, 'test_dummy_stream.mp4');
fs.writeFileSync(testFile, Buffer.alloc(1000, 0x42));

const server = http.createServer((req, res) => {
  streamVideo(req, res, testFile);
});

async function runTest() {
  await new Promise(resolve => server.listen(8999, '127.0.0.1', resolve));

  function request(headers) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: 8999,
        path: '/',
        method: 'GET',
        headers
      }, (res) => {
        let len = 0;
        res.on('data', chunk => { len += chunk.length; });
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            receivedBytes: len
          });
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  try {
    console.log('=== RUNNING REAL HTTP RANGE INTEGRATION SMOKE TESTS ===\n');

    // Case 1: bytes=0-1
    const r1 = await request({ range: 'bytes=0-1' });
    assert.equal(r1.status, 206, 'Case 1 status should be 206');
    assert.equal(r1.headers['content-range'], 'bytes 0-1/1000', 'Content-Range 0-1');
    assert.equal(r1.headers['content-length'], '2', 'Content-Length 2');
    assert.equal(r1.receivedBytes, 2, 'Received bytes 2');
    console.log('⛓ Case 1 PASS: bytes=0-1 returned status 206, Content-Range: bytes 0-1/1000, Content-Length: 2');

    // Case 2: open-ended range bytes=500-
    const r2 = await request({ range: 'bytes=500-' });
    assert.equal(r2.status, 206, 'Case 2 status should be 206');
    assert.equal(r2.headers['content-range'], 'bytes 500-999/1000', 'Content-Range 500-999');
    assert.equal(r2.headers['content-length'], '500', 'Content-Length 500');
    assert.equal(r2.receivedBytes, 500, 'Received bytes 500');
    console.log('✓ Case 2 PASS: bytes=500- returned status 206, Content-Range: bytes 500-999/1000, Content-Length: 500');

    // Case 3: suffix range bytes=-200
    const r3 = await request({ range: 'bytes=-200' });
    assert.equal(r3.status, 206, 'Case 3 status should be 206');
    assert.equal(r3.headers['content-range'], 'bytes 800-999/1000', 'Content-Range 800-999');
    assert.equal(r3.headers['content-length'], '200', 'Content-Length 200');
    assert.equal(r3.receivedBytes, 200, 'Received bytes 200');
    console.log('✓ Case 3 PASS: bytes=-200 returned status 206, Content-Range: bytes 800-999/1000, Content-Length: 200');

    // Case 4: unsatisfiable range bytes=1000-
    const r4 = await request({ range: 'bytes=1000-' });
    assert.equal(r4.status, 416, 'Case 4 status should be 416');
    assert.equal(r4.headers['content-range'], 'bytes */1000', 'Content-Range */1000');
    console.log('⛓ Case 4 PASS: bytes=1000- returned status 416, Content-Range: bytes */1000');

    console.log('\nALL REAL HTTP RANGE INTEGRATION SMOKE TESTS PASSED!');
  } finally {
    server.close();
    try { fs.unlinkSync(testFile); } catch(e) {}
  }
}

runTest().catch(err => {
  console.error(err);
  process.exit(1);
});
