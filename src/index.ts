import { cargarConfig } from './config/index.js';
import { construirServicio } from './api/servidor.js';

const cfg = cargarConfig();
const svc = construirServicio(cfg);

// Trabajador de la cola de eventos. Bajo retención cero, cada evento que queda sin
// procesar es el resultado de una llamada que nadie está mirando.
const tCola = setInterval(() => {
  const r = svc.trabajador.procesarLote();
  if (r.procesados > 0 || r.errores > 0) svc.app.log.info(r, 'Lote de eventos procesado');
}, 5_000);

// Despacho de llamadas salientes.
const tDespacho = setInterval(() => {
  void svc.despachador.despacharLote().then((r) => {
    if (r.despachados > 0 || r.fallidos > 0) svc.app.log.info(r, 'Lote de llamadas despachado');
  });
}, 15_000);

// Conciliación horaria: llamadas originadas contra resultados recibidos.
const tConciliacion = setInterval(() => {
  const r = svc.conciliar();
  if (r.totalSinResultado > 0) svc.app.log.warn(r, 'Conciliación con huecos');
}, 60 * 60 * 1000);

async function apagar(senal: string): Promise<void> {
  svc.app.log.info({ senal }, 'Apagando');
  clearInterval(tCola);
  clearInterval(tDespacho);
  clearInterval(tConciliacion);
  // Se vacía la cola antes de cerrar: no se pierde un resultado por un despliegue.
  svc.trabajador.procesarLote(500);
  await svc.cerrar();
  process.exit(0);
}

process.on('SIGTERM', () => void apagar('SIGTERM'));
process.on('SIGINT', () => void apagar('SIGINT'));

await svc.app.listen({ port: cfg.PUERTO, host: cfg.HOST });
