# Local setup

From a fresh clone to a running system with demo data and passing tests.

## 1. Prerequisites
- **Docker Desktop** (or Docker Engine) with Compose v2. That's all you need to run and test.
- Optional, only to run code outside containers: Node.js 22+.

Ports used on your machine: **8080** (web), 3000 (API), 4000 (mock WhatsApp), 5433 (Postgres), 6380 (Redis). Free them first if something else uses them.

## 2. Start everything
```bash
git clone <repo-url> certiflow
cd certiflow
docker compose up --build
```
The first build takes a few minutes. You're ready when `docker compose ps` shows `api`, `worker` (×2), `mock-whatsapp` and `web` running and `migrate` exited with code 0.

Open **http://localhost:8080**.

Demo data is loaded automatically:
| Batch | State | Try |
|---|---|---|
| Electrician batch (Anika) | Draft | Upload a file, submit |
| Retail associate batch 14 | District review, Kabir already approved | Approve as Dev or Meera |
| Data entry operators batch 7 | State review | Final approve as Farah, watch certificates go out |
| Plumbing batch 3 | Issued on startup | Verify and cancel certificates |
| Welding batch 2 (Nagpur) | District review | Only Ravi can see it; Pune officers can't |

## 3. A five-minute tour of the key moments
1. **Bad spreadsheet (moment 1):** pick **Anika** → create a batch → upload `samples/bad-mixed-errors.csv`. Every problem is listed by row and column; nothing is saved. Upload `samples/good-60-candidates.csv` → 60 candidates → **Submit**.
2. **District review (moment 2):** pick **Dev** → *Waiting for me* → open the batch → Approve. Pick **Meera** → Approve. It moves on once (60 > 50, so it goes to Neha). To see the race itself, run the concurrency test (below) or approve as Dev and Meera within the same second from two tabs.
3. **Quality and final approval (moment 3):** **Neha** approves, then **Farah** approves. Open **Phones (demo)**: each of the 60 candidates gets exactly one message, even though the stand-in provider fails 20% of calls and times out on 10%. The counters show failures, timeouts and duplicates blocked. Click a message's download link to get the PDF.
4. **Cancel and verify (moment 4):** as **Farah**, open **Certificates** → *Cancel certificate* with a reason. Open the PDF's QR code or use **Verify** with its number and code: it says **Cancelled: not valid**.
5. **Stuck batch (moment 5):** leave any batch in review for 3 minutes (`SLA_MINUTES` in `docker-compose.yml`). Farah gets a live alert and the batch shows **Overdue** under **In review**.
6. **Send back and resubmit (moment 6):** as an officer, write a reason → **Send back**. As Anika, fix and resubmit. The decisions panel shows earlier votes greyed out as "no longer counted".
7. **WhatsApp outage:** on **Phones (demo)** click *Simulate WhatsApp outage*, approve a batch, and watch retries in the Certificates list and batch history. After ~4 minutes deliveries are marked *Failed*; end the outage and use *Retry WhatsApp*.

## 4. Run the tests
```bash
docker compose --profile test run --rm --build test
```
This applies migrations to a separate `certiflow_test` database and runs all tests against real Postgres and Redis. Expected: `Tests 42 passed`.

Outside Docker (with Postgres and Redis from compose running):
```bash
cd api && npm ci
DATABASE_URL=postgresql://certiflow:certiflow@localhost:5433/certiflow_test npx prisma migrate deploy
npx vitest run
```

## 5. Useful commands
```bash
docker compose logs -f worker          # watch issuance, retries, escalations
docker compose up -d --scale worker=4  # more workers: still exactly one certificate each
docker compose restart redis           # queues survive (AOF); unsent events stay in the Postgres outbox
docker compose down -v                 # stop and wipe all data (fresh demo next time)
```

## 6. Developing without containers
Run Postgres and Redis from compose (`docker compose up -d postgres redis`), then:
```bash
cd api && npm ci
export DATABASE_URL=postgresql://certiflow:certiflow@localhost:5433/certiflow REDIS_URL=redis://localhost:6380 \
  JWT_SECRET=local-dev-jwt-secret-123456 CERT_SIGNING_SECRET=local-dev-cert-secret-123456 PUBLIC_BASE_URL=http://localhost:5173 SLA_MINUTES=3
npx prisma migrate deploy && npx tsx src/seed.ts
npx tsx src/mock-whatsapp/server.ts &   # port 4000
npx tsx src/worker.ts &
npx tsx src/server.ts                   # port 3000
cd ../web && npm ci && npm run dev      # http://localhost:5173 (proxies /api)
```

## Troubleshooting
- **Port already allocated:** another service uses one of the ports above; stop it or change the left-hand port in `docker-compose.yml`.
- **`certiflow_test` does not exist:** the test database is created only when the Postgres volume is first created. Run `docker compose down -v` once, then start again.
- **Nothing updates live:** the green **Live** dot in the persona bar should be on; reload the page if your network dropped.
