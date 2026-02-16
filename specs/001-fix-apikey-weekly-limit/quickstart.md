# Quickstart: Verify weeklyCostLimit Fix

## Prerequisites

- Running Redis instance
- Service started: `npm run dev`
- Admin credentials from `data/init.json`

## Verification Steps

### 1. Create API Key with Weekly Limit

```bash
# Login to get admin session token
curl -X POST http://localhost:3000/admin/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"<from init.json>"}'

# Create key with weeklyCostLimit
curl -X POST http://localhost:3000/admin/api-keys \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <token>' \
  -d '{
    "name": "test-weekly-limit",
    "weeklyCostLimit": 500
  }'

# Expected: response includes weeklyCostLimit: 500
```

### 2. Verify in Key List

```bash
curl http://localhost:3000/admin/api-keys \
  -H 'Authorization: Bearer <token>'

# Expected: the created key shows weeklyCostLimit: 500
```

### 3. Verify via Edit Form

Open admin panel at `http://localhost:3000/admin-next/` → API Keys
→ Click edit on the test key → Weekly cost limit field shows 500.

### 4. Batch Create Verification

```bash
curl -X POST http://localhost:3000/admin/api-keys/batch \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <token>' \
  -d '{
    "baseName": "batch-test",
    "count": 2,
    "weeklyCostLimit": 300
  }'

# Expected: both keys have weeklyCostLimit: 300
```

### 5. Default Behavior (No Limit Set)

```bash
curl -X POST http://localhost:3000/admin/api-keys \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <token>' \
  -d '{"name": "test-no-limit"}'

# Expected: weeklyCostLimit defaults to 0
```
