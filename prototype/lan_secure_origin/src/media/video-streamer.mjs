import fs from 'node:fs';
import path from 'node:path';

let rangeRequestSeq = 0;
const recentRangeLifecycles = [];
const MAX_RANGE_HISTORY = 100;

export function getRecentRangeLifecycles() {
  return recentRangeLifecycles;
}

export function resetRangeLifecycles() {
  recentRangeLifecycles.length = 0;
  rangeRequestSeq = 0;
}

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
  if (rangeSet.startsWith('-')) {
    const suffixLength = parseInt(rangeSet.slice(1), 10);
    if (isNaN(suffixLength) || suffixLength <= 0) return { type: 'invalid', error: 'Invalid suffix' };
    if (fileSize === 0) return { type: 'unsatisfiable', start: 0, end: 0, fileSize };
    const len = Math.min(suffixLength, fileSize);
    return { type: 'single', start: fileSize - len, end: fileSize - 1, contentLength: len };
  }
  const parts = rangeSet.split('-');
  if (parts.length !== 2) return { type: 'invalid', error: 'Invalid range parts' };
  const start = parseInt(parts[0].trim(), 10);
  if (isNaN(start) || start < 0) return { type: 'invalid', error: 'Invalid range start' };
  if (start >= fileSize) return { type: 'unsatisfiable', start, end: -1, fileSize };
  let end;
  if (parts[1].trim() === '') {
    end = fileSize - 1;
  } else {
    end = parseInt(parts[1].trim(), 10);
    if (isNaN(end) || end < start) return { type: 'invalid', error: 'Invalid range end' };
    if (end >= fileSize) end = fileSize - 1;
  }
  return { type: 'single', start, end, contentLength: (end - start) + 1 };
}

export function streamVideo(req, res, filePath) {
  const reqId = ++rangeRequestSeq;
  const startTime = Date.now();
  const rawRange = req.headers ? (req.headers.range || null) : null;
  const mediaName = filePath ? path.basename(filePath) : '--';

  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Video file not found: ' + filePath);
    const endRecord = {
      event: 'RANGE_FINISH',
      requestId: reqId,
      timestamp: new Date().toISOString(),
      durationMs: 0,
      outcome: 'not_found',
      responseStatus: 404,
      contentRange: null,
      contentLength: 0
    };
    recentRangeLifecycles.push(endRecord);
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
    const endRecord = {
      event: 'RANGE_FINISH',
      requestId: reqId,
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - startTime,
      outcome: 'head',
      responseStatus: 200,
      contentRange: null,
      contentLength: fileSize
    };
    recentRangeLifecycles.push(endRecord);
    return;
  }

  const rangeParsed = parseByteRange(rawRange, fileSize);

  if (rangeParsed.type === 'multiple' || rangeParsed.type === 'invalid' || rangeParsed.type === 'unsatisfiable') {
    const rangeHeaderVal = `bytes */${fileSize}`;
    res.writeHead(416, {
      'Content-Range': rangeHeaderVal,
      'Content-Type': 'video/mp4',
      'Access-Control-Allow-Origin': '*'
    });
    res.end();
    const endRecord = {
      event: 'RANGE_FINISH',
      requestId: reqId,
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - startTime,
      outcome: 'unsatisfiable',
      responseStatus: 416,
      contentRange: rangeHeaderVal,
      contentLength: 0
    };
    recentRangeLifecycles.push(endRecord);
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
    statusCode = 200;
    headers['Content-Length'] = fileSize;
  }

  console.log(`[RANGE_START #${reqId}] ${mediaName} | Range:${rawRange || 'none'} (${readStart}-${readEnd}) | Status:${statusCode} | Len:${headers['Content-Length']}`);

  res.writeHead(statusCode, headers);

  const fileStream = fs.createReadStream(filePath, { start: readStart, end: readEnd });

  let finalized = false;
  const finalize = (outcome) => {
    if (finalized) return;
    finalized = true;
    if (!fileStream.destroyed) {
      fileStream.destroy();
    }
    const durationMs = Date.now() - startTime;
    const endEventName = outcome === 'finish' ? 'RANGE_FINISH' : (outcome === 'aborted' ? 'RANGE_ABORT' : 'RANGE_CLOSE');
    const endRecord = {
      event: endEventName,
      requestId: reqId,
      timestamp: new Date().toISOString(),
      durationMs,
      outcome, // 'finish' | 'close' | 'aborted' | 'error'
      responseStatus: statusCode,
      contentRange: headers['Content-Range'] || null,
      contentLength: headers['Content-Length']
    };
    recentRangeLifecycles.push(endRecord);
    if (recentRangeLifecycles.length > MAX_RANGE_HISTORY) {
      recentRangeLifecycles.shift();
    }
    console.log(`[${endEventName} #${reqId}] outcome:${outcome} | dur:${durationMs}ms | Status:${statusCode} | Range:${headers['Content-Range'] || '--'}`);
  };

  fileStream.on('error', () => finalize('error'));
  res.on('finish', () => finalize('finish'));
  res.on('close', () => finalize('close'));
  req.on('aborted', () => finalize('aborted'));

  fileStream.pipe(res);
}
