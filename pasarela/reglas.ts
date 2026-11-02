// Dónde están los datos personales en las respuestas de los MCP internos.
// Para añadir un campo nuevo basta con añadirlo aquí.
import type { TipoDato } from "./tipos.js";

// Claves JSON (sin distinguir mayúsculas). MCP de Producción.
export const CAMPOS_JSON: Record<string, TipoDato> = {
  nomusuarioactual: "PERSONA",
  nombreusuario: "PERSONA",
  nomcomercial: "PERSONA",
  nombresolicitante: "PERSONA",
  contacto: "PERSONA",
  nombrecompleto: "PERSONA",
  nombre: "PERSONA",
  contactotelefono: "TEL",
  telefonomovilusuario: "TEL",
  direccionvisita: "DIRECCION",
  codpostalvisita: "CP",
  referenciacatastral: "REFCAT",
  // MCP de tickets (osTicket)
  agente: "PERSONA",
  solicitante: "PERSONA",
  autor: "PERSONA",
};

// Líneas "Etiqueta: valor" de las respuestas en texto: DW (buscar_expediente) y agenda en markdown.
export const ETIQUETAS_TEXTO: Record<string, TipoDato> = {
  "- asignado a": "PERSONA",
  "técnico": "PERSONA",
  supervisor: "PERSONA",
  "supervisor administrativo": "PERSONA",
  "código postal": "CP",
  coordenadas: "COORD",
  // MCP de tickets (osTicket)
  "- agente": "PERSONA",
  "- solicitante": "PERSONA",
  "- autor": "PERSONA",
};

// Columnas de las respuestas CSV (separador ;). MCP del DW (listar_expedientes, calculos_plazos).
export const COLUMNAS_CSV: Record<string, TipoDato> = {
  tecnico: "PERSONA",
  supervisor: "PERSONA",
  // MCP de tickets (listar_tickets)
  agente: "PERSONA",
  solicitante: "PERSONA",
};
