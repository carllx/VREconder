import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RANGE_LOG_PATH = path.join(__dirname, '..', '..', 'range_diagnostics.log');

let reqCounter = 0;
let activeStreamCount = 0;

export function parseByteRange(rangeHeader, fileSize) {
  if (!rangeHeader || typeof rangeHeader !== 'string') {
    return { type: 'none' };
  }

  const match = rangeHeader.trim().match(/^bytes=(.+)$/i);
  if (!match) {
    return { type: 'invalid', error: 'Malformed Range prefix' };
  }

  const rangeSet = match[1].trim();
  if (rangeSet.includes(',')) {
    return { type: 'multiple', raw: rangeSet };
  }

  // Suffix range: bytes=-500
  if (rangeSet.startsWith('-')) {
    const suffixLength = parseInt(rangeSet.slice(1), 10);
    if (isNaN(suffixLength) || suffixLength <= 0) {
      return { type: 'invalid', error: 'Invalid suffix length' };
    }
    if (fileSize === 0) {
      return { type: 'unsatisfiable', start: 0, end: 0, fileSize };
    }
    const len = Math.min(suffixLength, fileSize);
    const start = fileSize - len;
    const end = fileSize - 1;
    return { type: 'single', start, end, contentLength: len };
  }

  const parts = rangeSet.split('-');
  if (parts.length !== 2) {
    return { type: 'invalid', error: 'Invalid range parts' };
  }

  const startStr = parts[0].trim();
  const endStr = parts[1].trim();
  const start = parseInt(startStr, 10);

  if (isNaN(start) || start < 0) {
    return { type: 'invalid', error: 'Invalid range start' };
  }

  if (start >= fileSize) {
    return { type: 'unsatisfiable', start, end: -1, fileSize };
  }

  let end;
  if (endStr === '') {
    end = fileSize - 1;
  } else {
    end = parseInt(endStr, 10);
    if (isNaN(end) || end < start) {
      return { type: 'invalid', error: 'Invalid range end' };
    }
    if (end >= fileSize) {
      end = fileSize - 1;
    }
  }

  const contentLength = (end - start) + 1;
  return { type: 'single', start, end, contentLength };
}

function logRangeDiagnostic(entry) {
  try {
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(RANGE_LOG_PATH, line, 'utf8');
  } catch (err) {}
}

export function streamVideo(req, res, filePath) {
  const reqId = ++reqCounter;
  const startTime = Date.now();
  const rawRange = req.headers.range || null;
  const clientIp = req.socket.remoteAddress;

  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Video file not found: ' + filePath);
    logRangeDiagnostic({
      reqId, timestamp: new Date().toISOString(), clientIp, filePath, method: req.method,
      status: 404, error: 'File not found', durationMs: Date.now() - startTime
    });
    return;
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;

  if (req.method === 'HEAD') {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*'
    });
    res.end();
    logRangeDiagnostic({
      reqId, timestamp: new Date().toISOString(), clientIp, filePath, method: 'HEAD',
      status: 200, fileSize, durationMs: Date.now() - startTime
    });
    return;
  }

  const rangeParsed = parseByteRange(rawRange, fileSize);

  if (rangeParsed.type === 'multiple' || rangeParsed.type === 'invalid' || rangeParsed.type === 'unsatisfiable') {
    res.writeHead(416, {
      'Content-Range': `bytes */${fileSize}`,
      'Content-Type': 'video/mp4',
      'Access-Control-Allow-Origin': '*'
    });
    res.end();
    logRangeDiagnostic({
      reqId, timestamp: new Date().toISOString(), clientIp, filePath, method: req.method,
      rawRange, rangeParsed, status: 416, fileSize, durationMs: Date.now() - startTime
    });
    return;
  }

  let statusCode = 200;
  let headers = {
    'Accept-Ranges': 'bytes',
    'Content-Type': 'video/mp4',
    'Access-Control-Allow-Origin': '*'
  };

  let readStart = 0;
  let readEnd = fileSize - 1;

  if (rangeParsed.type === 'single') {
    statusCode = 206;
    readStart = rangeParsed.start;
    readEnd = rangeParsed.end;
    headers['Content-Range'] = `bytes ${readStart}-${readEnd}/${fileSize}`;
    headers['Content-Length'] = rangeParsed.contentLength;
  } else {
    // No range header provided
    statusCode = 200;
    headers['Content-Length'] = fileSize;
  }

  res.writeHead(statusCode, headers);

  activeStreamCount++;
  let bytesSent = 0;
  let streamDestroyed = false;

  const fileStream = fs.createReadStream(filePath, { start: readStart, end: readEnd });

  fileStream.on('data', (chunk) => {
    bytesSent += chunk.length;
  });

  const cleanup = (reason) => {
    if (!streamDestroyed) {
      streamDestroyed = true;
      activeStreamCount = Math.max(0, activeStreamCount - 1);
      fileStream.destroy();
    }
  };

  fileStream.on('error', (err) => {
    cleanup('stream_error');
    logRangeDiagnostic({
      reqId, timestamp: new Date().toISOString(), clientIp, filePath, method: req.method,
      statusCode, readStart, readEnd, bytesSent, activeStreams: activeStreamCount,
      event: 'stream_error', error: err.message, durationMs: Date.now() - startTime
    });
  });

  res.on('finish', () => {
    cleanup('finished');
    logRangeDiagnostic({
      reqId, timestamp: new Date().toISOString(), clientIp, filePath, method: req.method,
      rawRange, statusCode, readStart, readEnd, totalServed: bytesSent,
      activeStreams: activeStreamCount, event: 'finish', durationMs: Date.now() - startTime
    });
  });

  res.on('close', () => {
    const isAborted = !res.writableEnded;
    cleanup(isAborted ? 'aborted' : 'closed');
    if (isAborted) {
      logRangeDiagnostic({
        reqId, timestamp: new Date().toISOString(), clientIp, filePath, method: req.method,
        rawRange, statusCode, readStart, readEnd, bytesSent, activeStreams: activeStreamCount,
        event: 'aborted_close', durationMs: Date.now() - startTime
      });
    }
  });

  req.on('aborted', () => {
    cleanup('req_aborted');
  });

  fileStream.pipe(res);
}
