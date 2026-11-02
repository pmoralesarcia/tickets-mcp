# tickets-mcp

MCP de solo lectura sobre la BBDD MySQL de osTicket (soporte IT de Valmesa), versión 0.1.0.
Va detrás de la pasarela como servidor «tickets», igual que el MCP del DW y el de Producción.

## Herramientas

| Herramienta | Para qué |
|---|---|
| `listar_tickets` | Lista tickets filtrando por estado, periodo (fecha de creación, cierre o último movimiento), agente, departamento, cliente, tipo de soporte, tema, texto del asunto o vencidos. Con `campos` se eligen las columnas. Paginado (máx. 100 por página). |
| `estadisticas_tickets` | Total, abiertos, cerrados, vencidos abiertos, horas medias de resolución y tiempo empleado, agrupados por departamento, tema, estado, agente, mes, cliente, tipo de soporte, tipo de entrada u origen. Mismos filtros que `listar_tickets`. |
| `detalle_ticket` | Ficha de un ticket por su número: datos, solicitante, trabajo realizado, historial (asignaciones, transferencias, cierres) y conversación (mensajes, respuestas y notas internas) en texto plano. |
| `tickets_expediente` | Tickets de un expediente de Valora. Búsqueda flexible: `15/2026/47703/1` = `.../000001`; con solo el encargo (`15/2026/47703`) salen todos sus expedientes; también `2026/47703`. Busca en el campo «Numero de expediente» y en el asunto, y si no encuentra nada, en el texto de los mensajes. |
| `catalogos` | Valores válidos de estados, departamentos, temas, clientes, tipos de soporte, tipos de entrada y agentes activos. |

Columnas que admite `campos` en `listar_tickets`: ticket, expediente, asunto, estado, departamento, tema, agente,
solicitante, cliente, tipo_soporte, tipo_entrada, tiempo_empleado, origen, vencido, contestado, creado,
ult_movimiento, vence, cerrado, reabierto, trabajo_realizado. Por defecto: ticket, asunto, estado, departamento,
agente, cliente, creado y cerrado.

Todas las respuestas admiten `response_format` = `markdown` (por defecto) o `json`, y llevan `structuredContent`.

## Datos de osTicket que usa

- `ost_ticket` + `ost_ticket__cdata` (campos del formulario: asunto, `field_37` = número de expediente, `cliente`,
  `tsoporte`, `tipoentrada`, `timeticket`, `trabajorealizado`, `mejorafutura`…). Los campos de lista se guardan como
  `{"2":"BBVA"}` y el MCP los devuelve limpios.
- `ost_ticket_status`, `ost_department`, `ost_help_topic`, `ost_staff` (solo nombre, departamento y activo),
  `ost_user` (solo nombre), `ost_thread`, `ost_thread_entry`, `ost_thread_event`, `ost_form_field`.
- `field_36` («Estado del ticket») no se usa: su lista está vacía. El estado es el estándar de osTicket.
- Los tickets en estado Borrado se ocultan salvo que se pida `incluir_borrados`.

## Seguridad

- Usuario MySQL de solo lectura con SELECT solo en esas tablas, y en `ost_staff` y `ost_user` solo en las columnas
  necesarias: `sql/mysql_usuario_solo_lectura.sql`. No ve contraseñas, emails ni teléfonos de agentes, ni
  configuración, claves de API o adjuntos.
- Cada conexión se abre en `READ ONLY` y con tiempo máximo por consulta (`MYSQL_QUERY_TIMEOUT_MS`, 20 s).
- Todo el SQL es fijo y con parámetros. Claude nunca envía SQL.
- Escucha en `127.0.0.1` y exige `Authorization: Bearer <MCP_AUTH_TOKEN>`, que es la clave `CLAVE_MCP_TICKETS` de la pasarela.
- Ámbito: solo TODO. Con otro ámbito se niega; confirma `valmesa.es/ambito-aplicado` = `TODO` en el `_meta`.
- La anonimización la hace la pasarela. Hay que añadir a su `src/privacidad/reglas.ts` los campos `agente`,
  `solicitante` y `autor` (fichero completo en `pasarela/reglas.ts`, cambios en `pasarela/reglas.diff`).
  Emails, teléfonos, NIF e IBAN dentro de los mensajes se detectan por formato. Los nombres de empleados que estén en
  `dim_empleado` del DW se reconocen en cualquier texto. **Límite:** el nombre de alguien que solo aparezca dentro del
  texto de un mensaje (sin ser agente, solicitante ni empleado del DW) no se detecta.
- Log de auditoría JSON por línea en `LOG_FILE`.

## Instalación (valmcp01)

1. Pedir al administrador de la BBDD de osTicket que ejecute `sql/mysql_usuario_solo_lectura.sql`, con la IP de
   valmcp01 y una contraseña nueva. Comprobar desde valmcp01 que llega al MySQL (`nc -vz <servidor> 3306`).
2. Copiar la carpeta a `/home/valmesa/tickets-mcp` (sin `node_modules`) y ejecutar `npm ci`. Requiere Node 20
   o superior.
3. Crear `.env` a partir de `.env.example`. `MCP_AUTH_TOKEN` nuevo:
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
4. `sudo cp deploy/tickets-mcp.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now tickets-mcp`
5. Comprobar: `curl -s http://127.0.0.1:8767/health` debe dar `"db":"ok"`.
6. MCP_Seguridad: ejecutar `sql/014_servidor_tickets.sql` (alta del servidor, sus 5 herramientas y permisos para
   Admin y Operación con ámbito TODO).
7. Pasarela: añadir `CLAVE_MCP_TICKETS` (= `MCP_AUTH_TOKEN` del paso 3) a su `.env`, aplicar el cambio de
   `reglas.ts`, `npm test`, desplegar y reiniciar. Comprobar con `node scripts/comprobar-claves.mjs` y
   `npx tsx scripts/probar-perfil.ts <token>`.

Para probar en tu PC: lo mismo con `HOST=127.0.0.1`, otro puerto si el 8767 está ocupado, y en `seg.Servidor` la URL
de tu PC (solo en tu MCP_Seguridad local).

## Pruebas

- `npm test`: pruebas de la interpretación de números de expediente.
- Probado el 29/10/2026 contra una copia vacía del esquema de osTicket (MariaDB 10.11) con datos ficticios y el
  usuario de solo lectura: las 5 herramientas, errores, ámbito distinto de TODO, token incorrecto, y la salida pasada
  por el anonimizador real de la pasarela con las reglas nuevas (sin fugas de nombres, emails ni teléfonos).
  Falta probarlo contra la BBDD real.
