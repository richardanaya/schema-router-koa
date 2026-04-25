import Router from "@koa/router";

const DEFAULT_LIMIT = 50;
const DEFAULT_MAX_LIMIT = 500;

export function createSchemaRestRouter(dbvgOutput, queryable, options = {}) {
  if (!dbvgOutput || typeof dbvgOutput !== "object") {
    throw new TypeError("createSchemaRestRouter requires the imported dbvg output module");
  }

  if (!queryable || typeof queryable.query !== "function") {
    throw new TypeError("createSchemaRestRouter requires a Postgres client or pool with query(sql, params)");
  }

  const metadata = dbvgOutput.metadata;

  if (!metadata || typeof metadata !== "object") {
    throw new TypeError("dbvg output must export metadata");
  }

  const {
    prefix = "/api",
    limit = DEFAULT_LIMIT,
    maxLimit = DEFAULT_MAX_LIMIT,
    tables = ["*"],
    excludeTables = [],
    title = "REST API",
    version = "1.0.0",
    policies = {},
  } = options;

  if (!policies || typeof policies !== "object" || Array.isArray(policies)) {
    throw new TypeError("policies must be an object");
  }

  const router = new Router({ prefix });
  const allTableNames = Object.keys(metadata);
  const includedNames = matchGlobs(allTableNames, tables);
  const excludedNames = new Set(matchGlobs(allTableNames, excludeTables));
  const activeTableNames = includedNames.filter((name) => !excludedNames.has(name));
  const tableSet = new Set(activeTableNames);

  validatePatternsMatchTables(tables, allTableNames, "tables");
  validatePatternsMatchTables(excludeTables, allTableNames, "excludeTables");
  validatePolicies(policies);

  for (const [tableName, tableMeta] of Object.entries(metadata)) {
    if (!tableSet.has(tableName)) {
      continue;
    }

    const isView = tableMeta.view === true;
    const primaryKey = Array.isArray(tableMeta.primaryKey) ? tableMeta.primaryKey : [];
    const pkColumns = primaryKey.length > 0 ? primaryKey : ["id"];
    const tablePath = `/${encodePathSegment(tableName)}`;
    const pkPath = pkColumns.map((column) => `/:${paramName(column)}`).join("");
    const rowSchema = schemaFor(dbvgOutput, "rowSchemas", tableName, `${toCamelCase(tableName)}RowSchema`, `${toCamelCase(tableName)}Schema`);
    const insertSchema = isView ? null : schemaFor(dbvgOutput, "insertSchemas", tableName, `${toCamelCase(tableName)}InsertSchema`);
    const updateSchema = isView ? null : schemaFor(dbvgOutput, "updateSchemas", tableName, `${toCamelCase(tableName)}UpdateSchema`);
    const tableSql = quoteIdentifier(tableName);

    if (!rowSchema) {
      throw new TypeError(`dbvg output is missing a row schema for table ${tableName}`);
    }

    router.get(tablePath, async (ctx) => {
      const pageLimit = parseBoundedInteger(ctx.query.limit, limit, 1, maxLimit);
      const offset = parseBoundedInteger(ctx.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
      const scope = await policyScope(policies, ctx, tableMeta, tableName);
      const values = [...scope.values, pageLimit, offset];
      const limitPlaceholder = `$${scope.values.length + 1}`;
      const offsetPlaceholder = `$${scope.values.length + 2}`;
      const whereClause = scope.whereSql ? ` where ${scope.whereSql}` : "";
      const { rows } = await queryable.query(
        `select * from ${tableSql}${whereClause} limit ${limitPlaceholder} offset ${offsetPlaceholder}`,
        values,
      );

      ctx.body = rowSchema.array().parse(normalizeRows(rows, tableMeta));
    });

    router.get(`${tablePath}${pkPath}`, async (ctx) => {
      const pkWhere = primaryKeyWhere(pkColumns, ctx.params);
      const scope = await policyScope(policies, ctx, tableMeta, tableName, pkWhere.values.length);
      const whereSql = joinWhereSql(pkWhere.whereSql, scope.whereSql);
      const values = [...pkWhere.values, ...scope.values];
      const { rows } = await queryable.query(`select * from ${tableSql} where ${whereSql}`, values);

      if (!rows[0]) {
        ctx.status = 404;
        ctx.body = { error: "Not found" };
        return;
      }

      ctx.body = rowSchema.parse(normalizeRow(rows[0], tableMeta));
    });

    if (insertSchema) {
      router.post(tablePath, validateBody(insertSchema, (ctx) => applyInsertPolicy(policies, ctx, tableName, tableMeta)), async (ctx) => {
        const columns = Object.keys(ctx.validatedBody);

        if (columns.length === 0) {
          ctx.status = 400;
          ctx.body = { error: "No fields to insert" };
          return;
        }

        const columnSql = columns.map(quoteIdentifier).join(", ");
        const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
        const values = columns.map((column) => ctx.validatedBody[column]);
        const { rows } = await queryable.query(
          `insert into ${tableSql} (${columnSql}) values (${placeholders}) returning *`,
          values,
        );

        ctx.status = 201;
        ctx.body = rowSchema.parse(normalizeRow(rows[0], tableMeta));
      });
    }

    if (updateSchema) {
      router.patch(`${tablePath}${pkPath}`, validateBody(updateSchema), async (ctx) => {
        const columns = Object.keys(ctx.validatedBody);

        if (columns.length === 0) {
          ctx.status = 400;
          ctx.body = { error: "No fields to update" };
          return;
        }

        const assignments = columns.map((column, index) => `${quoteIdentifier(column)} = $${index + 1}`).join(", ");
        const bodyValues = columns.map((column) => ctx.validatedBody[column]);
        const pkWhere = primaryKeyWhere(pkColumns, ctx.params, bodyValues.length);
        const scope = await policyScope(policies, ctx, tableMeta, tableName, bodyValues.length + pkWhere.values.length);
        const whereSql = joinWhereSql(pkWhere.whereSql, scope.whereSql);
        const { rows } = await queryable.query(
          `update ${tableSql} set ${assignments} where ${whereSql} returning *`,
          [...bodyValues, ...pkWhere.values, ...scope.values],
        );

        if (!rows[0]) {
          ctx.status = 404;
          ctx.body = { error: "Not found" };
          return;
        }

        ctx.body = rowSchema.parse(normalizeRow(rows[0], tableMeta));
      });
    }

    if (!isView) {
      router.delete(`${tablePath}${pkPath}`, async (ctx) => {
        const pkWhere = primaryKeyWhere(pkColumns, ctx.params);
        const scope = await policyScope(policies, ctx, tableMeta, tableName, pkWhere.values.length);
        const whereSql = joinWhereSql(pkWhere.whereSql, scope.whereSql);
        const values = [...pkWhere.values, ...scope.values];
        const { rowCount } = await queryable.query(`delete from ${tableSql} where ${whereSql}`, values);

        ctx.status = rowCount > 0 ? 204 : 404;
      });
    }
  }

  const openApiSpec = buildOpenApiSpec(metadata, tableSet, { prefix, limit, maxLimit, title, version });

  router.get("/openapi.json", async (ctx) => {
    ctx.type = "application/json";
    ctx.body = openApiSpec;
  });

  return router;
}

function validateBody(schema, transformBody = null) {
  return async (ctx, next) => {
    const body = transformBody ? await transformBody(ctx) : ctx.request.body;
    const result = await schema.safeParseAsync(body);

    if (!result.success) {
      ctx.status = 400;
      ctx.body = {
        error: "Validation failed",
        issues: result.error.issues,
      };
      return;
    }

    ctx.validatedBody = result.data;
    await next();
  };
}

async function applyInsertPolicy(policies, ctx, tableName, tableMeta) {
  if (typeof policies.insert !== "function") {
    return ctx.request.body;
  }

  return policies.insert(ctx.request.body, ctx, tableName, tableMeta);
}

function validatePolicies(policies) {
  if (policies.scope !== undefined && typeof policies.scope !== "function") {
    throw new TypeError("policies.scope must be a function");
  }

  if (policies.insert !== undefined && typeof policies.insert !== "function") {
    throw new TypeError("policies.insert must be a function");
  }
}

async function policyScope(policies, ctx, tableMeta, tableName, placeholderOffset = 0) {
  if (typeof policies.scope !== "function") {
    return { whereSql: "", values: [] };
  }

  const scope = await policies.scope(ctx, tableName, tableMeta);

  if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
    throw new TypeError("policies.scope must return an object");
  }

  const entries = Object.entries(scope);

  for (const [column] of entries) {
    if (!tableMeta.columns || !Object.hasOwn(tableMeta.columns, column)) {
      throw new TypeError(`policy scope for table ${tableName} references unknown column ${column}`);
    }
  }

  return {
    whereSql: entries.map(([column], index) => `${quoteIdentifier(column)} = $${placeholderOffset + index + 1}`).join(" and "),
    values: entries.map(([, value]) => value),
  };
}

function joinWhereSql(...parts) {
  return parts.filter(Boolean).join(" and ");
}

function schemaFor(dbvgOutput, registryName, tableName, ...exportNames) {
  return dbvgOutput[registryName]?.[tableName] ?? exportNames.map((name) => dbvgOutput[name]).find(Boolean);
}

function primaryKeyWhere(pkColumns, params, placeholderOffset = 0) {
  return {
    whereSql: pkColumns.map((column, index) => `${quoteIdentifier(column)} = $${placeholderOffset + index + 1}`).join(" and "),
    values: pkColumns.map((column) => params[paramName(column)]),
  };
}

function parseBoundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(Array.isArray(value) ? value[0] : value, 10);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, min), max);
}

function quoteIdentifier(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

function encodePathSegment(segment) {
  return String(segment)
    .split("/")
    .map(encodeURIComponent)
    .join("%2F");
}

function paramName(column) {
  return `pk_${toCamelCase(column)}`;
}

function toCamelCase(value) {
  const words = String(value).split(/[^a-zA-Z0-9]+/).filter(Boolean);

  if (words.length === 0) {
    return "value";
  }

  return words
    .map((word, index) => {
      const lower = word.toLowerCase();
      return index === 0 ? lower : `${lower.slice(0, 1).toUpperCase()}${lower.slice(1)}`;
    })
    .join("");
}

function buildOpenApiSpec(metadata, tableSet, { prefix, limit, maxLimit, title, version }) {
  const paths = {};
  const schemas = {};

  for (const [tableName, tableMeta] of Object.entries(metadata)) {
    if (!tableSet.has(tableName)) {
      continue;
    }

    const isView = tableMeta.view === true;
    const primaryKey = Array.isArray(tableMeta.primaryKey) ? tableMeta.primaryKey : [];
    const pkColumns = primaryKey.length > 0 ? primaryKey : ["id"];
    const tablePath = `/${encodePathSegment(tableName)}`;
    const pkPath = pkColumns.map((column) => `/{${paramName(column)}}`).join("");
    const pascalName = toPascalCase(tableName);

    schemas[pascalName] = openApiSchemaFromColumns(tableMeta.columns);

    const pkParameters = pkColumns.map((column) => ({
      name: paramName(column),
      in: "path",
      required: true,
      schema: openApiTypeFromColumn(tableMeta.columns?.[column]),
    }));

    paths[tablePath] = {
      get: {
        operationId: `list${pascalName}`,
        summary: `List ${tableName}`,
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: maxLimit, default: limit } },
          { name: "offset", in: "query", schema: { type: "integer", minimum: 0, default: 0 } },
        ],
        responses: {
          200: {
            description: `Array of ${tableName}`,
            content: { "application/json": { schema: { type: "array", items: { $ref: `#/components/schemas/${pascalName}` } } } },
          },
        },
      },
    };

    if (!isView) {
      paths[tablePath].post = {
        operationId: `create${pascalName}`,
        summary: `Create ${tableName}`,
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: `#/components/schemas/${pascalName}Insert` } } },
        },
        responses: {
          201: {
            description: `Created ${tableName}`,
            content: { "application/json": { schema: { $ref: `#/components/schemas/${pascalName}` } } },
          },
          400: { description: "Validation failed" },
        },
      };

      schemas[`${pascalName}Insert`] = openApiInsertSchemaFromColumns(tableMeta.columns, pkColumns);
      schemas[`${pascalName}Update`] = openApiUpdateSchemaFromColumns(tableMeta.columns, pkColumns);
    }

    paths[`${tablePath}${pkPath}`] = {
      get: {
        operationId: `get${pascalName}ById`,
        summary: `Get a ${tableName} by primary key`,
        parameters: pkParameters,
        responses: {
          200: {
            description: `A ${tableName}`,
            content: { "application/json": { schema: { $ref: `#/components/schemas/${pascalName}` } } },
          },
          404: { description: "Not found" },
        },
      },
    };

    if (!isView) {
      paths[`${tablePath}${pkPath}`].patch = {
        operationId: `update${pascalName}`,
        summary: `Update ${tableName}`,
        parameters: pkParameters,
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: `#/components/schemas/${pascalName}Update` } } },
        },
        responses: {
          200: {
            description: `Updated ${tableName}`,
            content: { "application/json": { schema: { $ref: `#/components/schemas/${pascalName}` } } },
          },
          400: { description: "Validation failed" },
          404: { description: "Not found" },
        },
      };

      paths[`${tablePath}${pkPath}`].delete = {
        operationId: `delete${pascalName}`,
        summary: `Delete ${tableName}`,
        parameters: pkParameters,
        responses: {
          204: { description: "Deleted" },
          404: { description: "Not found" },
        },
      };
    }
  }

  return {
    openapi: "3.0.3",
    info: { title, version },
    servers: [{ url: prefix }],
    paths,
    components: { schemas },
  };
}

function openApiSchemaFromColumns(columns) {
  const properties = {};
  const required = [];

  for (const [name, column] of Object.entries(columns ?? {})) {
    properties[name] = openApiTypeFromColumn(column);
    if (column && column.nullable === false) {
      required.push(name);
    }
  }

  return { type: "object", properties, required: required.length > 0 ? required : undefined };
}

function openApiInsertSchemaFromColumns(columns, pkColumns) {
  const properties = {};
  const required = [];

  for (const [name, column] of Object.entries(columns ?? {})) {
    if (column && (column.identity === "ALWAYS" || column.generated)) {
      continue;
    }

    properties[name] = openApiTypeFromColumn(column);

    if (column && column.nullable === false && column.default == null) {
      required.push(name);
    }
  }

  return { type: "object", properties, required: required.length > 0 ? required : undefined };
}

function openApiUpdateSchemaFromColumns(columns, pkColumns) {
  const properties = {};

  for (const [name, column] of Object.entries(columns ?? {})) {
    if (column && (column.identity === "ALWAYS" || column.generated || column.primaryKey)) {
      continue;
    }

    properties[name] = openApiTypeFromColumn(column);
  }

  return { type: "object", properties };
}

function openApiTypeFromColumn(column) {
  if (!column) {
    return { type: "string" };
  }

  const udt = String(column.udtName ?? "").toLowerCase();
  const dataType = String(column.dataType ?? "").toLowerCase();
  const nullable = column.nullable === true;

  let schema;

  if (["int2", "int4", "int8", "integer", "smallint", "bigint", "serial", "bigserial"].includes(udt)) {
    schema = { type: "integer" };
  } else if (["numeric", "decimal"].includes(udt)) {
    schema = { type: "number" };
  } else if (["real", "float4", "double precision", "float8"].includes(udt)) {
    schema = { type: "number" };
  } else if (["bool", "boolean"].includes(udt)) {
    schema = { type: "boolean" };
  } else if (["date"].includes(udt)) {
    schema = { type: "string", format: "date" };
  } else if (["timestamptz", "timestamp", "timestamp with time zone", "timestamp without time zone"].includes(udt)) {
    schema = { type: "string", format: "date-time" };
  } else if (["json", "jsonb"].includes(udt)) {
    schema = { type: "object" };
  } else if (udt.startsWith("_") || dataType === "array") {
    const itemType = udt.startsWith("_") ? udt.slice(1) : "string";
    const items = ["int2", "int4", "int8", "integer"].includes(itemType) ? { type: "integer" } : { type: "string" };
    schema = { type: "array", items };
  } else if (dataType === "user-defined") {
    schema = { type: "string" };
  } else {
    schema = { type: "string" };
  }

  if (nullable) {
    schema.nullable = true;
  }

  if (column.description) {
    schema.description = String(column.description).replace(/\s*@(?:dbzod|db-validator-gen|format)\s+\S+/gi, "").trim();
  }

  return schema;
}

function toPascalCase(value) {
  const camel = toCamelCase(value);
  return camel ? `${camel[0].toUpperCase()}${camel.slice(1)}` : "";
}

function normalizeRows(rows, tableMeta) {
  return rows.map((row) => normalizeRow(row, tableMeta));
}

function normalizeRow(row, tableMeta) {
  const numericColumns = numericColumnNames(tableMeta);
  const numericArrayColumns = numericArrayColumnNames(tableMeta);

  if (numericColumns.length === 0 && numericArrayColumns.length === 0) {
    return row;
  }

  const normalized = { ...row };

  for (const columnName of numericColumns) {
    if (typeof normalized[columnName] === "string") {
      normalized[columnName] = Number(normalized[columnName]);
    }
  }

  for (const columnName of numericArrayColumns) {
    if (Array.isArray(normalized[columnName])) {
      normalized[columnName] = normalized[columnName].map((value) => (typeof value === "string" ? Number(value) : value));
    }
  }

  return normalized;
}

function numericColumnNames(tableMeta) {
  const columns = tableMeta?.columns;

  if (!columns || typeof columns !== "object") {
    return [];
  }

  return Object.entries(columns)
    .filter(([, column]) => column?.dataType === "numeric" || column?.udtName === "numeric")
    .map(([columnName]) => columnName);
}

function numericArrayColumnNames(tableMeta) {
  const columns = tableMeta?.columns;

  if (!columns || typeof columns !== "object") {
    return [];
  }

  return Object.entries(columns)
    .filter(([, column]) => column?.dataType === "ARRAY" && column?.udtName === "_numeric")
    .map(([columnName]) => columnName);
}

function matchGlobs(names, patterns) {
  if (patterns.length === 0) {
    return [];
  }

  const regexps = patterns.map((pattern) => globToRegExp(pattern));
  return names.filter((name) => regexps.some((re) => re.test(name)));
}

function validatePatternsMatchTables(patterns, tableNames, optionName) {
  for (const pattern of patterns) {
    const regex = globToRegExp(pattern);
    const hasMatch = tableNames.some((name) => regex.test(name));

    if (!hasMatch) {
      throw new Error(`Pattern "${pattern}" in ${optionName} does not match any table. Available tables: ${tableNames.join(", ")}`);
    }
  }
}

function globToRegExp(pattern) {
  const regexPattern = String(pattern)
    .split("")
    .map((character) => {
      if (character === "*") {
        return ".*";
      }

      if (character === "?") {
        return ".";
      }

      return escapeRegExp(character);
    })
    .join("");

  return new RegExp(`^${regexPattern}$`);
}

function escapeRegExp(string) {
  return String(string).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
