/**
 * Entrada serverless para Vercel.
 *
 * Vercel no ejecuta procesos persistentes: no hay temporizadores ni disco
 * durable. Este adaptador envuelve la misma app Fastify de `src/api/servidor.ts`
 * y deja las tareas de fondo (cola, despacho, conciliación) a los endpoints
 * `/tareas/*`, que dispara el cron de `vercel.json` o una petición manual.
 *
 * LÍMITE CONOCIDO: la base SQLite vive en /tmp de la instancia. Es efímera y no
 * se comparte entre instancias. Sirve para una superficie pública de prueba; no
 * para operar con pacientes. Ver docs/despliegue-vercel.md.
 */
if (process.env.VERCEL && !process.env.DB_RUTA) {
  process.env.DB_RUTA = '/tmp/agente.db';
}

const { cargarConfig } = await import('../dist/src/config/index.js');
const { construirServicio } = await import('../dist/src/api/servidor.js');

let servicio = null;

function obtenerServicio() {
  if (!servicio) servicio = construirServicio(cargarConfig());
  return servicio;
}

export default async function handler(req, res) {
  const svc = obtenerServicio();
  await svc.app.ready();
  svc.app.server.emit('request', req, res);
}
