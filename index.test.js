import assert from "node:assert/strict";
import { test } from "node:test";
import Koa from "koa";
import bodyParser from "koa-bodyparser";
import request from "supertest";
import { z } from "zod";
import { createSchemaRestRouter } from "./index.js";

const usersRowSchema = z.object({
  id: z.number().int(),
  email: z.string().email(),
  name: z.string(),
});

const dbvgOutput = {
  rowSchemas: {
    users: usersRowSchema,
  },
  insertSchemas: {
    users: z.object({
      email: z.string().email(),
      name: z.string(),
    }),
  },
  updateSchemas: {
    users: z.object({
      email: z.string().email().optional(),
      name: z.string().optional(),
    }),
  },
  metadata: {
    users: {
      primaryKey: ["id"],
      columns: {
        id: { nullable: false, primaryKey: true },
        email: { nullable: false },
        name: { nullable: false },
      },
    },
  },
};

const policyDbvgOutput = {
  rowSchemas: {
    items: z.object({
      id: z.number().int(),
      owner_id: z.number().int(),
      name: z.string(),
    }),
  },
  insertSchemas: {
    items: z.object({
      owner_id: z.number().int(),
      name: z.string(),
    }),
  },
  updateSchemas: {
    items: z.object({
      name: z.string().optional(),
    }),
  },
  metadata: {
    items: {
      primaryKey: ["id"],
      columns: {
        id: { nullable: false, primaryKey: true },
        owner_id: { nullable: false },
        name: { nullable: false },
      },
    },
  },
};

test("registers CRUD routes from dbvg output registries", async () => {
  const queries = [];
  const queryable = {
    async query(sql, params) {
      queries.push({ sql, params });

      if (sql.startsWith("select * from")) {
        return { rows: [{ id: 1, email: "person@example.com", name: "Person" }], rowCount: 1 };
      }

      if (sql.startsWith("insert into")) {
        return { rows: [{ id: 2, email: params[0], name: params[1] }], rowCount: 1 };
      }

      if (sql.startsWith("update")) {
        return { rows: [{ id: 1, email: "person@example.com", name: params[0] }], rowCount: 1 };
      }

      if (sql.startsWith("delete")) {
        return { rows: [], rowCount: 1 };
      }

      return { rows: [], rowCount: 0 };
    },
  };

  const app = createApp(queryable);

  await request(app.callback()).get("/api/users?limit=10&offset=5").expect(200, [
    { id: 1, email: "person@example.com", name: "Person" },
  ]);
  await request(app.callback()).get("/api/users/1").expect(200, { id: 1, email: "person@example.com", name: "Person" });
  await request(app.callback()).post("/api/users").send({ email: "new@example.com", name: "New" }).expect(201, {
    id: 2,
    email: "new@example.com",
    name: "New",
  });
  await request(app.callback()).patch("/api/users/1").send({ name: "Updated" }).expect(200, {
    id: 1,
    email: "person@example.com",
    name: "Updated",
  });
  await request(app.callback()).delete("/api/users/1").expect(204);

  assert.deepEqual(queries.map((query) => query.sql), [
    "select * from \"users\" limit $1 offset $2",
    "select * from \"users\" where \"id\" = $1",
    "insert into \"users\" (\"email\", \"name\") values ($1, $2) returning *",
    "update \"users\" set \"name\" = $1 where \"id\" = $2 returning *",
    "delete from \"users\" where \"id\" = $1",
  ]);
});

test("returns validation errors from generated insert schemas", async () => {
  const app = createApp({
    async query() {
      throw new Error("should not query on invalid body");
    },
  });

  const response = await request(app.callback()).post("/api/users").send({ email: "not-an-email", name: "New" }).expect(400);

  assert.equal(response.body.error, "Validation failed");
  assert.ok(response.body.issues.length > 0);
});

test("normalizes PostgreSQL numeric strings before response validation", async () => {
  const metricsOutput = {
    rowSchemas: {
      workout_summary: z.object({
        id: z.number().int(),
        score: z.number().nullable(),
        scores: z.array(z.number()),
        total_weight_time: z.union([z.bigint(), z.string()]).nullable(),
      }),
    },
    metadata: {
      workout_summary: {
        view: true,
        primaryKey: [],
        columns: {
          id: { dataType: "integer", udtName: "int4", nullable: false },
          score: { dataType: "numeric", udtName: "numeric", nullable: true },
          scores: { dataType: "ARRAY", udtName: "_numeric", nullable: false },
          total_weight_time: { dataType: "bigint", udtName: "int8", nullable: true },
        },
      },
    },
  };

  const app = new Koa();
  const router = createSchemaRestRouter(metricsOutput, {
    async query() {
      return {
        rows: [{ id: 1, score: "1.25", scores: ["1.25", "2.5"], total_weight_time: "9007199254740993" }],
        rowCount: 1,
      };
    },
  });
  app.use(bodyParser());
  app.use(router.routes());
  app.use(router.allowedMethods());

  await request(app.callback()).get("/api/workout_summary").expect(200, [
    { id: 1, score: 1.25, scores: [1.25, 2.5], total_weight_time: "9007199254740993" },
  ]);
});

test("serves a cached openapi.json spec", async () => {
  const app = createApp({
    async query() {
      return { rows: [], rowCount: 0 };
    },
  });

  const response = await request(app.callback()).get("/api/openapi.json").expect(200);

  assert.equal(response.body.openapi, "3.0.3");
  assert.equal(response.body.info.title, "REST API");
  assert.ok(response.body.paths["/users"]);
  assert.ok(response.body.paths["/users"].get);
  assert.ok(response.body.paths["/users"].post);
  assert.ok(response.body.paths["/users/{pk_id}"]);
  assert.ok(response.body.paths["/users/{pk_id}"].get);
  assert.ok(response.body.paths["/users/{pk_id}"].patch);
  assert.ok(response.body.paths["/users/{pk_id}"].delete);
  assert.ok(response.body.components.schemas.Users);
  assert.ok(response.body.components.schemas.UsersInsert);
  assert.ok(response.body.components.schemas.UsersUpdate);
  assert.deepEqual(response.body.components.schemas.Users.required, ["id", "email", "name"]);
});

test("tables option supports wildcard patterns", async () => {
  const multiDbvg = {
    rowSchemas: {
      users: usersRowSchema,
      app_settings: usersRowSchema,
      audit_log: usersRowSchema,
    },
    metadata: {
      users: { primaryKey: ["id"], columns: { id: { nullable: false } } },
      app_settings: { primaryKey: ["id"], columns: { id: { nullable: false } } },
      audit_log: { primaryKey: ["id"], columns: { id: { nullable: false } } },
    },
  };

  const app = createAppWithOptions(multiDbvg, { tables: ["app_*", "users"] });
  const spec = await request(app.callback()).get("/api/openapi.json").expect(200);

  assert.ok(spec.body.paths["/users"]);
  assert.ok(spec.body.paths["/app_settings"]);
  assert.equal(spec.body.paths["/audit_log"], undefined);
});

test("excludeTables option filters out matched tables", async () => {
  const multiDbvg = {
    rowSchemas: {
      users: usersRowSchema,
      app_settings: usersRowSchema,
      audit_log: usersRowSchema,
    },
    metadata: {
      users: { primaryKey: ["id"], columns: { id: { nullable: false } } },
      app_settings: { primaryKey: ["id"], columns: { id: { nullable: false } } },
      audit_log: { primaryKey: ["id"], columns: { id: { nullable: false } } },
    },
  };

  const app = createAppWithOptions(multiDbvg, { excludeTables: ["audit_*"] });
  const spec = await request(app.callback()).get("/api/openapi.json").expect(200);

  assert.ok(spec.body.paths["/users"]);
  assert.ok(spec.body.paths["/app_settings"]);
  assert.equal(spec.body.paths["/audit_log"], undefined);
});

test("throws when tables pattern matches nothing", () => {
  assert.throws(
    () => createSchemaRestRouter(dbvgOutput, { async query() {} }, { tables: ["nonexistent_*"] }),
    /Pattern "nonexistent_\*" in tables does not match any table/,
  );
});

test("throws when excludeTables pattern matches nothing", () => {
  assert.throws(
    () => createSchemaRestRouter(dbvgOutput, { async query() {} }, { excludeTables: ["nonexistent_*"] }),
    /Pattern "nonexistent_\*" in excludeTables does not match any table/,
  );
});

test("does not add CORS headers by default", async () => {
  const app = createApp({
    async query() {
      return { rows: [], rowCount: 0 };
    },
  });

  const response = await request(app.callback()).get("/api/users").expect(200);

  assert.equal(response.headers["access-control-allow-origin"], undefined);
});

test("cors true adds permissive headers", async () => {
  const app = createAppWithOptions(dbvgOutput, { cors: true });

  const response = await request(app.callback()).get("/api/users").expect(200);

  assert.equal(response.headers["access-control-allow-origin"], "*");
  assert.equal(response.headers["access-control-allow-methods"], "GET, POST, PATCH, DELETE, OPTIONS");
  assert.equal(response.headers["access-control-allow-headers"], "Content-Type, Authorization");
});

test("cors true answers preflight without querying", async () => {
  const app = createAppWithQueryAndOptions(dbvgOutput, {
    async query() {
      throw new Error("should not query on preflight");
    },
  }, { cors: true });

  await request(app.callback())
    .options("/api/users")
    .set("Origin", "https://example.com")
    .set("Access-Control-Request-Method", "POST")
    .expect(204)
    .expect("Access-Control-Allow-Origin", "*");
});

test("cors object supports custom origin, headers, methods, credentials, and max age", async () => {
  const app = createAppWithOptions(dbvgOutput, {
    cors: {
      origin: "https://app.example.com",
      methods: ["GET", "OPTIONS"],
      headers: ["Content-Type", "X-Client"],
      credentials: true,
      maxAge: 3600,
    },
  });

  const response = await request(app.callback()).options("/api/users").expect(204);

  assert.equal(response.headers["access-control-allow-origin"], "https://app.example.com");
  assert.equal(response.headers["access-control-allow-methods"], "GET, OPTIONS");
  assert.equal(response.headers["access-control-allow-headers"], "Content-Type, X-Client");
  assert.equal(response.headers["access-control-allow-credentials"], "true");
  assert.equal(response.headers["access-control-max-age"], "3600");
});

test("cors credentials reflect request origin when origin is wildcard", async () => {
  const app = createAppWithOptions(dbvgOutput, {
    cors: {
      credentials: true,
    },
  });

  const response = await request(app.callback())
    .get("/api/users")
    .set("Origin", "https://app.example.com")
    .expect(200);

  assert.equal(response.headers["access-control-allow-origin"], "https://app.example.com");
  assert.equal(response.headers["access-control-allow-credentials"], "true");
});

function createApp(queryable) {
  const app = new Koa();
  const router = createSchemaRestRouter(dbvgOutput, queryable);

  app.use(bodyParser());
  app.use(router.routes());
  app.use(router.allowedMethods());

  return app;
}

test("policies scope list, read, update, and delete queries", async () => {
  const queries = [];
  const app = createAppWithQueryAndOptions(policyDbvgOutput, {
    async query(sql, params) {
      queries.push({ sql, params });

      if (sql.startsWith("select * from")) {
        return { rows: [{ id: 1, owner_id: 7, name: "Owned" }], rowCount: 1 };
      }

      if (sql.startsWith("update")) {
        return { rows: [{ id: 1, owner_id: 7, name: params[0] }], rowCount: 1 };
      }

      if (sql.startsWith("delete")) {
        return { rows: [], rowCount: 1 };
      }

      return { rows: [], rowCount: 0 };
    },
  }, policyOptions());

  await request(app.callback()).get("/api/items?limit=10&offset=5").expect(200, [{ id: 1, owner_id: 7, name: "Owned" }]);
  await request(app.callback()).get("/api/items/1").expect(200, { id: 1, owner_id: 7, name: "Owned" });
  await request(app.callback()).patch("/api/items/1").send({ name: "Updated" }).expect(200, {
    id: 1,
    owner_id: 7,
    name: "Updated",
  });
  await request(app.callback()).delete("/api/items/1").expect(204);

  assert.deepEqual(queries, [
    { sql: "select * from \"items\" where \"owner_id\" = $1 limit $2 offset $3", params: [7, 10, 5] },
    { sql: "select * from \"items\" where \"id\" = $1 and \"owner_id\" = $2", params: ["1", 7] },
    { sql: "update \"items\" set \"name\" = $1 where \"id\" = $2 and \"owner_id\" = $3 returning *", params: ["Updated", "1", 7] },
    { sql: "delete from \"items\" where \"id\" = $1 and \"owner_id\" = $2", params: ["1", 7] },
  ]);
});

test("policies transform inserts before validation and database writes", async () => {
  const queries = [];
  const app = createAppWithQueryAndOptions(policyDbvgOutput, {
    async query(sql, params) {
      queries.push({ sql, params });
      return { rows: [{ id: 2, owner_id: params[0], name: params[1] }], rowCount: 1 };
    },
  }, policyOptions());

  await request(app.callback()).post("/api/items").send({ name: "New" }).expect(201, {
    id: 2,
    owner_id: 7,
    name: "New",
  });

  assert.deepEqual(queries, [
    { sql: "insert into \"items\" (\"owner_id\", \"name\") values ($1, $2) returning *", params: [7, "New"] },
  ]);
});

test("throws when policies is not an object", () => {
  assert.throws(
    () => createSchemaRestRouter(dbvgOutput, { async query() {} }, { policies: "not-an-object" }),
    /policies must be an object/,
  );
});

test("throws when a policy hook is not a function", () => {
  assert.throws(
    () => createSchemaRestRouter(policyDbvgOutput, { async query() {} }, { policies: { scope: "not-a-function" } }),
    /policies.scope must be a function/,
  );
});

function createAppWithOptions(dbvg, options) {
  return createAppWithQueryAndOptions(dbvg, {
    async query(sql, params) {
      if (sql.startsWith("insert into")) {
        return { rows: [{ id: 2, email: params[0], name: params[1] }], rowCount: 1 };
      }
      if (sql.startsWith("update")) {
        return { rows: [{ id: 1, email: "person@example.com", name: params[0] }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  }, options);
}

function createAppWithQueryAndOptions(dbvg, queryable, options) {
  const app = new Koa();
  const router = createSchemaRestRouter(dbvg, queryable, options);

  app.use(bodyParser());
  app.use(async (ctx, next) => {
    ctx.state.user = { id: 7 };
    await next();
  });
  app.use(router.routes());
  app.use(router.allowedMethods());

  return app;
}

function policyOptions() {
  return {
    policies: {
      scope: (ctx, tableName) => (tableName === "items" ? { owner_id: ctx.state.user.id } : {}),
      insert: (body, ctx, tableName) => (tableName === "items" ? { ...body, owner_id: ctx.state.user.id } : body),
    },
  };
}
