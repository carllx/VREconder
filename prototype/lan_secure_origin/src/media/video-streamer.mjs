import fs from 'node:fs';
import path from 'node:path';

let rangeRequestSeq = 0;
const recentRangeLifecycles = [];
const MAX_RANGE_HISTORY = 100;
let activeStreamCount = 0;
const streamCountListeners = new Set();

export function onActiveStreamCountChange(fn) {
  streamCountListeners.add(fn);
  return () => streamCountListeners.delete(fn);
}

function notifyStreamCountChange() {
  for (const fn of streamCountListeners) {
    try { fn(activeStreamCount); } catch (_) {}
  }
}

export function getRecentRangeLifecycles(options = {}) {
  const { sinceMs = null, mediaPath = null, limit = 20 } = options;
  const now = Date.now();
  let filtered = recentRangeLifecycles;

  if (typeof sinceMs === 'number' && sinceMs > 0) {
    const cutoff = now - sinceMs;
    filtered = filtered.filter(r => (r.startTime >= cutoff || (r.endTime && r.endTime >= cutoff)));
  }

  if (typeof mediaPath === 'string' && mediaPath) {
    const targetName = path.basename(mediaPath);
    filtered = filtered.filter(r => r.mediaName === targetName || (r.fullPath && r.fullPath.includes(mediaPath)));
  }

  if (typeof limit === 'number' && limit > 0 && filtered.length > limit) {
    filtered = filtered.slice(-limit);
  }

  return filtered;
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

  const record = {
    requestId: reqId,
    mediaName: mediaName,
    fullPath: filePath,
    rangeHeader: rawRange,
    requestedStart: null,
    requestedEnd: null,
    contentLength: 0,
    status: 200,
    startTime: startTime,
    startTimestamp: new Date(startTime).toISOString(),
    endTime: null,
    endTimestamp: null,
    durationMs: null,
    outcome: 'in_progress',
    contentRange: null
  };

  recentRangeLifecycles.push(record);
  if (recentRangeLifecycles.length > MAX_RANGE_HISTORY) {
    recentRangeLifecycles.shift();
  }

  const markFinal = (outcome, status, contentRange, contentLength) => {
    if (record.endTime !== null) return;
    const endTime = Date.now();
    record.endTime = endTime;
    record.endTimestamp = new Date(endTime).toISOString();
    record.durationMs = endTime - startTime;
    record.outcome = outcome;
    record.status = status;
    record.contentRange = contentRange || null;
    if (typeof contentLength === 'number') record.contentLength = contentLength;
  };

  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Video file not found: ' + filePath);
    markFinal('not_found', 404, null, 0);
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
    markFinal('head', 200, null, fileSize);
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
    markFinal('unsatisfiable', 416, rangeHeaderVal, 0);
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

  record.requestedStart = readStart;
  record.requestedEnd = readEnd;
  record.contentLength = headers['Content-Length'];
  record.status = statusCode;
  record.contentRange = headers['Content-Range'] || null;

  res.writeHead(statusCode, headers);

  activeStreamCount++;
  notifyStreamCountChange();
  let streamCountDecremented = false;

  const fileStream = fs.createReadStream(filePath, { start: readStart, end: readEnd });

  const finalize = (outcome) => {
    if (!streamCountDecremented) {
      streamCountDecremented = true;
      activeStreamCount = Math.max(0, activeStreamCount - 1);
      notifyStreamCountChange();
    }
    if (!fileStream.destroyed) {
      fileStream.destroy();
    }
    markFinal(outcome, statusCode, headers['Content-Range'], headers['Content-Length']);
  };

  fileStream.on('error', () => finalize('error'));
  res.on('finish', () => finalize('finish'));
  res.on('close', () => finalize('close'));
  req.on('aborted', () => finalize('aborted'));

  fileStream.pipe(res);
}
