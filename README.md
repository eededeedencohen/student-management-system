# Student Management System - Server

Backend for **שק"ל**, a student registration, sales, cash-flow, commissions and goals
management system for a Hebrew coaching-courses business. Built as a MERN server that also
**serves the production client build**, so the whole app runs from this single service.

> **Stack:** Node.js (ESM) · Express · MongoDB (Mongoose) · JWT auth

## Features

- **Auth & roles** - passwordless pick-a-user login, manager / rep roles, super-admin
  "view as" (impersonation), rep-scoped data access.
- **Deals & payments** - registrations with unified payment schedules, per-installment
  confirmation, reconciliation self-checks.
- **Dashboards** - KPIs per period & per rep, cash-flow forecast, commissions & salary
  (with prorated base and salary/income ratio), rep & manager goals.
- **Courses** - catalog + Gantt, with best-effort enrollment matching of messy deal data.
- **Excel** - imports the source workbooks and exports per-student / debtor / course files.

## Getting started

```bash
npm install
cp .env.example .env      # then fill in your MongoDB connection + secrets
npm run import            # (optional) import the source Excel files into MongoDB
npm run seed:users        # (optional) create login users
npm run dev               # start on http://localhost:5000
```

Open **http://localhost:5000** - the API is under `/api/*` and every other route serves
the bundled single-page client (`public/`).

## Environment

See [`.env.example`](.env.example). Required: `DATABASE` + `DATABASE_PASSWORD` (or
`MONGODB_URI`) and `JWT_SECRET`. Optional: `PORT`, `ADMIN_TOKEN`, `CLIENT_ORIGIN`,
`SEED_MORAN_YEAR`, `DATA_DIR`.

## Project layout

```
server/
├── public/              # bundled production client (served by Express)
├── src/
│   ├── models/          # Mongoose schemas
│   ├── controllers/     # domain logic
│   ├── routes/          # API endpoints (/api/*)
│   ├── middleware/      # auth (JWT + roles) + error handling
│   ├── utils/           # normalization, date ranges, tokens, course matching
│   ├── scripts/         # import / seed / maintenance / export scripts
│   ├── app.js           # Express app (API routes + static client + SPA fallback)
│   └── server.js        # DB connection + HTTP listener
└── .env.example         # environment template (no secrets)
```

## Deploying an updated client

The client is bundled into `public/`. To refresh it after a client change:

```bash
# from the client project
npm run build
# copy the build into the server
rm -rf ../server/public && cp -r dist ../server/public
```
