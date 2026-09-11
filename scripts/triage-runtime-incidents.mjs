#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  readPendingIncidents,
  readProcessedIncidents,
  acknowledgeIncidents
} from '../prototype/lan_secure_origin/src/telemetry/incident-store.mjs';
import {
  clusterIncidents,
  routeIncident,
  sanitizeReason,
  determineIncidentStatus,
  getHypothesisDetails,
  IncidentStatus
} from '../prototype/lan_secure_origin/src/telemetry/incident-cluster.mjs';

export {
  routeIncident,
  sanitizeReason,
  determineIncidentStatus,
  getHypothesisDetails,
  IncidentStatus
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const PROTO_DIR = path.join(REPO_ROOT, 'prototype', 'lan_secure_origin');

// Parse CLI flags
const args = process.argv.slice(2);
const isAck = args.includes('--ack');
const isPost = args.includes('--post-github') || args.includes('--post');
const isJson = args.includes('--json');
const isHelp = args.includes('--help') || args.includes('-h');

if (isHelp) {
  console.log(`
Usage: node scripts/triage-runtime-incidents.mjs [options]

Options:
  --ack          Acknowledge triaged pending incidents (moves to processed.jsonl)
  --post-github  Post sanitized summaries as comments to relevant GitHub issues (#21, #23, #24)
  --json         Output raw JSON summary
  --help, -h     Show this help
`);
  process.exit(0);
}

/**
 * Sanitizes an incident report so NO private filenames or absolute paths are exposed,
 * and clusters incidents by stable failure signature with paired admission correlation.
 */
export function generateSanitizedTriage(pendingList) {
  if (!pendingList || pendingList.length === 0) {
    return { groups: [], clusters: [], totalCount: 0, totalLogicalOccurrences: 0 };
  }

  const { clusters, totalRawEvents, totalLogicalOccurrences } = clusterIncidents(pendingList);

  const groups = clusters.map(c => ({
    ...c,
    count: c.rawEventCount,
    fingerprintCount: c.mediaCount,
    fingerprintIds: c.affectedMedia.map(m => m.fingerprintId).filter(Boolean),
    incidentIds: c.rawIncidentIds
  }));

  return {
    groups,
    clusters: groups,
    totalCount: totalRawEvents,
    totalLogicalOccurrences
  };
}

export function formatMarkdownSummary(triage) {
  if (triage.totalCount === 0) {
    return '### Runtime Incident Triage\n\nNo pending runtime incidents found in `runtime_incidents.pending.jsonl`.\n';
  }

  let md = `### Runtime Incident Triage Summary (${triage.totalCount} raw incidents across ${triage.groups.length} logical clusters)\n\n`;
  md += '| Target Issue | Status | Classification | Envelope | Occurrences (Raw) | Media | Time Window | Reason |\n';
  md += '|:---|:---|:---|:---|:---:|:---:|:---|:---|' + '\n';

  for (const g of triage.groups) {
    const env = g.matchedEnvelopeId ? `\`${g.matchedEnvelopeId}\`` : 'None';
    const cleanReason = (g.reason || '').replace(/\|/g, '\\|');
    const firstStr = g.firstSeen ? g.firstSeen.slice(11, 19) : '--';
    const lastStr = g.lastSeen ? g.lastSeen.slice(11, 19) : '--';
    const timeWin = firstStr === lastStr ? firstStr : `${firstStr}..${lastStr}`;
    md += `| #${g.targetIssue} (${g.topic}) | \`${g.status}\` | \`${g.classification}\` | ${env} | ${g.occurrenceCount} (${g.count}) | ${g.fingerprintCount} | ${timeWin} | ${cleanReason} |\n`;
  }

  md += '\n#### Cluster Details (Sanitized)\n\n';
  for (let i = 0; i < triage.groups.length; i++) {
    const g = triage.groups[i];
    md += `**Cluster ${i + 1} [${g.status}] -> Issue #${g.targetIssue} (${g.topic})**\n`;
    md += `- **Signature**: \`${g.signature}\`\n`;
    md += `- **Status**: \`${g.status}\`\n`;
    md += `- **Classification**: \`${g.classification}\`\n`;
    md += `- **Matched Envelope**: ${g.matchedEnvelopeId ? `\`${g.matchedEnvelopeId}\`` : 'None'}\n`;
    md += `- **Reason**: ${g.reason}\n`;
    if (g.hypothesisDetails) {
      md += `- **Hypothesis / Targeted Follow-up**: ${g.hypothesisDetails}\n`;
    }
    md += `- **Occurrences**: ${g.occurrenceCount} logical selections (${g.count} raw events${g.pairedEventsCount > 0 ? `, ${g.pairedEventsCount} paired server/client` : ''})\n`;
    md += `- **First Seen**: ${g.firstSeen || 'unknown'}\n`;
    md += `- **Last Seen**: ${g.lastSeen || 'unknown'}\n`;
    md += `- **Occurrence Sources**: ${g.occurrenceSources.join(', ') || 'unknown'}\n`;
    md += `- **Allowed Next Actions**: ${g.allowedNextActions.length > 0 ? g.allowedNextActions.join(', ') : 'None'}\n`;
    md += `- **Incident IDs**: \`${g.incidentIds.join(', ')}\`\n`;
    if (g.fingerprintIds.length > 0) {
      md += `- **Sanitized Fingerprints**: \`${g.fingerprintIds.join(', ')}\`\n`;
    }
    md += '\n';
  }

  return md;
}

export function postToGitHub(targetIssue, commentBody) {
  try {
    const res = spawnSync('gh', ['issue', 'comment', String(targetIssue), '-F', '-'], {
      cwd: REPO_ROOT,
      input: commentBody,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    if (res.status !== 0) {
      console.error(`[GitHub] Failed to post comment to Issue #${targetIssue}:`, res.stderr || res.stdout);
      return false;
    }
    console.log(`[GitHub] Successfully posted triage comment to Issue #${targetIssue}`);
    return true;
  } catch (err) {
    console.error(`[GitHub] Failed to post comment to Issue #${targetIssue}:`, err.message);
    return false;
  }
}

/**
 * Executes triage logic with configurable incident reader/poster for dependency injection & testing.
 */
export function executeTriage({
  pendingList = null,
  protoDir = PROTO_DIR,
  isPost = false,
  isAck = false,
  poster = postToGitHub,
  logger = console.log
} = {}) {
  const pending = pendingList !== null ? pendingList : readPendingIncidents(protoDir);
  const triage = generateSanitizedTriage(pending);

  const publishedIncidentIds = [];
  const failedIncidentIds = [];

  if (isPost && triage.groups.length > 0) {
    logger('\n--- Posting to GitHub Issues ---');
    const byIssue = new Map();
    for (const g of triage.groups) {
      if (!byIssue.has(g.targetIssue)) byIssue.set(g.targetIssue, []);
      byIssue.get(g.targetIssue).push(g);
    }

    for (const [issueNum, issueGroups] of byIssue.entries()) {
      let issueComment = `### Runtime Incidents Triage Report\n\n`;
      issueComment += `Automated report from pending runtime incidents inbox.\n\n`;
      issueComment += '| Status | Classification | Envelope | Occurrences (Raw) | Media | Reason |\n';
      issueComment += '|:---|:---|:---|:---:|:---:|:---|\n';
      for (const g of issueGroups) {
        const env = g.matchedEnvelopeId ? `\`${g.matchedEnvelopeId}\`` : 'None';
        issueComment += `| \`${g.status}\` | \`${g.classification}\` | ${env} | ${g.occurrenceCount} (${g.count}) | ${g.fingerprintCount} | ${(g.reason || '').replace(/\|/g, '\\|')} |\n`;
      }
      issueComment += '\n**Sanitized Reference Incident IDs**:\n';
      for (const g of issueGroups) {
        issueComment += `- [${g.status}] \`${g.classification}\`: ${g.incidentIds.join(', ')}\n`;
        if (g.hypothesisDetails) {
          issueComment += `  * Note: ${g.hypothesisDetails}\n`;
        }
      }

      const postSuccess = poster(issueNum, issueComment);
      const groupIncidentIds = issueGroups.flatMap(g => g.incidentIds);
      if (postSuccess) {
        publishedIncidentIds.push(...groupIncidentIds);
      } else {
        failedIncidentIds.push(...groupIncidentIds);
      }
    }
  }

  // Acknowledgment policy:
  // 1. If --post-github was requested: acknowledge ONLY the incident IDs whose GitHub publication succeeded.
  // 2. If --ack was requested WITHOUT --post-github: intentional manual acknowledgement of all pending incidents.
  let ackResult = null;
  if (isPost && isAck) {
    if (publishedIncidentIds.length > 0) {
      ackResult = acknowledgeIncidents(publishedIncidentIds, { triagedBy: 'triage-runtime-incidents.mjs', publishMode: 'github' }, protoDir);
      logger(`\n[IncidentStore] Acknowledged ${ackResult.acknowledgedCount} published incidents. Remaining pending: ${ackResult.remainingCount}`);
    } else {
      logger(`\n[IncidentStore] No incidents acknowledged because no GitHub issue comment succeeded.`);
    }
    if (failedIncidentIds.length > 0) {
      logger(`[IncidentStore] WARNING: ${failedIncidentIds.length} incident IDs remain pending due to publication failure.`);
    }
  } else if (!isPost && isAck && pending.length > 0) {
    const allIds = pending.map(p => p.incidentId);
    ackResult = acknowledgeIncidents(allIds, { triagedBy: 'triage-runtime-incidents.mjs', publishMode: 'manual_ack' }, protoDir);
    logger(`\n[IncidentStore] Manual acknowledgement: ${ackResult.acknowledgedCount} incidents moved to processed. Remaining pending: ${ackResult.remainingCount}`);
  }

  return {
    triage,
    publishedIncidentIds,
    failedIncidentIds,
    ackResult
  };
}

// Run if called as CLI script directly
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const pending = readPendingIncidents(PROTO_DIR);
  const triage = generateSanitizedTriage(pending);

  if (isJson) {
    console.log(JSON.stringify(triage, null, 2));
  } else {
    const summaryMd = formatMarkdownSummary(triage);
    console.log(summaryMd);
  }

  executeTriage({
    pendingList: pending,
    protoDir: PROTO_DIR,
    isPost,
    isAck,
    poster: postToGitHub,
    logger: console.log
  });
}
