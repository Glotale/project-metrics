# Glotale Project Metrics Dashboard

Live dashboard tracking [Glotale Task Management](https://github.com/orgs/Glotale/projects/10) board metrics.

## Setup

1. **Create a PAT** with `read:project` and `repo` scopes at https://github.com/settings/tokens
2. **Add it as a secret** in this repo: Settings → Secrets → Actions → `PROJECT_TOKEN`
3. The GitHub Action runs every 6 hours and on every push to `main`

## What it tracks

- Status distribution (To Do / In Progress / In Review / Done)
- Team breakdown by status (Operations, Sales, Digital Marketing, etc.)
- Ticket creators — who opens the most work
- Assignee workload — who owns the most items
- Average cycle time (days from creation to close)
- Average age of open items
- Items created over time (last 60 days)
- Milestone progress (Q1 vs Q2)
- Stale and unassigned items

## Manual refresh

Go to Actions → "Update Project Metrics" → Run workflow
