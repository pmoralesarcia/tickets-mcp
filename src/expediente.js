/**
 * Números de expediente de Valora en osTicket (campo "Numero de expediente", field_37).
 *
 * Formato: delegación/año/encargo[/expediente], p. ej. 15/2026/48887/000001.
 * En los tickets aparece escrito de varias formas: con 5 o 6 dígitos en el
 * expediente, solo hasta el encargo, con guiones o espacios... La comparación
 * se hace parte a parte como números, así que 15/2026/48887/1 = .../000001.
 */

// Partes numéricas de un texto con separadores / - . espacio o _.
function partes(texto) {
  return String(texto ?? "")
    .trim()
    .split(/[\s/\-._]+/)
    .filter(Boolean);
}

/**
 * Interpreta lo que pide el usuario. Admite:
 *   15/2026/48887/1   delegación, año, encargo y expediente
 *   15/2026/48887     delegación, año y encargo (todos sus expedientes)
 *   2026/48887        año y encargo (cualquier delegación)
 *   48887             solo el encargo (cualquier año: más ruido)
 * Devuelve null si no tiene esa forma.
 */
export function parsearBusqueda(texto) {
  const p = partes(texto);
  if (p.length === 0 || p.length > 4 || !p.every((x) => /^\d+$/.test(x))) return null;
  const n = p.map((x) => parseInt(x, 10));
  if (p.length === 1) return { delegacion: null, anio: null, encargo: n[0], expediente: null };
  if (p.length === 2) return { delegacion: null, anio: n[0], encargo: n[1], expediente: null };
  return { delegacion: n[0], anio: n[1], encargo: n[2], expediente: p.length === 4 ? n[3] : null };
}

/** Interpreta el valor guardado en un ticket. Null si no parece un expediente. */
export function parsearCampo(valor) {
  const p = partes(valor);
  if (p.length < 3 || !p.slice(0, 4).every((x) => /^\d+$/.test(x))) return null;
  const n = p.map((x) => parseInt(x, 10));
  return { delegacion: n[0], anio: n[1], encargo: n[2], expediente: p.length >= 4 ? n[3] : null };
}

/**
 * Cómo encaja el expediente de un ticket con lo buscado:
 *   "exacta"   mismo expediente (o mismo encargo si se buscó solo el encargo)
 *   "encargo"  el ticket es del encargo sin expediente concreto
 *   "otro"     es otro expediente del mismo encargo (solo si se buscó uno concreto)
 *   null       no coincide
 */
export function coincidencia(buscado, campo) {
  if (!buscado || !campo) return null;
  if (campo.encargo !== buscado.encargo) return null;
  if (buscado.anio !== null && campo.anio !== buscado.anio) return null;
  if (buscado.delegacion !== null && campo.delegacion !== buscado.delegacion) return null;
  if (buscado.expediente === null) return "exacta";
  if (campo.expediente === null) return "encargo";
  return campo.expediente === buscado.expediente ? "exacta" : "otro";
}

/** El número del encargo aparece en un texto libre (asunto o mensaje) como número completo. */
export function encargoEnTexto(buscado, texto) {
  if (!buscado || !texto) return false;
  const re = new RegExp(`(^|\\D)0*${buscado.encargo}(\\D|$)`);
  if (!re.test(texto)) return false;
  // Si se conoce el año, se exige que aparezca también (evita números sueltos que coinciden).
  return buscado.anio === null || String(texto).includes(String(buscado.anio));
}

/** Patrones LIKE para preseleccionar candidatos en MySQL (luego se filtra en JS). */
export function patronesLike(buscado) {
  const enc = String(buscado.encargo);
  return {
    campo: buscado.anio !== null ? `%${buscado.anio}%${enc}%` : `%${enc}%`,
    texto: `%${enc}%`,
  };
}

/** Texto normalizado para mostrar: 15/2026/48887/1 -> 15/2026/48887/000001. */
export function formatear(e) {
  if (!e) return null;
  const base = [e.delegacion ?? "?", e.anio ?? "?", String(e.encargo).padStart(5, "0")].join("/");
  return e.expediente === null ? base : `${base}/${String(e.expediente).padStart(6, "0")}`;
}
