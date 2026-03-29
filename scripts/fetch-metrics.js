#!/usr/bin/env node
// Fetches project board data from GitHub Projects v2 API.
// Writes data/metrics.json (dashboard data) and data/history.json (status transition log).
// Cycle time is calculated two ways and combined:
//   1. History-based: snapshot diffs detect when status changes, recording To Do → Done transitions
//   2. closedAt-based: GitHub issue close date minus created date (available immediately for closed issues)
//
// Requires: GH_TOKEN env var with read:project + repo scopes

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const ORG            = 'Glotale';
const PROJECT_NUMBER = 10;
const TOKEN          = process.env.GH_TOKEN;

if (!TOKEN) {
  console.error('GH_TOKEN environment variable is required');
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────
// GitHub GraphQL helper
// ─────────────────────────────────────────────────────────────
function graphql(query, variables = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query, variables });
    const req = https.request({
      hostname: 'api.github.com',
      path: '/graphql',
      method: 'POST',
      headers: {
        'Authorization': `bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'glotale-metrics-bot/1.0',
      },
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────
// Fetch all project items (paginated)
// ─────────────────────────────────────────────────────────────
async function fetchAllItems() {
  const allItems = [];
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const query = `
      query($org: String!, $number: Int!, $cursor: String) {
        organization(login: $org) {
          projectV2(number: $number) {
            items(first: 50, after: $cursor) {
              pageInfo { hasNextPage endCursor }
              nodes {
                fieldValues(first: 20) {
                  nodes {
                    ... on ProjectV2ItemFieldTextValue {
                      text
                      field { ... on ProjectV2FieldCommon { name } }
                    }
                    ... on ProjectV2ItemFieldSingleSelectValue {
                      name
                      field { ... on ProjectV2FieldCommon { name } }
                    }
                    ... on ProjectV2ItemFieldDateValue {
                      date
                      field { ... on ProjectV2FieldCommon { name } }
                    }
                    ... on ProjectV2ItemFieldNumberValue {
                      number
                      field { ... on ProjectV2FieldCommon { name } }
                    }
                    ... on ProjectV2ItemFieldIterationValue {
                      title
                      startDate
                      duration
                      field { ... on ProjectV2FieldCommon { name } }
                    }
                  }
                }
                content {
                  ... on Issue {
                    number title state createdAt closedAt
                    author { login }
                    labels(first: 10) { nodes { name } }
                    assignees(first: 5) { nodes { login } }
                    milestone { title dueOn }
                  }
                  ... on PullRequest {
                    number title state createdAt closedAt
                    author { login }
                    labels(first: 10) { nodes { name } }
                    assignees(first: 5) { nodes { login } }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const result = await graphql(query, { org: ORG, number: PROJECT_NUMBER, cursor });
    if (result.errors) {
      console.error('GraphQL errors:', JSON.stringify(result.errors, null, 2));
      process.exit(1);
    }

    const page = result.data.organization.projectV2.items;
    hasNextPage = page.pageInfo.hasNextPage;
    cursor      = page.pageInfo.endCursor;

    for (const item of page.nodes) {
      const c = item.content;
      if (!c) continue;
      const fvs = item.fieldValues.nodes;
      let status = null, kind = null, size = null, sprint = null;
      for (const fv of fvs) {
        if (!fv?.field) continue;
        const n = fv.field.name;
        if (n === 'Status') status = fv.name;
        else if (n === 'Kind')   kind   = fv.name;
        else if (n === 'Size')   size   = fv.name || fv.number;
        else if (n === 'Sprint') sprint = fv.title;
      }
      allItems.push({
        number:      c.number,
        title:       c.title,
        state:       c.state,
        status,  kind, size, sprint,
        author:      c.author?.login || null,
        labels:      (c.labels?.nodes || []).map(l => l.name),
        assignees:   (c.assignees?.nodes || []).map(a => a.login),
        milestone:   c.milestone?.title || null,
        milestoneDue: c.milestone?.dueOn || null,
        createdAt:   c.createdAt,
        closedAt:    c.closedAt,
      });
    }
    console.log(`  Fetched ${allItems.length} items...`);
  }
  return allItems;
}

// ─────────────────────────────────────────────────────────────
// History: load, update, and compute cycle times
// ─────────────────────────────────────────────────────────────

function loadHistory(historyPath) {
  if (fs.existsSync(historyPath)) {
    try { return JSON.parse(fs.readFileSync(historyPath, 'utf8')); }
    catch (_) { /* corrupt file — start fresh */ }
  }
  return { lastUpdated: null, items: {} };
}

/**
 * Update the history with the latest item statuses.
 * - First-time items: seed their initial status entry.
 *   • If status is "To Do" → use createdAt as the enteredAt (it was likely To Do from creation).
 *   • If status is "Done" and closedAt exists → use closedAt as the done enteredAt.
 *   • Otherwise → use now (we don't know when they transitioned).
 * - Known items: if status has changed since last snapshot, record the exit/entry timestamps.
 * - closedAt is always updated so the closed-based fallback stays accurate.
 */
function updateHistory(items, history) {
  const now = new Date().toISOString();

  for (const item of items) {
    const key     = String(item.number);
    const current = item.status;

    if (!history.items[key]) {
      // Seed initial entry
      let enteredAt;
      if (current === 'To Do') {
        enteredAt = item.createdAt || now;        // To Do from the start
      } else if (current === 'Done' && item.closedAt) {
        enteredAt = item.closedAt;                // Done when issue was closed
      } else {
        enteredAt = now;                          // Unknown transition time
      }

      history.items[key] = {
        title:     item.title,
        createdAt: item.createdAt,
        closedAt:  item.closedAt,
        firstSeenAt: now,
        statusHistory: [{
          status:    current,
          enteredAt,
          exitedAt:  null,
          source:    'initial',
        }],
      };
    } else {
      const record   = history.items[key];
      const lastEntry = record.statusHistory[record.statusHistory.length - 1];

      // Always keep closedAt and title in sync
      record.closedAt = item.closedAt;
      record.title    = item.title;

      if (lastEntry.status !== current) {
        // Status changed — close out the old entry and open the new one
        lastEntry.exitedAt = now;

        let enteredAt = now;
        // If it just became Done and there's a closedAt, prefer that as a more accurate timestamp
        if (current === 'Done' && item.closedAt) {
          const closedDate = new Date(item.closedAt);
          const lastExit   = new Date(lastEntry.exitedAt);
          // Use closedAt only if it's at or before now (sanity check)
          if (closedDate <= lastExit) enteredAt = item.closedAt;
        }

        record.statusHistory.push({
          status:    current,
          enteredAt,
          exitedAt:  null,
          source:    'detected',
        });
        console.log(`  Transition detected: #${item.number} "${lastEntry.status}" → "${current}"`);
      }
    }
  }

  history.lastUpdated = now;
  return history;
}

/**
 * Compute cycle time for a single item using both methods.
 *
 * History-based: time from when "To Do" was entered to when "Done" was entered.
 * closedAt-based: closedAt - createdAt (available immediately for closed issues).
 * combined: prefer history-based when To Do entry is known; fall back to closedAt.
 */
function itemCycleTime(record) {
  const sh = record.statusHistory;

  // History method: find the earliest To Do entry and the Done entry
  const todoEntry = sh.find(s => s.status === 'To Do');
  const doneEntry = sh.find(s => s.status === 'Done');
  let historyDays = null;
  if (todoEntry && doneEntry) {
    historyDays = Math.max(0, Math.round(
      (new Date(doneEntry.enteredAt) - new Date(todoEntry.enteredAt)) / 864e5
    ));
  }

  // closedAt method
  let closedDays = null;
  if (record.closedAt && record.createdAt) {
    closedDays = Math.max(0, Math.round(
      (new Date(record.closedAt) - new Date(record.createdAt)) / 864e5
    ));
  }

  // Combined: prefer history-based (more accurate), fall back to closedAt
  const cycleDays = historyDays ?? closedDays;

  // Current status duration
  const currentEntry = sh[sh.length - 1];
  const currentStatusDays = Math.round(
    (new Date() - new Date(currentEntry.enteredAt)) / 864e5
  );

  return { historyDays, closedDays, cycleDays, currentStatusDays };
}

/**
 * Build the cycleStats block included in metrics.json.
 * Returns per-item cycle data and aggregated averages by team/kind/milestone.
 */
function computeCycleStats(items, history) {
  const completed = []; // items that have reached Done

  for (const item of items) {
    const record = history.items[String(item.number)];
    if (!record) continue;

    const ct = itemCycleTime(record);

    // Only include in completed stats if they are in Done or closed
    if (item.status === 'Done' || item.closedAt) {
      if (ct.cycleDays !== null) {
        completed.push({
          number:    item.number,
          title:     item.title,
          labels:    item.labels,
          kind:      item.kind,
          milestone: item.milestone,
          assignees: item.assignees,
          cycleDays:      ct.cycleDays,
          historyDays:    ct.historyDays,
          closedDays:     ct.closedDays,
          source: ct.historyDays !== null ? 'history' : 'closedAt',
        });
      }
    }
  }

  // Aggregate helper
  function avg(arr) {
    return arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;
  }

  const TEAMS = ['Operations', 'Digital marketing', 'Sales', 'Coaching/Delivery', 'Product'];

  const byTeam = {};
  TEAMS.forEach(t => {
    const teamItems = completed.filter(i => i.labels.includes(t));
    byTeam[t] = avg(teamItems.map(i => i.cycleDays));
  });

  const byKind = {};
  ['Task', 'Story'].forEach(k => {
    const kindItems = completed.filter(i => i.kind === k);
    byKind[k] = avg(kindItems.map(i => i.cycleDays));
  });

  const byMilestone = {};
  ['Q1 2026', 'Q2 2026'].forEach(m => {
    const mItems = completed.filter(i => i.milestone === m);
    byMilestone[m] = avg(mItems.map(i => i.cycleDays));
  });

  // Items currently in progress with time in current status
  const inFlight = items
    .filter(i => ['To Do', 'In progress', 'In review'].includes(i.status))
    .map(i => {
      const record = history.items[String(i.number)];
      if (!record) return null;
      const ct = itemCycleTime(record);
      // Days since To Do was entered (total time in flight so far)
      const todoEntry = record.statusHistory.find(s => s.status === 'To Do');
      const daysInFlight = todoEntry
        ? Math.round((new Date() - new Date(todoEntry.enteredAt)) / 864e5)
        : null;
      return {
        number:         i.number,
        title:          i.title,
        labels:         i.labels,
        kind:           i.kind,
        milestone:      i.milestone,
        assignees:      i.assignees,
        currentStatus:  i.status,
        currentStatusDays: ct.currentStatusDays,
        daysInFlight,
      };
    })
    .filter(Boolean)
    .sort((a, b) => (b.daysInFlight ?? 0) - (a.daysInFlight ?? 0));

  return {
    overall:      avg(completed.map(i => i.cycleDays)),
    overallHistory: avg(completed.filter(i=>i.source==='history').map(i=>i.historyDays)),
    overallClosed:  avg(completed.filter(i=>i.closedDays!==null).map(i=>i.closedDays)),
    completedCount: completed.length,
    byTeam,
    byKind,
    byMilestone,
    completed,
    inFlight,
  };
}

// ─────────────────────────────────────────────────────────────
// Core metrics (unchanged aggregates)
// ─────────────────────────────────────────────────────────────
function computeMetrics(items, cycleStats) {
  const now = new Date();
  const TEAMS    = ['Operations', 'Digital marketing', 'Sales', 'Coaching/Delivery', 'Product'];
  const STATUSES = ['To Do', 'In progress', 'In review', 'Done', 'Unset'];

  const byStatus = {}, byKind = {}, byLabel = {}, byAssignee = {}, byMilestone = {}, byAuthor = {};
  items.forEach(r => {
    const s = r.status || 'Unset'; byStatus[s] = (byStatus[s] || 0) + 1;
    const k = r.kind   || 'Unset'; byKind[k]   = (byKind[k]   || 0) + 1;
    r.labels.forEach(l => { byLabel[l]    = (byLabel[l]    || 0) + 1; });
    r.assignees.forEach(a => { byAssignee[a] = (byAssignee[a] || 0) + 1; });
    const m = r.milestone || 'None'; byMilestone[m] = (byMilestone[m] || 0) + 1;
    if (r.author) byAuthor[r.author] = (byAuthor[r.author] || 0) + 1;
  });

  const milestoneStatus = {};
  ['Q1 2026', 'Q2 2026', 'None'].forEach(m => {
    milestoneStatus[m] = {};
    STATUSES.forEach(s => milestoneStatus[m][s] = 0);
    items.filter(r => (r.milestone || 'None') === m).forEach(r => {
      milestoneStatus[m][r.status || 'Unset']++;
    });
  });

  const teamStatus = {};
  TEAMS.forEach(t => {
    teamStatus[t] = {};
    STATUSES.forEach(s => teamStatus[t][s] = 0);
    items.filter(r => r.labels.includes(t)).forEach(r => {
      teamStatus[t][r.status || 'Unset']++;
    });
  });

  const openItems   = items.filter(r => r.state === 'OPEN');
  const avgAgeDays  = openItems.length
    ? Math.round(openItems.reduce((a, r) => a + (now - new Date(r.createdAt)) / 864e5, 0) / openItems.length)
    : 0;

  const ageBuckets = { '0-7 days': 0, '8-14 days': 0, '15-30 days': 0, '30+ days': 0 };
  openItems.forEach(r => {
    const age = Math.floor((now - new Date(r.createdAt)) / 864e5);
    if (age <= 7) ageBuckets['0-7 days']++;
    else if (age <= 14) ageBuckets['8-14 days']++;
    else if (age <= 30) ageBuckets['15-30 days']++;
    else ageBuckets['30+ days']++;
  });

  const cutoff = new Date(now.getTime() - 60 * 864e5);
  const byDate = {};
  items.forEach(r => {
    const d = new Date(r.createdAt);
    if (d >= cutoff) {
      const key = d.toISOString().substring(0, 10);
      byDate[key] = (byDate[key] || 0) + 1;
    }
  });

  return {
    lastUpdated: now.toISOString(),
    summary: {
      total:            items.length,
      done:             byStatus['Done'] || 0,
      inProgress:       byStatus['In progress'] || 0,
      inReview:         byStatus['In review'] || 0,
      toDo:             byStatus['To Do'] || 0,
      unset:            byStatus['Unset'] || 0,
      completionRate:   Math.round(((byStatus['Done'] || 0) / items.length) * 100),
      avgCycleDays:     cycleStats.overall,       // combined best estimate
      avgAgeDays,
      unassignedCount:  items.filter(r => r.assignees.length === 0).length,
    },
    byStatus, byKind, byLabel, byAssignee, byAuthor,
    byMilestone, milestoneStatus, teamStatus, ageBuckets, byDate,
    cycleStats,
    items: items.map(r => ({
      number:    r.number,
      title:     r.title,
      state:     r.state,
      status:    r.status,
      kind:      r.kind,
      author:    r.author,
      labels:    r.labels,
      assignees: r.assignees,
      milestone: r.milestone,
      createdAt: r.createdAt,
      closedAt:  r.closedAt,
      ageDays:   Math.floor((now - new Date(r.createdAt)) / 864e5),
    })),
  };
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────
async function main() {
  const dataDir     = path.join(__dirname, '..', 'data');
  const metricsPath = path.join(dataDir, 'metrics.json');
  const historyPath = path.join(dataDir, 'history.json');
  fs.mkdirSync(dataDir, { recursive: true });

  console.log('Fetching project items...');
  const items = await fetchAllItems();
  console.log(`Total items fetched: ${items.length}`);

  console.log('Updating status history...');
  const history    = loadHistory(historyPath);
  const newHistory = updateHistory(items, history);
  fs.writeFileSync(historyPath, JSON.stringify(newHistory, null, 2));
  console.log(`History written to ${historyPath}`);

  console.log('Computing metrics...');
  const cycleStats = computeCycleStats(items, newHistory);
  const metrics    = computeMetrics(items, cycleStats);
  fs.writeFileSync(metricsPath, JSON.stringify(metrics, null, 2));

  console.log(`Metrics written to ${metricsPath}`);
  console.log(`Cycle time: ${cycleStats.overall ?? 'N/A'} days avg (${cycleStats.completedCount} completed items)`);
  console.log(`  History-based: ${cycleStats.overallHistory ?? 'N/A'} days | closedAt-based: ${cycleStats.overallClosed ?? 'N/A'} days`);
  console.log(`Summary: ${metrics.summary.total} items, ${metrics.summary.done} done, ${metrics.summary.completionRate}% complete`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
