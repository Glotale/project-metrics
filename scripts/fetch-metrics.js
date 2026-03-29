#!/usr/bin/env node
// Fetches project board data from GitHub Projects v2 API and writes data/metrics.json
// Requires: GH_TOKEN env var with read:project + repo scopes

const https = require('https');
const fs = require('fs');
const path = require('path');

const ORG = 'Glotale';
const PROJECT_NUMBER = 10;
const TOKEN = process.env.GH_TOKEN;

if (!TOKEN) {
  console.error('GH_TOKEN environment variable is required');
  process.exit(1);
}

function graphql(query, variables = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query, variables });
    const options = {
      hostname: 'api.github.com',
      path: '/graphql',
      method: 'POST',
      headers: {
        'Authorization': `bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'glotale-metrics-bot/1.0'
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function fetchAllItems() {
  const allItems = [];
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const query = `
      query($org: String!, $number: Int!, $cursor: String) {
        organization(login: $org) {
          projectV2(number: $number) {
            title
            items(first: 50, after: $cursor) {
              pageInfo { hasNextPage endCursor }
              totalCount
              nodes {
                id
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
                    number
                    title
                    state
                    createdAt
                    closedAt
                    author { login }
                    labels(first: 10) { nodes { name color } }
                    assignees(first: 5) { nodes { login } }
                    milestone { title dueOn }
                  }
                  ... on PullRequest {
                    number
                    title
                    state
                    createdAt
                    closedAt
                    author { login }
                    labels(first: 10) { nodes { name color } }
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

    const project = result.data.organization.projectV2;
    const page = project.items;
    hasNextPage = page.pageInfo.hasNextPage;
    cursor = page.pageInfo.endCursor;

    for (const item of page.nodes) {
      const content = item.content;
      if (!content) continue;

      const fvs = item.fieldValues.nodes;
      let status = null, kind = null, size = null, sprint = null;

      for (const fv of fvs) {
        if (!fv || !fv.field) continue;
        const fname = fv.field.name;
        if (fname === 'Status') status = fv.name;
        else if (fname === 'Kind') kind = fv.name;
        else if (fname === 'Size') size = fv.name || fv.number;
        else if (fname === 'Sprint') sprint = fv.title;
      }

      allItems.push({
        number: content.number,
        title: content.title,
        state: content.state,
        status,
        kind,
        size,
        sprint,
        author: content.author?.login || null,
        labels: (content.labels?.nodes || []).map(l => l.name),
        assignees: (content.assignees?.nodes || []).map(a => a.login),
        milestone: content.milestone?.title || null,
        milestoneDue: content.milestone?.dueOn || null,
        createdAt: content.createdAt,
        closedAt: content.closedAt,
      });
    }

    console.log(`Fetched ${allItems.length} items so far...`);
  }

  return allItems;
}

function computeMetrics(items) {
  const now = new Date();
  const TEAMS = ['Operations', 'Digital marketing', 'Sales', 'Coaching/Delivery', 'Product'];
  const STATUSES = ['To Do', 'In progress', 'In review', 'Done', 'Unset'];

  const byStatus = {}, byKind = {}, byLabel = {}, byAssignee = {}, byMilestone = {}, byAuthor = {};

  items.forEach(r => {
    const s = r.status || 'Unset';
    byStatus[s] = (byStatus[s] || 0) + 1;
    const k = r.kind || 'Unset';
    byKind[k] = (byKind[k] || 0) + 1;
    r.labels.forEach(l => { byLabel[l] = (byLabel[l] || 0) + 1; });
    r.assignees.forEach(a => { byAssignee[a] = (byAssignee[a] || 0) + 1; });
    const m = r.milestone || 'None';
    byMilestone[m] = (byMilestone[m] || 0) + 1;
    if (r.author) byAuthor[r.author] = (byAuthor[r.author] || 0) + 1;
  });

  // Milestone x Status
  const milestoneStatus = {};
  ['Q1 2026', 'Q2 2026', 'None'].forEach(m => {
    milestoneStatus[m] = {};
    STATUSES.forEach(s => milestoneStatus[m][s] = 0);
    items.filter(r => (r.milestone || 'None') === m).forEach(r => {
      milestoneStatus[m][r.status || 'Unset']++;
    });
  });

  // Team x Status
  const teamStatus = {};
  TEAMS.forEach(t => {
    teamStatus[t] = {};
    STATUSES.forEach(s => teamStatus[t][s] = 0);
    items.filter(r => r.labels.includes(t)).forEach(r => {
      teamStatus[t][r.status || 'Unset']++;
    });
  });

  // Cycle time for closed items
  const closedItems = items.filter(r => r.closedAt && r.createdAt);
  const avgCycleDays = closedItems.length
    ? Math.round(closedItems.reduce((a, r) => a + (new Date(r.closedAt) - new Date(r.createdAt)) / (1000 * 60 * 60 * 24), 0) / closedItems.length)
    : null;

  // Average age of open items
  const openItems = items.filter(r => r.state === 'OPEN');
  const avgAgeDays = openItems.length
    ? Math.round(openItems.reduce((a, r) => a + (now - new Date(r.createdAt)) / (1000 * 60 * 60 * 24), 0) / openItems.length)
    : 0;

  // Age buckets
  const ageBuckets = { '0-7 days': 0, '8-14 days': 0, '15-30 days': 0, '30+ days': 0 };
  openItems.forEach(r => {
    const age = Math.floor((now - new Date(r.createdAt)) / (1000 * 60 * 60 * 24));
    if (age <= 7) ageBuckets['0-7 days']++;
    else if (age <= 14) ageBuckets['8-14 days']++;
    else if (age <= 30) ageBuckets['15-30 days']++;
    else ageBuckets['30+ days']++;
  });

  // Items created by date (last 60 days)
  const byDate = {};
  const cutoff = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
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
      total: items.length,
      done: byStatus['Done'] || 0,
      inProgress: byStatus['In progress'] || 0,
      inReview: byStatus['In review'] || 0,
      toDo: byStatus['To Do'] || 0,
      unset: byStatus['Unset'] || 0,
      completionRate: Math.round(((byStatus['Done'] || 0) / items.length) * 100),
      avgCycleDays,
      avgAgeDays,
      unassignedCount: items.filter(r => r.assignees.length === 0).length,
    },
    byStatus,
    byKind,
    byLabel,
    byAssignee,
    byAuthor,
    byMilestone,
    milestoneStatus,
    teamStatus,
    ageBuckets,
    byDate,
    items: items.map(r => ({
      number: r.number,
      title: r.title,
      state: r.state,
      status: r.status,
      kind: r.kind,
      author: r.author,
      labels: r.labels,
      assignees: r.assignees,
      milestone: r.milestone,
      createdAt: r.createdAt,
      closedAt: r.closedAt,
      ageDays: Math.floor((now - new Date(r.createdAt)) / (1000 * 60 * 60 * 24)),
    })),
  };
}

async function main() {
  console.log('Fetching project items...');
  const items = await fetchAllItems();
  console.log(`Total items fetched: ${items.length}`);

  const metrics = computeMetrics(items);

  const outPath = path.join(__dirname, '..', 'data', 'metrics.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(metrics, null, 2));
  console.log(`Metrics written to ${outPath}`);
  console.log(`Summary: ${metrics.summary.total} items, ${metrics.summary.done} done, ${metrics.summary.completionRate}% complete`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
