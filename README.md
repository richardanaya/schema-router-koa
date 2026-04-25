# dbvg-rest-koa

Zero-code Koa REST routes from a [database-validator-generator](https://github.com/richardanaya/database-validator-generator) schema.

If you already have a `schemas.mjs` file generated from your PostgreSQL database, this package turns it into a fully validated REST API in a single function call. No manual route definitions, no hand-written validators, no SQL injection risk.

## The workflow

1. Run `dbvg generate` against your database to get `schemas.mjs`
2. Pass that module to `dbvg-rest-koa`
3. You now have CRUD endpoints for every table

## Quick start

```sh
npm install dbvg-rest-koa @koa/router koa koa-bodyparser pg zod
```

```js
import Koa from "koa";
import bodyParser from "koa-bodyparser";
import pg from "pg";
import * as dbvg from "./schemas.mjs";
import { createKoaRestRouter } from "dbvg-rest-koa";

const app = new Koa();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

app.use(bodyParser());

const api = createKoaRestRouter(dbvg, pool, { prefix: "/api" });
app.use(api.routes());
app.use(api.allowedMethods());

app.listen(3000);
```

For a `users` table, you immediately get:

```
GET    /api/users           → list with ?limit= & ?offset=
GET    /api/users/:pk_id    → get one by primary key
POST   /api/users           → insert (validated)
PATCH  /api/users/:pk_id    → update (validated)
DELETE /api/users/:pk_id    → remove
```

Composite primary keys work automatically:

```
GET /api/order_items/:pk_orderId/:pk_productId
```

## How it works

This package consumes the generated contract (`metadata`, `rowSchemas`, `insertSchemas`, `updateSchemas`) and builds Koa routes from it. It does not introspect your database again — everything it needs is already in `schemas.mjs`.

- **POST** bodies are validated against the insert schema before touching the database
- **PATCH** bodies are validated against the update schema before touching the database
- **Returned rows** are parsed through the row schema before being sent to the client
- All SQL identifiers are quoted; all values are parameterized

## Options

```js
createKoaRestRouter(dbvg, pool, {
  prefix: "/api",        // route prefix
  limit: 50,             // default page size
  maxLimit: 500,         // max allowed ?limit=
  tables: ["*"],         // glob patterns for which tables to expose (default all)
  excludeTables: [],     // glob patterns for tables to hide
  title: "My API",       // OpenAPI title
  version: "1.0.0",      // OpenAPI version
  intercept: async (body, schema, ctx) => {
    // authorization hook: runs after validation, before database
  },
});
```

### Exposing only some tables

```js
// Only user-facing tables
tables: ["users", "projects", "tasks"]

// Exclude audit/internal tables
excludeTables: ["audit_*", "internal_*"]
```

### Authorization with `intercept`

Use `intercept` to enforce ownership or role checks from your auth middleware:

```js
createKoaRestRouter(dbvg, pool, {
  intercept: async (body, schema, ctx) => {
    // ctx.state.user was set by upstream JWT middleware
    if (schema === dbvg.insertSchemas.projects && body.owner_id !== ctx.state.user.id) {
      ctx.status = 403;
      ctx.body = { error: "You can only create your own projects" };
    }
  },
});
```

The hook receives:

- `body` — the Zod-validated JSON body
- `schema` — the Zod schema that validated it (useful for `===` checks)
- `ctx` — the full Koa context

Set `ctx.status` and `ctx.body` inside `intercept` to reject a request early. The database is never touched if you do.

### OpenAPI spec

A cached OpenAPI 3.0 spec is available at:

```
GET /api/openapi.json
```

It includes all registered paths, schemas, and parameters derived directly from the generated metadata.

## Requirements

- Node.js ≥ 18
- [database-validator-generator](https://github.com/richardanaya/database-validator-generator) (to generate `schemas.mjs`)
- Koa 2.x or 3.x

## License

MIT
