// server.js
import express from "express";
import fetch from "node-fetch";
import pino from "pino";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

/* ================== Config & Logger ================== */
const log = pino({ level: process.env.LOG_LEVEL || "info" });
const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
if (!HUBSPOT_TOKEN) {
  log.error("Falta HUBSPOT_TOKEN (variable de entorno)");
  process.exit(1);
}

/* ================== HTTP helpers ================== */
async function hsPOST(path, body) {
  const res = await fetch(`https://api.hubapi.com${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${HUBSPOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HubSpot ${res.status} ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function hsGET(path, query = {}) {
  const url = new URL(`https://api.hubapi.com${path}`);
  Object.entries(query).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "")
      url.searchParams.set(k, String(v));
  });
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HubSpot ${res.status} ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/* ============ Utilidades varias ============ */
function chunk(arr, size = 90) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Respuestas “a prueba de clientes estrictos” (usa type=text)
function asText(obj, label = null) {
  try {
    const payload = label ? { label, data: obj } : obj;
    return { content: [{ type: "text", text: JSON.stringify(payload) }] };
  } catch (e) {
    return { content: [{ type: "text", text: String(obj) }] };
  }
}

/* ================== MCP Server ================== */
const server = new McpServer({ name: "hubspot-mcp", version: "1.2.0" });

/* --------- CONTACTS --------- */
server.registerTool(
  "hubspot_contacts_search",
  {
    title: "Buscar contactos",
    description: "Busca contactos por email/nombre",
    inputSchema: z.object({
      query: z.string().optional(),
      properties: z.array(z.string()).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
  },
  async ({
    query,
    properties = [
      "email",
      "firstname",
      "lastname",
      "lifecyclestage",
      "createdate",
      "hubspot_owner_id",
    ],
    limit = 20,
  }) => {
    log.info({ tool: "hubspot_contacts_search", query, limit, properties });
    try {
      const body = {
        filterGroups: query
          ? [
              {
                filters: [
                  {
                    propertyName: "email",
                    operator: "CONTAINS_TOKEN",
                    value: query,
                  },
                  {
                    propertyName: "firstname",
                    operator: "CONTAINS_TOKEN",
                    value: query,
                  },
                ],
              },
            ]
          : [],
        properties,
        limit,
      };
      const data = await hsPOST("/crm/v3/objects/contacts/search", body);
      return asText(
        {
          ok: true,
          count: data?.results?.length ?? 0,
          results: data?.results ?? [],
          paging: data?.paging ?? null,
        },
        "contacts"
      );
    } catch (e) {
      log.error({ tool: "hubspot_contacts_search", error: String(e) });
      return asText({ ok: false, error: String(e) }, "contacts_error");
    }
  }
);

/* --------- COMPANIES --------- */
server.registerTool(
  "hubspot_companies_search",
  {
    title: "Buscar empresas",
    description: "Busca companies por nombre/dominio",
    inputSchema: z.object({
      query: z.string().optional(),
      properties: z.array(z.string()).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
  },
  async ({
    query,
    properties = ["name", "domain", "industry", "city", "country"],
    limit = 20,
  }) => {
    log.info({ tool: "hubspot_companies_search", query, limit, properties });
    try {
      const data = await hsPOST("/crm/v3/objects/companies/search", {
        filterGroups: query
          ? [
              {
                filters: [
                  {
                    propertyName: "name",
                    operator: "CONTAINS_TOKEN",
                    value: query,
                  },
                  {
                    propertyName: "domain",
                    operator: "CONTAINS_TOKEN",
                    value: query,
                  },
                ],
              },
            ]
          : [],
        properties,
        limit,
      });
      return asText(
        {
          ok: true,
          count: data?.results?.length ?? 0,
          results: data?.results ?? [],
          paging: data?.paging ?? null,
        },
        "companies"
      );
    } catch (e) {
      log.error({ tool: "hubspot_companies_search", error: String(e) });
      return asText({ ok: false, error: String(e) }, "companies_error");
    }
  }
);

/* --------- DEALS --------- */
server.registerTool(
  "hubspot_deals_search",
  {
    title: "Buscar deals",
    description: "Filtra deals por etapa/pipeline",
    inputSchema: z.object({
      stage: z.string().optional(),
      pipeline: z.string().optional(),
      properties: z.array(z.string()).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
  },
  async ({
    stage,
    pipeline,
    properties = [
      "dealname",
      "amount",
      "dealstage",
      "pipeline",
      "createdate",
      "hs_close_date",
      "hubspot_owner_id",
    ],
    limit = 20,
  }) => {
    log.info({ tool: "hubspot_deals_search", stage, pipeline, limit, properties });
    try {
      const filters = [];
      if (stage)
        filters.push({ propertyName: "dealstage", operator: "EQ", value: stage });
      if (pipeline)
        filters.push({ propertyName: "pipeline", operator: "EQ", value: pipeline });

      const body = {
        filterGroups: filters.length ? [{ filters }] : [],
        properties,
        limit,
      };
      const data = await hsPOST("/crm/v3/objects/deals/search", body);
      return asText(
        {
          ok: true,
          count: data?.results?.length ?? 0,
          results: data?.results ?? [],
          paging: data?.paging ?? null,
        },
        "deals"
      );
    } catch (e) {
      log.error({ tool: "hubspot_deals_search", error: String(e) });
      return asText({ ok: false, error: String(e) }, "deals_error");
    }
  }
);

/* --------- OWNERS --------- */
server.registerTool(
  "hubspot_owners_list",
  {
    title: "Listar owners",
    description: "Lista dueños (usuarios) de HubSpot",
    inputSchema: z.object({
      after: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
  },
  async ({ after, limit = 100 }) => {
    log.info({ tool: "hubspot_owners_list", after, limit });
    try {
      const data = await hsGET("/crm/v3/owners/", { after, limit });
      return asText({ ok: true, ...data }, "owners");
    } catch (e) {
      log.error({ tool: "hubspot_owners_list", error: String(e) });
      return asText({ ok: false, error: String(e) }, "owners_error");
    }
  }
);

/* --------- PROPERTIES (schema) --------- */
server.registerTool(
  "hubspot_properties",
  {
    title: "Listar propiedades",
    description: "Devuelve el schema de propiedades de un objeto",
    inputSchema: z.object({
      object: z.string().default("deals"),
    }),
  },
  async ({ object = "deals" }) => {
    log.info({ tool: "hubspot_properties", object });
    try {
      const data = await hsGET(`/crm/v3/properties/${object}`);
      return asText({ ok: true, ...data }, "properties");
    } catch (e) {
      log.error({ tool: "hubspot_properties", error: String(e) });
      return asText({ ok: false, error: String(e) }, "properties_error");
    }
  }
);

/* --------- PIPELINES & STAGES --------- */
server.registerTool(
  "hubspot_pipelines",
  {
    title: "Pipelines",
    description: "Obtiene pipelines y etapas de un objeto (deals, tickets, ...)",
    inputSchema: z.object({
      object: z.string().default("deals"),
    }),
  },
  async ({ object = "deals" }) => {
    log.info({ tool: "hubspot_pipelines", object });
    try {
      const data = await hsGET(`/crm/v3/pipelines/${object}`);
      return asText({ ok: true, ...data }, "pipelines");
    } catch (e) {
      log.error({ tool: "hubspot_pipelines", error: String(e) });
      return asText({ ok: false, error: String(e) }, "pipelines_error");
    }
  }
);

/* --------- PAGINATE (GET LIST) --------- */
server.registerTool(
  "hubspot_paginate",
  {
    title: "Paginar objetos",
    description: "Listado paginado de objetos (contacts, companies, deals, ...)",
    inputSchema: z.object({
      object: z.string(),
      after: z.string().optional(),
      properties: z.array(z.string()).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
  },
  async ({ object, after, properties = [], limit = 100 }) => {
    log.info({ tool: "hubspot_paginate", object, after, limit, properties });
    try {
      const data = await hsGET(`/crm/v3/objects/${object}`, {
        properties: properties.join(","),
        limit,
        after,
      });
      return asText({ ok: true, ...data }, "paginate");
    } catch (e) {
      log.error({ tool: "hubspot_paginate", error: String(e) });
      return asText({ ok: false, error: String(e) }, "paginate_error");
    }
  }
);

/* --------- BATCH READ BY IDS --------- */
server.registerTool(
  "hubspot_batch_read",
  {
    title: "Batch read",
    description: "Lee por IDs un objeto dado",
    inputSchema: z.object({
      object: z.string(),
      ids: z.array(z.string()),
      properties: z.array(z.string()).optional(),
    }),
  },
  async ({ object, ids, properties = [] }) => {
    log.info({ tool: "hubspot_batch_read", object, ids_len: ids?.length || 0 });
    try {
      const all = [];
      for (const part of chunk(ids)) {
        const res = await fetch(
          `https://api.hubapi.com/crm/v3/objects/${object}/batch/read`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${HUBSPOT_TOKEN}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              properties,
              inputs: part.map((id) => ({ id })),
            }),
          }
        );
        const text = await res.text();
        if (!res.ok) throw new Error(`HubSpot batch ${object} ${res.status} ${text}`);
        const json = JSON.parse(text);
        if (json?.results) all.push(...json.results);
      }
      return asText({ ok: true, results: all }, "batch_read");
    } catch (e) {
      log.error({ tool: "hubspot_batch_read", error: String(e) });
      return asText({ ok: false, error: String(e) }, "batch_read_error");
    }
  }
);

/* --------- ASSOCIATIONS (BATCH) --------- */
server.registerTool(
  "hubspot_associations_batch",
  {
    title: "Asociaciones (batch)",
    description:
      "Lee asociaciones entre objetos (ej: companies -> deals) por lote de IDs",
    inputSchema: z.object({
      from_object: z.string(),
      to_object: z.string(),
      ids: z.array(z.string()),
    }),
  },
  async ({ from_object, to_object, ids }) => {
    log.info({
      tool: "hubspot_associations_batch",
      from_object,
      to_object,
      ids_len: ids?.length || 0,
    });
    try {
      const res = await fetch(
        `https://api.hubapi.com/crm/v3/associations/${from_object}/${to_object}/batch/read`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${HUBSPOT_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ inputs: ids.map((id) => ({ id })) }),
        }
      );
      const text = await res.text();
      if (!res.ok)
        throw new Error(
          `HubSpot associations ${from_object}->${to_object} ${res.status} ${text}`
        );
      const data = JSON.parse(text);
      return asText({ ok: true, ...data }, "associations");
    } catch (e) {
      log.error({ tool: "hubspot_associations_batch", error: String(e) });
      return asText({ ok: false, error: String(e) }, "associations_error");
    }
  }
);

/* --------- RECENTLY MODIFIED --------- */
server.registerTool(
  "hubspot_recently_modified",
  {
    title: "Modificados desde",
    description: "Busca objetos modificados desde un timestamp (ms)",
    inputSchema: z.object({
      object: z.string(),
      since_ms: z.number().int(),
      properties: z.array(z.string()).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
  },
  async ({ object, since_ms, properties = [], limit = 50 }) => {
    log.info({ tool: "hubspot_recently_modified", object, since_ms, limit });
    try {
      const data = await hsPOST(`/crm/v3/objects/${object}/search`, {
        filterGroups: [
          {
            filters: [
              {
                propertyName: "hs_lastmodifieddate",
                operator: "GTE",
                value: String(since_ms),
              },
            ],
          },
        ],
        properties,
        limit,
        sorts: [
          { propertyName: "hs_lastmodifieddate", direction: "DESCENDING" },
        ],
      });
      return asText(
        {
          ok: true,
          count: data?.results?.length ?? 0,
          results: data?.results ?? [],
          paging: data?.paging ?? null,
        },
        "recently_modified"
      );
    } catch (e) {
      log.error({ tool: "hubspot_recently_modified", error: String(e) });
      return asText({ ok: false, error: String(e) }, "recently_modified_error");
    }
  }
);

/* --------- ADVANCED SEARCH --------- */
server.registerTool(
  "hubspot_search_advanced",
  {
    title: "Búsqueda avanzada",
    description: "Ejecuta filterGroups crudos de HubSpot Search",
    inputSchema: z.object({
      object: z.string(),
      filterGroups: z.any(),
      properties: z.array(z.string()).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      sorts: z.any().optional(),
    }),
  },
  async ({ object, filterGroups, properties = [], limit = 50, sorts }) => {
    log.info({ tool: "hubspot_search_advanced", object, limit });
    try {
      const data = await hsPOST(`/crm/v3/objects/${object}/search`, {
        filterGroups,
        properties,
        limit,
        ...(sorts ? { sorts } : {}),
      });
      return asText(
        {
          ok: true,
          count: data?.results?.length ?? 0,
          results: data?.results ?? [],
          paging: data?.paging ?? null,
        },
        "advanced_search"
      );
    } catch (e) {
      log.error({ tool: "hubspot_search_advanced", error: String(e) });
      return asText({ ok: false, error: String(e) }, "advanced_search_error");
    }
  }
);

/* ================== Express + SSE ================== */
const app = express();
app.use(express.json());

// Health
app.get("/healthz", (_, res) => res.json({ ok: true }));

// Endpoint de diagnóstico simple (opcional)
app.get("/diag/contacts", async (req, res) => {
  try {
    const q = req.query.q || "@gmail.com";
    const data = await hsPOST("/crm/v3/objects/contacts/search", {
      filterGroups: [
        { filters: [{ propertyName: "email", operator: "CONTAINS_TOKEN", value: q }] },
      ],
      properties: ["email", "firstname", "lastname", "lifecyclestage", "createdate"],
      limit: 5,
    });
    res.json({ ok: true, sample: data?.results?.length ?? 0, results: data?.results ?? [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// SSE setup (legacy-compatible): /sse abre sesión, /messages recibe POSTs
const transports = {}; // sessionId -> transport

app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  transports[transport.sessionId] = transport;
  res.on("close", () => {
    delete transports[transport.sessionId];
  });
  await server.connect(transport);
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports[sessionId];
  if (!transport) return res.status(400).send("No transport found for sessionId");
  await transport.handlePostMessage(req, res, req.body);
});

const port = process.env.PORT || 3000;
app.listen(port, () => log.info(`MCP HubSpot listo en :${port} (/sse)`));
