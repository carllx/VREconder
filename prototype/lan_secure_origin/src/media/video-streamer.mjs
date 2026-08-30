import fs from 'node:fs';

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
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Video file not found: ' + filePath);
    return;
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (req.method === 'HEAD') {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*'
    });
    res.end();
    return;
  }

  if (range) {
    const parsed = parseByteRange(range, fileSize);
    if (parsed.type === 'single') {
      const file = fs.createReadStream(filePath, { start: parsed.start, end: parsed.end });
      res.writeHead(206, {
        'Content-Range': `bytes ${parsed.start}-${parsed.end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': parsed.contentLength,
        'Content-Type': 'video/mp4',
        'Access-Control-Allow-Origin': '*'
      });
      file.pipe(res);
      return;
    }
    if (parsed.type === 'unsatisfiable' || parsed.type === 'invalid' || parsed.type === 'multiple') {
      res.writeHead(416, {
        'Content-Range': `bytes */${fileSize}`,
        'Content-Type': 'video/mp4',
        'Access-Control-Allow-Origin': '*'
      });
      res.end();
      return;
    }
  }

  res.writeHead(200, {
    'Content-Length': fileSize,
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*'
  });
  fs.createReadStream(filePath).pipe(res);
}
