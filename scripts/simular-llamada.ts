/**
 * Simulador de conversación. Recorre un escenario completo contra la máquina de
 * estados real, sin red y sin tocar la plataforma de voz. Es la herramienta para
 * que el equipo clínico revise el guion antes de que exista una llamada.
 *
 *   npm run simular -- normal
 *   npm run simular -- alarma
 *   npm run simular -- familiar
 *   npm run simular -- consulta
 */
import { abrir, avanzar, estadoInicial } from '../src/dominio/checklist/maquina.js';
import { evaluar } from '../src/dominio/criterios/index.js';
import { ClasificadorSimulado } from '../src/llm/clasificador.js';
import { ContextoLlamada } from '../src/dominio/tipos.js';

const ctx = ContextoLlamada.parse({
  idLlamada: 'sim-001',
  idPaciente: 'pac-sim',
  verificacion: { nombrePaciente: 'María', rutUltimosCuatro: '4821', diaMesProcedimiento: '15-04' },
  indicacion: {
    idIndicacion: 'ind-77',
    emitidaPor: 'Dra. Silva',
    emitidaEn: '2026-04-10T14:00:00.000Z',
    horaInicioAyuno: '22:00',
    farmacosASuspender: [
      { nombre: 'acenocumarol', instruccion: 'Debe suspender el acenocumarol desde el lunes en la mañana, es decir, tres días antes.' },
      { nombre: 'aspirina', instruccion: 'La aspirina la suspende el mismo lunes.' },
    ],
    examenesRequeridos: ['hemograma', 'perfil de coagulación'],
    requiereAcompanante: true,
    horaLlegada: '07:30',
    fechaProcedimiento: '2026-04-15',
  },
});

const ESCENARIOS: Record<string, string[]> = {
  normal: ['sí, soy yo', '4821', '15 del 04', 'a las 22:00', 'ya, entendí', 'entendí', 'sí, los tengo', 'sí, viene mi hija'],
  alarma: ['sí, soy yo', '4821', '15 del 04', 'a las 22:00', 'ya entendí, pero ando con fiebre desde ayer'],
  familiar: ['sí, soy yo', 'no me acuerdo del RUT'],
  consulta: ['sí, soy yo', '4821', '15 del 04', '¿esto significa que el tumor creció?'],
  persona: ['sí, soy yo', 'prefiero hablar con una persona'],
  repite: ['sí, soy yo', '4821', '15 del 04', 'no escuché, ¿me repite?', 'a las 22:00', 'sí', 'sí', 'sí', 'sí'],
};

const nombre = process.argv[2] ?? 'normal';
const turnos = ESCENARIOS[nombre];
if (!turnos) {
  console.error(`Escenario desconocido: "${nombre}". Disponibles: ${Object.keys(ESCENARIOS).join(', ')}`);
  process.exit(1);
}

const clasificador = new ClasificadorSimulado();
let st = estadoInicial(ctx.idLlamada);

const AGENTE = '[36m';
const PACIENTE = '[33m';
const META = '[90m';
const FIN = '[0m';

console.log(`\n${META}── Escenario: ${nombre} ──${FIN}\n`);

const ap = abrir(ctx, st);
st = ap.estado;
console.log(`${AGENTE}AGENTE  ${FIN} ${ap.salida}`);

let ultimaSalida = ap.salida;

for (const turno of turnos) {
  console.log(`${PACIENTE}PACIENTE${FIN} ${turno}`);
  const cls = await clasificador.clasificar({
    textoPaciente: turno,
    estado: st.estado,
    preguntaDelAgente: ultimaSalida,
  });
  const r = avanzar(ctx, st, turno, cls);
  st = r.estado;
  ultimaSalida = r.salida;

  const ev = st.auditoria.at(-1);
  console.log(
    `${META}         [${cls.intencion} ${cls.confianza.toFixed(2)}] → ${st.estado}` +
      `${ev?.guardrail ? ` · guardrail: ${ev.guardrail}` : ''}${FIN}`,
  );
  if (r.salida) console.log(`${AGENTE}AGENTE  ${FIN} ${r.salida}`);
  if (r.transferir) {
    console.log(`${META}         >>> TRANSFERENCIA A PERSONA${FIN}`);
    break;
  }
  if (r.terminar) {
    console.log(`${META}         >>> LLAMADA TERMINADA${FIN}`);
    break;
  }
}

const res = evaluar(ctx, st);
console.log(`\n${META}── Evaluación ──${FIN}`);
console.log(`Estado final: ${res.estadoFinal}`);
for (const c of res.criterios) {
  const marca = c.veredicto === 'cumplido' ? '✓' : c.veredicto === 'no_cumplido' ? '✗' : '?';
  console.log(`  ${marca} ${c.id.padEnd(28)} ${META}${c.justificacion}${FIN}`);
}
console.log(`\n${META}── Datos extraídos ──${FIN}`);
console.log(JSON.stringify(res.datos, null, 2));
console.log(
  `\n${res.requiereRevisionHumana ? '[31mREQUIERE REVISIÓN HUMANA' : '[32mSin hallazgos pendientes'}${FIN}\n`,
);
