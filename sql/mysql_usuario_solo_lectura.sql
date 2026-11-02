-- Usuario MySQL de solo lectura para tickets-mcp.
-- Ejecutarlo un administrador de la BBDD de osTicket.
-- Cambiar '<ip_valmcp01>' por la IP desde la que se conecta el MCP (repetir el bloque para la IP del PC de
-- pruebas si hace falta) y '<contraseña>' por una contraseña larga. La contraseña va solo al .env del MCP.
-- Solo da SELECT sobre las tablas que usa el MCP; en ost_staff y ost_user, solo sobre las columnas
-- necesarias. No ve contraseñas de agentes, emails, teléfonos, configuración, claves de API ni adjuntos.

CREATE USER IF NOT EXISTS 'mcp_tickets'@'<ip_valmcp01>' IDENTIFIED BY '<contraseña>';

GRANT SELECT ON bd_osticket.ost_ticket          TO 'mcp_tickets'@'<ip_valmcp01>';
GRANT SELECT ON bd_osticket.ost_ticket__cdata   TO 'mcp_tickets'@'<ip_valmcp01>';
GRANT SELECT ON bd_osticket.ost_ticket_status   TO 'mcp_tickets'@'<ip_valmcp01>';
GRANT SELECT ON bd_osticket.ost_department      TO 'mcp_tickets'@'<ip_valmcp01>';
GRANT SELECT ON bd_osticket.ost_help_topic      TO 'mcp_tickets'@'<ip_valmcp01>';
GRANT SELECT ON bd_osticket.ost_thread          TO 'mcp_tickets'@'<ip_valmcp01>';
GRANT SELECT ON bd_osticket.ost_thread_entry    TO 'mcp_tickets'@'<ip_valmcp01>';
GRANT SELECT ON bd_osticket.ost_thread_event    TO 'mcp_tickets'@'<ip_valmcp01>';
GRANT SELECT ON bd_osticket.ost_form_field      TO 'mcp_tickets'@'<ip_valmcp01>';
-- ost_staff y ost_user: solo las columnas que usa el MCP (sin contraseñas, emails ni teléfonos)
GRANT SELECT (staff_id, dept_id, firstname, lastname, isactive) ON bd_osticket.ost_staff TO 'mcp_tickets'@'<ip_valmcp01>';
GRANT SELECT (id, name) ON bd_osticket.ost_user TO 'mcp_tickets'@'<ip_valmcp01>';

-- Comprobación
SHOW GRANTS FOR 'mcp_tickets'@'<ip_valmcp01>';
