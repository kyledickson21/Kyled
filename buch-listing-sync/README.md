# Buch Realty Listing Sync

In-between service: Spark API (Columbus REALTORS MLS) → Zapier webhook (Catch Hook) → REsimpli.

Polls Spark every `POLL_INTERVAL_MINUTES` for listings modified since the last check
(via the Broker Back Office – Full MLS API feed, including `PrivateRemarks` /
`ShowingInstructions`) and POSTs each one as JSON to a Zapier Catch Hook webhook.

Compliance: never logs full listing bodies or confidential fields — only counts and IDs.
Secrets are read from environment variables only, never committed.

## Local dev

```
npm install
npm run selftest   # spins up fake Spark + Zapier servers, must print SELF-TEST PASSED
cp .env.example .env   # fill in real values, or leave blank to see the "not connected yet" notice
npm start
```

## Deploy (Render — background worker + persistent disk)

A plain serverless/cron deploy loses `state.json` between runs, so this needs a
worker with a disk. `render.yaml` in this folder defines exactly that: a
Background Worker (`buch-listing-sync`) with a 1GB disk mounted at `/data`,
`STATE_FILE=/data/state.json`, and `POLL_INTERVAL_MINUTES=15`.

Step by step:
1. Go to https://dashboard.render.com and sign up / log in (GitHub login is easiest).
2. Click **New +** → **Blueprint**.
3. Connect your GitHub account if prompted, then select the `kyled` repo
   (branch: whichever branch has this folder — currently `claude/here-cpwrtg`,
   or `main` after merging).
4. Render detects `buch-listing-sync/render.yaml` and shows the `buch-listing-sync`
   worker plan. Click **Apply**.
5. When prompted for the two env vars marked "secret" (`SPARK_ACCESS_TOKEN`,
   `ZAPIER_WEBHOOK_URL`), leave them blank for now — the service starts fine
   without them and logs a "not connected yet" line.
6. Click **Create Blueprint / Deploy**. First deploy takes a minute or two.

### Set the real secrets later

Render dashboard → the `buch-listing-sync` service → **Environment** tab →
edit `SPARK_ACCESS_TOKEN` and `ZAPIER_WEBHOOK_URL` → **Save Changes**. Render
redeploys automatically and the next poll cycle will use them — no code changes
needed.

### View logs

Render dashboard → the `buch-listing-sync` service → **Logs** tab (live
tail). Only timestamps, counts, and listing IDs are ever logged — no
private remarks or showing instructions.

### Cost

Render Starter worker (~$7/mo) + 1GB disk (~$0.25/mo). Cheapest alternative
if that's too much: a $4-6/mo VPS (e.g. Hetzner/DigitalOcean) running this
under systemd with `state.json` on local disk — ask if you'd rather go that
route and I'll write the systemd unit + setup script.
