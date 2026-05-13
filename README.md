# Philtronics – Time to Complete

Shopfloor assembly-timing system for Philtronics Ltd.  
Touch-first tablet UI · Role-based access · CSV export · Audit trail.

---

## Quick local run

```bash
git clone <your-repo>
cd philtronics
cp .env.example server/.env          # edit JWT_SECRET at minimum
cd server && npm install
node seed.js                          # creates DB + default users
node server.js
# → open http://localhost:3000
```

---

## Deploy to Railway (free proof-of-concept)

Railway gives **$5 free credit/month** on the Hobby plan — enough to run this  
app continuously for a proof-of-concept with no credit card required.

### Step 1 – Push to GitHub

```bash
git init
git add .
git commit -m "Initial commit"
# create a repo on github.com, then:
git remote add origin https://github.com/YOUR_ORG/philtronics-ttc.git
git push -u origin main
```

### Step 2 – Create Railway project

1. Go to [railway.app](https://railway.app) → **Start a New Project**
2. Choose **Deploy from GitHub repo** → select your repo
3. Railway will detect the `Dockerfile` automatically

### Step 3 – Add a Persistent Volume (for SQLite)

> Without this the database resets every deploy. Takes 30 seconds.

1. In your Railway project, click **+ New** → **Volume**
2. Name it `philtronics-data`
3. Set **Mount Path** to `/data`
4. Attach it to your service

### Step 4 – Set environment variables

In Railway dashboard → your service → **Variables** tab, add:

| Variable | Value |
|---|---|
| `JWT_SECRET` | A 64-char random hex string (see below) |
| `JWT_EXPIRES_IN` | `8h` |
| `DB_PATH` | `/data/philtronics.db` |
| `NODE_ENV` | `production` |
| `BCRYPT_ROUNDS` | `12` |
| `LOGIN_RATE_LIMIT` | `10` |

Generate a JWT secret:
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

### Step 5 – Deploy

Railway deploys automatically on every `git push`.  
The seed script runs on first start and creates the default users.

### Step 6 – Get your URL

Railway assigns a public URL like `https://philtronics-ttc.up.railway.app`.  
Find it under **Settings → Networking → Public URL** in your service.

---

## Default login credentials

> ⚠️ **Change these immediately after first login.**

| Username | Password | Role |
|---|---|---|
| `admin` | `ChangeMeNow!` | Administrator |
| `manager1` | `Manager123!` | Manager |
| `supervisor1` | `Super123!` | Supervisor |
| `operator1` | `Oper123!` | Operator |
| `operator2` | `Oper123!` | Operator |

To reset a password: log in as `admin` → Admin → Reset PW button next to the user.

---

## Roles & permissions

| Permission | Operator | Supervisor | Manager | Administrator |
|---|:---:|:---:|:---:|:---:|
| Start/stop own timer | ✓ | ✓ | ✓ | ✓ |
| View own history | ✓ | ✓ | ✓ | ✓ |
| View all operators | | ✓ | ✓ | ✓ |
| Cancel/adjust timers | | ✓ | ✓ | ✓ |
| Dashboard & CSV export | | | ✓ | ✓ |
| User management | | | | ✓ |

---

## API endpoints

```
POST   /api/auth/login
POST   /api/auth/logout
GET    /api/me

POST   /api/timers/start
POST   /api/timers/:id/stop
POST   /api/timers/:id/cancel        (reason required)
PATCH  /api/timers/:id               (adjust times, Supervisor+)
GET    /api/timers                   (role-filtered)
GET    /api/timers/:id

GET    /api/export/csv               (Manager+, query params: from/to/operatorId/itemNumber)
GET    /api/export/stats             (Manager+)

GET    /api/users                    (Admin only)
POST   /api/users
PATCH  /api/users/:id
POST   /api/users/:id/reset-password

GET    /api/items?q=                 (autocomplete, authenticated)
```

---

## Project structure

```
philtronics/
├── Dockerfile
├── railway.toml
├── package.json          ← root (delegates to server/)
├── .env.example
├── .gitignore
├── public/
│   ├── index.html
│   ├── styles.css
│   └── app.js
└── server/
    ├── package.json
    ├── server.js
    ├── db.js
    ├── seed.js
    ├── migrations/
    │   ├── runner.js
    │   └── 001_initial_schema.sql
    ├── middleware/
    │   ├── auth.js
    │   └── validate.js
    └── routes/
        ├── auth.js
        ├── timers.js
        ├── export.js
        └── users.js
```

---

## Security notes

- Passwords hashed with **bcrypt** (12 rounds)
- Auth via **httpOnly, SameSite=Strict JWT cookie** (never localStorage)
- Login **rate-limited** (10 attempts / 15 min / IP)
- All input validated server-side with **Joi**
- RBAC enforced on every protected route
- Security headers: X-Frame-Options, X-Content-Type-Options, CSP
- Audit log for all cancellations and adjustments

---

## Changing the admin password (CLI)

```bash
cd server
node -e "
const db = require('./db');
const bcrypt = require('bcrypt');
bcrypt.hash('YourNewPassword!', 12).then(h => {
  db.prepare('UPDATE users SET password_hash=? WHERE username=?').run(h,'admin');
  console.log('Done');
});
"
```
