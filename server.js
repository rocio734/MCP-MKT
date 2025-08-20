import express from "express";
import fetch from "node-fetch";
import pino from "pino";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

const log = pino({ level: process.env.LOG_LEVEL || "info" });
const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
if (!HUBSPOT_TOKEN) { log.error("Falta HUBSPOT_TOKEN"); process.exit(1); }

// --- helpers HubSpot ---
async function hsPOST(path, body) {
  const res = await fetch(`https://api.hubapi.com${path}`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${HUBSPOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body || {})
  });
  if (!res.ok) throw new Error(`HubSpot ${res.status} ${await res.text()}`);
  return res.json();
}
async function hsGET(path, query = {}) {
  const url = new URL(`https://api.hubapi.com${path}`);
  Object.entries(query).forEach(([k, v]) => v !== undefined && url.searchParams.set(k, v));
  const res = await fetch(url, { headers: { "Authorization": `Bearer ${HUBSPOT_TOKEN}` } });
  if (!res.ok) throw new Error(`HubSpot ${res.status} ${await res.text()}`);
  return res.json();
}

// --- MCP server ---
const server = new McpServer({ name: "hubspot-mcp", version: "1.0.0" });

// tools (puedes añadir más)
server.registerTool(
  "hubspot.contacts.search",
  {
    title: "Buscar contactos",
    description: "Busca contactos por email/nombre",
    inputSchema: {
      query: z.string().optional(),
      properties: z.array(z.string()).optional(),
      limit: z.number().int().min(1).max(100).optional()
    }
  },
  async ({ query, properties = ["email","firstname","lastname","lifecyclestage"], limit = 20 }) => {
    const data = await hsPOST("/crm/v3/objects/contacts/search", {
      filterGroups: query ? [{
        filters: [
          { propertyName: "email", operator: "CONTAINS_TOKEN", value: query },
          { propertyName: "firstname", operator: "CONTAINS_TOKEN", value: query }
        ]
      }] : [],
      properties, limit
    });
    return { content: [{ type: "json", json: data }] };
  }
);

server.registerTool(
  "hubspot.deals.search",
  {
    title: "Buscar deals",
    description: "Filtra deals por etapa",
    inputSchema: { stage: z.string().optional(), limit: z.number().int().min(1).max(100).optional() }
  },
  async ({ stage, limit = 20 }) => {
    const filters = stage ? [{ propertyName: "dealstage", operator: "EQ", value: stage }] : [];
    const data = await hsPOST("/crm/v3/objects/deals/search", {
      filterGroups: filters.length ? [{ filters }] : [], limit,
      properties: ["dealname","amount","dealstage","pipeline","hs_close_date"]
    });
    return { content: [{ type: "json", json: data }] };
  }
);

// --- Express + endpoints SSE (legacy) ---
const app = express();
app.use(express.json());

const transports = {}; // sessionId -> transport

app.get("/healthz", (_, res) => res.json({ ok: true }));

// Apertura de sesión SSE (Copilot se conecta aquí)
app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res); // <- ruta para POSTs
  transports[transport.sessionId] = transport;
  res.on("close", () => { delete transports[transport.sessionId]; });
  await server.connect(transport);
});

// Donde el cliente envía los mensajes JSON-RPC
app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports[sessionId];
  if (!transport) return res.status(400).send("No transport found for sessionId");
  await transport.handlePostMessage(req, res, req.body);
});

const port = process.env.PORT || 3000;
app.listen(port, () => log.info(`MCP HubSpot listo en :${port} (/sse)`));
