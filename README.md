# schema-router-koa

Zero-code Koa REST routes from a [database-validator-generator](https://github.com/richardanaya/database-validator-generator) schema.

If you already have a `schemas.mjs` file generated from your PostgreSQL database, this package turns it into a fully validated REST API in a single function call. No manual route definitions, no hand-written validators, no SQL injection risk.

## The workflow

1. Run `dbvg generate` against your database to get `schemas.mjs`
2. Pass that module to `dbvg-rest-koa`
3. You now have CRUD endpoints for every table

## Quick start

```sh
npm install schema-router-koa @koa/router koa koa-bodyparser pg zod
```

```js
import Koa from "koa";
import bodyParser from "koa-bodyparser";
import pg from "pg";
import * as dbvg from "./schemas.mjs";
import { createSchemaRestRouter } from "schema-router-koa";

const app = new Koa();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

app.use(bodyParser());

const api = createSchemaRestRouter(dbvg, pool, { prefix: "/api" });
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
createSchemaRestRouter(dbvg, pool, {
  prefix: "/api",        // route prefix
  limit: 50,             // default page size
  maxLimit: 500,         // max allowed ?limit=
  tables: ["*"],         // glob patterns for which tables to expose (default all)
  excludeTables: [],     // glob patterns for tables to hide
  title: "My API",       // OpenAPI title
  version: "1.0.0",      // OpenAPI version
  cors: true,             // permissive CORS for browser apps
  policies: {
    scope: (ctx, tableName, tableMeta) => ({ owner_id: ctx.state.user.id }),
    insert: (body, ctx, tableName, tableMeta) => ({ ...body, owner_id: ctx.state.user.id }),
  },
});
```

### Permissive CORS

Pass `cors: true` to allow browser clients from any origin and answer preflight requests automatically:

```js
const api = createSchemaRestRouter(dbvg, pool, {
  prefix: "/api",
  cors: true,
});
```

For tighter control, pass an object:

```js
cors: {
  origin: "https://app.example.com",
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  headers: ["Content-Type", "Authorization"],
  credentials: true,
  maxAge: 86400,
}
```

### Exposing only some tables

```js
// Only user-facing tables
tables: ["users", "projects", "tasks"]

// Exclude audit/internal tables
excludeTables: ["audit_*", "internal_*"]
```

### Authorization with `policies`

Use `policies` to scope generated queries from your auth middleware:

```js
createSchemaRestRouter(dbvg, pool, {
  policies: {
    // ctx.state.user was set by upstream JWT middleware
    scope: (ctx, tableName, tableMeta) => {
      if (!tableMeta.columns.owner_id) {
        return {};
      }

      return { owner_id: ctx.state.user.id };
    },
    insert: (body, ctx, tableName, tableMeta) => {
      if (!tableMeta.columns.owner_id) {
        return body;
      }

      return { ...body, owner_id: ctx.state.user.id };
    },
  },
});
```

The policy hooks are global:

- `scope(ctx, tableName, tableMeta)` returns column/value constraints that are added to generated `GET`, `PATCH`, and `DELETE` statements.
- `insert(body, ctx, tableName, tableMeta)` returns the body to validate and insert, which lets server code force ownership fields instead of trusting clients.

Both hooks also receive `tableName` and `tableMeta`, so one policy can decide which tables should be scoped.

With the example above, list and item routes only see rows owned by the current user:

```sql
select * from "projects" where "owner_id" = $1 limit $2 offset $3
select * from "projects" where "id" = $1 and "owner_id" = $2
```

Updates and deletes use the same ownership predicate. If a row exists but is not owned by the current user, item routes return `404` rather than revealing that the row exists.

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
