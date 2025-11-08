# BSUBIKERENTAL-BACKEND

## Tracker ingestion configuration

Add the following environment variable to your backend runtime (e.g. `.env.local`, deployment secrets, or host environment):

```
IOT_SHARED_SECRET=change-me-strong
```

Use this value as the Bearer token when the tracker posts to `/tracker`:

```
Authorization: Bearer <IOT_SHARED_SECRET>
```

