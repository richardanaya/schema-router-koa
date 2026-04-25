import assert from "node:assert/strict";
import { test } from "node:test";
import Koa from "koa";
import bodyParser from "koa-bodyparser";
import request from "supertest";
import { z } from "zod";
import { createKoaRestRouter } from "./index.js";

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
  const router = createKoaRestRouter(metricsOutput, {
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
    () => createKoaRestRouter(dbvgOutput, { async query() {} }, { tables: ["nonexistent_*"] }),
    /Pattern "nonexistent_\*" in tables does not match any table/,
  );
});

test("throws when excludeTables pattern matches nothing", () => {
  assert.throws(
    () => createKoaRestRouter(dbvgOutput, { async query() {} }, { excludeTables: ["nonexistent_*"] }),
    /Pattern "nonexistent_\*" in excludeTables does not match any table/,
  );
});

function createApp(queryable) {
  const app = new Koa();
  const router = createKoaRestRouter(dbvgOutput, queryable);

  app.use(bodyParser());
  app.use(router.routes());
  app.use(router.allowedMethods());

  return app;
}

test("intercept receives validated body, schema, and ctx on insert", async () => {
  const interceptCalls = [];

  const app = createAppWithOptions(dbvgOutput, {
    intercept(validatedBody, schema, ctx) {
      interceptCalls.push({ validatedBody, schema, hasCtx: !!ctx, state: ctx.state });
    },
  });

  await request(app.callback())
    .post("/api/users")
    .send({ email: "new@example.com", name: "New" })
    .expect(201);

  assert.equal(interceptCalls.length, 1);
  assert.equal(interceptCalls[0].validatedBody.email, "new@example.com");
  assert.equal(interceptCalls[0].validatedBody.name, "New");
  assert.equal(interceptCalls[0].hasCtx, true);
});

test("intercept can reject inserts before database call", async () => {
  const app = createAppWithOptions(dbvgOutput, {
    intercept(body, schema, ctx) {
      if (body.email === "blocked@example.com") {
        ctx.status = 403;
        ctx.body = { error: "Not authorized" };
        return;
      }
    },
  });

  const blocked = await request(app.callback())
    .post("/api/users")
    .send({ email: "blocked@example.com", name: "Blocked" })
    .expect(403);

  assert.equal(blocked.body.error, "Not authorized");
});

test("invalid body does not reach intercept", async () => {
  let interceptCalled = false;

  const app = createAppWithOptions(dbvgOutput, {
    intercept() {
      interceptCalled = true;
    },
  });

  await request(app.callback())
    .post("/api/users")
    .send({ email: "not-an-email", name: "New" })
    .expect(400);

  assert.equal(interceptCalled, false);
});

test("intercept receives validated body on patch", async () => {
  const interceptCalls = [];

  const app = createAppWithOptions(dbvgOutput, {
    intercept(body, schema, ctx) {
      interceptCalls.push({ body, schema, pkId: ctx.params.pk_id });
    },
  });

  await request(app.callback())
    .patch("/api/users/1")
    .send({ name: "Updated" })
    .expect(200);

  assert.equal(interceptCalls.length, 1);
  assert.equal(interceptCalls[0].body.name, "Updated");
  assert.equal(interceptCalls[0].pkId, "1");
});

test("throws when intercept is not a function", () => {
  assert.throws(
    () => createKoaRestRouter(dbvgOutput, { async query() {} }, { intercept: "not-a-function" }),
    /intercept must be a function/,
  );
});

function createAppWithOptions(dbvg, options) {
  const app = new Koa();
  const router = createKoaRestRouter(dbvg, {
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

  app.use(bodyParser());
  app.use(router.routes());
  app.use(router.allowedMethods());

  return app;
}
