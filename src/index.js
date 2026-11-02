#!/usr/bin/env node
/**
 * tickets-mcp  v0.1.0
 *
 * MCP server de solo lectura sobre la BBDD MySQL de osTicket (soporte IT de Valmesa).
 * Pensado para ir detrás de la pasarela MCP (código de servidor «tickets»).
 *
 *  - Transporte Streamable HTTP sin estado en POST /mcp (spec MCP 2025-03-26 y posteriores)
 *  - McpServer + registerTool, esquemas Zod .strict() con .describe()
 *  - Anotaciones readOnlyHint / idempotentHint / openWorldHint
 *  - structuredContent en cada respuesta y response_format json|markdown
 *  - Paginación (limit/offset/has_more/next_offset) y CHARACTER_LIMIT
 *  - Auth: Authorization Bearer (la clave que envía la pasarela); validación de Origin
 *  - Ámbito: solo TODO. Confirma en _meta "valmesa.es/ambito-aplicado"
 *
 * Salvaguardas:
 *  - Sesión MySQL en READ ONLY, tiempo máximo por consulta y pool pequeño
 *  - Solo SELECT con parámetros; nunca SQL que venga de Claude
 *  - Por defecto se ocultan los tickets en estado Borrado
 *  - Log de auditoría de cada llamada (JSON por línea)
 *
 * La anonimización de datos personales la hace la pasarela (src/privacidad/reglas.ts).
 * Los nombres de las claves JSON y de las líneas "Etiqueta: valor" de este fichero
 * tienen que coincidir con esas reglas.
 */

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import mysql from "mysql2/promise";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { z } from "zod";
import {
  parsearBusqueda,
  parsearCampo,
  coincidencia,
  encargoEnTexto,
  patronesLike,
  formatear,
} from "./expediente.js";

dotenv.config();

// ===================== Configuracion =====================

const SERVER_NAME = "tickets-mcp-server";
const SERVER_VERSION = "0.1.0";

const QUERY_TIMEOUT_MS = parseInt(process.env.MYSQL_QUERY_TIMEOUT_MS || "20000", 10);

const MYSQL_CONFIG = {
  host: process.env.MYSQL_HOST,
  port: parseInt(process.env.MYSQL_PORT || "3306", 10),
  database: process.env.MYSQL_DATABASE || "bd_osticket",
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  connectionLimit: parseInt(process.env.MYSQL_POOL_MAX || "2", 10),
  waitForConnections: true,
  queueLimit: 20,
  connectTimeout: 15000,
  // Fechas tal cual están en la BBDD, sin conversiones de zona horaria
  dateStrings: true,
  charset: "utf8mb4",
  multipleStatements: false,
};

const PORT = parseInt(process.env.PORT || "8767", 10);
const HOST = process.env.HOST || "127.0.0.1";
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || "";
const CHARACTER_LIMIT = parseInt(process.env.CHARACTER_LIMIT || "100000", 10);
const LOG_FILE = process.env.LOG_FILE || path.join(process.cwd(), "mcp-tickets.log");

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const META_AMBITO = "valmesa.es/ambito";
const META_AMBITO_APLICADO = "valmesa.es/ambito-aplicado";

if (!AUTH_TOKEN) {
  console.error(
    "[tickets-mcp] FATAL: MCP_AUTH_TOKEN no esta definido. Genera uno y configuralo en .env"
  );
  process.exit(1);
}

// ===================== Log y auth =====================

function logCall(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  try {
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch (_) {}
}

function tokensEqual(a, b) {
  const ba = Buffer.from(a || "");
  const bb = Buffer.from(b || "");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// ===================== Pool MySQL =====================

let pool;
function getPool() {
  if (!pool) {
    pool = mysql.createPool(MYSQL_CONFIG);
    // Cada conexión nueva: solo lectura y tiempo máximo por consulta.
    // MAX_EXECUTION_TIME es de MySQL y max_statement_time de MariaDB: se prueban los dos.
    pool.pool.on("connection", (conn) => {
      conn.query("SET SESSION TRANSACTION READ ONLY");
      conn.query(`SET SESSION MAX_EXECUTION_TIME = ${QUERY_TIMEOUT_MS}`, () => {});
      conn.query(`SET SESSION max_statement_time = ${QUERY_TIMEOUT_MS / 1000}`, () => {});
    });
  }
  return pool;
}

async function q(sqlText, params = []) {
  const [rows] = await getPool().query({ sql: sqlText, timeout: QUERY_TIMEOUT_MS + 5000 }, params);
  return rows;
}

// ===================== Helpers de datos =====================

/** Los campos de lista de osTicket se guardan como {"2":"BBVA"}. Devuelve "BBVA". */
function limpiarLista(v) {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v).trim();
  if (s.startsWith("{")) {
    try {
      const vals = Object.values(JSON.parse(s)).map((x) => String(x).trim());
      return vals.length ? vals.join(", ") : null;
    } catch (_) {}
  }
  return s;
}

const ENTIDADES = { "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'" };

/** Quita el HTML de los mensajes y deja texto plano legible. */
function limpiarHtml(s) {
  if (!s) return "";
  return String(s)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(nbsp|amp|lt|gt|quot|apos|#39);/g, (m) => ENTIDADES[m] ?? m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function recortar(s, max) {
  if (!s || s.length <= max) return s;
  return s.slice(0, max) + ` […recortado, ${s.length - max} caracteres más]`;
}

function nombreAgente(r) {
  const n = `${r.agente_nombre ?? ""} ${r.agente_apellidos ?? ""}`.trim();
  return n || null;
}

function countBy(rows, key) {
  const counts = {};
  for (const r of rows) {
    const k = r[key] ?? "(sin valor)";
    counts[k] = (counts[k] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
}

const TIPO_ENTRADA = { M: "Mensaje", R: "Respuesta", N: "Nota interna" };

const EVENTOS = {
  created: "creado",
  closed: "cerrado",
  reopened: "reabierto",
  assigned: "asignado",
  released: "liberado",
  transferred: "transferido",
  referred: "derivado",
  overdue: "vencido",
  edited: "editado",
  collab: "colaborador",
  resent: "reenviado",
  deleted: "borrado",
};

// ===================== SQL comun =====================

const FROM_TICKET = `
  FROM ost_ticket t
  LEFT JOIN ost_ticket__cdata c  ON c.ticket_id = t.ticket_id
  LEFT JOIN ost_ticket_status st ON st.id = t.status_id
  LEFT JOIN ost_department d     ON d.id = t.dept_id
  LEFT JOIN ost_help_topic ht    ON ht.topic_id = t.topic_id
  LEFT JOIN ost_staff s          ON s.staff_id = t.staff_id
  LEFT JOIN ost_user u           ON u.id = t.user_id`;

const SELECT_TICKET = `
  SELECT t.ticket_id, t.number, c.field_37 AS expediente_raw, c.subject AS asunto,
         st.name AS estado, st.state AS estado_tipo, d.name AS departamento,
         ht.topic AS tema, s.firstname AS agente_nombre, s.lastname AS agente_apellidos,
         c.cliente AS cliente_raw, c.tsoporte AS tsoporte_raw, c.tipoentrada AS tipoentrada_raw,
         c.timeticket, t.source AS origen, t.isoverdue, t.isanswered,
         t.duedate, t.created, t.lastupdate, t.closed, t.reopened, u.name AS solicitante
  ${FROM_TICKET}`;

function compactarTicket(r) {
  const campo = parsearCampo(r.expediente_raw);
  return {
    ticket: r.number,
    expediente: r.expediente_raw ? String(r.expediente_raw).trim() : null,
    expediente_normalizado: campo ? formatear(campo) : null,
    asunto: r.asunto,
    estado: r.estado,
    abierto: r.estado_tipo === "open",
    departamento: r.departamento,
    tema: r.tema,
    agente: nombreAgente(r),
    solicitante: r.solicitante || null,
    cliente: limpiarLista(r.cliente_raw),
    tipo_soporte: limpiarLista(r.tsoporte_raw),
    tipo_entrada: limpiarLista(r.tipoentrada_raw),
    tiempo_empleado: r.timeticket || null,
    origen: r.origen,
    vencido: r.isoverdue === 1,
    contestado: r.isanswered === 1,
    creado: r.created,
    ult_movimiento: r.lastupdate,
    vence: r.duedate,
    cerrado: r.closed,
    reabierto: r.reopened,
  };
}

function lineasTicket(t, extra = "") {
  const out = [`### Ticket ${t.ticket} — ${t.estado ?? "?"}${extra}`];
  out.push(`- Asunto: ${t.asunto ?? ""}`);
  if (t.expediente) out.push(`- Expediente: ${t.expediente}`);
  out.push(`- Departamento: ${t.departamento ?? "—"} · Tema: ${t.tema ?? "—"}`);
  out.push(`- Agente: ${t.agente ?? "(sin asignar)"}`);
  if (t.cliente || t.tipo_soporte) out.push(`- Cliente / tipo: ${t.cliente ?? "—"} / ${t.tipo_soporte ?? "—"}`);
  out.push(
    `- Fechas: creado ${t.creado ?? "—"} · último movimiento ${t.ult_movimiento ?? "—"}` +
      (t.cerrado ? ` · cerrado ${t.cerrado}` : "") +
      (t.vencido ? " · VENCIDO" : "")
  );
  return out;
}

// Filtros comunes de listar_tickets y estadisticas_tickets
const FILTROS_SHAPE = {
  estado: z
    .string()
    .max(60)
    .optional()
    .describe("'abiertos', 'cerrados' o el nombre de un estado (Abierto, Iniciado, Pendiente de contestación, Resuelto, Cerrado...)"),
  departamento: z.string().max(100).optional().describe("Nombre o parte del nombre del departamento (Soporte, Programación, Sistemas...)"),
  tema: z.string().max(60).optional().describe("Tema de ayuda: Consulta, Error, Error Cliente, Error de Usuario, Listados, Mejora Futura, Varios"),
  cliente: z.string().max(60).optional().describe("Cliente del ticket (BBVA, SAREB, INTERNO...). Ver catalogos"),
  tipo_soporte: z.string().max(60).optional().describe("Tipo de soporte (Problema SW, Valora, Correo...). Ver catalogos"),
  agente: z.string().max(100).optional().describe("Nombre o parte del nombre del agente asignado"),
  texto: z.string().max(100).optional().describe("Texto a buscar en el asunto"),
  desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Desde esta fecha (AAAA-MM-DD, incluida)"),
  hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Hasta esta fecha (AAAA-MM-DD, incluida)"),
  fecha_por: z
    .enum(["creacion", "cierre", "ult_movimiento"])
    .default("creacion")
    .describe("A qué fecha se aplican desde/hasta: creación (por defecto), cierre o último movimiento"),
  solo_vencidos: z.boolean().optional().describe("Solo tickets marcados como vencidos"),
  incluir_borrados: z.boolean().default(false).describe("Incluir tickets en estado Borrado (por defecto no)"),
};

const COLUMNA_FECHA = { creacion: "t.created", cierre: "t.closed", ult_movimiento: "t.lastupdate" };

function construirWhere(f) {
  const w = [];
  const p = [];
  if (!f.incluir_borrados) w.push("(st.state IS NULL OR st.state <> 'deleted')");
  if (f.estado) {
    const e = f.estado.trim().toLowerCase();
    if (e === "abiertos" || e === "abierto(s)" || e === "open") w.push("st.state = 'open'");
    else if (e === "cerrados" || e === "closed") w.push("st.state = 'closed'");
    else {
      w.push("st.name LIKE ?");
      p.push(`%${f.estado.trim()}%`);
    }
  }
  const like = (col, v) => {
    if (v) {
      w.push(`${col} LIKE ?`);
      p.push(`%${v.trim()}%`);
    }
  };
  like("d.name", f.departamento);
  like("ht.topic", f.tema);
  like("c.cliente", f.cliente);
  like("c.tsoporte", f.tipo_soporte);
  like("CONCAT_WS(' ', s.firstname, s.lastname)", f.agente);
  like("c.subject", f.texto);
  const colFecha = COLUMNA_FECHA[f.fecha_por || "creacion"];
  if (f.desde) {
    w.push(`${colFecha} >= ?`);
    p.push(`${f.desde} 00:00:00`);
  }
  if (f.hasta) {
    w.push(`${colFecha} < DATE_ADD(?, INTERVAL 1 DAY)`);
    p.push(f.hasta);
  }
  if (f.solo_vencidos) w.push("t.isoverdue = 1");
  return { where: w.length ? "WHERE " + w.join(" AND ") : "", params: p };
}

function describirFiltros(f) {
  return Object.entries(f)
    .filter(
      ([k, v]) =>
        v !== undefined && v !== false &&
        !["response_format", "limit", "offset", "campos", "orden"].includes(k) &&
        !(k === "fecha_por" && !f.desde && !f.hasta)
    )
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
}

// ===================== Respuestas =====================

const RESPONSE_FORMAT = z
  .enum(["markdown", "json"])
  .default("markdown")
  .describe("'markdown' (legible, por defecto) o 'json' (datos completos)");

function responder(data, markdown, format) {
  let text = format === "json" ? JSON.stringify(data, null, 2) : markdown;
  let structured = data;
  if (text.length > CHARACTER_LIMIT) {
    text =
      text.slice(0, CHARACTER_LIMIT) +
      "\n\n[Respuesta recortada por tamaño. Usa filtros más concretos, un 'limit' menor o 'offset' para paginar.]";
    structured = { recortado: true, nota: "Respuesta demasiado grande; ver texto recortado" };
  }
  return {
    content: [{ type: "text", text }],
    structuredContent: structured,
    _meta: { [META_AMBITO_APLICADO]: "TODO" },
  };
}

function error(msg, ambitoAplicado = "TODO") {
  const r = { isError: true, content: [{ type: "text", text: msg }] };
  if (ambitoAplicado) r._meta = { [META_AMBITO_APLICADO]: ambitoAplicado };
  return r;
}

/**
 * Envuelve cada herramienta: comprueba el ámbito que envía la pasarela, mide y registra.
 * Este MCP no sabe filtrar por PROPIOS/CARTERA/EQUIPO: con otro ámbito se niega.
 */
function herramienta(nombre, fn) {
  return async (args, extra) => {
    const t0 = Date.now();
    const ambito = extra?._meta?.[META_AMBITO];
    if (ambito && ambito !== "TODO") {
      logCall({ tool: nombre, args, ok: false, motivo: `ambito ${ambito}` });
      return error(
        `Esta herramienta solo está disponible con ámbito TODO (recibido: ${ambito}). Consulta con el administrador.`,
        null
      );
    }
    try {
      const r = await fn(args);
      logCall({ tool: nombre, args, ok: !r.isError, ms: Date.now() - t0 });
      return r;
    } catch (e) {
      logCall({ tool: nombre, args, ok: false, ms: Date.now() - t0, error: e.message, code: e.code });
      console.error(`[tickets-mcp] ${nombre}:`, e);
      if (e.code === "ER_TABLEACCESS_DENIED_ERROR" || e.code === "ER_COLUMNACCESS_DENIED_ERROR")
        return error(`El usuario MySQL del MCP no tiene permiso de lectura sobre una tabla necesaria: ${e.sqlMessage}`);
      if (e.code === "ER_QUERY_TIMEOUT" || /max_statement_time|maximum statement execution time/i.test(e.message || ""))
        return error("La consulta ha superado el tiempo máximo. Acota la búsqueda (fechas, departamento...).");
      return error(`Error consultando la BBDD de tickets: ${e.message}`);
    }
  };
}

const ANOTACIONES = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

// ===================== Herramientas =====================

async function ticketsExpediente({ expediente, buscar_en_mensajes, incluir_borrados, response_format }) {
  const buscado = parsearBusqueda(expediente);
  if (!buscado) {
    return error(
      "Formato de expediente no reconocido. Usa delegación/año/encargo[/expediente], p. ej. 15/2026/47703 o 15/2026/47703/000001 (también 2026/47703)."
    );
  }
  const like = patronesLike(buscado);
  const filtroBorrados = incluir_borrados ? "" : "AND (st.state IS NULL OR st.state <> 'deleted')";

  // 1) Campo expediente y asunto
  const rows = await q(
    `${SELECT_TICKET}
     WHERE (c.field_37 LIKE ? OR c.subject LIKE ?) ${filtroBorrados}
     ORDER BY t.created DESC
     LIMIT 500`,
    [like.campo, like.texto]
  );

  const encontrados = [];
  const otros = [];
  for (const r of rows) {
    const m = coincidencia(buscado, parsearCampo(r.expediente_raw));
    if (m === "exacta" || m === "encargo") encontrados.push({ ...compactarTicket(r), coincidencia: m === "exacta" ? "expediente" : "encargo" });
    else if (m === "otro") otros.push(compactarTicket(r));
    else if (encargoEnTexto(buscado, r.asunto)) encontrados.push({ ...compactarTicket(r), coincidencia: "asunto" });
  }

  // 2) Si no hay nada, texto de los mensajes (más lento)
  let busco_mensajes = false;
  if (encontrados.length === 0 && buscar_en_mensajes) {
    busco_mensajes = true;
    const hits = await q(
      `SELECT DISTINCT th.object_id AS ticket_id, e.body
       FROM ost_thread_entry e
       JOIN ost_thread th ON th.id = e.thread_id AND th.object_type = 'T'
       WHERE e.body LIKE ?
       LIMIT 300`,
      [like.texto]
    );
    const ids = [...new Set(hits.filter((h) => encargoEnTexto(buscado, limpiarHtml(h.body))).map((h) => h.ticket_id))].slice(0, 100);
    if (ids.length) {
      const trows = await q(
        `${SELECT_TICKET}
         WHERE t.ticket_id IN (${ids.map(() => "?").join(",")}) ${filtroBorrados}
         ORDER BY t.created DESC`,
        ids
      );
      for (const r of trows) encontrados.push({ ...compactarTicket(r), coincidencia: "mensaje" });
    }
  }

  const data = {
    busqueda: { texto: expediente, interpretado: formatear(buscado), ...buscado },
    total: encontrados.length,
    abiertos: encontrados.filter((t) => t.abierto).length,
    por_estado: countBy(encontrados, "estado"),
    busco_en_mensajes: busco_mensajes,
    tickets: encontrados,
    otros_expedientes_mismo_encargo: otros.map((t) => ({ ticket: t.ticket, expediente: t.expediente, estado: t.estado, asunto: t.asunto })),
  };

  const md = [`## Tickets del expediente ${formatear(buscado)}`];
  if (encontrados.length === 0) {
    md.push(
      `No hay tickets para este expediente${busco_mensajes ? " (buscado también en el texto de los mensajes)" : ""}.`
    );
  } else {
    md.push(`**${data.total} tickets**, ${data.abiertos} abiertos. Por estado: ${Object.entries(data.por_estado).map(([k, v]) => `${k} ${v}`).join(", ")}.`);
    md.push(
      "Coincidencia: 'expediente' = mismo expediente; 'encargo' = ticket del encargo sin expediente concreto; 'asunto' o 'mensaje' = el número aparece en el texto."
    );
    for (const t of encontrados) md.push("", ...lineasTicket(t, ` (coincidencia: ${t.coincidencia})`));
  }
  if (otros.length) {
    md.push("", `### Otros expedientes del mismo encargo (${otros.length})`);
    for (const t of otros.slice(0, 30)) md.push(`- ${t.ticket} · ${t.expediente} · ${t.estado} · ${t.asunto ?? ""}`);
  }
  md.push("", "Para ver la conversación completa de un ticket usa detalle_ticket con su número.");
  return responder(data, md.join("\n"), response_format);
}

async function detalleTicket({ numero, incluir_notas_internas, max_entradas, max_caracteres_por_entrada, response_format }) {
  const rows = await q(
    `${SELECT_TICKET.replace("u.name AS solicitante", "u.name AS solicitante, c.trabajorealizado, c.mejorafutura, c.codtareamejorafutura")}
     WHERE t.number = ?
     LIMIT 2`,
    [String(numero).trim()]
  );
  if (rows.length === 0) return error(`No existe el ticket ${numero}.`);
  const r = rows[0];
  const ticket = compactarTicket(r);
  ticket.trabajo_realizado = recortar(limpiarHtml(r.trabajorealizado), max_caracteres_por_entrada) || null;
  ticket.mejora_futura = recortar(limpiarHtml(r.mejorafutura), max_caracteres_por_entrada) || null;
  ticket.cod_tarea_mejora_futura = r.codtareamejorafutura || null;

  const th = await q("SELECT id FROM ost_thread WHERE object_type = 'T' AND object_id = ? LIMIT 1", [r.ticket_id]);
  let entradas = [];
  let eventos = [];
  let total_entradas = 0;
  if (th.length) {
    const threadId = th[0].id;
    const ent = await q(
      `SELECT e.id, e.type, e.poster, e.title, e.body, e.created
       FROM ost_thread_entry e
       WHERE e.thread_id = ? ${incluir_notas_internas ? "" : "AND e.type <> 'N'"}
       ORDER BY e.created, e.id`,
      [threadId]
    );
    total_entradas = ent.length;
    entradas = ent.slice(-max_entradas).map((e) => ({
      tipo: TIPO_ENTRADA[e.type] || e.type,
      autor: e.poster || null,
      fecha: e.created,
      titulo: e.title || null,
      texto: recortar(limpiarHtml(e.body), max_caracteres_por_entrada),
    }));
    const ev = await q(
      `SELECT ev.state AS evento, ev.username AS usuario, ev.timestamp AS fecha,
              d.name AS departamento, s.firstname AS agente_nombre, s.lastname AS agente_apellidos,
              CONCAT_WS(' ', s2.firstname, s2.lastname) AS autor_agente, u2.name AS autor_usuario
       FROM ost_thread_event ev
       LEFT JOIN ost_department d ON d.id = ev.dept_id
       LEFT JOIN ost_staff s ON s.staff_id = ev.staff_id
       LEFT JOIN ost_staff s2 ON ev.uid_type = 'S' AND s2.staff_id = ev.uid
       LEFT JOIN ost_user u2 ON ev.uid_type = 'U' AND u2.id = ev.uid
       WHERE ev.thread_id = ? AND ev.annulled = 0 AND ev.state NOT IN ('viewed', 'error')
       ORDER BY ev.timestamp, ev.id
       LIMIT 200`,
      [threadId]
    );
    eventos = ev.map((e) => ({
      evento: EVENTOS[e.evento] || e.evento,
      fecha: e.fecha,
      autor: e.autor_agente || e.autor_usuario || e.usuario || null,
      departamento: e.departamento || null,
      agente: nombreAgente(e),
    }));
  }

  const data = { ticket, total_entradas, entradas_mostradas: entradas.length, entradas, eventos };

  const md = lineasTicket(ticket);
  md.push(`- Solicitante: ${ticket.solicitante ?? "—"}`);
  if (ticket.tiempo_empleado) md.push(`- Tiempo empleado: ${ticket.tiempo_empleado}`);
  if (ticket.trabajo_realizado) md.push("", "**Trabajo realizado**", ticket.trabajo_realizado);
  if (ticket.mejora_futura) md.push("", `**Mejora futura** ${ticket.cod_tarea_mejora_futura ? `(tarea ${ticket.cod_tarea_mejora_futura})` : ""}`, ticket.mejora_futura);
  if (eventos.length) {
    md.push("", "**Historial**");
    // Los nombres van en líneas "- Autor:" / "- Agente:" propias para que la pasarela los reconozca
    for (const e of eventos) {
      md.push(`- ${e.fecha} · ${e.evento}${e.departamento ? ` · ${e.departamento}` : ""}`);
      if (e.autor) md.push(`  - Autor: ${e.autor}`);
      if (e.agente) md.push(`  - Agente: ${e.agente}`);
    }
  }
  md.push("", `**Conversación** (${entradas.length} de ${total_entradas} entradas${total_entradas > entradas.length ? ", las más recientes" : ""})`);
  entradas.forEach((e, i) => {
    md.push("", `#### ${e.tipo} · ${e.fecha}`);
    md.push(`- Autor: ${e.autor ?? "—"}`);
    md.push(e.texto || "(sin texto)");
  });
  return responder(data, md.join("\n"), response_format);
}

const ORDEN_SQL = {
  recientes: "t.created DESC",
  antiguos: "t.created ASC",
  ult_movimiento: "t.lastupdate DESC",
};

const CAMPOS_LISTADO = [
  "ticket", "expediente", "asunto", "estado", "departamento", "tema", "agente", "solicitante",
  "cliente", "tipo_soporte", "tipo_entrada", "tiempo_empleado", "origen", "vencido", "contestado",
  "creado", "ult_movimiento", "vence", "cerrado", "reabierto", "trabajo_realizado",
];
const CAMPOS_POR_DEFECTO = ["ticket", "asunto", "estado", "departamento", "agente", "cliente", "creado", "cerrado"];

function celda(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "Sí" : "No";
  return String(v).replace(/[;\r\n]+/g, " ").trim();
}

async function listarTickets(args) {
  const { limit, offset, orden, response_format } = args;
  const campos = args.campos?.length ? [...new Set(["ticket", ...args.campos])] : CAMPOS_POR_DEFECTO;
  const conTrabajo = campos.includes("trabajo_realizado");
  const { where, params } = construirWhere(args);
  const [{ total }] = await q(`SELECT COUNT(*) AS total ${FROM_TICKET} ${where}`, params);
  const select = conTrabajo ? SELECT_TICKET.replace("u.name AS solicitante", "u.name AS solicitante, c.trabajorealizado") : SELECT_TICKET;
  const rows = await q(`${select} ${where} ORDER BY ${ORDEN_SQL[orden]} LIMIT ? OFFSET ?`, [...params, limit, offset]);
  const tickets = rows.map((r) => {
    const t = compactarTicket(r);
    if (conTrabajo) t.trabajo_realizado = recortar(limpiarHtml(r.trabajorealizado), 1000) || null;
    return Object.fromEntries(campos.map((k) => [k, t[k] ?? null]));
  });
  const has_more = offset + tickets.length < total;
  const data = {
    filtros: describirFiltros(args),
    campos,
    total,
    count: tickets.length,
    offset,
    has_more,
    next_offset: has_more ? offset + tickets.length : null,
    tickets,
  };
  const md = [`## Tickets (${tickets.length ? `${offset + 1}–${offset + tickets.length}` : "0"} de ${total})`];
  if (data.filtros) md.push(`**Filtros:** ${data.filtros}`);
  if (tickets.length) {
    md.push("", campos.join(";"));
    for (const t of tickets) md.push(campos.map((k) => celda(t[k])).join(";"));
  }
  if (has_more) md.push("", `Hay más resultados: repite con offset=${data.next_offset}.`);
  return responder(data, md.join("\n"), response_format);
}

const AGRUPACIONES = {
  departamento: "d.name",
  tema: "ht.topic",
  estado: "st.name",
  agente: "CONCAT_WS(' ', s.firstname, s.lastname)",
  mes: "DATE_FORMAT(t.created, '%Y-%m')",
  cliente: "c.cliente",
  tipo_soporte: "c.tsoporte",
  tipo_entrada: "c.tipoentrada",
  origen: "t.source",
};
const AGRUPACIONES_LISTA = new Set(["cliente", "tipo_soporte", "tipo_entrada"]);

async function estadisticasTickets(args) {
  const { agrupar_por, response_format } = args;
  const { where, params } = construirWhere(args);
  const expr = AGRUPACIONES[agrupar_por];
  const rows = await q(
    `SELECT ${expr} AS grupo,
            COUNT(*) AS total,
            SUM(st.state = 'open') AS abiertos,
            SUM(st.state = 'closed') AS cerrados,
            SUM(st.state = 'open' AND t.isoverdue = 1) AS vencidos_abiertos,
            SUM(CASE WHEN t.closed IS NOT NULL THEN TIMESTAMPDIFF(MINUTE, t.created, t.closed) END) AS min_resolucion,
            SUM(t.closed IS NOT NULL) AS n_resueltos,
            SUM(CASE WHEN TRIM(c.timeticket) REGEXP '^[0-9]+([.,][0-9]+)?$'
                     THEN CAST(REPLACE(TRIM(c.timeticket), ',', '.') AS DECIMAL(12,2)) END) AS tiempo_empleado,
            SUM(TRIM(c.timeticket) REGEXP '^[0-9]+([.,][0-9]+)?$') AS n_con_tiempo
     ${FROM_TICKET}
     ${where}
     GROUP BY grupo
     LIMIT 1000`,
    params
  );

  // Los campos de lista vienen como {"2":"BBVA"}: se limpian y se suman los grupos iguales.
  const acc = new Map();
  for (const r of rows) {
    let g = AGRUPACIONES_LISTA.has(agrupar_por) ? limpiarLista(r.grupo) : r.grupo;
    if (g === null || g === undefined || String(g).trim() === "") g = "(sin valor)";
    const a = acc.get(g) || { grupo: g, total: 0, abiertos: 0, cerrados: 0, vencidos_abiertos: 0, min: 0, n_res: 0, tiempo: 0, n_tiempo: 0 };
    a.total += Number(r.total);
    a.abiertos += Number(r.abiertos || 0);
    a.cerrados += Number(r.cerrados || 0);
    a.vencidos_abiertos += Number(r.vencidos_abiertos || 0);
    a.min += Number(r.min_resolucion || 0);
    a.n_res += Number(r.n_resueltos || 0);
    a.tiempo += Number(r.tiempo_empleado || 0);
    a.n_tiempo += Number(r.n_con_tiempo || 0);
    acc.set(g, a);
  }
  const grupos = [...acc.values()]
    // La clave lleva el nombre de la dimensión ("agente", "cliente"...) para que la pasarela sepa qué anonimizar
    .map((a) => ({
      [agrupar_por]: a.grupo,
      total: a.total,
      abiertos: a.abiertos,
      cerrados: a.cerrados,
      vencidos_abiertos: a.vencidos_abiertos,
      horas_media_resolucion: a.n_res ? Math.round((a.min / a.n_res / 60) * 10) / 10 : null,
      tiempo_empleado_total: a.n_tiempo ? Math.round(a.tiempo * 100) / 100 : null,
      tickets_con_tiempo_empleado: a.n_tiempo,
    }))
    .sort((x, y) => (agrupar_por === "mes" ? String(x.mes).localeCompare(String(y.mes)) : y.total - x.total));

  const total = grupos.reduce((s, g) => s + g.total, 0);
  const data = {
    agrupado_por: agrupar_por,
    filtros: describirFiltros({ ...args, agrupar_por: undefined }),
    total_tickets: total,
    notas: [
      "horas_media_resolucion = media de (cierre - creación) en horas naturales de los tickets con fecha de cierre.",
      "tiempo_empleado_total = suma del campo 'Tiempo empleado soporte' cuando es un número (la unidad es la que usen los agentes al rellenarlo).",
    ],
    grupos,
  };
  const etiqueta = agrupar_por === "agente" ? "Agente" : agrupar_por.charAt(0).toUpperCase() + agrupar_por.slice(1).replace("_", " ");
  const md = [`## Estadísticas por ${agrupar_por} — ${total} tickets`];
  if (data.filtros) md.push(`**Filtros:** ${data.filtros}`);
  md.push("", `${etiqueta};Total;Abiertos;Cerrados;Vencidos abiertos;Horas media resolución;Tiempo empleado`);
  for (const g of grupos)
    md.push(`${celda(g[agrupar_por])};${g.total};${g.abiertos};${g.cerrados};${g.vencidos_abiertos};${g.horas_media_resolucion ?? ""};${g.tiempo_empleado_total ?? ""}`);
  md.push("", ...data.notas.map((n) => `_${n}_`));
  return responder(data, md.join("\n"), response_format);
}

function parsearChoices(configuracion) {
  try {
    const cfg = JSON.parse(configuracion || "{}");
    return String(cfg.choices || "")
      .split(/\r?\n/)
      .map((l) => l.replace(/^\s*\d+\s*:\s*/, "").trim())
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

async function catalogos({ response_format }) {
  const [estados, departamentos, temas, agentes] = await Promise.all([
    q("SELECT name AS estado, state AS tipo FROM ost_ticket_status ORDER BY sort, id"),
    q("SELECT name AS departamento FROM ost_department ORDER BY name"),
    q("SELECT topic AS tema FROM ost_help_topic ORDER BY topic"),
    q(
      `SELECT s.firstname AS agente_nombre, s.lastname AS agente_apellidos, d.name AS departamento
       FROM ost_staff s LEFT JOIN ost_department d ON d.id = s.dept_id
       WHERE s.isactive = 1 ORDER BY s.firstname, s.lastname`
    ),
  ]);
  const data = {
    estados,
    departamentos: departamentos.map((r) => r.departamento),
    temas: temas.map((r) => r.tema),
    agentes: agentes.map((r) => ({ agente: nombreAgente(r), departamento: r.departamento })),
  };
  try {
    const campos = await q(
      "SELECT name, configuration FROM ost_form_field WHERE form_id = 2 AND name IN ('cliente', 'tsoporte', 'tipoentrada')"
    );
    for (const c of campos) {
      const clave = { cliente: "clientes", tsoporte: "tipos_soporte", tipoentrada: "tipos_entrada" }[c.name];
      data[clave] = parsearChoices(c.configuration);
    }
  } catch (e) {
    data.aviso = "No se pudieron leer las listas de cliente y tipo de soporte (falta permiso SELECT sobre ost_form_field).";
  }

  const md = ["## Catálogos de la BBDD de tickets"];
  md.push("", `**Estados:** ${estados.map((e) => `${e.estado} (${e.tipo})`).join(", ")}`);
  md.push(`**Departamentos:** ${data.departamentos.join(", ")}`);
  md.push(`**Temas:** ${data.temas.join(", ")}`);
  if (data.clientes) md.push(`**Clientes:** ${data.clientes.join(", ")}`);
  if (data.tipos_soporte) md.push(`**Tipos de soporte:** ${data.tipos_soporte.join(", ")}`);
  if (data.tipos_entrada) md.push(`**Tipos de entrada:** ${data.tipos_entrada.join(", ")}`);
  md.push("", "**Agentes activos por departamento**");
  const porDepto = new Map();
  for (const a of data.agentes) {
    const k = a.departamento || "(sin departamento)";
    if (!porDepto.has(k)) porDepto.set(k, []);
    porDepto.get(k).push(a.agente);
  }
  for (const [depto, nombres] of porDepto) {
    md.push(`_${depto}_`);
    for (const n of nombres) md.push(`- Agente: ${n}`);
  }
  if (data.aviso) md.push("", `_${data.aviso}_`);
  return responder(data, md.join("\n"), response_format);
}

// ===================== Servidor MCP =====================

function crearServidor() {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    "tickets_expediente",
    {
      title: "Tickets de un expediente",
      description:
        "Busca los tickets de soporte IT (osTicket) relacionados con un expediente de Valora. " +
        "Admite el número completo (15/2026/47703/000001), solo hasta el encargo (15/2026/47703, devuelve todos sus " +
        "expedientes) o sin delegación (2026/47703). No hace falta que coincida exactamente: compara las partes como " +
        "números y, si no encuentra nada en el campo expediente ni en el asunto, busca en el texto de los mensajes. " +
        "Devuelve estado, departamento, agente, fechas y cómo coincide cada ticket.",
      inputSchema: z
        .object({
          expediente: z.string().min(1).max(40).describe("Número de expediente o encargo, p. ej. '15/2026/47703'"),
          buscar_en_mensajes: z
            .boolean()
            .default(true)
            .describe("Si no hay resultados por campo expediente o asunto, buscar también en el texto de los mensajes (más lento)"),
          incluir_borrados: z.boolean().default(false).describe("Incluir tickets en estado Borrado"),
          response_format: RESPONSE_FORMAT,
        })
        .strict().shape,
      annotations: ANOTACIONES,
    },
    herramienta("tickets_expediente", ticketsExpediente)
  );

  server.registerTool(
    "detalle_ticket",
    {
      title: "Detalle de un ticket",
      description:
        "Ficha completa de un ticket por su número: datos, solicitante, trabajo realizado, historial de cambios " +
        "(asignaciones, transferencias, cierres) y la conversación (mensajes, respuestas y notas internas) en texto plano.",
      inputSchema: z
        .object({
          numero: z.string().min(1).max(20).describe("Número del ticket tal como aparece en osTicket"),
          incluir_notas_internas: z.boolean().default(true).describe("Incluir las notas internas de los agentes"),
          max_entradas: z.number().int().min(1).max(200).default(30).describe("Máximo de entradas de la conversación (las más recientes)"),
          max_caracteres_por_entrada: z.number().int().min(200).max(20000).default(3000).describe("Recorte de cada mensaje"),
          response_format: RESPONSE_FORMAT,
        })
        .strict().shape,
      annotations: ANOTACIONES,
    },
    herramienta("detalle_ticket", detalleTicket)
  );

  server.registerTool(
    "listar_tickets",
    {
      title: "Listar tickets",
      description:
        "Lista tickets filtrando por estado, periodo (por fecha de creación, cierre o último movimiento), agente " +
        "asignado, departamento, cliente, tipo de soporte, tema, texto del asunto o vencidos; los filtros se combinan. " +
        "Con 'campos' se eligen las columnas. Paginado. Para recuentos o tiempos medios usa estadisticas_tickets; " +
        "para los valores válidos de los filtros, catalogos.",
      inputSchema: z
        .object({
          ...FILTROS_SHAPE,
          campos: z
            .array(z.enum(CAMPOS_LISTADO))
            .max(CAMPOS_LISTADO.length)
            .optional()
            .describe(`Columnas a incluir (el número de ticket siempre va). Por defecto: ${CAMPOS_POR_DEFECTO.join(", ")}`),
          orden: z.enum(["recientes", "antiguos", "ult_movimiento"]).default("recientes").describe("Orden de los resultados"),
          limit: z.number().int().min(1).max(100).default(25).describe("Tickets por página (máx. 100)"),
          offset: z.number().int().min(0).default(0).describe("Desplazamiento para paginar"),
          response_format: RESPONSE_FORMAT,
        })
        .strict().shape,
      annotations: ANOTACIONES,
    },
    herramienta("listar_tickets", listarTickets)
  );

  server.registerTool(
    "estadisticas_tickets",
    {
      title: "Estadísticas de tickets",
      description:
        "Cifras agregadas de tickets agrupadas por departamento, tema, estado, agente, mes, cliente, tipo de soporte, " +
        "tipo de entrada u origen: total, abiertos, cerrados, vencidos abiertos, horas medias de resolución y tiempo " +
        "empleado. Admite los mismos filtros que listar_tickets.",
      inputSchema: z
        .object({
          agrupar_por: z
            .enum(["departamento", "tema", "estado", "agente", "mes", "cliente", "tipo_soporte", "tipo_entrada", "origen"])
            .describe("Dimensión de agrupación"),
          ...FILTROS_SHAPE,
          response_format: RESPONSE_FORMAT,
        })
        .strict().shape,
      annotations: ANOTACIONES,
    },
    herramienta("estadisticas_tickets", estadisticasTickets)
  );

  server.registerTool(
    "catalogos",
    {
      title: "Catálogos de tickets",
      description:
        "Valores válidos para filtrar: estados, departamentos, temas, clientes, tipos de soporte, tipos de entrada y agentes activos.",
      inputSchema: z.object({ response_format: RESPONSE_FORMAT }).strict().shape,
      annotations: ANOTACIONES,
    },
    herramienta("catalogos", catalogos)
  );

  return server;
}

// ===================== HTTP =====================

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

function checkOrigin(req, res, next) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.length && !ALLOWED_ORIGINS.includes(origin)) {
    return res.status(403).json({ error: "Origin no permitido" });
  }
  next();
}

function requireAuth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : req.headers["x-mcp-token"] || "";
  if (!tokensEqual(String(token), AUTH_TOKEN)) {
    logCall({ evento: "auth_fallida", ip: req.ip });
    return res.status(401).json({ error: "No autorizado" });
  }
  next();
}

app.get("/health", async (_req, res) => {
  try {
    await q("SELECT 1 AS ok");
    res.json({ ok: true, server: SERVER_NAME, version: SERVER_VERSION, db: "ok" });
  } catch (e) {
    res.status(503).json({ ok: false, server: SERVER_NAME, version: SERVER_VERSION, db: "error" });
  }
});

// Streamable HTTP sin estado: un servidor y un transporte por petición.
app.post("/mcp", checkOrigin, requireAuth, async (req, res) => {
  const server = crearServidor();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("[tickets-mcp] error en /mcp:", e);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Error interno" }, id: null });
    }
  }
});

// Sin sesiones: no hay stream GET ni cierre de sesión.
const sinSesiones = (_req, res) =>
  res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Método no permitido" }, id: null });
app.get("/mcp", sinSesiones);
app.delete("/mcp", sinSesiones);

const httpServer = app.listen(PORT, HOST, () => {
  console.log(`[tickets-mcp] ${SERVER_NAME} v${SERVER_VERSION} escuchando en http://${HOST}:${PORT}/mcp`);
});

function apagar() {
  httpServer.close(() => {
    if (pool) pool.end().finally(() => process.exit(0));
    else process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", apagar);
process.on("SIGINT", apagar);
