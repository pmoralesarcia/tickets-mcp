/* ============================================================
   014 · MCP de tickets (osTicket, soporte IT)
   - Alta del servidor «tickets» (tickets-mcp, Streamable HTTP, puerto 8767).
   - Sus 5 herramientas, todas de solo lectura.
   - Permisos: ADMIN, OPERACIONES y DIRECCION (inactivo) con ámbito TODO.
     Las herramientas no saben filtrar por PROPIOS/CARTERA/EQUIPO (AmbitosFiltrados = NULL),
     así que un perfil con esos ámbitos no las vería aunque se le diera permiso.
   - En PROD la URL es la de valmcp01 (127.0.0.1 si la pasarela corre en la misma máquina).
     La pasarela envía al MCP la clave de su variable CLAVE_MCP_TICKETS (.env de la pasarela),
     que debe ser igual a MCP_AUTH_TOKEN del .env de tickets-mcp.
   Requiere 001 a 005. Se puede ejecutar más de una vez.
   ============================================================ */
USE MCP_Seguridad;
GO

IF NOT EXISTS (SELECT 1 FROM seg.Servidor WHERE Codigo = 'tickets')
    INSERT INTO seg.Servidor (Codigo, Nombre, UrlInterna, Transporte)
    VALUES ('tickets', N'tickets-mcp (osTicket, soporte IT)', 'http://127.0.0.1:8767/mcp', 'STREAMABLE_HTTP');
GO

INSERT INTO seg.Herramienta (ServidorId, Nombre, Grupo, Descripcion, EsEscritura)
SELECT s.Id, v.Nombre, N'Soporte IT', v.Descripcion, 0
FROM (VALUES
    ('listar_tickets',       N'Lista tickets por estado, periodo, agente, departamento, cliente... con columnas a elegir'),
    ('estadisticas_tickets', N'Recuentos y tiempos de resolución agrupados por agente, departamento, cliente, mes...'),
    ('detalle_ticket',       N'Ficha, historial y conversación de un ticket'),
    ('tickets_expediente',   N'Tickets relacionados con un expediente de Valora (búsqueda flexible)'),
    ('catalogos',            N'Estados, departamentos, temas, clientes, tipos de soporte y agentes')
) AS v(Nombre, Descripcion)
JOIN seg.Servidor s ON s.Codigo = 'tickets'
WHERE NOT EXISTS (SELECT 1 FROM seg.Herramienta h WHERE h.ServidorId = s.Id AND h.Nombre = v.Nombre);
GO

INSERT INTO seg.PerfilPermiso (PerfilId, Patron, Efecto, Ambito)
SELECT p.Id, 'tickets.*', 'PERMITIR', 'TODO'
FROM seg.Perfil p
WHERE p.Codigo IN ('ADMIN', 'OPERACIONES', 'DIRECCION')
  AND NOT EXISTS (SELECT 1 FROM seg.PerfilPermiso pp WHERE pp.PerfilId = p.Id AND pp.Patron = 'tickets.*' AND pp.Efecto = 'PERMITIR');
GO

/* Para dar acceso a una persona concreta de otro perfil (ámbito TODO obligatorio):
   INSERT INTO seg.UsuarioPermiso (UsuarioId, Patron, Efecto, Ambito, Motivo)
   VALUES (@UsuarioId, 'tickets.*', 'PERMITIR', 'TODO', N'Motivo'); */

-- Comprobación
SELECT s.Codigo, s.UrlInterna, s.Transporte, s.Activo, h.Nombre, h.Activa
FROM seg.Servidor s JOIN seg.Herramienta h ON h.ServidorId = s.Id
WHERE s.Codigo = 'tickets';

SELECT p.Codigo AS Perfil, pp.Patron, pp.Efecto, pp.Ambito
FROM seg.PerfilPermiso pp JOIN seg.Perfil p ON p.Id = pp.PerfilId
WHERE pp.Patron LIKE 'tickets%';
GO
