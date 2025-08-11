const input = {
  version: 1,
  mediaFileName: 'HUNVR087 - Nanami Miori.mp4',
  cutSegments: [
    {
      start: 156.172349,
      end: 2110.7514333895447,
      name: '',
    },
  ],
}

let baseVidName = input.mediaFileName.replace('.mp4', '');
const Starts = input.cutSegments.map(segment => segment.start.toFixed(3)); // May need adjustment if used later for per-group logic
const Ends = input.cutSegments.map(segment => segment.end.toFixed(3));     // May need adjustment if used later for per-group logic

let isDependInit = false;

const DATA = {
  requestId: "",
  requestHeaders: "",
  cookie: "",
  urls: "",
  dir: "",
  referer: "",
};

function aria2AddUri(data, success, error) {
  const json = {
    "jsonrpc": "2.0",
    "id": data.id,
    "method": "system.multicall",
    "params": []
  };

  if (typeof G !== 'undefined' && G.aria2RpcToken) { // Check if G is defined
    json.params.push(`token:${G.aria2RpcToken}`);
  }

  const tasks = data.tasks.map(t => ({
    "methodName": "aria2.addUri",
    "params": [[t.url], {
      dir: data.dir,
      referer: data.referer,
      out: t.out,
    }]
  }));

  json.params.push(tasks);

  $.ajax({
    type: "POST",
    url: "http://localhost:16800/jsonrpc",
    data: JSON.stringify([json]),
    contentType: "application/json; charset=utf-8",
    dataType: "json",
  });
}

function calculateSegment(totalDuration, timestamp, totalSegments) {
  if (typeof totalDuration !== 'number' || typeof timestamp !== 'number' || typeof totalSegments !== 'number') {
    throw new Error('Invalid input parameters');
  }

  if (timestamp > totalDuration) {
    // Allow timestamp to be slightly greater than totalDuration due to precision issues
    if (timestamp > totalDuration + 0.001) { // Adding a small tolerance
        console.warn(`Timestamp ${timestamp} exceeds total duration ${totalDuration} slightly. Clamping to duration.`);
        timestamp = totalDuration;
    } else {
        // If significantly larger, then it's an error
        // throw new Error('Timestamp exceeds total duration');
        // For now, let's also clamp it and log a stronger warning or error
        console.error(`Timestamp ${timestamp} significantly exceeds total duration ${totalDuration}. Clamping to duration.`);
        timestamp = totalDuration;
    }
  }
  if (timestamp < 0) timestamp = 0; // Ensure timestamp is not negative

  const ratio = timestamp / totalDuration;
  let segmentNumber = Math.floor(ratio * totalSegments);
  
  // Ensure segmentNumber is within bounds [0, totalSegments - 1]
  if (segmentNumber >= totalSegments) {
    segmentNumber = totalSegments - 1;
  }
  if (segmentNumber < 0) {
    segmentNumber = 0;
  }
  
  return segmentNumber;
}


function getFragmentsIndex(timestamp, totalDuration, totalSegments) {
  return calculateSegment(totalDuration, timestamp, totalSegments);
}

// Helper function to convert seconds to time string, if not already available
function secToTime(timeInSeconds) {
    const pad = function(num, size) { return ('000' + num).slice(size * -1); },
    time = parseFloat(timeInSeconds).toFixed(3),
    hours = Math.floor(time / 60 / 60),
    minutes = Math.floor(time / 60) % 60,
    seconds = Math.floor(time - minutes * 60),
    milliseconds = time.slice(-3); // Ensure this is correct if timeInSeconds is a number
    return pad(hours, 2) + ':' + pad(minutes, 2) + ':' + pad(seconds, 2) + '.' + pad(milliseconds, 3);
}


// Assuming hls, _fragments, totalDuration, fragmentsLength are defined globally by CatCatch
const totalDuration = hls.levels[0].details.totalduration;
const fragmentsLength = _fragments.length;

// Group segments by name
const segmentsByName = input.cutSegments.reduce((acc, segment) => {
  // Sanitize name for use in directory/file names
  const nameKey = segment.name.replace(/[^a-zA-Z0-9_-\s]/g, '_').replace(/\s+/g, '_');
  if (!acc[nameKey]) {
    acc[nameKey] = {
      originalName: segment.name,
      segments: []
    };
  }
  acc[nameKey].segments.push(segment);
  return acc;
}, {});

// Detect if init segment is depended upon (globally)
if (_fragments[0] && _fragments[0].initSegment) {
  isDependInit = true;
}

Object.keys(segmentsByName).forEach(nameKey => {
  const group = segmentsByName[nameKey];
  const currentSegmentsInGroup = group.segments;
  const originalSegmentNameForGroup = group.originalName;

  let groupVidName = `${baseVidName}-${nameKey}`;
  if (isDependInit) {
      // VidName += ' (DependInit)'; // Original global modification
      // If you want the folder name to include this, append it here:
      // groupVidName += ' (DependInit)';
      // However, MergeDash.ps1 just looks for "init.mp4", so folder name suffix isn't strictly needed for it.
  }

  const taskListForGroup = [];
  let groupExportDuration = 0;
  let groupFragmentsDownloadCount = 0;

  if (isDependInit) { // Add init segment task for this group
    taskListForGroup.push({
      url: _fragments[0].initSegment.url,
      out: `init.mp4` // This will be relative to the group's DATA.dir
    });
  }

  currentSegmentsInGroup.forEach((segment, i) => { // `i` is the P-identifier for this group's segment part
    const startIndex = getFragmentsIndex(segment.start, totalDuration, fragmentsLength);
    const endIndex = getFragmentsIndex(segment.end, totalDuration, fragmentsLength);

    const hsl_fragments_details = hls.levels[0].details.fragments;
    const segmentPartStart = hsl_fragments_details[startIndex].start;
    const segmentPartEnd = hsl_fragments_details[endIndex].end;

    const fragmentsToDownloadForSegmentPart = _fragments.filter((fragment, index) => index >= startIndex && index <= endIndex);
    groupExportDuration += fragmentsToDownloadForSegmentPart.reduce((acc, frag) => acc + frag.duration, 0);
    groupFragmentsDownloadCount += fragmentsToDownloadForSegmentPart.length;

    taskListForGroup.push(...fragmentsToDownloadForSegmentPart.map(fragment => {
      const sequenceNumber = fragment.sn.toString().padStart(4, '0');
      return {
        url: fragment.url,
        out: `P${i+1}-${segmentPartStart.toFixed(3)}-${segmentPartEnd.toFixed(3)}-${sequenceNumber}.m4s`
      };
    }));
  });

  console.log(`\nProcessing group: ${originalSegmentNameForGroup} (Target Folder: ${groupVidName})`);
  console.log(`  Download fragments for this group: ${isDependInit ? groupFragmentsDownloadCount + 1 : groupFragmentsDownloadCount}`);
  console.log(`  Exported duration for this group: ${secToTime(groupExportDuration)} (${groupExportDuration.toFixed(3)})`);

  const groupDATA = { ...DATA }; // Clone global DATA object
  groupDATA.id = `cat-catch-${nameKey}-` + Date.now().toString();

  if (navigator.platform === 'MacIntel') {
    // groupDATA.dir = `/Volumes/batch/${groupVidName}`;
    groupDATA.dir = `//Volumes/T7-carllx2T/${groupVidName}`;
  } else if (navigator.platform === 'Win32') {
    groupDATA.dir = `D:\\\\Downloads\\\\VR\\\\04_HEVC_Conversion_Queue\\\\${groupVidName}`;
  }
  groupDATA.tasks = taskListForGroup;
  groupDATA.referer = typeof requestHeaders !== 'undefined' ? requestHeaders.referer : document.referrer; // Ensure requestHeaders is defined

  aria2AddUri(groupDATA);
});
