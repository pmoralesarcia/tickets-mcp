import { test } from "node:test";
import assert from "node:assert/strict";
import { parsearBusqueda, parsearCampo, coincidencia, encargoEnTexto, formatear } from "../src/expediente.js";

const b = (t) => parsearBusqueda(t);
const c = (t) => parsearCampo(t);

test("interpreta las formas de escribir un expediente", () => {
  assert.deepEqual(b("15/2026/47703"), { delegacion: 15, anio: 2026, encargo: 47703, expediente: null });
  assert.deepEqual(b(" 15-2026-47703-000001 "), { delegacion: 15, anio: 2026, encargo: 47703, expediente: 1 });
  assert.deepEqual(b("2026/47703"), { delegacion: null, anio: 2026, encargo: 47703, expediente: null });
  assert.equal(b("abc"), null);
  assert.equal(b("1/2/3/4/5"), null);
  assert.equal(c(""), null);
  assert.equal(c("ver ticket anterior"), null);
});

test("compara las partes como números", () => {
  assert.equal(coincidencia(b("15/2026/47703/1"), c("15/2026/47703/000001")), "exacta");
  assert.equal(coincidencia(b("15/2026/47703/000001"), c("15/2026/47703/00001")), "exacta");
  assert.equal(coincidencia(b("15/2026/47703/1"), c("15/2026/47703")), "encargo");
  assert.equal(coincidencia(b("15/2026/47703/1"), c("15/2026/47703/000002")), "otro");
  assert.equal(coincidencia(b("15/2026/47703"), c("15/2026/47703/000002")), "exacta");
  assert.equal(coincidencia(b("15/2026/47703"), c("15/2026/147703/000001")), null);
  assert.equal(coincidencia(b("31/2026/2115"), c("31/2026/02115/000003")), "exacta");
  assert.equal(coincidencia(b("15/2026/2115"), c("31/2026/02115/000003")), null);
  assert.equal(coincidencia(b("2026/2115"), c("31/2026/02115/000003")), "exacta");
});

test("busca el encargo como número completo en textos", () => {
  assert.equal(encargoEnTexto(b("15/2026/47703"), "Consulta 15-2026-47703 urgente"), true);
  assert.equal(encargoEnTexto(b("15/2026/47703"), "Consulta 147703 de 2026"), false);
  assert.equal(encargoEnTexto(b("15/2026/47703"), "Consulta 47703"), false); // falta el año
  assert.equal(encargoEnTexto(b("47703"), "Consulta 47703"), true);
});

test("formatea con ceros", () => {
  assert.equal(formatear(b("15/2026/2115/3")), "15/2026/02115/000003");
  assert.equal(formatear(b("2026/47703")), "?/2026/47703");
});
