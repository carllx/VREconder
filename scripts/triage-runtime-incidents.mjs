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
 * Maps an incident to the appropriate GitHub issue and category.
 * Routing rules:
 * - Media-health / compatibility findings -> Issue #21 (Normalization & Codec Authority):
 *   - NORMALIZATION_CANDIDATE_CERTIFIED
 *   - EXACT_CERTIFIED_NORMALIZATION_CANDIDATE
 *   - EXPERIMENT_DERIVATIVE
 *   - NEEDS_BUCKET_CERTIFICATION
 *   - NEEDS_DEVICE_PROBE
 *   - UNSUPPORTED_UNKNOWN_FIX
 *   - UNREADABLE_MEDIA
 *   - INVALID_MEDIA
 * - Actual runtime playback failures -> Issue #23 (Runtime Playback Recovery):
 *   - MEDIA_ERR_SRC_NOT_SUPPORTED
 *   - MEDIA_ERR_ABORTED
 *   - MEDIA_ERR_NETWORK
 *   - MEDIA_ERR_DECODE
 *   - MEDIA_PLAYBACK_ERROR
 * - Incident pipeline / logging lifecycle defects & unclassified pipeline failures -> Issue #24 (Incident Triage Pipeline)
 */
export function routeIncident(incident) {
  const c = incident.classification || '';
  const r = incident.reason || '';
  const e = incident.eventType || '';

  // Actual runtime playback failures -> Issue #23
  if (
    c === 'MEDIA_ERR_SRC_NOT_SUPPORTED' ||
    c === 'MEDIA_ERR_DECODE' ||
    c === 'MEDIA_ERR_NETWORK' ||
    c === 'MEDIA_ERR_ABORTED' ||
    r.includes('MEDIA_ERR_SRC_NOT_SUPPORTED') ||
    e === 'MEDIA_PLAYBACK_ERROR'
  ) {
    return { targetIssue: 23, topic: 'Runtime Playback Recovery' };
  }

  // Media-health / compatibility findings -> Issue #21
  if (
    c === 'NORMALIZATION_CANDIDATE_CERTIFIED' ||
    c === 'EXACT_CERTIFIED_NORMALIZATION_CANDIDATE' ||
    c === 'EXPERIMENT_DERIVATIVE' ||
    c === 'NEEDS_BUCKET_CERTIFICATION' ||
    c === 'NEEDS_DEVICE_PROBE' ||
    c === 'UNSUPPORTED_UNKNOWN_FIX' ||
    c === 'UNREADABLE_MEDIA' ||
    c === 'INVALID_MEDIA' ||
    e === 'PLAYBACK_ADMISSION_DENIED'
  ) {
    return { targetIssue: 21, topic: 'Media Normalization / Policy Compatibility' };
  }

  // Incident pipeline lifecycle / unclassified defects -> Issue #24
  return { targetIssue: 24, topic: 'Runtime Incident Triage' };
}

/**
 * Sanitizes reason strings to remove any absolute paths or private media filenames.
 */
function sanitizeReason(reason) {
  if (!reason || typeof reason !== 'string') return '';
  // Replace Windows and Unix file paths with [path]
  let sanitized = reason.replace(/[a-zA-Z]:\\[^ \n\r\t,"]+/g, '[path]');
  sanitized = sanitized.replace(/\/[^ \n\r\t,"]+\.(mp4|m4v|mkv|mov|webm)/gi, '[path]');
  return sanitized;
}

/**
 * Sanitizes an incident report so NO private filenames or absolute paths are exposed.
 */
export function generateSanitizedTriage(pendingList) {
  if (!pendingList || pendingList.length === 0) {
    return { groups: [], totalCount: 0 };
  }

  // Group by (targetIssue, classification, matchedEnvelopeId, reason)
  const groupMap = new Map();

  for (const inc of pendingList) {
    const route = routeIncident(inc);
    const cleanReason = sanitizeReason(inc.reason);
    const key = `${route.targetIssue}::${inc.classification}::${inc.matchedEnvelopeId || 'NONE'}::${cleanReason}`;

    if (!groupMap.has(key)) {
      groupMap.set(key, {
        targetIssue: route.targetIssue,
        topic: route.topic,
        classification: inc.classification,
        matchedEnvelopeId: inc.matchedEnvelopeId || null,
        reason: cleanReason,
        allowedNextActions: inc.allowedNextActions || [],
        incidentIds: [],
        fingerprintIds: new Set(),
        occurrenceSources: new Set(),
        count: 0
      });
    }

    const g = groupMap.get(key);
    g.count++;
    g.incidentIds.push(inc.incidentId);
    if (inc.fingerprintId) g.fingerprintIds.add(inc.fingerprintId);
    if (inc.occurrenceSource) g.occurrenceSources.add(inc.occurrenceSource);
  }

  const groups = Array.from(groupMap.values()).map(g => ({
    ...g,
    fingerprintCount: g.fingerprintIds.size,
    fingerprintIds: Array.from(g.fingerprintIds),
    occurrenceSources: Array.from(g.occurrenceSources)
  }));

  return { groups, totalCount: pendingList.length };
}

export function formatMarkdownSummary(triage) {
  if (triage.totalCount === 0) {
    return '### Runtime Incident Triage\n\nNo pending runtime incidents found in `runtime_incidents.pending.jsonl`.\n';
  }

  let md = `### Runtime Incident Triage Summary (${triage.totalCount} pending incidents)\n\n`;
  md += '| Target Issue | Classification | Envelope | Events | Unique Media | Reason |\n';
  md += '|:---|:---|:---|:---:|:---:|:---|\n';

  for (const g of triage.groups) {
    const env = g.matchedEnvelopeId ? `\`${g.matchedEnvelopeId}\`` : 'None';
    const cleanReason = (g.reason || '').replace(/\|/g, '\\|');
    md += `| #${g.targetIssue} (${g.topic}) | \`${g.classification}\` | ${env} | ${g.count} | ${g.fingerprintCount} | ${cleanReason} |\n`;
  }

  md += '\n#### Group Details (Sanitized)\n\n';
  for (let i = 0; i < triage.groups.length; i++) {
    const g = triage.groups[i];
    md += `**Group ${i + 1} -> Issue #${g.targetIssue}**\n`;
    md += `- **Classification**: \`${g.classification}\`\n`;
    md += `- **Matched Envelope**: ${g.matchedEnvelopeId ? `\`${g.matchedEnvelopeId}\`` : 'None'}\n`;
    md += `- **Reason**: ${g.reason}\n`;
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
      issueComment += '| Classification | Envelope | Events | Unique Media | Reason |\n';
      issueComment += '|:---|:---|:---:|:---:|:---|\n';
      for (const g of issueGroups) {
        const env = g.matchedEnvelopeId ? `\`${g.matchedEnvelopeId}\`` : 'None';
        issueComment += `| \`${g.classification}\` | ${env} | ${g.count} | ${g.fingerprintCount} | ${(g.reason || '').replace(/\|/g, '\\|')} |\n`;
      }
      issueComment += '\n**Sanitized Reference Incident IDs**:\n';
      for (const g of issueGroups) {
        issueComment += `- \`${g.classification}\`: ${g.incidentIds.join(', ')}\n`;
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
